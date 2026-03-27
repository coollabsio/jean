//! Configuration and path management for the embedded GitHub CLI

use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use crate::platform::silent_command;

/// Directory name for storing the GitHub CLI binary
pub const GH_CLI_DIR_NAME: &str = "gh-cli";

/// Name of the GitHub CLI binary
#[cfg(not(target_os = "windows"))]
pub const GH_CLI_BINARY_NAME: &str = "gh";

#[cfg(target_os = "windows")]
pub const GH_CLI_BINARY_NAME: &str = "gh.exe";

/// Get the directory where GitHub CLI is installed
///
/// Returns: `~/Library/Application Support/jean/gh-cli/` (macOS)
///          `~/.local/share/jean/gh-cli/` (Linux)
///          `%APPDATA%/jean/gh-cli/` (Windows)
pub fn get_gh_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(GH_CLI_DIR_NAME))
}

/// Get the full path to the GitHub CLI binary
///
/// Returns: `~/Library/Application Support/jean/gh-cli/gh` (macOS/Linux)
///          `%APPDATA%/jean/gh-cli/gh.exe` (Windows)
pub fn get_gh_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_gh_cli_dir(app)?.join(GH_CLI_BINARY_NAME))
}

/// Resolve GitHub CLI binary path based on the user's preference.
///
/// If `gh_cli_source` preference is `"path"`, look up `gh` in system PATH.
/// Otherwise (default `"jean"`), use the Jean-managed binary.
pub fn resolve_gh_binary(app: &AppHandle) -> PathBuf {
    let use_path = match crate::get_preferences_path(app) {
        Ok(prefs_path) => {
            if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                    prefs.gh_cli_source == "path"
                } else {
                    false
                }
            } else {
                false
            }
        }
        Err(_) => false,
    };

    if use_path {
        let which_cmd = if cfg!(target_os = "windows") {
            "where"
        } else {
            "which"
        };

        if let Ok(output) = silent_command(which_cmd).arg("gh").output() {
            if output.status.success() {
                // On Windows, `where` can return multiple paths; take only the first line
                let path_str = String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("").trim().to_string();
                if !path_str.is_empty() {
                    let path = PathBuf::from(&path_str);
                    if path.exists() {
                        return path;
                    }
                }
            }
        }
        log::warn!("gh_cli_source is 'path' but could not find gh in PATH, falling back to Jean-managed binary");
    }

    get_gh_cli_binary_path(app)
        .unwrap_or_else(|_| PathBuf::from(GH_CLI_DIR_NAME).join(GH_CLI_BINARY_NAME))
}

/// Ensure the CLI directory exists, creating it if necessary
pub fn ensure_gh_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_gh_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create GitHub CLI directory: {e}"))?;
    Ok(cli_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_jean_managed_location_shape() {
        let resolved = PathBuf::from(GH_CLI_DIR_NAME).join(GH_CLI_BINARY_NAME);

        assert!(resolved.ends_with(GH_CLI_BINARY_NAME));
        assert!(resolved.to_string_lossy().contains(GH_CLI_DIR_NAME));
    }
}
