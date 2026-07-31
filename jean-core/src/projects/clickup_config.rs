//! ClickUp integration configuration, stored in an isolated sidecar JSON file
//! (`<app_data>/clickup/config.json`) so the feature never touches the shared
//! `AppPreferences` / `Project` structs and stays conflict-free on merge-forward.
//!
//! Holds the personal API token (global + optional per-project override) and the
//! ClickUp list ids used to browse/pick tasks (Planexpo + Sprint).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

/// Persisted ClickUp configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpConfig {
    /// Global personal API token (starts with `pk_`).
    #[serde(default)]
    pub token: Option<String>,
    /// Per-project token override: `project_id` -> token.
    #[serde(default)]
    pub project_tokens: HashMap<String, String>,
    /// Default list id used to browse/pick tasks (e.g. the Planexpo list).
    #[serde(default)]
    pub planexpo_list_id: Option<String>,
    /// Secondary list id (the Sprint list) used to browse/pick tasks.
    #[serde(default)]
    pub sprint_list_id: Option<String>,
    /// Endpoint returning the full Git SHA currently served in production.
    #[serde(default)]
    pub production_version_url: Option<String>,
}

/// Directory holding the ClickUp sidecar files.
pub fn get_clickup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?
        .join("clickup");
    Ok(dir)
}

/// Load a JSON sidecar file from the ClickUp dir, returning `T::default()` when
/// the file is absent. Shared by the config and link stores.
pub fn load_sidecar<T: DeserializeOwned + Default>(
    app: &AppHandle,
    filename: &str,
) -> Result<T, String> {
    let path: PathBuf = get_clickup_dir(app)?.join(filename);
    if !path.exists() {
        return Ok(T::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read ClickUp {filename}: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse ClickUp {filename}: {e}"))
}

/// Persist a value as a JSON sidecar file in the ClickUp dir (creating it).
pub fn save_sidecar<T: Serialize>(
    app: &AppHandle,
    filename: &str,
    value: &T,
) -> Result<(), String> {
    let dir = get_clickup_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ClickUp directory: {e}"))?;
    let content = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize ClickUp {filename}: {e}"))?;
    std::fs::write(dir.join(filename), content)
        .map_err(|e| format!("Failed to write ClickUp {filename}: {e}"))
}

/// Load the ClickUp config from disk, returning defaults when absent.
pub fn load_clickup_config(app: &AppHandle) -> Result<ClickUpConfig, String> {
    load_sidecar(app, "config.json")
}

/// Persist the ClickUp config to disk (creating the directory if needed).
pub fn save_clickup_config(app: &AppHandle, config: &ClickUpConfig) -> Result<(), String> {
    save_sidecar(app, "config.json", config)
}

/// Resolve the effective token from a config: per-project override wins over the
/// global token. Pure helper so it can be unit-tested without disk access.
pub fn resolve_token_from_config(
    config: &ClickUpConfig,
    project_id: Option<&str>,
) -> Option<String> {
    if let Some(pid) = project_id {
        if let Some(t) = config
            .project_tokens
            .get(pid)
            .filter(|t| !t.trim().is_empty())
        {
            return Some(t.clone());
        }
    }
    config
        .token
        .as_ref()
        .filter(|t| !t.trim().is_empty())
        .cloned()
}

/// Resolve the effective token for a project (falling back to the global token).
pub fn resolve_clickup_token(app: &AppHandle, project_id: Option<&str>) -> Result<String, String> {
    let config = load_clickup_config(app)?;
    resolve_token_from_config(&config, project_id).ok_or_else(|| {
        "No ClickUp API token configured. Add one in Settings → Integrations.".to_string()
    })
}

// =============================================================================
// Tauri commands
// =============================================================================

/// Return the current ClickUp config (token included, like the Linear key field).
pub async fn get_clickup_config(app: AppHandle) -> Result<ClickUpConfig, String> {
    load_clickup_config(&app)
}

/// Update the global token and list ids (Planexpo + Sprint). `None` clears a value.
pub async fn set_clickup_config(
    app: AppHandle,
    token: Option<String>,
    planexpo_list_id: Option<String>,
    sprint_list_id: Option<String>,
    production_version_url: Option<String>,
) -> Result<(), String> {
    let mut config = load_clickup_config(&app)?;
    config.token = token.filter(|t| !t.trim().is_empty());
    config.planexpo_list_id = planexpo_list_id.filter(|t| !t.trim().is_empty());
    config.sprint_list_id = sprint_list_id.filter(|t| !t.trim().is_empty());
    config.production_version_url = production_version_url.filter(|t| !t.trim().is_empty());
    save_clickup_config(&app, &config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with(global: Option<&str>, project: &[(&str, &str)]) -> ClickUpConfig {
        ClickUpConfig {
            token: global.map(|s| s.to_string()),
            project_tokens: project
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            planexpo_list_id: None,
            sprint_list_id: None,
            production_version_url: None,
        }
    }

    #[test]
    fn project_override_wins_over_global() {
        let cfg = config_with(Some("pk_global"), &[("proj1", "pk_project")]);
        assert_eq!(
            resolve_token_from_config(&cfg, Some("proj1")),
            Some("pk_project".to_string())
        );
    }

    #[test]
    fn falls_back_to_global_when_no_project_override() {
        let cfg = config_with(Some("pk_global"), &[("other", "pk_other")]);
        assert_eq!(
            resolve_token_from_config(&cfg, Some("proj1")),
            Some("pk_global".to_string())
        );
    }

    #[test]
    fn global_used_when_project_id_absent() {
        let cfg = config_with(Some("pk_global"), &[]);
        assert_eq!(
            resolve_token_from_config(&cfg, None),
            Some("pk_global".to_string())
        );
    }

    #[test]
    fn empty_tokens_are_ignored() {
        let cfg = config_with(Some("   "), &[("proj1", "")]);
        assert_eq!(resolve_token_from_config(&cfg, Some("proj1")), None);
    }

    #[test]
    fn none_when_no_token_configured() {
        let cfg = config_with(None, &[]);
        assert_eq!(resolve_token_from_config(&cfg, Some("proj1")), None);
    }
}
