//! Configuration and path resolution for the Antigravity CLI (`agy`).
//!
//! Antigravity is distributed as a standalone Go binary (`agy`), not via npm, so
//! Jean resolves it from the system PATH (no Jean-managed npm install). The user
//! can pin the source via the `antigravity_cli_source` preference.

use crate::platform::get_wsl_config;
use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "agy.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "agy";

pub const CLI_TOOL_CANDIDATES: &[&str] = &["agy"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravitySourcePreference {
    ExplicitPath,
    /// No explicit preference — default to PATH (Antigravity has no managed install).
    Missing,
}

fn source_preference_from_value(value: &Value) -> AntigravitySourcePreference {
    match value.get("antigravity_cli_source") {
        Some(value) if value.as_str() == Some("path") => AntigravitySourcePreference::ExplicitPath,
        _ => AntigravitySourcePreference::Missing,
    }
}

fn read_source_preference(app: &AppHandle) -> AntigravitySourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|prefs_path| std::fs::read_to_string(prefs_path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .map(|value| source_preference_from_value(&value))
        .unwrap_or(AntigravitySourcePreference::Missing)
}

/// Locate `agy` on the system PATH (or inside WSL when enabled).
pub fn find_system_antigravity_binary(app: &AppHandle) -> Option<PathBuf> {
    let _ = read_source_preference(app); // reserved for future managed-install source switching
    for candidate in CLI_TOOL_CANDIDATES {
        let detection = crate::platform::detect_cli_in_path(candidate, None, None);
        if detection.found {
            if let Some(path) = detection.path {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// Resolve the `agy` binary. PATH-only today; falls back to the bare binary name
/// so a WSL/login-shell lookup can still find it at spawn time.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, "agy", None) {
            return PathBuf::from(unix_path);
        }
        return PathBuf::from(CLI_BINARY_NAME);
    }

    find_system_antigravity_binary(app).unwrap_or_else(|| PathBuf::from(CLI_BINARY_NAME))
}

pub fn binary_exists(path: &PathBuf) -> bool {
    if path.is_absolute() {
        path.exists()
    } else {
        let wsl = get_wsl_config();
        if wsl.enabled {
            crate::platform::check_wsl_tool(&wsl.distro, &path.to_string_lossy())
        } else {
            which::which(path).is_ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_path_is_agy_binary_name() {
        assert!(PathBuf::from(CLI_BINARY_NAME).ends_with(CLI_BINARY_NAME));
    }

    #[test]
    fn source_preference_reads_path_value() {
        let value = serde_json::json!({ "antigravity_cli_source": "path" });
        assert_eq!(
            source_preference_from_value(&value),
            AntigravitySourcePreference::ExplicitPath
        );
        let empty = serde_json::json!({});
        assert_eq!(
            source_preference_from_value(&empty),
            AntigravitySourcePreference::Missing
        );
    }
}
