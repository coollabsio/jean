use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::github_issues::{
    get_github_contexts_dir, load_context_references, save_context_references, slugify_issue_title,
    IssueContext,
};
use super::storage::load_projects_data;

// =============================================================================
// Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueState {
    pub name: String,
    #[serde(rename = "type")]
    pub state_type: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearUser {
    pub name: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub state: LinearIssueState,
    #[serde(default)]
    pub labels: Vec<LinearLabel>,
    pub assignee: Option<LinearUser>,
    pub created_at: String,
    pub url: String,
    pub priority: u32,
    pub priority_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearComment {
    pub body: String,
    pub user: Option<LinearUser>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueDetail {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub state: LinearIssueState,
    #[serde(default)]
    pub labels: Vec<LinearLabel>,
    pub assignee: Option<LinearUser>,
    pub created_at: String,
    pub url: String,
    pub priority: u32,
    pub priority_label: String,
    pub comments: Vec<LinearComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueListResult {
    pub issues: Vec<LinearIssue>,
}

/// Context for creating a worktree from a Linear issue (passed from frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueContext {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub comments: Vec<LinearComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedLinearIssueContext {
    pub identifier: String,
    pub title: String,
    pub comment_count: usize,
    pub project_name: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeam {
    pub id: String,
    pub name: String,
    pub key: String,
}

// =============================================================================
// GraphQL Client
// =============================================================================

const LINEAR_API_URL: &str = "https://api.linear.app/graphql";

async fn linear_graphql(
    api_key: &str,
    query: &str,
    variables: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let mut body = serde_json::json!({ "query": query });
    if let Some(vars) = variables {
        body["variables"] = vars;
    }

    let response = client
        .post(LINEAR_API_URL)
        .header("Authorization", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Linear API request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.as_u16() == 401 {
            return Err("Linear API key is invalid. Update it in project settings.".to_string());
        }
        return Err(format!("Linear API error ({status}): {text}"));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Linear response: {e}"))?;

    if let Some(errors) = json.get("errors") {
        return Err(format!("Linear GraphQL errors: {errors}"));
    }

    Ok(json)
}

// =============================================================================
// Helpers
// =============================================================================

/// Extract numeric part from Linear identifier (e.g., "ENG-123" → 123)
pub fn parse_linear_identifier_number(identifier: &str) -> u32 {
    identifier
        .rsplit_once('-')
        .and_then(|(_, num)| num.parse::<u32>().ok())
        .unwrap_or(0)
}

/// Generate branch name from Linear issue identifier and title
pub fn generate_branch_name_from_linear_issue(identifier: &str, title: &str) -> String {
    let slug = slugify_issue_title(title);
    let id = identifier.to_lowercase();
    format!("linear-{id}-{slug}")
}

/// Convert a LinearIssueDetail to the shared IssueContext for create_worktree
pub fn linear_issue_to_issue_context(detail: &LinearIssueDetail) -> IssueContext {
    use super::github_issues::GitHubComment;

    let comments = detail
        .comments
        .iter()
        .map(|c| GitHubComment {
            body: c.body.clone(),
            author: super::github_issues::GitHubAuthor {
                login: c
                    .user
                    .as_ref()
                    .map(|u| u.display_name.clone())
                    .unwrap_or_else(|| "Unknown".to_string()),
            },
            created_at: c.created_at.clone(),
        })
        .collect();

    IssueContext {
        number: parse_linear_identifier_number(&detail.identifier),
        title: detail.title.clone(),
        body: detail.description.clone(),
        comments,
    }
}

/// Format a Linear issue as markdown context
pub fn format_linear_issue_context_markdown(detail: &LinearIssueDetail) -> String {
    let mut content = String::new();

    content.push_str(&format!(
        "# Linear Issue {}: {}\n\n",
        detail.identifier, detail.title
    ));

    content.push_str(&format!("- **Status**: {}\n", detail.state.name));
    content.push_str(&format!("- **Priority**: {}\n", detail.priority_label));

    if !detail.labels.is_empty() {
        let labels: Vec<&str> = detail.labels.iter().map(|l| l.name.as_str()).collect();
        content.push_str(&format!("- **Labels**: {}\n", labels.join(", ")));
    }

    if let Some(assignee) = &detail.assignee {
        content.push_str(&format!("- **Assignee**: {}\n", assignee.display_name));
    }

    content.push_str(&format!("- **URL**: {}\n", detail.url));

    content.push_str("\n---\n\n");

    content.push_str("## Description\n\n");
    if let Some(desc) = &detail.description {
        if !desc.is_empty() {
            content.push_str(desc);
        } else {
            content.push_str("*No description provided.*");
        }
    } else {
        content.push_str("*No description provided.*");
    }
    content.push_str("\n\n");

    if !detail.comments.is_empty() {
        content.push_str("## Comments\n\n");
        for comment in &detail.comments {
            let author = comment
                .user
                .as_ref()
                .map(|u| u.display_name.as_str())
                .unwrap_or("Unknown");
            content.push_str(&format!("### {} ({})\n\n", author, comment.created_at));
            content.push_str(&comment.body);
            content.push_str("\n\n---\n\n");
        }
    }

    content.push_str("---\n\n");
    content.push_str("*Investigate this issue and propose a solution.*\n");

    content
}

/// Linear config resolved from project + global preferences.
struct LinearConfig {
    api_key: String,
    project_name: String,
    team_id: Option<String>,
}

/// Get the Linear config for a project, falling back to global preferences for the API key.
fn get_linear_config(app: &AppHandle, project_id: &str) -> Result<LinearConfig, String> {
    let data = load_projects_data(app)?;
    let project = data
        .find_project(project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    let team_id = project.linear_team_id.clone().filter(|t| !t.is_empty());
    let project_name = project.name.clone();

    // 1. Check project-level key first
    if let Some(key) = project.linear_api_key.as_ref().filter(|k| !k.is_empty()) {
        return Ok(LinearConfig {
            api_key: key.clone(),
            project_name,
            team_id,
        });
    }

    // 2. Fall back to global key from AppPreferences
    let prefs = crate::load_preferences_sync(app)?;
    if let Some(key) = prefs.linear_api_key.as_ref().filter(|k| !k.is_empty()) {
        return Ok(LinearConfig {
            api_key: key.clone(),
            project_name,
            team_id,
        });
    }

    Err("No Linear API key configured. Add one in Settings → Integrations, or override per-project.".to_string())
}

/// Parse a GraphQL response node into a LinearIssue
fn parse_issue_node(node: &serde_json::Value) -> Option<LinearIssue> {
    let state = node.get("state")?;
    let labels_nodes = node
        .get("labels")
        .and_then(|l| l.get("nodes"))
        .and_then(|n| n.as_array())
        .cloned()
        .unwrap_or_default();

    let labels: Vec<LinearLabel> = labels_nodes
        .iter()
        .filter_map(|l| {
            Some(LinearLabel {
                name: l.get("name")?.as_str()?.to_string(),
                color: l.get("color")?.as_str()?.to_string(),
            })
        })
        .collect();

    let assignee = node.get("assignee").and_then(|a| {
        if a.is_null() {
            None
        } else {
            Some(LinearUser {
                name: a.get("name")?.as_str()?.to_string(),
                display_name: a.get("displayName")?.as_str()?.to_string(),
            })
        }
    });

    Some(LinearIssue {
        id: node.get("id")?.as_str()?.to_string(),
        identifier: node.get("identifier")?.as_str()?.to_string(),
        title: node.get("title")?.as_str()?.to_string(),
        description: node
            .get("description")
            .and_then(|d| d.as_str())
            .map(|s| s.to_string()),
        state: LinearIssueState {
            name: state.get("name")?.as_str()?.to_string(),
            state_type: state.get("type")?.as_str()?.to_string(),
            color: state.get("color")?.as_str()?.to_string(),
        },
        labels,
        assignee,
        created_at: node.get("createdAt")?.as_str()?.to_string(),
        url: node.get("url")?.as_str()?.to_string(),
        priority: node.get("priority")?.as_u64()? as u32,
        priority_label: node
            .get("priorityLabel")
            .and_then(|p| p.as_str())
            .unwrap_or("No priority")
            .to_string(),
    })
}

// =============================================================================
// GraphQL Queries
// =============================================================================

const ISSUE_FIELDS: &str = r#"
            id
            identifier
            title
            description
            state { name type color }
            labels { nodes { name color } }
            assignee { name displayName }
            createdAt
            url
            priority
            priorityLabel
"#;

/// Build list issues query, optionally filtering by team.
fn build_list_issues_query(team_id: Option<&str>) -> String {
    let team_filter = match team_id {
        Some(_) => r#", team: { id: { eq: $teamId } }"#,
        None => "",
    };
    let vars = match team_id {
        Some(_) => "($teamId: ID!)",
        None => "",
    };
    format!(
        r#"query ListIssues{vars} {{
    issues(
        filter: {{
            state: {{ type: {{ in: ["started", "unstarted", "backlog", "triage"] }} }}{team_filter}
        }}
        orderBy: updatedAt
        first: 100
    ) {{
        nodes {{{ISSUE_FIELDS}
        }}
    }}
}}"#
    )
}

/// Build search issues query, optionally filtering by team.
fn build_search_issues_query(team_id: Option<&str>) -> String {
    let team_filter = match team_id {
        Some(_) => r#", team: { id: { eq: $teamId } }"#,
        None => "",
    };
    let vars = match team_id {
        Some(_) => "($query: String!, $teamId: ID!)",
        None => "($query: String!)",
    };
    format!(
        r#"query SearchIssues{vars} {{
    issueSearch(query: $query, first: 50, filter: {{
        state: {{ type: {{ in: ["started", "unstarted", "backlog", "triage"] }} }}{team_filter}
    }}) {{
        nodes {{{ISSUE_FIELDS}
        }}
    }}
}}"#
    )
}

const LIST_TEAMS_QUERY: &str = r#"
query ListTeams {
    teams(first: 250) {
        nodes {
            id
            name
            key
        }
    }
}
"#;

/// Build get-issue-by-number query, optionally filtering by team.
fn build_issue_by_number_query(team_id: Option<&str>) -> String {
    let team_filter = match team_id {
        Some(_) => r#", team: { id: { eq: $teamId } }"#,
        None => "",
    };
    let vars = match team_id {
        Some(_) => "($number: Float!, $teamId: ID!)",
        None => "($number: Float!)",
    };
    format!(
        r#"query GetIssueByNumber{vars} {{
    issues(
        filter: {{
            number: {{ eq: $number }}{team_filter}
        }}
        first: 1
    ) {{
        nodes {{{ISSUE_FIELDS}
        }}
    }}
}}"#
    )
}

const GET_ISSUE_QUERY: &str = r#"
query GetIssue($id: String!) {
    issue(id: $id) {
        id
        identifier
        title
        description
        state { name type color }
        labels { nodes { name color } }
        assignee { name displayName }
        createdAt
        url
        priority
        priorityLabel
        comments {
            nodes {
                body
                user { name displayName }
                createdAt
            }
        }
    }
}
"#;

// =============================================================================
// Tauri Commands
// =============================================================================

/// List Linear teams for a project
#[tauri::command]
pub async fn list_linear_teams(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<LinearTeam>, String> {
    log::info!("Listing Linear teams for project {project_id}");

    let config = get_linear_config(&app, &project_id)?;
    log::info!(
        "Linear config resolved: api_key_len={}, project={}",
        config.api_key.len(),
        config.project_name
    );

    let response = linear_graphql(&config.api_key, LIST_TEAMS_QUERY, None).await?;
    log::info!("Linear teams raw response: {response}");

    let nodes = response
        .get("data")
        .and_then(|d| d.get("teams"))
        .and_then(|t| t.get("nodes"))
        .and_then(|n| n.as_array())
        .ok_or("Unexpected Linear API response format")?;

    log::info!("Linear teams raw nodes count: {}", nodes.len());

    let teams: Vec<LinearTeam> = nodes
        .iter()
        .filter_map(|node| {
            let team = LinearTeam {
                id: node.get("id")?.as_str()?.to_string(),
                name: node.get("name")?.as_str()?.to_string(),
                key: node.get("key")?.as_str()?.to_string(),
            };
            log::info!("Parsed team: {} ({}) [{}]", team.name, team.key, team.id);
            Some(team)
        })
        .collect();

    log::info!("Found {} Linear teams total", teams.len());
    Ok(teams)
}

/// List Linear issues for a project (active states only)
#[tauri::command]
pub async fn list_linear_issues(
    app: AppHandle,
    project_id: String,
) -> Result<LinearIssueListResult, String> {
    log::trace!("Listing Linear issues for project {project_id}");

    let config = get_linear_config(&app, &project_id)?;
    let query = build_list_issues_query(config.team_id.as_deref());
    let variables = config.team_id.map(|id| serde_json::json!({ "teamId": id }));

    let response = linear_graphql(&config.api_key, &query, variables).await?;

    let nodes = response
        .get("data")
        .and_then(|d| d.get("issues"))
        .and_then(|i| i.get("nodes"))
        .and_then(|n| n.as_array())
        .ok_or("Unexpected Linear API response format")?;

    let issues: Vec<LinearIssue> = nodes.iter().filter_map(parse_issue_node).collect();

    log::trace!("Found {} Linear issues", issues.len());
    Ok(LinearIssueListResult { issues })
}

/// Search Linear issues
#[tauri::command]
pub async fn search_linear_issues(
    app: AppHandle,
    project_id: String,
    query: String,
) -> Result<Vec<LinearIssue>, String> {
    log::trace!("Searching Linear issues for project {project_id}: {query}");

    let config = get_linear_config(&app, &project_id)?;
    let gql_query = build_search_issues_query(config.team_id.as_deref());
    let mut variables = serde_json::json!({ "query": query });
    if let Some(team_id) = &config.team_id {
        variables["teamId"] = serde_json::json!(team_id);
    }
    let response = linear_graphql(&config.api_key, &gql_query, Some(variables)).await?;

    let nodes = response
        .get("data")
        .and_then(|d| d.get("issueSearch"))
        .and_then(|i| i.get("nodes"))
        .and_then(|n| n.as_array())
        .ok_or("Unexpected Linear search response format")?;

    let issues: Vec<LinearIssue> = nodes.iter().filter_map(parse_issue_node).collect();

    log::trace!("Search returned {} Linear issues", issues.len());
    Ok(issues)
}

/// Get a single Linear issue with comments
#[tauri::command]
pub async fn get_linear_issue(
    app: AppHandle,
    project_id: String,
    issue_id: String,
) -> Result<LinearIssueDetail, String> {
    log::trace!("Getting Linear issue {issue_id} for project {project_id}");

    let config = get_linear_config(&app, &project_id)?;

    let variables = serde_json::json!({ "id": issue_id });
    let response = linear_graphql(&config.api_key, GET_ISSUE_QUERY, Some(variables)).await?;

    let node = response
        .get("data")
        .and_then(|d| d.get("issue"))
        .ok_or("Issue not found")?;

    let base = parse_issue_node(node).ok_or("Failed to parse Linear issue")?;

    let comment_nodes = node
        .get("comments")
        .and_then(|c| c.get("nodes"))
        .and_then(|n| n.as_array())
        .cloned()
        .unwrap_or_default();

    let comments: Vec<LinearComment> = comment_nodes
        .iter()
        .filter_map(|c| {
            Some(LinearComment {
                body: c.get("body")?.as_str()?.to_string(),
                user: c.get("user").and_then(|u| {
                    if u.is_null() {
                        None
                    } else {
                        Some(LinearUser {
                            name: u.get("name")?.as_str()?.to_string(),
                            display_name: u.get("displayName")?.as_str()?.to_string(),
                        })
                    }
                }),
                created_at: c.get("createdAt")?.as_str()?.to_string(),
            })
        })
        .collect();

    Ok(LinearIssueDetail {
        id: base.id,
        identifier: base.identifier,
        title: base.title,
        description: base.description,
        state: base.state,
        labels: base.labels,
        assignee: base.assignee,
        created_at: base.created_at,
        url: base.url,
        priority: base.priority,
        priority_label: base.priority_label,
        comments,
    })
}

/// Get a single Linear issue by its number (e.g., #12 → ENG-12)
#[tauri::command]
pub async fn get_linear_issue_by_number(
    app: AppHandle,
    project_id: String,
    issue_number: i64,
) -> Result<Option<LinearIssue>, String> {
    log::trace!("Getting Linear issue #{issue_number} for project {project_id}");

    let config = get_linear_config(&app, &project_id)?;
    let query = build_issue_by_number_query(config.team_id.as_deref());
    let mut variables = serde_json::json!({ "number": issue_number });
    if let Some(team_id) = &config.team_id {
        variables["teamId"] = serde_json::json!(team_id);
    }

    let response = linear_graphql(&config.api_key, &query, Some(variables)).await?;

    let nodes = response
        .get("data")
        .and_then(|d| d.get("issues"))
        .and_then(|i| i.get("nodes"))
        .and_then(|n| n.as_array())
        .ok_or("Unexpected Linear API response format")?;

    Ok(nodes.first().and_then(parse_issue_node))
}

/// Load/refresh Linear issue context for a session
#[tauri::command]
pub async fn load_linear_issue_context(
    app: AppHandle,
    session_id: String,
    project_id: String,
    issue_id: String,
) -> Result<LoadedLinearIssueContext, String> {
    log::trace!("Loading Linear issue {issue_id} context for session {session_id}");

    let config = get_linear_config(&app, &project_id)?;
    let project_name = config.project_name;

    let detail = get_linear_issue(app.clone(), project_id, issue_id).await?;

    // Write to shared git-context directory
    let contexts_dir = get_github_contexts_dir(&app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;

    let identifier_lower = detail.identifier.to_lowercase();
    let context_file = contexts_dir.join(format!("{project_name}-linear-{identifier_lower}.md"));
    let context_content = format_linear_issue_context_markdown(&detail);

    std::fs::write(&context_file, context_content)
        .map_err(|e| format!("Failed to write Linear issue context file: {e}"))?;

    // Add reference tracking
    add_linear_reference(&app, &project_name, &detail.identifier, &session_id)?;

    let comment_count = detail.comments.len();
    log::trace!(
        "Linear issue context loaded for {} ({comment_count} comments)",
        detail.identifier
    );

    Ok(LoadedLinearIssueContext {
        identifier: detail.identifier,
        title: detail.title,
        comment_count,
        project_name,
        url: Some(detail.url.clone()),
    })
}

/// List all loaded Linear issue contexts for a session
#[tauri::command]
pub async fn list_loaded_linear_issue_contexts(
    app: AppHandle,
    session_id: String,
    worktree_id: Option<String>,
    project_id: String,
) -> Result<Vec<LoadedLinearIssueContext>, String> {
    log::trace!("Listing loaded Linear issue contexts for session {session_id}");

    let config = get_linear_config(&app, &project_id)?;
    let project_name = config.project_name;

    let mut keys = get_session_linear_refs(&app, &session_id)?;

    if let Some(ref wt_id) = worktree_id {
        if let Ok(wt_keys) = get_session_linear_refs(&app, wt_id) {
            for key in wt_keys {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
    }

    if keys.is_empty() {
        return Ok(vec![]);
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contexts = Vec::new();

    for key in keys {
        // Key format: "{project_name}-{identifier}"
        if let Some(identifier) = key.strip_prefix(&format!("{project_name}-")) {
            let context_file = contexts_dir.join(format!(
                "{project_name}-linear-{}.md",
                identifier.to_lowercase()
            ));

            if let Ok(content) = std::fs::read_to_string(&context_file) {
                let title = content
                    .lines()
                    .next()
                    .and_then(|line| {
                        line.strip_prefix("# Linear Issue ")
                            .and_then(|rest| rest.split_once(": "))
                            .map(|(_, title)| title.to_string())
                    })
                    .unwrap_or_else(|| format!("Issue {identifier}"));

                let comment_count = content
                    .split("## Comments")
                    .nth(1)
                    .map(|section| section.lines().filter(|l| l.starts_with("### ")).count())
                    .unwrap_or(0);

                let url = content
                    .lines()
                    .find(|l| l.starts_with("- **URL**: "))
                    .and_then(|l| l.strip_prefix("- **URL**: "))
                    .map(|s| s.to_string());

                contexts.push(LoadedLinearIssueContext {
                    identifier: identifier.to_string(),
                    title,
                    comment_count,
                    project_name: project_name.clone(),
                    url,
                });
            }
        }
    }

    Ok(contexts)
}

/// Content of a loaded Linear issue context file
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueContextContent {
    pub identifier: String,
    pub title: String,
    pub content: String,
}

/// Return the full markdown content of each loaded Linear issue context file.
/// Used to embed context directly into investigation prompts (Claude CLI cannot access Linear API).
#[tauri::command]
pub async fn get_linear_issue_context_contents(
    app: AppHandle,
    session_id: String,
    worktree_id: Option<String>,
    project_id: String,
) -> Result<Vec<LinearIssueContextContent>, String> {
    log::trace!("Getting Linear issue context contents for session {session_id}");

    let config = get_linear_config(&app, &project_id)?;
    let project_name = config.project_name;

    let mut keys = get_session_linear_refs(&app, &session_id)?;

    if let Some(ref wt_id) = worktree_id {
        if let Ok(wt_keys) = get_session_linear_refs(&app, wt_id) {
            for key in wt_keys {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
    }

    if keys.is_empty() {
        return Ok(vec![]);
    }

    let contexts_dir = get_github_contexts_dir(&app)?;
    let mut contents = Vec::new();

    for key in keys {
        // Key format: "{project_name}-{identifier}"
        if let Some(identifier) = key.strip_prefix(&format!("{project_name}-")) {
            let context_file = contexts_dir.join(format!(
                "{project_name}-linear-{}.md",
                identifier.to_lowercase()
            ));

            if let Ok(content) = std::fs::read_to_string(&context_file) {
                let title = content
                    .lines()
                    .next()
                    .and_then(|line| {
                        line.strip_prefix("# Linear Issue ")
                            .and_then(|rest| rest.split_once(": "))
                            .map(|(_, title)| title.to_string())
                    })
                    .unwrap_or_else(|| format!("Issue {identifier}"));

                contents.push(LinearIssueContextContent {
                    identifier: identifier.to_string(),
                    title,
                    content,
                });
            }
        }
    }

    Ok(contents)
}

/// Remove a loaded Linear issue context from a session
#[tauri::command]
pub async fn remove_linear_issue_context(
    app: AppHandle,
    session_id: String,
    project_id: String,
    identifier: String,
) -> Result<(), String> {
    log::trace!("Removing Linear issue {identifier} context for session {session_id}");

    let config = get_linear_config(&app, &project_id)?;
    let project_name = config.project_name;

    let orphaned = remove_linear_reference(&app, &project_name, &identifier, &session_id)?;

    if orphaned {
        // Delete the context file if no more references
        let contexts_dir = get_github_contexts_dir(&app)?;
        let identifier_lower = identifier.to_lowercase();
        let context_file =
            contexts_dir.join(format!("{project_name}-linear-{identifier_lower}.md"));
        if context_file.exists() {
            let _ = std::fs::remove_file(&context_file);
        }
    }

    Ok(())
}

// =============================================================================
// Context Reference Tracking
// =============================================================================

/// Add a Linear issue reference for a session
/// Key format: "{project_name}-{identifier}"
pub fn add_linear_reference(
    app: &AppHandle,
    project_name: &str,
    identifier: &str,
    session_id: &str,
) -> Result<(), String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{project_name}-{identifier}");

    let entry = refs.linear.entry(key).or_default();
    if !entry.sessions.contains(&session_id.to_string()) {
        entry.sessions.push(session_id.to_string());
    }
    entry.orphaned_at = None;

    save_context_references(app, &refs)
}

/// Remove a Linear issue reference for a session
pub fn remove_linear_reference(
    app: &AppHandle,
    project_name: &str,
    identifier: &str,
    session_id: &str,
) -> Result<bool, String> {
    let mut refs = load_context_references(app)?;
    let key = format!("{project_name}-{identifier}");

    let orphaned = if let Some(entry) = refs.linear.get_mut(&key) {
        entry.sessions.retain(|s| s != session_id);
        if entry.sessions.is_empty() && entry.orphaned_at.is_none() {
            entry.orphaned_at = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
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

/// Get all Linear issue keys referenced by a session
pub fn get_session_linear_refs(app: &AppHandle, session_id: &str) -> Result<Vec<String>, String> {
    let refs = load_context_references(app)?;
    Ok(refs
        .linear
        .iter()
        .filter(|(_, entry)| entry.sessions.contains(&session_id.to_string()))
        .map(|(key, _)| key.clone())
        .collect())
}

/// Get Linear issue identifiers (e.g. "ENG-123") referenced by a session, filtered by project name.
pub fn get_session_linear_identifiers(
    app: &AppHandle,
    session_id: &str,
    project_name: &str,
) -> Result<Vec<String>, String> {
    let keys = get_session_linear_refs(app, session_id)?;
    let prefix = format!("{project_name}-");
    Ok(keys
        .into_iter()
        .filter_map(|key| key.strip_prefix(&prefix).map(|id| id.to_string()))
        .collect())
}

/// Convert a LinearIssueContext into a LinearIssueDetail for formatting
pub fn linear_context_to_detail(ctx: &LinearIssueContext) -> LinearIssueDetail {
    LinearIssueDetail {
        id: ctx.id.clone(),
        identifier: ctx.identifier.clone(),
        title: ctx.title.clone(),
        description: ctx.description.clone(),
        state: LinearIssueState {
            name: "Unknown".to_string(),
            state_type: "started".to_string(),
            color: "#000000".to_string(),
        },
        labels: vec![],
        assignee: None,
        created_at: String::new(),
        url: String::new(),
        priority: 0,
        priority_label: "No priority".to_string(),
        comments: ctx.comments.clone(),
    }
}
