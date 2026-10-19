//! Configuration and path resolution for Devin CLI.

use serde_json::Value;
use std::path::PathBuf;
use tauri::AppHandle;

pub const CLI_DIR_NAME: &str = "devin-cli";

/// Official Windows bundle binary (`bin/devin.exe` inside the zip).
#[cfg(windows)]
pub const MANAGED_CLI_BINARY_NAME: &str = "devin.exe";
#[cfg(not(windows))]
pub const MANAGED_CLI_BINARY_NAME: &str = "devin";

/// Unix name used for Jean-managed installs inside a WSL distro.
pub const CLI_BINARY_NAME_UNIX: &str = "devin";

#[cfg(windows)]
const MANAGED_CANDIDATES: &[&str] = &["devin.exe", "devin.cmd", "devin.bat"];
#[cfg(not(windows))]
const MANAGED_CANDIDATES: &[&str] = &["devin"];

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
        .map_err(|error| format!("Failed to create Devin CLI directory: {error}"))?;
    Ok(dir)
}

pub fn get_cli_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join(MANAGED_CLI_BINARY_NAME))
}

/// Full Unix path of the Jean-managed Devin CLI inside a WSL distro.
pub fn get_wsl_cli_binary_path(distro: &str) -> Result<String, String> {
    let home = crate::platform::get_wsl_home_dir(distro)?;
    Ok(format!(
        "{home}/.local/share/jean/{CLI_DIR_NAME}/{CLI_BINARY_NAME_UNIX}"
    ))
}

fn find_managed_binary(app: &AppHandle) -> Option<PathBuf> {
    let dir = get_cli_dir(app).ok()?;
    MANAGED_CANDIDATES
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.exists())
}

pub fn find_system_devin_binary(app: &AppHandle) -> Option<PathBuf> {
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(
            &wsl.distro,
            "devin",
            get_wsl_cli_binary_path(&wsl.distro).ok().as_deref(),
        )
        .map(PathBuf::from);
    }

    let managed = find_managed_binary(app)
        .or_else(|| get_cli_binary_path(app).ok())
        .and_then(|path| std::fs::canonicalize(path).ok());
    crate::platform::detect_cli_in_path("devin", managed.as_deref(), None)
        .path
        .map(PathBuf::from)
}

fn source_preference(app: &AppHandle) -> SourcePreference {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|value| value.get("devin_cli_source").cloned())
        .map(|value| {
            if value.as_str() == Some("jean") {
                SourcePreference::Jean
            } else {
                SourcePreference::Path
            }
        })
        .unwrap_or(SourcePreference::Missing)
}

fn jean_managed_path(app: &AppHandle) -> PathBuf {
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(CLI_BINARY_NAME_UNIX));
    }
    find_managed_binary(app)
        .or_else(|| get_cli_binary_path(app).ok())
        .unwrap_or_else(|| PathBuf::from("devin"))
}

fn jean_managed_installed(app: &AppHandle) -> bool {
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        return get_wsl_cli_binary_path(&wsl.distro)
            .map(|path| crate::platform::wsl_file_executable(&wsl.distro, &path))
            .unwrap_or(false);
    }
    find_managed_binary(app).is_some()
}

/// Resolve the Devin binary from the source preference.
///
/// `"jean"` (the default) uses the app-managed binary, then a PATH install.
/// `"path"` uses the system binary, then the managed one.
pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let system = find_system_devin_binary(app);
    match source_preference(app) {
        SourcePreference::Path => system.unwrap_or_else(|| jean_managed_path(app)),
        SourcePreference::Jean | SourcePreference::Missing => {
            if jean_managed_installed(app) {
                jean_managed_path(app)
            } else {
                system.unwrap_or_else(|| jean_managed_path(app))
            }
        }
    }
}

pub fn binary_exists(path: &PathBuf) -> bool {
    if path.is_absolute() || crate::platform::is_wsl_unix_path(path) {
        crate::platform::resolved_cli_exists(path)
    } else {
        which::which(path).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_binary_uses_devin_name() {
        assert_eq!(MANAGED_CLI_BINARY_NAME.split('.').next(), Some("devin"));
    }
}
