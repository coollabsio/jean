//! Configuration and path management for the embedded GitHub CLI

use crate::platform::{get_wsl_config, get_wsl_home_dir};
use std::path::PathBuf;
use tauri::AppHandle;

/// Directory name for storing the GitHub CLI binary
pub const GH_CLI_DIR_NAME: &str = "gh-cli";

/// Name of the GitHub CLI binary
#[cfg(not(target_os = "windows"))]
pub const GH_CLI_BINARY_NAME: &str = "gh";

#[cfg(target_os = "windows")]
pub const GH_CLI_BINARY_NAME: &str = "gh.exe";

/// Name of the GitHub CLI binary when Jean manages it inside a WSL distro.
pub const GH_CLI_BINARY_NAME_UNIX: &str = "gh";

/// Get the full Unix path to the (eventual) Jean-managed GitHub CLI binary
/// inside a WSL distro. Used so detection can distinguish "Jean installed
/// nothing yet" from "a system `gh` exists on PATH".
pub fn get_wsl_gh_binary_path(distro: &str) -> Result<String, String> {
    let home = get_wsl_home_dir(distro)?;
    Ok(format!(
        "{home}/.local/share/jean/{GH_CLI_DIR_NAME}/{GH_CLI_BINARY_NAME_UNIX}"
    ))
}

/// Get the directory where GitHub CLI is installed
///
/// Returns: `~/Library/Application Support/jean/gh-cli/` (macOS)
///          `~/.local/share/jean/gh-cli/` (Linux)
///          `%APPDATA%/jean/gh-cli/` (Windows)
pub fn get_gh_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(GH_CLI_DIR_NAME))
}

/// Get the full path to the GitHub CLI binary
///
/// Returns: `~/Library/Application Support/jean/gh-cli/gh` (macOS/Linux)
///          `%APPDATA%/jean/gh-cli/gh.exe` (Windows)
pub fn get_gh_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_gh_cli_dir(app)?.join(GH_CLI_BINARY_NAME))
}

/// Resolve GitHub CLI binary path based on the user's preference.
///
/// If `gh_cli_source` preference is `"path"`, look up `gh` in system PATH.
/// Otherwise (default `"jean"`), use the Jean-managed binary.
pub fn resolve_gh_binary(app: &AppHandle) -> PathBuf {
    let use_path = match crate::get_preferences_path(app) {
        Ok(prefs_path) => {
            if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                if let Ok(prefs) = serde_json::from_str::<crate::AppPreferences>(&contents) {
                    prefs.gh_cli_source == "path"
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
                "gh",
                get_wsl_gh_binary_path(&wsl.distro).ok().as_deref(),
            ) {
                return PathBuf::from(unix_path);
            }
        } else if let Some(path) = crate::platform::find_cli_in_host_path("gh", None) {
            return path;
        }
        log::warn!("gh_cli_source is 'path' but could not find gh in PATH, falling back to Jean-managed binary");
    }

    // In WSL mode the Jean-managed install (when it exists) lives inside
    // the distro. Return the designated Unix path so `check_gh_cli_installed`
    // can distinguish "Jean hasn't installed anything" from "system gh is on
    // PATH". Until Jean-managed installs are supported in WSL for gh, this
    // path will not exist and the check correctly reports not-installed.
    let wsl = get_wsl_config();
    if wsl.enabled {
        return get_wsl_gh_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(GH_CLI_BINARY_NAME_UNIX));
    }

    get_gh_cli_binary_path(app)
        .unwrap_or_else(|_| PathBuf::from(GH_CLI_DIR_NAME).join(GH_CLI_BINARY_NAME))
}

/// Ensure the CLI directory exists, creating it if necessary
pub fn ensure_gh_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_gh_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create GitHub CLI directory: {e}"))?;
    Ok(cli_dir)
}

/// Resolve GitHub CLI binary only when it is actually installed/runnable.
///
/// Unlike [`resolve_gh_binary`], this returns `None` when the preferred binary
/// path does not exist (or is not executable in WSL). Use this for system
/// prompt injection so we never tell the model to use a missing `gh`.
pub fn resolve_available_gh_binary(app: &AppHandle) -> Option<PathBuf> {
    let path = resolve_gh_binary(app);
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

/// System prompt block injected when GitHub CLI is not available.
pub const GH_CLI_UNAVAILABLE_INSTRUCTION: &str = "\
## GitHub CLI\n\
- GitHub CLI (`gh`) is not installed in this environment.\n\
- Do NOT run `gh` or other GitHub CLI commands; they will fail.\n\
- Skip GitHub issue, PR, discussion, and Actions discovery unless the user provides that context another way.\n\
- Prefer local git for remotes/branches. For GitLab or other hosts, use that host's tools if available.";

/// Heading used by the default global system prompt for post-change GitHub discovery.
pub const GITHUB_DISCOVERY_SECTION_MARKER: &str = "## GitHub Issue and Discussion Discovery";

/// Remove the GitHub Issue/Discussion Discovery section from a prompt string.
///
/// Used when `gh` is unavailable so the model is not instructed to search
/// GitHub issues that require the GitHub CLI.
pub fn strip_github_discovery_section(prompt: &str) -> String {
    let Some(start) = prompt.find(GITHUB_DISCOVERY_SECTION_MARKER) else {
        return prompt.to_string();
    };

    let after_marker = &prompt[start + GITHUB_DISCOVERY_SECTION_MARKER.len()..];
    // Next markdown H2 (or end of string) ends the discovery section.
    let section_end_rel = after_marker
        .find("\n## ")
        .map(|i| i + 1) // include the leading newline of the next heading
        .unwrap_or(after_marker.len());
    let end = start + GITHUB_DISCOVERY_SECTION_MARKER.len() + section_end_rel;

    let before = prompt[..start].trim_end();
    let after = prompt[end..].trim_start();
    if before.is_empty() {
        return after.to_string();
    }
    if after.is_empty() {
        return before.to_string();
    }
    format!("{before}\n\n{after}")
}

/// Append GitHub + GitLab CLI guidance to system prompt parts based on availability.
///
/// - When `gh` is installed: inject the full path so agents use Jean's binary.
/// - When `gh` is missing: strip GitHub-discovery duties from earlier parts and
///   tell the model not to invoke `gh`.
/// - When `glab` is installed: inject path and instruct use for GitLab remotes.
/// - When `glab` is missing: note that GitLab CLI commands will fail.
pub fn append_gh_cli_system_prompt(parts: &mut Vec<String>, app: &AppHandle) {
    match resolve_available_gh_binary(app) {
        Some(path) => {
            parts.push(format!(
                "When running GitHub CLI commands for GitHub remotes, use the full path to the embedded binary: {}\n\
                 Do NOT use bare `gh` — always use the full path above.\n\
                 Do not use `gh` for GitLab remotes.",
                path.display()
            ));
        }
        None => {
            for part in parts.iter_mut() {
                *part = strip_github_discovery_section(part);
            }
            parts.push(GH_CLI_UNAVAILABLE_INSTRUCTION.to_string());
        }
    }

    // GitLab CLI (optional, host-aware)
    match crate::glab_cli::config::resolve_available_glab_binary(app) {
        Some(path) => {
            parts.push(crate::glab_cli::config::glab_path_instruction(&path));
        }
        None => {
            parts.push(crate::glab_cli::config::GLAB_CLI_UNAVAILABLE_NOTE.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_jean_managed_location_shape() {
        let resolved = PathBuf::from(GH_CLI_DIR_NAME).join(GH_CLI_BINARY_NAME);

        assert!(resolved.ends_with(GH_CLI_BINARY_NAME));
        assert!(resolved.to_string_lossy().contains(GH_CLI_DIR_NAME));
    }

    #[test]
    fn strip_github_discovery_section_removes_middle_block() {
        let input = "\
## Core Principles
- Keep it simple

## GitHub Issue and Discussion Discovery
- Search issues after changes
- Include links in the recap

## Jean Worktree Policy
- Do not create worktrees manually";

        let stripped = strip_github_discovery_section(input);
        assert!(!stripped.contains("GitHub Issue and Discussion Discovery"));
        assert!(!stripped.contains("Search issues after changes"));
        assert!(stripped.contains("## Core Principles"));
        assert!(stripped.contains("## Jean Worktree Policy"));
        assert!(stripped.contains("Do not create worktrees manually"));
    }

    #[test]
    fn strip_github_discovery_section_is_noop_when_absent() {
        let input = "## Core Principles\n- Keep it simple";
        assert_eq!(strip_github_discovery_section(input), input);
    }

    #[test]
    fn strip_github_discovery_section_handles_trailing_section() {
        let input = "\
## Core Principles
- Keep it simple

## GitHub Issue and Discussion Discovery
- Search issues after changes
";
        let stripped = strip_github_discovery_section(input);
        assert_eq!(
            stripped,
            "## Core Principles\n- Keep it simple"
        );
    }
}
