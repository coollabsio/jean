//! Configuration and path resolution for Command Code CLI.

use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

/// Directory name for Jean-managed Command Code npm install.
pub const CLI_DIR_NAME: &str = "commandcode-cli";

#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "cmdc";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "cmd";
pub const LEGACY_CLI_BINARY_NAME: &str = "command-code";

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_NAME: &str = "cmdc.cmd";
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_NAME: &str = CLI_BINARY_NAME;

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_CANDIDATES: &[&str] = &[
    "cmdc.cmd",
    "cmdc.exe",
    "cmdc.bat",
    "cmd.cmd",
    "cmd.exe",
    "command-code.cmd",
    "command-code.exe",
];
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_CANDIDATES: &[&str] =
    &[CLI_BINARY_NAME, LEGACY_CLI_BINARY_NAME, "cmdc"];

#[cfg(windows)]
pub const CLI_TOOL_CANDIDATES: &[&str] = &["cmdc", "cmd", LEGACY_CLI_BINARY_NAME];
#[cfg(not(windows))]
pub const CLI_TOOL_CANDIDATES: &[&str] = &[CLI_BINARY_NAME, LEGACY_CLI_BINARY_NAME, "cmdc"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandCodeSourcePreference {
    ExplicitJean,
    ExplicitPath,
    Missing,
}

pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(CLI_DIR_NAME))
}

pub fn ensure_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create Command Code CLI directory: {e}"))?;
    Ok(cli_dir)
}

fn managed_bin_dir_from_dir(cli_dir: PathBuf) -> PathBuf {
    cli_dir.join("node_modules").join(".bin")
}

pub fn managed_binary_path_from_dir(cli_dir: PathBuf) -> PathBuf {
    managed_bin_dir_from_dir(cli_dir).join(MANAGED_CLI_BINARY_NAME)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_binary_path_from_dir(get_cli_dir(app)?))
}

pub fn managed_binary_candidates_from_dir(cli_dir: PathBuf) -> Vec<PathBuf> {
    let bin_dir = managed_bin_dir_from_dir(cli_dir);
    MANAGED_CLI_BINARY_CANDIDATES
        .iter()
        .map(|candidate| bin_dir.join(candidate))
        .collect()
}

pub fn find_managed_commandcode_binary(app: &AppHandle) -> Option<PathBuf> {
    let cli_dir = get_cli_dir(app).ok()?;
    managed_binary_candidates_from_dir(cli_dir)
        .into_iter()
        .find(|path| path.exists())
}

fn source_preference_from_value(value: &Value) -> CommandCodeSourcePreference {
    match value.get("commandcode_cli_source") {
        Some(value) if value.as_str() == Some("path") => CommandCodeSourcePreference::ExplicitPath,
        Some(_) => CommandCodeSourcePreference::ExplicitJean,
        None => CommandCodeSourcePreference::Missing,
    }
}

fn read_source_preference(app: &AppHandle) -> CommandCodeSourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|prefs_path| std::fs::read_to_string(prefs_path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .map(|value| source_preference_from_value(&value))
        .unwrap_or(CommandCodeSourcePreference::Missing)
}

pub fn should_use_system_path(
    source_preference: CommandCodeSourcePreference,
    system_commandcode_found: bool,
) -> bool {
    match source_preference {
        CommandCodeSourcePreference::ExplicitPath => system_commandcode_found,
        CommandCodeSourcePreference::ExplicitJean => false,
        // Keep migration safe for old preferences that lacked the field: use a
        // PATH install only when no explicit Jean preference exists.
        CommandCodeSourcePreference::Missing => system_commandcode_found,
    }
}

pub fn find_system_commandcode_binary(app: &AppHandle) -> Option<PathBuf> {
    let jean_managed_path = find_managed_commandcode_binary(app)
        .or_else(|| get_cli_binary_path(app).ok())
        .and_then(|path| std::fs::canonicalize(path).ok());

    for candidate in CLI_TOOL_CANDIDATES {
        let detection =
            crate::platform::detect_cli_in_path(candidate, jean_managed_path.as_deref(), None);
        if detection.found {
            if let Some(path) = detection.path {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// Resolve Command Code binary path based on the user's preference.
///
/// If `commandcode_cli_source` is `"path"`, use a system PATH binary when one
/// exists. Otherwise use the Jean-managed npm install under app data.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let source_preference = read_source_preference(app);
    let system_path = find_system_commandcode_binary(app);

    if should_use_system_path(source_preference, system_path.is_some()) {
        if let Some(path) = system_path {
            return path;
        }
    }

    if source_preference == CommandCodeSourcePreference::ExplicitPath {
        log::warn!("commandcode_cli_source is 'path' but Command Code was not found in PATH; falling back to Jean-managed binary");
    }

    find_managed_commandcode_binary(app).unwrap_or_else(|| {
        get_cli_binary_path(app)
            .unwrap_or_else(|_| PathBuf::from(CLI_DIR_NAME).join(MANAGED_CLI_BINARY_NAME))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn managed_path_points_to_npm_bin_dir() {
        let path = managed_binary_path_from_dir(PathBuf::from("/tmp/jean/commandcode-cli"));
        assert!(path.ends_with(
            PathBuf::from("node_modules")
                .join(".bin")
                .join(MANAGED_CLI_BINARY_NAME)
        ));
    }

    #[test]
    fn managed_candidates_are_separate_from_path_tool_names() {
        assert!(MANAGED_CLI_BINARY_CANDIDATES.contains(&MANAGED_CLI_BINARY_NAME));
        assert!(CLI_TOOL_CANDIDATES.contains(&CLI_BINARY_NAME));
        assert!(!CLI_TOOL_CANDIDATES
            .iter()
            .any(|name| name.ends_with(".ps1")));
    }

    #[test]
    fn explicit_jean_source_never_uses_system_path() {
        assert!(!should_use_system_path(
            CommandCodeSourcePreference::ExplicitJean,
            true
        ));
        assert!(!should_use_system_path(
            CommandCodeSourcePreference::ExplicitJean,
            false
        ));
    }

    #[test]
    fn explicit_path_source_uses_system_path_when_available() {
        assert!(should_use_system_path(
            CommandCodeSourcePreference::ExplicitPath,
            true
        ));
        assert!(!should_use_system_path(
            CommandCodeSourcePreference::ExplicitPath,
            false
        ));
    }
}
