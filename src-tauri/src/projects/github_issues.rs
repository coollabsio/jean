use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use super::git::get_repo_identifier;
use crate::gh_cli::config::resolve_gh_binary;
use crate::platform::silent_command;

// =============================================================================
// GitHub Types
// =============================================================================

/// GitHub issue label
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLabel {
    pub name: String,
    pub color: String,
}

/// GitHub user/author
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubAuthor {
    pub login: String,
}

/// GitHub issue from list response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssue {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub labels: Vec<GitHubLabel>,
    pub created_at: String,
    pub author: GitHubAuthor,
}

/// GitHub comment
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubComment {
    pub body: String,
    pub author: GitHubAuthor,
    pub created_at: String,
}

/// GitHub issue detail with comments (from gh issue view)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueDetail {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub labels: Vec<GitHubLabel>,
    pub created_at: String,
    pub author: GitHubAuthor,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub comments: Vec<GitHubComment>,
}

/// Result of listing GitHub issues, includes total count for pagination awareness
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueListResult {
    pub issues: Vec<GitHubIssue>,
    pub total_count: u32,
}

/// Issue context to pass when creating a worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueContext {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub comments: Vec<GitHubComment>,
}

/// List GitHub issues for a repository
///
/// Uses `gh issue list` to fetch issues from the repository.
/// - state: "open", "closed", or "all" (default: "open")
/// - Returns up to 100 issues sorted by creation date (newest first)
/// - Includes total_count from GitHub search API for accurate badge display
#[tauri::command]
pub async fn list_github_issues(
    app: AppHandle,
    project_path: String,
    state: Option<String>,
) -> Result<GitHubIssueListResult, String> {
    log::trace!("Listing GitHub issues for {project_path} with state: {state:?}");

    let gh = resolve_gh_binary(&app);
    let state_arg = state.unwrap_or_else(|| "open".to_string());

    // Run gh issue list
    let output = silent_command(&gh)
        .args([
            "issue",
            "list",
            "--json",
            "number,title,body,state,labels,createdAt,author",
            "-L",
            "100",
            "--state",
            &state_arg,
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh issue list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Handle specific errors
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("Could not resolve") {
            return Err("Could not resolve repository. Is this a GitHub repository?".to_string());
        }
        return Err(format!("gh issue list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let issues: Vec<GitHubIssue> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    // Get accurate total count from GitHub search API
    let total_count =
        get_issue_total_count(&gh, &project_path, &state_arg).unwrap_or(issues.len() as u32);

    log::trace!("Found {} issues (total: {total_count})", issues.len());
    Ok(GitHubIssueListResult {
        issues,
        total_count,
    })
}

/// Get accurate total issue count from GitHub search API
///
/// Uses `gh api search/issues` to get the real total count without fetching all issues.
/// Falls back to None on any error so callers can use issues.len() instead.
fn get_issue_total_count(gh: &PathBuf, project_path: &str, state: &str) -> Option<u32> {
    let repo_id = get_repo_identifier(project_path).ok()?;
    let state_qualifier = match state {
        "closed" => "+state:closed",
        "all" => "",
        _ => "+state:open",
    };
    let query = format!(
        "search/issues?q=repo:{}/{}+is:issue{}&per_page=1",
        repo_id.owner, repo_id.repo, state_qualifier
    );

    let output = silent_command(gh)
        .args(["api", &query])
        .current_dir(project_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    json.get("total_count")?.as_u64().map(|n| n as u32)
}

/// Search GitHub issues using GitHub's search syntax
///
/// Uses `gh issue list --search` to query GitHub's search API.
/// This finds issues beyond the default -L 100 limit.
#[tauri::command]
pub async fn search_github_issues(
    app: AppHandle,
    project_path: String,
    query: String,
) -> Result<Vec<GitHubIssue>, String> {
    log::trace!("Searching GitHub issues for {project_path} with query: {query}");

    let gh = resolve_gh_binary(&app);
    let output = silent_command(&gh)
        .args([
            "issue",
            "list",
            "--search",
            &query,
            "--json",
            "number,title,body,state,labels,createdAt,author",
            "-L",
            "30",
            "--state",
            "all",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh issue list --search: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("Could not resolve") {
            return Err("Could not resolve repository. Is this a GitHub repository?".to_string());
        }
        return Err(format!("gh issue list --search failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let issues: Vec<GitHubIssue> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    log::trace!("Search found {} issues", issues.len());
    Ok(issues)
}

/// Get a GitHub issue by number, returning the same type as list_github_issues.
///
/// Uses `gh issue view` to fetch a single issue by exact number.
/// This finds any issue regardless of age or state.
#[tauri::command]
pub async fn get_github_issue_by_number(
    app: AppHandle,
    project_path: String,
    issue_number: u32,
) -> Result<GitHubIssue, String> {
    log::trace!("Getting GitHub issue #{issue_number} by number for {project_path}");

    let gh = resolve_gh_binary(&app);
    let output = silent_command(&gh)
        .args([
            "issue",
            "view",
            &issue_number.to_string(),
            "--json",
            "number,title,body,state,labels,createdAt,author",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh issue view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("Could not resolve") || stderr.contains("not found") {
            return Err(format!("Issue #{issue_number} not found"));
        }
        return Err(format!("gh issue view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let issue: GitHubIssue =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    log::trace!("Got issue #{}: {}", issue.number, issue.title);
    Ok(issue)
}

/// Get detailed information about a specific GitHub issue
///
/// Uses `gh issue view` to fetch the issue with comments.
#[tauri::command]
pub async fn get_github_issue(
    app: AppHandle,
    project_path: String,
    issue_number: u32,
) -> Result<GitHubIssueDetail, String> {
    log::trace!("Getting GitHub issue #{issue_number} for {project_path}");

    let gh = resolve_gh_binary(&app);
    // Run gh issue view
    let output = silent_command(&gh)
        .args([
            "issue",
            "view",
            &issue_number.to_string(),
            "--json",
            "number,title,body,state,labels,createdAt,author,url,comments",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh issue view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Handle specific errors
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("Could not resolve") || stderr.contains("not found") {
            return Err(format!("Issue #{issue_number} not found"));
        }
        return Err(format!("gh issue view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let issue: GitHubIssueDetail =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    log::trace!("Got issue #{}: {}", issue.number, issue.title);
    Ok(issue)
}

/// Generate a slug from an issue title for branch naming
/// e.g., "Fix the login bug" -> "fix-the-login-bug"
pub fn slugify_issue_title(title: &str) -> String {
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

/// Generate a branch name from an issue
/// e.g., Issue #123 "Fix the login bug" -> "issue-123-fix-the-login-bug"
pub fn generate_branch_name_from_issue(issue_number: u32, title: &str) -> String {
    let slug = slugify_issue_title(title);
    format!("issue-{issue_number}-{slug}")
}

/// Format issue context as markdown for the context file
pub fn format_issue_context_markdown(ctx: &IssueContext) -> String {
    let mut content = String::new();

    content.push_str(&format!(
        "# GitHub Issue #{}: {}\n\n",
        ctx.number, ctx.title
    ));

    content.push_str("---\n\n");

    content.push_str("## Description\n\n");
    if let Some(body) = &ctx.body {
        if !body.is_empty() {
            content.push_str(body);
        } else {
            content.push_str("*No description provided.*");
        }
    } else {
        content.push_str("*No description provided.*");
    }
    content.push_str("\n\n");

    if !ctx.comments.is_empty() {
        content.push_str("## Comments\n\n");
        for comment in &ctx.comments {
            content.push_str(&format!(
                "### @{} ({})\n\n",
                comment.author.login, comment.created_at
            ));
            content.push_str(&comment.body);
            content.push_str("\n\n---\n\n");
        }
    }

    content.push_str("---\n\n");
    content.push_str("*Investigate this issue and propose a solution.*\n");

    content
}

/// Loaded issue context info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedIssueContext {
    pub number: u32,
    pub title: String,
    pub comment_count: usize,
    pub repo_owner: String,
    pub repo_name: String,
}

// =============================================================================
// Shared Context Reference Tracking
// =============================================================================

/// Reference tracking for a single context file (issue or PR)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContextRef {
    #[serde(alias = "worktrees")]
    pub sessions: Vec<String>,
    pub orphaned_at: Option<u64>,
}

/// Tracks which sessions reference which shared context files
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContextReferences {
    pub issues: std::collections::HashMap<String, ContextRef>,
    pub prs: std::collections::HashMap<String, ContextRef>,
    #[serde(default)]
    pub security: std::collections::HashMap<String, ContextRef>,
    #[serde(default)]
    pub advisories: std::collections::HashMap<String, ContextRef>,
    #[serde(default)]
    pub linear: std::collections::HashMap<String, ContextRef>,
}

/// Get the directory for shared GitHub contexts
pub fn get_github_contexts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join("git-context"))
}

/// Get the path to the references.json file
pub fn get_references_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(get_github_contexts_dir(app)?.join("references.json"))
}

/// Load context references from disk
pub fn load_context_references(app: &tauri::AppHandle) -> Result<ContextReferences, String> {
    let path = get_references_path(app)?;
    if !path.exists() {
        return Ok(ContextReferences::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read references.json: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse references.json: {e}"))
}

/// Save context references to disk
pub fn save_context_references(
    app: &tauri::AppHandle,
    refs: &ContextReferences,
) -> Result<(), String> {
    let dir = get_github_contexts_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;

    let path = dir.join("references.json");
    let content = serde_json::to_string_pretty(refs)
        .map_err(|e| format!("Failed to serialize references: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write references.json: {e}"))
}

/// Add a session reference to an issue context
/// Key format: "{owner}-{repo}-{number}"
pub fn add_issue_reference(
    app: &tauri::AppHandle,
    repo_key: &str,
    issue_number: u32,
    session_id: &str,
) -> Result<(), String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{repo_key}-{issue_number}");

    let entry = refs.issues.entry(key).or_default();
    if !entry.sessions.contains(&session_id.to_string()) {
        entry.sessions.push(session_id.to_string());
    }
    // Clear orphaned status when a reference is added
    entry.orphaned_at = None;

    save_context_references(app, &refs)
}

/// Add a session reference to a PR context
/// Key format: "{owner}-{repo}-{number}"
pub fn add_pr_reference(
    app: &tauri::AppHandle,
    repo_key: &str,
    pr_number: u32,
    session_id: &str,
) -> Result<(), String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{repo_key}-{pr_number}");

    let entry = refs.prs.entry(key).or_default();
    if !entry.sessions.contains(&session_id.to_string()) {
        entry.sessions.push(session_id.to_string());
    }
    // Clear orphaned status when a reference is added
    entry.orphaned_at = None;

    save_context_references(app, &refs)
}

/// Remove a session reference from an issue context
/// Returns true if the context is now orphaned (no more references)
pub fn remove_issue_reference(
    app: &tauri::AppHandle,
    repo_key: &str,
    issue_number: u32,
    session_id: &str,
) -> Result<bool, String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{repo_key}-{issue_number}");

    let orphaned = if let Some(entry) = refs.issues.get_mut(&key) {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            );
            true
        } else {
            false
        }
    } else {
        false
    };

    save_context_references(app, &refs)?;
    Ok(orphaned)
}

/// Remove a session reference from a PR context
/// Returns true if the context is now orphaned (no more references)
pub fn remove_pr_reference(
    app: &tauri::AppHandle,
    repo_key: &str,
    pr_number: u32,
    session_id: &str,
) -> Result<bool, String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{repo_key}-{pr_number}");

    let orphaned = if let Some(entry) = refs.prs.get_mut(&key) {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            );
            true
        } else {
            false
        }
    } else {
        false
    };

    save_context_references(app, &refs)?;
    Ok(orphaned)
}

/// Get all issue keys referenced by a session
/// Returns keys in format "{owner}-{repo}-{number}"
pub fn get_session_issue_refs(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let refs = load_context_references(app)?;
    Ok(refs
        .issues
        .iter()
        .filter(|(_, entry)| entry.sessions.contains(&session_id.to_string()))
        .map(|(key, _)| key.clone())
        .collect())
}

/// Get all PR keys referenced by a session
/// Returns keys in format "{owner}-{repo}-{number}"
pub fn get_session_pr_refs(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let refs = load_context_references(app)?;
    Ok(refs
        .prs
        .iter()
        .filter(|(_, entry)| entry.sessions.contains(&session_id.to_string()))
        .map(|(key, _)| key.clone())
        .collect())
}

/// Add a session reference to a security alert context
/// Key format: "{owner}-{repo}-{number}"
pub fn add_security_reference(
    app: &tauri::AppHandle,
    repo_key: &str,
    alert_number: u32,
    session_id: &str,
) -> Result<(), String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{repo_key}-{alert_number}");

    let entry = refs.security.entry(key).or_default();
    if !entry.sessions.contains(&session_id.to_string()) {
        entry.sessions.push(session_id.to_string());
    }
    // Clear orphaned status when a reference is added
    entry.orphaned_at = None;

    save_context_references(app, &refs)
}

/// Remove a session reference from a security alert context
/// Returns true if the context is now orphaned (no more references)
pub fn remove_security_reference(
    app: &tauri::AppHandle,
    repo_key: &str,
    alert_number: u32,
    session_id: &str,
) -> Result<bool, String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{repo_key}-{alert_number}");

    let orphaned = if let Some(entry) = refs.security.get_mut(&key) {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            );
            true
        } else {
            false
        }
    } else {
        false
    };

    save_context_references(app, &refs)?;
    Ok(orphaned)
}

/// Get all security alert keys referenced by a session
/// Returns keys in format "{owner}-{repo}-{number}"
pub fn get_session_security_refs(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let refs = load_context_references(app)?;
    Ok(refs
        .security
        .iter()
        .filter(|(_, entry)| entry.sessions.contains(&session_id.to_string()))
        .map(|(key, _)| key.clone())
        .collect())
}

/// Add a session reference to an advisory context
/// Key format: "{repo_key}::{ghsa_id}"
pub fn add_advisory_reference(
    app: &tauri::AppHandle,
    repo_key: &str,
    ghsa_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{repo_key}::{ghsa_id}");

    let entry = refs.advisories.entry(key).or_default();
    if !entry.sessions.contains(&session_id.to_string()) {
        entry.sessions.push(session_id.to_string());
    }
    // Clear orphaned status when a reference is added
    entry.orphaned_at = None;

    save_context_references(app, &refs)
}

/// Remove a session reference from an advisory context
/// Returns true if the context is now orphaned (no more references)
pub fn remove_advisory_reference(
    app: &tauri::AppHandle,
    repo_key: &str,
    ghsa_id: &str,
    session_id: &str,
) -> Result<bool, String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{repo_key}::{ghsa_id}");

    let orphaned = if let Some(entry) = refs.advisories.get_mut(&key) {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            );
            true
        } else {
            false
        }
    } else {
        false
    };

    save_context_references(app, &refs)?;
    Ok(orphaned)
}

/// Get all advisory keys referenced by a session
/// Returns keys in format "{repo_key}::{ghsa_id}"
pub fn get_session_advisory_refs(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let refs = load_context_references(app)?;
    Ok(refs
        .advisories
        .iter()
        .filter(|(_, entry)| entry.sessions.contains(&session_id.to_string()))
        .map(|(key, _)| key.clone())
        .collect())
}

/// Parse an advisory context key into (owner, repo, ghsa_id)
/// Key format: "{owner}-{repo}::{ghsa_id}"
fn parse_advisory_context_key(key: &str) -> Option<(String, String, String)> {
    let (repo_key, ghsa_id) = key.split_once("::")?;
    let (owner, repo) = repo_key.split_once('-')?;
    Some((owner.to_string(), repo.to_string(), ghsa_id.to_string()))
}

/// Extract the number from a context ref key (format: "{owner}-{repo}-{number}")
fn extract_number_from_ref_key(key: &str) -> Option<u32> {
    key.rsplit('-').next()?.parse().ok()
}

/// Get all issue, PR, and security alert numbers referenced by a session
/// Returns (issue_numbers, pr_numbers, security_numbers)
pub fn get_session_context_numbers(
    app: &AppHandle,
    session_id: &str,
) -> Result<(Vec<u32>, Vec<u32>, Vec<u32>), String> {
    let issue_keys = get_session_issue_refs(app, session_id)?;
    let pr_keys = get_session_pr_refs(app, session_id)?;
    let security_keys = get_session_security_refs(app, session_id)?;

    let issue_nums: Vec<u32> = issue_keys
        .iter()
        .filter_map(|k| extract_number_from_ref_key(k))
        .collect();
    let pr_nums: Vec<u32> = pr_keys
        .iter()
        .filter_map(|k| extract_number_from_ref_key(k))
        .collect();
    let security_nums: Vec<u32> = security_keys
        .iter()
        .filter_map(|k| extract_number_from_ref_key(k))
        .collect();

    Ok((issue_nums, pr_nums, security_nums))
}

/// Get all loaded context markdown content for a session
/// Returns concatenated markdown of all issue, PR, and security context files, or empty string if none
pub fn get_session_context_content(
    app: &AppHandle,
    session_id: &str,
    project_path: &str,
) -> Result<String, String> {
    let repo_id = get_repo_identifier(project_path)?;
    let repo_key = repo_id.to_key();
    let contexts_dir = get_github_contexts_dir(app)?;

    let issue_keys = get_session_issue_refs(app, session_id)?;
    let pr_keys = get_session_pr_refs(app, session_id)?;
    let security_keys = get_session_security_refs(app, session_id)?;
    let advisory_keys = get_session_advisory_refs(app, session_id)?;

    if issue_keys.is_empty()
        && pr_keys.is_empty()
        && security_keys.is_empty()
        && advisory_keys.is_empty()
    {
        return Ok(String::new());
    }

    let mut parts: Vec<String> = Vec::new();

    for key in &issue_keys {
        if let Some(number) = extract_number_from_ref_key(key) {
            let file = contexts_dir.join(format!("{repo_key}-issue-{number}.md"));
            if file.exists() {
                if let Ok(content) = std::fs::read_to_string(&file) {
                    parts.push(format!("### Issue #{number}\n\n{content}"));
                }
            }
        }
    }

    for key in &pr_keys {
        if let Some(number) = extract_number_from_ref_key(key) {
            let file = contexts_dir.join(format!("{repo_key}-pr-{number}.md"));
            if file.exists() {
                if let Ok(content) = std::fs::read_to_string(&file) {
                    parts.push(format!("### PR #{number}\n\n{content}"));
                }
            }
        }
    }

    for key in &security_keys {
        if let Some(number) = extract_number_from_ref_key(key) {
            let file = contexts_dir.join(format!("{repo_key}-security-{number}.md"));
            if file.exists() {
                if let Ok(content) = std::fs::read_to_string(&file) {
                    parts.push(format!("### Security Alert #{number}\n\n{content}"));
                }
            }
        }
    }

    for key in &advisory_keys {
        if let Some((owner, repo, ghsa_id)) = parse_advisory_context_key(key) {
            let adv_repo_key = format!("{owner}-{repo}");
            let file = contexts_dir.join(format!("{adv_repo_key}-advisory-{ghsa_id}.md"));
            if file.exists() {
                if let Ok(content) = std::fs::read_to_string(&file) {
                    parts.push(format!("### Advisory {ghsa_id}\n\n{content}"));
                }
            }
        }
    }

    Ok(parts.join("\n\n"))
}

/// Remove all references for a session
/// Returns (orphaned_issue_keys, orphaned_pr_keys, orphaned_security_keys, orphaned_advisory_keys)
pub fn remove_all_session_references(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<(Vec<String>, Vec<String>, Vec<String>, Vec<String>), String> {
    let mut refs = load_context_references(app)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut orphaned_issues = Vec::new();
    let mut orphaned_prs = Vec::new();
    let mut orphaned_security = Vec::new();
    let mut orphaned_advisories = Vec::new();

    for (key, entry) in refs.issues.iter_mut() {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(now);
            orphaned_issues.push(key.clone());
        }
    }

    for (key, entry) in refs.prs.iter_mut() {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(now);
            orphaned_prs.push(key.clone());
        }
    }

    for (key, entry) in refs.security.iter_mut() {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(now);
            orphaned_security.push(key.clone());
        }
    }

    for (key, entry) in refs.advisories.iter_mut() {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(now);
            orphaned_advisories.push(key.clone());
        }
    }

    save_context_references(app, &refs)?;
    Ok((
        orphaned_issues,
        orphaned_prs,
        orphaned_security,
        orphaned_advisories,
    ))
}

/// Parse a context key into (repo_owner, repo_name, number)
/// Key format: "{owner}-{repo}-{number}"
fn parse_context_key(key: &str) -> Option<(String, String, u32)> {
    // Split from the right to get the number first
    let (repo_key, number_str) = key.rsplit_once('-')?;
    let number = number_str.parse::<u32>().ok()?;

    // Parse repo_key as "owner-repo" - split on first dash only
    let (owner, repo) = repo_key.split_once('-')?;

    Some((owner.to_string(), repo.to_string(), number))
}

/// Clean up orphaned context files older than retention_days
/// Returns the number of files deleted
pub fn cleanup_orphaned_contexts(
    app: &tauri::AppHandle,
    retention_days: u64,
) -> Result<u32, String> {
    let mut refs = load_context_references(app)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let retention_secs = retention_days * 24 * 60 * 60;

    let contexts_dir = get_github_contexts_dir(app)?;
    let mut deleted_count = 0u32;

    // Clean up orphaned issues
    let issues_to_remove: Vec<String> = refs
        .issues
        .iter()
        .filter_map(|(key, entry)| {
            if let Some(orphaned_at) = entry.orphaned_at {
                if orphaned_at + retention_secs < now {
                    return Some(key.clone());
                }
            }
            None
        })
        .collect();

    for key in &issues_to_remove {
        // File format: {repo_key}-issue-{number}.md
        // Key format: {repo_key}-{number}
        // We need to transform key to filename
        if let Some(last_dash) = key.rfind('-') {
            let repo_key = &key[..last_dash];
            let number = &key[last_dash + 1..];
            let filename = format!("{repo_key}-issue-{number}.md");
            let file_path = contexts_dir.join(&filename);
            if file_path.exists() {
                if let Err(e) = std::fs::remove_file(&file_path) {
                    log::warn!("Failed to remove orphaned issue context {filename}: {e}");
                } else {
                    deleted_count += 1;
                }
            }
        }
        refs.issues.remove(key);
    }

    // Clean up orphaned PRs
    let prs_to_remove: Vec<String> = refs
        .prs
        .iter()
        .filter_map(|(key, entry)| {
            if let Some(orphaned_at) = entry.orphaned_at {
                if orphaned_at + retention_secs < now {
                    return Some(key.clone());
                }
            }
            None
        })
        .collect();

    for key in &prs_to_remove {
        // File format: {repo_key}-pr-{number}.md
        // Key format: {repo_key}-{number}
        if let Some(last_dash) = key.rfind('-') {
            let repo_key = &key[..last_dash];
            let number = &key[last_dash + 1..];
            let filename = format!("{repo_key}-pr-{number}.md");
            let file_path = contexts_dir.join(&filename);
            if file_path.exists() {
                if let Err(e) = std::fs::remove_file(&file_path) {
                    log::warn!("Failed to remove orphaned PR context {filename}: {e}");
                } else {
                    deleted_count += 1;
                }
            }
        }
        refs.prs.remove(key);
    }

    // Clean up orphaned security alerts
    let security_to_remove: Vec<String> = refs
        .security
        .iter()
        .filter_map(|(key, entry)| {
            if let Some(orphaned_at) = entry.orphaned_at {
                if orphaned_at + retention_secs < now {
                    return Some(key.clone());
                }
            }
            None
        })
        .collect();

    for key in &security_to_remove {
        // File format: {repo_key}-security-{number}.md
        // Key format: {repo_key}-{number}
        if let Some(last_dash) = key.rfind('-') {
            let repo_key = &key[..last_dash];
            let number = &key[last_dash + 1..];
            let filename = format!("{repo_key}-security-{number}.md");
            let file_path = contexts_dir.join(&filename);
            if file_path.exists() {
                if let Err(e) = std::fs::remove_file(&file_path) {
                    log::warn!("Failed to remove orphaned security context {filename}: {e}");
                } else {
                    deleted_count += 1;
                }
            }
        }
        refs.security.remove(key);
    }

    // Clean up orphaned advisories
    let advisories_to_remove: Vec<String> = refs
        .advisories
        .iter()
        .filter_map(|(key, entry)| {
            if let Some(orphaned_at) = entry.orphaned_at {
                if orphaned_at + retention_secs < now {
                    return Some(key.clone());
                }
            }
            None
        })
        .collect();

    for key in &advisories_to_remove {
        if let Some((owner, repo, ghsa_id)) = parse_advisory_context_key(key) {
            let adv_repo_key = format!("{owner}-{repo}");
            let filename = format!("{adv_repo_key}-advisory-{ghsa_id}.md");
            let file_path = contexts_dir.join(&filename);
            if file_path.exists() {
                if let Err(e) = std::fs::remove_file(&file_path) {
                    log::warn!("Failed to remove orphaned advisory context {filename}: {e}");
                } else {
                    deleted_count += 1;
                }
            }
        }
        refs.advisories.remove(key);
    }

    save_context_references(app, &refs)?;
    Ok(deleted_count)
}

/// Load/refresh issue context for a session by fetching data from GitHub
///
/// Context is stored in shared location: `git-context/{repo_key}-issue-{number}.md`
/// Multiple sessions can reference the same context file.
#[tauri::command]
pub async fn load_issue_context(
    app: tauri::AppHandle,
    session_id: String,
    issue_number: u32,
    project_path: String,
) -> Result<LoadedIssueContext, String> {
    log::trace!("Loading issue #{issue_number} context for session {session_id}");

    // Get repo identifier for shared storage
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Fetch issue data from GitHub
    let issue = get_github_issue(app.clone(), project_path, issue_number).await?;

    // Create issue context
    let ctx = IssueContext {
        number: issue.number,
        title: issue.title.clone(),
        body: issue.body,
        comments: issue.comments,
    };

    // Write to shared git-context directory
    let contexts_dir = get_github_contexts_dir(&app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;

    // File format: {repo_key}-issue-{number}.md
    let context_file = contexts_dir.join(format!("{repo_key}-issue-{issue_number}.md"));
    let context_content = format_issue_context_markdown(&ctx);

    std::fs::write(&context_file, context_content)
        .map_err(|e| format!("Failed to write issue context file: {e}"))?;

    // Add reference tracking
    add_issue_reference(&app, &repo_key, issue_number, &session_id)?;

    log::trace!(
        "Issue context loaded successfully for issue #{} ({} comments)",
        issue_number,
        ctx.comments.len()
    );

    Ok(LoadedIssueContext {
        number: issue.number,
        title: issue.title,
        comment_count: ctx.comments.len(),
        repo_owner: repo_id.owner,
        repo_name: repo_id.repo,
    })
}

/// List all loaded issue contexts for a session
#[tauri::command]
pub async fn list_loaded_issue_contexts(
    app: tauri::AppHandle,
    session_id: String,
    worktree_id: Option<String>,
) -> Result<Vec<LoadedIssueContext>, String> {
    log::trace!("Listing loaded issue contexts for session {session_id}");

    // Get issue refs for this session from reference tracking
    let mut issue_keys = get_session_issue_refs(&app, &session_id)?;

    // Also check worktree_id refs (create_worktree stores refs under worktree_id)
    if let Some(ref wt_id) = worktree_id {
        if let Ok(wt_keys) = get_session_issue_refs(&app, wt_id) {
            for key in wt_keys {
                if !issue_keys.contains(&key) {
                    issue_keys.push(key);
                }
            }
        }
    }

    if issue_keys.is_empty() {
        return Ok(vec![]);
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts = Vec::new();

    for key in issue_keys {
        // Parse key format: "{owner}-{repo}-{number}"
        if let Some((owner, repo, number)) = parse_context_key(&key) {
            let repo_key = format!("{owner}-{repo}");
            let context_file = contexts_dir.join(format!("{repo_key}-issue-{number}.md"));

            if let Ok(content) = std::fs::read_to_string(&context_file) {
                // Parse title from first line: "# GitHub Issue #123: Title"
                let title = content
                    .lines()
                    .next()
                    .and_then(|line| {
                        line.strip_prefix("# GitHub Issue #")
                            .and_then(|rest| rest.split_once(": "))
                            .map(|(_, title)| title.to_string())
                    })
                    .unwrap_or_else(|| format!("Issue #{number}"));

                // Count comments by counting "### @" headers
                let comment_count = content.matches("### @").count();

                contexts.push(LoadedIssueContext {
                    number,
                    title,
                    comment_count,
                    repo_owner: owner,
                    repo_name: repo,
                });
            }
        }
    }

    // Sort by issue number
    contexts.sort_by_key(|c| c.number);

    log::trace!("Found {} loaded issue contexts", contexts.len());
    Ok(contexts)
}

/// Delete all context references for a session
///
/// Called during session deletion. Uses reference tracking - marks contexts as orphaned
/// but doesn't immediately delete shared files (they'll be cleaned up later by cleanup_orphaned_contexts).
pub fn cleanup_issue_contexts_for_session(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<(), String> {
    log::trace!("Cleaning up contexts for session {session_id}");

    // Remove all references for this session (handles issues, PRs, security alerts, and advisories)
    let (orphaned_issues, orphaned_prs, orphaned_security, orphaned_advisories) =
        remove_all_session_references(app, session_id)?;

    log::trace!(
        "Marked {} issues, {} PRs, {} security alerts, and {} advisories as orphaned for session {session_id}",
        orphaned_issues.len(),
        orphaned_prs.len(),
        orphaned_security.len(),
        orphaned_advisories.len()
    );

    Ok(())
}

/// Remove a loaded issue context for a session
#[tauri::command]
pub async fn remove_issue_context(
    app: tauri::AppHandle,
    session_id: String,
    issue_number: u32,
    project_path: String,
) -> Result<(), String> {
    log::trace!("Removing issue #{issue_number} context for session {session_id}");

    // Get repo identifier
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Remove reference
    let is_orphaned = remove_issue_reference(&app, &repo_key, issue_number, &session_id)?;

    // If orphaned, delete the shared file immediately
    if is_orphaned {
        let contexts_dir = get_github_contexts_dir(&app)?;
        let context_file = contexts_dir.join(format!("{repo_key}-issue-{issue_number}.md"));

        if context_file.exists() {
            std::fs::remove_file(&context_file)
                .map_err(|e| format!("Failed to remove issue context file: {e}"))?;
            log::trace!("Deleted orphaned issue context file");
        }
    }

    log::trace!("Issue context removed successfully");
    Ok(())
}

// =============================================================================
// GitHub Pull Request Types and Commands
// =============================================================================

/// GitHub pull request from list response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequest {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    pub created_at: String,
    pub author: GitHubAuthor,
    #[serde(default)]
    pub labels: Vec<GitHubLabel>,
}

/// GitHub review
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubReview {
    pub body: String,
    pub state: String,
    pub author: GitHubAuthor,
    pub submitted_at: Option<String>,
}

/// Raw GitHub REST API review comment (snake_case from API)
#[derive(Debug, Clone, Deserialize)]
struct RawReviewComment {
    user: Option<RawReviewCommentUser>,
    body: Option<String>,
    created_at: Option<String>,
    diff_hunk: Option<String>,
    path: Option<String>,
    #[serde(default)]
    start_line: Option<u32>,
    #[serde(default)]
    line: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawReviewCommentUser {
    login: Option<String>,
}

/// GitHub inline review comment (on specific diff lines), normalized to camelCase for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubReviewComment {
    pub author: GitHubAuthor,
    pub body: String,
    pub created_at: String,
    pub diff_hunk: String,
    pub path: String,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub line: Option<u32>,
}

impl From<RawReviewComment> for GitHubReviewComment {
    fn from(raw: RawReviewComment) -> Self {
        Self {
            author: GitHubAuthor {
                login: raw
                    .user
                    .and_then(|u| u.login)
                    .unwrap_or_else(|| "unknown".to_string()),
            },
            body: raw.body.unwrap_or_default(),
            created_at: raw.created_at.unwrap_or_default(),
            diff_hunk: raw.diff_hunk.unwrap_or_default(),
            path: raw.path.unwrap_or_default(),
            start_line: raw.start_line,
            line: raw.line,
        }
    }
}

/// GitHub PR detail with comments and reviews
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequestDetail {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    pub created_at: String,
    pub author: GitHubAuthor,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub labels: Vec<GitHubLabel>,
    #[serde(default)]
    pub comments: Vec<GitHubComment>,
    #[serde(default)]
    pub reviews: Vec<GitHubReview>,
}

/// PR context to pass when creating a worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestContext {
    pub number: u32,
    pub title: String,
    pub body: Option<String>,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub comments: Vec<GitHubComment>,
    pub reviews: Vec<GitHubReview>,
    pub diff: Option<String>,
}

/// Loaded PR context info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPullRequestContext {
    pub number: u32,
    pub title: String,
    pub comment_count: usize,
    pub review_count: usize,
    pub repo_owner: String,
    pub repo_name: String,
}

/// List GitHub pull requests for a repository
///
/// Uses `gh pr list` to fetch PRs from the repository.
/// - state: "open", "closed", "merged", or "all" (default: "open")
/// - Returns up to 100 PRs sorted by creation date (newest first)
#[tauri::command]
pub async fn list_github_prs(
    app: AppHandle,
    project_path: String,
    state: Option<String>,
) -> Result<Vec<GitHubPullRequest>, String> {
    log::trace!("Listing GitHub PRs for {project_path} with state: {state:?}");

    let gh = resolve_gh_binary(&app);
    let state_arg = state.unwrap_or_else(|| "open".to_string());

    // Run gh pr list
    let output = silent_command(&gh)
        .args([
            "pr",
            "list",
            "--json",
            "number,title,body,state,headRefName,baseRefName,isDraft,createdAt,author,labels",
            "-L",
            "100",
            "--state",
            &state_arg,
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh pr list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("Could not resolve") {
            return Err("Could not resolve repository. Is this a GitHub repository?".to_string());
        }
        return Err(format!("gh pr list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let prs: Vec<GitHubPullRequest> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    log::trace!("Found {} PRs", prs.len());
    Ok(prs)
}

/// Search GitHub pull requests using GitHub's search syntax
///
/// Uses `gh pr list --search` to query GitHub's search API.
/// This finds PRs beyond the default -L 100 limit.
#[tauri::command]
pub async fn search_github_prs(
    app: AppHandle,
    project_path: String,
    query: String,
) -> Result<Vec<GitHubPullRequest>, String> {
    log::trace!("Searching GitHub PRs for {project_path} with query: {query}");

    let gh = resolve_gh_binary(&app);
    let output = silent_command(&gh)
        .args([
            "pr",
            "list",
            "--search",
            &query,
            "--json",
            "number,title,body,state,headRefName,baseRefName,isDraft,createdAt,author,labels",
            "-L",
            "30",
            "--state",
            "all",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh pr list --search: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("Could not resolve") {
            return Err("Could not resolve repository. Is this a GitHub repository?".to_string());
        }
        return Err(format!("gh pr list --search failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let prs: Vec<GitHubPullRequest> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    log::trace!("Search found {} PRs", prs.len());
    Ok(prs)
}

/// Get a GitHub PR by number, returning the same type as list_github_prs.
///
/// Uses `gh pr view` to fetch a single PR by exact number.
/// This finds any PR regardless of age or state.
#[tauri::command]
pub async fn get_github_pr_by_number(
    app: AppHandle,
    project_path: String,
    pr_number: u32,
) -> Result<GitHubPullRequest, String> {
    log::trace!("Getting GitHub PR #{pr_number} by number for {project_path}");

    let gh = resolve_gh_binary(&app);
    let output = silent_command(&gh)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "number,title,body,state,headRefName,baseRefName,isDraft,createdAt,author,labels",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh pr view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("Could not resolve") || stderr.contains("not found") {
            return Err(format!("PR #{pr_number} not found"));
        }
        return Err(format!("gh pr view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pr: GitHubPullRequest =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    log::trace!("Got PR #{}: {}", pr.number, pr.title);
    Ok(pr)
}

/// Get detailed information about a specific GitHub PR
///
/// Uses `gh pr view` to fetch the PR with comments and reviews.
#[tauri::command]
pub async fn get_github_pr(
    app: AppHandle,
    project_path: String,
    pr_number: u32,
) -> Result<GitHubPullRequestDetail, String> {
    log::trace!("Getting GitHub PR #{pr_number} for {project_path}");

    let gh = resolve_gh_binary(&app);
    // Run gh pr view
    let output = silent_command(&gh)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "number,title,body,state,headRefName,baseRefName,isDraft,createdAt,author,url,labels,comments,reviews",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh pr view: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("Could not resolve") || stderr.contains("not found") {
            return Err(format!("PR #{pr_number} not found"));
        }
        return Err(format!("gh pr view failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pr: GitHubPullRequestDetail =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    log::trace!("Got PR #{}: {}", pr.number, pr.title);
    Ok(pr)
}

/// Fetch inline review comments for a PR.
///
/// Uses `gh api /repos/{owner}/{repo}/pulls/{number}/comments` to get code-level
/// review comments (inline comments on specific diff lines).
#[tauri::command]
pub async fn get_pr_review_comments(
    app: AppHandle,
    project_path: String,
    pr_number: u32,
) -> Result<Vec<GitHubReviewComment>, String> {
    log::trace!("Getting review comments for PR #{pr_number} in {project_path}");

    let gh = resolve_gh_binary(&app);
    let repo_id = get_repo_identifier(&project_path)?;
    let endpoint = format!(
        "/repos/{}/{}/pulls/{pr_number}/comments?per_page=100",
        repo_id.owner, repo_id.repo
    );

    let output = silent_command(&gh)
        .args(["api", &endpoint])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh api: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("404") || stderr.contains("Not Found") {
            return Err(format!("PR #{pr_number} not found"));
        }
        return Err(format!("gh api failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw_comments: Vec<RawReviewComment> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse gh response: {e}"))?;

    let comments: Vec<GitHubReviewComment> = raw_comments
        .into_iter()
        .map(GitHubReviewComment::from)
        .collect();

    log::trace!("Got {} review comments for PR #{pr_number}", comments.len());
    Ok(comments)
}

/// Generate a branch name from a PR
/// e.g., PR #123 "Fix the login bug" -> "pr-123-fix-the-login-bug"
pub fn generate_branch_name_from_pr(pr_number: u32, title: &str) -> String {
    let slug = slugify_issue_title(title);
    format!("pr-{pr_number}-{slug}")
}

/// Format PR context as markdown for the context file
pub fn format_pr_context_markdown(ctx: &PullRequestContext) -> String {
    let mut content = String::new();

    content.push_str(&format!(
        "# GitHub Pull Request #{}: {}\n\n",
        ctx.number, ctx.title
    ));

    content.push_str(&format!(
        "**Branch:** `{}` → `{}`\n\n",
        ctx.head_ref_name, ctx.base_ref_name
    ));

    content.push_str("---\n\n");

    content.push_str("## Description\n\n");
    if let Some(body) = &ctx.body {
        if !body.is_empty() {
            content.push_str(body);
        } else {
            content.push_str("*No description provided.*");
        }
    } else {
        content.push_str("*No description provided.*");
    }
    content.push_str("\n\n");

    if !ctx.reviews.is_empty() {
        content.push_str("## Reviews\n\n");
        for review in &ctx.reviews {
            let submitted = review.submitted_at.as_deref().unwrap_or("Unknown date");
            content.push_str(&format!(
                "### @{} - {} ({})\n\n",
                review.author.login, review.state, submitted
            ));
            if !review.body.is_empty() {
                content.push_str(&review.body);
                content.push_str("\n\n");
            }
            content.push_str("---\n\n");
        }
    }

    if !ctx.comments.is_empty() {
        content.push_str("## Comments\n\n");
        for comment in &ctx.comments {
            content.push_str(&format!(
                "### @{} ({})\n\n",
                comment.author.login, comment.created_at
            ));
            content.push_str(&comment.body);
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
    content.push_str("*Review this pull request and provide feedback or make changes.*\n");

    content
}

/// Get the diff for a PR using `gh pr diff`
///
/// Returns the diff as a string, truncated to 100KB if too large.
pub fn get_pr_diff(
    project_path: &str,
    pr_number: u32,
    gh_binary: &std::path::Path,
) -> Result<String, String> {
    log::debug!("Fetching diff for PR #{pr_number} in {project_path}");

    let output = silent_command(gh_binary)
        .args(["pr", "diff", &pr_number.to_string(), "--color", "never"])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to run gh pr diff: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::debug!("gh pr diff failed: {stderr}");
        // Return empty string on failure (diff might not be available)
        return Ok(String::new());
    }

    let diff = String::from_utf8_lossy(&output.stdout).to_string();
    log::debug!("Got diff for PR #{pr_number}: {} bytes", diff.len());

    // Truncate if > 100KB
    const MAX_DIFF_SIZE: usize = 100_000;
    if diff.len() > MAX_DIFF_SIZE {
        // Find a safe UTF-8 char boundary near MAX_DIFF_SIZE
        let end = diff
            .char_indices()
            .take_while(|(i, _)| *i < MAX_DIFF_SIZE)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(MAX_DIFF_SIZE.min(diff.len()));
        Ok(format!(
            "{}...\n\n[Diff truncated at 100KB - {} bytes total. Run `gh pr diff {}` to see the full diff.]",
            &diff[..end],
            diff.len(),
            pr_number
        ))
    } else {
        Ok(diff)
    }
}

/// Load/refresh PR context for a session by fetching data from GitHub
///
/// Context is stored in shared location: `git-context/{repo_key}-pr-{number}.md`
/// Multiple sessions can reference the same context file.
#[tauri::command]
pub async fn load_pr_context(
    app: tauri::AppHandle,
    session_id: String,
    pr_number: u32,
    project_path: String,
) -> Result<LoadedPullRequestContext, String> {
    log::trace!("Loading PR #{pr_number} context for session {session_id}");

    // Get repo identifier for shared storage
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    let gh = resolve_gh_binary(&app);

    // Fetch PR data from GitHub
    let pr = get_github_pr(app.clone(), project_path.clone(), pr_number).await?;

    // Fetch the diff
    let diff = get_pr_diff(&project_path, pr_number, &gh).ok();

    // Create PR context
    let ctx = PullRequestContext {
        number: pr.number,
        title: pr.title.clone(),
        body: pr.body,
        head_ref_name: pr.head_ref_name,
        base_ref_name: pr.base_ref_name,
        comments: pr.comments,
        reviews: pr.reviews.clone(),
        diff,
    };

    // Write to shared git-context directory
    let contexts_dir = get_github_contexts_dir(&app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;

    // File format: {repo_key}-pr-{number}.md
    let context_file = contexts_dir.join(format!("{repo_key}-pr-{pr_number}.md"));
    let context_content = format_pr_context_markdown(&ctx);

    std::fs::write(&context_file, context_content)
        .map_err(|e| format!("Failed to write PR context file: {e}"))?;

    // Add reference tracking
    add_pr_reference(&app, &repo_key, pr_number, &session_id)?;

    log::debug!(
        "PR context loaded successfully for PR #{} ({} comments, {} reviews, diff: {} bytes)",
        pr_number,
        ctx.comments.len(),
        ctx.reviews.len(),
        ctx.diff.as_ref().map(|d| d.len()).unwrap_or(0)
    );

    Ok(LoadedPullRequestContext {
        number: pr.number,
        title: pr.title,
        comment_count: ctx.comments.len(),
        review_count: pr.reviews.len(),
        repo_owner: repo_id.owner,
        repo_name: repo_id.repo,
    })
}

/// List all loaded PR contexts for a session
#[tauri::command]
pub async fn list_loaded_pr_contexts(
    app: tauri::AppHandle,
    session_id: String,
    worktree_id: Option<String>,
) -> Result<Vec<LoadedPullRequestContext>, String> {
    log::trace!("Listing loaded PR contexts for session {session_id}");

    // Get PR refs for this session from reference tracking
    let mut pr_keys = get_session_pr_refs(&app, &session_id)?;

    // Also check worktree_id refs (create_worktree stores refs under worktree_id)
    if let Some(ref wt_id) = worktree_id {
        if let Ok(wt_keys) = get_session_pr_refs(&app, wt_id) {
            for key in wt_keys {
                if !pr_keys.contains(&key) {
                    pr_keys.push(key);
                }
            }
        }
    }

    if pr_keys.is_empty() {
        return Ok(vec![]);
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts = Vec::new();

    for key in pr_keys {
        // Parse key format: "{owner}-{repo}-{number}"
        if let Some((owner, repo, number)) = parse_context_key(&key) {
            let repo_key = format!("{owner}-{repo}");
            let context_file = contexts_dir.join(format!("{repo_key}-pr-{number}.md"));

            if let Ok(content) = std::fs::read_to_string(&context_file) {
                // Parse title from first line: "# GitHub Pull Request #123: Title"
                let title = content
                    .lines()
                    .next()
                    .and_then(|line| {
                        line.strip_prefix("# GitHub Pull Request #")
                            .and_then(|rest| rest.split_once(": "))
                            .map(|(_, title)| title.to_string())
                    })
                    .unwrap_or_else(|| format!("PR #{number}"));

                // Count comments by counting "### @" headers in Comments section
                let comment_count = content
                    .find("## Comments")
                    .map(|start| content[start..].matches("### @").count())
                    .unwrap_or(0);

                // Count reviews by counting "### @" headers in Reviews section
                let review_count = content
                    .find("## Reviews")
                    .map(|start| {
                        let reviews_section = &content[start..];
                        let end = reviews_section
                            .find("## Comments")
                            .unwrap_or(reviews_section.len());
                        reviews_section[..end].matches("### @").count()
                    })
                    .unwrap_or(0);

                contexts.push(LoadedPullRequestContext {
                    number,
                    title,
                    comment_count,
                    review_count,
                    repo_owner: owner,
                    repo_name: repo,
                });
            }
        }
    }

    // Sort by PR number
    contexts.sort_by_key(|c| c.number);

    log::trace!("Found {} loaded PR contexts", contexts.len());
    Ok(contexts)
}

/// Remove a loaded PR context for a session
#[tauri::command]
pub async fn remove_pr_context(
    app: tauri::AppHandle,
    session_id: String,
    pr_number: u32,
    project_path: String,
) -> Result<(), String> {
    log::trace!("Removing PR #{pr_number} context for session {session_id}");

    // Get repo identifier
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Remove reference
    let is_orphaned = remove_pr_reference(&app, &repo_key, pr_number, &session_id)?;

    // If orphaned, delete the shared file immediately
    if is_orphaned {
        let contexts_dir = get_github_contexts_dir(&app)?;
        let context_file = contexts_dir.join(format!("{repo_key}-pr-{pr_number}.md"));

        if context_file.exists() {
            std::fs::remove_file(&context_file)
                .map_err(|e| format!("Failed to remove PR context file: {e}"))?;
            log::trace!("Deleted orphaned PR context file");
        }
    }

    log::trace!("PR context removed successfully");
    Ok(())
}

/// Get the content of a loaded issue context file
#[tauri::command]
pub async fn get_issue_context_content(
    app: tauri::AppHandle,
    session_id: String,
    issue_number: u32,
    project_path: String,
) -> Result<String, String> {
    // Get repo identifier
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Verify this session has a reference to this context
    let refs = get_session_issue_refs(&app, &session_id)?;
    let expected_key = format!("{repo_key}-{issue_number}");
    if !refs.contains(&expected_key) {
        return Err(format!(
            "Session does not have issue #{issue_number} loaded"
        ));
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let context_file = contexts_dir.join(format!("{repo_key}-issue-{issue_number}.md"));

    if !context_file.exists() {
        return Err(format!(
            "Issue context file not found for issue #{issue_number}"
        ));
    }

    std::fs::read_to_string(&context_file)
        .map_err(|e| format!("Failed to read issue context file: {e}"))
}

/// Get the content of a loaded PR context file
#[tauri::command]
pub async fn get_pr_context_content(
    app: tauri::AppHandle,
    session_id: String,
    pr_number: u32,
    project_path: String,
) -> Result<String, String> {
    // Get repo identifier
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Verify this session has a reference to this context
    let refs = get_session_pr_refs(&app, &session_id)?;
    let expected_key = format!("{repo_key}-{pr_number}");
    if !refs.contains(&expected_key) {
        return Err(format!("Session does not have PR #{pr_number} loaded"));
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let context_file = contexts_dir.join(format!("{repo_key}-pr-{pr_number}.md"));

    if !context_file.exists() {
        return Err(format!("PR context file not found for PR #{pr_number}"));
    }

    std::fs::read_to_string(&context_file)
        .map_err(|e| format!("Failed to read PR context file: {e}"))
}

// =============================================================================
// Dependabot Alert / Security Types and Commands
// =============================================================================

/// Raw package info from GitHub Dependabot API
#[derive(Debug, Clone, Deserialize)]
pub struct DependabotPackageRaw {
    pub name: String,
    pub ecosystem: String,
}

/// Raw dependency from GitHub Dependabot API
#[derive(Debug, Clone, Deserialize)]
pub struct DependabotDependencyRaw {
    pub package: DependabotPackageRaw,
    pub manifest_path: String,
}

/// Raw security advisory from GitHub Dependabot API
#[derive(Debug, Clone, Deserialize)]
pub struct SecurityAdvisoryRaw {
    pub ghsa_id: String,
    pub cve_id: Option<String>,
    pub summary: String,
    pub description: String,
    pub severity: String,
}

/// Raw Dependabot alert from GitHub REST API
#[derive(Debug, Clone, Deserialize)]
pub struct DependabotAlertRaw {
    pub number: u32,
    pub state: String,
    pub dependency: DependabotDependencyRaw,
    pub security_advisory: SecurityAdvisoryRaw,
    pub created_at: String,
    pub html_url: String,
    pub dismissed_reason: Option<String>,
    pub dismissed_comment: Option<String>,
    pub fixed_at: Option<String>,
}

/// Dependabot alert flattened for frontend consumption
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependabotAlert {
    pub number: u32,
    pub state: String,
    pub package_name: String,
    pub package_ecosystem: String,
    pub manifest_path: String,
    pub ghsa_id: String,
    pub cve_id: Option<String>,
    pub severity: String,
    pub summary: String,
    pub description: String,
    pub created_at: String,
    pub html_url: String,
}

/// Security alert context to pass when creating a worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityAlertContext {
    pub number: u32,
    pub package_name: String,
    pub package_ecosystem: String,
    pub severity: String,
    pub summary: String,
    pub description: String,
    pub ghsa_id: String,
    pub cve_id: Option<String>,
    pub manifest_path: String,
}

/// Loaded security alert context info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSecurityAlertContext {
    pub number: u32,
    pub package_name: String,
    pub severity: String,
    pub summary: String,
    pub repo_owner: String,
    pub repo_name: String,
}

impl DependabotAlertRaw {
    pub fn into_frontend(self) -> DependabotAlert {
        DependabotAlert {
            number: self.number,
            state: self.state,
            package_name: self.dependency.package.name,
            package_ecosystem: self.dependency.package.ecosystem,
            manifest_path: self.dependency.manifest_path,
            ghsa_id: self.security_advisory.ghsa_id,
            cve_id: self.security_advisory.cve_id,
            severity: self.security_advisory.severity,
            summary: self.security_advisory.summary,
            description: self.security_advisory.description,
            created_at: self.created_at,
            html_url: self.html_url,
        }
    }
}

// =============================================================================
// Repository Security Advisory Types
// =============================================================================

/// Vulnerability package from GitHub Security Advisory API
#[derive(Debug, Clone, Deserialize)]
pub struct AdvisoryVulnerabilityPackageRaw {
    pub name: String,
    pub ecosystem: String,
}

/// Vulnerability entry from GitHub Security Advisory API
#[derive(Debug, Clone, Deserialize)]
pub struct AdvisoryVulnerabilityRaw {
    pub package: Option<AdvisoryVulnerabilityPackageRaw>,
    pub vulnerable_version_range: Option<String>,
    pub patched_versions: Option<String>,
    pub vulnerable_functions: Option<Vec<String>>,
}

/// Author from GitHub Security Advisory API
#[derive(Debug, Clone, Deserialize)]
pub struct AdvisoryAuthorRaw {
    pub login: String,
}

/// Raw repository security advisory from GitHub REST API
#[derive(Debug, Clone, Deserialize)]
pub struct RepositoryAdvisoryRaw {
    pub ghsa_id: String,
    pub cve_id: Option<String>,
    pub summary: String,
    pub description: Option<String>,
    pub severity: Option<String>,
    pub state: String,
    pub author: Option<AdvisoryAuthorRaw>,
    pub publisher: Option<AdvisoryAuthorRaw>,
    pub created_at: String,
    pub published_at: Option<String>,
    pub html_url: String,
    pub vulnerabilities: Vec<AdvisoryVulnerabilityRaw>,
}

/// Vulnerability info for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisoryVulnerability {
    pub package_name: String,
    pub package_ecosystem: String,
    pub vulnerable_version_range: Option<String>,
    pub patched_versions: Option<String>,
}

/// Repository security advisory for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryAdvisory {
    pub ghsa_id: String,
    pub cve_id: Option<String>,
    pub summary: String,
    pub description: String,
    pub severity: String,
    pub state: String,
    pub author_login: Option<String>,
    pub created_at: String,
    pub published_at: Option<String>,
    pub html_url: String,
    pub vulnerabilities: Vec<AdvisoryVulnerability>,
}

/// Advisory context to pass when creating a worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisoryContext {
    pub ghsa_id: String,
    pub severity: String,
    pub summary: String,
    pub description: String,
    pub cve_id: Option<String>,
    pub vulnerabilities: Vec<AdvisoryVulnerability>,
}

/// Loaded advisory context info returned from backend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedAdvisoryContext {
    pub ghsa_id: String,
    pub severity: String,
    pub summary: String,
    pub repo_owner: String,
    pub repo_name: String,
}

impl RepositoryAdvisoryRaw {
    pub fn into_frontend(self) -> RepositoryAdvisory {
        let vulnerabilities: Vec<AdvisoryVulnerability> = self
            .vulnerabilities
            .into_iter()
            .filter_map(|v| {
                v.package.map(|pkg| AdvisoryVulnerability {
                    package_name: pkg.name,
                    package_ecosystem: pkg.ecosystem,
                    vulnerable_version_range: v.vulnerable_version_range,
                    patched_versions: v.patched_versions,
                })
            })
            .collect();

        RepositoryAdvisory {
            ghsa_id: self.ghsa_id,
            cve_id: self.cve_id,
            summary: self.summary,
            description: self.description.unwrap_or_default(),
            severity: self.severity.unwrap_or_else(|| "unknown".to_string()),
            state: self.state,
            author_login: self.author.map(|a| a.login),
            created_at: self.created_at,
            published_at: self.published_at,
            html_url: self.html_url,
            vulnerabilities,
        }
    }
}

/// Generate a branch name from a security alert
pub fn generate_branch_name_from_security_alert(
    alert_number: u32,
    package_name: &str,
    summary: &str,
) -> String {
    let slug = slugify_issue_title(summary);
    // Include package name in branch, truncated
    let pkg = package_name.replace('/', "-").replace('@', "");
    let pkg_truncated;
    let pkg_short = if pkg.len() > 20 {
        pkg_truncated = pkg.chars().take(20).collect::<String>();
        &pkg_truncated
    } else {
        &pkg
    };
    format!("security-{alert_number}-{pkg_short}-{slug}")
}

/// Format security alert context as markdown
pub fn format_security_context_markdown(ctx: &SecurityAlertContext) -> String {
    let mut content = String::new();

    content.push_str(&format!(
        "# Dependabot Alert #{}: {}\n\n",
        ctx.number, ctx.summary
    ));

    content.push_str(&format!(
        "**Severity:** {} | **Package:** {} ({}) | **Manifest:** {}\n\n",
        ctx.severity, ctx.package_name, ctx.package_ecosystem, ctx.manifest_path
    ));

    content.push_str(&format!("**GHSA:** {}", ctx.ghsa_id));
    if let Some(ref cve) = ctx.cve_id {
        content.push_str(&format!(" | **CVE:** {cve}"));
    }
    content.push_str("\n\n---\n\n");

    content.push_str("## Description\n\n");
    content.push_str(&ctx.description);
    content.push_str("\n\n---\n\n");
    content.push_str("*Fix this security vulnerability.*\n");

    content
}

/// Generate branch name from advisory
pub fn generate_branch_name_from_advisory(ghsa_id: &str, summary: &str) -> String {
    let slug: String = summary
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.len() > 40 { &slug[..40] } else { &slug };
    let slug = slug.trim_end_matches('-');
    // Use short GHSA ID (remove "GHSA-" prefix for branch name brevity)
    let ghsa_short = ghsa_id.strip_prefix("GHSA-").unwrap_or(ghsa_id);
    format!("advisory-{ghsa_short}-{slug}")
}

/// Format advisory context as markdown
pub fn format_advisory_context_markdown(ctx: &AdvisoryContext) -> String {
    let mut content = String::new();

    content.push_str(&format!(
        "# Security Advisory {}: {}\n\n",
        ctx.ghsa_id, ctx.summary
    ));

    content.push_str(&format!("**Severity:** {}", ctx.severity));
    if let Some(ref cve) = ctx.cve_id {
        content.push_str(&format!(" | **CVE:** {cve}"));
    }
    content.push_str("\n\n");

    if !ctx.vulnerabilities.is_empty() {
        content.push_str("## Affected Packages\n\n");
        for vuln in &ctx.vulnerabilities {
            content.push_str(&format!(
                "- **{}** ({})",
                vuln.package_name, vuln.package_ecosystem
            ));
            if let Some(ref range) = vuln.vulnerable_version_range {
                content.push_str(&format!(" — vulnerable: {range}"));
            }
            if let Some(ref patched) = vuln.patched_versions {
                content.push_str(&format!(", patched: {patched}"));
            }
            content.push('\n');
        }
        content.push('\n');
    }

    content.push_str("---\n\n## Description\n\n");
    content.push_str(&ctx.description);
    content.push_str("\n\n---\n\n");
    content.push_str("*Fix this security advisory.*\n");

    content
}

/// List Dependabot alerts for a repository
///
/// Uses `gh api` to fetch Dependabot alerts from the repository.
/// - state: "open", "dismissed", "fixed", "auto_dismissed" (default: "open")
/// - Returns up to 100 alerts
#[tauri::command]
pub async fn list_dependabot_alerts(
    app: AppHandle,
    project_path: String,
    state: Option<String>,
) -> Result<Vec<DependabotAlert>, String> {
    log::trace!("Listing Dependabot alerts for {project_path} with state: {state:?}");

    let gh = resolve_gh_binary(&app);
    let repo_id = get_repo_identifier(&project_path)?;
    let state_arg = state.unwrap_or_else(|| "open".to_string());

    let endpoint = format!(
        "/repos/{}/{}/dependabot/alerts?state={}&per_page=100",
        repo_id.owner, repo_id.repo, state_arg
    );

    let output = silent_command(&gh)
        .args(["api", &endpoint])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh api: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("404") || stderr.contains("Dependabot alerts are not available") {
            log::debug!("Dependabot alerts not available for this repo, returning empty list");
            return Ok(vec![]);
        }
        if stderr.contains("403") {
            return Err("Insufficient permissions to access Dependabot alerts.".to_string());
        }
        return Err(format!("gh api failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw_alerts: Vec<DependabotAlertRaw> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse Dependabot alerts response: {e}"))?;

    let alerts: Vec<DependabotAlert> = raw_alerts.into_iter().map(|a| a.into_frontend()).collect();

    log::trace!("Found {} Dependabot alerts", alerts.len());
    Ok(alerts)
}

/// Get a single Dependabot alert by number
#[tauri::command]
pub async fn get_dependabot_alert(
    app: AppHandle,
    project_path: String,
    alert_number: u32,
) -> Result<DependabotAlert, String> {
    let gh = resolve_gh_binary(&app);
    let repo_id = get_repo_identifier(&project_path)?;

    let endpoint = format!(
        "/repos/{}/{}/dependabot/alerts/{alert_number}",
        repo_id.owner, repo_id.repo
    );

    let output = silent_command(&gh)
        .args(["api", &endpoint])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh api: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("404") {
            return Err(format!("Dependabot alert #{alert_number} not found"));
        }
        return Err(format!("gh api failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: DependabotAlertRaw = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse Dependabot alert response: {e}"))?;

    Ok(raw.into_frontend())
}

/// Load/refresh security alert context for a session by fetching data from GitHub
///
/// Context is stored in shared location: `git-context/{repo_key}-security-{number}.md`
/// Multiple sessions can reference the same context file.
#[tauri::command]
pub async fn load_security_alert_context(
    app: tauri::AppHandle,
    session_id: String,
    alert_number: u32,
    project_path: String,
) -> Result<LoadedSecurityAlertContext, String> {
    log::trace!("Loading security alert #{alert_number} context for session {session_id}");

    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Fetch alert from GitHub
    let alert_raw = {
        let gh = resolve_gh_binary(&app);
        let endpoint = format!(
            "/repos/{}/{}/dependabot/alerts/{alert_number}",
            repo_id.owner, repo_id.repo
        );
        let output = silent_command(&gh)
            .args(["api", &endpoint])
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to run gh api: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to fetch Dependabot alert: {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<DependabotAlertRaw>(&stdout)
            .map_err(|e| format!("Failed to parse Dependabot alert: {e}"))?
    };

    let ctx = SecurityAlertContext {
        number: alert_raw.number,
        package_name: alert_raw.dependency.package.name.clone(),
        package_ecosystem: alert_raw.dependency.package.ecosystem.clone(),
        severity: alert_raw.security_advisory.severity.clone(),
        summary: alert_raw.security_advisory.summary.clone(),
        description: alert_raw.security_advisory.description.clone(),
        ghsa_id: alert_raw.security_advisory.ghsa_id.clone(),
        cve_id: alert_raw.security_advisory.cve_id.clone(),
        manifest_path: alert_raw.dependency.manifest_path.clone(),
    };

    // Write to shared git-context directory
    let contexts_dir = get_github_contexts_dir(&app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;

    let context_file = contexts_dir.join(format!("{repo_key}-security-{alert_number}.md"));
    let context_content = format_security_context_markdown(&ctx);

    std::fs::write(&context_file, context_content)
        .map_err(|e| format!("Failed to write security context file: {e}"))?;

    add_security_reference(&app, &repo_key, alert_number, &session_id)?;

    Ok(LoadedSecurityAlertContext {
        number: alert_raw.number,
        package_name: alert_raw.dependency.package.name,
        severity: alert_raw.security_advisory.severity,
        summary: alert_raw.security_advisory.summary,
        repo_owner: repo_id.owner,
        repo_name: repo_id.repo,
    })
}

/// List all loaded security alert contexts for a session
#[tauri::command]
pub async fn list_loaded_security_contexts(
    app: tauri::AppHandle,
    session_id: String,
    worktree_id: Option<String>,
) -> Result<Vec<LoadedSecurityAlertContext>, String> {
    log::trace!("Listing loaded security contexts for session {session_id}");

    let mut security_keys = get_session_security_refs(&app, &session_id)?;

    // Also check worktree_id refs (create_worktree stores refs under worktree_id)
    if let Some(ref wt_id) = worktree_id {
        if let Ok(wt_keys) = get_session_security_refs(&app, wt_id) {
            for key in wt_keys {
                if !security_keys.contains(&key) {
                    security_keys.push(key);
                }
            }
        }
    }

    if security_keys.is_empty() {
        return Ok(vec![]);
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts = Vec::new();

    for key in security_keys {
        if let Some((owner, repo, number)) = parse_context_key(&key) {
            let repo_key = format!("{owner}-{repo}");
            let context_file = contexts_dir.join(format!("{repo_key}-security-{number}.md"));

            if let Ok(content) = std::fs::read_to_string(&context_file) {
                // Parse from first line: "# Dependabot Alert #42: Summary text"
                let summary = content
                    .lines()
                    .next()
                    .and_then(|line| {
                        line.strip_prefix("# Dependabot Alert #")
                            .and_then(|rest| rest.split_once(": "))
                            .map(|(_, title)| title.to_string())
                    })
                    .unwrap_or_else(|| format!("Alert #{number}"));

                // Parse severity and package from third line (index 2)
                // "**Severity:** critical | **Package:** lodash (npm) | **Manifest:** package.json"
                let (severity, package_name) = content
                    .lines()
                    .nth(2)
                    .map(|line| {
                        let sev = line
                            .split("**Severity:** ")
                            .nth(1)
                            .and_then(|s| s.split(" |").next())
                            .unwrap_or("unknown")
                            .to_string();
                        let pkg = line
                            .split("**Package:** ")
                            .nth(1)
                            .and_then(|s| s.split(" (").next())
                            .unwrap_or("unknown")
                            .to_string();
                        (sev, pkg)
                    })
                    .unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

                contexts.push(LoadedSecurityAlertContext {
                    number,
                    package_name,
                    severity,
                    summary,
                    repo_owner: owner,
                    repo_name: repo,
                });
            }
        }
    }

    contexts.sort_by_key(|c| c.number);
    log::trace!("Found {} loaded security contexts", contexts.len());
    Ok(contexts)
}

/// Remove a loaded security alert context for a session
#[tauri::command]
pub async fn remove_security_context(
    app: tauri::AppHandle,
    session_id: String,
    alert_number: u32,
    project_path: String,
) -> Result<(), String> {
    log::trace!("Removing security alert #{alert_number} context for session {session_id}");

    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    let is_orphaned = remove_security_reference(&app, &repo_key, alert_number, &session_id)?;

    if is_orphaned {
        let contexts_dir = get_github_contexts_dir(&app)?;
        let context_file = contexts_dir.join(format!("{repo_key}-security-{alert_number}.md"));

        if context_file.exists() {
            std::fs::remove_file(&context_file)
                .map_err(|e| format!("Failed to remove security context file: {e}"))?;
            log::trace!("Deleted orphaned security context file");
        }
    }

    log::trace!("Security context removed successfully");
    Ok(())
}

/// Get the content of a loaded security alert context file
#[tauri::command]
pub async fn get_security_context_content(
    app: tauri::AppHandle,
    session_id: String,
    alert_number: u32,
    project_path: String,
) -> Result<String, String> {
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    let refs = get_session_security_refs(&app, &session_id)?;
    let expected_key = format!("{repo_key}-{alert_number}");
    if !refs.contains(&expected_key) {
        return Err(format!(
            "Session does not have security alert #{alert_number} loaded"
        ));
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let context_file = contexts_dir.join(format!("{repo_key}-security-{alert_number}.md"));

    if !context_file.exists() {
        return Err(format!(
            "Security context file not found for alert #{alert_number}"
        ));
    }

    std::fs::read_to_string(&context_file)
        .map_err(|e| format!("Failed to read security context file: {e}"))
}

// =============================================================================
// Repository Security Advisory Commands
// =============================================================================

/// List repository security advisories
///
/// Uses `gh api` to fetch security advisories from the repository.
/// - state: "draft", "published", "triage", "closed", or omit for all
/// - Returns up to 100 advisories
#[tauri::command]
pub async fn list_repository_advisories(
    app: AppHandle,
    project_path: String,
    state: Option<String>,
) -> Result<Vec<RepositoryAdvisory>, String> {
    log::trace!("Listing repository advisories for {project_path} with state: {state:?}");

    let gh = resolve_gh_binary(&app);
    let repo_id = get_repo_identifier(&project_path)?;

    let mut endpoint = format!(
        "/repos/{}/{}/security-advisories?per_page=100",
        repo_id.owner, repo_id.repo
    );
    if let Some(ref s) = state {
        endpoint.push_str(&format!("&state={s}"));
    }

    let output = silent_command(&gh)
        .args(["api", &endpoint])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh api: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("not a git repository") {
            return Err("Not a git repository".to_string());
        }
        if stderr.contains("404") {
            log::debug!("Repository advisories not available for this repo, returning empty list");
            return Ok(vec![]);
        }
        if stderr.contains("403") {
            return Err("Insufficient permissions to access security advisories.".to_string());
        }
        return Err(format!("gh api failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: Vec<RepositoryAdvisoryRaw> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse advisories response: {e}"))?;

    let advisories: Vec<RepositoryAdvisory> = raw.into_iter().map(|a| a.into_frontend()).collect();

    log::trace!("Found {} repository advisories", advisories.len());
    Ok(advisories)
}

/// Get a single repository security advisory by GHSA ID
#[tauri::command]
pub async fn get_repository_advisory(
    app: AppHandle,
    project_path: String,
    ghsa_id: String,
) -> Result<RepositoryAdvisory, String> {
    let gh = resolve_gh_binary(&app);
    let repo_id = get_repo_identifier(&project_path)?;

    let endpoint = format!(
        "/repos/{}/{}/security-advisories/{ghsa_id}",
        repo_id.owner, repo_id.repo
    );

    let output = silent_command(&gh)
        .args(["api", &endpoint])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh api: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("gh auth login") || stderr.contains("authentication") {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        if stderr.contains("404") {
            return Err(format!("Advisory {ghsa_id} not found"));
        }
        return Err(format!("gh api failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: RepositoryAdvisoryRaw = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse advisory response: {e}"))?;

    Ok(raw.into_frontend())
}

/// Load/refresh advisory context for a session by fetching data from GitHub
///
/// Context is stored in shared location: `git-context/{repo_key}-advisory-{ghsa_id}.md`
/// Multiple sessions can reference the same context file.
#[tauri::command]
pub async fn load_advisory_context(
    app: tauri::AppHandle,
    session_id: String,
    ghsa_id: String,
    project_path: String,
) -> Result<LoadedAdvisoryContext, String> {
    log::trace!("Loading advisory {ghsa_id} context for session {session_id}");

    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    // Fetch advisory from GitHub
    let advisory_raw = {
        let gh = resolve_gh_binary(&app);
        let endpoint = format!(
            "/repos/{}/{}/security-advisories/{ghsa_id}",
            repo_id.owner, repo_id.repo
        );
        let output = silent_command(&gh)
            .args(["api", &endpoint])
            .current_dir(&project_path)
            .output()
            .map_err(|e| format!("Failed to run gh api: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to fetch advisory: {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<RepositoryAdvisoryRaw>(&stdout)
            .map_err(|e| format!("Failed to parse advisory: {e}"))?
    };

    let advisory = advisory_raw.into_frontend();

    let ctx = AdvisoryContext {
        ghsa_id: advisory.ghsa_id.clone(),
        severity: advisory.severity.clone(),
        summary: advisory.summary.clone(),
        description: advisory.description.clone(),
        cve_id: advisory.cve_id.clone(),
        vulnerabilities: advisory.vulnerabilities.clone(),
    };

    // Write to shared git-context directory
    let contexts_dir = get_github_contexts_dir(&app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;

    let context_file = contexts_dir.join(format!("{repo_key}-advisory-{}.md", ctx.ghsa_id));
    let context_content = format_advisory_context_markdown(&ctx);

    std::fs::write(&context_file, context_content)
        .map_err(|e| format!("Failed to write advisory context file: {e}"))?;

    add_advisory_reference(&app, &repo_key, &ctx.ghsa_id, &session_id)?;

    Ok(LoadedAdvisoryContext {
        ghsa_id: advisory.ghsa_id,
        severity: advisory.severity,
        summary: advisory.summary,
        repo_owner: repo_id.owner,
        repo_name: repo_id.repo,
    })
}

/// List all loaded advisory contexts for a session
#[tauri::command]
pub async fn list_loaded_advisory_contexts(
    app: tauri::AppHandle,
    session_id: String,
    worktree_id: Option<String>,
) -> Result<Vec<LoadedAdvisoryContext>, String> {
    log::trace!("Listing loaded advisory contexts for session {session_id}");

    let mut advisory_keys = get_session_advisory_refs(&app, &session_id)?;

    // Also check worktree_id refs (create_worktree stores refs under worktree_id)
    if let Some(ref wt_id) = worktree_id {
        if let Ok(wt_keys) = get_session_advisory_refs(&app, wt_id) {
            for key in wt_keys {
                if !advisory_keys.contains(&key) {
                    advisory_keys.push(key);
                }
            }
        }
    }

    if advisory_keys.is_empty() {
        return Ok(vec![]);
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts = Vec::new();

    for key in advisory_keys {
        if let Some((owner, repo, ghsa_id)) = parse_advisory_context_key(&key) {
            let repo_key = format!("{owner}-{repo}");
            let context_file = contexts_dir.join(format!("{repo_key}-advisory-{ghsa_id}.md"));

            if let Ok(content) = std::fs::read_to_string(&context_file) {
                // Parse from first line: "# Security Advisory GHSA-xxxx: Summary text"
                let summary = content
                    .lines()
                    .next()
                    .and_then(|line| line.strip_prefix("# Security Advisory "))
                    .and_then(|rest| rest.split_once(": "))
                    .map(|(_, title)| title.to_string())
                    .unwrap_or_else(|| format!("Advisory {ghsa_id}"));

                // Parse severity from second content line
                // "**Severity:** critical | **CVE:** CVE-2024-xxxx"
                let severity = content
                    .lines()
                    .nth(2)
                    .and_then(|line| line.split("**Severity:** ").nth(1))
                    .and_then(|s| s.split(" |").next().or(Some(s.trim())))
                    .unwrap_or("unknown")
                    .to_string();

                contexts.push(LoadedAdvisoryContext {
                    ghsa_id,
                    severity,
                    summary,
                    repo_owner: owner,
                    repo_name: repo,
                });
            }
        }
    }

    contexts.sort_by(|a, b| a.ghsa_id.cmp(&b.ghsa_id));
    log::trace!("Found {} loaded advisory contexts", contexts.len());
    Ok(contexts)
}

/// Remove a loaded advisory context for a session
#[tauri::command]
pub async fn remove_advisory_context(
    app: tauri::AppHandle,
    session_id: String,
    ghsa_id: String,
    project_path: String,
) -> Result<(), String> {
    log::trace!("Removing advisory {ghsa_id} context for session {session_id}");

    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    let is_orphaned = remove_advisory_reference(&app, &repo_key, &ghsa_id, &session_id)?;

    if is_orphaned {
        let contexts_dir = get_github_contexts_dir(&app)?;
        let context_file = contexts_dir.join(format!("{repo_key}-advisory-{ghsa_id}.md"));

        if context_file.exists() {
            std::fs::remove_file(&context_file)
                .map_err(|e| format!("Failed to remove advisory context file: {e}"))?;
            log::trace!("Deleted orphaned advisory context file");
        }
    }

    log::trace!("Advisory context removed successfully");
    Ok(())
}

/// Get the content of a loaded advisory context file
#[tauri::command]
pub async fn get_advisory_context_content(
    app: tauri::AppHandle,
    session_id: String,
    ghsa_id: String,
    project_path: String,
) -> Result<String, String> {
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    let refs = get_session_advisory_refs(&app, &session_id)?;
    let expected_key = format!("{repo_key}::{ghsa_id}");
    if !refs.contains(&expected_key) {
        return Err(format!("Session does not have advisory {ghsa_id} loaded"));
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let context_file = contexts_dir.join(format!("{repo_key}-advisory-{ghsa_id}.md"));

    if !context_file.exists() {
        return Err(format!("Advisory context file not found for {ghsa_id}"));
    }

    std::fs::read_to_string(&context_file)
        .map_err(|e| format!("Failed to read advisory context file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify_issue_title() {
        assert_eq!(
            slugify_issue_title("Fix the login bug"),
            "fix-the-login-bug"
        );
        // Apostrophe becomes space, so "can't" -> "can t" -> "can-t"
        assert_eq!(
            slugify_issue_title("Bug: can't save file"),
            "bug-can-t-save-file"
        );
        assert_eq!(slugify_issue_title("UPPERCASE Title"), "uppercase-title");
        assert_eq!(
            slugify_issue_title("Very long title that should be truncated to five words only"),
            "very-long-title-that-should"
        );
    }

    #[test]
    fn test_generate_branch_name_from_issue() {
        assert_eq!(
            generate_branch_name_from_issue(123, "Fix the login bug"),
            "issue-123-fix-the-login-bug"
        );
        assert_eq!(
            generate_branch_name_from_issue(42, "Add new feature"),
            "issue-42-add-new-feature"
        );
    }

    #[test]
    fn test_generate_branch_name_from_pr() {
        assert_eq!(
            generate_branch_name_from_pr(456, "Fix authentication"),
            "pr-456-fix-authentication"
        );
    }

    #[test]
    fn test_parse_context_key() {
        // Standard case: owner-repo-number
        assert_eq!(
            parse_context_key("owner-repo-123"),
            Some(("owner".to_string(), "repo".to_string(), 123))
        );

        // Repo with dash (splits on first dash for owner)
        assert_eq!(
            parse_context_key("owner-my-repo-456"),
            Some(("owner".to_string(), "my-repo".to_string(), 456))
        );

        // Invalid cases
        assert_eq!(parse_context_key("invalid"), None);
        assert_eq!(parse_context_key("repo-abc"), None);
        assert_eq!(parse_context_key("single"), None);
    }

    #[test]
    fn test_generate_branch_name_from_security_alert() {
        assert_eq!(
            generate_branch_name_from_security_alert(42, "lodash", "Prototype Pollution"),
            "security-42-lodash-prototype-pollution"
        );
        assert_eq!(
            generate_branch_name_from_security_alert(
                7,
                "@angular/core",
                "XSS vulnerability in template"
            ),
            "security-7-angular-core-xss-vulnerability-in-template"
        );
    }

    #[test]
    fn test_generate_branch_name_from_advisory() {
        let result = generate_branch_name_from_advisory(
            "GHSA-jg7v-5cqg-jvmf",
            "Prototype Pollution in lodash",
        );
        assert!(result.starts_with("advisory-jg7v-5cqg-jvmf-"));
        assert!(result.contains("prototype"));
    }

    #[test]
    fn test_parse_advisory_context_key() {
        assert_eq!(
            parse_advisory_context_key("owner-repo::GHSA-jg7v-5cqg-jvmf"),
            Some((
                "owner".to_string(),
                "repo".to_string(),
                "GHSA-jg7v-5cqg-jvmf".to_string()
            ))
        );

        // Invalid cases
        assert_eq!(parse_advisory_context_key("owner-repo-123"), None);
        assert_eq!(parse_advisory_context_key("invalid"), None);
    }
}
