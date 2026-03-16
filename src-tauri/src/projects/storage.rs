use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};

use super::types::ProjectsData;

/// Global mutex to prevent concurrent read-modify-write races on projects.json.
/// Multiple threads (e.g., fetch_worktrees_status) can call save_projects_data simultaneously,
/// causing race conditions with the atomic write pattern (temp file + rename).
static PROJECTS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Get the path to the projects.json data file
pub fn get_projects_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    // Ensure the directory exists
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    Ok(app_data_dir.join("projects.json"))
}

/// Get the base directory for all worktrees (~/jean)
pub fn get_worktrees_base_dir() -> Result<PathBuf, String> {
    let home_dir = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;

    let jean_dir = home_dir.join("jean");

    // Ensure the directory exists
    std::fs::create_dir_all(&jean_dir)
        .map_err(|e| format!("Failed to create jean directory: {e}"))?;

    Ok(jean_dir)
}

/// Get the directory for a specific project's worktrees.
/// When `custom_base_dir` is Some, uses that instead of ~/jean as the base.
/// In both cases, `<project-name>` subdirectory is appended.
pub fn get_project_worktrees_dir(
    project_name: &str,
    custom_base_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let base_dir = match custom_base_dir {
        Some(dir) => PathBuf::from(dir),
        None => get_worktrees_base_dir()?,
    };
    let project_dir = base_dir.join(sanitize_directory_name(project_name));

    // Ensure the directory exists
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create project worktrees directory: {e}"))?;

    Ok(project_dir)
}

/// Sanitize a string for use as a directory name
pub fn sanitize_directory_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Load projects data from disk (internal, no locking)
fn load_projects_data_internal(app: &AppHandle) -> Result<ProjectsData, String> {
    log::trace!("Loading projects data from disk");
    let path = get_projects_path(app)?;

    if !path.exists() {
        log::trace!("Projects file not found, returning empty data");
        return Ok(ProjectsData::default());
    }

    let contents = std::fs::read_to_string(&path).map_err(|e| {
        log::error!("Failed to read projects file: {e}");
        format!("Failed to read projects file: {e}")
    })?;

    let data: ProjectsData = serde_json::from_str(&contents).map_err(|e| {
        log::error!("Failed to parse projects JSON: {e}");
        format!("Failed to parse projects data: {e}")
    })?;

    let original_count = data.worktrees.len();

    // Filter out worktrees where path doesn't exist on disk
    // Skip recently created worktrees (< 5 min) - they may still be initializing in a background thread
    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let five_minutes_ago = now_ts.saturating_sub(300);

    let valid_worktrees: Vec<_> = data
        .worktrees
        .into_iter()
        .filter(|w| {
            let exists = std::path::Path::new(&w.path).exists();
            if !exists {
                if w.created_at > five_minutes_ago {
                    log::trace!(
                        "Keeping recently created worktree '{}' - path doesn't exist yet (created {}s ago)",
                        w.name,
                        now_ts - w.created_at
                    );
                    return true;
                }
                log::warn!(
                    "Removing orphaned worktree '{}' - path does not exist: {}",
                    w.name,
                    w.path
                );
            }
            exists
        })
        .collect();

    let removed_count = original_count - valid_worktrees.len();

    let data = ProjectsData {
        projects: data.projects,
        worktrees: valid_worktrees,
    };

    // Save cleaned data if any orphans were removed
    if removed_count > 0 {
        log::trace!("Cleaned up {removed_count} orphaned worktree(s)");
        save_projects_data_internal(app, &data)?;
    }

    log::trace!(
        "Loaded {} projects and {} worktrees",
        data.projects.len(),
        data.worktrees.len()
    );
    Ok(data)
}

/// Load projects data from disk (with locking for thread safety)
pub fn load_projects_data(app: &AppHandle) -> Result<ProjectsData, String> {
    let _lock = PROJECTS_LOCK.lock().unwrap();
    load_projects_data_internal(app)
}

/// Save projects data to disk (internal, no locking - atomic write: temp file + rename)
fn save_projects_data_internal(app: &AppHandle, data: &ProjectsData) -> Result<(), String> {
    log::trace!("Saving projects data to disk");
    let path = get_projects_path(app)?;

    let json_content = serde_json::to_string_pretty(data).map_err(|e| {
        log::error!("Failed to serialize projects data: {e}");
        format!("Failed to serialize projects data: {e}")
    })?;

    // Write to a temporary file first, then rename (atomic operation)
    let temp_path = path.with_extension("tmp");

    std::fs::write(&temp_path, json_content).map_err(|e| {
        log::error!("Failed to write projects file: {e}");
        format!("Failed to write projects file: {e}")
    })?;

    std::fs::rename(&temp_path, &path).map_err(|e| {
        log::error!("Failed to finalize projects file: {e}");
        format!("Failed to finalize projects file: {e}")
    })?;

    log::trace!(
        "Saved {} projects and {} worktrees to {path:?}",
        data.projects.len(),
        data.worktrees.len()
    );
    Ok(())
}

/// Save projects data to disk (with locking for thread safety)
pub fn save_projects_data(app: &AppHandle, data: &ProjectsData) -> Result<(), String> {
    let _lock = PROJECTS_LOCK.lock().unwrap();
    save_projects_data_internal(app, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_directory_name() {
        assert_eq!(sanitize_directory_name("my-project"), "my-project");
        assert_eq!(sanitize_directory_name("my project"), "my-project");
        assert_eq!(sanitize_directory_name("my/project"), "my-project");
        assert_eq!(sanitize_directory_name("my_project"), "my_project");
        assert_eq!(sanitize_directory_name("MyProject123"), "MyProject123");
    }
}
