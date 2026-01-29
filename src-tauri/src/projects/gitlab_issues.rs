//! GitLab Issues and Merge Requests module
//!
//! Provides types and commands for interacting with GitLab issues and MRs
//! via the glab CLI.

use serde::{Deserialize, Serialize};
use std::process::Command;

use super::git::get_gitlab_repo_identifier;
use super::github_issues::{
    add_issue_reference, add_pr_reference, get_github_contexts_dir, remove_issue_reference,
    remove_pr_reference,
};

// =============================================================================
// GitLab Types
// =============================================================================

/// GitLab user/author
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLabAuthor {
    pub username: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// GitLab issue from list response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabIssue {
    pub iid: u32,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub created_at: String,
    pub author: GitLabAuthor,
    pub web_url: String,
}

/// GitLab comment/note
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabNote {
    pub body: String,
    pub author: GitLabAuthor,
    pub created_at: String,
}

/// GitLab issue detail with notes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabIssueDetail {
    pub iid: u32,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub created_at: String,
    pub author: GitLabAuthor,
    pub web_url: String,
    #[serde(default)]
    pub notes: Vec<GitLabNote>,
}

/// Issue context to pass when creating a worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLabIssueContext {
    pub iid: u32,
    pub title: String,
    pub description: Option<String>,
    pub notes: Vec<GitLabNote>,
}

/// GitLab merge request from list response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabMergeRequest {
    pub iid: u32,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    pub source_branch: String,
    pub target_branch: String,
    #[serde(default)]
    pub draft: bool,
    pub created_at: String,
    pub author: GitLabAuthor,
    #[serde(default)]
    pub labels: Vec<String>,
    pub web_url: String,
}

/// GitLab MR detail with notes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabMergeRequestDetail {
    pub iid: u32,
    pub title: String,
    pub description: Option<String>,
    pub state: String,
    pub source_branch: String,
    pub target_branch: String,
    #[serde(default)]
    pub draft: bool,
    pub created_at: String,
    pub author: GitLabAuthor,
    #[serde(default)]
    pub labels: Vec<String>,
    pub web_url: String,
    #[serde(default)]
    pub notes: Vec<GitLabNote>,
}

/// MR context to pass when creating a worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabMergeRequestContext {
    pub iid: u32,
    pub title: String,
    pub description: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    pub notes: Vec<GitLabNote>,
    pub diff: Option<String>,
}

/// Loaded issue context info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedGitLabIssueContext {
    pub iid: u32,
    pub title: String,
    pub note_count: usize,
    pub project_path: String,
}

/// Loaded MR context info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedGitLabMergeRequestContext {
    pub iid: u32,
    pub title: String,
    pub note_count: usize,
    pub project_path: String,
}

// =============================================================================
// GitLab Issue Commands
// =============================================================================

/// List GitLab issues for a repository
///
/// Uses `glab issue list` to fetch issues from the repository.
/// - state: "opened", "closed", or "all" (default: "opened")
/// - Returns up to 100 issues sorted by creation date (newest first)
#[tauri::command]
pub async fn list_gitlab_issues(
    project_path: String,
    state: Option<String>,
) -> Result<Vec<GitLabIssue>, String> {
    log::trace!("Listing GitLab issues for {project_path} with state: {state:?}");

    // GitLab uses "opened" instead of "open"
    let state_arg = state.unwrap_or_else(|| "opened".to_string());

    // Run glab issue list
    let output = Command::new("glab")
        .args([
            "issue",
            "list",
            "--output",
            "json",
            "-P",
            "100",
            "--state",
            &state_arg,
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run glab issue list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Handle specific errors
        if stderr.contains("glab auth login") || stderr.contains("authentication") {
            return Err("GitLab CLI not authenticated. Run 'glab auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("Could not resolve") || stderr.contains("not found") {
            return Err(
                "Could not resolve repository. Is this a GitLab repository?".to_string(),
            );
        }
        return Err(format!("glab issue list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Handle empty response
    if stdout.trim().is_empty() || stdout.trim() == "[]" {
        return Ok(vec![]);
    }

    let issues: Vec<GitLabIssue> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab response: {e}"))?;

    log::trace!("Found {} issues", issues.len());
    Ok(issues)
}

/// Get detailed information about a specific GitLab issue
///
/// Uses `glab issue view` to fetch the issue with notes.
#[tauri::command]
pub async fn get_gitlab_issue(
    project_path: String,
    issue_iid: u32,
) -> Result<GitLabIssueDetail, String> {
    log::trace!("Getting GitLab issue !{issue_iid} for {project_path}");

    // Run glab issue view
    let output = Command::new("glab")
        .args([
            "issue",
            "view",
            &issue_iid.to_string(),
            "--output",
            "json",
            "--comments",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run glab issue view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Handle specific errors
        if stderr.contains("glab auth login") || stderr.contains("authentication") {
            return Err("GitLab CLI not authenticated. Run 'glab auth login' first.".to_string());
        }
        if stderr.contains("not found") {
            return Err(format!("Issue !{issue_iid} not found"));
        }
        return Err(format!("glab issue view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let issue: GitLabIssueDetail =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab response: {e}"))?;

    log::trace!("Got issue !{}: {}", issue.iid, issue.title);
    Ok(issue)
}

// =============================================================================
// GitLab Merge Request Commands
// =============================================================================

/// List GitLab merge requests for a repository
///
/// Uses `glab mr list` to fetch MRs from the repository.
/// - state: "opened", "closed", "merged", or "all" (default: "opened")
/// - Returns up to 100 MRs sorted by creation date (newest first)
#[tauri::command]
pub async fn list_gitlab_mrs(
    project_path: String,
    state: Option<String>,
) -> Result<Vec<GitLabMergeRequest>, String> {
    log::trace!("Listing GitLab MRs for {project_path} with state: {state:?}");

    let state_arg = state.unwrap_or_else(|| "opened".to_string());

    // Run glab mr list
    let output = Command::new("glab")
        .args([
            "mr",
            "list",
            "--output",
            "json",
            "-P",
            "100",
            "--state",
            &state_arg,
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run glab mr list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("glab auth login") || stderr.contains("authentication") {
            return Err("GitLab CLI not authenticated. Run 'glab auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("Could not resolve") || stderr.contains("not found") {
            return Err(
                "Could not resolve repository. Is this a GitLab repository?".to_string(),
            );
        }
        return Err(format!("glab mr list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Handle empty response
    if stdout.trim().is_empty() || stdout.trim() == "[]" {
        return Ok(vec![]);
    }

    let mrs: Vec<GitLabMergeRequest> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab response: {e}"))?;

    log::trace!("Found {} MRs", mrs.len());
    Ok(mrs)
}

/// Get detailed information about a specific GitLab MR
///
/// Uses `glab mr view` to fetch the MR with notes.
#[tauri::command]
pub async fn get_gitlab_mr(
    project_path: String,
    mr_iid: u32,
) -> Result<GitLabMergeRequestDetail, String> {
    log::trace!("Getting GitLab MR !{mr_iid} for {project_path}");

    // Run glab mr view
    let output = Command::new("glab")
        .args([
            "mr",
            "view",
            &mr_iid.to_string(),
            "--output",
            "json",
            "--comments",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run glab mr view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("glab auth login") || stderr.contains("authentication") {
            return Err("GitLab CLI not authenticated. Run 'glab auth login' first.".to_string());
        }
        if stderr.contains("not found") {
            return Err(format!("MR !{mr_iid} not found"));
        }
        return Err(format!("glab mr view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mr: GitLabMergeRequestDetail =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse glab response: {e}"))?;

    log::trace!("Got MR !{}: {}", mr.iid, mr.title);
    Ok(mr)
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Generate a slug from an issue/MR title for branch naming
/// e.g., "Fix the login bug" -> "fix-the-login-bug"
pub fn slugify_title(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .take(5) // Limit to first 5 words
        .collect::<Vec<_>>()
        .join("-");

    // Limit total length
    if slug.len() > 40 {
        slug[..40].trim_end_matches('-').to_string()
    } else {
        slug
    }
}

/// Generate a branch name from a GitLab issue
/// e.g., Issue !123 "Fix the login bug" -> "issue-123-fix-the-login-bug"
pub fn generate_branch_name_from_gitlab_issue(issue_iid: u32, title: &str) -> String {
    let slug = slugify_title(title);
    format!("issue-{issue_iid}-{slug}")
}

/// Generate a branch name from a GitLab MR
/// e.g., MR !123 "Fix the login bug" -> "mr-123-fix-the-login-bug"
pub fn generate_branch_name_from_gitlab_mr(mr_iid: u32, title: &str) -> String {
    let slug = slugify_title(title);
    format!("mr-{mr_iid}-{slug}")
}

/// Format GitLab issue context as markdown
pub fn format_gitlab_issue_context_markdown(ctx: &GitLabIssueContext) -> String {
    let mut content = String::new();

    content.push_str(&format!(
        "# GitLab Issue !{}: {}\n\n",
        ctx.iid, ctx.title
    ));

    content.push_str("---\n\n");

    content.push_str("## Description\n\n");
    if let Some(description) = &ctx.description {
        if !description.is_empty() {
            content.push_str(description);
        } else {
            content.push_str("*No description provided.*");
        }
    } else {
        content.push_str("*No description provided.*");
    }
    content.push_str("\n\n");

    if !ctx.notes.is_empty() {
        content.push_str("## Notes\n\n");
        for note in &ctx.notes {
            content.push_str(&format!(
                "### @{} ({})\n\n",
                note.author.username, note.created_at
            ));
            content.push_str(&note.body);
            content.push_str("\n\n---\n\n");
        }
    }

    content.push_str("---\n\n");
    content.push_str("*Investigate this issue and propose a solution.*\n");

    content
}

/// Format GitLab MR context as markdown
pub fn format_gitlab_mr_context_markdown(ctx: &GitLabMergeRequestContext) -> String {
    let mut content = String::new();

    content.push_str(&format!(
        "# GitLab Merge Request !{}: {}\n\n",
        ctx.iid, ctx.title
    ));

    content.push_str(&format!(
        "**Branch:** `{}` → `{}`\n\n",
        ctx.source_branch, ctx.target_branch
    ));

    content.push_str("---\n\n");

    content.push_str("## Description\n\n");
    if let Some(description) = &ctx.description {
        if !description.is_empty() {
            content.push_str(description);
        } else {
            content.push_str("*No description provided.*");
        }
    } else {
        content.push_str("*No description provided.*");
    }
    content.push_str("\n\n");

    if !ctx.notes.is_empty() {
        content.push_str("## Notes\n\n");
        for note in &ctx.notes {
            content.push_str(&format!(
                "### @{} ({})\n\n",
                note.author.username, note.created_at
            ));
            content.push_str(&note.body);
            content.push_str("\n\n---\n\n");
        }
    }

    // Add diff section if available
    if let Some(diff) = &ctx.diff {
        if !diff.is_empty() {
            content.push_str("## Changes (Diff)\n\n");
            content.push_str("```diff\n");
            content.push_str(diff);
            if !diff.ends_with('\n') {
                content.push('\n');
            }
            content.push_str("```\n\n");
        }
    }

    content.push_str("---\n\n");
    content.push_str("*Review this merge request and provide feedback or make changes.*\n");

    content
}

/// Get the diff for a MR using `glab mr diff`
///
/// Returns the diff as a string, truncated to 100KB if too large.
pub fn get_mr_diff(project_path: &str, mr_iid: u32) -> Result<String, String> {
    log::debug!("Fetching diff for MR !{mr_iid} in {project_path}");

    let output = Command::new("glab")
        .args(["mr", "diff", &mr_iid.to_string(), "--color", "never"])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to run glab mr diff: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::debug!("glab mr diff failed: {stderr}");
        // Return empty string on failure
        return Ok(String::new());
    }

    let diff = String::from_utf8_lossy(&output.stdout).to_string();
    log::debug!("Got diff for MR !{mr_iid}: {} bytes", diff.len());

    // Truncate if > 100KB
    const MAX_DIFF_SIZE: usize = 100_000;
    if diff.len() > MAX_DIFF_SIZE {
        Ok(format!(
            "{}...\n\n[Diff truncated at 100KB - {} bytes total. Run `glab mr diff {}` to see the full diff.]",
            &diff[..MAX_DIFF_SIZE],
            diff.len(),
            mr_iid
        ))
    } else {
        Ok(diff)
    }
}

// =============================================================================
// Context Loading Commands
// =============================================================================

/// Load/refresh GitLab issue context for a worktree
#[tauri::command]
pub async fn load_gitlab_issue_context(
    app: tauri::AppHandle,
    worktree_id: String,
    issue_iid: u32,
    project_path: String,
) -> Result<LoadedGitLabIssueContext, String> {
    log::trace!("Loading GitLab issue !{issue_iid} context for worktree {worktree_id}");

    // Get repo identifier for shared storage
    let repo_id = get_gitlab_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Fetch issue data from GitLab
    let issue = get_gitlab_issue(project_path.clone(), issue_iid).await?;

    // Create issue context
    let ctx = GitLabIssueContext {
        iid: issue.iid,
        title: issue.title.clone(),
        description: issue.description,
        notes: issue.notes,
    };

    // Write to shared git-context directory
    let contexts_dir = get_github_contexts_dir(&app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;

    // File format: {repo_key}-gitlab-issue-{iid}.md
    let context_file = contexts_dir.join(format!("{repo_key}-gitlab-issue-{issue_iid}.md"));
    let context_content = format_gitlab_issue_context_markdown(&ctx);

    std::fs::write(&context_file, context_content)
        .map_err(|e| format!("Failed to write issue context file: {e}"))?;

    // Add reference tracking (reuse GitHub's tracking with gitlab prefix in key)
    add_issue_reference(&app, &format!("gitlab-{repo_key}"), issue_iid, &worktree_id)?;

    log::trace!(
        "GitLab issue context loaded successfully for issue !{} ({} notes)",
        issue_iid,
        ctx.notes.len()
    );

    Ok(LoadedGitLabIssueContext {
        iid: issue.iid,
        title: issue.title,
        note_count: ctx.notes.len(),
        project_path: repo_key,
    })
}

/// Load/refresh GitLab MR context for a worktree
#[tauri::command]
pub async fn load_gitlab_mr_context(
    app: tauri::AppHandle,
    worktree_id: String,
    mr_iid: u32,
    project_path: String,
) -> Result<LoadedGitLabMergeRequestContext, String> {
    log::trace!("Loading GitLab MR !{mr_iid} context for worktree {worktree_id}");

    // Get repo identifier for shared storage
    let repo_id = get_gitlab_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Fetch MR data from GitLab
    let mr = get_gitlab_mr(project_path.clone(), mr_iid).await?;

    // Fetch the diff
    let diff = get_mr_diff(&project_path, mr_iid).ok();

    // Create MR context
    let ctx = GitLabMergeRequestContext {
        iid: mr.iid,
        title: mr.title.clone(),
        description: mr.description,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        notes: mr.notes.clone(),
        diff,
    };

    // Write to shared git-context directory
    let contexts_dir = get_github_contexts_dir(&app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;

    // File format: {repo_key}-gitlab-mr-{iid}.md
    let context_file = contexts_dir.join(format!("{repo_key}-gitlab-mr-{mr_iid}.md"));
    let context_content = format_gitlab_mr_context_markdown(&ctx);

    std::fs::write(&context_file, context_content)
        .map_err(|e| format!("Failed to write MR context file: {e}"))?;

    // Add reference tracking
    add_pr_reference(&app, &format!("gitlab-{repo_key}"), mr_iid, &worktree_id)?;

    log::debug!(
        "GitLab MR context loaded successfully for MR !{} ({} notes, diff: {} bytes)",
        mr_iid,
        ctx.notes.len(),
        ctx.diff.as_ref().map(|d| d.len()).unwrap_or(0)
    );

    Ok(LoadedGitLabMergeRequestContext {
        iid: mr.iid,
        title: mr.title,
        note_count: mr.notes.len(),
        project_path: repo_key,
    })
}

/// Remove a loaded GitLab issue context for a worktree
#[tauri::command]
pub async fn remove_gitlab_issue_context(
    app: tauri::AppHandle,
    worktree_id: String,
    issue_iid: u32,
    project_path: String,
) -> Result<(), String> {
    log::trace!("Removing GitLab issue !{issue_iid} context for worktree {worktree_id}");

    // Get repo identifier
    let repo_id = get_gitlab_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Remove reference
    let is_orphaned = remove_issue_reference(
        &app,
        &format!("gitlab-{repo_key}"),
        issue_iid,
        &worktree_id,
    )?;

    // If orphaned, delete the shared file immediately
    if is_orphaned {
        let contexts_dir = get_github_contexts_dir(&app)?;
        let context_file = contexts_dir.join(format!("{repo_key}-gitlab-issue-{issue_iid}.md"));

        if context_file.exists() {
            std::fs::remove_file(&context_file)
                .map_err(|e| format!("Failed to remove issue context file: {e}"))?;
            log::trace!("Deleted orphaned GitLab issue context file");
        }
    }

    log::trace!("GitLab issue context removed successfully");
    Ok(())
}

/// Remove a loaded GitLab MR context for a worktree
#[tauri::command]
pub async fn remove_gitlab_mr_context(
    app: tauri::AppHandle,
    worktree_id: String,
    mr_iid: u32,
    project_path: String,
) -> Result<(), String> {
    log::trace!("Removing GitLab MR !{mr_iid} context for worktree {worktree_id}");

    // Get repo identifier
    let repo_id = get_gitlab_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Remove reference
    let is_orphaned =
        remove_pr_reference(&app, &format!("gitlab-{repo_key}"), mr_iid, &worktree_id)?;

    // If orphaned, delete the shared file immediately
    if is_orphaned {
        let contexts_dir = get_github_contexts_dir(&app)?;
        let context_file = contexts_dir.join(format!("{repo_key}-gitlab-mr-{mr_iid}.md"));

        if context_file.exists() {
            std::fs::remove_file(&context_file)
                .map_err(|e| format!("Failed to remove MR context file: {e}"))?;
            log::trace!("Deleted orphaned GitLab MR context file");
        }
    }

    log::trace!("GitLab MR context removed successfully");
    Ok(())
}

// =============================================================================
// GitLab Context Listing and Content Retrieval
// =============================================================================

/// Get GitLab issue refs for a worktree from reference tracking
fn get_worktree_gitlab_issue_refs(
    app: &tauri::AppHandle,
    worktree_id: &str,
) -> Result<Vec<String>, String> {
    use super::github_issues::load_context_references;

    let refs = load_context_references(app)?;

    // Find all GitLab issue keys that reference this worktree
    let mut keys = Vec::new();
    for (key, context_ref) in &refs.issues {
        // GitLab keys start with "gitlab-"
        if key.starts_with("gitlab-") && context_ref.worktrees.contains(&worktree_id.to_string()) {
            // Strip the "gitlab-" prefix and return the rest
            if let Some(stripped) = key.strip_prefix("gitlab-") {
                keys.push(stripped.to_string());
            }
        }
    }

    Ok(keys)
}

/// Get GitLab MR refs for a worktree from reference tracking
fn get_worktree_gitlab_mr_refs(
    app: &tauri::AppHandle,
    worktree_id: &str,
) -> Result<Vec<String>, String> {
    use super::github_issues::load_context_references;

    let refs = load_context_references(app)?;

    // Find all GitLab MR keys that reference this worktree
    let mut keys = Vec::new();
    for (key, context_ref) in &refs.prs {
        // GitLab keys start with "gitlab-"
        if key.starts_with("gitlab-") && context_ref.worktrees.contains(&worktree_id.to_string()) {
            // Strip the "gitlab-" prefix and return the rest
            if let Some(stripped) = key.strip_prefix("gitlab-") {
                keys.push(stripped.to_string());
            }
        }
    }

    Ok(keys)
}

/// Parse context key format: "{repo_key}-{iid}"
fn parse_gitlab_context_key(key: &str) -> Option<(String, u32)> {
    // Key format: "{owner}-{repo}-{iid}" where owner-repo is the repo_key
    let parts: Vec<&str> = key.rsplitn(2, '-').collect();
    if parts.len() != 2 {
        return None;
    }

    let iid: u32 = parts[0].parse().ok()?;
    let repo_key = parts[1].to_string();

    Some((repo_key, iid))
}

/// List all loaded GitLab issue contexts for a worktree
#[tauri::command]
pub async fn list_loaded_gitlab_issue_contexts(
    app: tauri::AppHandle,
    worktree_id: String,
) -> Result<Vec<LoadedGitLabIssueContext>, String> {
    log::trace!("Listing loaded GitLab issue contexts for worktree {worktree_id}");

    // Get GitLab issue refs for this worktree from reference tracking
    let issue_keys = get_worktree_gitlab_issue_refs(&app, &worktree_id)?;

    if issue_keys.is_empty() {
        return Ok(vec![]);
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts = Vec::new();

    for key in issue_keys {
        // Parse key format: "{repo_key}-{iid}"
        if let Some((repo_key, iid)) = parse_gitlab_context_key(&key) {
            let context_file = contexts_dir.join(format!("{repo_key}-gitlab-issue-{iid}.md"));

            if let Ok(content) = std::fs::read_to_string(&context_file) {
                // Parse title from first line: "# GitLab Issue !123: Title"
                let title = content
                    .lines()
                    .next()
                    .and_then(|line| {
                        line.strip_prefix("# GitLab Issue !")
                            .and_then(|rest| rest.split_once(": "))
                            .map(|(_, title)| title.to_string())
                    })
                    .unwrap_or_else(|| format!("Issue !{iid}"));

                // Count notes by counting "### @" headers
                let note_count = content.matches("### @").count();

                contexts.push(LoadedGitLabIssueContext {
                    iid,
                    title,
                    note_count,
                    project_path: repo_key,
                });
            }
        }
    }

    // Sort by issue IID
    contexts.sort_by_key(|c| c.iid);

    log::trace!("Found {} loaded GitLab issue contexts", contexts.len());
    Ok(contexts)
}

/// List all loaded GitLab MR contexts for a worktree
#[tauri::command]
pub async fn list_loaded_gitlab_mr_contexts(
    app: tauri::AppHandle,
    worktree_id: String,
) -> Result<Vec<LoadedGitLabMergeRequestContext>, String> {
    log::trace!("Listing loaded GitLab MR contexts for worktree {worktree_id}");

    // Get GitLab MR refs for this worktree from reference tracking
    let mr_keys = get_worktree_gitlab_mr_refs(&app, &worktree_id)?;

    if mr_keys.is_empty() {
        return Ok(vec![]);
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts = Vec::new();

    for key in mr_keys {
        // Parse key format: "{repo_key}-{iid}"
        if let Some((repo_key, iid)) = parse_gitlab_context_key(&key) {
            let context_file = contexts_dir.join(format!("{repo_key}-gitlab-mr-{iid}.md"));

            if let Ok(content) = std::fs::read_to_string(&context_file) {
                // Parse title from first line: "# GitLab Merge Request !123: Title"
                let title = content
                    .lines()
                    .next()
                    .and_then(|line| {
                        line.strip_prefix("# GitLab Merge Request !")
                            .and_then(|rest| rest.split_once(": "))
                            .map(|(_, title)| title.to_string())
                    })
                    .unwrap_or_else(|| format!("MR !{iid}"));

                // Count notes by counting "### @" headers in Notes section
                let note_count = content
                    .find("## Notes")
                    .map(|start| content[start..].matches("### @").count())
                    .unwrap_or(0);

                contexts.push(LoadedGitLabMergeRequestContext {
                    iid,
                    title,
                    note_count,
                    project_path: repo_key,
                });
            }
        }
    }

    // Sort by MR IID
    contexts.sort_by_key(|c| c.iid);

    log::trace!("Found {} loaded GitLab MR contexts", contexts.len());
    Ok(contexts)
}

/// Get the content of a loaded GitLab issue context file
#[tauri::command]
pub async fn get_gitlab_issue_context_content(
    app: tauri::AppHandle,
    worktree_id: String,
    issue_iid: u32,
    project_path: String,
) -> Result<String, String> {
    // Get repo identifier
    let repo_id = get_gitlab_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Verify this worktree has a reference to this context
    let refs = get_worktree_gitlab_issue_refs(&app, &worktree_id)?;
    let expected_key = format!("{repo_key}-{issue_iid}");
    if !refs.contains(&expected_key) {
        return Err(format!(
            "Worktree does not have GitLab issue !{issue_iid} loaded"
        ));
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let context_file = contexts_dir.join(format!("{repo_key}-gitlab-issue-{issue_iid}.md"));

    if !context_file.exists() {
        return Err(format!(
            "Issue context file not found for GitLab issue !{issue_iid}"
        ));
    }

    std::fs::read_to_string(&context_file)
        .map_err(|e| format!("Failed to read GitLab issue context file: {e}"))
}

/// Get the content of a loaded GitLab MR context file
#[tauri::command]
pub async fn get_gitlab_mr_context_content(
    app: tauri::AppHandle,
    worktree_id: String,
    mr_iid: u32,
    project_path: String,
) -> Result<String, String> {
    // Get repo identifier
    let repo_id = get_gitlab_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Verify this worktree has a reference to this context
    let refs = get_worktree_gitlab_mr_refs(&app, &worktree_id)?;
    let expected_key = format!("{repo_key}-{mr_iid}");
    if !refs.contains(&expected_key) {
        return Err(format!(
            "Worktree does not have GitLab MR !{mr_iid} loaded"
        ));
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let context_file = contexts_dir.join(format!("{repo_key}-gitlab-mr-{mr_iid}.md"));

    if !context_file.exists() {
        return Err(format!(
            "MR context file not found for GitLab MR !{mr_iid}"
        ));
    }

    std::fs::read_to_string(&context_file)
        .map_err(|e| format!("Failed to read GitLab MR context file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify_title() {
        assert_eq!(slugify_title("Fix the login bug"), "fix-the-login-bug");
        assert_eq!(slugify_title("Bug: can't save file"), "bug-can-t-save-file");
        assert_eq!(slugify_title("UPPERCASE Title"), "uppercase-title");
        assert_eq!(
            slugify_title("Very long title that should be truncated to five words only"),
            "very-long-title-that-should"
        );
    }

    #[test]
    fn test_generate_branch_name_from_gitlab_issue() {
        assert_eq!(
            generate_branch_name_from_gitlab_issue(123, "Fix the login bug"),
            "issue-123-fix-the-login-bug"
        );
    }

    #[test]
    fn test_generate_branch_name_from_gitlab_mr() {
        assert_eq!(
            generate_branch_name_from_gitlab_mr(456, "Fix authentication"),
            "mr-456-fix-authentication"
        );
    }
}
