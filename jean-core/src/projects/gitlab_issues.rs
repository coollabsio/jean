//! GitLab issues + merge requests via the `glab` CLI.
//!
//! These functions are the GitLab counterparts to the `gh`-backed commands in
//! [`super::github_issues`]. They are NOT Tauri commands — the existing
//! `list_github_issues` / `list_github_prs` / etc. commands dispatch here when a
//! project resolves to the GitLab provider, so the frontend, MCP, and HTTP
//! dispatch layers keep using the same command names.
//!
//! We shell out to `glab api` (raw GitLab REST) rather than `glab issue list` /
//! `glab mr list`: the REST field names are stable and documented, whereas the
//! subcommands' formatting flags are inconsistent across versions. `glab api`
//! infers host + auth from the repo in the working directory, exactly like
//! `gh api`. Results are mapped into the existing `GitHub*` structs so the UI is
//! provider-agnostic.

use std::path::Path;
use std::process::Command;
use tauri::AppHandle;

use super::github_issues::{
    GitHubAuthor, GitHubComment, GitHubIssue, GitHubIssueDetail, GitHubIssueListResult,
    GitHubLabel, GitHubPullRequest, GitHubPullRequestDetail,
};
use crate::glab_cli::config::resolve_glab_binary;
use crate::projects::provider::{extract_host, resolve_git_provider};

/// Neutral fallback color for labels surfaced from list endpoints (which return
/// only label names, not colors).
const DEFAULT_LABEL_COLOR: &str = "#8b949e";

// =============================================================================
// glab invocation
// =============================================================================

fn glab_command(glab: &Path, project_path: &str) -> Command {
    crate::platform::resolved_cli_command(glab, Some(Path::new(project_path)))
}

/// Detect `glab` auth failures in stderr (as opposed to "not a GitLab repo").
fn is_glab_auth_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("glab auth login")
        || lower.contains("401")
        || lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("requires authentication")
        || lower.contains("invalid token")
        || lower.contains("token is invalid")
}

/// Run `glab api <endpoint>` (GET) in the project directory and return stdout.
fn run_glab_api(app: &AppHandle, project_path: &str, endpoint: &str) -> Result<String, String> {
    run_glab_api_method(app, project_path, "GET", endpoint)
}

/// Run `glab api --method <METHOD> <endpoint>` in the project directory.
///
/// For POST/PUT, params are passed in the endpoint query string (GitLab accepts
/// them there), so callers percent-encode values into `endpoint`.
fn run_glab_api_method(
    app: &AppHandle,
    project_path: &str,
    method: &str,
    endpoint: &str,
) -> Result<String, String> {
    let glab = resolve_glab_binary(app);
    // Set GITLAB_HOST so self-hosted instances resolve correctly even if glab's
    // remote inference is imperfect; harmless for gitlab.com.
    let (_provider, host) = resolve_git_provider(project_path);

    let output = glab_command(&glab, project_path)
        .env("GITLAB_HOST", host)
        .args(["api", "--method", method, endpoint])
        .output()
        .map_err(|e| format!("Failed to run glab api: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_glab_auth_error(&stderr) {
            return Err("GitLab CLI not authenticated. Run 'glab auth login' first.".to_string());
        }
        if stderr.contains("404") {
            return Err("Not found. Is this a GitLab repository?".to_string());
        }
        return Err(format!("glab api failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Resolve the GitLab project full path (`group/subgroup/repo`) from the repo's
/// origin remote, URL-encoded for use in a `projects/:id` API path.
fn gitlab_project_path_encoded(project_path: &str) -> Result<String, String> {
    let remote = origin_remote_url(project_path)
        .ok_or_else(|| "No origin remote found for this repository".to_string())?;
    let host = extract_host(&remote)
        .ok_or_else(|| format!("Could not parse host from remote: {remote}"))?;

    // Strip scheme + host (and any scp `git@host:` prefix), then `.git`.
    let path = if let Some(rest) = remote.strip_prefix("git@") {
        // git@host:group/repo.git
        rest.split_once(':').map(|(_, p)| p.to_string())
    } else if remote.contains("://") {
        remote
            .split("://")
            .nth(1)
            .and_then(|after| after.split_once('/').map(|(_, p)| p.to_string()))
    } else {
        None
    };

    let path = path
        .ok_or_else(|| format!("Could not parse project path from remote: {remote}"))?
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string();

    if path.is_empty() {
        return Err(format!("Empty project path parsed from remote on {host}"));
    }

    Ok(pct_encode(&path))
}

fn origin_remote_url(project_path: &str) -> Option<String> {
    let output = crate::platform::wsl_aware_command("git", Some(Path::new(project_path)))
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// Percent-encode a string for safe inclusion in an API path/query value.
/// Encodes everything except unreserved chars (RFC 3986: ALPHA / DIGIT / -._~).
fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// =============================================================================
// Raw GitLab REST shapes
// =============================================================================

#[derive(Debug, serde::Deserialize)]
struct GlAuthor {
    #[serde(default)]
    username: String,
}

#[derive(Debug, serde::Deserialize)]
struct GlIssue {
    iid: u32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    author: Option<GlAuthor>,
    #[serde(default)]
    web_url: String,
}

#[derive(Debug, serde::Deserialize)]
struct GlMr {
    iid: u32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    source_branch: String,
    #[serde(default)]
    target_branch: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    author: Option<GlAuthor>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    web_url: String,
}

#[derive(Debug, serde::Deserialize)]
struct GlNote {
    #[serde(default)]
    body: String,
    #[serde(default)]
    author: Option<GlAuthor>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    system: bool,
}

#[derive(Debug, serde::Deserialize)]
struct GlLabel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
}

// =============================================================================
// Mappers → GitHub* structs
// =============================================================================

/// Map GitLab lowercase state ("opened"/"closed"/"merged"/"locked") to the
/// uppercase form the frontend compares against ("OPEN"/"CLOSED"/"MERGED").
fn map_state(gl_state: &str) -> String {
    match gl_state {
        "opened" => "OPEN",
        "closed" => "CLOSED",
        "merged" => "MERGED",
        "locked" => "LOCKED",
        other => other,
    }
    .to_string()
}

fn map_author(a: Option<GlAuthor>) -> GitHubAuthor {
    GitHubAuthor {
        login: a
            .map(|a| a.username)
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "unknown".to_string()),
    }
}

fn map_labels(labels: Vec<String>) -> Vec<GitHubLabel> {
    labels
        .into_iter()
        .map(|name| GitHubLabel {
            name,
            color: DEFAULT_LABEL_COLOR.to_string(),
        })
        .collect()
}

fn map_notes_to_comments(notes: Vec<GlNote>) -> Vec<GitHubComment> {
    notes
        .into_iter()
        .filter(|n| !n.system && !n.body.trim().is_empty())
        .map(|n| GitHubComment {
            body: n.body,
            author: map_author(n.author),
            created_at: n.created_at,
        })
        .collect()
}

fn issue_to_github(i: GlIssue) -> GitHubIssue {
    GitHubIssue {
        number: i.iid,
        title: i.title,
        body: i.description,
        state: map_state(&i.state),
        labels: map_labels(i.labels),
        created_at: i.created_at,
        author: map_author(i.author),
    }
}

fn mr_to_github(m: GlMr) -> GitHubPullRequest {
    GitHubPullRequest {
        number: m.iid,
        title: m.title,
        body: m.description,
        state: map_state(&m.state),
        head_ref_name: m.source_branch,
        base_ref_name: m.target_branch,
        is_draft: m.draft || m.work_in_progress,
        created_at: m.created_at,
        author: map_author(m.author),
        labels: map_labels(m.labels),
    }
}

// =============================================================================
// Public API (called by github_issues dispatch)
// =============================================================================

/// GitLab `state` query value for issues, or `None` for "all".
fn issue_state_param(state: &str) -> Option<&'static str> {
    match state {
        "closed" => Some("closed"),
        "all" => None,
        _ => Some("opened"),
    }
}

/// GitLab `state` query value for merge requests, or `None` for "all".
fn mr_state_param(state: &str) -> Option<&'static str> {
    match state {
        "closed" => Some("closed"),
        "merged" => Some("merged"),
        "all" => None,
        _ => Some("opened"),
    }
}

pub async fn list_issues(
    app: &AppHandle,
    project_path: &str,
    state: Option<String>,
) -> Result<GitHubIssueListResult, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let state = state.unwrap_or_else(|| "open".to_string());

    let mut endpoint = format!("projects/{enc}/issues?per_page=100&order_by=created_at&sort=desc");
    if let Some(s) = issue_state_param(&state) {
        endpoint.push_str(&format!("&state={s}"));
    }

    let stdout = run_glab_api(app, project_path, &endpoint)?;
    let raw: Vec<GlIssue> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab issues: {e}"))?;

    let issues: Vec<GitHubIssue> = raw.into_iter().map(issue_to_github).collect();
    let total_count = issues.len() as u32;
    Ok(GitHubIssueListResult {
        issues,
        total_count,
    })
}

pub async fn get_issue_by_number(
    app: &AppHandle,
    project_path: &str,
    issue_number: u32,
) -> Result<GitHubIssue, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let endpoint = format!("projects/{enc}/issues/{issue_number}");
    let stdout = run_glab_api(app, project_path, &endpoint)?;
    let raw: GlIssue =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab issue: {e}"))?;
    Ok(issue_to_github(raw))
}

pub async fn get_issue_detail(
    app: &AppHandle,
    project_path: &str,
    issue_number: u32,
) -> Result<GitHubIssueDetail, String> {
    let enc = gitlab_project_path_encoded(project_path)?;

    let issue_json = run_glab_api(
        app,
        project_path,
        &format!("projects/{enc}/issues/{issue_number}"),
    )?;
    let raw: GlIssue = serde_json::from_str(&issue_json)
        .map_err(|e| format!("Failed to parse glab issue: {e}"))?;

    let comments = load_notes(app, project_path, &enc, "issues", issue_number);

    Ok(GitHubIssueDetail {
        number: raw.iid,
        title: raw.title,
        body: raw.description,
        state: map_state(&raw.state),
        labels: map_labels(raw.labels),
        created_at: raw.created_at,
        author: map_author(raw.author),
        url: raw.web_url,
        comments,
    })
}

pub async fn search_issues(
    app: &AppHandle,
    project_path: &str,
    query: String,
) -> Result<Vec<GitHubIssue>, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let endpoint = format!(
        "projects/{enc}/issues?per_page=100&search={}",
        pct_encode(&query)
    );
    let stdout = run_glab_api(app, project_path, &endpoint)?;
    let raw: Vec<GlIssue> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab issues: {e}"))?;
    Ok(raw.into_iter().map(issue_to_github).collect())
}

pub async fn list_labels(app: &AppHandle, project_path: &str) -> Result<Vec<GitHubLabel>, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let endpoint = format!("projects/{enc}/labels?per_page=100");
    let stdout = run_glab_api(app, project_path, &endpoint)?;
    let raw: Vec<GlLabel> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab labels: {e}"))?;
    let mut labels: Vec<GitHubLabel> = raw
        .into_iter()
        .map(|l| GitHubLabel {
            name: l.name,
            color: if l.color.is_empty() {
                DEFAULT_LABEL_COLOR.to_string()
            } else {
                l.color.trim_start_matches('#').to_string()
            },
        })
        .collect();
    labels.sort_by_key(|l| l.name.to_lowercase());
    Ok(labels)
}

pub async fn list_mrs(
    app: &AppHandle,
    project_path: &str,
    state: Option<String>,
) -> Result<Vec<GitHubPullRequest>, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let state = state.unwrap_or_else(|| "open".to_string());

    let mut endpoint =
        format!("projects/{enc}/merge_requests?per_page=100&order_by=created_at&sort=desc");
    if let Some(s) = mr_state_param(&state) {
        endpoint.push_str(&format!("&state={s}"));
    }

    let stdout = run_glab_api(app, project_path, &endpoint)?;
    let raw: Vec<GlMr> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab MRs: {e}"))?;
    Ok(raw.into_iter().map(mr_to_github).collect())
}

pub async fn get_mr_by_number(
    app: &AppHandle,
    project_path: &str,
    mr_number: u32,
) -> Result<GitHubPullRequest, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let endpoint = format!("projects/{enc}/merge_requests/{mr_number}");
    let stdout = run_glab_api(app, project_path, &endpoint)?;
    let raw: GlMr =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab MR: {e}"))?;
    Ok(mr_to_github(raw))
}

pub async fn get_mr_detail(
    app: &AppHandle,
    project_path: &str,
    mr_number: u32,
) -> Result<GitHubPullRequestDetail, String> {
    let enc = gitlab_project_path_encoded(project_path)?;

    let mr_json = run_glab_api(
        app,
        project_path,
        &format!("projects/{enc}/merge_requests/{mr_number}"),
    )?;
    let raw: GlMr =
        serde_json::from_str(&mr_json).map_err(|e| format!("Failed to parse glab MR: {e}"))?;

    let comments = load_notes(app, project_path, &enc, "merge_requests", mr_number);

    Ok(GitHubPullRequestDetail {
        number: raw.iid,
        title: raw.title,
        body: raw.description,
        state: map_state(&raw.state),
        head_ref_name: raw.source_branch,
        base_ref_name: raw.target_branch,
        is_draft: raw.draft || raw.work_in_progress,
        created_at: raw.created_at,
        author: map_author(raw.author),
        url: raw.web_url,
        labels: map_labels(raw.labels),
        comments,
        // GitLab review approvals don't map onto GitHub's review model; omit for now.
        reviews: Vec::new(),
    })
}

pub async fn search_mrs(
    app: &AppHandle,
    project_path: &str,
    query: String,
) -> Result<Vec<GitHubPullRequest>, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let endpoint = format!(
        "projects/{enc}/merge_requests?per_page=100&search={}",
        pct_encode(&query)
    );
    let stdout = run_glab_api(app, project_path, &endpoint)?;
    let raw: Vec<GlMr> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab MRs: {e}"))?;
    Ok(raw.into_iter().map(mr_to_github).collect())
}

/// Fetch non-system notes for an issue or merge request; returns empty on error
/// so a comments failure never blocks showing the item.
fn load_notes(
    app: &AppHandle,
    project_path: &str,
    enc_path: &str,
    kind: &str,
    iid: u32,
) -> Vec<GitHubComment> {
    let endpoint =
        format!("projects/{enc_path}/{kind}/{iid}/notes?per_page=100&sort=asc&order_by=created_at");
    match run_glab_api(app, project_path, &endpoint) {
        Ok(stdout) => match serde_json::from_str::<Vec<GlNote>>(&stdout) {
            Ok(notes) => map_notes_to_comments(notes),
            Err(e) => {
                log::warn!("Failed to parse glab notes for {kind} {iid}: {e}");
                Vec::new()
            }
        },
        Err(e) => {
            log::warn!("Failed to fetch glab notes for {kind} {iid}: {e}");
            Vec::new()
        }
    }
}

// =============================================================================
// Merge-request write path (create / merge / detect)
//
// These return plain tuples so the existing GitHub PR commands can dispatch here
// at their narrow `gh`-call boundaries without changing their response types.
// =============================================================================

/// Find an open MR whose source branch matches `branch`.
/// Returns `(number, web_url, title)` or `None`.
pub fn view_open_mr_for_branch(
    app: &AppHandle,
    project_path: &str,
    branch: &str,
) -> Result<Option<(u32, String, String)>, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let endpoint = format!(
        "projects/{enc}/merge_requests?state=opened&source_branch={}&per_page=1",
        pct_encode(branch)
    );
    let stdout = run_glab_api(app, project_path, &endpoint)?;
    let raw: Vec<GlMr> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab MRs: {e}"))?;
    Ok(raw
        .into_iter()
        .next()
        .filter(|m| !m.web_url.is_empty())
        .map(|m| (m.iid, m.web_url, m.title)))
}

/// Fetch a single MR's `(number, web_url, title)` by iid.
pub fn get_mr_brief(
    app: &AppHandle,
    project_path: &str,
    mr_number: u32,
) -> Result<(u32, String, String), String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let stdout = run_glab_api(
        app,
        project_path,
        &format!("projects/{enc}/merge_requests/{mr_number}"),
    )?;
    let m: GlMr =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab MR: {e}"))?;
    if m.web_url.is_empty() {
        return Err(format!("MR !{mr_number} did not return a valid URL"));
    }
    Ok((m.iid, m.web_url, m.title))
}

/// Create a merge request. Returns `(number, web_url)`.
pub fn create_mr(
    app: &AppHandle,
    project_path: &str,
    source_branch: &str,
    target_branch: &str,
    title: &str,
    body: &str,
) -> Result<(u32, String), String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let endpoint = format!(
        "projects/{enc}/merge_requests?source_branch={}&target_branch={}&title={}&description={}",
        pct_encode(source_branch),
        pct_encode(target_branch),
        pct_encode(title),
        pct_encode(body),
    );
    let stdout = run_glab_api_method(app, project_path, "POST", &endpoint)?;
    let m: GlMr =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse created MR: {e}"))?;
    Ok((m.iid, m.web_url))
}

/// Merge (accept) a merge request by iid.
pub fn merge_mr(app: &AppHandle, project_path: &str, mr_number: u32) -> Result<(), String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let endpoint = format!("projects/{enc}/merge_requests/{mr_number}/merge");
    run_glab_api_method(app, project_path, "PUT", &endpoint)?;
    Ok(())
}

/// Raw MR status fields used to build a `PrStatus` in `pr_status.rs`.
pub struct MrStatusRaw {
    pub state: String,
    pub is_draft: bool,
    pub pipeline_status: Option<String>,
    pub merge_status: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GlPipeline {
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GlMrStatus {
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    #[serde(default)]
    merge_status: Option<String>,
    #[serde(default)]
    detailed_merge_status: Option<String>,
    #[serde(default)]
    pipeline: Option<GlPipeline>,
    #[serde(default)]
    head_pipeline: Option<GlPipeline>,
}

/// Fetch the pipeline + mergeability signals for an MR (for status polling).
pub fn fetch_mr_status_raw(
    app: &AppHandle,
    project_path: &str,
    mr_number: u32,
) -> Result<MrStatusRaw, String> {
    let enc = gitlab_project_path_encoded(project_path)?;
    let stdout = run_glab_api(
        app,
        project_path,
        &format!("projects/{enc}/merge_requests/{mr_number}"),
    )?;
    let m: GlMrStatus =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse MR status: {e}"))?;

    // Prefer the richer `head_pipeline`, fall back to the (deprecated) `pipeline`;
    // `detailed_merge_status` supersedes `merge_status` on modern GitLab.
    let pipeline_status = m
        .head_pipeline
        .and_then(|p| p.status)
        .or_else(|| m.pipeline.and_then(|p| p.status));
    let merge_status = m.detailed_merge_status.or(m.merge_status);

    Ok(MrStatusRaw {
        state: m.state,
        is_draft: m.draft || m.work_in_progress,
        pipeline_status,
        merge_status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_gitlab_state_to_uppercase() {
        assert_eq!(map_state("opened"), "OPEN");
        assert_eq!(map_state("closed"), "CLOSED");
        assert_eq!(map_state("merged"), "MERGED");
        assert_eq!(map_state("locked"), "LOCKED");
    }

    #[test]
    fn state_params() {
        assert_eq!(issue_state_param("open"), Some("opened"));
        assert_eq!(issue_state_param("closed"), Some("closed"));
        assert_eq!(issue_state_param("all"), None);
        assert_eq!(mr_state_param("merged"), Some("merged"));
        assert_eq!(mr_state_param("all"), None);
    }

    #[test]
    fn pct_encode_encodes_reserved() {
        assert_eq!(pct_encode("group/sub/repo"), "group%2Fsub%2Frepo");
        assert_eq!(pct_encode("a b"), "a%20b");
        assert_eq!(pct_encode("keep-_.~"), "keep-_.~");
    }

    #[test]
    fn author_falls_back_to_unknown() {
        assert_eq!(map_author(None).login, "unknown");
        assert_eq!(
            map_author(Some(GlAuthor {
                username: "alice".into()
            }))
            .login,
            "alice"
        );
    }
}
