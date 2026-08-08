//! Configuration and path resolution for Devin CLI.

use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

pub const CLI_DIR_NAME: &str = "devin-cli";

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_NAME: &str = "devin.cmd";
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_NAME: &str = "devin";

#[cfg(windows)]
const MANAGED_CANDIDATES: &[&str] = &["devin.cmd", "devin.exe", "devin.bat"];
#[cfg(not(windows))]
const MANAGED_CANDIDATES: &[&str] = &["devin"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourcePreference {
    Jean,
    Path,
    Missing,
}

pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CLI_DIR_NAME))
        .map_err(|error| format!("Failed to get app data directory: {error}"))
}

pub fn ensure_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_cli_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create Devin CLI directory: {error}"))?;
    Ok(dir)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join(MANAGED_CLI_BINARY_NAME))
}

fn find_managed_binary(app: &AppHandle) -> Option<PathBuf> {
    let dir = get_cli_dir(app).ok()?;
    MANAGED_CANDIDATES
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.exists())
}

pub fn find_system_devin_binary(app: &AppHandle) -> Option<PathBuf> {
    let managed = find_managed_binary(app)
        .or_else(|| get_cli_binary_path(app).ok())
        .and_then(|path| std::fs::canonicalize(path).ok());
    crate::platform::detect_cli_in_path("devin", managed.as_deref(), None)
        .path
        .map(PathBuf::from)
}

fn source_preference(app: &AppHandle) -> SourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|value| value.get("devin_cli_source").cloned())
        .map(|value| {
            if value.as_str() == Some("jean") {
                SourcePreference::Jean
            } else {
                SourcePreference::Path
            }
        })
        .unwrap_or(SourcePreference::Missing)
}

/// Prefer the official PATH install by default; use the app-data path only when
/// explicitly selected or when no source preference exists and PATH is missing.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let system = find_system_devin_binary(app);
    match source_preference(app) {
        SourcePreference::Path => system.unwrap_or_else(|| PathBuf::from("devin")),
        SourcePreference::Missing if system.is_some() => system.unwrap_or_default(),
        SourcePreference::Jean | SourcePreference::Missing => find_managed_binary(app)
            .or_else(|| get_cli_binary_path(app).ok())
            .unwrap_or_else(|| PathBuf::from("devin")),
    }
}

pub fn binary_exists(path: &PathBuf) -> bool {
    if path.is_absolute() {
        path.exists()
    } else {
        which::which(path).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_binary_uses_devin_name() {
        assert_eq!(MANAGED_CLI_BINARY_NAME.split('.').next(), Some("devin"));
    }
}
