//! Resolve Hermes CLI binary and connection settings from preferences.

use super::types::HermesConnectionConfig;
use crate::platform::get_wsl_config;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:8642";
pub const DEFAULT_MODEL: &str = "hermes-agent";
pub const CLI_DIR_NAME: &str = "hermes-cli";
pub const INSTALL_SCRIPT_URL: &str = "https://hermes-agent.nousresearch.com/install.sh";

#[cfg(windows)]
const BINARY_CANDIDATES: &[&str] = &["hermes.exe", "hermes.cmd", "hermes.bat", "hermes"];
#[cfg(not(windows))]
const BINARY_CANDIDATES: &[&str] = &["hermes"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourcePreference {
    Jean,
    Path,
    Missing,
}

fn preferences_value(app: &AppHandle) -> Option<Value> {
    crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
}

fn pref_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn source_preference(app: &AppHandle) -> SourcePreference {
    preferences_value(app)
        .as_ref()
        .and_then(|v| pref_string(v, "hermes_cli_source"))
        .map(|s| {
            if s == "path" {
                SourcePreference::Path
            } else {
                SourcePreference::Jean
            }
        })
        .unwrap_or(SourcePreference::Missing)
}

/// Jean-managed install dir under app data (metadata / marker only; official
/// installer still places the real binary under ~/.local/bin or PATH).
pub fn get_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(CLI_DIR_NAME))
        .map_err(|error| format!("Failed to get app data directory: {error}"))
}

pub fn ensure_cli_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_cli_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create Hermes CLI directory: {error}"))?;
    Ok(dir)
}

/// Marker file written after a successful Jean-driven install.
pub fn install_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_cli_dir(app)?.join("installed-by-jean"))
}

pub fn mark_jean_installed(app: &AppHandle) -> Result<(), String> {
    let dir = ensure_cli_dir(app)?;
    std::fs::write(dir.join("installed-by-jean"), b"1")
        .map_err(|e| format!("Failed to write Hermes install marker: {e}"))
}

pub fn clear_jean_install_marker(app: &AppHandle) {
    if let Ok(path) = install_marker_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

pub fn was_jean_installed(app: &AppHandle) -> bool {
    install_marker_path(app)
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// Default Hermes home (`~/.hermes` or `$HERMES_HOME`).
pub fn hermes_home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HERMES_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".hermes")
}

pub fn hermes_env_path() -> PathBuf {
    hermes_home_dir().join(".env")
}

/// PATH hermes binary.
pub fn find_system_hermes_binary(_app: &AppHandle) -> Option<PathBuf> {
    let wsl = get_wsl_config();
    if wsl.enabled {
        return crate::platform::wsl_which(&wsl.distro, "hermes", None).map(PathBuf::from);
    }

    // Prefer user-local install first.
    if let Some(home) = dirs::home_dir() {
        let local = home.join(".local").join("bin").join("hermes");
        if local.exists() {
            return Some(local);
        }
    }

    for name in BINARY_CANDIDATES {
        if let Ok(path) = which::which(name) {
            return Some(path);
        }
    }

    let detection = crate::platform::detect_cli_in_path("hermes", None, None);
    detection.path.map(PathBuf::from)
}

pub fn resolve_cli_binary(app: &AppHandle) -> PathBuf {
    let system = find_system_hermes_binary(app);
    match source_preference(app) {
        SourcePreference::Path => system.unwrap_or_else(|| PathBuf::from("hermes")),
        SourcePreference::Missing if system.is_some() => {
            system.unwrap_or_else(|| PathBuf::from("hermes"))
        }
        SourcePreference::Jean | SourcePreference::Missing => {
            // Official installer puts hermes on PATH / ~/.local/bin even for Jean installs.
            system.unwrap_or_else(|| PathBuf::from("hermes"))
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

/// Read `API_SERVER_KEY` from `~/.hermes/.env` (or `$HERMES_HOME/.env`).
pub fn api_key_from_hermes_env() -> Option<String> {
    let contents = std::fs::read_to_string(hermes_env_path()).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let rest = line
            .strip_prefix("API_SERVER_KEY=")
            .or_else(|| line.strip_prefix("export API_SERVER_KEY="))?;
        let value = rest.trim().trim_matches('"').trim_matches('\'').trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

pub fn connection_config_from_prefs(app: &AppHandle) -> HermesConnectionConfig {
    let prefs = preferences_value(app);
    let base_url = prefs
        .as_ref()
        .and_then(|v| pref_string(v, "hermes_api_base_url"))
        .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string());
    // Prefer Jean prefs, then Hermes gateway .env so chat works without a
    // separate key paste when the local gateway already has API_SERVER_KEY.
    let api_key = prefs
        .as_ref()
        .and_then(|v| pref_string(v, "hermes_api_key"))
        .or_else(api_key_from_hermes_env);
    let profile = prefs
        .as_ref()
        .and_then(|v| pref_string(v, "hermes_profile"))
        .unwrap_or_default();
    HermesConnectionConfig {
        base_url,
        api_key,
        profile,
    }
}

pub fn selected_model_from_prefs(app: &AppHandle) -> String {
    preferences_value(app)
        .as_ref()
        .and_then(|v| pref_string(v, "selected_hermes_model"))
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

/// Persist Hermes connection fields without clobbering the rest of preferences.
pub fn patch_hermes_preferences(
    app: &AppHandle,
    api_key: Option<String>,
    cli_source: Option<&str>,
) -> Result<(), String> {
    let path = crate::get_preferences_path(app)?;
    let mut prefs = if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read preferences: {e}"))?;
        serde_json::from_str::<Value>(&contents)
            .map_err(|e| format!("Failed to parse preferences: {e}"))?
    } else {
        Value::Object(Default::default())
    };
    let obj = prefs
        .as_object_mut()
        .ok_or_else(|| "preferences.json is not an object".to_string())?;
    if let Some(key) = api_key {
        if key.trim().is_empty() {
            obj.remove("hermes_api_key");
        } else {
            obj.insert("hermes_api_key".into(), Value::String(key));
        }
    }
    if let Some(source) = cli_source {
        obj.insert(
            "hermes_cli_source".into(),
            Value::String(source.to_string()),
        );
    }
    if !obj.contains_key("hermes_api_base_url") {
        obj.insert(
            "hermes_api_base_url".into(),
            Value::String(DEFAULT_API_BASE_URL.to_string()),
        );
    }
    if !obj.contains_key("selected_hermes_model") {
        obj.insert(
            "selected_hermes_model".into(),
            Value::String(DEFAULT_MODEL.to_string()),
        );
    }
    let json = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {e}"))?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, &json).map_err(|e| format!("Failed to write preferences: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to finalize preferences: {e}")
    })?;
    Ok(())
}

/// Whether base URL is loopback (safe for local gateway management).
pub fn is_loopback_base_url(base_url: &str) -> bool {
    let lower = base_url.trim().to_ascii_lowercase();
    lower.contains("127.0.0.1")
        || lower.contains("localhost")
        || lower.contains("[::1]")
        || lower.contains("0.0.0.0")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_constants_are_loopback() {
        assert!(DEFAULT_API_BASE_URL.contains("127.0.0.1"));
        assert_eq!(DEFAULT_MODEL, "hermes-agent");
    }

    #[test]
    fn loopback_detection() {
        assert!(is_loopback_base_url("http://127.0.0.1:8642"));
        assert!(is_loopback_base_url("http://localhost:8642"));
        assert!(!is_loopback_base_url("https://hermes.example.com"));
    }
}
