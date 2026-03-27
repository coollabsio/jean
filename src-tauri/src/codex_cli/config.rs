//! Configuration and path management for the Codex CLI

use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use crate::platform::silent_command;

/// Directory name for storing the Codex CLI binary
pub const CLI_DIR_NAME: &str = "codex-cli";

/// Name of the Codex CLI binary
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "codex.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "codex";

/// Get the directory where Codex CLI is installed
///
/// Returns: `~/Library/Application Support/jean/codex-cli/`
pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(CLI_DIR_NAME))
}

/// Get the full path to the Codex CLI binary
///
/// Returns: `~/Library/Application Support/jean/codex-cli/codex`
pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join(CLI_BINARY_NAME))
}

/// Resolve Codex binary path based on the user's preference.
///
/// If `codex_cli_source` preference is `"path"`, look up `codex` in system PATH.
/// Otherwise (default `"jean"`), use the Jean-managed binary.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let use_path = match crate::get_preferences_path(app) {
        Ok(prefs_path) => {
            if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                    log::debug!("resolve_cli_binary: codex_cli_source={:?}", prefs.codex_cli_source);
                    prefs.codex_cli_source == "path"
                } else {
                    log::debug!("resolve_cli_binary: failed to parse preferences, defaulting to jean");
                    false
                }
            } else {
                log::debug!("resolve_cli_binary: failed to read preferences file, defaulting to jean");
                false
            }
        }
        Err(e) => {
            log::debug!("resolve_cli_binary: failed to get preferences path: {e}, defaulting to jean");
            false
        }
    };

    if use_path {
        let which_cmd = if cfg!(target_os = "windows") {
            "where"
        } else {
            "which"
        };

        match silent_command(which_cmd).arg("codex").output() {
            Ok(output) => {
                log::debug!("resolve_cli_binary: `{which_cmd} codex` exit_status={}, stdout={:?}",
                    output.status,
                    String::from_utf8_lossy(&output.stdout).trim());
                if output.status.success() {
                    // On Windows, `where` can return multiple paths; take only the first line
                    let path_str = String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("").trim().to_string();
                    if !path_str.is_empty() {
                        let path = PathBuf::from(&path_str);
                        if path.exists() {
                            log::debug!("resolve_cli_binary: resolved to PATH binary: {path_str}");
                            return path;
                        } else {
                            log::debug!("resolve_cli_binary: PATH binary does not exist on disk: {path_str}");
                        }
                    } else {
                        log::debug!("resolve_cli_binary: `{which_cmd} codex` returned empty output");
                    }
                }
            }
            Err(e) => {
                log::debug!("resolve_cli_binary: `{which_cmd} codex` failed to execute: {e}");
            }
        }
        log::warn!("codex_cli_source is 'path' but could not find codex in PATH, falling back to Jean-managed binary");
    }

    let fallback = get_cli_binary_path(app).unwrap_or_else(|_| PathBuf::from(CLI_DIR_NAME).join(CLI_BINARY_NAME));
    log::debug!("resolve_cli_binary: using jean-managed binary: {fallback:?}");
    fallback
}

/// Ensure the CLI directory exists, creating it if necessary
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
