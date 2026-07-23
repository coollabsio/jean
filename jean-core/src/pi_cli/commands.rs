//! Tauri commands for PI CLI management.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tauri::AppHandle;

use super::config::{find_pi_in_path, get_cli_dir, resolve_cli_binary};
use crate::platform::silent_command;

const PI_NPM_PACKAGE: &str = "@earendil-works/pi-coding-agent";

// NOTE: These structs intentionally use snake_case on the wire (no
// `#[serde(rename_all = "camelCase")]`). PI path/status detection is routed
// through the SAME shared `useCliVersionCheck` hook as gh/codex/coderabbit/cursor,
// all of which read snake_case fields (`package_manager`, `is_default`). The TS
// types in `src/types/pi-cli.ts` match this. Switching PI alone to camelCase
// would break that shared hook and diverge from its siblings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiReleaseInfo {
    pub version: String,
    pub prerelease: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}

fn parse_version(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    stdout
        .split_whitespace()
        .chain(stderr.split_whitespace())
        .find(|part| part.chars().any(|ch| ch.is_ascii_digit()))
        .map(|s| s.trim_start_matches('v').to_string())
}

fn format_pi_provider(provider: &str) -> String {
    match provider.to_lowercase().as_str() {
        "openai" => "OpenAI".to_string(),
        "openai-codex" => "OpenAI Codex".to_string(),
        "openrouter" => "OpenRouter".to_string(),
        "anthropic" => "Anthropic".to_string(),
        other => other
            .split('-')
            .filter(|part| !part.is_empty())
            .map(format_pi_token)
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn format_pi_token(token: &str) -> String {
    match token.to_lowercase().as_str() {
        "gpt" => "GPT".to_string(),
        "codex" => "Codex".to_string(),
        "spark" => "Spark".to_string(),
        "mini" => "Mini".to_string(),
        "sonnet" => "Sonnet".to_string(),
        "opus" => "Opus".to_string(),
        "haiku" => "Haiku".to_string(),
        _ if token.chars().all(|ch| ch.is_ascii_digit() || ch == '.') => token.to_string(),
        _ => {
            let mut chars = token.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        }
    }
}

fn format_pi_model_label(provider: &str, model: &str) -> String {
    let model_label = model
        .split(['-', '_', ':'])
        .filter(|part| !part.is_empty())
        .map(format_pi_token)
        .collect::<Vec<_>>()
        .join(" ");
    format!("{model_label} ({})", format_pi_provider(provider))
}

fn parse_pi_models(stdout: &[u8], stderr: &[u8]) -> Vec<PiModelInfo> {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    let mut models = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let provider = parts.next()?;
            let model = parts.next()?;
            if provider.eq_ignore_ascii_case("provider") || model.eq_ignore_ascii_case("model") {
                return None;
            }
            Some(PiModelInfo {
                id: format!("{provider}/{model}"),
                label: format_pi_model_label(provider, model),
                is_default: false,
            })
        })
        .collect::<Vec<_>>();
    if let Some(first) = models.first_mut() {
        first.is_default = true;
    }
    models
}

#[cfg(test)]
mod tests {
    use super::{default_pi_models, parse_pi_models, parse_version};

    #[test]
    fn parse_version_reads_pi_version_from_stderr() {
        assert_eq!(parse_version(b"", b"0.78.1\n"), Some("0.78.1".into()));
    }

    #[test]
    fn parse_pi_models_reads_active_provider_models_from_stderr() {
        let models = parse_pi_models(
            b"",
            b"provider      model\nopenai-codex  gpt-5.4\nopenai-codex  gpt-5.5\n",
        );

        assert_eq!(models[0].id, "openai-codex/gpt-5.4");
        assert_eq!(models[0].label, "GPT 5.4 (OpenAI Codex)");
        assert!(models[0].is_default);
        assert_eq!(models[1].id, "openai-codex/gpt-5.5");
        assert!(!models[1].is_default);
    }

    #[test]
    fn default_pi_models_keeps_legacy_sonnet_default_for_unavailable_cli() {
        let models = default_pi_models();

        assert_eq!(models[0].id, "sonnet");
        assert!(models[0].is_default);
        assert!(models.iter().skip(1).all(|model| !model.is_default));
    }
}

fn pi_auth_file_exists() -> bool {
    dirs::home_dir()
        .map(|home| home.join(".pi").join("agent").join("auth.json"))
        .filter(|path| path.exists())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|contents| !contents.trim().is_empty() && contents.trim() != "{}")
        .unwrap_or(false)
}

fn pi_env_auth_exists() -> bool {
    [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "OPENROUTER_API_KEY",
    ]
    .iter()
    .any(|key| {
        std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .is_some()
    })
}

pub async fn check_pi_cli_installed(app: AppHandle) -> Result<PiCliStatus, String> {
    let path = resolve_cli_binary(&app);
    if !path.exists() {
        return Ok(PiCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }
    let version = crate::platform::cli_command(&path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse_version(&o.stdout, &o.stderr));
    Ok(PiCliStatus {
        installed: true,
        version,
        path: Some(path.to_string_lossy().to_string()),
    })
}

pub async fn detect_pi_in_path(_app: AppHandle) -> Result<PiPathDetection, String> {
    let Some(path) = find_pi_in_path() else {
        return Ok(PiPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };
    let version = crate::platform::cli_command(&path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse_version(&o.stdout, &o.stderr));
    let package_manager = crate::platform::detect_package_manager(&path);
    Ok(PiPathDetection {
        found: true,
        path: Some(path.to_string_lossy().to_string()),
        version,
        package_manager,
    })
}

pub async fn check_pi_cli_auth(_app: AppHandle) -> Result<PiAuthStatus, String> {
    let authenticated = pi_auth_file_exists() || pi_env_auth_exists();
    Ok(PiAuthStatus {
        authenticated,
        error: if authenticated {
            None
        } else {
            Some(
                "Not authenticated. Run `pi` and use /login, or configure a provider API key."
                    .into(),
            )
        },
    })
}

pub async fn list_pi_models(app: AppHandle) -> Result<Vec<PiModelInfo>, String> {
    let path = resolve_cli_binary(&app);
    if !path.exists() {
        return Ok(default_pi_models());
    }
    let output = crate::platform::cli_command(&path.to_string_lossy(), None)
        .arg("--list-models")
        .output();
    let Ok(output) = output else {
        return Ok(default_pi_models());
    };
    if !output.status.success() {
        return Ok(default_pi_models());
    }
    let mut models = parse_pi_models(&output.stdout, &output.stderr);
    if models.is_empty() {
        models = default_pi_models();
    }
    // Merge Jean-managed custom providers from models.json so the picker
    // shows configured models even when the active auth provider differs.
    for model in models_from_pi_models_json() {
        if !models.iter().any(|existing| existing.id == model.id) {
            models.push(model);
        }
    }
    Ok(models)
}

fn pi_agent_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home directory found")?;
    Ok(home.join(".pi").join("agent"))
}

fn pi_models_json_path() -> Result<std::path::PathBuf, String> {
    Ok(pi_agent_dir()?.join("models.json"))
}

fn read_pi_models_json() -> Result<serde_json::Value, String> {
    let path = pi_models_json_path()?;
    if !path.exists() {
        return Ok(serde_json::json!({ "providers": {} }));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(serde_json::json!({ "providers": {} }));
    }
    serde_json::from_str(&raw).map_err(|e| format!("Invalid PI models.json: {e}"))
}

fn write_pi_models_json(value: &serde_json::Value) -> Result<(), String> {
    let path = pi_models_json_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let pretty = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize models.json: {e}"))?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, pretty).map_err(|e| format!("Failed to write models.json: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to finalize models.json: {e}")
    })?;
    Ok(())
}

fn models_from_pi_models_json() -> Vec<PiModelInfo> {
    let Ok(root) = read_pi_models_json() else {
        return Vec::new();
    };
    let Some(providers) = root.get("providers").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (provider_id, provider) in providers {
        let Some(models) = provider.get("models").and_then(|v| v.as_array()) else {
            continue;
        };
        for model in models {
            let Some(model_id) = model.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let label = model
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(model_id);
            out.push(PiModelInfo {
                id: format!("{provider_id}/{model_id}"),
                label: format!("{label} ({provider_id})"),
                is_default: false,
            });
        }
    }
    out
}

/// Upsert a custom PI provider into `~/.pi/agent/models.json` under `providers.<name>`.
/// Never overwrites unrelated providers or touches `auth.json`.
pub async fn upsert_pi_provider(profile: crate::PiProviderProfile) -> Result<(), String> {
    let name = profile.name.trim();
    if name.is_empty() {
        return Err("Provider name is required".to_string());
    }
    if name.contains('/') || name.contains(' ') {
        return Err("Provider name must be a single token (no spaces or slashes)".to_string());
    }
    if profile.base_url.trim().is_empty() {
        return Err("Base URL is required".to_string());
    }
    if profile.models.is_empty() {
        return Err("At least one model is required".to_string());
    }

    let mut root = read_pi_models_json()?;
    if !root.is_object() {
        root = serde_json::json!({ "providers": {} });
    }
    let providers = root
        .as_object_mut()
        .ok_or("models.json root must be an object")?
        .entry("providers".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !providers.is_object() {
        *providers = serde_json::json!({});
    }
    let providers_map = providers
        .as_object_mut()
        .ok_or("models.json providers must be an object")?;

    let mut entry = serde_json::Map::new();
    entry.insert(
        "baseUrl".to_string(),
        serde_json::json!(profile.base_url.trim()),
    );
    entry.insert("api".to_string(), serde_json::json!(profile.api.trim()));
    if let Some(env) = profile
        .api_key_env
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let key_ref = if env.starts_with('$') {
            env.to_string()
        } else {
            format!("${env}")
        };
        entry.insert("apiKey".to_string(), serde_json::json!(key_ref));
    }
    let models_json: Vec<serde_json::Value> = profile
        .models
        .iter()
        .filter(|m| !m.id.trim().is_empty())
        .map(|m| {
            let mut model = serde_json::Map::new();
            model.insert("id".to_string(), serde_json::json!(m.id.trim()));
            if let Some(label) = m.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                model.insert("name".to_string(), serde_json::json!(label));
            }
            serde_json::Value::Object(model)
        })
        .collect();
    if models_json.is_empty() {
        return Err("At least one model with a non-empty id is required".to_string());
    }
    entry.insert("models".to_string(), serde_json::Value::Array(models_json));

    providers_map.insert(name.to_string(), serde_json::Value::Object(entry));
    write_pi_models_json(&root)?;
    log::info!("Upserted PI provider '{name}' into models.json");
    Ok(())
}

/// Remove a Jean-managed provider entry from `~/.pi/agent/models.json`.
pub async fn delete_pi_provider(name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Provider name is required".to_string());
    }
    let mut root = read_pi_models_json()?;
    if let Some(providers) = root.get_mut("providers").and_then(|v| v.as_object_mut()) {
        providers.remove(name);
        write_pi_models_json(&root)?;
        log::info!("Deleted PI provider '{name}' from models.json");
    }
    Ok(())
}

#[cfg(test)]
mod provider_merge_tests {
    use super::*;
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_home<T>(f: impl FnOnce() -> T) -> T {
        let _guard = LOCK.lock().unwrap();
        let dir = tempfile::tempdir().expect("tempdir");
        let prev = std::env::var_os("HOME");
        // SAFETY: tests serialize on LOCK; HOME is restored after the closure.
        unsafe {
            std::env::set_var("HOME", dir.path());
        }
        let result = f();
        unsafe {
            match prev {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
        result
    }

    #[tokio::test]
    async fn upsert_merges_without_clobbering_sibling_providers() {
        with_temp_home(|| {
            let existing = serde_json::json!({
                "providers": {
                    "keep-me": {
                        "baseUrl": "http://localhost:1",
                        "api": "openai-completions",
                        "models": [{ "id": "a" }]
                    }
                }
            });
            write_pi_models_json(&existing).unwrap();
        });
        // Re-run inside same home for async call
        let _guard = LOCK.lock().unwrap();
        let dir = tempfile::tempdir().expect("tempdir");
        let prev = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", dir.path());
        }
        let existing = serde_json::json!({
            "providers": {
                "keep-me": {
                    "baseUrl": "http://localhost:1",
                    "api": "openai-completions",
                    "models": [{ "id": "a" }]
                }
            }
        });
        write_pi_models_json(&existing).unwrap();

        upsert_pi_provider(crate::PiProviderProfile {
            name: "openrouter".to_string(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            api: "openai-completions".to_string(),
            api_key_env: Some("OPENROUTER_API_KEY".to_string()),
            models: vec![crate::PiProviderModel {
                id: "anthropic/claude-sonnet-4".to_string(),
                name: Some("Sonnet".to_string()),
            }],
        })
        .await
        .unwrap();

        let root = read_pi_models_json().unwrap();
        assert!(root["providers"]["keep-me"].is_object());
        assert_eq!(
            root["providers"]["openrouter"]["apiKey"],
            "$OPENROUTER_API_KEY"
        );
        assert_eq!(
            root["providers"]["openrouter"]["models"][0]["id"],
            "anthropic/claude-sonnet-4"
        );
        unsafe {
            match prev {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[tokio::test]
    async fn delete_removes_only_named_provider() {
        let _guard = LOCK.lock().unwrap();
        let dir = tempfile::tempdir().expect("tempdir");
        let prev = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", dir.path());
        }
        write_pi_models_json(&serde_json::json!({
            "providers": {
                "a": { "baseUrl": "http://a", "api": "openai-completions", "models": [] },
                "b": { "baseUrl": "http://b", "api": "openai-completions", "models": [] }
            }
        }))
        .unwrap();
        delete_pi_provider("a".into()).await.unwrap();
        let root = read_pi_models_json().unwrap();
        assert!(root["providers"].get("a").is_none());
        assert!(root["providers"]["b"].is_object());
        unsafe {
            match prev {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }
}

fn default_pi_models() -> Vec<PiModelInfo> {
    ["sonnet", "sonnet:high", "opus", "haiku"]
        .iter()
        .map(|id| PiModelInfo {
            id: (*id).to_string(),
            label: id.replace(['-', '_', ':'], " "),
            is_default: *id == "sonnet",
        })
        .collect()
}

/// Split a semver string into numeric components for ordering, so `0.10.0`
/// correctly sorts ahead of `0.9.0` (string ordering gets this wrong).
fn semver_parts(version: &str) -> Vec<u32> {
    version
        .split(['.', '-'])
        .map(|p| p.parse::<u32>().unwrap_or(0))
        .collect()
}

pub async fn get_available_pi_versions(_app: AppHandle) -> Result<Vec<PiReleaseInfo>, String> {
    let url = "https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build PI HTTP client: {e}"))?;
    let value: serde_json::Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch PI versions: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse PI version response: {e}"))?;
    let mut versions = value
        .get("versions")
        .and_then(|v| v.as_object())
        .map(|object| {
            object
                .keys()
                .map(|version| PiReleaseInfo {
                    version: version.clone(),
                    prerelease: version.contains('-'),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    versions.sort_by_key(|release| std::cmp::Reverse(semver_parts(&release.version)));
    Ok(versions)
}

pub async fn check_pi_cli_version_exists(_app: AppHandle, version: String) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }

    let url = "https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build PI HTTP client: {e}"))?;
    let value: serde_json::Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch PI versions: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse PI version response: {e}"))?;
    Ok(value
        .get("versions")
        .and_then(|v| v.as_object())
        .is_some_and(|versions| versions.contains_key(version)))
}

pub async fn install_pi_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    let dir = get_cli_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create PI CLI dir: {e}"))?;
    let package = match version {
        Some(version) if !version.trim().is_empty() => format!("{PI_NPM_PACKAGE}@{version}"),
        _ => PI_NPM_PACKAGE.to_string(),
    };
    let status = silent_command("npm")
        .args(["install", "--prefix"])
        .arg(&dir)
        .arg("--ignore-scripts")
        .arg(&package)
        .status()
        .map_err(|e| format!("Failed to run npm install for PI: {e}"))?;
    if !status.success() {
        return Err("npm install for PI failed".to_string());
    }
    Ok(())
}

pub async fn uninstall_pi_cli(app: AppHandle) -> Result<(), String> {
    let dir = get_cli_dir(&app)?;
    if Path::new(&dir).exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to remove PI CLI directory: {e}"))?;
    }
    Ok(())
}
