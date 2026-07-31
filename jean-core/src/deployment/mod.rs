//! Production deployment cockpit for ClickUp-backed projects.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::AppHandle;

use crate::gh_cli::config::resolve_gh_binary;
use crate::platform::silent_command;
use crate::projects::clickup_client::clickup_get;
use crate::projects::git::get_github_url;
use crate::projects::storage::load_projects_data;
use crate::projects::{
    archive_worktree, clickup_task_id_for_worktree, load_clickup_config,
    parse_clickup_task_id_from_branch, resolve_clickup_token, update_clickup_task_status,
    ClickUpTask,
};

const TO_DEPLOY_STATUS: &str = "to deploy";
const CLOSED_STATUS: &str = "Closed";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DeploymentState {
    Deployed,
    Pending,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPullRequest {
    pub number: u32,
    pub title: String,
    pub branch: String,
    pub url: String,
    pub merge_commit: String,
    pub merged_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentWorktree {
    pub id: String,
    pub name: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentTask {
    pub task_id: String,
    pub name: String,
    pub url: Option<String>,
    pub state: DeploymentState,
    pub pull_request: Option<DeploymentPullRequest>,
    pub worktrees: Vec<DeploymentWorktree>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentOverview {
    pub project_id: String,
    pub project_name: String,
    pub production_sha: String,
    pub remote_branch: String,
    pub version_url: String,
    pub tasks: Vec<DeploymentTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDeploymentResult {
    pub task_id: String,
    pub closed: bool,
    pub archived_worktree_ids: Vec<String>,
    pub archive_errors: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
struct MergedPr {
    task_id: String,
    number: u32,
    title: String,
    branch: String,
    url: String,
    merge_commit: String,
    merged_at: String,
}

fn parse_production_sha(body: &str) -> Result<String, String> {
    let sha = body.trim();
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("The production version endpoint did not return a full Git SHA".to_string());
    }
    Ok(sha.to_ascii_lowercase())
}

fn classify_commit(in_production: bool, on_remote_branch: bool) -> DeploymentState {
    if in_production {
        DeploymentState::Deployed
    } else if on_remote_branch {
        DeploymentState::Pending
    } else {
        DeploymentState::Uncertain
    }
}

fn parse_merged_prs(value: &serde_json::Value) -> Vec<MergedPr> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|raw| {
            let branch = raw.get("headRefName")?.as_str()?.to_string();
            let task_id = parse_clickup_task_id_from_branch(&branch)?;
            let merge_commit = raw.get("mergeCommit")?.get("oid")?.as_str()?.to_string();
            Some(MergedPr {
                task_id,
                number: raw.get("number")?.as_u64()? as u32,
                title: raw.get("title")?.as_str()?.to_string(),
                branch,
                url: raw.get("url")?.as_str()?.to_string(),
                merge_commit,
                merged_at: raw
                    .get("mergedAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect()
}

fn repo_slug(project_path: &str) -> Result<String, String> {
    let url = get_github_url(project_path)?;
    url.strip_prefix("https://github.com/")
        .map(|s| s.trim_end_matches('/').trim_end_matches(".git").to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Could not parse owner/repo from GitHub URL: {url}"))
}

fn command_output(command: &mut std::process::Command, label: &str) -> Result<String, String> {
    let output = command
        .output()
        .map_err(|e| format!("Failed to run {label}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{label} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn fetch_merged_prs(app: &AppHandle, repo: &str) -> Result<Vec<MergedPr>, String> {
    let gh = resolve_gh_binary(app);
    let stdout = command_output(
        silent_command(&gh).args([
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "merged",
            "--limit",
            "500",
            "--json",
            "number,title,headRefName,url,mergedAt,mergeCommit",
        ]),
        "gh pr list",
    )?;
    let value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse gh pr list output: {e}"))?;
    Ok(parse_merged_prs(&value))
}

fn git_fetch(project_path: &str, remote: &str, branch: &str) -> Result<(), String> {
    command_output(
        silent_command("git")
            .args(["fetch", remote, branch])
            .current_dir(project_path),
        "git fetch",
    )?;
    Ok(())
}

fn is_ancestor(project_path: &str, ancestor: &str, descendant: &str) -> Result<bool, String> {
    let status = silent_command("git")
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .current_dir(project_path)
        .status()
        .map_err(|e| format!("Failed to run git merge-base: {e}"))?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err("git merge-base could not compare deployment commits".to_string()),
    }
}

async fn fetch_production_sha(version_url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let response = client
        .get(version_url)
        .send()
        .await
        .map_err(|e| format!("Production version request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Production version endpoint returned {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read production version: {e}"))?;
    parse_production_sha(&body)
}

async fn fetch_to_deploy_tasks(
    app: &AppHandle,
    project_id: &str,
) -> Result<Vec<ClickUpTask>, String> {
    let token = resolve_clickup_token(app, Some(project_id))?;
    let config = load_clickup_config(app)?;
    let list_ids: Vec<String> = [config.planexpo_list_id, config.sprint_list_id]
        .into_iter()
        .flatten()
        .filter(|id| !id.trim().is_empty())
        .collect();
    if list_ids.is_empty() {
        return Err("No ClickUp list configured. Set one in Settings → Integrations.".to_string());
    }

    let mut seen = HashSet::new();
    let mut tasks = Vec::new();
    for list_id in list_ids {
        let path = format!(
            "/list/{list_id}/task?statuses%5B%5D=to%20deploy&include_closed=false&subtasks=true"
        );
        let value = clickup_get(&token, &path).await?;
        for raw in value
            .get("tasks")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            if let Ok(task) = serde_json::from_value::<ClickUpTask>(raw.clone()) {
                if seen.insert(task.id.clone()) {
                    tasks.push(task);
                }
            }
        }
    }
    Ok(tasks)
}

pub async fn get_deployment_overview(
    app: AppHandle,
    project_id: String,
) -> Result<DeploymentOverview, String> {
    let config = load_clickup_config(&app)?;
    let version_url = config
        .production_version_url
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| {
            "No production version URL configured. Add one in Settings → Integrations → ClickUp."
                .to_string()
        })?;
    let data = load_projects_data(&app)?;
    let project = data
        .find_project(&project_id)
        .cloned()
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    let branch = if project.default_branch.trim().is_empty() {
        "master".to_string()
    } else {
        project.default_branch.clone()
    };
    let remote = "origin";
    let remote_branch = format!("{remote}/{branch}");

    let (production_sha, tasks) = tokio::try_join!(
        fetch_production_sha(&version_url),
        fetch_to_deploy_tasks(&app, &project_id)
    )?;
    git_fetch(&project.path, remote, &branch)?;
    let prs = fetch_merged_prs(&app, &repo_slug(&project.path)?)?;
    let prs_by_task: HashMap<String, MergedPr> = prs
        .into_iter()
        .map(|pr| (pr.task_id.to_ascii_lowercase(), pr))
        .collect();

    let mut deployment_tasks = Vec::new();
    for task in tasks {
        let worktrees = data
            .worktrees
            .iter()
            .filter(|worktree| worktree.project_id == project_id && worktree.archived_at.is_none())
            .filter_map(|worktree| {
                let linked = clickup_task_id_for_worktree(&app, worktree)
                    .ok()
                    .flatten()?;
                linked
                    .eq_ignore_ascii_case(&task.id)
                    .then(|| DeploymentWorktree {
                        id: worktree.id.clone(),
                        name: worktree.name.clone(),
                        branch: worktree.branch.clone(),
                    })
            })
            .collect();
        let pr = prs_by_task.get(&task.id.to_ascii_lowercase());
        let (state, pull_request, reason) = match pr {
            Some(pr) => {
                let in_production = is_ancestor(&project.path, &pr.merge_commit, &production_sha)?;
                let on_remote = is_ancestor(&project.path, &pr.merge_commit, &remote_branch)?;
                let state = classify_commit(in_production, on_remote);
                let reason = (state == DeploymentState::Uncertain).then(|| {
                    "Le commit de merge n'appartient ni à la production ni à la branche distante"
                        .to_string()
                });
                (
                    state,
                    Some(DeploymentPullRequest {
                        number: pr.number,
                        title: pr.title.clone(),
                        branch: pr.branch.clone(),
                        url: pr.url.clone(),
                        merge_commit: pr.merge_commit.clone(),
                        merged_at: pr.merged_at.clone(),
                    }),
                    reason,
                )
            }
            None => (
                DeploymentState::Uncertain,
                None,
                Some("Aucune PR mergée avec une branche CU correspondante".to_string()),
            ),
        };
        deployment_tasks.push(DeploymentTask {
            task_id: task.id,
            name: task.name,
            url: task.url,
            state,
            pull_request,
            worktrees,
            reason,
        });
    }
    deployment_tasks.sort_by(|a, b| {
        b.pull_request
            .as_ref()
            .map(|pr| pr.merged_at.as_str())
            .cmp(&a.pull_request.as_ref().map(|pr| pr.merged_at.as_str()))
    });

    Ok(DeploymentOverview {
        project_id,
        project_name: project.name,
        production_sha,
        remote_branch,
        version_url,
        tasks: deployment_tasks,
    })
}

async fn close_verified_task(
    app: &AppHandle,
    project_id: &str,
    task: &DeploymentTask,
) -> Result<CloseDeploymentResult, String> {
    update_clickup_task_status(
        app.clone(),
        task.task_id.clone(),
        CLOSED_STATUS.to_string(),
        Some(project_id.to_string()),
    )
    .await?;

    let mut archived_worktree_ids = Vec::new();
    let mut archive_errors = Vec::new();
    for worktree in &task.worktrees {
        match archive_worktree(app.clone(), worktree.id.clone()).await {
            Ok(()) => archived_worktree_ids.push(worktree.id.clone()),
            Err(error) => archive_errors.push(format!("{}: {error}", worktree.name)),
        }
    }
    Ok(CloseDeploymentResult {
        task_id: task.task_id.clone(),
        closed: true,
        archived_worktree_ids,
        archive_errors,
        error: None,
    })
}

pub async fn close_deployed_task(
    app: AppHandle,
    project_id: String,
    task_id: String,
) -> Result<CloseDeploymentResult, String> {
    let overview = get_deployment_overview(app.clone(), project_id.clone()).await?;
    let task = overview
        .tasks
        .iter()
        .find(|task| task.task_id.eq_ignore_ascii_case(&task_id))
        .ok_or_else(|| format!("TO DEPLOY task not found: {task_id}"))?;
    if task.state != DeploymentState::Deployed {
        return Err("The task cannot be closed because its deployment is not proven".to_string());
    }
    close_verified_task(&app, &project_id, task).await
}

pub async fn close_all_deployed_tasks(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<CloseDeploymentResult>, String> {
    let overview = get_deployment_overview(app.clone(), project_id.clone()).await?;
    let mut results = Vec::new();
    for task in overview
        .tasks
        .iter()
        .filter(|task| task.state == DeploymentState::Deployed)
    {
        match close_verified_task(&app, &project_id, task).await {
            Ok(result) => results.push(result),
            Err(error) => results.push(CloseDeploymentResult {
                task_id: task.task_id.clone(),
                closed: false,
                archived_worktree_ids: Vec::new(),
                archive_errors: Vec::new(),
                error: Some(error),
            }),
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_normalizes_production_sha() {
        assert_eq!(
            parse_production_sha("87d4b167e40c9e51c77c4ccad6ca5402f016f266\n"),
            Ok("87d4b167e40c9e51c77c4ccad6ca5402f016f266".to_string())
        );
        assert!(parse_production_sha("not-a-sha").is_err());
    }

    #[test]
    fn classifies_commit_against_production_and_remote_branch() {
        assert_eq!(classify_commit(true, true), DeploymentState::Deployed);
        assert_eq!(classify_commit(false, true), DeploymentState::Pending);
        assert_eq!(classify_commit(false, false), DeploymentState::Uncertain);
    }

    #[test]
    fn parses_merged_prs_and_ignores_branches_without_clickup_id() {
        let value = serde_json::json!([
            {"number":4231,"title":"Fix invoices","headRefName":"CU-86canbq67-arrondis-ttc","url":"https://github.com/Spottt/planexpo/pull/4231","mergedAt":"2026-07-31T12:00:00Z","mergeCommit":{"oid":"87d4b167e40c9e51c77c4ccad6ca5402f016f266"}},
            {"number":4232,"title":"No ticket","headRefName":"chore/no-ticket","url":"https://github.com/Spottt/planexpo/pull/4232","mergedAt":"2026-07-31T13:00:00Z","mergeCommit":{"oid":"97d4b167e40c9e51c77c4ccad6ca5402f016f266"}}
        ]);
        let prs = parse_merged_prs(&value);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].task_id, "86canbq67");
        assert_eq!(prs[0].number, 4231);
    }
}
