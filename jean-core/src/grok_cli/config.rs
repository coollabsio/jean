//! Configuration and path resolution for the Grok Build CLI.

use crate::platform::get_wsl_config;
use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

pub const CLI_DIR_NAME: &str = "grok-cli";

#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "grok.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "grok";

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_NAME: &str = "grok.cmd";
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_NAME: &str = CLI_BINARY_NAME;

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_CANDIDATES: &[&str] = &["grok.cmd", "grok.exe", "grok.bat"];
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_CANDIDATES: &[&str] = &[CLI_BINARY_NAME];

pub const CLI_TOOL_CANDIDATES: &[&str] = &["grok"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrokSourcePreference {
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
        .map_err(|e| format!("Failed to create Grok CLI directory: {e}"))?;
    Ok(cli_dir)
}

fn managed_bin_dir_from_dir(cli_dir: PathBuf) -> PathBuf {
    cli_dir.join("node_modules").join(".bin")
}

pub fn managed_binary_path_from_dir(cli_dir: PathBuf) -> PathBuf {
    managed_bin_dir_from_dir(cli_dir).join(MANAGED_CLI_BINARY_NAME)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_binary_path_from_dir(get_cli_dir(app)?))
}

pub fn managed_binary_candidates_from_dir(cli_dir: PathBuf) -> Vec<PathBuf> {
    let bin_dir = managed_bin_dir_from_dir(cli_dir);
    MANAGED_CLI_BINARY_CANDIDATES
        .iter()
        .map(|candidate| bin_dir.join(candidate))
        .collect()
}

pub fn find_managed_grok_binary(app: &AppHandle) -> Option<PathBuf> {
    let cli_dir = get_cli_dir(app).ok()?;
    managed_binary_candidates_from_dir(cli_dir)
        .into_iter()
        .find(|path| path.exists())
}

fn source_preference_from_value(value: &Value) -> GrokSourcePreference {
    match value.get("grok_cli_source") {
        Some(value) if value.as_str() == Some("path") => GrokSourcePreference::ExplicitPath,
        Some(_) => GrokSourcePreference::ExplicitJean,
        None => GrokSourcePreference::Missing,
    }
}

fn read_source_preference(app: &AppHandle) -> GrokSourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|prefs_path| std::fs::read_to_string(prefs_path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .map(|value| source_preference_from_value(&value))
        .unwrap_or(GrokSourcePreference::Missing)
}

pub fn should_use_system_path(
    source_preference: GrokSourcePreference,
    system_grok_found: bool,
) -> bool {
    match source_preference {
        GrokSourcePreference::ExplicitPath => system_grok_found,
        GrokSourcePreference::ExplicitJean => false,
        // Migration-safe: old preferences lacked a Grok source field and used
        // PATH-only installs, so keep using PATH only when no explicit Jean
        // preference exists and a system Grok binary is available.
        GrokSourcePreference::Missing => system_grok_found,
    }
}

pub fn find_system_grok_binary(app: &AppHandle) -> Option<PathBuf> {
    let jean_managed_path = find_managed_grok_binary(app)
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

/// Resolve the Grok binary based on the user's source preference.
///
/// If `grok_cli_source` is `"path"`, use a system PATH binary when one exists.
/// Otherwise use the Jean-managed npm install under app data.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, "grok", None) {
            return PathBuf::from(unix_path);
        }
        return PathBuf::from(CLI_BINARY_NAME);
    }

    let source_preference = read_source_preference(app);
    let system_path = find_system_grok_binary(app);

    if should_use_system_path(source_preference, system_path.is_some()) {
        if let Some(path) = system_path {
            return path;
        }
    }

    if source_preference == GrokSourcePreference::ExplicitPath {
        log::warn!("grok_cli_source is 'path' but Grok was not found in PATH; falling back to Jean-managed binary");
    }

    find_managed_grok_binary(app).unwrap_or_else(|| {
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
    fn fallback_path_is_grok_binary_name() {
        assert!(PathBuf::from(CLI_BINARY_NAME).ends_with(CLI_BINARY_NAME));
    }

    #[test]
    fn managed_path_points_to_npm_bin_dir() {
        let path = managed_binary_path_from_dir(PathBuf::from("/tmp/jean/grok-cli"));
        assert!(path.ends_with(
            PathBuf::from("node_modules")
                .join(".bin")
                .join(MANAGED_CLI_BINARY_NAME)
        ));
    }

    #[test]
    fn managed_candidates_are_separate_from_path_tool_names() {
        assert!(MANAGED_CLI_BINARY_CANDIDATES.contains(&MANAGED_CLI_BINARY_NAME));
        assert_eq!(CLI_TOOL_CANDIDATES, &["grok"]);
    }

    #[test]
    fn explicit_jean_source_never_uses_system_path() {
        assert!(!should_use_system_path(
            GrokSourcePreference::ExplicitJean,
            true
        ));
        assert!(!should_use_system_path(
            GrokSourcePreference::ExplicitJean,
            false
        ));
    }

    #[test]
    fn explicit_path_source_uses_system_path_when_available() {
        assert!(should_use_system_path(
            GrokSourcePreference::ExplicitPath,
            true
        ));
        assert!(!should_use_system_path(
            GrokSourcePreference::ExplicitPath,
            false
        ));
    }
}
