//! Configuration and path management for the embedded Claude CLI

use crate::platform::{get_wsl_config, get_wsl_home_dir};
use std::path::PathBuf;
use tauri::AppHandle;

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
/// Returns a Unix absolute path string like
/// `/home/<user>/.local/share/jean/claude-cli`.
pub fn get_wsl_cli_dir(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!("{home}/.local/share/jean/{CLI_DIR_NAME}"))
}

/// Get the full Unix path to the Jean-managed Claude CLI binary inside a
/// WSL distro.
pub fn get_wsl_cli_binary_path(distro: &str) -> Result<String, String> {
    Ok(format!(
        "{}/{CLI_BINARY_NAME_UNIX}",
        get_wsl_cli_dir(distro)?
    ))
}

/// Resolve Claude binary path based on the user's preference.
///
/// If `claude_cli_source` preference is `"path"`, look up `claude` in system PATH.
/// Otherwise (default `"jean"`), use the Jean-managed binary.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    // Read preference from disk to avoid needing managed state
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
            // In WSL mode, resolve the absolute Unix path so the session
            // spawn path can exec it directly. `wsl_which` uses a login
            // shell so PATH additions from ~/.profile / ~/.bashrc apply
            // (nvm, bun, volta, npm-global, etc.).
            if let Some(unix_path) = crate::platform::wsl_which(
                &wsl.distro,
                "claude",
                get_wsl_cli_binary_path(&wsl.distro).ok().as_deref(),
            ) {
                return PathBuf::from(unix_path);
            }
        } else if let Some(path) = crate::platform::find_cli_in_host_path("claude", None) {
            return path;
        }
        // Fallback: if PATH lookup fails, still return Jean-managed path
        log::warn!("claude_cli_source is 'path' but could not find claude in PATH, falling back to Jean-managed binary");
    }

    // In WSL mode, the Jean-managed install lives inside the distro — return
    // the Linux absolute path so the runtime can exec it via `wsl.exe`.
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
