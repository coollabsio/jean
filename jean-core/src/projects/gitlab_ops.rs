//! GitLab forge operations via `glab`, mapped into Jean's existing GitHub-shaped types
//! so the UI can show issues/MRs without a full type redesign.

use serde::Deserialize;
use std::path::Path;
use tauri::AppHandle;

use super::github_issues::{
    GitHubAuthor, GitHubIssue, GitHubIssueDetail, GitHubIssueListResult, GitHubLabel,
    GitHubPullRequest,
};
use crate::glab_cli::config::resolve_glab_binary;

fn glab_command(glab: &Path, project_path: &str) -> std::process::Command {
    crate::platform::resolved_cli_command(glab, Some(Path::new(project_path)))
}

fn is_glab_auth_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("not authenticated")
        || lower.contains("auth login")
        || lower.contains("no token")
        || lower.contains("401")
        || lower.contains("unauthorized")
}

/// Flexible author from glab JSON (username or login).
#[derive(Debug, Deserialize)]
struct GlabAuthor {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    login: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

impl GlabAuthor {
    fn login(&self) -> String {
        self.username
            .clone()
            .or_else(|| self.login.clone())
            .or_else(|| self.name.clone())
            .unwrap_or_else(|| "unknown".to_string())
    }
}

#[derive(Debug, Deserialize)]
struct GlabLabel {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    color: Option<String>,
}

impl GlabLabel {
    fn to_github(&self) -> Option<GitHubLabel> {
        let name = self
            .name
            .clone()
            .or_else(|| self.title.clone())
            .filter(|s| !s.is_empty())?;
        Some(GitHubLabel {
            name,
            color: self
                .color
                .clone()
                .unwrap_or_else(|| "808080".to_string())
                .trim_start_matches('#')
                .to_string(),
        })
    }
}

#[derive(Debug, Deserialize)]
struct GlabIssue {
    #[serde(default)]
    iid: Option<u32>,
    #[serde(default)]
    number: Option<u32>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    labels: Option<serde_json::Value>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default, alias = "createdAt")]
    created_at_camel: Option<String>,
    #[serde(default)]
    author: Option<GlabAuthor>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

fn parse_labels(value: Option<serde_json::Value>) -> Vec<GitHubLabel> {
    let Some(value) = value else {
        return Vec::new();
    };
    if let Ok(labels) = serde_json::from_value::<Vec<GlabLabel>>(value.clone()) {
        return labels.into_iter().filter_map(|l| l.to_github()).collect();
    }
    if let Some(arr) = value.as_array() {
        return arr
            .iter()
            .filter_map(|v| {
                if let Some(s) = v.as_str() {
                    return Some(GitHubLabel {
                        name: s.to_string(),
                        color: "808080".to_string(),
                    });
                }
                serde_json::from_value::<GlabLabel>(v.clone())
                    .ok()
                    .and_then(|l| l.to_github())
            })
            .collect();
    }
    // nodes wrapper
    if let Some(nodes) = value.get("nodes").and_then(|n| n.as_array()) {
        return nodes
            .iter()
            .filter_map(|v| {
                serde_json::from_value::<GlabLabel>(v.clone())
                    .ok()
                    .and_then(|l| l.to_github())
            })
            .collect();
    }
    Vec::new()
}

fn normalize_state(state: &str) -> String {
    match state.to_lowercase().as_str() {
        "opened" | "open" => "OPEN".to_string(),
        "closed" => "CLOSED".to_string(),
        "merged" => "MERGED".to_string(),
        other => other.to_uppercase(),
    }
}

impl GlabIssue {
    fn to_github_issue(&self) -> Option<GitHubIssue> {
        let number = self.iid.or(self.number)?;
        Some(GitHubIssue {
            number,
            title: self.title.clone().unwrap_or_default(),
            body: self.description.clone().or_else(|| self.body.clone()),
            state: normalize_state(self.state.as_deref().unwrap_or("opened")),
            labels: parse_labels(self.labels.clone()),
            created_at: self
                .created_at
                .clone()
                .or_else(|| self.created_at_camel.clone())
                .unwrap_or_default(),
            author: GitHubAuthor {
                login: self
                    .author
                    .as_ref()
                    .map(|a| a.login())
                    .unwrap_or_else(|| "unknown".to_string()),
            },
        })
    }

    fn to_github_issue_detail(&self) -> Option<GitHubIssueDetail> {
        let base = self.to_github_issue()?;
        Some(GitHubIssueDetail {
            number: base.number,
            title: base.title,
            body: base.body,
            state: base.state,
            labels: base.labels,
            created_at: base.created_at,
            author: base.author,
            url: self
                .web_url
                .clone()
                .or_else(|| self.url.clone())
                .unwrap_or_default(),
            comments: Vec::new(),
        })
    }
}

#[derive(Debug, Deserialize)]
struct GlabMr {
    #[serde(default)]
    iid: Option<u32>,
    #[serde(default)]
    number: Option<u32>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    labels: Option<serde_json::Value>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default, alias = "createdAt")]
    created_at_camel: Option<String>,
    #[serde(default)]
    author: Option<GlabAuthor>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    source_branch: Option<String>,
    #[serde(default, alias = "headRefName")]
    head_ref_name: Option<String>,
    #[serde(default)]
    target_branch: Option<String>,
    #[serde(default, alias = "baseRefName")]
    base_ref_name: Option<String>,
}

impl GlabMr {
    fn to_pr(&self) -> Option<GitHubPullRequest> {
        let number = self.iid.or(self.number)?;
        let state = normalize_state(self.state.as_deref().unwrap_or("opened"));
        Some(GitHubPullRequest {
            number,
            title: self.title.clone().unwrap_or_default(),
            body: self.description.clone().or_else(|| self.body.clone()),
            state,
            labels: parse_labels(self.labels.clone()),
            created_at: self
                .created_at
                .clone()
                .or_else(|| self.created_at_camel.clone())
                .unwrap_or_default(),
            author: GitHubAuthor {
                login: self
                    .author
                    .as_ref()
                    .map(|a| a.login())
                    .unwrap_or_else(|| "unknown".to_string()),
            },
            head_ref_name: self
                .source_branch
                .clone()
                .or_else(|| self.head_ref_name.clone())
                .unwrap_or_default(),
            base_ref_name: self
                .target_branch
                .clone()
                .or_else(|| self.base_ref_name.clone())
                .unwrap_or_default(),
            is_draft: false,
        })
    }
}

pub async fn list_gitlab_issues(
    app: &AppHandle,
    project_path: &str,
    state: Option<String>,
) -> Result<GitHubIssueListResult, String> {
    let glab = resolve_glab_binary(app);
    if !crate::glab_cli::config::resolve_available_glab_binary(app).is_some() {
        return Err(
            "GitLab CLI not installed. Install glab from Settings or onboarding to use GitLab issues."
                .to_string(),
        );
    }

    let state_arg = match state.as_deref().unwrap_or("open") {
        "closed" => "closed",
        "all" => "all",
        _ => "opened",
    };

    let output = glab_command(&glab, project_path)
        .args(["issue", "list", "-F", "json", "-P", "100", "--state", state_arg])
        .output()
        .map_err(|e| format!("Failed to run glab issue list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_glab_auth_error(&stderr) {
            return Err(
                "GitLab CLI not authenticated. Run 'glab auth login' first.".to_string(),
            );
        }
        return Err(format!("glab issue list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: Vec<GlabIssue> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse glab issue list: {e}"))?;
    let issues: Vec<GitHubIssue> = raw.iter().filter_map(|i| i.to_github_issue()).collect();
    let total_count = issues.len() as u32;
    Ok(GitHubIssueListResult {
        issues,
        total_count,
    })
}

pub async fn get_gitlab_issue(
    app: &AppHandle,
    project_path: &str,
    issue_number: u32,
) -> Result<GitHubIssueDetail, String> {
    let glab = resolve_glab_binary(app);
    if crate::glab_cli::config::resolve_available_glab_binary(app).is_none() {
        return Err("GitLab CLI not installed".to_string());
    }

    let output = glab_command(&glab, project_path)
        .args(["issue", "view", &issue_number.to_string(), "-F", "json"])
        .output()
        .map_err(|e| format!("Failed to run glab issue view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_glab_auth_error(&stderr) {
            return Err(
                "GitLab CLI not authenticated. Run 'glab auth login' first.".to_string(),
            );
        }
        return Err(format!("glab issue view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: GlabIssue = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse glab issue view: {e}"))?;
    raw.to_github_issue_detail()
        .ok_or_else(|| "Invalid glab issue response".to_string())
}

pub async fn list_gitlab_mrs(
    app: &AppHandle,
    project_path: &str,
    state: Option<String>,
) -> Result<Vec<GitHubPullRequest>, String> {
    let glab = resolve_glab_binary(app);
    if crate::glab_cli::config::resolve_available_glab_binary(app).is_none() {
        return Err(
            "GitLab CLI not installed. Install glab to list merge requests.".to_string(),
        );
    }

    let state_arg = match state.as_deref().unwrap_or("open") {
        "closed" => "closed",
        "merged" => "merged",
        "all" => "all",
        _ => "opened",
    };

    let output = glab_command(&glab, project_path)
        .args(["mr", "list", "-F", "json", "-P", "100", "--state", state_arg])
        .output()
        .map_err(|e| format!("Failed to run glab mr list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_glab_auth_error(&stderr) {
            return Err(
                "GitLab CLI not authenticated. Run 'glab auth login' first.".to_string(),
            );
        }
        return Err(format!("glab mr list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: Vec<GlabMr> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab mr list: {e}"))?;
    Ok(raw.iter().filter_map(|m| m.to_pr()).collect())
}

pub async fn get_gitlab_mr(
    app: &AppHandle,
    project_path: &str,
    mr_number: u32,
) -> Result<GitHubPullRequest, String> {
    let glab = resolve_glab_binary(app);
    if crate::glab_cli::config::resolve_available_glab_binary(app).is_none() {
        return Err("GitLab CLI not installed".to_string());
    }

    let output = glab_command(&glab, project_path)
        .args(["mr", "view", &mr_number.to_string(), "-F", "json"])
        .output()
        .map_err(|e| format!("Failed to run glab mr view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_glab_auth_error(&stderr) {
            return Err(
                "GitLab CLI not authenticated. Run 'glab auth login' first.".to_string(),
            );
        }
        return Err(format!("glab mr view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: GlabMr =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab mr view: {e}"))?;
    raw.to_pr()
        .ok_or_else(|| "Invalid glab mr response".to_string())
}

pub fn create_gitlab_mr(
    app: &AppHandle,
    project_path: &str,
    title: &str,
    body: Option<&str>,
) -> Result<String, String> {
    let glab = resolve_glab_binary(app);
    if crate::glab_cli::config::resolve_available_glab_binary(app).is_none() {
        return Err("GitLab CLI not installed".to_string());
    }

    let mut cmd = glab_command(&glab, project_path);
    cmd.args(["mr", "create", "--title", title, "--yes", "--fill"]);
    if let Some(body) = body {
        if !body.is_empty() {
            cmd.args(["--description", body]);
        }
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run glab mr create: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("glab mr create failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Prefer a URL line in the output
    for line in stdout.lines() {
        let t = line.trim();
        if t.starts_with("http://") || t.starts_with("https://") {
            return Ok(t.to_string());
        }
    }
    Ok(stdout.trim().to_string())
}

