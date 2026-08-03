//! Tauri commands for the AI pipeline PR lifecycle.
//!
//! Phase 1 (resume): list pipeline PRs scoped to the project's GitHub repo,
//! create a worktree from one, self-assign the GitHub PR, and claim the ClickUp
//! task (self-assign — guarded, refuses if already assigned to someone else —
//! then move it to `in review`).
//!
//! Phase 2 (finish): one action = ClickUp status → `to deploy` + merge the PR.
//!
//! Everything reuses existing building blocks: `checkout_pr`, `merge_github_pr`,
//! the ClickUp commands, `parse_clickup_task_id_from_branch`, and
//! `git::get_github_url`. The only new GitHub plumbing is `gh pr edit
//! --add-assignee @me` (with a `gh pr view` pre-check).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::AppHandle;

use super::config::load_ai_pipeline_config;
use crate::gh_cli::config::resolve_gh_binary;
use crate::platform::silent_command;
use crate::projects::clickup_client::clickup_get;
use crate::projects::git::get_github_url;
use crate::projects::storage::load_projects_data;
use crate::projects::types::Worktree;
use crate::projects::{
    assign_clickup_task_to_me, checkout_pr, create_worktree, get_clickup_me, get_clickup_task,
    load_clickup_config, merge_github_pr, parse_clickup_task_id_from_branch,
    prepare_github_pr_for_merge, resolve_clickup_token, update_clickup_task_status, ClickUpTask,
};

/// ClickUp statuses that mark a ticket ready to pick up for review/merge.
/// Both the queued (`to review`) and active (`in review`) review columns count.
const REVIEW_STATUSES: &[&str] = &["to review", "in review"];

/// ClickUp status marking a ticket the pipeline could not finish on its own.
/// Such a ticket may or may not have a PR (the pipeline sometimes gives up
/// before pushing one), so its PR is optional everywhere below.
const STUCK_STATUS: &str = "stuck";

/// ClickUp status the "resume" action moves a picked-up review ticket to.
const IN_REVIEW_STATUS: &str = "in review";

/// ClickUp status the "resume" action moves a picked-up STUCK ticket to — a
/// human takes over where the pipeline stopped.
const IN_PROGRESS_STATUS: &str = "in progress";

/// ClickUp status the "finish" action moves the task to.
const TO_DEPLOY_STATUS: &str = "to deploy";

/// Longest branch-name suffix generated from a ticket title.
const MAX_BRANCH_SLUG_LEN: usize = 40;

// =============================================================================
// Types (camelCase for the frontend)
// =============================================================================

/// A pipeline PR surfaced from the dashboard `/prs` endpoint, scoped to one repo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiPipelinePr {
    pub number: u32,
    pub title: String,
    pub branch: String,
    pub url: String,
    /// CI rollup: `SUCCESS` | `FAILURE` | `PENDING` (or absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ci: Option<String>,
    pub is_draft: bool,
    /// `MERGEABLE` | `CONFLICTING` | `UNKNOWN` (or absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mergeable: Option<String>,
    pub created_at: String,
    pub labels: Vec<String>,
    /// GitHub `owner/repo` slug this PR belongs to.
    pub repo_slug: String,
    /// ClickUp task id derived from the `CU-<id>` branch convention, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clickup_task_id: Option<String>,
}

/// A pickable ClickUp ticket (unassigned or mine), joined with its GitHub PR in
/// the current project's repo when there is one. ClickUp drives the list (source
/// of truth for status + assignment); the PR carries the resume target and its
/// CI/mergeable state (CI may legitimately be red).
///
/// `pr` is `None` only in the STUCK bucket: the pipeline sometimes gives up
/// before pushing anything, and those tickets are still worth picking up.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiPipelineTask {
    pub task_id: String,
    pub name: String,
    /// ClickUp status name (e.g. `to review`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// `true` when the ticket is already assigned to me, `false` when it is
    /// unassigned (free to grab).
    pub assigned_to_me: bool,
    /// ClickUp task URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// ClickUp tag names (`ai-done`, `ai-escalade`, …) — they say a lot about
    /// why a ticket is where it is, so the list surfaces them.
    pub tags: Vec<String>,
    /// ClickUp priority (`urgent` | `high` | `normal` | `low`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    /// Last ClickUp update, epoch milliseconds as a string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// The matching pipeline PR in this repo, when the pipeline pushed one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<AiPipelinePr>,
}

/// The two pickable buckets, fetched together (one `gh` call + one ClickUp
/// round-trip serve both).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiPipelineTaskLists {
    /// `to review` / `in review` tickets whose PR is ready (non-draft).
    pub review: Vec<AiPipelineTask>,
    /// `stuck` tickets, with or without a PR.
    pub stuck: Vec<AiPipelineTask>,
}

/// Outcome of one best-effort sub-step (so a partial success is still reported).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub ok: bool,
    pub message: String,
}

impl StepResult {
    fn ok(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: message.into(),
        }
    }

    fn fail(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
        }
    }
}

/// Result of resuming a pipeline PR: the worktree (always created on success),
/// plus the per-side self-assign outcomes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResult {
    pub worktree: Worktree,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clickup_task_id: Option<String>,
    pub github: StepResult,
    pub clickup: StepResult,
}

/// Result of finishing a pipeline PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishResult {
    pub clickup: StepResult,
    pub merge: StepResult,
}

// =============================================================================
// Pure helpers (unit-tested without disk/network)
// =============================================================================

/// Extract the `owner/repo` slug from a normalized GitHub URL.
fn repo_slug_from_github_url(url: &str) -> Option<String> {
    url.strip_prefix("https://github.com/")
        .map(|s| s.trim_end_matches('/').trim_end_matches(".git").to_string())
        .filter(|s| !s.is_empty())
}

/// One check's contribution to the CI rollup.
#[derive(Debug, PartialEq)]
enum CiVerdict {
    Pass,
    Pending,
    Fail,
}

/// Classify a single `statusCheckRollup` entry (a `CheckRun` or a legacy
/// `StatusContext`) as pass / pending / fail. Pure so it is unit-tested.
fn classify_check(check: &serde_json::Value) -> CiVerdict {
    match check.get("__typename").and_then(|t| t.as_str()) {
        Some("CheckRun") => {
            if check.get("status").and_then(|s| s.as_str()) != Some("COMPLETED") {
                return CiVerdict::Pending;
            }
            match check.get("conclusion").and_then(|c| c.as_str()) {
                Some("SUCCESS") | Some("NEUTRAL") | Some("SKIPPED") => CiVerdict::Pass,
                Some("") | None => CiVerdict::Pending,
                // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE, STALE…
                _ => CiVerdict::Fail,
            }
        }
        Some("StatusContext") => match check.get("state").and_then(|s| s.as_str()) {
            Some("SUCCESS") => CiVerdict::Pass,
            Some("PENDING") | Some("EXPECTED") => CiVerdict::Pending,
            // FAILURE, ERROR…
            _ => CiVerdict::Fail,
        },
        // Unknown entry shape: don't let it force a fail/pending.
        _ => CiVerdict::Pass,
    }
}

/// Roll up GitHub's `statusCheckRollup` array into a single `SUCCESS` |
/// `FAILURE` | `PENDING`, or `None` when there are no checks. Any failure wins,
/// then any pending, else success. Pure so it is unit-tested.
fn rollup_ci(rollup: Option<&serde_json::Value>) -> Option<String> {
    let arr = rollup.and_then(|r| r.as_array())?;
    if arr.is_empty() {
        return None;
    }
    let mut any_pending = false;
    for check in arr {
        match classify_check(check) {
            CiVerdict::Fail => return Some("FAILURE".to_string()),
            CiVerdict::Pending => any_pending = true,
            CiVerdict::Pass => {}
        }
    }
    Some(if any_pending { "PENDING" } else { "SUCCESS" }.to_string())
}

/// Parse the `gh pr list --json …` array into this repo's pipeline PRs.
///
/// A PR is "pipeline" when its branch follows the `CU-<id>` convention (the
/// reliable signal — the label is added late by review steps) **or** it carries
/// the configured pipeline `label`. The CI rollup is derived from
/// `statusCheckRollup`. `repo_slug` is the `owner/repo` the PRs belong to.
fn parse_gh_prs(value: &serde_json::Value, repo_slug: &str, label: &str) -> Vec<AiPipelinePr> {
    let mut out = Vec::new();
    let Some(prs) = value.as_array() else {
        return out;
    };

    for pr in prs {
        let Some(number) = pr.get("number").and_then(|n| n.as_u64()) else {
            continue;
        };
        let branch = pr
            .get("headRefName")
            .and_then(|b| b.as_str())
            .unwrap_or("")
            .to_string();
        // gh `labels` is an array of objects: `[{ "name": "…" }, …]`.
        let labels: Vec<String> = pr
            .get("labels")
            .and_then(|l| l.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let clickup_task_id = parse_clickup_task_id_from_branch(&branch);
        let is_pipeline = clickup_task_id.is_some() || labels.iter().any(|l| l == label);
        if !is_pipeline {
            continue;
        }

        out.push(AiPipelinePr {
            number: number as u32,
            title: pr
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
            branch,
            url: pr
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string(),
            ci: rollup_ci(pr.get("statusCheckRollup")),
            is_draft: pr.get("isDraft").and_then(|d| d.as_bool()).unwrap_or(false),
            mergeable: pr
                .get("mergeable")
                .and_then(|m| m.as_str())
                .map(String::from),
            created_at: pr
                .get("createdAt")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string(),
            labels,
            repo_slug: repo_slug.to_string(),
            clickup_task_id,
        });
    }

    // Newest first (ISO-8601 timestamps sort lexicographically).
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Build the `task_id -> PR` join map. Pure so it is unit-tested. PRs without a
/// `CU-<id>` task id can't be joined and are always dropped.
///
/// `include_drafts` splits the two buckets: a review ticket needs a **ready**
/// PR (a draft means the pipeline hasn't finished), while a STUCK ticket is
/// precisely the case where the draft PR is what you want to pick up.
fn pr_by_task(prs: &[AiPipelinePr], include_drafts: bool) -> HashMap<String, AiPipelinePr> {
    prs.iter()
        .filter(|pr| include_drafts || !pr.is_draft)
        .filter_map(|pr| pr.clickup_task_id.clone().map(|id| (id, pr.clone())))
        .collect()
}

/// Which list a pickable ticket belongs to.
#[derive(Debug, Clone, Copy, PartialEq)]
enum TaskBucket {
    /// `to review` / `in review` — the pipeline is done, waiting on a human.
    Review,
    /// `stuck` — the pipeline gave up; a human takes over.
    Stuck,
}

/// Status + (unassigned OR mine) inclusion filter. Pure so it is unit-tested.
/// Returns the bucket and whether the ticket is already mine, or `None` when it
/// must be excluded (status we don't care about, or owned by someone else).
fn task_inclusion(
    status: Option<&str>,
    assignee_ids: &[i64],
    me_id: i64,
) -> Option<(TaskBucket, bool)> {
    let status = status?;
    let bucket = if REVIEW_STATUSES
        .iter()
        .any(|r| status.eq_ignore_ascii_case(r))
    {
        TaskBucket::Review
    } else if status.eq_ignore_ascii_case(STUCK_STATUS) {
        TaskBucket::Stuck
    } else {
        return None;
    };

    let assigned_to_me = assignee_ids.contains(&me_id);
    let unassigned = assignee_ids.is_empty();
    if assigned_to_me || unassigned {
        Some((bucket, assigned_to_me))
    } else {
        None
    }
}

/// Slugify a ClickUp ticket name into a branch-safe suffix: lowercase ASCII
/// words joined by `-`, truncated on a word boundary. Emojis and accents (both
/// common in the tickets) are dropped rather than transliterated — the id in
/// front of it is what carries the meaning. Pure so it is unit-tested.
fn slugify_branch_suffix(name: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        words.push(current);
    }

    let mut slug = String::new();
    for word in words {
        if slug.is_empty() {
            if word.len() > MAX_BRANCH_SLUG_LEN {
                return word[..MAX_BRANCH_SLUG_LEN].to_string();
            }
            slug = word;
        } else if slug.len() + 1 + word.len() <= MAX_BRANCH_SLUG_LEN {
            slug.push('-');
            slug.push_str(&word);
        } else {
            break;
        }
    }
    slug
}

/// Branch name for a ticket the pipeline never pushed a PR for. Follows the
/// same `CU-<id>-<slug>` convention as the pipeline, so every ClickUp link in
/// Jean (worktree → task resolution, `finish`) keeps working. Pure so it is
/// unit-tested.
fn pipeline_branch_name(task_id: &str, task_name: &str) -> String {
    let slug = slugify_branch_suffix(task_name);
    if slug.is_empty() {
        format!("CU-{task_id}")
    } else {
        format!("CU-{task_id}-{slug}")
    }
}

/// Decide whether the current user may self-assign given the existing assignee
/// logins. Pure so the guard logic is unit-tested. Returns the action message on
/// allow, or an error message when the PR is owned by someone else.
fn github_assign_decision(me: &str, assignees: &[String]) -> Result<GithubAssign, String> {
    if assignees.iter().any(|a| a.eq_ignore_ascii_case(me)) {
        return Ok(GithubAssign::AlreadyMine);
    }
    if !assignees.is_empty() {
        return Err(format!("PR déjà assignée à {}", assignees.join(", ")));
    }
    Ok(GithubAssign::Assign)
}

#[derive(Debug, PartialEq)]
enum GithubAssign {
    AlreadyMine,
    Assign,
}

// =============================================================================
// Internal (disk/network) helpers
// =============================================================================

fn project_path_for(app: &AppHandle, project_id: &str) -> Result<String, String> {
    let data = load_projects_data(app)?;
    data.find_project(project_id)
        .map(|p| p.path.clone())
        .ok_or_else(|| format!("Project not found: {project_id}"))
}

fn repo_slug_for_path(project_path: &str) -> Result<String, String> {
    let url = get_github_url(project_path)?;
    repo_slug_from_github_url(&url)
        .ok_or_else(|| format!("Could not parse owner/repo from GitHub URL: {url}"))
}

/// Fetch this repo's open PRs as the raw `gh pr list --json …` array. Replaces
/// the former internal-dashboard `/prs` call: the PR state Jean needs (CI,
/// draft, mergeable, branch, labels) all comes from GitHub directly, so no
/// extra service/credential is required beyond the `gh` auth Jean already has.
fn fetch_repo_prs_json(app: &AppHandle, repo_slug: &str) -> Result<serde_json::Value, String> {
    let gh = resolve_gh_binary(app);
    let output = silent_command(&gh)
        .args([
            "pr",
            "list",
            "--repo",
            repo_slug,
            "--state",
            "open",
            "--limit",
            "300",
            "--json",
            "number,title,headRefName,url,isDraft,mergeable,statusCheckRollup,createdAt,labels",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr list: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr list failed: {stderr}"));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse gh pr list output: {e}"))
}

/// Current GitHub login from `gh api user`.
fn gh_login(app: &AppHandle) -> Result<String, String> {
    let gh = resolve_gh_binary(app);
    let output = silent_command(&gh)
        .args(["api", "user", "--jq", ".login"])
        .output()
        .map_err(|e| format!("Failed to run gh api user: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh api user failed: {stderr}"));
    }
    let login = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if login.is_empty() {
        return Err("gh api user returned an empty login".to_string());
    }
    Ok(login)
}

/// Read the PR's current assignee logins via `gh pr view`.
fn gh_pr_assignees(
    app: &AppHandle,
    repo_slug: &str,
    pr_number: u32,
) -> Result<Vec<String>, String> {
    let gh = resolve_gh_binary(app);
    let output = silent_command(&gh)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--repo",
            repo_slug,
            "--json",
            "assignees",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr view: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr view failed: {stderr}"));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse gh pr view output: {e}"))?;
    let assignees = value
        .get("assignees")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.get("login").and_then(|l| l.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(assignees)
}

/// Self-assign the PR via `gh pr edit --add-assignee @me`, guarded against
/// stealing a PR already assigned to someone else. Returns a human message.
fn assign_pr_guarded(app: &AppHandle, repo_slug: &str, pr_number: u32) -> Result<String, String> {
    let me = gh_login(app)?;
    let assignees = gh_pr_assignees(app, repo_slug, pr_number)?;

    match github_assign_decision(&me, &assignees)? {
        GithubAssign::AlreadyMine => Ok("PR déjà assignée à toi".to_string()),
        GithubAssign::Assign => {
            let gh = resolve_gh_binary(app);
            let output = silent_command(&gh)
                .args([
                    "pr",
                    "edit",
                    &pr_number.to_string(),
                    "--repo",
                    repo_slug,
                    "--add-assignee",
                    "@me",
                ])
                .output()
                .map_err(|e| format!("Failed to run gh pr edit: {e}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("gh pr edit failed: {stderr}"));
            }
            Ok("PR auto-assignée".to_string())
        }
    }
}

/// Self-assign the ClickUp task, guarded against stealing a task already
/// assigned to someone else. Returns a human message.
async fn assign_clickup_guarded(
    app: &AppHandle,
    task_id: &str,
    project_id: &str,
) -> Result<String, String> {
    let me = get_clickup_me(app.clone(), Some(project_id.to_string())).await?;
    let task = get_clickup_task(
        app.clone(),
        task_id.to_string(),
        Some(project_id.to_string()),
    )
    .await?;

    let mine = task.assignees.iter().any(|a| a.id == me.id);
    if mine {
        return Ok("Tâche déjà assignée à toi".to_string());
    }
    if !task.assignees.is_empty() {
        let others: Vec<String> = task
            .assignees
            .iter()
            .map(|a| a.username.clone().unwrap_or_else(|| a.id.to_string()))
            .collect();
        return Err(format!("Tâche déjà assignée à {}", others.join(", ")));
    }

    assign_clickup_task_to_me(
        app.clone(),
        task_id.to_string(),
        Some(project_id.to_string()),
    )
    .await?;
    Ok("Tâche auto-assignée".to_string())
}

/// Claim a ClickUp task when resuming it: self-assign (guarded), then move it to
/// `target_status`. Returned as a single combined step. The status is only
/// changed once the task is ours — a task owned by someone else is left
/// untouched (the guard fails first, so we never move someone else's ticket).
async fn claim_clickup_task(
    app: &AppHandle,
    task_id: &str,
    project_id: &str,
    target_status: &str,
) -> StepResult {
    // Self-assign first; bail out (without touching the status) if it is not ours.
    let assigned = match assign_clickup_guarded(app, task_id, project_id).await {
        Ok(m) => m,
        Err(e) => return StepResult::fail(e),
    };

    // Now we own it: move it into the target column.
    match update_clickup_task_status(
        app.clone(),
        task_id.to_string(),
        target_status.to_string(),
        Some(project_id.to_string()),
    )
    .await
    {
        Ok(_) => StepResult::ok(format!("{assigned} → {}", target_status.to_uppercase())),
        Err(e) => StepResult::fail(format!("{assigned}, mais statut non changé : {e}")),
    }
}

/// Fetch the pickable ClickUp tickets (review columns + `stuck`) from every
/// configured list (Planexpo + Sprint), deduped by id. Uses the API status
/// filter and a client-side guard.
fn pickable_tasks_path(list_id: &str) -> String {
    let status_query = REVIEW_STATUSES
        .iter()
        .chain(std::iter::once(&STUCK_STATUS))
        .map(|s| format!("statuses%5B%5D={}", s.replace(' ', "%20")))
        .collect::<Vec<_>>()
        .join("&");

    format!("/list/{list_id}/task?{status_query}&include_closed=false&subtasks=true")
}

async fn fetch_pickable_tasks(
    app: &AppHandle,
    project_id: &str,
) -> Result<Vec<ClickUpTask>, String> {
    let token = resolve_clickup_token(app, Some(project_id))?;
    let config = load_clickup_config(app)?;

    let lists: Vec<String> = [config.planexpo_list_id, config.sprint_list_id]
        .into_iter()
        .flatten()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lists.is_empty() {
        return Err(
            "No ClickUp list configured. Set a list id in Settings → Integrations.".to_string(),
        );
    }

    // Resilient: a misconfigured list (e.g. a workspace id pasted as a list id →
    // 404) must not blank the whole feature. Skip failing lists and continue;
    // only surface an error when *every* configured list failed (e.g. bad token).
    let mut seen = HashSet::new();
    let mut tasks = Vec::new();
    let mut any_ok = false;
    let mut last_err: Option<String> = None;
    for list_id in lists {
        let path = pickable_tasks_path(&list_id);
        match clickup_get(&token, &path).await {
            Ok(value) => {
                any_ok = true;
                if let Some(arr) = value.get("tasks").and_then(|t| t.as_array()) {
                    for raw in arr {
                        if let Ok(task) = serde_json::from_value::<ClickUpTask>(raw.clone()) {
                            if seen.insert(task.id.clone()) {
                                tasks.push(task);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::warn!("AI pipeline: skipping ClickUp list {list_id}: {e}");
                last_err = Some(e);
            }
        }
    }
    if !any_ok {
        if let Some(e) = last_err {
            return Err(e);
        }
    }
    Ok(tasks)
}

// =============================================================================
// Tauri commands
// =============================================================================

/// List the AI pipeline PRs for a project (scoped to its GitHub repo).
pub async fn list_ai_pipeline_prs(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<AiPipelinePr>, String> {
    let config = load_ai_pipeline_config(&app)?;
    let label = config.effective_label();

    let project_path = project_path_for(&app, &project_id)?;
    let slug = repo_slug_for_path(&project_path)?;

    let value = fetch_repo_prs_json(&app, &slug)?;
    Ok(parse_gh_prs(&value, &slug, &label))
}

/// List the pickable ClickUp tickets (unassigned or mine) for a project, in two
/// buckets: the review columns and the `stuck` column.
///
/// ClickUp is the source of truth. A **review** ticket needs a ready PR in this
/// repo — a draft means the pipeline hasn't finished, and a ticket whose PR
/// lives in another repo isn't ours to show. Red CI is still shown (review can
/// act on it). A **stuck** ticket is listed with or without a PR: the pipeline
/// sometimes gives up before pushing anything, and picking those up is exactly
/// what the bucket is for.
pub async fn list_ai_pipeline_tasks(
    app: AppHandle,
    project_id: String,
) -> Result<AiPipelineTaskLists, String> {
    // This repo's pipeline PRs, keyed by their ClickUp task id (for the join).
    let config = load_ai_pipeline_config(&app)?;
    let label = config.effective_label();
    let project_path = project_path_for(&app, &project_id)?;
    let slug = repo_slug_for_path(&project_path)?;
    let value = fetch_repo_prs_json(&app, &slug)?;
    let prs = parse_gh_prs(&value, &slug, &label);
    let ready_pr_by_task = pr_by_task(&prs, false);
    let any_pr_by_task = pr_by_task(&prs, true);

    // Pickable ClickUp tickets + the current user (assignment filter).
    let me = get_clickup_me(app.clone(), Some(project_id.clone())).await?;
    let tasks = fetch_pickable_tasks(&app, &project_id).await?;

    let mut review: Vec<AiPipelineTask> = Vec::new();
    let mut stuck: Vec<AiPipelineTask> = Vec::new();
    for task in tasks {
        let assignee_ids: Vec<i64> = task.assignees.iter().map(|a| a.id).collect();
        let status = task.status.as_ref().map(|s| s.status.as_str());
        let Some((bucket, assigned_to_me)) = task_inclusion(status, &assignee_ids, me.id) else {
            continue;
        };

        let pr = match bucket {
            // Repo scoping + resume target: a review ticket without a ready PR
            // in this repo has nothing to pick up.
            TaskBucket::Review => match ready_pr_by_task.get(&task.id) {
                Some(pr) => Some(pr.clone()),
                None => continue,
            },
            TaskBucket::Stuck => any_pr_by_task.get(&task.id).cloned(),
        };

        let item = AiPipelineTask {
            task_id: task.id.clone(),
            name: task.name.clone(),
            status: task.status.as_ref().map(|s| s.status.clone()),
            assigned_to_me,
            url: task.url.clone(),
            tags: task.tags.iter().map(|t| t.name.clone()).collect(),
            priority: task.priority.as_ref().map(|p| p.priority.clone()),
            updated_at: task.date_updated.clone(),
            pr,
        };
        match bucket {
            TaskBucket::Review => review.push(item),
            TaskBucket::Stuck => stuck.push(item),
        }
    }

    // Mine first, then newest PR first — every review item has a PR.
    review.sort_by(|a, b| {
        b.assigned_to_me
            .cmp(&a.assigned_to_me)
            .then_with(|| pr_created_at(b).cmp(pr_created_at(a)))
    });
    // Stuck items may have no PR, so recency comes from ClickUp (epoch ms).
    stuck.sort_by(|a, b| {
        b.assigned_to_me
            .cmp(&a.assigned_to_me)
            .then_with(|| updated_ms(b).cmp(&updated_ms(a)))
    });
    Ok(AiPipelineTaskLists { review, stuck })
}

/// PR creation timestamp (ISO-8601, sorts lexicographically), empty when the
/// ticket has no PR.
fn pr_created_at(task: &AiPipelineTask) -> &str {
    task.pr
        .as_ref()
        .map(|pr| pr.created_at.as_str())
        .unwrap_or("")
}

/// ClickUp `date_updated` as a number (the API sends epoch ms as a string).
fn updated_ms(task: &AiPipelineTask) -> i64 {
    task.updated_at
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
}

/// Self-assign the GitHub PR to the current user (guarded). Standalone command;
/// `resume_ai_pipeline_pr` performs this as part of its flow.
pub async fn assign_pr_to_me(
    app: AppHandle,
    project_id: String,
    pr_number: u32,
) -> Result<StepResult, String> {
    let project_path = project_path_for(&app, &project_id)?;
    let slug = repo_slug_for_path(&project_path)?;
    Ok(match assign_pr_guarded(&app, &slug, pr_number) {
        Ok(m) => StepResult::ok(m),
        Err(e) => StepResult::fail(e),
    })
}

/// Resume a pipeline ticket: get a worktree for it, self-assign the GitHub PR
/// when there is one, and claim the linked ClickUp task (self-assign + status
/// move). The worktree creation must succeed; the GitHub and ClickUp steps are
/// best-effort and reported individually.
///
/// Two shapes, one action:
/// - **with a PR** (`pr_number`) → `checkout_pr`, then self-assign that PR;
/// - **without a PR** (a `stuck` ticket the pipeline never pushed) → a fresh
///   worktree on a `CU-<id>-<slug>` branch off the project's default branch, so
///   the ClickUp link still resolves from the branch name.
///
/// `target_status` defaults to `in review` with a PR (a human is reviewing the
/// pipeline's work) and `in progress` without one (a human is doing the work).
pub async fn resume_ai_pipeline_task(
    app: AppHandle,
    project_id: String,
    task_id: String,
    pr_number: Option<u32>,
    target_status: Option<String>,
) -> Result<ResumeResult, String> {
    let project_path = project_path_for(&app, &project_id)?;
    let slug = repo_slug_for_path(&project_path)?;

    // 1. Worktree (hard requirement) + 2. GitHub side (best effort).
    let (worktree, github) = match pr_number {
        Some(number) => {
            let worktree = checkout_pr(app.clone(), project_id.clone(), number).await?;
            let github = match assign_pr_guarded(&app, &slug, number) {
                Ok(m) => StepResult::ok(m),
                Err(e) => StepResult::fail(e),
            };
            (worktree, github)
        }
        None => {
            // No PR: name the branch after the ticket so Jean's ClickUp link
            // (and the pipeline's own convention) still resolves.
            let task =
                get_clickup_task(app.clone(), task_id.clone(), Some(project_id.clone())).await?;
            let branch = pipeline_branch_name(&task_id, &task.name);
            let worktree = create_worktree(
                app.clone(),
                project_id.clone(),
                None, // base_branch
                None, // issue_context
                None, // pr_context
                None, // security_context
                None, // advisory_context
                None, // linear_context
                None, // sentry_context
                Some(branch.clone()),
                Some(true),
                None, // origin
            )
            .await?;
            (
                worktree,
                StepResult::ok(format!("Aucune PR — branche {branch}")),
            )
        }
    };

    // 3. ClickUp claim (best effort): self-assign + status move. The id comes
    //    from the branch when there is one (the PR may belong to another
    //    ticket than the one clicked), else from the caller.
    let clickup_task_id = parse_clickup_task_id_from_branch(&worktree.branch).or(Some(task_id));
    let status = target_status.unwrap_or_else(|| {
        if pr_number.is_some() {
            IN_REVIEW_STATUS.to_string()
        } else {
            IN_PROGRESS_STATUS.to_string()
        }
    });
    let clickup = match &clickup_task_id {
        Some(id) => claim_clickup_task(&app, id, &project_id, &status).await,
        None => StepResult::fail("Aucune tâche ClickUp liée à la branche"),
    };

    Ok(ResumeResult {
        worktree,
        clickup_task_id,
        github,
        clickup,
    })
}

/// Finish a pipeline PR in one action: move the ClickUp task to `to deploy` and
/// merge the PR. Both steps are reported individually.
pub async fn finish_ai_pipeline_pr(
    app: AppHandle,
    worktree_path: String,
    project_id: String,
    task_id: Option<String>,
) -> Result<FinishResult, String> {
    log::info!("[FinishPipeline] start project={project_id} task={task_id:?} path={worktree_path}");

    // Prepare GitHub before mutating ClickUp. Draft PRs are marked ready first,
    // so a preparation failure cannot strand the task in TO DEPLOY.
    if let Err(error) = prepare_github_pr_for_merge(&app, &worktree_path) {
        log::warn!("[FinishPipeline] preflight failed: {error}");
        return Err(error);
    }

    // 1. ClickUp → TO DEPLOY (skipped with a message when no task is linked).
    let clickup = match &task_id {
        Some(id) => match update_clickup_task_status(
            app.clone(),
            id.clone(),
            TO_DEPLOY_STATUS.to_string(),
            Some(project_id.clone()),
        )
        .await
        {
            Ok(_) => StepResult::ok("Tâche → TO DEPLOY"),
            Err(e) => StepResult::fail(e),
        },
        None => StepResult::fail("Aucune tâche ClickUp liée"),
    };

    // 2. Merge the PR.
    let merge = match merge_github_pr(app.clone(), worktree_path).await {
        Ok(r) => StepResult::ok(r.message),
        Err(e) => StepResult::fail(e),
    };

    if clickup.ok && merge.ok {
        log::info!(
            "[FinishPipeline] completed: {} / {}",
            clickup.message,
            merge.message
        );
    } else {
        log::warn!(
            "[FinishPipeline] partial failure: {} / {}",
            clickup.message,
            merge.message
        );
    }

    Ok(FinishResult { clickup, merge })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pickable_tasks_query_includes_subtasks() {
        let path = pickable_tasks_path("46575365");

        assert_eq!(
            path,
            "/list/46575365/task?statuses%5B%5D=to%20review&statuses%5B%5D=in%20review&statuses%5B%5D=stuck&include_closed=false&subtasks=true"
        );
    }

    /// Mirrors a `gh pr list --json …` array for one repo (Spottt/planexpo).
    fn sample_payload() -> serde_json::Value {
        serde_json::json!([
            {
                "number": 3977,
                "title": "feat(86c997enp): identifiant national",
                "headRefName": "CU-86c997enp__national-id",
                "url": "https://github.com/Spottt/planexpo/pull/3977",
                "statusCheckRollup": [
                    {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE"}
                ],
                "isDraft": true,
                "mergeable": "UNKNOWN",
                "createdAt": "2026-06-22T13:54:26Z",
                "labels": []
            },
            {
                "number": 3976,
                "title": "feat(86cac8hvh): Emailing 2eme passe",
                "headRefName": "CU-86cac8hvh-emailing-2eme-passe",
                "url": "https://github.com/Spottt/planexpo/pull/3976",
                "statusCheckRollup": [
                    {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
                    {"__typename": "StatusContext", "state": "SUCCESS"}
                ],
                "isDraft": true,
                "mergeable": "MERGEABLE",
                "createdAt": "2026-06-22T11:25:25Z",
                "labels": [{"name": "ai-full-flow"}]
            },
            {
                "number": 100,
                "title": "chore: human PR not from pipeline",
                "headRefName": "fix/manual-tweak",
                "url": "https://github.com/Spottt/planexpo/pull/100",
                "statusCheckRollup": [
                    {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"}
                ],
                "isDraft": false,
                "mergeable": "MERGEABLE",
                "createdAt": "2026-06-10T09:00:00Z",
                "labels": []
            },
            {
                "number": 101,
                "title": "feat: labeled but no CU branch",
                "headRefName": "feature/labeled",
                "url": "https://github.com/Spottt/planexpo/pull/101",
                "statusCheckRollup": [
                    {"__typename": "CheckRun", "status": "IN_PROGRESS"}
                ],
                "isDraft": false,
                "mergeable": "MERGEABLE",
                "createdAt": "2026-06-09T09:00:00Z",
                "labels": [{"name": "ai-full-flow"}]
            }
        ])
    }

    #[test]
    fn tags_every_pr_with_the_queried_repo() {
        let prs = parse_gh_prs(&sample_payload(), "Spottt/planexpo", "ai-full-flow");
        assert!(prs.iter().all(|p| p.repo_slug == "Spottt/planexpo"));
    }

    #[test]
    fn includes_cu_branch_even_without_label() {
        let prs = parse_gh_prs(&sample_payload(), "Spottt/planexpo", "ai-full-flow");
        let pr = prs
            .iter()
            .find(|p| p.number == 3977)
            .expect("CU PR present");
        assert_eq!(pr.clickup_task_id.as_deref(), Some("86c997enp"));
        assert!(pr.labels.is_empty());
    }

    #[test]
    fn includes_labeled_pr_without_cu_branch() {
        let prs = parse_gh_prs(&sample_payload(), "Spottt/planexpo", "ai-full-flow");
        let pr = prs
            .iter()
            .find(|p| p.number == 101)
            .expect("labeled PR present");
        assert!(pr.clickup_task_id.is_none());
        assert_eq!(pr.labels, vec!["ai-full-flow".to_string()]);
    }

    #[test]
    fn excludes_human_pr_without_label_or_cu_branch() {
        let prs = parse_gh_prs(&sample_payload(), "Spottt/planexpo", "ai-full-flow");
        assert!(!prs.iter().any(|p| p.number == 100));
    }

    #[test]
    fn sorted_newest_first() {
        let prs = parse_gh_prs(&sample_payload(), "Spottt/planexpo", "ai-full-flow");
        let dates: Vec<&str> = prs.iter().map(|p| p.created_at.as_str()).collect();
        let mut sorted = dates.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(dates, sorted);
    }

    #[test]
    fn maps_pr_fields_and_rolls_up_ci() {
        let prs = parse_gh_prs(&sample_payload(), "Spottt/planexpo", "ai-full-flow");
        let pr = prs.iter().find(|p| p.number == 3976).unwrap();
        assert_eq!(pr.ci.as_deref(), Some("SUCCESS")); // rolled up from checks
        assert!(pr.is_draft);
        assert_eq!(pr.mergeable.as_deref(), Some("MERGEABLE"));
        assert_eq!(pr.clickup_task_id.as_deref(), Some("86cac8hvh"));
        // #3977 has a failing check, #101 an in-progress one.
        assert_eq!(
            prs.iter().find(|p| p.number == 3977).unwrap().ci.as_deref(),
            Some("FAILURE")
        );
        assert_eq!(
            prs.iter().find(|p| p.number == 101).unwrap().ci.as_deref(),
            Some("PENDING")
        );
    }

    #[test]
    fn stuck_join_keeps_draft_prs() {
        // A stuck ticket's PR is typically still a draft — that's the point.
        let payload = serde_json::json!([
            {
                "number": 1,
                "title": "draft",
                "headRefName": "CU-aaa-draft",
                "url": "https://github.com/Spottt/planexpo/pull/1",
                "statusCheckRollup": [],
                "isDraft": true,
                "createdAt": "2026-01-01T00:00:00Z",
                "labels": []
            }
        ]);
        let prs = parse_gh_prs(&payload, "Spottt/planexpo", "ai-full-flow");
        assert!(pr_by_task(&prs, true).contains_key("aaa"));
        assert!(!pr_by_task(&prs, false).contains_key("aaa"));
    }

    #[test]
    fn stuck_bucket_detected_and_scoped_to_free_or_mine() {
        assert_eq!(
            task_inclusion(Some("stuck"), &[], 7),
            Some((TaskBucket::Stuck, false))
        );
        assert_eq!(
            task_inclusion(Some("STUCK"), &[7], 7),
            Some((TaskBucket::Stuck, true))
        );
        // Someone else's stuck ticket is not ours to grab.
        assert_eq!(task_inclusion(Some("stuck"), &[3], 7), None);
    }

    #[test]
    fn review_and_stuck_land_in_distinct_buckets() {
        assert_eq!(
            task_inclusion(Some("to review"), &[], 7),
            Some((TaskBucket::Review, false))
        );
        assert_eq!(
            task_inclusion(Some("in review"), &[], 7),
            Some((TaskBucket::Review, false))
        );
        assert_eq!(
            task_inclusion(Some("stuck"), &[], 7),
            Some((TaskBucket::Stuck, false))
        );
    }

    #[test]
    fn branch_name_follows_the_pipeline_convention() {
        assert_eq!(
            pipeline_branch_name("86canbg67", "Arrondis TTC incorrects sur les factures"),
            "CU-86canbg67-arrondis-ttc-incorrects-sur-les-factures"
        );
        // The next word would blow the budget, so it is dropped whole.
        assert_eq!(
            pipeline_branch_name(
                "86canbg67",
                "Arrondis TTC incorrects sur les factures groupe"
            ),
            "CU-86canbg67-arrondis-ttc-incorrects-sur-les-factures"
        );
    }

    #[test]
    fn branch_slug_drops_emojis_and_accents() {
        // Real ticket titles start with an emoji and are full of accents.
        assert_eq!(
            slugify_branch_suffix("💡 ETO je peux activer les exports"),
            "eto-je-peux-activer-les-exports"
        );
        assert_eq!(slugify_branch_suffix("Événement à créer"), "v-nement-cr-er");
    }

    #[test]
    fn branch_slug_is_bounded_and_never_ends_on_a_dash() {
        let slug = slugify_branch_suffix(
            "un titre vraiment tres long qui depasse largement la limite autorisee",
        );
        assert!(slug.len() <= MAX_BRANCH_SLUG_LEN, "slug too long: {slug}");
        assert!(!slug.ends_with('-'));
        // A single oversized word is truncated rather than dropped.
        let long_word = slugify_branch_suffix(&"a".repeat(80));
        assert_eq!(long_word.len(), MAX_BRANCH_SLUG_LEN);
    }

    #[test]
    fn branch_name_falls_back_to_the_bare_id() {
        // A title with nothing ASCII left must still yield a valid branch.
        assert_eq!(pipeline_branch_name("86canbg67", "🛑 —"), "CU-86canbg67");
    }

    #[test]
    fn review_join_excludes_draft_prs() {
        // Two CU PRs in the same repo: one draft, one ready.
        let payload = serde_json::json!([
            {
                "number": 1,
                "title": "draft",
                "headRefName": "CU-aaa-draft",
                "url": "https://github.com/Spottt/planexpo/pull/1",
                "statusCheckRollup": [],
                "isDraft": true,
                "createdAt": "2026-01-01T00:00:00Z",
                "labels": []
            },
            {
                "number": 2,
                "title": "ready",
                "headRefName": "CU-bbb-ready",
                "url": "https://github.com/Spottt/planexpo/pull/2",
                "statusCheckRollup": [],
                "isDraft": false,
                "createdAt": "2026-01-02T00:00:00Z",
                "labels": []
            }
        ]);
        let prs = parse_gh_prs(&payload, "Spottt/planexpo", "ai-full-flow");
        let by_task = pr_by_task(&prs, false);
        assert!(by_task.contains_key("bbb"), "non-draft CU PR is pickable");
        assert!(!by_task.contains_key("aaa"), "draft CU PR is hidden");
        assert_eq!(by_task.len(), 1);
    }

    #[test]
    fn empty_payload_yields_no_prs() {
        assert!(parse_gh_prs(&serde_json::json!([]), "Spottt/planexpo", "ai-full-flow").is_empty());
        // A non-array (e.g. a `gh` error object) is tolerated, not panicked on.
        assert!(parse_gh_prs(&serde_json::json!({}), "Spottt/planexpo", "ai-full-flow").is_empty());
    }

    #[test]
    fn ci_rollup_empty_is_none() {
        assert_eq!(rollup_ci(Some(&serde_json::json!([]))), None);
        assert_eq!(rollup_ci(None), None);
    }

    #[test]
    fn ci_rollup_any_failure_wins() {
        let checks = serde_json::json!([
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"__typename": "CheckRun", "status": "IN_PROGRESS"},
            {"__typename": "StatusContext", "state": "FAILURE"}
        ]);
        assert_eq!(rollup_ci(Some(&checks)).as_deref(), Some("FAILURE"));
    }

    #[test]
    fn ci_rollup_pending_when_no_failure() {
        let checks = serde_json::json!([
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"__typename": "CheckRun", "status": "QUEUED"}
        ]);
        assert_eq!(rollup_ci(Some(&checks)).as_deref(), Some("PENDING"));
    }

    #[test]
    fn ci_rollup_success_when_all_pass() {
        let checks = serde_json::json!([
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED"},
            {"__typename": "StatusContext", "state": "SUCCESS"}
        ]);
        assert_eq!(rollup_ci(Some(&checks)).as_deref(), Some("SUCCESS"));
    }

    #[test]
    fn slug_parsed_from_github_url() {
        assert_eq!(
            repo_slug_from_github_url("https://github.com/Spottt/planexpo"),
            Some("Spottt/planexpo".to_string())
        );
        assert_eq!(
            repo_slug_from_github_url("https://github.com/Spottt/planexpo.git"),
            Some("Spottt/planexpo".to_string())
        );
        assert_eq!(repo_slug_from_github_url("https://gitlab.com/x/y"), None);
    }

    #[test]
    fn github_guard_allows_when_unassigned() {
        assert_eq!(
            github_assign_decision("fares", &[]),
            Ok(GithubAssign::Assign)
        );
    }

    #[test]
    fn github_guard_idempotent_when_already_mine() {
        assert_eq!(
            github_assign_decision("fares", &["fares".to_string()]),
            Ok(GithubAssign::AlreadyMine)
        );
        // case-insensitive
        assert_eq!(
            github_assign_decision("Fares", &["fares".to_string()]),
            Ok(GithubAssign::AlreadyMine)
        );
    }

    #[test]
    fn github_guard_blocks_when_assigned_to_other() {
        let decision = github_assign_decision("fares", &["someone-else".to_string()]);
        assert!(decision.is_err());
    }

    #[test]
    fn github_guard_allows_when_mine_among_others() {
        assert_eq!(
            github_assign_decision("fares", &["other".to_string(), "fares".to_string()]),
            Ok(GithubAssign::AlreadyMine)
        );
    }

    #[test]
    fn review_includes_when_assigned_to_me() {
        assert_eq!(
            task_inclusion(Some("to review"), &[7], 7),
            Some((TaskBucket::Review, true))
        );
        // mine among others
        assert_eq!(
            task_inclusion(Some("to review"), &[3, 7], 7),
            Some((TaskBucket::Review, true))
        );
    }

    #[test]
    fn review_excludes_when_assigned_to_other() {
        assert_eq!(task_inclusion(Some("to review"), &[3], 7), None);
        assert_eq!(task_inclusion(Some("in review"), &[3], 7), None);
    }

    #[test]
    fn excludes_statuses_outside_the_pickable_columns() {
        assert_eq!(task_inclusion(Some("in progress"), &[7], 7), None);
        assert_eq!(task_inclusion(Some("to deploy"), &[], 7), None);
        assert_eq!(task_inclusion(None, &[], 7), None);
    }

    #[test]
    fn status_matching_is_case_insensitive() {
        assert_eq!(
            task_inclusion(Some("TO REVIEW"), &[], 7),
            Some((TaskBucket::Review, false))
        );
        assert_eq!(
            task_inclusion(Some("In Review"), &[], 7),
            Some((TaskBucket::Review, false))
        );
    }
}
