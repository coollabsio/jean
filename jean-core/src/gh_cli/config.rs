//! Configuration and path management for the embedded GitHub CLI

use crate::platform::{get_wsl_config, get_wsl_home_dir};
use std::path::PathBuf;
use tauri::AppHandle;

/// Directory name for storing the GitHub CLI binary
pub const GH_CLI_DIR_NAME: &str = "gh-cli";

/// Name of the GitHub CLI binary
#[cfg(not(target_os = "windows"))]
pub const GH_CLI_BINARY_NAME: &str = "gh";

#[cfg(target_os = "windows")]
pub const GH_CLI_BINARY_NAME: &str = "gh.exe";

/// Name of the GitHub CLI binary when Jean manages it inside a WSL distro.
pub const GH_CLI_BINARY_NAME_UNIX: &str = "gh";

/// Get the full Unix path to the (eventual) Jean-managed GitHub CLI binary
/// inside a WSL distro. Used so detection can distinguish "Jean installed
/// nothing yet" from "a system `gh` exists on PATH".
pub fn get_wsl_gh_binary_path(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!(
        "{home}/.local/share/jean/{GH_CLI_DIR_NAME}/{GH_CLI_BINARY_NAME_UNIX}"
    ))
}

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
        let wsl = get_wsl_config();
        if wsl.enabled {
            // Resolve absolute Unix path so the session/status checks don't
            // depend on a non-login-shell PATH.
            if let Some(unix_path) = crate::platform::wsl_which(
                &wsl.distro,
                "gh",
                get_wsl_gh_binary_path(&wsl.distro).ok().as_deref(),
            ) {
                return PathBuf::from(unix_path);
            }
        } else if let Some(path) = crate::platform::find_cli_in_host_path("gh", None) {
            return path;
        }
        log::warn!("gh_cli_source is 'path' but could not find gh in PATH, falling back to Jean-managed binary");
    }

    // In WSL mode the Jean-managed install (when it exists) lives inside
    // the distro. Return the designated Unix path so `check_gh_cli_installed`
    // can distinguish "Jean hasn't installed anything" from "system gh is on
    // PATH". Until Jean-managed installs are supported in WSL for gh, this
    // path will not exist and the check correctly reports not-installed.
    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_gh_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(GH_CLI_BINARY_NAME_UNIX));
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
