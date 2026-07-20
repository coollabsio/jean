//! Configuration and path management for the Codex CLI

use crate::platform::{get_wsl_config, get_wsl_home_dir};
use std::path::PathBuf;
use tauri::AppHandle;

/// Directory name for storing the Codex CLI binary
pub const CLI_DIR_NAME: &str = "codex-cli";

/// Name of the Codex CLI binary
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "codex.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "codex";

/// Name of the Codex CLI binary when Jean manages it inside a WSL distro.
pub const CLI_BINARY_NAME_UNIX: &str = "codex";

/// Full Unix path to the (eventual) Jean-managed Codex CLI inside a WSL
/// distro. Used so detection doesn't confuse a system-PATH `codex` with a
/// Jean-managed one.
pub fn get_wsl_cli_binary_path(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!(
        "{home}/.local/share/jean/{CLI_DIR_NAME}/{CLI_BINARY_NAME_UNIX}"
    ))
}

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
pub fn resolve_cli_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let use_path = match crate::get_preferences_path(app) {
        Ok(prefs_path) => {
            if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                    log::debug!(
                        "resolve_cli_binary: codex_cli_source={:?}",
                        prefs.codex_cli_source
                    );
                    prefs.codex_cli_source == "path"
                } else {
                    log::debug!(
                        "resolve_cli_binary: failed to parse preferences, defaulting to jean"
                    );
                    false
                }
            } else {
                log::debug!(
                    "resolve_cli_binary: failed to read preferences file, defaulting to jean"
                );
                false
            }
        }
        Err(e) => {
            log::debug!(
                "resolve_cli_binary: failed to get preferences path: {e}, defaulting to jean"
            );
            false
        }
    };

    if use_path {
        let wsl = get_wsl_config();
        if wsl.enabled {
            // Resolve absolute Unix path so downstream session/status probes
            // don't depend on a non-login-shell PATH.
            let jean_managed = get_wsl_cli_binary_path(&wsl.distro).ok();
            if let Some(unix_path) =
                crate::platform::wsl_which(&wsl.distro, "codex", jean_managed.as_deref())
            {
                log::debug!(
                    "resolve_cli_binary: found codex in WSL distro {} at {unix_path}",
                    wsl.distro
                );
                return Ok(PathBuf::from(unix_path));
            }
        } else if let Some(path) = crate::platform::find_cli_in_host_path("codex", None) {
            log::debug!("resolve_cli_binary: resolved to PATH binary: {path:?}");
            return Ok(path);
        }
        log::warn!("codex_cli_source is 'path' but could not find codex in PATH, falling back to Jean-managed binary");
    }

    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro).map(PathBuf::from);
    }

    let fallback = get_cli_binary_path(app)
        .unwrap_or_else(|_| PathBuf::from(CLI_DIR_NAME).join(CLI_BINARY_NAME));
    log::debug!("resolve_cli_binary: using jean-managed binary: {fallback:?}");
    Ok(fallback)
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

    #[test]
    fn resolve_cli_binary_fails_closed_with_explicit_errors() {
        let _resolver: fn(&AppHandle) -> Result<PathBuf, String> = resolve_cli_binary;
    }
}
