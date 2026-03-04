//! Configuration and path management for the embedded Claude CLI

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Directory name for storing the Claude CLI binary
pub const CLI_DIR_NAME: &str = "claude-cli";

/// Name of the Claude CLI binary
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "claude.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "claude";

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

/// Resolve the Claude CLI binary to use for commands.
///
/// Returns the embedded binary path if it exists, otherwise falls back to
/// resolving `claude` from PATH.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let embedded_binary = get_cli_binary_path(app).ok().filter(|path| path.exists());
    let path_binary = which::which(CLI_BINARY_NAME).ok();

    resolve_cli_binary_with(embedded_binary, path_binary)
}

fn resolve_cli_binary_with(
    embedded_binary: Option<PathBuf>,
    path_binary: Option<PathBuf>,
) -> PathBuf {
    if let Some(embedded_binary) = embedded_binary {
        return embedded_binary;
    }

    if let Some(path_binary) = path_binary {
        return path_binary;
    }

    PathBuf::from(CLI_BINARY_NAME)
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
    fn resolve_cli_binary_prefers_embedded_binary() {
        let embedded = PathBuf::from("/tmp/jean/claude");
        let path_binary = PathBuf::from("/opt/homebrew/bin/claude");

        let resolved = resolve_cli_binary_with(Some(embedded.clone()), Some(path_binary));

        assert_eq!(resolved, embedded);
    }

    #[test]
    fn resolve_cli_binary_uses_path_binary_when_embedded_missing() {
        let path_binary = PathBuf::from("/opt/homebrew/bin/claude");

        let resolved = resolve_cli_binary_with(None, Some(path_binary.clone()));

        assert_eq!(resolved, path_binary);
    }

    #[test]
    fn resolve_cli_binary_falls_back_to_command_name() {
        let resolved = resolve_cli_binary_with(None, None);

        assert_eq!(resolved, PathBuf::from(CLI_BINARY_NAME));
    }
}
