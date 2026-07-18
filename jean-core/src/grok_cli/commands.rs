//! Tauri commands for Grok Build CLI management.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::config::{
    binary_exists, ensure_cli_dir, find_system_grok_binary, get_cli_binary_path, get_cli_dir,
    resolve_cli_binary,
};
use crate::platform::silent_command;

const AUTH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const MODELS_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrokCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrokInstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrokReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: String,
    pub prerelease: bool,
}

const GROK_NPM_PACKAGE: &str = "@xai-official/grok";

fn grok_package(version: Option<&str>) -> String {
    match version.map(str::trim).filter(|v| !v.is_empty()) {
        Some("latest") | None => format!("{GROK_NPM_PACKAGE}@latest"),
        Some(version) if version.starts_with("@xai-official/grok@") => version.to_string(),
        Some(version) => format!("{GROK_NPM_PACKAGE}@{version}"),
    }
}

fn semver_parts(version: &str) -> Vec<u32> {
    version
        .split(['-', '+'])
        .next()
        .unwrap_or(version)
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

fn fallback_models() -> Vec<GrokModelInfo> {
    vec![GrokModelInfo {
        id: "grok-4.5".to_string(),
        label: "Grok 4.5".to_string(),
        is_default: true,
    }]
}

fn format_model_label(id: &str) -> String {
    id.split('-')
        .map(|part| {
            if part.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
                part.to_string()
            } else {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_models_output(stdout: &[u8]) -> Vec<GrokModelInfo> {
    let text = strip_ansi(&String::from_utf8_lossy(stdout));
    let mut default_model = None;
    let mut models = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("Default model:") {
            default_model = Some(value.trim().to_string());
            continue;
        }

        let Some(candidate) = line.strip_prefix('*').or_else(|| line.strip_prefix('-')) else {
            continue;
        };
        let id = candidate
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let is_default = candidate.contains("(default)")
            || default_model
                .as_deref()
                .is_some_and(|default_model| default_model == id);
        models.push(GrokModelInfo {
            label: format_model_label(&id),
            id,
            is_default,
        });
    }

    if let Some(default_model) = default_model {
        for model in &mut models {
            model.is_default = model.is_default || model.id == default_model;
        }
        models.sort_by_key(|model| !model.is_default);
    }

    models
}

enum TimedCommandResult {
    Output(Output),
    TimedOut,
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().is_some_and(|c| *c == '[') {
                let _ = chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn parse_version(stdout: &[u8]) -> Option<String> {
    let text = strip_ansi(&String::from_utf8_lossy(stdout));
    text.split_whitespace()
        .find(|part| part.chars().any(|ch| ch.is_ascii_digit()) && part.contains('.'))
        .map(|part| part.trim_start_matches('v').to_string())
        .or_else(|| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
}

fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<TimedCommandResult, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn command: {error}"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            if let Some(mut handle) = child.stdout.take() {
                let _ = handle.read_to_end(&mut stdout);
            }
            if let Some(mut handle) = child.stderr.take() {
                let _ = handle.read_to_end(&mut stderr);
            }
            return Ok(TimedCommandResult::Output(Output {
                status,
                stdout,
                stderr,
            }));
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(TimedCommandResult::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn choose_auth_method(init: &Value) -> Option<String> {
    choose_auth_method_with_api_key(
        init,
        std::env::var("XAI_API_KEY")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false),
    )
}

fn choose_auth_method_with_api_key(init: &Value, has_api_key: bool) -> Option<String> {
    let methods = init
        .get("authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ids = methods
        .iter()
        .filter_map(|method| method.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if has_api_key && ids.contains(&"xai.api_key") {
        return Some("xai.api_key".to_string());
    }
    if ids.contains(&"cached_token") {
        return Some("cached_token".to_string());
    }
    None
}

fn check_auth_via_acp(binary: &std::path::Path) -> GrokAuthStatus {
    let mut child = match crate::platform::cli_command(&binary.to_string_lossy(), None)
        .args(["agent", "stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return GrokAuthStatus {
                authenticated: false,
                error: Some(format!("Failed to spawn Grok ACP: {e}")),
                timed_out: false,
            }
        }
    };

    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill();
            return GrokAuthStatus {
                authenticated: false,
                error: Some("Failed to open Grok ACP stdin".to_string()),
                timed_out: false,
            };
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            return GrokAuthStatus {
                authenticated: false,
                error: Some("Failed to open Grok ACP stdout".to_string()),
                timed_out: false,
            };
        }
    };
    // Blocking read_line() can hang past the deadline if Grok ACP stalls without
    // emitting a newline. Move the blocking reads to a dedicated thread that streams
    // lines over a channel, so the loops below honor the deadline via recv_timeout().
    let reader = BufReader::new(stdout);
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Dropping tx on EOF/error disconnects the channel, unblocking recv_timeout().
    });
    let deadline = Instant::now() + AUTH_CHECK_TIMEOUT;

    let initialize = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": true },
                "terminal": false
            }
        }
    });
    if writeln!(stdin, "{initialize}").is_err() {
        let _ = child.kill();
        return GrokAuthStatus {
            authenticated: false,
            error: Some("Failed to write Grok ACP initialize request".to_string()),
            timed_out: false,
        };
    }

    let init_result = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                    if value.get("id").and_then(Value::as_i64) == Some(1) {
                        break value.get("result").cloned();
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                return GrokAuthStatus {
                    authenticated: false,
                    error: Some("Grok auth check timed out".to_string()),
                    timed_out: true,
                };
            }
            Err(RecvTimeoutError::Disconnected) => break None,
        }
    };

    let Some(init) = init_result else {
        let _ = child.kill();
        return GrokAuthStatus {
            authenticated: false,
            error: Some("Grok ACP did not return initialize result".to_string()),
            timed_out: false,
        };
    };
    let Some(method_id) = choose_auth_method(&init) else {
        let _ = child.kill();
        return GrokAuthStatus {
            authenticated: false,
            error: Some("Run `grok login` first, or set XAI_API_KEY.".to_string()),
            timed_out: false,
        };
    };

    let authenticate = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "authenticate",
        "params": { "methodId": method_id, "_meta": { "headless": true } }
    });
    if writeln!(stdin, "{authenticate}").is_err() {
        let _ = child.kill();
        return GrokAuthStatus {
            authenticated: false,
            error: Some("Failed to write Grok ACP authenticate request".to_string()),
            timed_out: false,
        };
    }

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                    if value.get("id").and_then(Value::as_i64) == Some(2) {
                        let _ = child.kill();
                        if let Some(error) = value.get("error") {
                            return GrokAuthStatus {
                                authenticated: false,
                                error: Some(error.to_string()),
                                timed_out: false,
                            };
                        }
                        return GrokAuthStatus {
                            authenticated: true,
                            error: None,
                            timed_out: false,
                        };
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                return GrokAuthStatus {
                    authenticated: false,
                    error: Some("Grok auth check timed out".to_string()),
                    timed_out: true,
                };
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = child.kill();
    GrokAuthStatus {
        authenticated: false,
        error: Some("Grok ACP exited before authentication completed".to_string()),
        timed_out: false,
    }
}

pub async fn check_grok_cli_installed(app: AppHandle) -> Result<GrokCliStatus, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_exists(&binary_path) {
        return Ok(GrokCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }
    let version = match crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
    {
        Ok(output) if output.status.success() => parse_version(&output.stdout),
        _ => None,
    };
    Ok(GrokCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

pub async fn detect_grok_in_path(app: AppHandle) -> Result<GrokPathDetection, String> {
    let Some(path) = find_system_grok_binary(&app) else {
        return Ok(GrokPathDetection {
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
        .and_then(|out| parse_version(&out.stdout));
    Ok(GrokPathDetection {
        found: true,
        path: Some(path.to_string_lossy().to_string()),
        version,
        package_manager: Some("path".to_string()),
    })
}

pub async fn check_grok_cli_auth(app: AppHandle) -> Result<GrokAuthStatus, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_exists(&binary_path) {
        return Ok(GrokAuthStatus {
            authenticated: false,
            error: Some("Grok CLI not installed".to_string()),
            timed_out: false,
        });
    }
    Ok(check_auth_via_acp(&binary_path))
}

pub async fn list_grok_models(app: AppHandle) -> Result<Vec<GrokModelInfo>, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_exists(&binary_path) {
        return Ok(fallback_models());
    }

    let mut command = crate::platform::cli_command(&binary_path.to_string_lossy(), None);
    command.arg("models");
    let result = run_command_with_timeout(command, MODELS_CHECK_TIMEOUT)?;
    match result {
        TimedCommandResult::Output(output) if output.status.success() => {
            let models = parse_models_output(&output.stdout);
            Ok(if models.is_empty() {
                fallback_models()
            } else {
                models
            })
        }
        _ => Ok(fallback_models()),
    }
}

pub async fn get_available_grok_versions(_app: AppHandle) -> Result<Vec<GrokReleaseInfo>, String> {
    let url = "https://registry.npmjs.org/%40xai-official%2Fgrok";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build Grok HTTP client: {e}"))?;
    let value: serde_json::Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Grok versions: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse Grok version response: {e}"))?;
    let latest = value
        .get("dist-tags")
        .and_then(|tags| tags.get("latest"))
        .and_then(|tag| tag.as_str())
        .unwrap_or_default()
        .to_string();
    let mut versions = value
        .get("versions")
        .and_then(|v| v.as_object())
        .map(|object| {
            object
                .keys()
                .map(|version| GrokReleaseInfo {
                    version: version.clone(),
                    tag_name: if version == &latest {
                        "latest".to_string()
                    } else {
                        version.clone()
                    },
                    published_at: String::new(),
                    prerelease: version.contains('-'),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    versions.sort_by_key(|release| std::cmp::Reverse(semver_parts(&release.version)));
    Ok(versions)
}

pub async fn check_grok_cli_version_exists(
    _app: AppHandle,
    version: String,
) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }

    let url = "https://registry.npmjs.org/%40xai-official%2Fgrok";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build Grok HTTP client: {e}"))?;
    let value: serde_json::Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Grok versions: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse Grok version response: {e}"))?;
    Ok(value
        .get("versions")
        .and_then(|v| v.as_object())
        .is_some_and(|versions| versions.contains_key(version)))
}

pub async fn get_grok_install_command(app: AppHandle) -> Result<GrokInstallCommand, String> {
    let cli_dir = get_cli_dir(&app)?;
    Ok(GrokInstallCommand {
        command: "npm".to_string(),
        args: vec![
            "install".to_string(),
            "--prefix".to_string(),
            cli_dir.to_string_lossy().to_string(),
            grok_package(None),
        ],
        description: "Install the latest Grok CLI into Jean's managed app-data directory"
            .to_string(),
    })
}

pub async fn install_grok_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    let cli_dir = ensure_cli_dir(&app)?;
    let package = grok_package(version.as_deref());
    let output = silent_command("npm")
        .args(["install", "--prefix"])
        .arg(&cli_dir)
        .arg(package)
        .output()
        .map_err(|e| format!("Failed to run npm install for Grok CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(format!(
            "Grok CLI install failed: {}",
            if stderr.is_empty() { stdout } else { stderr }
        ));
    }

    let binary_path = get_cli_binary_path(&app)?;
    if !binary_path.exists() {
        return Err(format!(
            "Grok install completed but binary was not found at {}",
            binary_path.display()
        ));
    }

    let verify = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to verify Grok CLI: {e}"))?;
    if !verify.status.success() {
        return Err("Grok CLI verification failed".to_string());
    }

    Ok(())
}

pub async fn uninstall_grok_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove Grok CLI directory: {e}"))?;
    }
    Ok(())
}

pub async fn update_grok_cli(app: AppHandle) -> Result<(), String> {
    install_grok_cli(app, None).await
}

pub async fn login_grok_cli_device(app: AppHandle) -> Result<(), String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_exists(&binary_path) {
        return Err("Grok CLI not installed".to_string());
    }
    // Device-auth waits for the user to confirm in a browser, which can take far
    // longer than AUTH_CHECK_TIMEOUT. Run it to completion without an artificial
    // kill timeout (the CLI enforces its own) so we never report success/pending
    // for a process we already terminated. Use spawn_blocking to avoid stalling
    // the async runtime while the child waits on user input.
    let output = tokio::task::spawn_blocking(move || {
        crate::platform::cli_command(&binary_path.to_string_lossy(), None)
            .args(["login", "--device-auth"])
            .output()
    })
    .await
    .map_err(|error| format!("Failed to join Grok login task: {error}"))?
    .map_err(|error| format!("Failed to spawn Grok login: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
        Err(if stderr.trim().is_empty() {
            "Grok login failed".to_string()
        } else {
            stderr.trim().to_string()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choose_auth_method_prefers_api_key_when_available() {
        let init = serde_json::json!({
            "authMethods": [{"id":"cached_token"}, {"id":"xai.api_key"}]
        });
        assert_eq!(
            choose_auth_method_with_api_key(&init, true),
            Some("xai.api_key".to_string())
        );
    }

    #[test]
    fn choose_auth_method_uses_cached_token_without_api_key() {
        let init = serde_json::json!({
            "authMethods": [{"id":"cached_token"}]
        });
        assert_eq!(
            choose_auth_method_with_api_key(&init, false),
            Some("cached_token".to_string())
        );
    }

    #[test]
    fn grok_package_uses_latest_by_default_and_accepts_versions() {
        assert_eq!(grok_package(None), "@xai-official/grok@latest");
        assert_eq!(grok_package(Some("latest")), "@xai-official/grok@latest");
        assert_eq!(grok_package(Some("1.2.3")), "@xai-official/grok@1.2.3");
        assert_eq!(
            grok_package(Some("@xai-official/grok@2.0.0")),
            "@xai-official/grok@2.0.0"
        );
    }

    #[test]
    fn parse_models_output_reads_current_grok_cli_format() {
        let output = br#"
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
"#;

        let models = parse_models_output(output);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "grok-4.5");
        assert_eq!(models[0].label, "Grok 4.5");
        assert!(models[0].is_default);
    }
}
