//! Configuration and path management for the PI Coding Agent CLI.

use std::path::PathBuf;
use tauri::AppHandle;

pub const CLI_DIR_NAME: &str = "pi-cli";
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "pi.cmd";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "pi";

pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?
        .join(CLI_DIR_NAME))
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?
        .join("node_modules")
        .join(".bin")
        .join(CLI_BINARY_NAME))
}

pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let use_path = crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<crate::AppPreferences>(&contents).ok())
        .map(|prefs| prefs.pi_cli_source == "path")
        .unwrap_or(false);

    let wsl = crate::platform::get_wsl_config();

    if use_path {
        if let Some(path) = find_pi_in_path() {
            return path;
        }
        log::warn!("pi_cli_source is 'path' but pi was not found in PATH, falling back to Jean-managed binary");
    }

    if wsl.enabled {
        return PathBuf::from("pi");
    }

    get_cli_binary_path(app).unwrap_or_else(|_| PathBuf::from(CLI_BINARY_NAME))
}

pub fn find_pi_in_path() -> Option<PathBuf> {
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(&wsl.distro, "pi", None).map(PathBuf::from);
    }

    crate::platform::find_cli_in_host_path("pi", None)
}
