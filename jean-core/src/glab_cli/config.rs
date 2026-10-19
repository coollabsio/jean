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

    let path_binary = if use_path {
        let wsl = get_wsl_config();
        if wsl.enabled {
            // Resolve absolute Unix path so the session/status checks don't
            // depend on a non-login-shell PATH.
            crate::platform::wsl_which(
                &wsl.distro,
                "glab",
                get_wsl_glab_binary_path(&wsl.distro).ok().as_deref(),
            )
            .map(PathBuf::from)
        } else {
            crate::platform::find_cli_in_host_path("glab", None)
        }
    } else {
        None
    };
    if use_path && path_binary.is_none() {
        log::warn!(
            "glab_cli_source is 'path' but could not find glab in PATH, falling back to Jean-managed binary"
        );
    }

    // In WSL mode the Jean-managed install lives inside the distro.
    // `install_glab_cli` writes the binary here. Return that Unix path so
    // `check_glab_cli_installed` can distinguish "Jean hasn't installed
    // anything" from "system glab is on PATH".
    let wsl = get_wsl_config();
    let managed = if wsl.enabled {
        get_wsl_glab_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(GLAB_CLI_BINARY_NAME_UNIX))
    } else {
        get_glab_cli_binary_path(app)
            .unwrap_or_else(|_| PathBuf::from(GLAB_CLI_DIR_NAME).join(GLAB_CLI_BINARY_NAME))
    };
    prefer_path_binary(use_path, path_binary, managed)
}

/// Choose the glab binary with the same order as [`crate::gh_cli::config::resolve_gh_binary`].
///
/// When the preference is PATH and a binary was found, use that path.
/// Otherwise use the Jean-managed location (including the fallback when PATH
/// mode is set but nothing was found).
pub fn prefer_path_binary(
    source_is_path: bool,
    path_binary: Option<PathBuf>,
    managed: PathBuf,
) -> PathBuf {
    if source_is_path {
        path_binary.unwrap_or(managed)
    } else {
        managed
    }
}

/// Resolve GitLab CLI only when the chosen binary is actually installed.
///
/// Mirrors [`crate::gh_cli::config::resolve_available_gh_binary`]: `None` when
/// the preferred path does not exist (or is not executable in WSL).
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

/// System prompt when `glab` is installed at a full path.
pub fn glab_path_instruction(path: &std::path::Path) -> String {
    format!(
        "When running GitLab CLI commands for GitLab remotes, use the full path to the binary: {}\n\
         Do NOT use bare `glab` — always use the full path above.\n\
         Use `glab` for issues, merge requests (`mr`), and CI. Do not use `gh` for GitLab remotes.",
        path.display()
    )
}

/// System prompt block injected when GitLab CLI is not available.
pub const GLAB_CLI_UNAVAILABLE_NOTE: &str = "\
## GitLab CLI\n\
- GitLab CLI (`glab`) is not installed in this environment.\n\
- Do NOT run `glab` or other GitLab CLI commands; they will fail.\n\
- For GitLab repositories, use local git unless the user provides another way to access GitLab.";

/// Append GitLab CLI guidance the same way GitHub CLI guidance is appended.
///
/// - Full path: tell the model to use that binary for GitLab remotes.
/// - Bare `glab`: leave the prompt unchanged.
/// - Missing: tell the model not to invoke `glab`.
pub fn append_glab_cli_prompt(parts: &mut Vec<String>, binary: Option<&std::path::Path>) {
    match binary {
        Some(path) if path != std::path::Path::new("glab") => {
            parts.push(glab_path_instruction(path));
        }
        Some(_) => {}
        None => parts.push(GLAB_CLI_UNAVAILABLE_NOTE.to_string()),
    }
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

    #[test]
    fn path_source_prefers_a_discovered_binary() {
        let managed = PathBuf::from("glab-cli").join("glab");
        let discovered = PathBuf::from("/usr/bin/glab");
        assert_eq!(
            prefer_path_binary(true, Some(discovered.clone()), managed.clone()),
            discovered
        );
    }

    #[test]
    fn path_source_falls_back_to_jean_managed_when_nothing_is_on_path() {
        let managed = PathBuf::from("glab-cli").join("glab");
        assert_eq!(prefer_path_binary(true, None, managed.clone()), managed);
    }

    #[test]
    fn jean_source_ignores_a_path_binary() {
        let managed = PathBuf::from("glab-cli").join("glab");
        let discovered = PathBuf::from("/usr/bin/glab");
        assert_eq!(
            prefer_path_binary(false, Some(discovered), managed.clone()),
            managed
        );
    }

    #[test]
    fn prompt_uses_full_path_and_notes_when_missing() {
        let mut parts = vec!["earlier".to_string()];
        append_glab_cli_prompt(&mut parts, Some(std::path::Path::new("/opt/jean/glab")));
        assert!(parts[1].contains("/opt/jean/glab"));
        assert!(parts[1].contains("Do NOT use bare `glab`"));
        assert!(parts[1].contains("GitLab"));

        let mut bare = Vec::new();
        append_glab_cli_prompt(&mut bare, Some(std::path::Path::new("glab")));
        assert!(bare.is_empty());

        let mut missing = Vec::new();
        append_glab_cli_prompt(&mut missing, None);
        assert!(missing[0].contains("not installed"));
        assert!(missing[0].contains("Do NOT run `glab`"));
    }
}
