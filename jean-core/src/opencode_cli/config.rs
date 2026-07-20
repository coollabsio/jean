//! Configuration and path management for the OpenCode CLI

use crate::platform::{get_wsl_config, get_wsl_home_dir};
use std::path::PathBuf;
use tauri::AppHandle;

/// Directory name for storing the OpenCode CLI binary
pub const CLI_DIR_NAME: &str = "opencode-cli";

/// Name of the OpenCode CLI binary
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "opencode.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "opencode";

/// Name of the OpenCode CLI binary when Jean manages it inside a WSL distro.
pub const CLI_BINARY_NAME_UNIX: &str = "opencode";

/// Full Unix path to the (eventual) Jean-managed OpenCode CLI inside a WSL
/// distro. Used so detection doesn't confuse a system-PATH `opencode` with
/// a Jean-managed one.
pub fn get_wsl_cli_binary_path(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!(
        "{home}/.local/share/jean/{CLI_DIR_NAME}/{CLI_BINARY_NAME_UNIX}"
    ))
}

/// Get the directory where OpenCode CLI is installed.
pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(CLI_DIR_NAME))
}

/// Get the full path to the OpenCode CLI binary.
///
/// Returns: `opencode-cli/opencode` (macOS/Linux) or `opencode-cli/opencode.exe` (Windows)
pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join(CLI_BINARY_NAME))
}

/// Resolve OpenCode binary path based on the user's preference.
///
/// If `opencode_cli_source` preference is `"path"`, look up `opencode` in system PATH.
/// Otherwise (default `"jean"`), use the Jean-managed binary.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let use_path = match crate::get_preferences_path(app) {
        Ok(prefs_path) => {
            if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                    prefs.opencode_cli_source == "path"
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
            if let Some(unix_path) = crate::platform::wsl_which(
                &wsl.distro,
                "opencode",
                get_wsl_cli_binary_path(&wsl.distro).ok().as_deref(),
            ) {
                return PathBuf::from(unix_path);
            }
        } else if let Some(path) = crate::platform::find_cli_in_host_path("opencode", None) {
            return path;
        }
        log::warn!("opencode_cli_source is 'path' but could not find opencode in PATH, falling back to Jean-managed binary");
    }

    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(CLI_BINARY_NAME_UNIX));
    }

    get_cli_binary_path(app).unwrap_or_else(|_| PathBuf::from(CLI_DIR_NAME).join(CLI_BINARY_NAME))
}

/// Ensure the CLI directory exists.
pub fn ensure_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create CLI directory: {e}"))?;
    Ok(cli_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_jean_managed_location_shape() {
        let resolved = PathBuf::from(CLI_DIR_NAME).join(CLI_BINARY_NAME);

        assert!(resolved.ends_with(CLI_BINARY_NAME));
        assert!(resolved.to_string_lossy().contains(CLI_DIR_NAME));
    }
}
