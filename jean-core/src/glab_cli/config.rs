//! Configuration and path management for the embedded GitLab CLI

use crate::platform::{get_wsl_config, get_wsl_home_dir};
use std::path::PathBuf;
use tauri::AppHandle;

/// Directory name for storing the GitLab CLI binary
pub const GLAB_CLI_DIR_NAME: &str = "glab-cli";

/// Name of the GitLab CLI binary
#[cfg(not(target_os = "windows"))]
pub const GLAB_CLI_BINARY_NAME: &str = "glab";

#[cfg(target_os = "windows")]
pub const GLAB_CLI_BINARY_NAME: &str = "glab.exe";

/// Name of the GitLab CLI binary when Jean manages it inside a WSL distro.
pub const GLAB_CLI_BINARY_NAME_UNIX: &str = "glab";

/// Get the full Unix path to the (eventual) Jean-managed GitLab CLI binary
/// inside a WSL distro. Used so detection can distinguish "Jean installed
/// nothing yet" from "a system `glab` exists on PATH".
pub fn get_wsl_glab_binary_path(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!(
        "{home}/.local/share/jean/{GLAB_CLI_DIR_NAME}/{GLAB_CLI_BINARY_NAME_UNIX}"
    ))
}

/// Get the directory where GitLab CLI is installed
///
/// Returns: `~/Library/Application Support/jean/glab-cli/` (macOS)
///          `~/.local/share/jean/glab-cli/` (Linux)
///          `%APPDATA%/jean/glab-cli/` (Windows)
pub fn get_glab_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(GLAB_CLI_DIR_NAME))
}

/// Get the full path to the GitLab CLI binary
///
/// Returns: `~/Library/Application Support/jean/glab-cli/glab` (macOS/Linux)
///          `%APPDATA%/jean/glab-cli/glab.exe` (Windows)
pub fn get_glab_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_glab_cli_dir(app)?.join(GLAB_CLI_BINARY_NAME))
}

/// Resolve GitLab CLI binary path based on the user's preference.
///
/// If `glab_cli_source` preference is `"path"`, look up `glab` in system PATH.
/// Otherwise (default `"jean"`), use the Jean-managed binary.
pub fn resolve_glab_binary(app: &AppHandle) -> PathBuf {
    let use_path = match crate::get_preferences_path(app) {
        Ok(prefs_path) => {
            if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                    prefs.glab_cli_source == "path"
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
                "glab",
                get_wsl_glab_binary_path(&wsl.distro).ok().as_deref(),
            ) {
                return PathBuf::from(unix_path);
            }
        } else if let Some(path) = crate::platform::find_cli_in_host_path("glab", None) {
            return path;
        }
        log::warn!("glab_cli_source is 'path' but could not find glab in PATH, falling back to Jean-managed binary");
    }

    // In WSL mode the Jean-managed install (when it exists) lives inside
    // the distro. Return the designated Unix path so `check_glab_cli_installed`
    // can distinguish "Jean hasn't installed anything" from "system glab is on
    // PATH". Until Jean-managed installs are supported in WSL for glab, this
    // path will not exist and the check correctly reports not-installed.
    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_glab_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(GLAB_CLI_BINARY_NAME_UNIX));
    }

    get_glab_cli_binary_path(app)
        .unwrap_or_else(|_| PathBuf::from(GLAB_CLI_DIR_NAME).join(GLAB_CLI_BINARY_NAME))
}

/// Ensure the CLI directory exists, creating it if necessary
pub fn ensure_glab_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_glab_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create GitLab CLI directory: {e}"))?;
    Ok(cli_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_jean_managed_location_shape() {
        let resolved = PathBuf::from(GLAB_CLI_DIR_NAME).join(GLAB_CLI_BINARY_NAME);

        assert!(resolved.ends_with(GLAB_CLI_BINARY_NAME));
        assert!(resolved.to_string_lossy().contains(GLAB_CLI_DIR_NAME));
    }
}
