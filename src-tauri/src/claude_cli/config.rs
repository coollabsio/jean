//! Configuration and path management for the embedded Claude CLI

use crate::platform::{get_wsl_config, get_wsl_home_dir, silent_command};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Directory name for storing the Claude CLI binary
pub const CLI_DIR_NAME: &str = "claude-cli";

/// Name of the Claude CLI binary
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "claude.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "claude";

/// Name of the Claude CLI binary when Jean manages it inside a WSL distro
/// (always Linux, regardless of the host OS).
pub const CLI_BINARY_NAME_UNIX: &str = "claude";

/// Get the directory where Claude CLI is installed
///
/// Returns: `~/Library/Application Support/jean/claude-cli/`
pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(CLI_DIR_NAME))
}

/// Get the full path to the Claude CLI binary
///
/// Returns: `~/Library/Application Support/jean/claude-cli/claude`
pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join(CLI_BINARY_NAME))
}

/// Get the directory where Jean installs the Claude CLI inside a WSL distro.
pub fn get_wsl_cli_dir(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!("{home}/.local/share/jean/{CLI_DIR_NAME}"))
}

/// Get the full Unix path to the Jean-managed Claude CLI binary inside a WSL distro.
pub fn get_wsl_cli_binary_path(distro: &str) -> Result<String, String> {
    Ok(format!(
        "{}/{CLI_BINARY_NAME_UNIX}",
        get_wsl_cli_dir(distro)?
    ))
}

/// Resolve Claude binary path based on the user's preference.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let use_path = match crate::get_preferences_path(app) {
        Ok(prefs_path) => {
            if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                    prefs.claude_cli_source == "path"
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
            if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, "claude") {
                return PathBuf::from(unix_path);
            }
        } else {
            let which_cmd = if cfg!(target_os = "windows") {
                "where"
            } else {
                "which"
            };

            if let Ok(output) = silent_command(which_cmd).arg("claude").output() {
                if output.status.success() {
                    let path_str = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !path_str.is_empty() {
                        let path = PathBuf::from(&path_str);
                        if path.exists() {
                            return path;
                        }
                    }
                }
            }
        }
        log::warn!("claude_cli_source is 'path' but could not find claude in PATH, falling back to Jean-managed binary");
    }

    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(CLI_BINARY_NAME_UNIX));
    }

    get_cli_binary_path(app).unwrap_or_else(|_| PathBuf::from(CLI_DIR_NAME).join(CLI_BINARY_NAME))
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
