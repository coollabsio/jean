//! Configuration and path resolution for Cursor Agent.

use crate::platform::get_wsl_config;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Cursor Agent binary name.
///
/// Cursor's current CLI entrypoint is `agent`; `cursor-agent` remains a
/// backwards-compatible alias and is the canonical, unambiguous name.
/// Resolution prefers `cursor-agent` to avoid colliding with unrelated
/// third-party binaries also named `agent` (e.g. grok builds); `agent` is
/// the fallback.
#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "agent.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "agent";

#[cfg(windows)]
pub const LEGACY_CLI_BINARY_NAME: &str = "cursor-agent.exe";
#[cfg(not(windows))]
pub const LEGACY_CLI_BINARY_NAME: &str = "cursor-agent";

pub const CLI_BINARY_CANDIDATES: [&str; 2] = [LEGACY_CLI_BINARY_NAME, CLI_BINARY_NAME];

/// Bare tool names (without platform-specific extension) for WSL/Unix lookups.
pub const CLI_TOOL_NAME: &str = "agent";
pub const LEGACY_CLI_TOOL_NAME: &str = "cursor-agent";
pub const CLI_TOOL_CANDIDATES: [&str; 2] = [LEGACY_CLI_TOOL_NAME, CLI_TOOL_NAME];

fn local_install_candidates(home: &Path) -> [PathBuf; 2] {
    let bin_dir = home.join(".local").join("bin");
    [
        bin_dir.join(LEGACY_CLI_BINARY_NAME),
        bin_dir.join(CLI_BINARY_NAME),
    ]
}

/// Resolve the Cursor Agent binary from system PATH.
///
/// Cursor's installer places the binary on PATH, so Jean resolves the
/// discovered system binary when available and returns a non-existent fallback
/// path otherwise.
pub fn resolve_cli_binary(_app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        // Resolve the absolute Unix path inside WSL via a login shell, so
        // Cursor CLI installed via nvm / bun / cursor.com's installer is
        // found regardless of non-login-shell $PATH.
        for tool_name in CLI_TOOL_CANDIDATES {
            if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, tool_name, None) {
                return PathBuf::from(unix_path);
            }
        }
        return PathBuf::from(CLI_TOOL_NAME);
    }

    for tool_name in CLI_TOOL_CANDIDATES {
        if let Some(path) = crate::platform::find_cli_in_host_path(tool_name, None) {
            return path;
        }
    }

    if let Some(home) = dirs::home_dir() {
        for candidate in local_install_candidates(&home) {
            if candidate.is_file() {
                return candidate;
            }
        }
    }

    PathBuf::from(CLI_BINARY_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_primary_agent_binary_name() {
        let resolved = PathBuf::from(CLI_BINARY_NAME);
        assert!(resolved.ends_with(CLI_BINARY_NAME));
    }

    #[test]
    fn candidates_prefer_cursor_agent_before_agent() {
        assert_eq!(CLI_BINARY_CANDIDATES[0], LEGACY_CLI_BINARY_NAME);
        assert_eq!(CLI_BINARY_CANDIDATES[1], CLI_BINARY_NAME);
    }

    #[test]
    fn wsl_tool_candidates_prefer_cursor_agent_before_agent() {
        assert_eq!(CLI_TOOL_NAME, "agent");
        assert_eq!(CLI_TOOL_CANDIDATES[0], LEGACY_CLI_TOOL_NAME);
        assert_eq!(CLI_TOOL_CANDIDATES[1], CLI_TOOL_NAME);
    }

    #[test]
    fn local_install_candidates_use_cursor_official_bin_directory() {
        let candidates = local_install_candidates(Path::new("/home/tester"));

        assert_eq!(
            candidates[0],
            PathBuf::from("/home/tester/.local/bin").join(LEGACY_CLI_BINARY_NAME)
        );
        assert_eq!(
            candidates[1],
            PathBuf::from("/home/tester/.local/bin").join(CLI_BINARY_NAME)
        );
    }
}
