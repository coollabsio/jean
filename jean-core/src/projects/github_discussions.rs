use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use super::git::get_repo_identifier;
use super::github_issues::{
    get_github_contexts_dir, gh_command, is_gh_cli_auth_error, load_context_references,
    parse_context_key, save_context_references, slugify_issue_title,
};
use crate::gh_cli::config::resolve_gh_binary;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDiscussionAuthor {
    pub login: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDiscussionCategory {
    pub name: String,
    #[serde(default)]
    pub emoji: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDiscussion {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub url: String,
    pub closed: bool,
    pub is_answered: bool,
    pub author: Option<GitHubDiscussionAuthor>,
    pub category: Option<GitHubDiscussionCategory>,
    pub comment_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// One page of discussions; pass `end_cursor` back as `after` for the next page
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDiscussionPage {
    pub discussions: Vec<GitHubDiscussion>,
    pub total_count: u32,
    pub end_cursor: Option<String>,
    pub has_next_page: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDiscussionDetail {
    #[serde(flatten)]
    pub discussion: GitHubDiscussion,
    pub content: String,
}

/// Discussion context passed from the frontend into create_worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionContext {
    pub number: u32,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedDiscussionContext {
    pub number: u32,
    pub title: String,
    pub comment_count: usize,
    pub repo_owner: String,
    pub repo_name: String,
}

// =============================================================================
// GraphQL response parsing (pure)
// =============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReply {
    author: Option<GitHubDiscussionAuthor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Debug, Default, Deserialize)]
struct RawReplyConnection {
    #[serde(default)]
    nodes: Vec<RawReply>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    author: Option<GitHubDiscussionAuthor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    is_answer: bool,
    #[serde(default)]
    replies: RawReplyConnection,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommentConnection {
    #[serde(default)]
    total_count: u32,
    #[serde(default)]
    nodes: Vec<RawComment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDiscussion {
    number: u32,
    title: String,
    #[serde(default)]
    body: String,
    url: String,
    closed: bool,
    is_answered: Option<bool>,
    author: Option<GitHubDiscussionAuthor>,
    category: Option<GitHubDiscussionCategory>,
    #[serde(default)]
    comments: RawCommentConnection,
    created_at: String,
    updated_at: String,
}

impl RawDiscussion {
    fn summary(&self) -> GitHubDiscussion {
        GitHubDiscussion {
            number: self.number,
            title: self.title.clone(),
            body: self.body.clone(),
            url: self.url.clone(),
            closed: self.closed,
            is_answered: self.is_answered.unwrap_or(false),
            author: self.author.clone(),
            category: self.category.clone(),
            comment_count: self.comments.total_count,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// Unwrap a GraphQL envelope into its `data` value, surfacing GraphQL errors.
fn graphql_data(stdout: &str) -> Result<serde_json::Value, String> {
    let mut value: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|e| format!("Failed to parse GitHub GraphQL response: {e}"))?;
    let data = value.get_mut("data").map(serde_json::Value::take);
    match data {
        Some(data) if !data.is_null() => Ok(data),
        _ => {
            let message = value
                .get("errors")
                .and_then(|errors| errors.as_array())
                .and_then(|errors| errors.first())
                .and_then(|error| error.get("message"))
                .and_then(|message| message.as_str())
                .unwrap_or("missing data");
            Err(format!("GitHub GraphQL error: {message}"))
        }
    }
}

fn parse_discussion_list_response(stdout: &str) -> Result<GitHubDiscussionPage, String> {
    let data = graphql_data(stdout)?;
    let repository = data
        .get("repository")
        .filter(|repo| !repo.is_null())
        .ok_or_else(|| "Repository not found".to_string())?;
    if repository.get("hasDiscussionsEnabled") == Some(&serde_json::Value::Bool(false)) {
        return Ok(GitHubDiscussionPage::default());
    }
    let connection = repository
        .get("discussions")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let nodes = connection
        .get("nodes")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let raw: Vec<RawDiscussion> =
        serde_json::from_value(nodes).map_err(|e| format!("Failed to parse discussions: {e}"))?;
    let page_info = connection.get("pageInfo");
    Ok(GitHubDiscussionPage {
        discussions: raw.iter().map(RawDiscussion::summary).collect(),
        total_count: connection
            .get("totalCount")
            .and_then(|v| v.as_u64())
            .unwrap_or_default() as u32,
        end_cursor: page_info
            .and_then(|info| info.get("endCursor"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        has_next_page: page_info
            .and_then(|info| info.get("hasNextPage"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

fn parse_discussion_search_response(stdout: &str) -> Result<Vec<GitHubDiscussion>, String> {
    let data = graphql_data(stdout)?;
    let Some(nodes) = data.pointer("/search/nodes").and_then(|n| n.as_array()) else {
        return Ok(Vec::new());
    };
    nodes
        .iter()
        .filter(|node| node.get("number").is_some())
        .map(|node| {
            serde_json::from_value::<RawDiscussion>(node.clone())
                .map(|raw| raw.summary())
                .map_err(|e| format!("Failed to parse discussion search result: {e}"))
        })
        .collect()
}

fn parse_discussion_detail_response(
    stdout: &str,
    discussion_number: u32,
) -> Result<GitHubDiscussionDetail, String> {
    let data = graphql_data(stdout)?;
    let node = data
        .pointer("/repository/discussion")
        .filter(|node| !node.is_null())
        .cloned()
        .ok_or_else(|| format!("Discussion #{discussion_number} not found"))?;
    let raw: RawDiscussion =
        serde_json::from_value(node).map_err(|e| format!("Failed to parse discussion: {e}"))?;
    Ok(GitHubDiscussionDetail {
        discussion: raw.summary(),
        content: format_discussion_markdown(&raw),
    })
}

fn author_login(author: &Option<GitHubDiscussionAuthor>) -> &str {
    author.as_ref().map_or("ghost", |a| a.login.as_str())
}

fn format_discussion_markdown(raw: &RawDiscussion) -> String {
    let mut content = format!("# GitHub Discussion #{}: {}\n\n", raw.number, raw.title);
    if let Some(category) = &raw.category {
        let label = if category.emoji.is_empty() {
            category.name.clone()
        } else {
            format!("{} {}", category.emoji, category.name)
        };
        content.push_str(&format!("**Category:** {label}\n"));
    }
    content.push_str(&format!("**Author:** @{}\n", author_login(&raw.author)));
    let status = match (raw.closed, raw.is_answered.unwrap_or(false)) {
        (true, true) => "Closed, Answered",
        (true, false) => "Closed",
        (false, true) => "Open, Answered",
        (false, false) => "Open",
    };
    content.push_str(&format!("**Status:** {status}\n"));
    content.push_str(&format!("**URL:** {}\n\n", raw.url));

    content.push_str("## Description\n\n");
    if raw.body.trim().is_empty() {
        content.push_str("*No description provided.*\n\n");
    } else {
        content.push_str(raw.body.trim());
        content.push_str("\n\n");
    }

    if !raw.comments.nodes.is_empty() {
        content.push_str("## Comments\n\n");
        for comment in &raw.comments.nodes {
            let answer = if comment.is_answer {
                " [Accepted answer]"
            } else {
                ""
            };
            content.push_str(&format!(
                "### @{} ({}){answer}\n\n{}\n\n",
                author_login(&comment.author),
                comment.created_at,
                comment.body.trim()
            ));
            for reply in &comment.replies.nodes {
                content.push_str(&format!(
                    "#### Reply from @{} ({})\n\n{}\n\n",
                    author_login(&reply.author),
                    reply.created_at,
                    reply.body.trim()
                ));
            }
        }
    }

    content.push_str("---\n\n*Investigate this discussion and propose a solution.*\n");
    content
}

/// e.g. Discussion #42 "How do I deploy?" -> "discussion-42-how-do-i-deploy"
pub fn generate_branch_name_from_discussion(discussion_number: u32, title: &str) -> String {
    let slug = slugify_issue_title(title);
    format!("discussion-{discussion_number}-{slug}")
}

// =============================================================================
// gh invocation
// =============================================================================

const DISCUSSION_FIELDS: &str = "number title body url closed isAnswered createdAt updatedAt author { login } category { name emoji }";

fn run_gh_graphql(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    string_vars: &[(&str, &str)],
    int_vars: &[(&str, u32)],
) -> Result<String, String> {
    let gh = resolve_gh_binary(app);
    let mut command = gh_command(&gh, project_path);
    command.args(["api", "graphql", "-f", &format!("query={query}")]);
    for (name, value) in string_vars {
        command.args(["-f", &format!("{name}={value}")]);
    }
    for (name, value) in int_vars {
        command.args(["-F", &format!("{name}={value}")]);
    }
    let output = command
        .output()
        .map_err(|e| format!("Failed to run gh api graphql: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if is_gh_cli_auth_error(&stderr) {
            return Err("GitHub CLI not authenticated. Run 'gh auth login' first.".to_string());
        }
        // GraphQL errors exit non-zero but still carry a JSON body with the message.
        if let Err(message) = graphql_data(&stdout) {
            if !stdout.trim().is_empty() {
                return Err(message);
            }
        }
        return Err(format!("gh api graphql failed: {stderr}"));
    }
    Ok(stdout)
}

const DISCUSSION_PAGE_SIZE: u32 = 50;

fn list_query(state: Option<&str>) -> Result<String, String> {
    let states = match state.unwrap_or("open") {
        "open" => "states: [OPEN], ",
        "closed" => "states: [CLOSED], ",
        "all" => "",
        other => return Err(format!("Invalid discussion state: {other}")),
    };
    Ok(format!(
        "query($owner: String!, $name: String!, $after: String) {{ repository(owner: $owner, name: $name) {{ hasDiscussionsEnabled discussions(first: {DISCUSSION_PAGE_SIZE}, after: $after, {states}orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ totalCount pageInfo {{ endCursor hasNextPage }} nodes {{ {DISCUSSION_FIELDS} comments {{ totalCount }} }} }} }} }}"
    ))
}

fn search_query() -> String {
    format!(
        "query($q: String!) {{ search(type: DISCUSSION, query: $q, first: 30) {{ nodes {{ ... on Discussion {{ {DISCUSSION_FIELDS} comments {{ totalCount }} }} }} }} }}"
    )
}

fn detail_query() -> String {
    format!(
        "query($owner: String!, $name: String!, $number: Int!) {{ repository(owner: $owner, name: $name) {{ discussion(number: $number) {{ {DISCUSSION_FIELDS} comments(first: 100) {{ totalCount nodes {{ author {{ login }} body createdAt isAnswer replies(first: 50) {{ nodes {{ author {{ login }} body createdAt }} }} }} }} }} }} }}"
    )
}

fn is_gitlab_project(project_path: &str) -> bool {
    crate::projects::provider::resolve_git_provider(project_path).0
        == crate::projects::provider::GitProvider::Gitlab
}

/// List one page of discussions, most recently updated first.
/// state: "open" | "closed" | "all". `after` is the previous page's end cursor.
/// Returns an empty page when the repository has discussions disabled.
pub async fn list_github_discussions(
    app: AppHandle,
    project_path: String,
    state: Option<String>,
    after: Option<String>,
) -> Result<GitHubDiscussionPage, String> {
    // GitHub Discussions have no GitLab counterpart. The tab is hidden; don't
    // call `gh` just because the repo identifier now resolves for GitLab.
    if is_gitlab_project(&project_path) {
        return Ok(GitHubDiscussionPage {
            discussions: Vec::new(),
            total_count: 0,
            end_cursor: None,
            has_next_page: false,
        });
    }

    let repo_id = get_repo_identifier(&project_path)?;
    let query = list_query(state.as_deref())?;
    let mut string_vars = vec![
        ("owner", repo_id.owner.as_str()),
        ("name", repo_id.repo.as_str()),
    ];
    if let Some(after) = after.as_deref() {
        string_vars.push(("after", after));
    }
    let stdout = run_gh_graphql(&app, &project_path, &query, &string_vars, &[])?;
    parse_discussion_list_response(&stdout)
}

pub async fn search_github_discussions(
    app: AppHandle,
    project_path: String,
    query: String,
) -> Result<Vec<GitHubDiscussion>, String> {
    if is_gitlab_project(&project_path) {
        return Ok(Vec::new());
    }

    let repo_id = get_repo_identifier(&project_path)?;
    let search = format!("repo:{}/{} {}", repo_id.owner, repo_id.repo, query.trim());
    let stdout = run_gh_graphql(&app, &project_path, &search_query(), &[("q", &search)], &[])?;
    parse_discussion_search_response(&stdout)
}

pub async fn get_github_discussion(
    app: AppHandle,
    project_path: String,
    discussion_number: u32,
) -> Result<GitHubDiscussionDetail, String> {
    if is_gitlab_project(&project_path) {
        return Err("Discussions are not available for GitLab projects.".to_string());
    }

    let repo_id = get_repo_identifier(&project_path)?;
    let stdout = run_gh_graphql(
        &app,
        &project_path,
        &detail_query(),
        &[("owner", &repo_id.owner), ("name", &repo_id.repo)],
        &[("number", discussion_number)],
    )?;
    parse_discussion_detail_response(&stdout, discussion_number)
}

// =============================================================================
// Context references and files
// =============================================================================

fn discussion_file_name(repo_key: &str, number: u32) -> String {
    format!("{repo_key}-discussion-{number}.md")
}

/// Key format: "{owner}-{repo}-{number}"
pub fn add_discussion_reference(
    app: &AppHandle,
    repo_key: &str,
    discussion_number: u32,
    session_id: &str,
) -> Result<(), String> {
    let mut refs = load_context_references(app)?;
    let entry = refs
        .discussions
        .entry(format!("{repo_key}-{discussion_number}"))
        .or_default();
    if !entry.sessions.iter().any(|s| s == session_id) {
        entry.sessions.push(session_id.to_string());
    }
    entry.orphaned_at = None;
    save_context_references(app, &refs)
}

/// Returns true if the context is now orphaned (no more references)
fn remove_discussion_reference(
    app: &AppHandle,
    repo_key: &str,
    discussion_number: u32,
    session_id: &str,
) -> Result<bool, String> {
    let mut refs = load_context_references(app)?;
    let orphaned = match refs
        .discussions
        .get_mut(&format!("{repo_key}-{discussion_number}"))
    {
        Some(entry) => {
            entry.sessions.retain(|s| s != session_id);
            let orphaned = entry.sessions.is_empty() && entry.orphaned_at.is_none();
            if orphaned {
                entry.orphaned_at = Some(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                );
            }
            orphaned
        }
        None => false,
    };
    save_context_references(app, &refs)?;
    Ok(orphaned)
}

pub fn get_session_discussion_refs(
    app: &AppHandle,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let refs = load_context_references(app)?;
    Ok(refs
        .discussions
        .iter()
        .filter(|(_, entry)| entry.sessions.iter().any(|s| s == session_id))
        .map(|(key, _)| key.clone())
        .collect())
}

/// Session refs plus worktree refs, deduplicated.
pub fn get_combined_discussion_refs(
    app: &AppHandle,
    session_id: &str,
    worktree_id: Option<&str>,
) -> Vec<String> {
    let mut keys = get_session_discussion_refs(app, session_id).unwrap_or_default();
    if let Some(worktree_id) = worktree_id.filter(|id| *id != session_id) {
        for key in get_session_discussion_refs(app, worktree_id).unwrap_or_default() {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys
}

/// Existing discussion context files for a session and its worktree.
pub fn get_discussion_context_paths(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Vec<PathBuf> {
    let Ok(contexts_dir) = get_github_contexts_dir(app) else {
        return Vec::new();
    };
    get_combined_discussion_refs(app, session_id, Some(worktree_id))
        .iter()
        .filter_map(|key| {
            let (repo_key, number) = key.rsplit_once('-')?;
            let number = number.parse::<u32>().ok()?;
            Some(contexts_dir.join(discussion_file_name(repo_key, number)))
        })
        .filter(|path| path.exists())
        .collect()
}

fn loaded_context_from_file(
    content: &str,
    number: u32,
    repo_owner: String,
    repo_name: String,
) -> LoadedDiscussionContext {
    let title = content
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("# GitHub Discussion #"))
        .and_then(|rest| rest.split_once(": "))
        .map(|(_, title)| title.to_string())
        .unwrap_or_else(|| format!("Discussion #{number}"));
    LoadedDiscussionContext {
        number,
        title,
        comment_count: content.matches("\n### @").count(),
        repo_owner,
        repo_name,
    }
}

pub async fn load_discussion_context(
    app: AppHandle,
    session_id: String,
    discussion_number: u32,
    project_path: String,
) -> Result<LoadedDiscussionContext, String> {
    let detail =
        get_github_discussion(app.clone(), project_path.clone(), discussion_number).await?;
    let repo_id = get_repo_identifier(&project_path)?;
    let repo_key = repo_id.to_key();

    let contexts_dir = get_github_contexts_dir(&app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;
    std::fs::write(
        contexts_dir.join(discussion_file_name(&repo_key, discussion_number)),
        &detail.content,
    )
    .map_err(|e| format!("Failed to write discussion context file: {e}"))?;
    add_discussion_reference(&app, &repo_key, discussion_number, &session_id)?;

    Ok(loaded_context_from_file(
        &detail.content,
        discussion_number,
        repo_id.owner,
        repo_id.repo,
    ))
}

pub async fn list_loaded_discussion_contexts(
    app: AppHandle,
    session_id: String,
    worktree_id: Option<String>,
) -> Result<Vec<LoadedDiscussionContext>, String> {
    let keys = get_combined_discussion_refs(&app, &session_id, worktree_id.as_deref());
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts: Vec<LoadedDiscussionContext> = keys
        .iter()
        .filter_map(|key| {
            let (owner, repo, number) = parse_context_key(key)?;
            let repo_key = format!("{owner}-{repo}");
            let content =
                std::fs::read_to_string(contexts_dir.join(discussion_file_name(&repo_key, number)))
                    .ok()?;
            Some(loaded_context_from_file(&content, number, owner, repo))
        })
        .collect();
    contexts.sort_by_key(|c| c.number);
    Ok(contexts)
}

pub async fn remove_discussion_context(
    app: AppHandle,
    session_id: String,
    discussion_number: u32,
    project_path: String,
) -> Result<(), String> {
    let repo_key = get_repo_identifier(&project_path)?.to_key();
    if remove_discussion_reference(&app, &repo_key, discussion_number, &session_id)? {
        let path =
            get_github_contexts_dir(&app)?.join(discussion_file_name(&repo_key, discussion_number));
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("Failed to remove discussion context file: {e}"))?;
        }
    }
    Ok(())
}

/// Reads the shared context file. The contract carries no worktree id, so a
/// discussion attached to the worktree (not the session) must still be readable.
pub async fn get_discussion_context_content(
    app: AppHandle,
    _session_id: String,
    discussion_number: u32,
    project_path: String,
) -> Result<String, String> {
    let repo_key = get_repo_identifier(&project_path)?.to_key();
    let path =
        get_github_contexts_dir(&app)?.join(discussion_file_name(&repo_key, discussion_number));
    std::fs::read_to_string(&path).map_err(|_| {
        format!("Discussion context file not found for discussion #{discussion_number}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_parses_nodes_with_null_is_answered_and_missing_author_category() {
        let stdout = r#"{"data":{"repository":{"hasDiscussionsEnabled":true,"discussions":{"totalCount":120,"pageInfo":{"endCursor":"Y3Vyc29yOjUw","hasNextPage":true},"nodes":[
            {"number":7,"title":"Q","body":"b","url":"https://github.com/o/r/discussions/7","closed":false,"isAnswered":true,
             "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","author":{"login":"alice"},
             "category":{"name":"Q&A","emoji":":pray:"},"comments":{"totalCount":4}},
            {"number":8,"title":"Idea","body":"","url":"https://github.com/o/r/discussions/8","closed":true,"isAnswered":null,
             "createdAt":"2026-01-03T00:00:00Z","updatedAt":"2026-01-04T00:00:00Z","author":null,"category":null,"comments":{"totalCount":0}}
        ]}}}}"#;

        let page = parse_discussion_list_response(stdout).unwrap();

        assert_eq!(page.total_count, 120);
        assert_eq!(page.end_cursor.as_deref(), Some("Y3Vyc29yOjUw"));
        assert!(page.has_next_page);
        assert_eq!(
            page.discussions,
            vec![
                GitHubDiscussion {
                    number: 7,
                    title: "Q".into(),
                    body: "b".into(),
                    url: "https://github.com/o/r/discussions/7".into(),
                    closed: false,
                    is_answered: true,
                    author: Some(GitHubDiscussionAuthor {
                        login: "alice".into()
                    }),
                    category: Some(GitHubDiscussionCategory {
                        name: "Q&A".into(),
                        emoji: ":pray:".into()
                    }),
                    comment_count: 4,
                    created_at: "2026-01-01T00:00:00Z".into(),
                    updated_at: "2026-01-02T00:00:00Z".into(),
                },
                GitHubDiscussion {
                    number: 8,
                    title: "Idea".into(),
                    body: "".into(),
                    url: "https://github.com/o/r/discussions/8".into(),
                    closed: true,
                    is_answered: false,
                    author: None,
                    category: None,
                    comment_count: 0,
                    created_at: "2026-01-03T00:00:00Z".into(),
                    updated_at: "2026-01-04T00:00:00Z".into(),
                },
            ]
        );
    }

    #[test]
    fn list_returns_empty_when_discussions_disabled() {
        let stdout =
            r#"{"data":{"repository":{"hasDiscussionsEnabled":false,"discussions":{"nodes":[]}}}}"#;
        assert_eq!(
            parse_discussion_list_response(stdout).unwrap(),
            GitHubDiscussionPage::default()
        );
    }

    #[test]
    fn list_surfaces_graphql_errors() {
        let stdout = r#"{"data":null,"errors":[{"message":"Could not resolve to a Repository"}]}"#;
        assert_eq!(
            parse_discussion_list_response(stdout).unwrap_err(),
            "GitHub GraphQL error: Could not resolve to a Repository"
        );
    }

    #[test]
    fn search_skips_non_discussion_nodes() {
        let stdout = r#"{"data":{"search":{"nodes":[{},
            {"number":3,"title":"T","body":"x","url":"u","closed":false,"isAnswered":null,
             "createdAt":"c","updatedAt":"d","author":{"login":"bob"},"category":{"name":"General","emoji":":speech_balloon:"},"comments":{"totalCount":1}}]}}}"#;

        let discussions = parse_discussion_search_response(stdout).unwrap();

        assert_eq!(discussions.len(), 1);
        assert_eq!(discussions[0].number, 3);
        assert!(!discussions[0].is_answered);
        assert_eq!(discussions[0].comment_count, 1);
    }

    #[test]
    fn detail_formats_accepted_answer_and_replies() {
        let stdout = r#"{"data":{"repository":{"discussion":{
            "number":42,"title":"How to deploy?","body":"Steps please.\r\n","url":"https://github.com/o/r/discussions/42",
            "closed":false,"isAnswered":true,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-05T00:00:00Z",
            "author":{"login":"asker"},"category":{"name":"Q&A","emoji":":pray:"},
            "comments":{"totalCount":2,"nodes":[
                {"author":{"login":"helper"},"body":"Use docker.","createdAt":"2026-01-02T00:00:00Z","isAnswer":true,
                 "replies":{"nodes":[{"author":{"login":"asker"},"body":"Thanks!","createdAt":"2026-01-03T00:00:00Z"}]}},
                {"author":null,"body":"Me too","createdAt":"2026-01-04T00:00:00Z","isAnswer":false,"replies":{"nodes":[]}}
            ]}}}}}"#;

        let detail = parse_discussion_detail_response(stdout, 42).unwrap();

        assert_eq!(detail.discussion.comment_count, 2);
        assert!(detail.discussion.is_answered);
        assert_eq!(
            detail.content,
            "# GitHub Discussion #42: How to deploy?\n\n\
**Category:** :pray: Q&A\n\
**Author:** @asker\n\
**Status:** Open, Answered\n\
**URL:** https://github.com/o/r/discussions/42\n\n\
## Description\n\nSteps please.\n\n\
## Comments\n\n\
### @helper (2026-01-02T00:00:00Z) [Accepted answer]\n\nUse docker.\n\n\
#### Reply from @asker (2026-01-03T00:00:00Z)\n\nThanks!\n\n\
### @ghost (2026-01-04T00:00:00Z)\n\nMe too\n\n\
---\n\n*Investigate this discussion and propose a solution.*\n"
        );

        let loaded = loaded_context_from_file(&detail.content, 42, "o".into(), "r".into());
        assert_eq!(loaded.title, "How to deploy?");
        assert_eq!(loaded.comment_count, 2);
    }

    #[test]
    fn detail_reports_missing_discussion() {
        let stdout = r#"{"data":{"repository":{"discussion":null}}}"#;
        assert_eq!(
            parse_discussion_detail_response(stdout, 9).unwrap_err(),
            "Discussion #9 not found"
        );
    }

    #[test]
    fn detail_serializes_flattened_camel_case() {
        let stdout = r#"{"data":{"repository":{"discussion":{"number":1,"title":"t","body":"","url":"u","closed":false,
            "isAnswered":null,"createdAt":"c","updatedAt":"d","author":null,"category":null,"comments":{"totalCount":0,"nodes":[]}}}}}"#;
        let json =
            serde_json::to_value(parse_discussion_detail_response(stdout, 1).unwrap()).unwrap();
        assert_eq!(json["number"], 1);
        assert_eq!(json["isAnswered"], false);
        assert_eq!(json["commentCount"], 0);
        assert!(json["content"]
            .as_str()
            .unwrap()
            .starts_with("# GitHub Discussion #1: t"));
    }

    #[test]
    fn branch_name_uses_discussion_prefix() {
        assert_eq!(
            generate_branch_name_from_discussion(42, "How do I deploy?"),
            "discussion-42-how-do-i-deploy"
        );
    }
}
