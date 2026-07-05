//! Configuration and path resolution for the Antigravity CLI.

use crate::platform::get_wsl_config;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const CLI_DIR_NAME: &str = "antigravity-cli";

#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "agy.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "agy";

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_NAME: &str = "agy.exe";
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_NAME: &str = CLI_BINARY_NAME;

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_CANDIDATES: &[&str] = &["agy.exe", "agy.bat", "agy.cmd"];
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_CANDIDATES: &[&str] = &[CLI_BINARY_NAME];

pub const CLI_TOOL_CANDIDATES: &[&str] = &["agy"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravitySourcePreference {
    ExplicitJean,
    ExplicitPath,
    Missing,
}

pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(CLI_DIR_NAME))
}

pub fn ensure_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create Antigravity CLI directory: {e}"))?;
    Ok(cli_dir)
}

pub fn managed_binary_path_from_dir(cli_dir: PathBuf) -> PathBuf {
    // Under Jean-managed install, agy lives directly in the cli_dir (not in node_modules)
    cli_dir.join(MANAGED_CLI_BINARY_NAME)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_binary_path_from_dir(get_cli_dir(app)?))
}

pub fn managed_binary_candidates_from_dir(cli_dir: PathBuf) -> Vec<PathBuf> {
    MANAGED_CLI_BINARY_CANDIDATES
        .iter()
        .map(|candidate| cli_dir.join(candidate))
        .collect()
}

pub fn find_managed_antigravity_binary(app: &AppHandle) -> Option<PathBuf> {
    let cli_dir = get_cli_dir(app).ok()?;
    managed_binary_candidates_from_dir(cli_dir)
        .into_iter()
        .find(|path| path.exists())
}

fn source_preference_from_value(value: &Value) -> AntigravitySourcePreference {
    match value.get("antigravity_cli_source") {
        Some(value) if value.as_str() == Some("path") => AntigravitySourcePreference::ExplicitPath,
        Some(_) => AntigravitySourcePreference::ExplicitJean,
        None => AntigravitySourcePreference::Missing,
    }
}

fn read_source_preference(app: &AppHandle) -> AntigravitySourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|prefs_path| std::fs::read_to_string(prefs_path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .map(|value| source_preference_from_value(&value))
        .unwrap_or(AntigravitySourcePreference::Missing)
}

pub fn should_use_system_path(
    source_preference: AntigravitySourcePreference,
    system_agy_found: bool,
) -> bool {
    match source_preference {
        AntigravitySourcePreference::ExplicitPath => system_agy_found,
        AntigravitySourcePreference::ExplicitJean => false,
        AntigravitySourcePreference::Missing => system_agy_found,
    }
}

pub fn find_system_antigravity_binary(app: &AppHandle) -> Option<PathBuf> {
    let jean_managed_path = find_managed_antigravity_binary(app)
        .or_else(|| get_cli_binary_path(app).ok())
        .and_then(|path| std::fs::canonicalize(path).ok());

    for candidate in CLI_TOOL_CANDIDATES {
        let detection =
            crate::platform::detect_cli_in_path(candidate, jean_managed_path.as_deref(), None);
        if detection.found {
            if let Some(path) = detection.path {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// Resolve the Antigravity binary based on the user's source preference.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, "agy", None) {
            return PathBuf::from(unix_path);
        }
        return PathBuf::from(CLI_BINARY_NAME);
    }

    let source_preference = read_source_preference(app);
    let system_path = find_system_antigravity_binary(app);

    if should_use_system_path(source_preference, system_path.is_some()) {
        if let Some(path) = system_path {
            return path;
        }
    }

    if source_preference == AntigravitySourcePreference::ExplicitPath {
        log::warn!("antigravity_cli_source is 'path' but Antigravity was not found in PATH; falling back to Jean-managed binary");
    }

    find_managed_antigravity_binary(app).unwrap_or_else(|| {
        get_cli_binary_path(app)
            .unwrap_or_else(|_| PathBuf::from(CLI_DIR_NAME).join(MANAGED_CLI_BINARY_NAME))
    })
}

pub fn binary_exists(path: &PathBuf) -> bool {
    if path.is_absolute() {
        path.exists()
    } else {
        let wsl = get_wsl_config();
        if wsl.enabled {
            crate::platform::check_wsl_tool(&wsl.distro, &path.to_string_lossy())
        } else {
            which::which(path).is_ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_agy_binary_name() {
        assert!(PathBuf::from(CLI_BINARY_NAME).ends_with(CLI_BINARY_NAME));
    }

    #[test]
    fn managed_path_points_to_cli_dir() {
        let path = managed_binary_path_from_dir(PathBuf::from("/tmp/jean/antigravity-cli"));
        assert!(path.ends_with(PathBuf::from(MANAGED_CLI_BINARY_NAME)));
    }

    #[test]
    fn managed_candidates_are_separate_from_path_tool_names() {
        assert!(MANAGED_CLI_BINARY_CANDIDATES.contains(&MANAGED_CLI_BINARY_NAME));
        assert_eq!(CLI_TOOL_CANDIDATES, &["agy"]);
    }

    #[test]
    fn explicit_jean_source_never_uses_system_path() {
        assert!(!should_use_system_path(
            AntigravitySourcePreference::ExplicitJean,
            true
        ));
        assert!(!should_use_system_path(
            AntigravitySourcePreference::ExplicitJean,
            false
        ));
    }

    #[test]
    fn explicit_path_source_uses_system_path_when_available() {
        assert!(should_use_system_path(
            AntigravitySourcePreference::ExplicitPath,
            true
        ));
        assert!(!should_use_system_path(
            AntigravitySourcePreference::ExplicitPath,
            false
        ));
    }
}
