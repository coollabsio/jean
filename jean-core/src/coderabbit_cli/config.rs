//! Configuration and path management for the CodeRabbit CLI.

use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

pub const CODERABBIT_CLI_DIR_NAME: &str = "coderabbit-cli";

#[cfg(windows)]
pub const CODERABBIT_BINARY_NAME: &str = "coderabbit.exe";
#[cfg(not(windows))]
pub const CODERABBIT_BINARY_NAME: &str = "coderabbit";

pub fn get_coderabbit_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    Ok(app_data_dir.join(CODERABBIT_CLI_DIR_NAME))
}

pub fn get_coderabbit_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_coderabbit_cli_dir(app)?.join(CODERABBIT_BINARY_NAME))
}

pub fn ensure_coderabbit_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cli_dir = get_coderabbit_cli_dir(app)?;
    std::fs::create_dir_all(&cli_dir)
        .map_err(|e| format!("Failed to create CodeRabbit CLI directory: {e}"))?;
    Ok(cli_dir)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodeRabbitSourcePreference {
    ExplicitJean,
    ExplicitPath,
    Missing,
}

fn source_preference_from_value(value: &Value) -> CodeRabbitSourcePreference {
    match value.get("coderabbit_cli_source") {
        Some(value) if value.as_str() == Some("path") => CodeRabbitSourcePreference::ExplicitPath,
        Some(_) => CodeRabbitSourcePreference::ExplicitJean,
        None => CodeRabbitSourcePreference::Missing,
    }
}

fn read_source_preference(app: &AppHandle) -> CodeRabbitSourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|prefs_path| std::fs::read_to_string(prefs_path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .map(|value| source_preference_from_value(&value))
        .unwrap_or(CodeRabbitSourcePreference::Missing)
}

fn should_use_system_path(
    source_preference: CodeRabbitSourcePreference,
    jean_managed_installed: bool,
    system_coderabbit_found: bool,
) -> bool {
    match source_preference {
        CodeRabbitSourcePreference::ExplicitPath => system_coderabbit_found,
        CodeRabbitSourcePreference::ExplicitJean => false,
        CodeRabbitSourcePreference::Missing => !jean_managed_installed && system_coderabbit_found,
    }
}

fn which_coderabbit(jean_managed: Option<&std::path::Path>) -> Option<PathBuf> {
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(&wsl.distro, "coderabbit", None).map(PathBuf::from);
    }

    crate::platform::find_cli_in_host_path("coderabbit", jean_managed)
}

pub fn find_system_coderabbit_binary(app: &AppHandle) -> Option<PathBuf> {
    let jean_managed_path = get_coderabbit_binary_path(app)
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok());

    which_coderabbit(jean_managed_path.as_deref())
}

pub fn jean_managed_coderabbit_installed(app: &AppHandle) -> bool {
    get_coderabbit_binary_path(app)
        .map(|path| path.exists())
        .unwrap_or(false)
}

pub fn should_auto_use_system_coderabbit(app: &AppHandle) -> bool {
    !jean_managed_coderabbit_installed(app) && find_system_coderabbit_binary(app).is_some()
}

pub fn resolve_coderabbit_binary(app: &AppHandle) -> PathBuf {
    let source_preference = read_source_preference(app);
    let jean_managed_path = get_coderabbit_binary_path(app)
        .unwrap_or_else(|_| PathBuf::from(CODERABBIT_CLI_DIR_NAME).join(CODERABBIT_BINARY_NAME));
    let jean_managed_installed = jean_managed_path.exists();
    let system_path = find_system_coderabbit_binary(app);

    if should_use_system_path(
        source_preference,
        jean_managed_installed,
        system_path.is_some(),
    ) {
        if let Some(path) = system_path {
            return path;
        }
    }

    if source_preference == CodeRabbitSourcePreference::ExplicitPath {
        log::warn!("coderabbit_cli_source is 'path' but coderabbit was not found in PATH; falling back to Jean-managed binary");
    }

    jean_managed_path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_source_uses_system_only_without_managed_binary() {
        assert!(should_use_system_path(
            CodeRabbitSourcePreference::Missing,
            false,
            true
        ));
        assert!(!should_use_system_path(
            CodeRabbitSourcePreference::Missing,
            true,
            true
        ));
        assert!(!should_use_system_path(
            CodeRabbitSourcePreference::Missing,
            false,
            false
        ));
    }

    #[test]
    fn explicit_source_overrides_auto_detection() {
        assert!(!should_use_system_path(
            CodeRabbitSourcePreference::ExplicitJean,
            false,
            true
        ));
        assert!(should_use_system_path(
            CodeRabbitSourcePreference::ExplicitPath,
            true,
            true
        ));
        assert!(!should_use_system_path(
            CodeRabbitSourcePreference::ExplicitPath,
            true,
            false
        ));
    }

    #[test]
    fn parses_raw_source_preference_without_serde_defaults() {
        assert_eq!(
            source_preference_from_value(&serde_json::json!({ "coderabbit_cli_source": "path" })),
            CodeRabbitSourcePreference::ExplicitPath
        );
        assert_eq!(
            source_preference_from_value(&serde_json::json!({ "coderabbit_cli_source": "jean" })),
            CodeRabbitSourcePreference::ExplicitJean
        );
        assert_eq!(
            source_preference_from_value(&serde_json::json!({})),
            CodeRabbitSourcePreference::Missing
        );
        assert_eq!(
            source_preference_from_value(
                &serde_json::json!({ "coderabbit_cli_source": "invalid" })
            ),
            CodeRabbitSourcePreference::ExplicitJean
        );
    }
}
