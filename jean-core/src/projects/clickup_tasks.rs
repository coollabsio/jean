//! ClickUp task commands: fetch a task, change its status, self-assign, browse a
//! list, and expose the hard-coded Planexpo status transitions.
//!
//! All types mirror the ClickUp REST API v2 and serialize as `camelCase` for the
//! frontend. Docs: https://developer.clickup.com/reference

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::clickup_client::{clickup_get, clickup_put};
use super::clickup_config::{
    load_clickup_config, resolve_clickup_token, resolve_token_from_config,
};

// =============================================================================
// Types (mirror the ClickUp API, extra fields ignored by serde)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpStatus {
    pub status: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(rename = "type", default)]
    pub status_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpAssignee {
    pub id: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub profile_picture: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpTask {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub status: Option<ClickUpStatus>,
    #[serde(default)]
    pub assignees: Vec<ClickUpAssignee>,
    #[serde(default)]
    pub url: Option<String>,
    /// Tags carried by the task (`ai-done`, `ai-escalade`, …). The API sends
    /// them as objects, hence the dedicated struct.
    #[serde(default)]
    pub tags: Vec<ClickUpTag>,
    /// Priority object (`{ "priority": "high", … }`) or `null`.
    #[serde(default)]
    pub priority: Option<ClickUpPriority>,
    /// Last update, epoch milliseconds as a string. The API key is snake_case,
    /// so it is renamed explicitly (this struct is otherwise camelCase).
    #[serde(default, rename = "date_updated")]
    pub date_updated: Option<String>,
    /// Due date, epoch milliseconds as a string.
    #[serde(default, rename = "due_date")]
    pub due_date: Option<String>,
}

/// A ClickUp tag (only the name matters to us).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpTag {
    pub name: String,
}

/// A ClickUp priority (`urgent` | `high` | `normal` | `low`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpPriority {
    pub priority: String,
}

/// The authenticated ClickUp user (from `GET /user`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpMe {
    pub id: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub profile_picture: Option<String>,
}

/// A selectable status transition shown in the UI dropdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpStatusOption {
    /// Status value sent to the ClickUp API (must match the space's status name).
    pub value: String,
    /// Human-friendly label for the dropdown.
    pub label: String,
}

/// Hard-coded status transitions (`value`, `label`).
///
/// `value` is the exact status name as configured in the project's ClickUp
/// space. The workspace/list ids are entered in Settings and stored in local
/// config — never hardcoded here. `label` is the uppercased display form.
/// Order matches the space's `orderindex`.
const PLANEXPO_STATUSES: &[(&str, &str)] = &[
    ("backlog", "BACKLOG"),
    ("shortlist", "SHORTLIST"),
    ("refining", "REFINING"),
    ("ready", "READY"),
    ("need spec", "NEED SPEC"),
    ("todo", "TODO"),
    ("on standby", "ON STANDBY"),
    ("in progress ia", "IN PROGRESS IA"),
    ("in progress", "IN PROGRESS"),
    ("stuck", "STUCK"),
    ("to review", "TO REVIEW"),
    ("in review", "IN REVIEW"),
    ("to deploy", "TO DEPLOY"),
    ("test failed", "TEST FAILED"),
    ("Closed", "CLOSED"),
];

fn planexpo_status_options() -> Vec<ClickUpStatusOption> {
    PLANEXPO_STATUSES
        .iter()
        .map(|(value, label)| ClickUpStatusOption {
            value: value.to_string(),
            label: label.to_string(),
        })
        .collect()
}

// =============================================================================
// Parsing helpers
// =============================================================================

fn parse_task(value: serde_json::Value) -> Result<ClickUpTask, String> {
    serde_json::from_value(value).map_err(|e| format!("Failed to parse ClickUp task: {e}"))
}

// =============================================================================
// Tauri commands
// =============================================================================

/// Fetch a single ClickUp task by id.
pub async fn get_clickup_task(
    app: AppHandle,
    task_id: String,
    project_id: Option<String>,
) -> Result<ClickUpTask, String> {
    let token = resolve_clickup_token(&app, project_id.as_deref())?;
    let value = clickup_get(&token, &format!("/task/{task_id}")).await?;
    parse_task(value)
}

/// Change a task's status. `status` must match the space's status name.
pub async fn update_clickup_task_status(
    app: AppHandle,
    task_id: String,
    status: String,
    project_id: Option<String>,
) -> Result<ClickUpTask, String> {
    let token = resolve_clickup_token(&app, project_id.as_deref())?;
    let body = serde_json::json!({ "status": status });
    let value = clickup_put(&token, &format!("/task/{task_id}"), body).await?;
    parse_task(value)
}

/// Add the authenticated user to a task's assignees.
pub async fn assign_clickup_task_to_me(
    app: AppHandle,
    task_id: String,
    project_id: Option<String>,
) -> Result<ClickUpTask, String> {
    let token = resolve_clickup_token(&app, project_id.as_deref())?;
    let me = fetch_me(&token).await?;
    let body = serde_json::json!({ "assignees": { "add": [me.id], "rem": [] } });
    let value = clickup_put(&token, &format!("/task/{task_id}"), body).await?;
    parse_task(value)
}

/// Return the authenticated ClickUp user.
pub async fn get_clickup_me(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<ClickUpMe, String> {
    let token = resolve_clickup_token(&app, project_id.as_deref())?;
    fetch_me(&token).await
}

async fn fetch_me(token: &str) -> Result<ClickUpMe, String> {
    let value = clickup_get(token, "/user").await?;
    let user = value
        .get("user")
        .cloned()
        .ok_or_else(|| "ClickUp /user response missing 'user' field".to_string())?;
    serde_json::from_value(user).map_err(|e| format!("Failed to parse ClickUp user: {e}"))
}

/// Browse tasks in a list (defaults to the configured Planexpo list) for the
/// manual link picker.
pub async fn list_clickup_tasks(
    app: AppHandle,
    list_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<ClickUpTask>, String> {
    // Load the config once and derive both the token and the default list id
    // from it (avoids reading config.json twice).
    let config = load_clickup_config(&app)?;
    let token = resolve_token_from_config(&config, project_id.as_deref()).ok_or_else(|| {
        "No ClickUp API token configured. Add one in Settings → Integrations.".to_string()
    })?;

    let list_id = match list_id.filter(|l| !l.trim().is_empty()) {
        Some(l) => l,
        None => config.planexpo_list_id.ok_or_else(|| {
            "No ClickUp list configured. Set a list id in Settings → Integrations.".to_string()
        })?,
    };

    let value = clickup_get(&token, &format!("/list/{list_id}/task")).await?;
    let tasks = value
        .get("tasks")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(tasks
        .into_iter()
        .filter_map(|t| serde_json::from_value(t).ok())
        .collect())
}

/// Return the hard-coded Planexpo status transitions for the UI dropdown.
pub fn get_clickup_status_options() -> Vec<ClickUpStatusOption> {
    planexpo_status_options()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_options_are_non_empty_and_well_formed() {
        let options = planexpo_status_options();
        assert!(!options.is_empty());
        assert!(options.iter().any(|o| o.value == "to deploy"));
        assert!(options.iter().any(|o| o.value == "in progress"));
        // No empty values/labels.
        assert!(options
            .iter()
            .all(|o| !o.value.is_empty() && !o.label.is_empty()));
    }

    #[test]
    fn parses_task_ignoring_extra_fields() {
        let value = serde_json::json!({
            "id": "86caa8btx",
            "name": "Fix the thing",
            "status": { "status": "in progress", "color": "#abc", "type": "custom" },
            "assignees": [
                { "id": 302498824, "username": "Farès", "email": "f@x.fr", "color": "#fff" }
            ],
            "url": "https://app.clickup.com/t/86caa8btx",
            "some_unknown_field": { "nested": true }
        });
        let task = parse_task(value).expect("should parse");
        assert_eq!(task.id, "86caa8btx");
        assert_eq!(task.name, "Fix the thing");
        assert_eq!(task.status.unwrap().status, "in progress");
        assert_eq!(task.assignees.len(), 1);
        assert_eq!(task.assignees[0].id, 302498824);
    }

    #[test]
    fn parses_task_with_missing_optional_fields() {
        let value = serde_json::json!({ "id": "x1", "name": "Bare task" });
        let task = parse_task(value).expect("should parse");
        assert!(task.status.is_none());
        assert!(task.assignees.is_empty());
        assert!(task.url.is_none());
    }
}
