//! Configuration and path management for the embedded GitLab CLI (`glab`)

use crate::platform::{get_wsl_config, get_wsl_home_dir};
use std::path::PathBuf;
use tauri::AppHandle;

pub const GLAB_CLI_DIR_NAME: &str = "glab-cli";

#[cfg(not(target_os = "windows"))]
pub const GLAB_CLI_BINARY_NAME: &str = "glab";

#[cfg(target_os = "windows")]
pub const GLAB_CLI_BINARY_NAME: &str = "glab.exe";

pub const GLAB_CLI_BINARY_NAME_UNIX: &str = "glab";

pub fn get_wsl_glab_binary_path(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!(
        "{home}/.local/share/jean/{GLAB_CLI_DIR_NAME}/{GLAB_CLI_BINARY_NAME_UNIX}"
    ))
}

pub fn get_glab_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(GLAB_CLI_DIR_NAME))
}

pub fn get_glab_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_glab_cli_dir(app)?.join(GLAB_CLI_BINARY_NAME))
}

/// Resolve GitLab CLI binary path based on `glab_cli_source` preference.
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
        log::warn!(
            "glab_cli_source is 'path' but could not find glab in PATH, falling back to Jean-managed binary"
        );
    }

    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_glab_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(GLAB_CLI_BINARY_NAME_UNIX));
    }

    get_glab_cli_binary_path(app)
        .unwrap_or_else(|_| PathBuf::from(GLAB_CLI_DIR_NAME).join(GLAB_CLI_BINARY_NAME))
}

pub fn ensure_glab_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_glab_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create GitLab CLI directory: {e}"))?;
    Ok(cli_dir)
}

/// Resolve GitLab CLI only when installed/runnable.
pub fn resolve_available_glab_binary(app: &AppHandle) -> Option<PathBuf> {
    let path = resolve_glab_binary(app);
    let wsl = get_wsl_config();
    if wsl.enabled {
        let tool = path.to_string_lossy();
        let installed = if tool.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &tool)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &tool)
        };
        return installed.then_some(path);
    }
    path.exists().then_some(path)
}

/// System prompt when glab is available.
pub fn glab_path_instruction(path: &std::path::Path) -> String {
    format!(
        "When running GitLab CLI commands for GitLab remotes, use the full path to the binary: {}\n\
         Do NOT use bare `glab` — always use the full path above.\n\
         Use `glab` for issues, merge requests (`mr`), and CI — not `gh`.",
        path.display()
    )
}

pub const GLAB_CLI_UNAVAILABLE_NOTE: &str = "\
## GitLab CLI\n\
- GitLab CLI (`glab`) is not installed.\n\
- Do NOT run `glab` commands; they will fail.\n\
- For GitLab repositories, use local git only unless the user provides another way to access GitLab.";
