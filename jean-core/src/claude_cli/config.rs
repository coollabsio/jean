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

/// Whether the Jean-managed Claude binary is present and executable.
pub fn jean_managed_installed(app: &AppHandle) -> bool {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro)
            .map(|path| crate::platform::wsl_file_executable(&wsl.distro, &path))
            .unwrap_or(false);
    }
    get_cli_binary_path(app)
        .map(|path| path.exists())
        .unwrap_or(false)
}

/// Find Claude on the system PATH (excluding the Jean-managed binary).
pub fn find_system_binary(app: &AppHandle) -> Option<PathBuf> {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(
            &wsl.distro,
            "claude",
            get_wsl_cli_binary_path(&wsl.distro).ok().as_deref(),
        )
        .map(PathBuf::from);
    }

    let jean_managed = get_cli_binary_path(app)
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok());
    crate::platform::find_cli_in_host_path("claude", jean_managed.as_deref())
}

/// True when Jean-managed Claude is missing but a system PATH install exists.
/// Used to auto-select `claude_cli_source = "path"` so Homebrew installs work
/// without requiring a manual Settings toggle (issue #387).
pub fn should_auto_use_system(app: &AppHandle) -> bool {
    !jean_managed_installed(app) && find_system_binary(app).is_some()
}

fn jean_managed_path(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(CLI_BINARY_NAME_UNIX));
    }
    get_cli_binary_path(app).unwrap_or_else(|_| PathBuf::from(CLI_DIR_NAME).join(CLI_BINARY_NAME))
}

/// Resolve Claude binary path based on the user's preference.
///
/// If `claude_cli_source` is `"path"`, look up `claude` in system PATH.
/// If `"jean"` (default) and the Jean-managed binary exists, use it.
/// Otherwise fall back to a system PATH install when present so Homebrew
/// (and similar) CLIs work without an explicit source switch.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let prefer_path = match crate::get_preferences_path(app) {
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

    if prefer_path {
        if let Some(path) = find_system_binary(app) {
            return path;
        }
        log::warn!(
            "claude_cli_source is 'path' but could not find claude in PATH, falling back to Jean-managed binary"
        );
        return jean_managed_path(app);
    }

    if jean_managed_installed(app) {
        return jean_managed_path(app);
    }

    if let Some(path) = find_system_binary(app) {
        log::info!(
            "Jean-managed Claude CLI not installed; using system PATH binary at {}",
            path.display()
        );
        return path;
    }

    jean_managed_path(app)
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
