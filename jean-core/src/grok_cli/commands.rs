//! Tauri commands for Grok Build CLI management.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use super::config::{
    binary_exists, ensure_cli_dir, find_system_grok_binary, get_cli_binary_path, get_cli_dir,
    resolve_cli_binary,
};
use crate::platform::silent_command;

const AUTH_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const MODELS_CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// Official Grok CLI subscription usage endpoints (consumer OAuth, not API-key TPM).
const GROK_BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_CLI_USER_URL: &str = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const GROK_TASK_USAGE_URL: &str = "https://grok.com/rest/tasks/usage";
const GROK_TOKEN_ENDPOINT: &str = "https://auth.x.ai/oauth2/token";
const GROK_DEFAULT_OIDC_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_USAGE_CACHE_TTL_SECS: u64 = 5 * 60;
const FALLBACK_GROK_CLIENT_VERSION: &str = "0.2.103";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokUsageWindowSnapshot {
    pub used_percent: f64,
    pub resets_at: Option<u64>,
    pub limit_window_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokProductUsageSnapshot {
    pub product: String,
    pub used_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokUsageSnapshot {
    pub plan_type: Option<String>,
    /// Overall weekly credit usage percent from billing config.
    pub weekly: Option<GrokUsageWindowSnapshot>,
    /// Grok Build product usage (primary CLI product).
    pub session: Option<GrokUsageWindowSnapshot>,
    pub products: Vec<GrokProductUsageSnapshot>,
    pub frequent_used: Option<f64>,
    pub frequent_limit: Option<f64>,
    pub occasional_used: Option<f64>,
    pub occasional_limit: Option<f64>,
    pub has_grok_code_access: Option<bool>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GrokUsageCacheEntry {
    cached_at: u64,
    snapshot: GrokUsageSnapshot,
}

#[derive(Debug, Clone)]
struct GrokAuthCredentials {
    access_token: String,
    refresh_token: Option<String>,
    expires_at_secs: Option<i64>,
    client_id: String,
    token_endpoint: String,
    auth_registry_key: Option<String>,
    auth_path: PathBuf,
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

fn current_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn get_usage_cache_dir() -> Option<PathBuf> {
    let base = dirs::cache_dir().or_else(|| dirs::home_dir().map(|h| h.join(".cache")))?;
    Some(base.join("jean").join("usage-cache"))
}

fn get_grok_usage_cache_path() -> Option<PathBuf> {
    Some(get_usage_cache_dir()?.join("grok.json"))
}

fn load_cached_grok_usage(now_secs: u64) -> Option<GrokUsageSnapshot> {
    let path = get_grok_usage_cache_path()?;
    let content = std::fs::read_to_string(path).ok()?;
    let entry: GrokUsageCacheEntry = serde_json::from_str(&content).ok()?;
    if now_secs.saturating_sub(entry.cached_at) <= GROK_USAGE_CACHE_TTL_SECS {
        return Some(entry.snapshot);
    }
    None
}

fn save_cached_grok_usage(snapshot: &GrokUsageSnapshot, now_secs: u64) {
    let Some(path) = get_grok_usage_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let entry = GrokUsageCacheEntry {
        cached_at: now_secs,
        snapshot: snapshot.clone(),
    };
    if let Ok(serialized) = serde_json::to_string_pretty(&entry) {
        let _ = std::fs::write(path, serialized);
    }
}

fn official_grok_auth_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".grok").join("auth.json"))
}

fn parse_rfc3339_secs(value: &str) -> Option<i64> {
    // Prefer chrono if available via date parsing without extra deps:
    // accept RFC3339-ish timestamps by splitting at non-numeric boundaries.
    // Use a lightweight approach: SystemTime via `humantime` is not present;
    // parse with chrono from the workspace if available, else manual.
    chrono_lite_rfc3339(value)
}

/// Minimal RFC3339 → unix seconds parser (no extra crate dependency).
fn chrono_lite_rfc3339(value: &str) -> Option<i64> {
    // Try `time` crate is not guaranteed; use `chrono` if already a dep via
    // other modules. Fall back to `httpdate` style via DateTime if present.
    // Jean already uses `chrono` transitively; prefer SystemTime::UNIX_EPOCH math.
    // Use `chrono` from workspace dependencies.
    // Manual parse: YYYY-MM-DDTHH:MM:SS[.frac][Z|±HH:MM]
    let s = value.trim();
    let (date, rest) = s.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i32 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;

    let rest = rest.trim_end_matches('Z');
    let (time_part, offset_part) = if let Some(idx) = rest.rfind(['+', '-']) {
        if idx > 0 {
            (&rest[..idx], Some(&rest[idx..]))
        } else {
            (rest, None)
        }
    } else {
        (rest, None)
    };
    let time_part = time_part.split('.').next()?;
    let mut time_parts = time_part.split(':');
    let hour: u32 = time_parts.next()?.parse().ok()?;
    let minute: u32 = time_parts.next()?.parse().ok()?;
    let second: u32 = time_parts.next()?.parse().ok()?;

    let days = days_from_civil(year, month, day)?;
    let mut secs =
        days * 86_400 + i64::from(hour) * 3600 + i64::from(minute) * 60 + i64::from(second);

    if let Some(offset) = offset_part {
        let sign = if offset.starts_with('-') { -1i64 } else { 1i64 };
        let body = offset.trim_start_matches(['+', '-']);
        let mut op = body.split(':');
        let oh: i64 = op.next()?.parse().ok()?;
        let om: i64 = op.next().unwrap_or("0").parse().ok()?;
        secs -= sign * (oh * 3600 + om * 60);
    }

    Some(secs)
}

/// Howard Hinnant civil-from-days inverse (proleptic Gregorian → days since 1970-01-01).
fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || day == 0 || day > 31 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(i64::from(era) * 146_097 + i64::from(doe) - 719_468)
}

fn load_grok_auth_credentials() -> Result<GrokAuthCredentials, String> {
    let auth_path = official_grok_auth_path()
        .ok_or_else(|| "Could not resolve home directory for Grok auth".to_string())?;
    if !auth_path.exists() {
        return Err(
            "Grok is not authenticated. Run `grok login` or open Settings → Grok.".to_string(),
        );
    }
    let content = std::fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read Grok auth.json: {e}"))?;
    let registry: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Grok auth.json: {e}"))?;
    let object = registry
        .as_object()
        .ok_or_else(|| "Grok auth.json is not an object".to_string())?;

    let mut best: Option<(i64, String, &Value)> = None;
    for (key, entry) in object {
        if !key.starts_with("https://auth.x.ai") {
            continue;
        }
        let access = entry
            .get("key")
            .or_else(|| entry.get("access_token"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(access) = access else {
            continue;
        };
        let expires = entry
            .get("expires_at")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_secs)
            .unwrap_or(0);
        match &best {
            Some((prev, _, _)) if *prev >= expires => {}
            _ => best = Some((expires, access.to_string(), entry)),
        }
    }

    let Some((expires_at_secs, access_token, entry)) = best else {
        return Err(
            "Grok OAuth credentials not found. Run `grok login` (API keys have no subscription usage).".to_string(),
        );
    };

    let refresh_token = entry
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let client_id = entry
        .get("oidc_client_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(GROK_DEFAULT_OIDC_CLIENT_ID)
        .to_string();
    let token_endpoint = entry
        .get("token_endpoint")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(GROK_TOKEN_ENDPOINT)
        .to_string();
    let auth_registry_key = object
        .keys()
        .find(|k| {
            object
                .get(*k)
                .and_then(|e| e.get("key").or_else(|| e.get("access_token")))
                .and_then(Value::as_str)
                == Some(access_token.as_str())
        })
        .cloned();

    Ok(GrokAuthCredentials {
        access_token,
        refresh_token,
        expires_at_secs: if expires_at_secs > 0 {
            Some(expires_at_secs)
        } else {
            None
        },
        client_id,
        token_endpoint,
        auth_registry_key,
        auth_path,
    })
}

fn persist_refreshed_grok_token(
    creds: &GrokAuthCredentials,
    access_token: &str,
    refresh_token: Option<&str>,
    expires_in: Option<i64>,
) {
    let Ok(content) = std::fs::read_to_string(&creds.auth_path) else {
        return;
    };
    let Ok(mut registry) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let Some(object) = registry.as_object_mut() else {
        return;
    };
    let Some(key) = creds.auth_registry_key.as_deref() else {
        return;
    };
    let Some(entry) = object.get_mut(key).and_then(Value::as_object_mut) else {
        return;
    };
    entry.insert("key".to_string(), Value::String(access_token.to_string()));
    if let Some(refresh) = refresh_token.filter(|s| !s.is_empty()) {
        entry.insert(
            "refresh_token".to_string(),
            Value::String(refresh.to_string()),
        );
    }
    if let Some(seconds) = expires_in.filter(|s| *s > 0) {
        let expires_at = current_unix_secs() as i64 + seconds;
        // Store as RFC3339 UTC for CLI compatibility
        let secs = expires_at.max(0) as u64;
        let datetime = format_unix_rfc3339(secs);
        entry.insert("expires_at".to_string(), Value::String(datetime));
    }
    if let Ok(serialized) = serde_json::to_string_pretty(&registry) {
        let _ = std::fs::write(&creds.auth_path, serialized);
    }
}

fn format_unix_rfc3339(secs: u64) -> String {
    // Simple UTC formatter without chrono dependency
    const DAYS_IN_MONTH: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;

    // Convert days since 1970-01-01 to Y-M-D (proleptic Gregorian)
    // Howard Hinnant algorithm
    days += 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = (days - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let _ = DAYS_IN_MONTH; // keep for clarity / future validation
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

async fn refresh_grok_access_token(
    client: &reqwest::Client,
    creds: &mut GrokAuthCredentials,
) -> Result<(), String> {
    let refresh = creds
        .refresh_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Grok access token expired and no refresh token is available. Run `grok login`."
                .to_string()
        })?;

    let response = client
        .post(&creds.token_endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", creds.client_id.as_str()),
            ("refresh_token", refresh),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to refresh Grok token: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Grok token refresh response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Grok token refresh failed (HTTP {status}). Run `grok login` again."
        ));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse Grok token refresh: {e}"))?;
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Grok token refresh did not return access_token".to_string())?;
    let new_refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let expires_in = value.get("expires_in").and_then(Value::as_i64);

    persist_refreshed_grok_token(
        creds,
        access,
        new_refresh.as_deref().or(Some(refresh)),
        expires_in,
    );
    creds.access_token = access.to_string();
    if let Some(rt) = new_refresh {
        creds.refresh_token = Some(rt);
    }
    if let Some(seconds) = expires_in.filter(|s| *s > 0) {
        creds.expires_at_secs = Some(current_unix_secs() as i64 + seconds);
    }
    Ok(())
}

fn grok_client_version(app: &AppHandle) -> String {
    let binary_path = resolve_cli_binary(app);
    if binary_exists(&binary_path) {
        if let Ok(output) = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
            .arg("--version")
            .output()
        {
            if let Some(version) = parse_version(&output.stdout) {
                return version;
            }
        }
    }
    FALLBACK_GROK_CLIENT_VERSION.to_string()
}

fn build_grok_usage_request(
    client: &reqwest::Client,
    url: &str,
    access_token: &str,
    client_version: &str,
) -> reqwest::RequestBuilder {
    client
        .get(url)
        .bearer_auth(access_token)
        .header(reqwest::header::ACCEPT, "application/json,text/plain,*/*")
        .header("x-xai-token-auth", "xai-grok-cli")
        .header("x-grok-client-version", client_version)
        .header(
            reqwest::header::USER_AGENT,
            format!("grok-cli/{client_version}"),
        )
}

fn f64_field(value: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = value.get(*key) {
            if let Some(n) = v.as_f64() {
                return Some(n);
            }
            if let Some(n) = v.as_i64() {
                return Some(n as f64);
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.parse::<f64>() {
                    return Some(n);
                }
            }
            if let Some(inner) = v.get("val") {
                if let Some(n) = inner.as_f64() {
                    return Some(n);
                }
                if let Some(n) = inner.as_i64() {
                    return Some(n as f64);
                }
            }
        }
    }
    None
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn period_end_unix(period_end: Option<&str>) -> Option<u64> {
    period_end
        .and_then(parse_rfc3339_secs)
        .map(|s| s.max(0) as u64)
}

fn map_usage_window(
    used_percent: Option<f64>,
    period_end: Option<&str>,
) -> Option<GrokUsageWindowSnapshot> {
    let used_percent = used_percent?;
    Some(GrokUsageWindowSnapshot {
        used_percent: used_percent.clamp(0.0, 100.0),
        resets_at: period_end_unix(period_end),
        limit_window_seconds: None,
    })
}

fn snapshot_from_payloads(
    billing: &Value,
    user: Option<&Value>,
    task_usage: Option<&Value>,
    fetched_at: u64,
) -> GrokUsageSnapshot {
    let config = billing.get("config").unwrap_or(billing);
    let period = config.get("currentPeriod");
    let period_start = period
        .and_then(|p| string_field(p, &["start"]))
        .or_else(|| string_field(config, &["billingPeriodStart", "periodStart"]));
    let period_end = period
        .and_then(|p| string_field(p, &["end"]))
        .or_else(|| string_field(config, &["billingPeriodEnd", "periodEnd"]));

    let weekly_percent = f64_field(config, &["creditUsagePercent", "weeklyLimitPercent"])
        .or_else(|| f64_field(billing, &["creditUsagePercent"]));

    let mut products = Vec::new();
    if let Some(arr) = config
        .get("productUsage")
        .or_else(|| billing.get("productUsage"))
        .and_then(Value::as_array)
    {
        for item in arr {
            let product =
                string_field(item, &["product", "name"]).unwrap_or_else(|| "unknown".into());
            if let Some(pct) = f64_field(item, &["usagePercent", "usedPercent", "usage"]) {
                products.push(GrokProductUsageSnapshot {
                    product,
                    used_percent: pct.clamp(0.0, 100.0),
                });
            }
        }
    }

    let build_percent = products
        .iter()
        .find(|p| {
            let name = p.product.to_ascii_lowercase();
            name.contains("build") || name.contains("code")
        })
        .map(|p| p.used_percent)
        .or_else(|| products.first().map(|p| p.used_percent));

    let plan_type = user
        .and_then(|u| string_field(u, &["subscriptionTier", "subscription_tier", "tier"]))
        .or_else(|| string_field(config, &["subscriptionTier", "planType", "plan"]))
        .map(|tier| {
            // Normalize common API values for UI display
            match tier.as_str() {
                "XPremiumPlus" | "SUBSCRIPTION_TIER_X_PREMIUM_PLUS" => "X Premium+".to_string(),
                "XPremium" | "SUBSCRIPTION_TIER_X_PREMIUM" => "X Premium".to_string(),
                "SuperGrok" | "SUBSCRIPTION_TIER_SUPER_GROK" => "SuperGrok".to_string(),
                other => other.to_string(),
            }
        });

    let has_grok_code_access = user.and_then(|u| {
        u.get("hasGrokCodeAccess")
            .or_else(|| u.get("has_grok_code_access"))
            .and_then(Value::as_bool)
    });

    let (frequent_used, frequent_limit, occasional_used, occasional_limit) =
        if let Some(task) = task_usage {
            (
                f64_field(task, &["frequentUsage", "frequent_usage"]),
                f64_field(task, &["frequentLimit", "frequent_limit"]),
                f64_field(task, &["occasionalUsage", "occasional_usage"]),
                f64_field(task, &["occasionalLimit", "occasional_limit"]),
            )
        } else {
            (None, None, None, None)
        };

    GrokUsageSnapshot {
        plan_type,
        weekly: map_usage_window(weekly_percent, period_end.as_deref()),
        session: map_usage_window(build_percent, period_end.as_deref()),
        products,
        frequent_used,
        frequent_limit,
        occasional_used,
        occasional_limit,
        has_grok_code_access,
        period_start,
        period_end,
        fetched_at,
    }
}

/// Fetch Grok Build / subscription usage for the authenticated OAuth account.
///
/// Uses official consumer endpoints discovered from Grok CLI auth (`~/.grok/auth.json`):
/// - `https://cli-chat-proxy.grok.com/v1/billing?format=credits`
/// - `https://cli-chat-proxy.grok.com/v1/user?include=subscription`
/// - `https://grok.com/rest/tasks/usage`
///
/// API-key auth has no subscription quota surface (only RPS/TPM in console.x.ai).
pub async fn get_grok_usage(app: AppHandle) -> Result<GrokUsageSnapshot, String> {
    let now_secs = current_unix_secs();
    if let Some(cached) = load_cached_grok_usage(now_secs) {
        return Ok(cached);
    }

    let mut creds = load_grok_auth_credentials()?;
    let client_version = grok_client_version(&app);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to build Grok usage HTTP client: {e}"))?;

    // Refresh when expired or within 60s of expiry.
    let needs_refresh = creds
        .expires_at_secs
        .is_some_and(|exp| exp <= (now_secs as i64) + 60);
    if needs_refresh {
        let _ = refresh_grok_access_token(&client, &mut creds).await;
    }

    let mut billing_response = build_grok_usage_request(
        &client,
        GROK_BILLING_URL,
        &creds.access_token,
        &client_version,
    )
    .send()
    .await
    .map_err(|e| format!("Failed to fetch Grok billing usage: {e}"))?;

    if billing_response.status() == reqwest::StatusCode::UNAUTHORIZED
        || billing_response.status() == reqwest::StatusCode::FORBIDDEN
    {
        refresh_grok_access_token(&client, &mut creds).await?;
        billing_response = build_grok_usage_request(
            &client,
            GROK_BILLING_URL,
            &creds.access_token,
            &client_version,
        )
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Grok billing usage: {e}"))?;
    }

    if !billing_response.status().is_success() {
        return Err(format!(
            "Grok billing usage request failed (HTTP {}).",
            billing_response.status()
        ));
    }

    let billing: Value = billing_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Grok billing usage: {e}"))?;

    let user = match build_grok_usage_request(
        &client,
        GROK_CLI_USER_URL,
        &creds.access_token,
        &client_version,
    )
    .send()
    .await
    {
        Ok(resp) if resp.status().is_success() => resp.json::<Value>().await.ok(),
        _ => None,
    };

    let task_usage = match client
        .get(GROK_TASK_USAGE_URL)
        .bearer_auth(&creds.access_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("x-xai-token-auth", "xai-grok-cli")
        .header(reqwest::header::USER_AGENT, "Grok Build")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp.json::<Value>().await.ok(),
        _ => None,
    };

    let snapshot = snapshot_from_payloads(&billing, user.as_ref(), task_usage.as_ref(), now_secs);
    save_cached_grok_usage(&snapshot, now_secs);
    Ok(snapshot)
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
    fn parse_rfc3339_secs_handles_z_and_offsets() {
        let z = parse_rfc3339_secs("2026-07-18T12:43:56.508407459Z");
        assert!(z.is_some());
        let offset = parse_rfc3339_secs("2026-07-20T06:53:23.124867+00:00");
        assert!(offset.is_some());
        // Offset form with +00:00 should match Z for same civil time
        assert_eq!(
            parse_rfc3339_secs("2026-07-18T12:00:00Z"),
            parse_rfc3339_secs("2026-07-18T12:00:00+00:00")
        );
    }

    #[test]
    fn snapshot_from_payloads_maps_billing_and_products() {
        let billing = serde_json::json!({
            "config": {
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-07-13T06:53:23Z",
                    "end": "2026-07-20T06:53:23Z"
                },
                "creditUsagePercent": 72.0,
                "productUsage": [
                    {"product": "GrokBuild", "usagePercent": 68.0},
                    {"product": "GrokChat", "usagePercent": 4.0}
                ]
            }
        });
        let user = serde_json::json!({
            "subscriptionTier": "XPremiumPlus",
            "hasGrokCodeAccess": true
        });
        let task = serde_json::json!({
            "frequentUsage": 1,
            "frequentLimit": 10,
            "occasionalUsage": 2,
            "occasionalLimit": 30
        });
        let snap = snapshot_from_payloads(&billing, Some(&user), Some(&task), 100);
        assert_eq!(snap.plan_type.as_deref(), Some("X Premium+"));
        assert_eq!(snap.weekly.as_ref().map(|w| w.used_percent), Some(72.0));
        assert_eq!(snap.session.as_ref().map(|w| w.used_percent), Some(68.0));
        assert_eq!(snap.products.len(), 2);
        assert_eq!(snap.frequent_used, Some(1.0));
        assert_eq!(snap.has_grok_code_access, Some(true));
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
