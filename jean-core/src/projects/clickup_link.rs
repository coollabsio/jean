//! Links a Jean worktree to a ClickUp task.
//!
//! Resolution order (isolated, no change to the shared `Worktree` struct):
//!   1. Manual override stored in the sidecar `<app_data>/clickup/links.json`.
//!   2. The branch-name convention `CU-<taskId>-<description>` (feature-flow).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;

use super::clickup_config::{load_sidecar, save_sidecar};
use super::storage::load_projects_data;

/// Parse the ClickUp task id out of a branch named `CU-<taskId><sep><description>`.
///
/// The prefix match is case-insensitive (`CU-` / `cu-`); the task id is the
/// leading alphanumeric run after the prefix. ClickUp task ids are alphanumeric
/// (e.g. `86caa8btx`), so the id ends at the first non-alphanumeric character —
/// this covers both the `-` separator (`CU-<id>-desc`) and the `__` separator
/// the pipeline also emits (`CU-<id>__desc`). Returns `None` for non-matching
/// branches.
pub fn parse_clickup_task_id_from_branch(branch: &str) -> Option<String> {
    let rest = branch
        .strip_prefix("CU-")
        .or_else(|| branch.strip_prefix("cu-"))?;

    let id: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Manual worktree → task id overrides.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClickUpLinks {
    /// `worktree_id` -> `task_id`.
    #[serde(default)]
    pub links: HashMap<String, String>,
}

fn load_clickup_links(app: &AppHandle) -> Result<ClickUpLinks, String> {
    load_sidecar(app, "links.json")
}

/// Resolve a task id from a worktree record without another projects.json read.
pub fn clickup_task_id_for_worktree(
    app: &AppHandle,
    worktree: &super::types::Worktree,
) -> Result<Option<String>, String> {
    let links = load_clickup_links(app)?;
    Ok(links
        .links
        .get(&worktree.id)
        .cloned()
        .or_else(|| parse_clickup_task_id_from_branch(&worktree.branch)))
}

fn save_clickup_links(app: &AppHandle, links: &ClickUpLinks) -> Result<(), String> {
    save_sidecar(app, "links.json", links)
}

// =============================================================================
// Tauri commands
// =============================================================================

/// Resolve the ClickUp task id for a worktree: manual override first, then the
/// `CU-<id>` branch convention. Returns `None` when nothing is linked.
pub async fn resolve_clickup_task_for_worktree(
    app: AppHandle,
    worktree_id: String,
) -> Result<Option<String>, String> {
    let data = load_projects_data(&app)?;
    if let Some(worktree) = data.find_worktree(&worktree_id) {
        return clickup_task_id_for_worktree(&app, worktree);
    }

    Ok(None)
}

/// Manually link a worktree to a ClickUp task (overrides the branch convention).
pub async fn set_clickup_link(
    app: AppHandle,
    worktree_id: String,
    task_id: String,
) -> Result<(), String> {
    let mut links = load_clickup_links(&app)?;
    links.links.insert(worktree_id, task_id);
    save_clickup_links(&app, &links)
}

/// Remove a manual link (resolution falls back to the branch convention).
pub async fn clear_clickup_link(app: AppHandle, worktree_id: String) -> Result<(), String> {
    let mut links = load_clickup_links(&app)?;
    links.links.remove(&worktree_id);
    save_clickup_links(&app, &links)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_branch() {
        assert_eq!(
            parse_clickup_task_id_from_branch("CU-86caa8btx-fix-contrat-readonly"),
            Some("86caa8btx".to_string())
        );
    }

    #[test]
    fn parses_branch_without_description() {
        assert_eq!(
            parse_clickup_task_id_from_branch("CU-86caa8btx"),
            Some("86caa8btx".to_string())
        );
    }

    #[test]
    fn parses_double_underscore_separator() {
        // The pipeline also emits `CU-<id>__<slug>` branches.
        assert_eq!(
            parse_clickup_task_id_from_branch("CU-86c997enp__national-id-and-exhibitor-profile"),
            Some("86c997enp".to_string())
        );
    }

    #[test]
    fn parses_lowercase_prefix() {
        assert_eq!(
            parse_clickup_task_id_from_branch("cu-abc123-something"),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn returns_none_for_non_cu_branch() {
        assert_eq!(parse_clickup_task_id_from_branch("feature/login"), None);
        assert_eq!(parse_clickup_task_id_from_branch("linear-eng-123-x"), None);
        assert_eq!(parse_clickup_task_id_from_branch("main"), None);
    }

    #[test]
    fn returns_none_for_empty_id() {
        assert_eq!(parse_clickup_task_id_from_branch("CU--desc"), None);
        assert_eq!(parse_clickup_task_id_from_branch("CU-"), None);
    }
}
