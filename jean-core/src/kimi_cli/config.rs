use crate::platform::get_wsl_config;
use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

pub const CLI_DIR_NAME: &str = "kimi-code-cli";

#[cfg(windows)]
pub const MANAGED_CLI_BINARY_NAME: &str = "kimi.cmd";
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_NAME: &str = "kimi";

#[cfg(windows)]
const MANAGED_CANDIDATES: &[&str] = &["kimi.cmd", "kimi.exe", "kimi.bat"];
#[cfg(not(windows))]
const MANAGED_CANDIDATES: &[&str] = &["kimi"];

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
        .map_err(|error| format!("Failed to create Kimi Code CLI directory: {error}"))?;
    Ok(dir)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?
        .join("node_modules")
        .join(".bin")
        .join(MANAGED_CLI_BINARY_NAME))
}

fn find_managed_binary(app: &AppHandle) -> Option<PathBuf> {
    let bin_dir = get_cli_dir(app).ok()?.join("node_modules").join(".bin");
    MANAGED_CANDIDATES
        .iter()
        .map(|name| bin_dir.join(name))
        .find(|path| path.exists())
}

fn source_preference(app: &AppHandle) -> SourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|value| value.get("kimi_cli_source").cloned())
        .map(|value| {
            if value.as_str() == Some("path") {
                SourcePreference::Path
            } else {
                SourcePreference::Jean
            }
        })
        .unwrap_or(SourcePreference::Missing)
}

pub fn find_system_kimi_binary(app: &AppHandle) -> Option<PathBuf> {
    let managed = find_managed_binary(app)
        .or_else(|| get_cli_binary_path(app).ok())
        .and_then(|path| std::fs::canonicalize(path).ok());
    let detection = crate::platform::detect_cli_in_path("kimi", managed.as_deref(), None);
    detection.path.map(PathBuf::from)
}

pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(&wsl.distro, "kimi", None)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("kimi"));
    }

    let system = find_system_kimi_binary(app);
    match source_preference(app) {
        SourcePreference::Path => system.unwrap_or_else(|| PathBuf::from("kimi")),
        SourcePreference::Missing if system.is_some() => system.unwrap_or_default(),
        SourcePreference::Jean | SourcePreference::Missing => find_managed_binary(app)
            .or_else(|| get_cli_binary_path(app).ok())
            .unwrap_or_else(|| PathBuf::from("kimi")),
    }
}

pub fn binary_exists(path: &PathBuf) -> bool {
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
    fn managed_binary_uses_kimi_name() {
        assert_eq!(MANAGED_CLI_BINARY_NAME.split('.').next(), Some("kimi"));
    }
}
