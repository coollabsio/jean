//! Configuration and path management for the embedded GitLab CLI

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Directory name for storing the GitLab CLI binary
pub const GLAB_CLI_DIR_NAME: &str = "glab-cli";

/// Name of the GitLab CLI binary
#[cfg(not(target_os = "windows"))]
pub const GLAB_CLI_BINARY_NAME: &str = "glab";

#[cfg(target_os = "windows")]
pub const GLAB_CLI_BINARY_NAME: &str = "glab.exe";

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

/// Ensure the CLI directory exists, creating it if necessary
pub fn ensure_glab_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_glab_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create GitLab CLI directory: {e}"))?;
    Ok(cli_dir)
}
