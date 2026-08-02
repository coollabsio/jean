//! Configuration and path resolution for the Antigravity CLI (`agy`).
//!
//! Antigravity is distributed as a standalone Go binary (`agy`), not via npm, so
//! Jean resolves it from the system PATH (no Jean-managed npm install). The user
//! can pin the source via the `antigravity_cli_source` preference.

use crate::platform::get_wsl_config;
use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

pub const CLI_DIR_NAME: &str = "antigravity-cli";

#[cfg(windows)]
pub const CLI_BINARY_NAME: &str = "agy.exe";
#[cfg(not(windows))]
pub const CLI_BINARY_NAME: &str = "agy";

pub const CLI_TOOL_CANDIDATES: &[&str] = &["agy"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravitySourcePreference {
    /// Use the Jean-managed binary under app-data (installed via the CLI installer).
    ExplicitJean,
    /// Use a system PATH binary.
    ExplicitPath,
    /// No explicit preference — default to PATH.
    Missing,
}

fn source_preference_from_value(value: &Value) -> AntigravitySourcePreference {
    match value.get("antigravity_cli_source") {
        Some(value) if value.as_str() == Some("path") => AntigravitySourcePreference::ExplicitPath,
        Some(value) if value.as_str() == Some("jean") => AntigravitySourcePreference::ExplicitJean,
        _ => AntigravitySourcePreference::Missing,
    }
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
        .map_err(|e| format!("Failed to create Antigravity CLI directory: {e}"))?;
    Ok(cli_dir)
}

/// Managed installs land the binary under `<app-data>/antigravity-cli/bin/agy`.
pub fn managed_binary_path_from_dir(cli_dir: PathBuf) -> PathBuf {
    cli_dir.join("bin").join(CLI_BINARY_NAME)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_binary_path_from_dir(get_cli_dir(app)?))
}

pub fn find_managed_antigravity_binary(app: &AppHandle) -> Option<PathBuf> {
    let path = get_cli_binary_path(app).ok()?;
    path.exists().then_some(path)
}

fn read_source_preference(app: &AppHandle) -> AntigravitySourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|prefs_path| std::fs::read_to_string(prefs_path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .map(|value| source_preference_from_value(&value))
        .unwrap_or(AntigravitySourcePreference::Missing)
}

/// Locate `agy` on the system PATH (or inside WSL when enabled). Ignores the
/// managed binary so PATH detection stays independent of the source preference.
pub fn find_system_antigravity_binary(app: &AppHandle) -> Option<PathBuf> {
    let managed = find_managed_antigravity_binary(app)
        .and_then(|path| std::fs::canonicalize(path).ok());
    for candidate in CLI_TOOL_CANDIDATES {
        let detection =
            crate::platform::detect_cli_in_path(candidate, managed.as_deref(), None);
        if detection.found {
            if let Some(path) = detection.path {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

/// Resolve the `agy` binary based on the user's source preference.
/// `jean` → Jean-managed install; `path`/unset → system PATH. Falls back to the
/// bare binary name so a WSL/login-shell lookup can still find it at spawn time.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        if let Some(unix_path) = crate::platform::wsl_which(&wsl.distro, "agy", None) {
            return PathBuf::from(unix_path);
        }
        return PathBuf::from(CLI_BINARY_NAME);
    }

    let source = read_source_preference(app);
    if source == AntigravitySourcePreference::ExplicitJean {
        if let Some(managed) = find_managed_antigravity_binary(app) {
            return managed;
        }
        log::warn!(
            "antigravity_cli_source is 'jean' but no managed binary found; falling back to PATH"
        );
    }

    find_system_antigravity_binary(app)
        .or_else(|| find_managed_antigravity_binary(app))
        .unwrap_or_else(|| PathBuf::from(CLI_BINARY_NAME))
}

/// Antigravity refuses to operate on an untrusted workspace and blocks on an
/// interactive trust prompt — fatal for headless runs. Add `working_dir` to the
/// CLI's `trustedWorkspaces` list in `~/.gemini/antigravity-cli/settings.json`
/// (best-effort; silently no-ops if the settings file is absent/unreadable).
pub fn auto_trust_workspace(working_dir: &std::path::Path) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let settings_file = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("settings.json");
    let dir_str = working_dir.to_string_lossy().to_string();

    // Load existing settings, or start a fresh object if the file is missing.
    let mut value: Value = std::fs::read_to_string(&settings_file)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));

    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let mut changed = false;
    match obj.get_mut("trustedWorkspaces").and_then(Value::as_array_mut) {
        Some(trusted) => {
            if !trusted.iter().any(|v| v.as_str() == Some(&dir_str)) {
                trusted.push(Value::String(dir_str));
                changed = true;
            }
        }
        None => {
            obj.insert(
                "trustedWorkspaces".to_string(),
                Value::Array(vec![Value::String(dir_str)]),
            );
            changed = true;
        }
    }

    if changed {
        if let Some(parent) = settings_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(serialized) = serde_json::to_string_pretty(&value) {
            let _ = std::fs::write(&settings_file, serialized);
        }
    }
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
