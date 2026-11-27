//! Plane (https://plane.so) work item integration.
//!
//! Uses the Plane REST API v1, which Plane Cloud and self-hosted Plane both serve:
//! https://developers.plane.so/api-reference/introduction
//!
//! The work item JSON sent to the frontend has the same shape as a Linear issue,
//! so the issue list UI is shared between both providers.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

use super::github_issues::{
    get_github_contexts_dir, load_context_references, save_context_references, slugify_issue_title,
};
use super::storage::{load_projects_data, save_projects_data};
use super::types::{PlaneProjectSettings, Project};

// =============================================================================
// Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaneWorkItemState {
    pub name: String,
    /// Plane state group: backlog, unstarted, started, completed, cancelled, triage
    #[serde(rename = "type")]
    pub group: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaneLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaneUser {
    pub name: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaneWorkItem {
    pub id: String,
    /// Human identifier, e.g. "PROJ-123"
    pub identifier: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub state: PlaneWorkItemState,
    #[serde(default)]
    pub labels: Vec<PlaneLabel>,
    #[serde(default)]
    pub assignee: Option<PlaneUser>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub url: String,
    /// 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low (same scale as Linear)
    #[serde(default)]
    pub priority: u32,
    #[serde(default)]
    pub priority_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaneComment {
    pub body: String,
    #[serde(default)]
    pub user: Option<PlaneUser>,
    #[serde(default)]
    pub created_at: String,
}

/// A work item with its comments. The frontend passes this back as
/// `planeContext` when it creates a worktree from a work item.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaneWorkItemDetail {
    #[serde(flatten)]
    pub item: PlaneWorkItem,
    #[serde(default)]
    pub comments: Vec<PlaneComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaneProject {
    pub id: String,
    pub name: String,
    /// Project key used in work item identifiers, e.g. "PROJ"
    pub identifier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPlaneWorkItemContext {
    pub identifier: String,
    pub title: String,
    pub comment_count: usize,
    pub project_name: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneWorkItemContextContent {
    pub identifier: String,
    pub title: String,
    pub content: String,
}

// =============================================================================
// Validation and URL building
// =============================================================================

pub const PLANE_CLOUD_API_URL: &str = "https://api.plane.so";
const PLANE_CLOUD_API_HOST: &str = "api.plane.so";
const PLANE_CLOUD_APP_HOST: &str = "app.plane.so";
/// Without a Plane project filter, list work items from at most this many projects.
const MAX_UNFILTERED_PROJECTS: usize = 10;
const ACTIVE_STATE_GROUPS: [&str; 4] = ["backlog", "unstarted", "started", "triage"];

/// Normalize a work item identifier like "proj-12" to "PROJ-12".
/// Returns None unless it is `<1-12 letters/digits>-<positive number>`.
pub fn parse_plane_identifier(input: &str) -> Option<String> {
    let (prefix, number) = input.trim().rsplit_once('-')?;
    let prefix_ok = !prefix.is_empty()
        && prefix.len() <= 12
        && prefix.chars().all(|c| c.is_ascii_alphanumeric());
    let number_ok = !number.is_empty() && number.chars().all(|c| c.is_ascii_digit());
    if !prefix_ok || !number_ok {
        return None;
    }
    let number = number.parse::<u64>().ok().filter(|n| *n > 0)?;
    Some(format!("{}-{number}", prefix.to_ascii_uppercase()))
}

fn is_valid_workspace_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Plane resource IDs are UUIDs.
fn is_valid_plane_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn require_plane_id<'a>(id: &'a str, what: &str) -> Result<&'a str, String> {
    if is_valid_plane_id(id) {
        Ok(id)
    } else {
        Err(format!("Invalid Plane {what} ID"))
    }
}

/// Parse the configured Plane base URL. Empty means Plane Cloud.
/// Accepts only http/https URLs without credentials. A trailing `/api` or
/// `/api/v1` is removed, so users can paste either the app URL or the API URL.
pub fn parse_plane_base_url(raw: Option<&str>) -> Result<reqwest::Url, String> {
    let raw = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(PLANE_CLOUD_API_URL);
    let mut url =
        reqwest::Url::parse(raw).map_err(|_| "Plane base URL is not a valid URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Plane base URL must start with http:// or https://".to_string());
    }
    if url.host_str().is_none() || url.cannot_be_a_base() {
        return Err("Plane base URL must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Plane base URL must not contain credentials".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_string();
    let path = path
        .strip_suffix("/api/v1")
        .or_else(|| path.strip_suffix("/api"))
        .unwrap_or(&path)
        .to_string();
    url.set_path(&path);
    Ok(url)
}

/// Append path segments (percent-encoded) and a trailing slash, which Plane requires.
fn join_segments(base: &reqwest::Url, segments: &[&str]) -> reqwest::Url {
    let mut url = base.clone();
    if let Ok(mut path) = url.path_segments_mut() {
        path.pop_if_empty().extend(segments).push("");
    }
    url
}

fn plane_api_url(base: &reqwest::Url, workspace: &str, segments: &[&str]) -> reqwest::Url {
    let mut all = vec!["api", "v1", "workspaces", workspace];
    all.extend_from_slice(segments);
    join_segments(base, &all)
}

/// Browser URL of a work item. Plane Cloud serves the API and the app on different hosts.
pub fn plane_work_item_web_url(base: &reqwest::Url, workspace: &str, identifier: &str) -> String {
    let mut web = base.clone();
    if web.host_str() == Some(PLANE_CLOUD_API_HOST) {
        let _ = web.set_host(Some(PLANE_CLOUD_APP_HOST));
    }
    let mut url = join_segments(&web, &[workspace, "browse", identifier]).to_string();
    url.pop(); // Plane's web route has no trailing slash
    url
}

/// Generate branch name from a Plane work item identifier and title
pub fn generate_branch_name_from_plane_work_item(identifier: &str, title: &str) -> String {
    let slug = slugify_issue_title(title);
    let id = identifier.to_lowercase();
    format!("plane-{id}-{slug}")
}

// =============================================================================
// Config
// =============================================================================

/// Plane config resolved from project settings, then global preferences.
#[derive(Debug)]
struct PlaneConfig {
    api_key: String,
    workspace_slug: String,
    base_url: reqwest::Url,
    plane_project_id: Option<String>,
}

fn non_empty(value: Option<&String>) -> Option<&str> {
    value.map(|s| s.trim()).filter(|s| !s.is_empty())
}

fn resolve_plane_config(
    project: &Project,
    prefs: &crate::AppPreferences,
) -> Result<PlaneConfig, String> {
    let settings = project.plane.clone().unwrap_or_default();
    let api_key = non_empty(settings.api_key.as_ref())
        .or(non_empty(prefs.plane_api_key.as_ref()))
        .ok_or("No Plane API key configured. Add one in Settings → Integrations.")?;
    let workspace_slug = non_empty(settings.workspace_slug.as_ref())
        .or(non_empty(prefs.plane_workspace_slug.as_ref()))
        .ok_or("No Plane workspace slug configured. Add one in Settings → Integrations.")?;
    if !is_valid_workspace_slug(workspace_slug) {
        return Err("Plane workspace slug may contain only letters, digits, '-' and '_'".into());
    }
    let base_url = parse_plane_base_url(
        non_empty(settings.base_url.as_ref()).or(non_empty(prefs.plane_base_url.as_ref())),
    )?;
    let plane_project_id = non_empty(settings.project_id.as_ref())
        .map(|id| require_plane_id(id, "project").map(str::to_string))
        .transpose()?;
    Ok(PlaneConfig {
        api_key: api_key.to_string(),
        workspace_slug: workspace_slug.to_string(),
        base_url,
        plane_project_id,
    })
}

fn load_project(app: &AppHandle, project_id: &str) -> Result<Project, String> {
    load_projects_data(app)?
        .find_project(project_id)
        .cloned()
        .ok_or_else(|| format!("Project not found: {project_id}"))
}

fn plane_client_for(app: &AppHandle, project_id: &str) -> Result<(PlaneClient, Project), String> {
    let project = load_project(app, project_id)?;
    let prefs = crate::load_preferences_sync(app)?;
    let config = resolve_plane_config(&project, &prefs)?;
    Ok((PlaneClient::new(config), project))
}

// =============================================================================
// Response parsing
// =============================================================================

fn str_field<'a>(node: &'a Value, key: &str) -> Option<&'a str> {
    node.get(key).and_then(Value::as_str)
}

/// Paginated v1 endpoints return `{ "results": [...] }`; some return a bare array.
fn results_array(value: &Value) -> &[Value] {
    value
        .as_array()
        .or_else(|| value.get("results").and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Convert Plane rich-text HTML to plain text.
fn html_to_text(html: &str) -> String {
    let breaks = regex::Regex::new(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|pre|blockquote)>").unwrap();
    let tags = regex::Regex::new(r"<[^>]*>").unwrap();
    let text = breaks.replace_all(html, "\n");
    let text = tags.replace_all(&text, "");
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

/// Prefer Plane's plain-text field, else convert the HTML field.
fn plain_text(node: &Value, stripped_key: &str, html_key: &str) -> Option<String> {
    str_field(node, stripped_key)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| str_field(node, html_key).map(html_to_text))
        .filter(|s| !s.is_empty())
}

fn parse_user(node: &Value) -> Option<PlaneUser> {
    let display_name = str_field(node, "display_name")?.to_string();
    let full_name = format!(
        "{} {}",
        str_field(node, "first_name").unwrap_or(""),
        str_field(node, "last_name").unwrap_or("")
    );
    let full_name = full_name.trim();
    Some(PlaneUser {
        name: if full_name.is_empty() {
            display_name.clone()
        } else {
            full_name.to_string()
        },
        display_name,
    })
}

fn priority_from_plane(priority: Option<&str>) -> (u32, &'static str) {
    match priority.unwrap_or("none") {
        "urgent" => (1, "Urgent"),
        "high" => (2, "High"),
        "medium" => (3, "Medium"),
        "low" => (4, "Low"),
        _ => (0, "No priority"),
    }
}

fn unknown_state() -> PlaneWorkItemState {
    PlaneWorkItemState {
        name: "Unknown".to_string(),
        group: "unstarted".to_string(),
        color: "#94a3b8".to_string(),
    }
}

/// Parse a v1 work item. `state`, `labels` and `assignees` are objects when the
/// request used `expand=state,labels,assignees`, otherwise UUID strings.
fn parse_work_item(
    node: &Value,
    project_identifier: &str,
    base: &reqwest::Url,
    workspace: &str,
) -> Option<PlaneWorkItem> {
    let sequence_id = node.get("sequence_id")?.as_u64()?;
    let identifier = parse_plane_identifier(&format!("{project_identifier}-{sequence_id}"))?;
    let state = node
        .get("state")
        .filter(|s| s.is_object())
        .and_then(|s| {
            Some(PlaneWorkItemState {
                name: str_field(s, "name")?.to_string(),
                group: str_field(s, "group").unwrap_or("unstarted").to_string(),
                color: str_field(s, "color").unwrap_or("#94a3b8").to_string(),
            })
        })
        .unwrap_or_else(unknown_state);
    let labels = node
        .get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|l| {
                    Some(PlaneLabel {
                        name: str_field(l, "name")?.to_string(),
                        color: str_field(l, "color").unwrap_or("#94a3b8").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let assignee = node
        .get("assignees")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find_map(parse_user));
    let (priority, priority_label) = priority_from_plane(str_field(node, "priority"));

    Some(PlaneWorkItem {
        id: str_field(node, "id")?.to_string(),
        url: plane_work_item_web_url(base, workspace, &identifier),
        identifier,
        title: str_field(node, "name")?.to_string(),
        description: plain_text(node, "description_stripped", "description_html"),
        state,
        labels,
        assignee,
        created_at: str_field(node, "created_at").unwrap_or("").to_string(),
        priority,
        priority_label: priority_label.to_string(),
    })
}

/// Parse a search hit (`{ id, name, sequence_id, project__identifier }`).
fn parse_search_hit(node: &Value, base: &reqwest::Url, workspace: &str) -> Option<PlaneWorkItem> {
    let project_identifier = str_field(node, "project__identifier")?;
    parse_work_item(node, project_identifier, base, workspace)
}

fn parse_comment(node: &Value) -> Option<PlaneComment> {
    let body = plain_text(node, "comment_stripped", "comment_html")?;
    let user = ["actor_detail", "actor"].iter().find_map(|key| {
        node.get(*key)
            .filter(|v| v.is_object())
            .and_then(parse_user)
    });
    Some(PlaneComment {
        body,
        user,
        created_at: str_field(node, "created_at").unwrap_or("").to_string(),
    })
}

fn parse_project(node: &Value) -> Option<PlaneProject> {
    if node.get("archived_at").is_some_and(|v| !v.is_null()) {
        return None;
    }
    Some(PlaneProject {
        id: str_field(node, "id")?.to_string(),
        name: str_field(node, "name")?.to_string(),
        identifier: str_field(node, "identifier")?.to_string(),
    })
}

// =============================================================================
// HTTP client
// =============================================================================

struct PlaneClient {
    http: reqwest::Client,
    config: PlaneConfig,
}

impl PlaneClient {
    fn new(config: PlaneConfig) -> Self {
        // No redirects: a redirect to another host would forward the X-API-Key header.
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self { http, config }
    }

    fn url(&self, segments: &[&str], query: &[(&str, &str)]) -> reqwest::Url {
        let mut url = plane_api_url(&self.config.base_url, &self.config.workspace_slug, segments);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        url
    }

    async fn get(&self, url: reqwest::Url) -> Result<Value, String> {
        let response = self
            .http
            .get(url)
            .header("X-API-Key", &self.config.api_key)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Plane API request failed: {e}"))?;

        let status = response.status();
        if status.is_redirection() {
            return Err("Plane API redirected the request. Check the Plane base URL.".into());
        }
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 => "Plane API key is invalid. Update it in Settings → Integrations.".into(),
                429 => {
                    "Plane API rate limit reached (60 requests per minute). Try again in a minute."
                        .into()
                }
                403 => "Plane API key has no access to this workspace or project.".into(),
                404 => "Plane resource not found. Check the workspace slug, project, and base URL."
                    .into(),
                _ => {
                    let text = response.text().await.unwrap_or_default();
                    let text: String = text.chars().take(300).collect();
                    format!("Plane API error ({status}): {text}")
                }
            });
        }
        response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Plane response: {e}"))
    }

    fn parse_item(&self, node: &Value, project_identifier: &str) -> Option<PlaneWorkItem> {
        parse_work_item(
            node,
            project_identifier,
            &self.config.base_url,
            &self.config.workspace_slug,
        )
    }

    async fn list_projects(&self) -> Result<Vec<PlaneProject>, String> {
        let json = self
            .get(self.url(&["projects"], &[("per_page", "100")]))
            .await?;
        Ok(results_array(&json)
            .iter()
            .filter_map(parse_project)
            .collect())
    }

    async fn get_project(&self, project_id: &str) -> Result<PlaneProject, String> {
        let project_id = require_plane_id(project_id, "project")?;
        let json = self.get(self.url(&["projects", project_id], &[])).await?;
        parse_project(&json).ok_or_else(|| "Unexpected Plane project response".to_string())
    }

    /// Active (not completed/cancelled) work items of one Plane project.
    async fn list_project_work_items(
        &self,
        project: &PlaneProject,
    ) -> Result<Vec<PlaneWorkItem>, String> {
        let project_id = require_plane_id(&project.id, "project")?;
        let url = self.url(
            &["projects", project_id, "work-items"],
            &[
                ("expand", "state,labels,assignees"),
                ("order_by", "-updated_at"),
                ("per_page", "100"),
            ],
        );
        let json = self.get(url).await?;
        Ok(results_array(&json)
            .iter()
            .filter_map(|node| self.parse_item(node, &project.identifier))
            .filter(|item| ACTIVE_STATE_GROUPS.contains(&item.state.group.as_str()))
            .collect())
    }

    async fn list_work_items(&self) -> Result<Vec<PlaneWorkItem>, String> {
        let projects = match &self.config.plane_project_id {
            Some(id) => vec![self.get_project(id).await?],
            None => {
                let mut projects = self.list_projects().await?;
                projects.truncate(MAX_UNFILTERED_PROJECTS);
                projects
            }
        };
        let results = futures_util::future::join_all(
            projects.iter().map(|p| self.list_project_work_items(p)),
        )
        .await;
        let mut items = Vec::new();
        let mut first_error = None;
        for result in results {
            match result {
                Ok(mut list) => items.append(&mut list),
                Err(e) => {
                    log::warn!("Failed to list Plane work items for a project: {e}");
                    first_error.get_or_insert(e);
                }
            }
        }
        match first_error {
            Some(e) if items.is_empty() => Err(e),
            _ => Ok(items),
        }
    }

    async fn search(&self, query: &str) -> Result<Vec<PlaneWorkItem>, String> {
        let mut params = vec![("search", query), ("limit", "50")];
        if let Some(id) = &self.config.plane_project_id {
            params.push(("project_id", id.as_str()));
        }
        let json = self
            .get(self.url(&["work-items", "search"], &params))
            .await?;
        let hits = json
            .get("issues")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_else(|| results_array(&json));
        Ok(hits
            .iter()
            .filter_map(|node| {
                parse_search_hit(node, &self.config.base_url, &self.config.workspace_slug)
            })
            .collect())
    }

    async fn get_work_item(&self, identifier: &str) -> Result<PlaneWorkItemDetail, String> {
        let identifier = parse_plane_identifier(identifier)
            .ok_or_else(|| format!("Invalid Plane work item identifier: {identifier}"))?;
        let (project_identifier, _) = identifier
            .rsplit_once('-')
            .ok_or("Invalid Plane work item identifier")?;
        let json = self
            .get(self.url(
                &["work-items", &identifier],
                &[("expand", "state,labels,assignees")],
            ))
            .await?;
        let item = self
            .parse_item(&json, project_identifier)
            .ok_or("Unexpected Plane work item response")?;
        let project_id = str_field(&json, "project").ok_or("Plane work item has no project")?;
        let project_id = require_plane_id(project_id, "project")?;
        let item_id = require_plane_id(&item.id, "work item")?;
        let comments_json = self
            .get(self.url(
                &["projects", project_id, "work-items", item_id, "comments"],
                &[("expand", "actor"), ("per_page", "100")],
            ))
            .await?;
        // The v1 comment list always returns newest first; show them oldest first.
        let mut comments: Vec<PlaneComment> = results_array(&comments_json)
            .iter()
            .filter_map(parse_comment)
            .collect();
        comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(PlaneWorkItemDetail { item, comments })
    }
}

// =============================================================================
// Context files
// =============================================================================

const CONTEXT_TITLE_PREFIX: &str = "# Plane Work Item ";

fn plane_context_file(contexts_dir: &Path, project_name: &str, identifier: &str) -> PathBuf {
    contexts_dir.join(format!(
        "{project_name}-plane-{}.md",
        identifier.to_lowercase()
    ))
}

/// Context reference key: "{project_name}::{IDENTIFIER}"
fn plane_ref_key(project_name: &str, identifier: &str) -> String {
    format!("{project_name}::{identifier}")
}

/// Format a Plane work item as markdown context
pub fn format_plane_work_item_markdown(detail: &PlaneWorkItemDetail) -> String {
    let item = &detail.item;
    let mut content = format!(
        "{CONTEXT_TITLE_PREFIX}{}: {}\n\n",
        item.identifier,
        item.title.replace('\n', " ")
    );
    content.push_str(&format!("- **Status**: {}\n", item.state.name));
    content.push_str(&format!("- **Priority**: {}\n", item.priority_label));
    if !item.labels.is_empty() {
        let labels: Vec<&str> = item.labels.iter().map(|l| l.name.as_str()).collect();
        content.push_str(&format!("- **Labels**: {}\n", labels.join(", ")));
    }
    if let Some(assignee) = &item.assignee {
        content.push_str(&format!("- **Assignee**: {}\n", assignee.display_name));
    }
    if !item.url.is_empty() {
        content.push_str(&format!("- **URL**: {}\n", item.url));
    }
    content.push_str("\n---\n\n## Description\n\n");
    match item.description.as_deref().filter(|d| !d.is_empty()) {
        Some(desc) => content.push_str(desc),
        None => content.push_str("*No description provided.*"),
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
            content.push_str(&format!("### {author} ({})\n\n", comment.created_at));
            content.push_str(&comment.body);
            content.push_str("\n\n---\n\n");
        }
    }
    content.push_str("---\n\n*Investigate this work item and propose a solution.*\n");
    content
}

fn loaded_context_from_markdown(
    content: &str,
    identifier: &str,
    project_name: &str,
) -> LoadedPlaneWorkItemContext {
    let title = content
        .lines()
        .next()
        .and_then(|line| line.strip_prefix(CONTEXT_TITLE_PREFIX))
        .and_then(|rest| rest.split_once(": "))
        .map(|(_, title)| title.to_string())
        .unwrap_or_else(|| format!("Work item {identifier}"));
    let comment_count = content
        .split("## Comments")
        .nth(1)
        .map(|section| section.lines().filter(|l| l.starts_with("### ")).count())
        .unwrap_or(0);
    let url = content
        .lines()
        .find_map(|l| l.strip_prefix("- **URL**: "))
        .map(str::to_string);
    LoadedPlaneWorkItemContext {
        identifier: identifier.to_string(),
        title,
        comment_count,
        project_name: project_name.to_string(),
        url,
    }
}

/// Write the context file and reference it from a session or worktree.
pub fn write_plane_work_item_context(
    app: &AppHandle,
    project_name: &str,
    detail: &PlaneWorkItemDetail,
    session_id: &str,
) -> Result<PathBuf, String> {
    let identifier = parse_plane_identifier(&detail.item.identifier)
        .ok_or("Invalid Plane work item identifier")?;
    let contexts_dir = get_github_contexts_dir(app)?;
    std::fs::create_dir_all(&contexts_dir)
        .map_err(|e| format!("Failed to create git-context directory: {e}"))?;
    let path = plane_context_file(&contexts_dir, project_name, &identifier);
    std::fs::write(&path, format_plane_work_item_markdown(detail))
        .map_err(|e| format!("Failed to write Plane context file: {e}"))?;

    let mut refs = load_context_references(app)?;
    let entry = refs
        .plane
        .entry(plane_ref_key(project_name, &identifier))
        .or_default();
    if !entry.sessions.iter().any(|s| s == session_id) {
        entry.sessions.push(session_id.to_string());
    }
    entry.orphaned_at = None;
    save_context_references(app, &refs)?;
    Ok(path)
}

/// Plane reference keys of a session plus its worktree.
fn plane_refs(app: &AppHandle, session_id: &str, worktree_id: Option<&str>) -> Vec<String> {
    let Ok(refs) = load_context_references(app) else {
        return Vec::new();
    };
    let mut keys: Vec<String> = refs
        .plane
        .iter()
        .filter(|(_, entry)| {
            entry
                .sessions
                .iter()
                .any(|s| s == session_id || Some(s.as_str()) == worktree_id)
        })
        .map(|(key, _)| key.clone())
        .collect();
    keys.sort();
    keys
}

/// Context files of the Plane work items loaded into a session or its worktree.
pub fn get_plane_context_paths(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Vec<PathBuf> {
    let Ok(contexts_dir) = get_github_contexts_dir(app) else {
        return Vec::new();
    };
    plane_refs(app, session_id, Some(worktree_id))
        .iter()
        .filter_map(|key| key.split_once("::"))
        .map(|(project_name, identifier)| {
            plane_context_file(&contexts_dir, project_name, identifier)
        })
        .filter(|path| path.exists())
        .collect()
}

/// (identifier, file content) of each loaded work item of one Jean project.
fn loaded_context_files(
    app: &AppHandle,
    session_id: &str,
    worktree_id: Option<&str>,
    project_name: &str,
) -> Result<Vec<(String, String)>, String> {
    let contexts_dir = get_github_contexts_dir(app)?;
    let prefix = format!("{project_name}::");
    Ok(plane_refs(app, session_id, worktree_id)
        .iter()
        .filter_map(|key| key.strip_prefix(&prefix))
        .filter_map(|identifier| {
            let path = plane_context_file(&contexts_dir, project_name, identifier);
            let content = std::fs::read_to_string(path).ok()?;
            Some((identifier.to_string(), content))
        })
        .collect())
}

// =============================================================================
// Commands
// =============================================================================

/// List Plane projects of the configured workspace (for the project filter setting)
pub async fn list_plane_projects(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<PlaneProject>, String> {
    let (client, _) = plane_client_for(&app, &project_id)?;
    client.list_projects().await
}

/// List active Plane work items for a Jean project
pub async fn list_plane_work_items(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<PlaneWorkItem>, String> {
    let (client, _) = plane_client_for(&app, &project_id)?;
    client.list_work_items().await
}

/// Search Plane work items by title or identifier
pub async fn search_plane_work_items(
    app: AppHandle,
    project_id: String,
    query: String,
) -> Result<Vec<PlaneWorkItem>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let (client, _) = plane_client_for(&app, &project_id)?;
    client.search(query).await
}

/// Get a Plane work item with comments by its identifier (e.g. "PROJ-123")
pub async fn get_plane_work_item(
    app: AppHandle,
    project_id: String,
    identifier: String,
) -> Result<PlaneWorkItemDetail, String> {
    let (client, _) = plane_client_for(&app, &project_id)?;
    client.get_work_item(&identifier).await
}

/// Fetch a work item and load it as context into a session
pub async fn load_plane_work_item_context(
    app: AppHandle,
    session_id: String,
    project_id: String,
    identifier: String,
) -> Result<LoadedPlaneWorkItemContext, String> {
    let (client, project) = plane_client_for(&app, &project_id)?;
    let detail = client.get_work_item(&identifier).await?;
    write_plane_work_item_context(&app, &project.name, &detail, &session_id)?;
    Ok(LoadedPlaneWorkItemContext {
        identifier: detail.item.identifier,
        title: detail.item.title,
        comment_count: detail.comments.len(),
        project_name: project.name,
        url: Some(detail.item.url),
    })
}

/// List the Plane work items loaded into a session (and its worktree)
pub async fn list_loaded_plane_work_item_contexts(
    app: AppHandle,
    session_id: String,
    worktree_id: Option<String>,
    project_id: String,
) -> Result<Vec<LoadedPlaneWorkItemContext>, String> {
    let project = load_project(&app, &project_id)?;
    Ok(
        loaded_context_files(&app, &session_id, worktree_id.as_deref(), &project.name)?
            .iter()
            .map(|(identifier, content)| {
                loaded_context_from_markdown(content, identifier, &project.name)
            })
            .collect(),
    )
}

/// Full markdown of each loaded Plane work item (for the context viewer)
pub async fn get_plane_work_item_context_contents(
    app: AppHandle,
    session_id: String,
    worktree_id: Option<String>,
    project_id: String,
) -> Result<Vec<PlaneWorkItemContextContent>, String> {
    let project = load_project(&app, &project_id)?;
    Ok(
        loaded_context_files(&app, &session_id, worktree_id.as_deref(), &project.name)?
            .into_iter()
            .map(|(identifier, content)| {
                let title =
                    loaded_context_from_markdown(&content, &identifier, &project.name).title;
                PlaneWorkItemContextContent {
                    identifier,
                    title,
                    content,
                }
            })
            .collect(),
    )
}

/// Remove a loaded Plane work item from a session
pub async fn remove_plane_work_item_context(
    app: AppHandle,
    session_id: String,
    project_id: String,
    identifier: String,
) -> Result<(), String> {
    let identifier = parse_plane_identifier(&identifier)
        .ok_or_else(|| format!("Invalid Plane work item identifier: {identifier}"))?;
    let project = load_project(&app, &project_id)?;
    let key = plane_ref_key(&project.name, &identifier);

    let mut refs = load_context_references(&app)?;
    let orphaned = match refs.plane.get_mut(&key) {
        Some(entry) => {
            entry.sessions.retain(|s| s != &session_id);
            entry.sessions.is_empty()
        }
        None => false,
    };
    if orphaned {
        refs.plane.remove(&key);
        let contexts_dir = get_github_contexts_dir(&app)?;
        let _ = std::fs::remove_file(plane_context_file(
            &contexts_dir,
            &project.name,
            &identifier,
        ));
    }
    save_context_references(&app, &refs)
}

/// Trim values, drop empty ones, and validate what is set.
fn normalize_plane_settings(
    settings: PlaneProjectSettings,
) -> Result<Option<PlaneProjectSettings>, String> {
    let clean = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let settings = PlaneProjectSettings {
        api_key: clean(settings.api_key),
        workspace_slug: clean(settings.workspace_slug),
        base_url: clean(settings.base_url),
        project_id: clean(settings.project_id),
    };
    if let Some(slug) = &settings.workspace_slug {
        if !is_valid_workspace_slug(slug) {
            return Err(
                "Plane workspace slug may contain only letters, digits, '-' and '_'".into(),
            );
        }
    }
    if let Some(url) = &settings.base_url {
        parse_plane_base_url(Some(url))?;
    }
    if let Some(id) = &settings.project_id {
        require_plane_id(id, "project")?;
    }
    Ok((settings != PlaneProjectSettings::default()).then_some(settings))
}

/// Replace the per-project Plane settings (empty values fall back to global settings)
pub async fn update_project_plane_settings(
    app: AppHandle,
    project_id: String,
    settings: PlaneProjectSettings,
) -> Result<Project, String> {
    let settings = normalize_plane_settings(settings)?;
    let mut data = load_projects_data(&app)?;
    let project = data
        .find_project_mut(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    project.plane = settings;
    let updated = project.clone();
    save_projects_data(&app, &data)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn cloud() -> reqwest::Url {
        parse_plane_base_url(None).unwrap()
    }

    #[test]
    fn parse_plane_identifier_normalizes_valid_identifiers() {
        assert_eq!(parse_plane_identifier("proj-12"), Some("PROJ-12".into()));
        assert_eq!(parse_plane_identifier("  WEB2-7 "), Some("WEB2-7".into()));
    }

    #[test]
    fn parse_plane_identifier_rejects_unsafe_or_malformed_input() {
        for input in [
            "",
            "PROJ",
            "PROJ-",
            "-12",
            "PROJ-0",
            "PROJ-+1",
            "PROJ-1a",
            "../x-1",
            "PR/OJ-1",
            "PROJ-1/../x",
            "ABCDEFGHIJKLM-1",
            "PR OJ-1",
        ] {
            assert_eq!(parse_plane_identifier(input), None, "{input}");
        }
    }

    #[test]
    fn base_url_defaults_to_cloud_and_strips_api_suffix() {
        assert_eq!(cloud().as_str(), "https://api.plane.so/");
        assert_eq!(
            parse_plane_base_url(Some(" https://plane.example.com/api/v1/ "))
                .unwrap()
                .as_str(),
            "https://plane.example.com/"
        );
        assert_eq!(
            parse_plane_base_url(Some("http://10.0.0.5:8080/plane/api?x=1#y"))
                .unwrap()
                .as_str(),
            "http://10.0.0.5:8080/plane"
        );
    }

    #[test]
    fn base_url_rejects_other_schemes_and_credentials() {
        for input in [
            "ftp://plane.example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "plane.example.com",
            "https://user:pass@plane.example.com",
        ] {
            assert!(parse_plane_base_url(Some(input)).is_err(), "{input}");
        }
    }

    #[test]
    fn api_urls_encode_segments_and_keep_base_path() {
        let base = parse_plane_base_url(Some("https://pm.example.com/plane")).unwrap();
        assert_eq!(
            plane_api_url(&base, "my-team", &["work-items", "PROJ-1"]).as_str(),
            "https://pm.example.com/plane/api/v1/workspaces/my-team/work-items/PROJ-1/"
        );
        assert_eq!(
            plane_api_url(&cloud(), "a b", &["projects"]).as_str(),
            "https://api.plane.so/api/v1/workspaces/a%20b/projects/"
        );
    }

    #[test]
    fn web_url_uses_app_host_on_cloud_and_same_host_when_self_hosted() {
        assert_eq!(
            plane_work_item_web_url(&cloud(), "acme", "PROJ-3"),
            "https://app.plane.so/acme/browse/PROJ-3"
        );
        let base = parse_plane_base_url(Some("https://plane.example.com")).unwrap();
        assert_eq!(
            plane_work_item_web_url(&base, "acme", "PROJ-3"),
            "https://plane.example.com/acme/browse/PROJ-3"
        );
    }

    #[test]
    fn branch_name_uses_plane_prefix() {
        assert_eq!(
            generate_branch_name_from_plane_work_item("PROJ-12", "Fix login bug"),
            format!("plane-proj-12-{}", slugify_issue_title("Fix login bug"))
        );
    }

    #[test]
    fn parse_work_item_reads_expanded_fields() {
        let node = json!({
            "id": "0f1e2d3c-aaaa-bbbb-cccc-000000000001",
            "sequence_id": 42,
            "name": "Crash on save",
            "description_html": "<p>Steps &amp; more</p><p>line 2</p>",
            "description_stripped": "",
            "priority": "high",
            "created_at": "2026-11-01T10:00:00Z",
            "state": { "name": "In Progress", "group": "started", "color": "#f59e0b" },
            "labels": [{ "name": "bug", "color": "#ff0000" }],
            "assignees": [{ "display_name": "ana", "first_name": "Ana", "last_name": "B" }]
        });
        let item = parse_work_item(&node, "proj", &cloud(), "acme").unwrap();
        assert_eq!(
            item,
            PlaneWorkItem {
                id: "0f1e2d3c-aaaa-bbbb-cccc-000000000001".into(),
                identifier: "PROJ-42".into(),
                title: "Crash on save".into(),
                description: Some("Steps & more\nline 2".into()),
                state: PlaneWorkItemState {
                    name: "In Progress".into(),
                    group: "started".into(),
                    color: "#f59e0b".into(),
                },
                labels: vec![PlaneLabel {
                    name: "bug".into(),
                    color: "#ff0000".into()
                }],
                assignee: Some(PlaneUser {
                    name: "Ana B".into(),
                    display_name: "ana".into()
                }),
                created_at: "2026-11-01T10:00:00Z".into(),
                url: "https://app.plane.so/acme/browse/PROJ-42".into(),
                priority: 2,
                priority_label: "High".into(),
            }
        );
    }

    #[test]
    fn parse_work_item_tolerates_unexpanded_ids() {
        let node = json!({
            "id": "abc", "sequence_id": 1, "name": "T",
            "state": "a-state-uuid", "labels": ["l1"], "assignees": ["u1"], "priority": "none"
        });
        let item = parse_work_item(&node, "PROJ", &cloud(), "acme").unwrap();
        assert_eq!(item.state, unknown_state());
        assert!(item.labels.is_empty());
        assert_eq!(item.assignee, None);
        assert_eq!(
            (item.priority, item.priority_label.as_str()),
            (0, "No priority")
        );
        assert_eq!(item.description, None);
    }

    #[test]
    fn work_item_detail_round_trips_through_frontend_json() {
        let detail = PlaneWorkItemDetail {
            item: parse_work_item(
                &json!({ "id": "abc", "sequence_id": 1, "name": "T" }),
                "PROJ",
                &cloud(),
                "acme",
            )
            .unwrap(),
            comments: vec![],
        };
        let value = serde_json::to_value(&detail).unwrap();
        assert_eq!(value["identifier"], "PROJ-1");
        assert_eq!(value["state"]["type"], "unstarted");
        assert_eq!(value["priorityLabel"], "No priority");
        let back: PlaneWorkItemDetail = serde_json::from_value(value).unwrap();
        assert_eq!(back, detail);
    }

    #[test]
    fn markdown_context_round_trips_title_comments_and_url() {
        let detail = PlaneWorkItemDetail {
            item: parse_work_item(
                &json!({ "id": "abc", "sequence_id": 9, "name": "Add: export", "description_stripped": "Desc" }),
                "PROJ",
                &cloud(),
                "acme",
            )
            .unwrap(),
            comments: vec![
                parse_comment(&json!({ "comment_html": "<p>first</p>", "actor_detail": { "display_name": "ana" } })).unwrap(),
                parse_comment(&json!({ "comment_stripped": "second", "actor": { "display_name": "bo" } })).unwrap(),
            ],
        };
        let markdown = format_plane_work_item_markdown(&detail);
        assert!(markdown.starts_with("# Plane Work Item PROJ-9: Add: export\n"));
        assert!(markdown.contains("### ana ()\n\nfirst"));
        assert_eq!(
            loaded_context_from_markdown(&markdown, "PROJ-9", "Jean"),
            LoadedPlaneWorkItemContext {
                identifier: "PROJ-9".into(),
                title: "Add: export".into(),
                comment_count: 2,
                project_name: "Jean".into(),
                url: Some("https://app.plane.so/acme/browse/PROJ-9".into()),
            }
        );
    }

    fn project_with(plane: Option<PlaneProjectSettings>) -> Project {
        let mut project: Project = serde_json::from_value(json!({
            "id": "p1", "name": "Jean", "path": "/tmp/jean", "default_branch": "main",
            "added_at": 0, "order": 0
        }))
        .unwrap();
        project.plane = plane;
        project
    }

    #[test]
    fn config_prefers_project_values_and_falls_back_to_global() {
        let prefs = crate::AppPreferences {
            plane_api_key: Some("global-key".into()),
            plane_workspace_slug: Some("global-ws".into()),
            plane_base_url: Some("https://plane.example.com".into()),
            ..Default::default()
        };

        let config = resolve_plane_config(&project_with(None), &prefs).unwrap();
        assert_eq!(config.api_key, "global-key");
        assert_eq!(config.workspace_slug, "global-ws");
        assert_eq!(config.base_url.as_str(), "https://plane.example.com/");
        assert_eq!(config.plane_project_id, None);

        let project = project_with(Some(PlaneProjectSettings {
            api_key: Some("project-key".into()),
            workspace_slug: Some(" ".into()),
            base_url: None,
            project_id: Some("0f1e2d3c-aaaa".into()),
        }));
        let config = resolve_plane_config(&project, &prefs).unwrap();
        assert_eq!(config.api_key, "project-key");
        assert_eq!(config.workspace_slug, "global-ws");
        assert_eq!(config.plane_project_id.as_deref(), Some("0f1e2d3c-aaaa"));
    }

    #[test]
    fn config_reports_missing_and_invalid_settings() {
        let mut prefs = crate::AppPreferences::default();
        let err = resolve_plane_config(&project_with(None), &prefs).unwrap_err();
        assert!(err.contains("No Plane API key"));
        prefs.plane_api_key = Some("k".into());
        let err = resolve_plane_config(&project_with(None), &prefs).unwrap_err();
        assert!(err.contains("No Plane workspace slug"));
        prefs.plane_workspace_slug = Some("../admin".into());
        assert!(resolve_plane_config(&project_with(None), &prefs).is_err());
        prefs.plane_workspace_slug = Some("acme".into());
        prefs.plane_base_url = Some("ftp://x".into());
        assert!(resolve_plane_config(&project_with(None), &prefs).is_err());
    }

    #[test]
    fn normalize_settings_drops_empty_values_and_validates() {
        assert_eq!(
            normalize_plane_settings(PlaneProjectSettings {
                api_key: Some("  ".into()),
                ..Default::default()
            }),
            Ok(None)
        );
        assert!(normalize_plane_settings(PlaneProjectSettings {
            project_id: Some("../x".into()),
            ..Default::default()
        })
        .is_err());
        assert!(normalize_plane_settings(PlaneProjectSettings {
            base_url: Some("javascript:alert(1)".into()),
            ..Default::default()
        })
        .is_err());
    }

    // ---- Mocked HTTP ----------------------------------------------------------

    struct MockPlane {
        base: reqwest::Url,
        requests: Arc<Mutex<Vec<String>>>,
    }

    /// Serve canned responses keyed by request path. Records each request head.
    async fn mock_plane(routes: Vec<(&'static str, u16, Value)>) -> MockPlane {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base =
            reqwest::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = vec![0u8; 16 * 1024];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let path = target.split('?').next().unwrap_or("").to_string();
                recorded.lock().unwrap().push(head);
                let (status, body) = routes
                    .iter()
                    .find(|(p, _, _)| *p == path)
                    .map(|(_, s, b)| (*s, b.to_string()))
                    .unwrap_or((404, "{}".into()));
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nLocation: http://evil.example/\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        MockPlane { base, requests }
    }

    fn client(base: &reqwest::Url, project_id: Option<&str>) -> PlaneClient {
        PlaneClient::new(PlaneConfig {
            api_key: "secret-key".into(),
            workspace_slug: "acme".into(),
            base_url: base.clone(),
            plane_project_id: project_id.map(str::to_string),
        })
    }

    const PID: &str = "aaaaaaaa-0000-0000-0000-000000000001";

    #[tokio::test]
    async fn list_work_items_sends_key_and_keeps_only_active_items() {
        let mock = mock_plane(vec![
            (
                "/api/v1/workspaces/acme/projects/aaaaaaaa-0000-0000-0000-000000000001/",
                200,
                json!({ "id": PID, "name": "Web", "identifier": "WEB" }),
            ),
            (
                "/api/v1/workspaces/acme/projects/aaaaaaaa-0000-0000-0000-000000000001/work-items/",
                200,
                json!({ "results": [
                    { "id": "b1", "sequence_id": 1, "name": "Open", "state": { "name": "Todo", "group": "unstarted", "color": "#000" } },
                    { "id": "b2", "sequence_id": 2, "name": "Done", "state": { "name": "Done", "group": "completed", "color": "#0f0" } }
                ], "next_cursor": "100:1:0" }),
            ),
        ])
        .await;

        let items = client(&mock.base, Some(PID))
            .list_work_items()
            .await
            .unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| i.identifier.as_str())
                .collect::<Vec<_>>(),
            vec!["WEB-1"]
        );
        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let list_request = requests[1].to_lowercase();
        assert!(list_request.contains("x-api-key: secret-key"));
        assert!(list_request.contains("expand=state%2clabels%2cassignees"));
    }

    #[tokio::test]
    async fn list_work_items_without_project_filter_reads_all_projects() {
        let mock = mock_plane(vec![
            (
                "/api/v1/workspaces/acme/projects/",
                200,
                json!({ "results": [
                    { "id": PID, "name": "Web", "identifier": "WEB" },
                    { "id": "aaaaaaaa-0000-0000-0000-000000000002", "name": "Old", "identifier": "OLD", "archived_at": "2026-01-01" }
                ] }),
            ),
            (
                "/api/v1/workspaces/acme/projects/aaaaaaaa-0000-0000-0000-000000000001/work-items/",
                200,
                json!([{ "id": "b1", "sequence_id": 5, "name": "Open" }]),
            ),
        ])
        .await;

        let items = client(&mock.base, None).list_work_items().await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].identifier, "WEB-5");
        assert_eq!(
            mock.requests.lock().unwrap().len(),
            2,
            "archived project skipped"
        );
    }

    #[tokio::test]
    async fn get_work_item_resolves_identifier_and_fetches_comments() {
        let mock = mock_plane(vec![
            (
                "/api/v1/workspaces/acme/work-items/WEB-7/",
                200,
                json!({ "id": "bbbbbbbb-0000-0000-0000-000000000007", "sequence_id": 7, "name": "Bug", "project": PID }),
            ),
            (
                "/api/v1/workspaces/acme/projects/aaaaaaaa-0000-0000-0000-000000000001/work-items/bbbbbbbb-0000-0000-0000-000000000007/comments/",
                200,
                // Real v1 shape: newest first, `comment_stripped` excluded, actor expanded.
                json!({ "next_cursor": "100:1:0", "results": [
                    { "comment_html": "<p>Fixed &amp; deployed</p>", "created_at": "2026-11-03T09:00:00Z", "actor": { "display_name": "bo" } },
                    { "comment_html": "<p></p>", "created_at": "2026-11-02T12:00:00Z" },
                    { "comment_html": "<p>Repro attached</p>", "created_at": "2026-11-02T10:00:00Z", "actor": { "display_name": "ana", "first_name": "", "last_name": "" } }
                ] }),
            ),
        ])
        .await;

        let detail = client(&mock.base, None)
            .get_work_item("web-7")
            .await
            .unwrap();
        assert_eq!(detail.item.identifier, "WEB-7");
        assert_eq!(
            detail.comments,
            vec![
                PlaneComment {
                    body: "Repro attached".into(),
                    user: Some(PlaneUser {
                        name: "ana".into(),
                        display_name: "ana".into()
                    }),
                    created_at: "2026-11-02T10:00:00Z".into(),
                },
                PlaneComment {
                    body: "Fixed & deployed".into(),
                    user: Some(PlaneUser {
                        name: "bo".into(),
                        display_name: "bo".into()
                    }),
                    created_at: "2026-11-03T09:00:00Z".into(),
                },
            ]
        );
        let comment_request = mock.requests.lock().unwrap()[1].clone();
        assert!(comment_request.contains("expand=actor"));
    }

    #[tokio::test]
    async fn get_work_item_rejects_bad_identifier_without_a_request() {
        let mock = mock_plane(vec![]).await;
        let err = client(&mock.base, None)
            .get_work_item("../../projects")
            .await
            .unwrap_err();
        assert!(err.contains("Invalid Plane work item identifier"));
        assert!(mock.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn search_maps_hits_to_work_items() {
        let mock = mock_plane(vec![(
            "/api/v1/workspaces/acme/work-items/search/",
            200,
            json!({ "issues": [{ "id": "c1", "name": "Login", "sequence_id": 3, "project__identifier": "WEB" }] }),
        )])
        .await;
        let items = client(&mock.base, Some(PID)).search("login").await.unwrap();
        assert_eq!(items[0].identifier, "WEB-3");
        assert_eq!(items[0].title, "Login");
        let request = mock.requests.lock().unwrap()[0].clone();
        assert!(request.contains("search=login"));
        assert!(request.contains(&format!("project_id={PID}")));
    }

    #[tokio::test]
    async fn errors_never_contain_the_api_key_and_redirects_are_not_followed() {
        let mock = mock_plane(vec![
            (
                "/api/v1/workspaces/acme/projects/",
                401,
                json!({ "detail": "bad" }),
            ),
            ("/api/v1/workspaces/acme/work-items/search/", 302, json!({})),
        ])
        .await;
        let plane = client(&mock.base, None);
        let err = plane.list_projects().await.unwrap_err();
        assert!(err.contains("Plane API key is invalid"));
        assert!(!err.contains("secret-key"));
        let err = plane.search("x").await.unwrap_err();
        assert!(err.contains("redirected"));
        assert_eq!(mock.requests.lock().unwrap().len(), 2);
    }
}
