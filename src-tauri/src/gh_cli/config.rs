//! Configuration and path management for the embedded GitHub CLI

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Directory name for storing the GitHub CLI binary
pub const GH_CLI_DIR_NAME: &str = "gh-cli";

/// Name of the GitHub CLI binary
#[cfg(not(target_os = "windows"))]
pub const GH_CLI_BINARY_NAME: &str = "gh";

#[cfg(target_os = "windows")]
pub const GH_CLI_BINARY_NAME: &str = "gh.exe";

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

/// Resolve the GitHub CLI binary to use for commands.
///
/// Returns the embedded binary path if it exists, otherwise falls back to
/// resolving `gh` from PATH.
pub fn resolve_gh_binary(app: &AppHandle) -> PathBuf {
    let embedded_binary = get_gh_cli_binary_path(app)
        .ok()
        .filter(|path| path.exists());
    let path_binary = which::which(GH_CLI_BINARY_NAME).ok();

    resolve_gh_binary_with(embedded_binary, path_binary)
}

fn resolve_gh_binary_with(
    embedded_binary: Option<PathBuf>,
    path_binary: Option<PathBuf>,
) -> PathBuf {
    if let Some(embedded_binary) = embedded_binary {
        return embedded_binary;
    }

    if let Some(path_binary) = path_binary {
        return path_binary;
    }

    PathBuf::from(GH_CLI_BINARY_NAME)
}

/// Ensure the CLI directory exists, creating it if necessary
pub fn ensure_gh_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_gh_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create GitHub CLI directory: {e}"))?;
    Ok(cli_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_gh_binary_prefers_embedded_binary() {
        let embedded = PathBuf::from("/tmp/jean/gh");
        let path_binary = PathBuf::from("/opt/homebrew/bin/gh");

        let resolved = resolve_gh_binary_with(Some(embedded.clone()), Some(path_binary));

        assert_eq!(resolved, embedded);
    }

    #[test]
    fn resolve_gh_binary_uses_path_binary_when_embedded_missing() {
        let path_binary = PathBuf::from("/opt/homebrew/bin/gh");

        let resolved = resolve_gh_binary_with(None, Some(path_binary.clone()));

        assert_eq!(resolved, path_binary);
    }

    #[test]
    fn resolve_gh_binary_falls_back_to_command_name() {
        let resolved = resolve_gh_binary_with(None, None);

        assert_eq!(resolved, PathBuf::from(GH_CLI_BINARY_NAME));
    }
}
