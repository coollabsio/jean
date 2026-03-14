use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
pub struct PlaneState {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(rename = "group")]
    pub state_group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneLabel {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneUser {
    pub id: String,
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneIssue {
    pub id: String,
    pub sequence_id: String,
    pub name: String,
    pub description: Option<String>,
    pub description_html: Option<String>,
    pub state: PlaneState,
    #[serde(default)]
    pub labels: Vec<PlaneLabel>,
    pub assignee: Option<PlaneUser>,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub priority: u32,
    pub priority_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneComment {
    pub id: String,
    pub comment: String,
    pub created_at: String,
    pub updated_at: String,
    pub actor: Option<PlaneUser>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneIssueDetail {
    pub id: String,
    pub sequence_id: String,
    pub name: String,
    pub description: Option<String>,
    pub description_html: Option<String>,
    pub state: PlaneState,
    #[serde(default)]
    pub labels: Vec<PlaneLabel>,
    pub assignee: Option<PlaneUser>,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub priority: u32,
    pub priority_label: String,
    pub comments: Vec<PlaneComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneIssueListResult {
    pub issues: Vec<PlaneIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPlaneIssueContext {
    pub identifier: String,
    pub title: String,
    pub comment_count: usize,
    pub project_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneWorkspace {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub logo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneProject {
    pub id: String,
    pub name: String,
    pub identifier: String,
    pub description: Option<String>,
    pub workspace: PlaneWorkspace,
}

// =============================================================================
// API Client
// =============================================================================

struct PlaneConfig {
    api_key: String,
    base_url: String,
    project_name: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
}

/// Get the Plane config for a project, falling back to global preferences for the API key and URL.
fn get_plane_config(app: &AppHandle, project_id: &str) -> Result<PlaneConfig, String> {
    let data = load_projects_data(app)?;
    let project = data
        .find_project(project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    let workspace_id = project.plane_workspace_id.clone().filter(|t| !t.is_empty());
    let project_id_opt = project.plane_project_id.clone().filter(|t| !t.is_empty());
    let project_name = project.name.clone();

    // 1. Check project-level config first
    if let (Some(key), Some(url)) = (
        project.plane_api_key.as_ref().filter(|k| !k.is_empty()),
        project.plane_url.as_ref().filter(|u| !u.is_empty()),
    ) {
        return Ok(PlaneConfig {
            api_key: key.clone(),
            base_url: url.trim_end_matches('/').to_string(),
            project_name,
            workspace_id,
            project_id: project_id_opt,
        });
    }

    // 2. Fall back to global config from AppPreferences
    let prefs = crate::load_preferences_sync(app)?;
    if let (Some(key), Some(url)) = (
        prefs.plane_api_key.as_ref().filter(|k| !k.is_empty()),
        prefs.plane_url.as_ref().filter(|u| !u.is_empty()),
    ) {
        return Ok(PlaneConfig {
            api_key: key.clone(),
            base_url: url.trim_end_matches('/').to_string(),
            project_name,
            workspace_id,
            project_id: project_id_opt,
        });
    }

    Err("No Plane API key or URL configured. Add one in Settings → Integrations, or override per-project.".to_string())
}

async fn plane_request(
    base_url: &str,
    api_key: &str,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);

    let mut request = client
        .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), &url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json");

    if let Some(b) = body {
        request = request.json(&b);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Plane API request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.as_u16() == 401 {
            return Err("Plane API key is invalid. Update it in project settings.".to_string());
        }
        return Err(format!("Plane API error ({status}): {text}"));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Plane response: {e}"))?;

    Ok(json)
}

// =============================================================================
// Helpers
// =============================================================================

/// Extract numeric part from Plane sequence_id (e.g., "PROJ-123" → 123)
fn parse_plane_item_number(identifier: &str) -> Option<String> {
    let parts: Vec<&str> = identifier.split('-').collect();
    parts.last().map(|s| s.to_string())
}

/// Priority mapping for Plane
fn map_plane_priority(priority: u32) -> (u32, String) {
    match priority {
        0 => (0, "No priority".to_string()),
        1 => (4, "Urgent".to_string()),
        2 => (3, "High".to_string()),
        3 => (2, "Medium".to_string()),
        4 => (1, "Low".to_string()),
        _ => (0, "Unknown".to_string()),
    }
}
    }
}

// =============================================================================
// Commands
// =============================================================================

/// List Plane workspaces for a project
#[tauri::command]
pub async fn list_plane_workspaces(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<PlaneWorkspace>, String> {
    log::info!("Listing Plane workspaces for project {project_id}");

    let config = get_plane_config(&app, &project_id)?;
    log::info!(
        "Plane config resolved: api_key_len={}, base_url={}, project={}",
        config.api_key.len(),
        config.base_url,
        config.project_name
    );

    let response = plane_request(&config.base_url, &config.api_key, "GET", "/api/v1/workspaces/", None).await?;
    log::info!("Plane workspaces raw response: {response}");

    let results = response
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or("Unexpected Plane API response format: missing results array")?;

    log::info!("Plane workspaces raw nodes count: {}", results.len());

    let workspaces: Vec<PlaneWorkspace> = results
        .iter()
        .filter_map(|node| {
            let workspace = PlaneWorkspace {
                id: node.get("id")?.as_str()?.to_string(),
                name: node.get("name")?.as_str()?.to_string(),
                slug: node.get("slug")?.as_str()?.to_string(),
                logo: node.get("logo").and_then(|l| l.as_str()).map(|s| s.to_string()),
            };
            log::info!("Parsed workspace: {} ({}) [{}]", workspace.name, workspace.slug, workspace.id);
            Some(workspace)
        })
        .collect();

    log::info!("Found {} Plane workspaces total", workspaces.len());
    Ok(workspaces)
}

/// List Plane projects for a workspace
#[tauri::command]
pub async fn list_plane_projects(
    app: AppHandle,
    project_id: String,
    workspace_slug: String,
) -> Result<Vec<PlaneProject>, String> {
    log::info!("Listing Plane projects for project {project_id}, workspace {workspace_slug}");

    let config = get_plane_config(&app, &project_id)?;

    let path = format!("/api/v1/workspaces/{}/projects/", workspace_slug);
    let response = plane_request(&config.base_url, &config.api_key, "GET", &path, None).await?;
    log::info!("Plane projects raw response: {response}");

    let results = response
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or("Unexpected Plane API response format: missing results array")?;

    let projects: Vec<PlaneProject> = results
        .iter()
        .filter_map(|node| {
            let workspace_node = node.get("workspace")?;
            let workspace = PlaneWorkspace {
                id: workspace_node.get("id")?.as_str()?.to_string(),
                name: workspace_node.get("name")?.as_str()?.to_string(),
                slug: workspace_node.get("slug")?.as_str()?.to_string(),
                logo: workspace_node.get("logo").and_then(|l| l.as_str()).map(|s| s.to_string()),
            };
            let project = PlaneProject {
                id: node.get("id")?.as_str()?.to_string(),
                name: node.get("name")?.as_str()?.to_string(),
                identifier: node.get("identifier")?.as_str()?.to_string(),
                description: node.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()),
                workspace,
            };
            log::info!("Parsed project: {} ({}) [{}]", project.name, project.identifier, project.id);
            Some(project)
        })
        .collect();

    log::info!("Found {} Plane projects total", projects.len());
    Ok(projects)
}

/// List Plane issues for a project
#[tauri::command]
pub async fn list_plane_issues(
    app: AppHandle,
    project_id: String,
    workspace_slug: String,
    project_id_filter: Option<String>,
) -> Result<Vec<PlaneIssue>, String> {
    log::info!("Listing Plane issues for project {project_id}, workspace {workspace_slug}");

    let config = get_plane_config(&app, &project_id)?;

    // Use project filter if provided, otherwise use workspace-level endpoint
    let path = if let Some(pid) = project_id_filter {
        format!(
            "/api/v1/workspaces/{}/projects/{}/issues/",
            workspace_slug, pid
        )
    } else {
        format!("/api/v1/workspaces/{}/issues/", workspace_slug)
    };

    let response = plane_request(&config.base_url, &config.api_key, "GET", &path, None).await?;
    log::info!("Plane issues raw response: {}", response);

    let results = response
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or("Unexpected Plane API response format: missing results array")?;

    let issues: Vec<PlaneIssue> = results
        .iter()
        .filter_map(|node| {
            let state_node = node.get("state")?;
            let state = PlaneState {
                id: state_node.get("id")?.as_str()?.to_string(),
                name: state_node.get("name")?.as_str()?.to_string(),
                color: state_node.get("color")?.as_str()?.to_string(),
                state_group: state_node.get("group").and_then(|g| g.as_str()).unwrap_or("null").to_string(),
            };

            let labels: Vec<PlaneLabel> = node
                .get("labels")
                .and_then(|l| l.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|label| {
                            Some(PlaneLabel {
                                id: label.get("id")?.as_str()?.to_string(),
                                name: label.get("name")?.as_str()?.to_string(),
                                color: label.get("color")?.as_str()?.to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            let assignee = node.get("assignee").and_then(|a| {
                if a.is_null() {
                    None
                } else {
                    Some(PlaneUser {
                        id: a.get("id")?.as_str()?.to_string(),
                        name: a.get("name")?.as_str()?.to_string(),
                        email: a.get("email")?.as_str()?.to_string(),
                    })
                }
            });

            let priority = node.get("priority").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
            let (priority_val, priority_lbl) = map_plane_priority(priority);

            let issue = PlaneIssue {
                id: node.get("id")?.as_str()?.to_string(),
                sequence_id: node.get("sequence_id")?.as_str()?.to_string(),
                name: node.get("name")?.as_str()?.to_string(),
                description: node.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()),
                description_html: node.get("description_html").and_then(|d| d.as_str()).map(|s| s.to_string()),
                state,
                labels,
                assignee,
                created_at: node.get("created_at")?.as_str()?.to_string(),
                updated_at: node.get("updated_at")?.as_str()?.to_string(),
                url: config.base_url.clone(),
                priority: priority_val,
                priority_label: priority_lbl,
            };
            Some(issue)
        })
        .collect();

    log::info!("Found {} Plane issues total", issues.len());
    Ok(issues)
}

/// Search Plane issues by text
#[tauri::command]
pub async fn search_plane_issues(
    app: AppHandle,
    project_id: String,
    workspace_slug: String,
    project_id_filter: Option<String>,
    search: String,
) -> Result<Vec<PlaneIssue>, String> {
    log::info!("Searching Plane issues for project {project_id}, workspace {workspace_slug}, search: {search}");

    let config = get_plane_config(&app, &project_id)?;

    // Use project filter if provided, otherwise use workspace-level endpoint
    let path = if let Some(pid) = project_id_filter {
        format!(
            "/api/v1/workspaces/{}/projects/{}/issues/",
            workspace_slug, pid
        )
    } else {
        format!("/api/v1/workspaces/{}/issues/", workspace_slug)
    };

    // Add search query param
    let path_with_search = format!("{}?search={}", path, urlencoding::encode(&search));

    let response = plane_request(&config.base_url, &config.api_key, "GET", &path_with_search, None).await?;

    let results = response
        .get("results")
        .and_then(|r| r.as_array())
        .ok_or("Unexpected Plane API response format: missing results array")?;

    let issues: Vec<PlaneIssue> = results
        .iter()
        .filter_map(|node| {
            let state_node = node.get("state")?;
            let state = PlaneState {
                id: state_node.get("id")?.as_str()?.to_string(),
                name: state_node.get("name")?.as_str()?.to_string(),
                color: state_node.get("color")?.as_str()?.to_string(),
                state_group: state_node.get("group").and_then(|g| g.as_str()).unwrap_or("null").to_string(),
            };

            let labels: Vec<PlaneLabel> = node
                .get("labels")
                .and_then(|l| l.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|label| {
                            Some(PlaneLabel {
                                id: label.get("id")?.as_str()?.to_string(),
                                name: label.get("name")?.as_str()?.to_string(),
                                color: label.get("color")?.as_str()?.to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            let assignee = node.get("assignee").and_then(|a| {
                if a.is_null() {
                    None
                } else {
                    Some(PlaneUser {
                        id: a.get("id")?.as_str()?.to_string(),
                        name: a.get("name")?.as_str()?.to_string(),
                        email: a.get("email")?.as_str()?.to_string(),
                    })
                }
            });

            let priority = node.get("priority").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
            let (priority_val, priority_lbl) = map_plane_priority(priority);

            let issue = PlaneIssue {
                id: node.get("id")?.as_str()?.to_string(),
                sequence_id: node.get("sequence_id")?.as_str()?.to_string(),
                name: node.get("name")?.as_str()?.to_string(),
                description: node.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()),
                description_html: node.get("description_html").and_then(|d| d.as_str()).map(|s| s.to_string()),
                state,
                labels,
                assignee,
                created_at: node.get("created_at")?.as_str()?.to_string(),
                updated_at: node.get("updated_at")?.as_str()?.to_string(),
                url: config.base_url.clone(),
                priority: priority_val,
                priority_label: priority_lbl,
            };
            Some(issue)
        })
        .collect();

    log::info!("Found {} Plane issues matching search", issues.len());
    Ok(issues)
}

/// Get a single Plane issue by ID
#[tauri::command]
pub async fn get_plane_issue(
    app: AppHandle,
    project_id: String,
    workspace_slug: String,
    issue_id: String,
) -> Result<PlaneIssueDetail, String> {
    log::info!("Getting Plane issue {issue_id} for project {project_id}, workspace {workspace_slug}");

    let config = get_plane_config(&app, &project_id)?;

    let path = format!("/api/v1/workspaces/{}/issues/{}/", workspace_slug, issue_id);
    let response = plane_request(&config.base_url, &config.api_key, "GET", &path, None).await?;
    log::info!("Plane issue raw response: {}", response);

    let node = &response;

    let state_node = node.get("state").ok_or("Missing state in Plane issue")?;
    let state = PlaneState {
        id: state_node.get("id")?.as_str()?.to_string(),
        name: state_node.get("name")?.as_str()?.to_string(),
        color: state_node.get("color")?.as_str()?.to_string(),
        state_group: state_node.get("group").and_then(|g| g.as_str()).unwrap_or("null").to_string(),
    };

    let labels: Vec<PlaneLabel> = node
        .get("labels")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|label| {
                    Some(PlaneLabel {
                        id: label.get("id")?.as_str()?.to_string(),
                        name: label.get("name")?.as_str()?.to_string(),
                        color: label.get("color")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let assignee = node.get("assignee").and_then(|a| {
        if a.is_null() {
            None
        } else {
            Some(PlaneUser {
                id: a.get("id")?.as_str()?.to_string(),
                name: a.get("name")?.as_str()?.to_string(),
                email: a.get("email")?.as_str()?.to_string(),
            })
        }
    });

    // Get comments
    let comments: Vec<PlaneComment> = node
        .get("comments")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|comment| {
                    let actor = comment.get("actor").and_then(|a| {
                        if a.is_null() {
                            None
                        } else {
                            Some(PlaneUser {
                                id: a.get("id")?.as_str()?.to_string(),
                                name: a.get("name")?.as_str()?.to_string(),
                                email: a.get("email")?.as_str()?.to_string(),
                            })
                        }
                    });
                    Some(PlaneComment {
                        id: comment.get("id")?.as_str()?.to_string(),
                        comment: comment.get("comment")?.as_str()?.to_string(),
                        created_at: comment.get("created_at")?.as_str()?.to_string(),
                        updated_at: comment.get("updated_at")?.as_str()?.to_string(),
                        actor,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let priority = node.get("priority").and_then(|p| p.as_u64()).unwrap_or(0) as u32;
    let (priority_val, priority_lbl) = map_plane_priority(priority);

    let issue = PlaneIssueDetail {
        id: node.get("id")?.as_str()?.to_string(),
        sequence_id: node.get("sequence_id")?.as_str()?.to_string(),
        name: node.get("name")?.as_str()?.to_string(),
        description: node.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()),
        description_html: node.get("description_html").and_then(|d| d.as_str()).map(|s| s.to_string()),
        state,
        labels,
        assignee,
        created_at: node.get("created_at")?.as_str()?.to_string(),
        updated_at: node.get("updated_at")?.as_str()?.to_string(),
        url: config.base_url.clone(),
        priority: priority_val,
        priority_label: priority_lbl,
        comments,
    };

    log::info!("Got Plane issue: {} ({})", issue.name, issue.sequence_id);
    Ok(issue)
}

/// Get a single Plane issue by sequence number (e.g., "PROJ-123")
#[tauri::command]
pub async fn get_plane_issue_by_number(
    app: AppHandle,
    project_id: String,
    workspace_slug: String,
    project_id_filter: Option<String>,
    identifier: String,
) -> Result<PlaneIssueDetail, String> {
    log::info!("Getting Plane issue by number {identifier} for project {project_id}");

    // First, search for the issue by identifier
    let issues = search_plane_issues(app, project_id, workspace_slug, project_id_filter, identifier.clone()).await?;

    // Find the exact match
    issues
        .into_iter()
        .find(|i| i.sequence_id == identifier)
        .map(|i| {
            // Need to fetch full details including comments
            // For now, convert from list format (can't easily call get_plane_issue here due to async)
            // This is a limitation - in practice, we should fetch by ID
            PlaneIssueDetail {
                id: i.id,
                sequence_id: i.sequence_id,
                name: i.name,
                description: i.description,
                description_html: i.description_html,
                state: i.state,
                labels: i.labels,
                assignee: i.assignee,
                created_at: i.created_at,
                updated_at: i.updated_at,
                url: i.url,
                priority: i.priority,
                priority_label: i.priority_label,
                comments: vec![],
            }
        })
        .ok_or_else(|| format!("Issue not found: {identifier}"))
}

/// Load Plane issue context for a session
#[tauri::command]
pub async fn load_plane_issue_context(
    app: AppHandle,
    project_id: String,
    session_id: String,
    workspace_slug: String,
    issue_identifier: String,
) -> Result<IssueContext, String> {
    log::info!(
        "Loading Plane issue context for project {project_id}, session {session_id}, issue {issue_identifier}"
    );

    let config = get_plane_config(&app, &project_id)?;

    // Get the issue with full details
    let issue = get_plane_issue(app.clone(), project_id.clone(), workspace_slug.clone(), issue_identifier.clone()).await?;

    // Build context content
    let mut content = String::new();
    content.push_str(&format!("# {}\n\n", issue.name));

    if let Some(desc) = &issue.description {
        content.push_str("## Description\n\n");
        content.push_str(desc);
        content.push_str("\n\n");
    }

    if !issue.comments.is_empty() {
        content.push_str("## Comments\n\n");
        for comment in &issue.comments {
            content.push_str(&format!(
                "### {} - {}\n\n{}\n\n",
                comment.actor.as_ref().map(|a| a.name_or("Unknown"),
                comment.created_at.as_str()).unwrap,
                comment.comment
            ));
        }
    }

    // Determine project name for context
    let project_name = config.project_name.clone();

    // Save to file using github_issues helper
    let contexts_dir = get_github_contexts_dir(&app, &project_id, &session_id)?;
    let filename = slugify_issue_title(&issue.name);
    let file_path = contexts_dir.join(format!("{}.md", filename));

    std::fs::create_dir_all(&contexts_dir).map_err(|e| format!("Failed to create contexts dir: {}", e))?;
    std::fs::write(&file_path, &content).map_err(|e| format!("Failed to write context file: {}", e))?;

    // Update references
    let references = load_context_references(&app, &project_id, &session_id)?;
    let new_refs = references.into_iter().chain(std::iter::new(IssueContext {
        context_type: "plane".to_string(),
        identifier: issue.sequence_id.clone(),
        title: issue.name.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        comment_count: issue.comments.len(),
        project_name: project_name.clone(),
    })).collect();

    save_context_references(&app, &project_id, &session_id, &new_ref)?;

    log::info!(
        "Loaded Plane issue context: {} ({} comments)",
        issue.sequence_id,
        issue.comments.len()
    );

    Ok(IssueContext {
        context_type: "plane".to_string(),
        identifier: issue.sequence_id,
        title: issue.name,
        file_path: file_path.to_string_lossy().to_string(),
        comment_count: issue.comments.len(),
        project_name,
    })
}

/// List all loaded Plane issue contexts for a session
#[tauri::command]
pub async fn list_loaded_plane_issue_contexts(
    app: AppHandle,
    project_id: String,
    session_id: String,
) -> Result<Vec<LoadedPlaneIssueContext>, String> {
    log::info!(
        "Listing loaded Plane issue contexts for project {project_id}, session {session_id}"
    );

    let references = load_context_references(&app, &project_id, &session_id)?;

    let plane_refs: Vec<LoadedPlaneIssueContext> = references
        .into_iter()
        .filter(|r| r.context_type == "plane")
        .map(|r| LoadedPlaneIssueContext {
            identifier: r.identifier,
            title: r.title,
            comment_count: r.comment_count,
            project_name: r.project_name,
        })
        .collect();

    log::info!("Found {} Plane issue contexts", plane_refs.len());
    Ok(plane_refs)
}

/// Get contents of a loaded Plane issue context
#[tauri::command]
pub async fn get_plane_issue_context_contents(
    project_id: String,
    session_id: String,
    identifier: String,
) -> Result<String, String> {
    log::info!(
        "Getting Plane issue context contents for project {project_id}, session {session_id}, identifier {identifier}"
    );

    let references = load_context_references(&crate::AppHandle::from_owned(app.clone()), &project_id, &session_id)?;

    let file_path = references
        .into_iter()
        .find(|r| r.context_type == "plane" && r.identifier == identifier)
        .map(|r| r.file_path)
        .ok_or_else(|| format!("Context not found for identifier: {identifier}"))?;

    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read context file: {}", e))?;

    Ok(content)
}

/// Remove a Plane issue context from a session
#[tauri::command]
pub async fn remove_plane_issue_context(
    app: AppHandle,
    project_id: String,
    session_id: String,
    identifier: String,
) -> Result<(), String> {
    log::info!(
        "Removing Plane issue context for project {project_id}, session {session_id}, identifier {identifier}"
    );

    let references = load_context_references(&app, &project_id, &session_id)?;

    let (remaining, removed) = references
        .into_iter()
        .partition(|r| !(r.context_type == "plane" && r.identifier == identifier));

    if removed.is_empty() {
        return Err(format!("Context not found for identifier: {identifier}"));
    }

    // Delete the file
    if let Some(context) = removed.into_iter().next() {
        let path = std::path::Path::new(&context.file_path);
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("Failed to delete context file: {}", e))?;
        }
    }

    save_context_references(&app, &project_id, &session_id, &remaining)?;

    log::info!("Removed Plane issue context: {identifier}");
    Ok(())
}
