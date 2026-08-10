use crate::platform::get_wsl_config;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const CLI_DIR_NAME: &str = "antigravity-cli";

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_NAME: &str = "agy.exe";
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_NAME: &str = "agy";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourcePreference {
    Jean,
    Path,
    Missing,
}

pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CLI_DIR_NAME))
        .map_err(|error| format!("Failed to get app data directory: {error}"))
}

pub fn ensure_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_cli_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create Antigravity CLI directory: {error}"))?;
    Ok(dir)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join(MANAGED_CLI_BINARY_NAME))
}

fn source_preference(app: &AppHandle) -> SourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|value| {
            value
                .get("antigravity_cli_source")
                .cloned()
                .or_else(|| value.get("gemini_cli_source").cloned())
        })
        .map(|value| {
            if value.as_str() == Some("path") {
                SourcePreference::Path
            } else {
                SourcePreference::Jean
            }
        })
        .unwrap_or(SourcePreference::Missing)
}

pub fn find_system_antigravity_binary(app: &AppHandle) -> Option<PathBuf> {
    let managed = get_cli_binary_path(app)
        .ok()
        .and_then(|path| std::fs::canonicalize(path).ok());
    ["agy", "antigravity"].iter().find_map(|name| {
        crate::platform::detect_cli_in_path(name, managed.as_deref(), None)
            .path
            .map(PathBuf::from)
    })
}

pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(&wsl.distro, "agy", None)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("agy"));
    }
    let managed = get_cli_binary_path(app).ok().filter(|path| path.exists());
    let system = find_system_antigravity_binary(app);
    match source_preference(app) {
        SourcePreference::Path => system.unwrap_or_else(|| PathBuf::from("agy")),
        SourcePreference::Missing if system.is_some() => system.unwrap_or_default(),
        SourcePreference::Jean | SourcePreference::Missing => {
            managed.unwrap_or_else(|| PathBuf::from("agy"))
        }
    }
}

pub fn binary_exists(path: &Path) -> bool {
    if path.is_absolute() {
        path.exists()
    } else {
        which::which(path).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_binary_uses_official_agy_name() {
        assert_eq!(
            Path::new(MANAGED_CLI_BINARY_NAME)
                .file_stem()
                .and_then(|v| v.to_str()),
            Some("agy")
        );
    }
}
