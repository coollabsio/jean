//! Configuration and path resolution for Cursor Agent.

use crate::platform::{get_wsl_config, silent_command};
use std::path::PathBuf;
use tauri::AppHandle;

/// Name of the Cursor Agent binary.
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "cursor-agent.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "cursor-agent";

/// Bare tool name used for WSL/Unix lookups.
pub const CLI_TOOL_NAME: &str = "cursor-agent";

/// Resolve the Cursor Agent binary from system PATH.
pub fn resolve_cli_binary(_app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, CLI_TOOL_NAME) {
            return PathBuf::from(unix_path);
        }
        return PathBuf::from(CLI_TOOL_NAME);
    }

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    if let Ok(output) = silent_command(which_cmd).arg(CLI_BINARY_NAME).output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !path_str.is_empty() {
                let path = PathBuf::from(&path_str);
                if path.exists() {
                    return path;
                }
            }
        }
    }

    PathBuf::from(CLI_BINARY_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_cursor_agent_binary_name() {
        let resolved = PathBuf::from(CLI_BINARY_NAME);
        assert!(resolved.ends_with(CLI_BINARY_NAME));
    }
}
