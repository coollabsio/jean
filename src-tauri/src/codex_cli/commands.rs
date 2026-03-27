//! Tauri commands for Codex CLI management

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use super::config::{ensure_cli_dir, get_cli_binary_path, resolve_cli_binary};
use crate::gh_cli::resolve_github_api_token;
use crate::http_server::EmitExt;
use crate::platform::silent_command;

/// GitHub API URL for Codex CLI releases
const CODEX_RELEASES_API: &str = "https://api.github.com/repos/openai/codex/releases";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_OAUTH_REFRESH_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE_CACHE_TTL_SECS: u64 = 5 * 60;
const GITHUB_API_ACCEPT: &str = "application/vnd.github+json";
const GITHUB_API_VERSION: &str = "2022-11-28";

/// Emergency fallback version when API fails AND no cache exists.
const FALLBACK_CODEX_VERSION: &str = "0.116.0-alpha.12";
const CODEX_VERSIONS_CACHE_FILE: &str = "codex-versions-cache.json";

/// Extract version number from a tag like "v0.104.0" or "vrust-v0.104.0"
fn extract_version_from_tag(tag: &str) -> String {
    // Try to find a semver pattern (digits.digits.digits)
    for part in tag.split('v') {
        let trimmed = part.trim_end_matches('-');
        if trimmed
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
            && trimmed.contains('.')
        {
            return trimmed.to_string();
        }
    }
    tag.to_string()
}

/// Status of the Codex CLI installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Auth status of the Codex CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageWindowSnapshot {
    pub used_percent: f64,
    pub resets_at: Option<u64>,
    pub limit_window_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAdditionalUsageLimit {
    pub label: String,
    pub session: Option<CodexUsageWindowSnapshot>,
    pub weekly: Option<CodexUsageWindowSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageSnapshot {
    pub plan_type: Option<String>,
    pub session: Option<CodexUsageWindowSnapshot>,
    pub weekly: Option<CodexUsageWindowSnapshot>,
    pub reviews: Option<CodexUsageWindowSnapshot>,
    pub credits_remaining: Option<f64>,
    pub model_limits: Vec<CodexAdditionalUsageLimit>,
    pub fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsageCacheEntry {
    cached_at: u64,
    snapshot: CodexUsageSnapshot,
}

/// Information about a Codex CLI release
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: String,
    pub prerelease: bool,
}

/// Progress event for CLI installation
#[derive(Debug, Clone, Serialize)]
pub struct CodexInstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
}

/// GitHub API release response structure
#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    published_at: String,
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CodexAuthTokens {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CodexAuthFile {
    #[serde(default)]
    tokens: Option<CodexAuthTokens>,
    #[serde(default)]
    last_refresh: Option<String>,
    #[serde(rename = "OPENAI_API_KEY", default)]
    openai_api_key: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
enum CodexAuthSource {
    File(PathBuf),
    #[cfg(target_os = "macos")]
    Keychain,
}

#[derive(Debug, Deserialize)]
struct CodexRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct CodexUsageWindow {
    #[serde(default, deserialize_with = "de_opt_f64")]
    used_percent: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    reset_at: Option<u64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    reset_after_seconds: Option<u64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    limit_window_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct CodexUsageRateLimit {
    #[serde(default)]
    primary_window: Option<CodexUsageWindow>,
    #[serde(default)]
    secondary_window: Option<CodexUsageWindow>,
}

#[derive(Debug, Deserialize, Clone)]
struct CodexUsageAdditionalRateLimit {
    #[serde(default)]
    limit_name: Option<String>,
    #[serde(default)]
    rate_limit: Option<CodexUsageRateLimit>,
}

#[derive(Debug, Deserialize, Clone)]
struct CodexCredits {
    #[serde(default, deserialize_with = "de_opt_f64")]
    balance: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CodexUsageApiResponse {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    rate_limit: Option<CodexUsageRateLimit>,
    #[serde(default)]
    code_review_rate_limit: Option<CodexUsageRateLimit>,
    #[serde(default)]
    additional_rate_limits: Option<Vec<CodexUsageAdditionalRateLimit>>,
    #[serde(default)]
    credits: Option<CodexCredits>,
}

fn de_opt_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };

    let parsed = match value {
        Value::Number(num) => num.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    };

    Ok(parsed)
}

fn de_opt_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    let Some(value) = value else {
        return Ok(None);
    };

    let parsed = match value {
        Value::Number(num) => num.as_u64(),
        Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    };

    Ok(parsed)
}

/// Result of detecting Codex CLI in system PATH
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

/// Detect Codex CLI in system PATH (excluding Jean-managed binary)
#[tauri::command]
pub async fn detect_codex_in_path(app: AppHandle) -> Result<CodexPathDetection, String> {
    log::debug!("detect_codex_in_path: starting");

    let jean_managed_path = get_cli_binary_path(&app)
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());
    log::debug!("detect_codex_in_path: jean_managed_path={jean_managed_path:?}");

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = match silent_command(which_cmd).arg("codex").output() {
        Ok(output) if output.status.success() => {
            // On Windows, `where` can return multiple paths; take only the first line
            let raw = String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("").trim().to_string();
            log::debug!("detect_codex_in_path: `{which_cmd} codex` found: {raw:?}");
            raw
        }
        Ok(output) => {
            log::debug!("detect_codex_in_path: `{which_cmd} codex` exited with status={}, stderr={:?}",
                output.status, String::from_utf8_lossy(&output.stderr).trim());
            return Ok(CodexPathDetection {
                found: false,
                path: None,
                version: None,
                package_manager: None,
            });
        }
        Err(e) => {
            log::debug!("detect_codex_in_path: `{which_cmd} codex` failed to execute: {e}");
            return Ok(CodexPathDetection {
                found: false,
                path: None,
                version: None,
                package_manager: None,
            });
        }
    };

    if output.is_empty() {
        log::debug!("detect_codex_in_path: which returned empty output");
        return Ok(CodexPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    }

    let found_path = std::path::PathBuf::from(&output);

    // Exclude Jean-managed binary
    if let Some(ref jean_path) = jean_managed_path {
        if let Ok(canonical_found) = std::fs::canonicalize(&found_path) {
            if canonical_found == *jean_path {
                log::debug!("detect_codex_in_path: found path is jean-managed binary, excluding");
                return Ok(CodexPathDetection {
                    found: false,
                    path: None,
                    version: None,
                    package_manager: None,
                });
            }
        }
    }

    let version = match silent_command(&found_path).arg("--version").output() {
        Ok(ver_output) if ver_output.status.success() => {
            let ver_str = String::from_utf8_lossy(&ver_output.stdout).trim().to_string();
            log::debug!("detect_codex_in_path: raw --version output={ver_str:?}");
            let cleaned = ver_str
                .split_whitespace()
                .last()
                .unwrap_or(&ver_str)
                .trim_start_matches('v')
                .to_string();
            if cleaned.is_empty() { None } else { Some(cleaned) }
        }
        Ok(ver_output) => {
            log::debug!("detect_codex_in_path: --version failed, status={}, stderr={:?}",
                ver_output.status, String::from_utf8_lossy(&ver_output.stderr).trim());
            None
        }
        Err(e) => {
            log::debug!("detect_codex_in_path: --version command error: {e}");
            None
        }
    };

    let package_manager = crate::platform::detect_package_manager(&found_path);

    log::debug!("detect_codex_in_path: result path={output} version={version:?} pkg_mgr={package_manager:?}");

    Ok(CodexPathDetection {
        found: true,
        path: Some(output),
        version,
        package_manager,
    })
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let _ = app.emit_all(
        "codex-cli:install-progress",
        &CodexInstallProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

fn build_github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn build_usage_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create usage HTTP client: {e}"))
}

fn get_codex_auth_paths() -> Vec<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let trimmed = codex_home.trim();
        if !trimmed.is_empty() {
            return vec![PathBuf::from(trimmed).join("auth.json")];
        }
    }

    if let Some(home) = dirs::home_dir() {
        return vec![
            home.join(".config").join("codex").join("auth.json"),
            home.join(".codex").join("auth.json"),
        ];
    }

    Vec::new()
}

fn get_usage_cache_dir() -> Option<PathBuf> {
    let base = dirs::cache_dir().or_else(|| dirs::home_dir().map(|h| h.join(".cache")))?;
    Some(base.join("jean").join("usage-cache"))
}

fn get_codex_usage_cache_path() -> Option<PathBuf> {
    Some(get_usage_cache_dir()?.join("codex.json"))
}

fn load_cached_codex_usage(now_secs: u64) -> Option<CodexUsageSnapshot> {
    let path = get_codex_usage_cache_path()?;
    let content = std::fs::read_to_string(path).ok()?;
    let entry: CodexUsageCacheEntry = serde_json::from_str(&content).ok()?;
    if now_secs.saturating_sub(entry.cached_at) <= CODEX_USAGE_CACHE_TTL_SECS {
        return Some(entry.snapshot);
    }
    None
}

fn save_cached_codex_usage(snapshot: &CodexUsageSnapshot, now_secs: u64) {
    let Some(path) = get_codex_usage_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let entry = CodexUsageCacheEntry {
        cached_at: now_secs,
        snapshot: snapshot.clone(),
    };
    if let Ok(serialized) = serde_json::to_string_pretty(&entry) {
        let _ = std::fs::write(path, serialized);
    }
}

#[cfg(target_os = "macos")]
fn decode_hex_utf8(hex: &str) -> Option<String> {
    if hex.is_empty() || hex.len() % 2 != 0 {
        return None;
    }
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for idx in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[idx..idx + 2], 16).ok()?;
        bytes.push(byte);
    }
    String::from_utf8(bytes).ok()
}

#[cfg(target_os = "macos")]
fn parse_auth_payload(raw: &str) -> Option<CodexAuthFile> {
    if let Ok(auth) = serde_json::from_str::<CodexAuthFile>(raw) {
        return Some(auth);
    }

    let trimmed = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    let decoded = decode_hex_utf8(trimmed)?;
    serde_json::from_str::<CodexAuthFile>(&decoded).ok()
}

#[cfg(target_os = "macos")]
fn load_codex_auth_from_keychain() -> Option<CodexAuthFile> {
    let output = silent_command("security")
        .args(["find-generic-password", "-s", "Codex Auth", "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let payload = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_auth_payload(&payload)
}

fn load_codex_auth() -> Result<(CodexAuthSource, CodexAuthFile), String> {
    let auth_paths = get_codex_auth_paths();

    for path in auth_paths {
        if !path.exists() {
            continue;
        }

        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read Codex auth file {}: {e}", path.display()))?;
        let auth: CodexAuthFile = serde_json::from_str(&content).map_err(|e| {
            format!(
                "Failed to parse Codex auth file JSON ({}): {e}",
                path.display()
            )
        })?;
        return Ok((CodexAuthSource::File(path), auth));
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(auth) = load_codex_auth_from_keychain() {
            return Ok((CodexAuthSource::Keychain, auth));
        }
    }

    Err("Codex auth not found. Run `codex` to authenticate.".to_string())
}

fn persist_codex_auth(source: &CodexAuthSource, auth: &CodexAuthFile) -> Result<(), String> {
    match source {
        CodexAuthSource::File(path) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create Codex auth directory {}: {e}",
                        parent.display()
                    )
                })?;
            }

            let content = serde_json::to_string_pretty(auth)
                .map_err(|e| format!("Failed to serialize Codex auth JSON: {e}"))?;
            std::fs::write(path, content)
                .map_err(|e| format!("Failed to write Codex auth file {}: {e}", path.display()))
        }
        #[cfg(target_os = "macos")]
        CodexAuthSource::Keychain => {
            let payload = serde_json::to_string(auth)
                .map_err(|e| format!("Failed to serialize Codex keychain payload: {e}"))?;
            let output = silent_command("security")
                .args([
                    "add-generic-password",
                    "-U",
                    "-s",
                    "Codex Auth",
                    "-a",
                    "codex",
                    "-w",
                    &payload,
                ])
                .output()
                .map_err(|e| format!("Failed to update Codex keychain entry: {e}"))?;
            if output.status.success() {
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(if stderr.is_empty() {
                    "Failed to update Codex keychain entry.".to_string()
                } else {
                    format!("Failed to update Codex keychain entry: {stderr}")
                })
            }
        }
    }
}

fn parse_header_f64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<f64>().ok())
}

fn resolve_reset_timestamp(now_secs: u64, window: &CodexUsageWindow) -> Option<u64> {
    if let Some(reset_at) = window.reset_at {
        return Some(reset_at);
    }

    window
        .reset_after_seconds
        .map(|seconds| now_secs.saturating_add(seconds))
}

fn map_usage_window(
    now_secs: u64,
    window: Option<&CodexUsageWindow>,
) -> Option<CodexUsageWindowSnapshot> {
    let window = window?;
    let used_percent = window.used_percent?;

    Some(CodexUsageWindowSnapshot {
        used_percent,
        resets_at: resolve_reset_timestamp(now_secs, window),
        limit_window_seconds: window.limit_window_seconds,
    })
}

async fn refresh_codex_access_token(
    client: &reqwest::Client,
    auth_source: &CodexAuthSource,
    auth: &mut CodexAuthFile,
) -> Result<Option<String>, String> {
    let refresh_token = auth
        .tokens
        .as_ref()
        .and_then(|t| t.refresh_token.clone())
        .ok_or_else(|| {
            "Codex refresh token missing. Run `codex` to authenticate again.".to_string()
        })?;

    let response = client
        .post(CODEX_OAUTH_REFRESH_URL)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CODEX_OAUTH_CLIENT_ID),
            ("refresh_token", &refresh_token),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to refresh Codex token: {e}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::BAD_REQUEST
    {
        let body = response
            .json::<serde_json::Value>()
            .await
            .unwrap_or(serde_json::Value::Null);
        let code = body
            .get("error")
            .and_then(|v| {
                if v.is_object() {
                    v.get("code")
                } else {
                    Some(v)
                }
            })
            .and_then(|v| v.as_str())
            .or_else(|| body.get("code").and_then(|v| v.as_str()))
            .unwrap_or("token_expired");

        return Err(match code {
            "refresh_token_expired" => {
                "Codex session expired. Run `codex` to log in again.".to_string()
            }
            "refresh_token_reused" => {
                "Codex token conflict. Run `codex` to log in again.".to_string()
            }
            "refresh_token_invalidated" => {
                "Codex token revoked. Run `codex` to log in again.".to_string()
            }
            _ => "Codex token expired. Run `codex` to log in again.".to_string(),
        });
    }

    if !response.status().is_success() {
        return Ok(None);
    }

    let refreshed = response
        .json::<CodexRefreshResponse>()
        .await
        .map_err(|e| format!("Failed to parse Codex token refresh response: {e}"))?;

    let mut tokens = auth.tokens.clone().unwrap_or_default();
    tokens.access_token = Some(refreshed.access_token.clone());
    if let Some(refresh_token) = refreshed.refresh_token {
        tokens.refresh_token = Some(refresh_token);
    }
    if let Some(id_token) = refreshed.id_token {
        tokens.id_token = Some(id_token);
    }
    auth.tokens = Some(tokens);
    auth.last_refresh = Some(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string()),
    );

    if let Err(e) = persist_codex_auth(auth_source, auth) {
        log::warn!("Codex token refresh succeeded but could not persist auth: {e}");
    }

    Ok(auth.tokens.as_ref().and_then(|t| t.access_token.clone()))
}

/// Check if Codex CLI is installed and get its status
#[tauri::command]
pub async fn check_codex_cli_installed(app: AppHandle) -> Result<CodexCliStatus, String> {
    log::debug!("check_codex_cli_installed: starting");

    let binary_path = resolve_cli_binary(&app);
    log::debug!("check_codex_cli_installed: resolved binary_path={:?}", binary_path);

    if !binary_path.exists() {
        log::debug!("check_codex_cli_installed: binary not found at {:?}", binary_path);
        return Ok(CodexCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    // Get version
    let version = match silent_command(&binary_path).arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            log::debug!("check_codex_cli_installed: raw --version output={:?}", version_str);
            if version_str.is_empty() {
                None
            } else {
                // codex --version might return "codex 0.104.0" or just "0.104.0"
                let version = version_str
                    .split_whitespace()
                    .last()
                    .map(|s| s.trim_start_matches('v').to_string())
                    .unwrap_or(version_str);
                Some(version)
            }
        }
        Ok(output) => {
            log::debug!("check_codex_cli_installed: --version failed, exit_status={}, stderr={:?}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim());
            None
        }
        Err(e) => {
            log::debug!("check_codex_cli_installed: --version command error: {e}");
            None
        }
    };

    let status = CodexCliStatus {
        installed: true,
        version: version.clone(),
        path: Some(binary_path.to_string_lossy().to_string()),
    };
    log::debug!("check_codex_cli_installed: returning installed={} version={:?} path={:?}",
        status.installed, status.version, status.path);

    Ok(status)
}

/// Check if Codex CLI is authenticated
#[tauri::command]
pub async fn check_codex_cli_auth(app: AppHandle) -> Result<CodexAuthStatus, String> {
    log::trace!("Checking Codex CLI authentication status");

    let binary_path = resolve_cli_binary(&app);

    if !binary_path.exists() {
        return Ok(CodexAuthStatus {
            authenticated: false,
            error: Some("Codex CLI not installed".to_string()),
        });
    }

    // Run `codex login status` to check authentication
    let output = silent_command(&binary_path)
        .args(["login", "status"])
        .output()
        .map_err(|e| format!("Failed to execute Codex CLI: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        log::trace!("Codex CLI auth check output: {stdout}");
        Ok(CodexAuthStatus {
            authenticated: true,
            error: None,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::trace!("Codex CLI auth check failed: {stderr}");
        Ok(CodexAuthStatus {
            authenticated: false,
            error: if stderr.is_empty() {
                Some("Not authenticated".to_string())
            } else {
                Some(stderr)
            },
        })
    }
}

/// Get current Codex usage for authenticated users.
#[tauri::command]
pub async fn get_codex_usage() -> Result<CodexUsageSnapshot, String> {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(cached) = load_cached_codex_usage(now_secs) {
        return Ok(cached);
    }

    let (auth_source, mut auth) = load_codex_auth()?;
    let usage_client = build_usage_client()?;

    let mut access_token = auth
        .tokens
        .as_ref()
        .and_then(|t| t.access_token.clone())
        .ok_or_else(|| {
            if auth.openai_api_key.is_some() {
                "Usage is unavailable for API key authentication.".to_string()
            } else {
                "Codex access token missing. Run `codex` to authenticate.".to_string()
            }
        })?;
    let account_id = auth.tokens.as_ref().and_then(|t| t.account_id.clone());

    let mut request = usage_client
        .get(CODEX_USAGE_URL)
        .bearer_auth(&access_token)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(account_id) = account_id.as_deref() {
        request = request.header("ChatGPT-Account-Id", account_id);
    }

    let mut response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Codex usage: {e}"))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        if let Some(refreshed_token) =
            refresh_codex_access_token(&usage_client, &auth_source, &mut auth).await?
        {
            access_token = refreshed_token;
            let mut retry_request = usage_client
                .get(CODEX_USAGE_URL)
                .bearer_auth(&access_token)
                .header(reqwest::header::ACCEPT, "application/json");
            if let Some(account_id) = account_id.as_deref() {
                retry_request = retry_request.header("ChatGPT-Account-Id", account_id);
            }
            response = retry_request
                .send()
                .await
                .map_err(|e| format!("Failed to fetch Codex usage: {e}"))?;
        }
    }

    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err("Codex token expired. Run `codex` to log in again.".to_string());
    }

    if !response.status().is_success() {
        return Err(format!(
            "Codex usage request failed (HTTP {}).",
            response.status()
        ));
    }

    let headers = response.headers().clone();
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Codex usage response body: {e}"))?;
    let usage = serde_json::from_str::<CodexUsageApiResponse>(&response_text).map_err(|e| {
        let snippet = response_text.chars().take(200).collect::<String>();
        format!("Failed to parse Codex usage response JSON: {e}. Body starts with: {snippet}")
    })?;

    let session = if let Some(percent) = parse_header_f64(&headers, "x-codex-primary-used-percent")
    {
        Some(CodexUsageWindowSnapshot {
            used_percent: percent,
            resets_at: usage
                .rate_limit
                .as_ref()
                .and_then(|r| r.primary_window.as_ref())
                .and_then(|w| resolve_reset_timestamp(now_secs, w)),
            limit_window_seconds: usage
                .rate_limit
                .as_ref()
                .and_then(|r| r.primary_window.as_ref())
                .and_then(|w| w.limit_window_seconds),
        })
    } else {
        map_usage_window(
            now_secs,
            usage
                .rate_limit
                .as_ref()
                .and_then(|r| r.primary_window.as_ref()),
        )
    };

    let weekly = if let Some(percent) = parse_header_f64(&headers, "x-codex-secondary-used-percent")
    {
        Some(CodexUsageWindowSnapshot {
            used_percent: percent,
            resets_at: usage
                .rate_limit
                .as_ref()
                .and_then(|r| r.secondary_window.as_ref())
                .and_then(|w| resolve_reset_timestamp(now_secs, w)),
            limit_window_seconds: usage
                .rate_limit
                .as_ref()
                .and_then(|r| r.secondary_window.as_ref())
                .and_then(|w| w.limit_window_seconds),
        })
    } else {
        map_usage_window(
            now_secs,
            usage
                .rate_limit
                .as_ref()
                .and_then(|r| r.secondary_window.as_ref()),
        )
    };

    let reviews = map_usage_window(
        now_secs,
        usage
            .code_review_rate_limit
            .as_ref()
            .and_then(|r| r.primary_window.as_ref()),
    );

    let credits_remaining = parse_header_f64(&headers, "x-codex-credits-balance")
        .or_else(|| usage.credits.as_ref().and_then(|credits| credits.balance));

    let model_limits = usage
        .additional_rate_limits
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let rate_limit = entry.rate_limit?;
            let label = entry
                .limit_name
                .unwrap_or_else(|| "Model".to_string())
                .trim_start_matches("GPT-")
                .trim_start_matches("gpt-")
                .replace("-Codex", "")
                .replace("-codex", "");

            let session = map_usage_window(now_secs, rate_limit.primary_window.as_ref());
            let weekly = map_usage_window(now_secs, rate_limit.secondary_window.as_ref());

            if session.is_none() && weekly.is_none() {
                return None;
            }

            Some(CodexAdditionalUsageLimit {
                label: if label.is_empty() {
                    "Model".to_string()
                } else {
                    label
                },
                session,
                weekly,
            })
        })
        .collect();

    let snapshot = CodexUsageSnapshot {
        plan_type: usage.plan_type,
        session,
        weekly,
        reviews,
        credits_remaining,
        model_limits,
        fetched_at: now_secs,
    };

    save_cached_codex_usage(&snapshot, now_secs);
    Ok(snapshot)
}

/// Cached versions structure for disk persistence
#[derive(Debug, Serialize, Deserialize)]
struct CachedCodexVersions {
    versions: Vec<CodexReleaseInfo>,
    fetched_at: String,
}

fn save_codex_versions_cache(app: &AppHandle, versions: &[CodexReleaseInfo]) {
    let cache_path = match super::config::ensure_cli_dir(app) {
        Ok(dir) => dir.join(CODEX_VERSIONS_CACHE_FILE),
        Err(e) => {
            log::warn!("Cannot resolve/create Codex CLI dir for cache: {e}");
            return;
        }
    };
    log::debug!("save_codex_versions_cache: writing {} versions to {cache_path:?}", versions.len());
    let cached = CachedCodexVersions {
        versions: versions.to_vec(),
        fetched_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default(),
    };
    match serde_json::to_string(&cached) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&cache_path, json) {
                log::warn!("Failed to write Codex versions cache: {e}");
            }
        }
        Err(e) => log::warn!("Failed to serialize Codex versions cache: {e}"),
    }
}

fn load_codex_versions_cache(app: &AppHandle) -> Option<Vec<CodexReleaseInfo>> {
    let cache_path = super::config::get_cli_dir(app).ok()?.join(CODEX_VERSIONS_CACHE_FILE);
    let contents = std::fs::read_to_string(&cache_path).ok()?;
    let cached: CachedCodexVersions = serde_json::from_str(&contents).ok()?;
    if cached.versions.is_empty() {
        return None;
    }
    log::trace!("Loaded {} cached Codex versions", cached.versions.len());
    Some(cached.versions)
}

fn fallback_codex_versions() -> Vec<CodexReleaseInfo> {
    vec![CodexReleaseInfo {
        version: FALLBACK_CODEX_VERSION.to_string(),
        tag_name: format!("codex-v{FALLBACK_CODEX_VERSION}"),
        published_at: String::new(),
        prerelease: false,
    }]
}

/// Get available Codex CLI versions from GitHub releases.
///
/// Falls back to disk cache or a hardcoded version if the API is unreachable.
#[tauri::command]
pub async fn get_available_codex_versions(app: AppHandle) -> Result<Vec<CodexReleaseInfo>, String> {
    log::trace!("Fetching available Codex CLI versions from GitHub API");

    match fetch_codex_versions_from_api(&app).await {
        Ok(versions) if !versions.is_empty() => {
            save_codex_versions_cache(&app, &versions);
            Ok(versions)
        }
        Ok(_empty) => {
            log::warn!("GitHub API returned empty Codex releases, falling back to cache");
            Ok(load_codex_versions_cache(&app).unwrap_or_else(fallback_codex_versions))
        }
        Err(e) => {
            log::warn!("Codex GitHub API request failed ({e}), falling back to cache");
            Ok(load_codex_versions_cache(&app).unwrap_or_else(fallback_codex_versions))
        }
    }
}

/// Fetch Codex versions directly from the GitHub API (no fallback).
async fn fetch_codex_versions_from_api(app: &AppHandle) -> Result<Vec<CodexReleaseInfo>, String> {
    let client = build_github_client()?;
    let token = resolve_github_api_token(app);

    let mut request = client
        .get(format!("{CODEX_RELEASES_API}?per_page=100"))
        .header("Accept", GITHUB_API_ACCEPT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);
    if let Some(ref token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let releases: Vec<GitHubRelease> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub API response: {e}"))?;

    let versions: Vec<CodexReleaseInfo> = releases
        .into_iter()
        .filter(|r| !r.prerelease && !r.assets.is_empty())
        .take(5)
        .map(|r| CodexReleaseInfo {
            version: extract_version_from_tag(&r.tag_name),
            tag_name: r.tag_name,
            published_at: r.published_at,
            prerelease: r.prerelease,
        })
        .collect();

    log::trace!("Found {} Codex CLI versions from API", versions.len());
    Ok(versions)
}

/// Get the Codex target triple for the current platform
fn get_codex_target() -> Result<&'static str, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok("aarch64-apple-darwin");
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok("x86_64-apple-darwin");
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Ok("x86_64-unknown-linux-gnu");
    }

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Ok("aarch64-unknown-linux-gnu");
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok("x86_64-pc-windows-msvc");
    }

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Ok("aarch64-pc-windows-msvc");
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

/// Fetch the latest Codex CLI version from GitHub API.
///
/// Uses the releases list endpoint instead of /releases/latest because all
/// Codex releases are pre-releases (alpha), and GitHub's /latest endpoint
/// only returns non-prerelease versions.
///
/// Falls back to disk cache or hardcoded version if the API is unreachable.
async fn fetch_latest_codex_version(app: &AppHandle) -> Result<String, String> {
    log::trace!("Fetching latest Codex CLI version");

    let client = build_github_client()?;
    let token = resolve_github_api_token(app);
    let mut request = client
        .get(format!("{CODEX_RELEASES_API}?per_page=10"))
        .header("Accept", GITHUB_API_ACCEPT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);
    if let Some(ref token) = token {
        request = request.bearer_auth(token);
    }

    if let Ok(resp) = request.send().await {
        if resp.status().is_success() {
            if let Ok(releases) = resp.json::<Vec<GitHubRelease>>().await {
                if let Some(release) = releases.first() {
                    let version = extract_version_from_tag(&release.tag_name);
                    log::trace!("Latest Codex CLI version: {version}");
                    return Ok(version);
                }
            }
        }
    }

    log::warn!("Failed to fetch latest Codex version from API, using fallback");
    if let Some(cached) = load_codex_versions_cache(app) {
        if let Some(first) = cached.into_iter().next() {
            return Ok(first.version);
        }
    }
    Ok(FALLBACK_CODEX_VERSION.to_string())
}

/// Find the download URL for a specific asset by searching recent releases
async fn find_asset_url(app: &AppHandle, version: &str, asset_name: &str) -> Result<String, String> {
    let client = build_github_client()?;
    let token = resolve_github_api_token(app);
    let mut request = client
        .get(CODEX_RELEASES_API)
        .header("Accept", GITHUB_API_ACCEPT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);
    if let Some(ref token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let releases: Vec<GitHubRelease> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse releases: {e}"))?;

    for release in &releases {
        let release_version = extract_version_from_tag(&release.tag_name);
        if release_version == version {
            for asset in &release.assets {
                if asset.name == asset_name {
                    return Ok(asset.browser_download_url.clone());
                }
            }
            return Err(format!(
                "Asset {asset_name} not found in release {}",
                release.tag_name
            ));
        }
    }

    Err(format!("Release for version {version} not found"))
}

/// Install Codex CLI by downloading from GitHub releases
#[tauri::command]
pub async fn install_codex_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    log::trace!("Installing Codex CLI, version: {:?}", version);

    let _cli_dir = ensure_cli_dir(&app)?;
    let binary_path = get_cli_binary_path(&app)?;

    // Emit progress: starting
    emit_progress(&app, "starting", "Preparing installation...", 0);

    // Determine version
    let version = match version {
        Some(v) => v,
        None => fetch_latest_codex_version(&app).await?,
    };

    let target = get_codex_target()?;
    log::trace!("Installing version {version} for target {target}");

    // Build asset name to search for in release assets
    #[cfg(target_os = "windows")]
    let (asset_name, is_zip) = (format!("codex-{target}.exe.zip"), true);
    #[cfg(not(target_os = "windows"))]
    let (asset_name, is_zip) = (format!("codex-{target}.tar.gz"), false);

    // Find the download URL from the release assets
    let download_url = find_asset_url(&app, &version, &asset_name).await?;
    log::trace!("Downloading from: {download_url}");

    // Emit progress: downloading
    emit_progress(&app, "downloading", "Downloading Codex CLI...", 20);

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download Codex CLI: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download Codex CLI: HTTP {}",
            response.status()
        ));
    }

    let archive_content = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read archive content: {e}"))?;

    log::trace!("Downloaded {} bytes", archive_content.len());

    // Emit progress: extracting
    emit_progress(&app, "extracting", "Extracting archive...", 45);

    // On Windows, a running codex.exe holds a file lock that prevents overwriting.
    // Rename the old binary out of the way before extracting the new one.
    #[cfg(windows)]
    if binary_path.exists() {
        let old_path = binary_path.with_extension("exe.old");
        let _ = std::fs::remove_file(&old_path); // Clean up previous .old if any
        if let Err(e) = std::fs::rename(&binary_path, &old_path) {
            log::warn!("Could not rename existing binary (may be unlocked): {e}");
            // Try removing directly as a fallback
            if let Err(e2) = std::fs::remove_file(&binary_path) {
                return Err(format!(
                    "Cannot replace existing Codex CLI binary — it may be in use by another process. \
                     Please close any running Codex sessions and try again. (rename: {e}, remove: {e2})"
                ));
            }
        }
    }

    if is_zip {
        extract_zip_binary(&archive_content, &binary_path, target)?;
    } else {
        extract_tar_gz_binary(&archive_content, &binary_path, target)?;
    }

    // Emit progress: installing
    emit_progress(&app, "installing", "Installing Codex CLI...", 65);

    // Make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&binary_path)
            .map_err(|e| format!("Failed to get binary metadata: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&binary_path, perms)
            .map_err(|e| format!("Failed to set binary permissions: {e}"))?;
    }

    // Remove macOS quarantine attribute
    #[cfg(target_os = "macos")]
    {
        let _ = silent_command("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&binary_path)
            .output();
    }

    // Emit progress: verifying
    emit_progress(&app, "verifying", "Verifying installation...", 80);

    // Verify the binary works
    let version_output = silent_command(&binary_path)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to verify Codex CLI: {e}"))?;

    if !version_output.status.success() {
        let stderr = String::from_utf8_lossy(&version_output.stderr);
        let stdout = String::from_utf8_lossy(&version_output.stdout);
        let output = if !stderr.is_empty() {
            stderr.to_string()
        } else if !stdout.is_empty() {
            stdout.to_string()
        } else {
            format!("exit code {}", version_output.status)
        };
        return Err(format!("Codex CLI verification failed: {output}"));
    }

    // Clean up stale .old binary from Windows rename-on-reinstall
    #[cfg(windows)]
    {
        let old_path = binary_path.with_extension("exe.old");
        let _ = std::fs::remove_file(&old_path);
    }

    // Emit progress: complete
    emit_progress(&app, "complete", "Installation complete!", 100);

    log::trace!("Codex CLI installed successfully at {:?}", binary_path);
    Ok(())
}

/// Extract the codex binary from a tar.gz archive
fn extract_tar_gz_binary(
    archive_content: &[u8],
    binary_path: &std::path::Path,
    target: &str,
) -> Result<(), String> {
    use flate2::read::GzDecoder;
    use std::io::{Cursor, Read};
    use tar::Archive;

    let cursor = Cursor::new(archive_content);
    let decoder = GzDecoder::new(cursor);
    let mut archive = Archive::new(decoder);

    // Match only the main codex binary (e.g. "codex-aarch64-apple-darwin"),
    // not helper binaries like codex-command-runner or codex-windows-sandbox-setup.
    let expected_name = format!("codex-{target}");

    for entry in archive
        .entries()
        .map_err(|e| format!("Failed to read tar entries: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("Failed to read tar entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("Failed to get entry path: {e}"))?;

        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name == expected_name {
                let mut content = Vec::new();
                entry
                    .read_to_end(&mut content)
                    .map_err(|e| format!("Failed to read binary from archive: {e}"))?;

                crate::platform::write_binary_file(binary_path, &content)
                    .map_err(|e| format!("Failed to write binary: {e}"))?;

                return Ok(());
            }
        }
    }

    Err(format!(
        "Codex binary '{expected_name}' not found in tar.gz archive"
    ))
}

/// Extract the codex binary from a zip archive (Windows)
///
/// The Windows zip may contain helper binaries (codex-command-runner.exe,
/// codex-windows-sandbox-setup.exe) bundled for WinGet. We must extract only
/// the main codex binary matching the expected target name.
fn extract_zip_binary(
    archive_content: &[u8],
    binary_path: &std::path::Path,
    target: &str,
) -> Result<(), String> {
    use std::io::{Cursor, Read};

    let cursor = Cursor::new(archive_content);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip archive: {e}"))?;

    let expected_name = format!("codex-{target}.exe");

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;

        if let Some(name) = file.enclosed_name().and_then(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        }) {
            if name == expected_name {
                let mut content = Vec::new();
                file.read_to_end(&mut content)
                    .map_err(|e| format!("Failed to read binary from archive: {e}"))?;

                crate::platform::write_binary_file(binary_path, &content)
                    .map_err(|e| format!("Failed to write binary: {e}"))?;

                return Ok(());
            }
        }
    }

    Err(format!(
        "Codex binary '{expected_name}' not found in zip archive"
    ))
}
