use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::config::{
    binary_exists, ensure_cli_dir, find_system_kimi_binary, get_cli_binary_path, get_cli_dir,
    resolve_cli_binary,
};
use crate::platform::silent_command;

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const PACKAGE_NAME: &str = "@moonshot-ai/kimi-code";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KimiCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KimiAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KimiPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KimiModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KimiInstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KimiReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: String,
    pub prerelease: bool,
}

fn package(version: Option<&str>) -> String {
    match version.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("latest") => format!("{PACKAGE_NAME}@latest"),
        Some(value) if value.starts_with("@moonshot-ai/kimi-code@") => value.to_string(),
        Some(value) => format!("{PACKAGE_NAME}@{value}"),
    }
}

fn parse_version(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
        .map(|part| part.trim_start_matches('v').to_string())
}

fn semver_parts(version: &str) -> Vec<u32> {
    version
        .split(['-', '+'])
        .next()
        .unwrap_or(version)
        .split('.')
        .map(|part| part.parse().unwrap_or_default())
        .collect()
}

fn check_auth(binary: &std::path::Path) -> KimiAuthStatus {
    let mut command = crate::platform::cli_command(&binary.to_string_lossy(), None);
    command
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return KimiAuthStatus {
            authenticated: false,
            error: Some("Failed to start Kimi Code ACP".to_string()),
            timed_out: false,
        };
    };
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return KimiAuthStatus {
            authenticated: false,
            error: Some("Failed to open Kimi Code ACP stdin".to_string()),
            timed_out: false,
        };
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return KimiAuthStatus {
            authenticated: false,
            error: Some("Failed to read Kimi Code ACP stdout".to_string()),
            timed_out: false,
        };
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let initialize = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": 1, "clientCapabilities": {}}
    });
    if writeln!(stdin, "{initialize}").is_err() || stdin.flush().is_err() {
        let _ = child.kill();
        return KimiAuthStatus {
            authenticated: false,
            error: Some("Failed to initialize Kimi Code ACP".to_string()),
            timed_out: false,
        };
    }
    let deadline = Instant::now() + AUTH_TIMEOUT;
    let init = loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(line) => {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value.get("id").and_then(Value::as_i64) == Some(1) {
                        break value;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                return KimiAuthStatus {
                    authenticated: false,
                    error: Some("Kimi Code auth check timed out".to_string()),
                    timed_out: true,
                };
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                return KimiAuthStatus {
                    authenticated: false,
                    error: Some("Kimi Code ACP exited during auth check".to_string()),
                    timed_out: false,
                };
            }
        }
    };
    let method_id = init
        .pointer("/result/authMethods")
        .and_then(Value::as_array)
        .and_then(|methods| methods.first())
        .and_then(|method| method.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("login");
    let authenticate = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "authenticate",
        "params": {"methodId": method_id, "_meta": {"headless": true}}
    });
    if writeln!(stdin, "{authenticate}").is_err() || stdin.flush().is_err() {
        let _ = child.kill();
        return KimiAuthStatus {
            authenticated: false,
            error: Some("Failed to authenticate Kimi Code ACP".to_string()),
            timed_out: false,
        };
    }
    loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(line) => {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value.get("id").and_then(Value::as_i64) == Some(2) {
                        let _ = child.kill();
                        let error = value.get("error").map(|error| {
                            error
                                .get("message")
                                .and_then(Value::as_str)
                                .map(|message| {
                                    if message.eq_ignore_ascii_case("Authentication required") {
                                        "Authentication required. Run `kimi login`.".to_string()
                                    } else {
                                        message.to_string()
                                    }
                                })
                                .unwrap_or_else(|| error.to_string())
                        });
                        return KimiAuthStatus {
                            authenticated: error.is_none(),
                            error,
                            timed_out: false,
                        };
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                return KimiAuthStatus {
                    authenticated: false,
                    error: Some("Kimi Code auth check timed out".to_string()),
                    timed_out: true,
                };
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                return KimiAuthStatus {
                    authenticated: false,
                    error: Some("Run `kimi login` first".to_string()),
                    timed_out: false,
                };
            }
        }
    }
}

pub async fn check_kimi_cli_installed(app: AppHandle) -> Result<KimiCliStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(KimiCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }
    let version = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| parse_version(&output.stdout));
    Ok(KimiCliStatus {
        installed: true,
        version,
        path: Some(binary.to_string_lossy().to_string()),
    })
}

pub async fn detect_kimi_in_path(app: AppHandle) -> Result<KimiPathDetection, String> {
    let Some(binary) = find_system_kimi_binary(&app) else {
        return Ok(KimiPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };
    let version = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| parse_version(&output.stdout));
    Ok(KimiPathDetection {
        found: true,
        path: Some(binary.to_string_lossy().to_string()),
        version,
        package_manager: Some("path".to_string()),
    })
}

pub async fn check_kimi_cli_auth(app: AppHandle) -> Result<KimiAuthStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(KimiAuthStatus {
            authenticated: false,
            error: Some("Kimi Code CLI not installed".to_string()),
            timed_out: false,
        });
    }
    Ok(check_auth(&binary))
}

fn parse_models(value: &Value) -> Vec<KimiModelInfo> {
    let default_model = value
        .get("default_model")
        .or_else(|| value.get("defaultModel"))
        .and_then(Value::as_str);
    let mut models = value
        .get("models")
        .and_then(Value::as_object)
        .map(|models| {
            models
                .iter()
                .map(|(id, config)| KimiModelInfo {
                    id: id.clone(),
                    label: config
                        .get("display_name")
                        .or_else(|| config.get("displayName"))
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_string(),
                    is_default: default_model == Some(id.as_str()),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    models.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.label.cmp(&right.label))
    });
    models
}

pub async fn list_kimi_models(app: AppHandle) -> Result<Vec<KimiModelInfo>, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(Vec::new());
    }
    let output = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .args(["provider", "list", "--json"])
        .output()
        .map_err(|error| format!("Failed to list Kimi models: {error}"))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to parse Kimi model list: {error}"))?;
    Ok(parse_models(&value))
}

pub async fn get_available_kimi_versions(_app: AppHandle) -> Result<Vec<KimiReleaseInfo>, String> {
    let value: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Failed to build Kimi HTTP client: {error}"))?
        .get("https://registry.npmjs.org/%40moonshot-ai%2Fkimi-code")
        .send()
        .await
        .map_err(|error| format!("Failed to fetch Kimi versions: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse Kimi versions: {error}"))?;
    let latest = value
        .pointer("/dist-tags/latest")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut versions = value
        .get("versions")
        .and_then(Value::as_object)
        .map(|versions| {
            versions
                .keys()
                .map(|version| KimiReleaseInfo {
                    version: version.clone(),
                    tag_name: if version == latest { "latest" } else { version }.to_string(),
                    published_at: String::new(),
                    prerelease: version.contains('-'),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    versions.sort_by_key(|version| std::cmp::Reverse(semver_parts(&version.version)));
    Ok(versions)
}

pub async fn check_kimi_cli_version_exists(
    _app: AppHandle,
    version: String,
) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }
    let value: Value = reqwest::get("https://registry.npmjs.org/%40moonshot-ai%2Fkimi-code")
        .await
        .map_err(|error| format!("Failed to fetch Kimi versions: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse Kimi versions: {error}"))?;
    Ok(value
        .get("versions")
        .and_then(Value::as_object)
        .is_some_and(|versions| versions.contains_key(version)))
}

pub async fn get_kimi_install_command(app: AppHandle) -> Result<KimiInstallCommand, String> {
    let dir = get_cli_dir(&app)?;
    Ok(KimiInstallCommand {
        command: "npm".to_string(),
        args: vec![
            "install".to_string(),
            "--prefix".to_string(),
            dir.to_string_lossy().to_string(),
            package(None),
        ],
        description: "Install Kimi Code into Jean's managed app-data directory".to_string(),
    })
}

pub async fn install_kimi_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    let dir = ensure_cli_dir(&app)?;
    let output = silent_command("npm")
        .args(["install", "--prefix"])
        .arg(&dir)
        .arg(package(version.as_deref()))
        .output()
        .map_err(|error| format!("Failed to install Kimi Code: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Kimi Code install failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !get_cli_binary_path(&app)?.exists() {
        return Err("Kimi Code install completed but the binary was not found".to_string());
    }
    Ok(())
}

pub async fn uninstall_kimi_cli(app: AppHandle) -> Result<(), String> {
    let dir = get_cli_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|error| format!("Failed to remove Kimi Code CLI: {error}"))?;
    }
    Ok(())
}

pub async fn update_kimi_cli(app: AppHandle) -> Result<(), String> {
    install_kimi_cli(app, None).await
}

pub async fn login_kimi_cli_device(app: AppHandle) -> Result<(), String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Err("Kimi Code CLI not installed".to_string());
    }
    let output = tokio::task::spawn_blocking(move || {
        crate::platform::cli_command(&binary.to_string_lossy(), None)
            .arg("login")
            .output()
    })
    .await
    .map_err(|error| format!("Failed to join Kimi login task: {error}"))?
    .map_err(|error| format!("Failed to start Kimi login: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_uses_official_kimi_code_package() {
        assert_eq!(package(None), "@moonshot-ai/kimi-code@latest");
        assert_eq!(package(Some("0.26.0")), "@moonshot-ai/kimi-code@0.26.0");
    }

    #[test]
    fn parses_cli_version() {
        assert_eq!(
            parse_version(b"kimi-code 0.26.0\n").as_deref(),
            Some("0.26.0")
        );
    }

    #[test]
    fn parses_provider_model_list() {
        let models = parse_models(&serde_json::json!({
            "default_model": "kimi-code/kimi-for-coding",
            "models": {
                "other/model": {"display_name": "Other"},
                "kimi-code/kimi-for-coding": {"display_name": "Kimi for Coding"}
            }
        }));

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "kimi-code/kimi-for-coding");
        assert_eq!(models[0].label, "Kimi for Coding");
        assert!(models[0].is_default);
    }
}
