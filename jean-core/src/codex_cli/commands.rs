//! Tauri commands for Codex CLI management

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use super::config::{ensure_cli_dir, get_cli_binary_path, get_cli_dir, resolve_cli_binary};
use crate::gh_cli::resolve_github_api_token;
use crate::http_server::EmitExt;
#[cfg(target_os = "macos")]
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
    /// Linux only: whether Codex can find bubblewrap (`bwrap`) for its sandbox.
    /// `None` on macOS/Windows or when Codex is not installed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_ready: Option<bool>,
    /// Install guidance when `sandbox_ready` is `Some(false)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_message: Option<String>,
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
    pub rate_limit_reached_type: Option<String>,
    pub model_limits: Vec<CodexAdditionalUsageLimit>,
    pub fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerAuthTokens {
    pub access_token: String,
    pub chatgpt_account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_plan_type: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexArchiveFormat {
    TarGz,
    Zip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexAssetCandidate {
    name: String,
    binary_target: String,
    format: CodexArchiveFormat,
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
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    chatgpt_account_id: Option<String>,
    #[serde(default)]
    chatgpt_plan_type: Option<String>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppServerRateLimitsParams {
    rate_limits: CodexAppServerRateLimitSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppServerRateLimitSnapshot {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    primary: Option<CodexAppServerRateLimitWindow>,
    #[serde(default)]
    secondary: Option<CodexAppServerRateLimitWindow>,
    #[serde(default)]
    credits: Option<CodexAppServerCredits>,
    #[serde(default)]
    rate_limit_reached_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppServerRateLimitWindow {
    #[serde(default, deserialize_with = "de_opt_f64")]
    used_percent: Option<f64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    resets_at: Option<u64>,
    #[serde(default, deserialize_with = "de_opt_u64")]
    window_duration_mins: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppServerCredits {
    #[serde(default, deserialize_with = "de_opt_f64")]
    balance: Option<f64>,
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
pub async fn detect_codex_in_path(app: AppHandle) -> Result<CodexPathDetection, String> {
    log::debug!("detect_codex_in_path: starting");

    let jean_managed_path = get_cli_binary_path(&app)
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());
    let wsl = crate::platform::get_wsl_config();
    let jean_managed_wsl = if wsl.enabled {
        super::config::get_wsl_cli_binary_path(&wsl.distro).ok()
    } else {
        None
    };
    log::debug!("detect_codex_in_path: jean_managed_path={jean_managed_path:?}");

    let detection = crate::platform::detect_cli_in_path(
        "codex",
        jean_managed_path.as_deref(),
        jean_managed_wsl.as_deref(),
    );

    if !detection.found {
        log::debug!("detect_codex_in_path: not found");
        return Ok(CodexPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    }

    let version = detection.version.and_then(|ver_str| {
        let cleaned = ver_str
            .split_whitespace()
            .last()
            .unwrap_or(&ver_str)
            .trim_start_matches('v')
            .to_string();
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    });

    log::debug!(
        "detect_codex_in_path: result path={:?} version={:?} pkg_mgr={:?}",
        detection.path,
        version,
        detection.package_manager
    );

    Ok(CodexPathDetection {
        found: true,
        path: detection.path,
        version,
        package_manager: detection.package_manager,
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

fn push_codex_home_auth_path(
    paths: &mut Vec<PathBuf>,
    codex_home: Option<&str>,
    in_wsl: bool,
    distro: &str,
) {
    let Some(codex_home) = codex_home else {
        return;
    };
    let trimmed = codex_home.trim();
    if trimmed.is_empty() {
        return;
    }

    let auth_path = PathBuf::from(trimmed).join("auth.json");
    if in_wsl {
        if trimmed.starts_with('/') {
            paths.push(PathBuf::from(crate::platform::wsl_to_win_path(
                &auth_path.to_string_lossy(),
                distro,
            )));
        }
    } else {
        paths.push(auth_path);
    }
}

fn push_host_codex_auth_paths(
    paths: &mut Vec<PathBuf>,
    host_home: Option<PathBuf>,
    codex_home: Option<&str>,
) {
    push_codex_home_auth_path(paths, codex_home, false, "");

    if let Some(home) = host_home {
        paths.push(home.join(".config").join("codex").join("auth.json"));
        paths.push(home.join(".codex").join("auth.json"));
    }
}

fn push_wsl_codex_auth_paths(
    paths: &mut Vec<PathBuf>,
    wsl_home: Option<&str>,
    codex_home: Option<&str>,
    distro: &str,
) {
    push_codex_home_auth_path(paths, codex_home, true, distro);

    let Some(wsl_home) = wsl_home else {
        return;
    };
    let trimmed_home = wsl_home.trim();
    if trimmed_home.is_empty() {
        return;
    }

    for unix_path in [
        format!("{trimmed_home}/.config/codex/auth.json"),
        format!("{trimmed_home}/.codex/auth.json"),
    ] {
        paths.push(PathBuf::from(crate::platform::wsl_to_win_path(
            &unix_path, distro,
        )));
    }
}

fn should_prefer_wsl_codex_auth(wsl_enabled: bool, binary_path: Option<&str>) -> bool {
    wsl_enabled
        && binary_path
            .map(|path| path.starts_with('/'))
            .unwrap_or(true)
}

fn build_codex_auth_paths(
    codex_home: Option<&str>,
    host_home: Option<PathBuf>,
    wsl_home: Option<&str>,
    wsl_enabled: bool,
    distro: &str,
    binary_path: Option<&str>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if should_prefer_wsl_codex_auth(wsl_enabled, binary_path) {
        push_wsl_codex_auth_paths(&mut paths, wsl_home, codex_home, distro);
    }

    push_host_codex_auth_paths(&mut paths, host_home, codex_home);
    paths.dedup();
    paths
}

fn get_codex_auth_paths(binary_path: Option<&str>) -> Vec<PathBuf> {
    let codex_home = std::env::var("CODEX_HOME").ok();
    let host_home = dirs::home_dir();
    let wsl = crate::platform::get_wsl_config();
    let wsl_home = if wsl.enabled {
        crate::platform::get_wsl_home_dir(&wsl.distro).ok()
    } else {
        None
    };

    build_codex_auth_paths(
        codex_home.as_deref(),
        host_home,
        wsl_home.as_deref(),
        wsl.enabled,
        &wsl.distro,
        binary_path,
    )
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

fn load_codex_auth_for_binary(
    binary_path: Option<&str>,
) -> Result<(CodexAuthSource, CodexAuthFile), String> {
    let auth_paths = get_codex_auth_paths(binary_path);

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

#[allow(dead_code)]
fn load_codex_auth() -> Result<(CodexAuthSource, CodexAuthFile), String> {
    load_codex_auth_for_binary(None)
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

fn current_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn map_app_server_rate_limit_window(
    window: Option<CodexAppServerRateLimitWindow>,
) -> Option<CodexUsageWindowSnapshot> {
    let window = window?;
    let used_percent = window.used_percent?;

    Some(CodexUsageWindowSnapshot {
        used_percent,
        resets_at: window.resets_at,
        limit_window_seconds: window
            .window_duration_mins
            .map(|mins| mins.saturating_mul(60)),
    })
}

pub(crate) fn codex_usage_snapshot_from_app_server_rate_limits(
    params: &Value,
    fetched_at: u64,
) -> Result<CodexUsageSnapshot, String> {
    let notification = serde_json::from_value::<CodexAppServerRateLimitsParams>(params.clone())
        .map_err(|e| format!("Failed to parse Codex rate limits notification payload: {e}"))?;
    let rate_limits = notification.rate_limits;

    Ok(CodexUsageSnapshot {
        plan_type: rate_limits.plan_type,
        session: map_app_server_rate_limit_window(rate_limits.primary),
        weekly: map_app_server_rate_limit_window(rate_limits.secondary),
        reviews: None,
        credits_remaining: rate_limits.credits.and_then(|credits| credits.balance),
        rate_limit_reached_type: rate_limits.rate_limit_reached_type,
        model_limits: Vec::new(),
        fetched_at,
    })
}

pub(crate) fn update_codex_usage_from_app_server_rate_limits(
    app: &AppHandle,
    params: &Value,
) -> Result<CodexUsageSnapshot, String> {
    let snapshot = codex_usage_snapshot_from_app_server_rate_limits(params, current_unix_secs())?;
    save_cached_codex_usage(&snapshot, snapshot.fetched_at);
    let _ = app.emit_all("codex-cli:usage-updated", &snapshot);
    Ok(snapshot)
}

async fn refresh_codex_access_token(
    client: &reqwest::Client,
    auth_source: &CodexAuthSource,
    auth: &mut CodexAuthFile,
) -> Result<Option<CodexRefreshResponse>, String> {
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
    if let Some(account_id) = refreshed
        .chatgpt_account_id
        .clone()
        .or_else(|| refreshed.account_id.clone())
    {
        tokens.account_id = Some(account_id);
    }
    if let Some(refresh_token) = refreshed.refresh_token.clone() {
        tokens.refresh_token = Some(refresh_token);
    }
    if let Some(id_token) = refreshed.id_token.clone() {
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

    Ok(Some(refreshed))
}

pub async fn refresh_codex_app_server_auth_tokens(
    app: AppHandle,
    previous_account_id: Option<String>,
) -> Result<CodexAppServerAuthTokens, String> {
    let binary_path = resolve_cli_binary(&app)?;
    let binary_str = binary_path.to_string_lossy();
    let (auth_source, mut auth) = load_codex_auth_for_binary(Some(&binary_str))?;
    let client = build_usage_client()?;
    let refreshed = refresh_codex_access_token(&client, &auth_source, &mut auth).await?;
    if refreshed.is_none() {
        return Err("Codex token refresh failed.".to_string());
    }

    let access_token = auth
        .tokens
        .as_ref()
        .and_then(|t| t.access_token.clone())
        .ok_or_else(|| "Codex access token missing. Run `codex` to authenticate.".to_string())?;
    let chatgpt_account_id = auth
        .tokens
        .as_ref()
        .and_then(|t| t.account_id.clone())
        .or(previous_account_id)
        .ok_or_else(|| {
            "Codex account id missing. Run `codex` to authenticate again.".to_string()
        })?;
    let chatgpt_plan_type = refreshed.and_then(|r| r.chatgpt_plan_type);

    Ok(CodexAppServerAuthTokens {
        access_token,
        chatgpt_account_id,
        chatgpt_plan_type,
    })
}

/// Package-manager hint for installing system bubblewrap on Linux.
fn bubblewrap_install_hint() -> String {
    if std::path::Path::new("/etc/debian_version").exists() {
        "Codex sandbox requires bubblewrap. Install it with: sudo apt install bubblewrap"
            .to_string()
    } else if std::path::Path::new("/etc/fedora-release").exists()
        || std::path::Path::new("/etc/redhat-release").exists()
    {
        "Codex sandbox requires bubblewrap. Install it with: sudo dnf install bubblewrap"
            .to_string()
    } else if std::path::Path::new("/etc/arch-release").exists() {
        "Codex sandbox requires bubblewrap. Install it with: sudo pacman -S bubblewrap".to_string()
    } else {
        "Codex sandbox requires bubblewrap (bwrap). Install it via your package manager \
         (e.g. `sudo apt install bubblewrap` on Debian/Ubuntu)."
            .to_string()
    }
}

/// True when `bwrap` is on PATH (host).
fn host_has_system_bwrap() -> bool {
    crate::platform::silent_command("bwrap")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// True when Jean-managed / Codex-adjacent `codex-resources/bwrap` exists next to the binary.
fn bundled_bwrap_exists(binary_path: &std::path::Path) -> bool {
    binary_path
        .parent()
        .map(|dir| dir.join("codex-resources").join("bwrap").is_file())
        .unwrap_or(false)
}

/// Linux sandbox readiness for a Codex binary on the host (non-WSL).
fn linux_sandbox_status_for_host_binary(
    binary_path: &std::path::Path,
) -> (Option<bool>, Option<String>) {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = binary_path;
        (None, None)
    }
    #[cfg(target_os = "linux")]
    {
        if host_has_system_bwrap() || bundled_bwrap_exists(binary_path) {
            (Some(true), None)
        } else {
            (Some(false), Some(bubblewrap_install_hint()))
        }
    }
}

/// Linux sandbox readiness when Codex runs inside WSL.
fn linux_sandbox_status_for_wsl_binary(
    distro: &str,
    binary_path: &str,
) -> (Option<bool>, Option<String>) {
    // System bwrap inside the distro
    if crate::platform::check_wsl_tool(distro, "bwrap") {
        return (Some(true), None);
    }
    // Bundled helper next to Jean-managed binary
    if let Some(parent) = std::path::Path::new(binary_path).parent() {
        let bundled = parent
            .join("codex-resources")
            .join("bwrap")
            .to_string_lossy()
            .to_string();
        if crate::platform::wsl_file_executable(distro, &bundled) {
            return (Some(true), None);
        }
    }
    (
        Some(false),
        Some(
            "Codex sandbox requires bubblewrap inside WSL. Install it with: \
             sudo apt install bubblewrap (or your distro's equivalent)."
                .to_string(),
        ),
    )
}

fn empty_codex_status() -> CodexCliStatus {
    CodexCliStatus {
        installed: false,
        version: None,
        path: None,
        sandbox_ready: None,
        sandbox_message: None,
    }
}

/// Check if Codex CLI is installed and get its status
pub async fn check_codex_cli_installed(app: AppHandle) -> Result<CodexCliStatus, String> {
    log::debug!("check_codex_cli_installed: starting");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_cli_binary(&app)?;
    log::debug!(
        "check_codex_cli_installed: resolved binary_path={:?}",
        binary_path
    );

    if wsl.enabled {
        let tool = binary_path.to_string_lossy().to_string();
        let installed = if tool.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &tool)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &tool)
        };
        if !installed {
            return Ok(empty_codex_status());
        }
        let version = crate::platform::wsl_tool_version(&wsl.distro, &tool).and_then(|v| {
            let cleaned = v
                .split_whitespace()
                .last()
                .unwrap_or(&v)
                .trim_start_matches('v')
                .to_string();
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        });
        let (sandbox_ready, sandbox_message) =
            linux_sandbox_status_for_wsl_binary(&wsl.distro, &tool);
        return Ok(CodexCliStatus {
            installed: true,
            version,
            path: Some(tool),
            sandbox_ready,
            sandbox_message,
        });
    }

    if !binary_path.exists() {
        log::debug!(
            "check_codex_cli_installed: binary not found at {:?}",
            binary_path
        );
        return Ok(empty_codex_status());
    }

    // Get version
    let version = match crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
    {
        Ok(output) if output.status.success() => {
            let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            log::debug!(
                "check_codex_cli_installed: raw --version output={:?}",
                version_str
            );
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
            log::debug!(
                "check_codex_cli_installed: --version failed, exit_status={}, stderr={:?}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
            None
        }
        Err(e) => {
            log::debug!("check_codex_cli_installed: --version command error: {e}");
            None
        }
    };

    let (sandbox_ready, sandbox_message) = linux_sandbox_status_for_host_binary(&binary_path);

    let status = CodexCliStatus {
        installed: true,
        version: version.clone(),
        path: Some(binary_path.to_string_lossy().to_string()),
        sandbox_ready,
        sandbox_message,
    };
    log::debug!(
        "check_codex_cli_installed: returning installed={} version={:?} path={:?} sandbox_ready={:?}",
        status.installed,
        status.version,
        status.path,
        status.sandbox_ready
    );

    Ok(status)
}

/// Check if Codex CLI is authenticated
pub async fn check_codex_cli_auth(app: AppHandle) -> Result<CodexAuthStatus, String> {
    log::trace!("Checking Codex CLI authentication status");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_cli_binary(&app)?;

    if !wsl.enabled && !binary_path.exists() {
        return Ok(CodexAuthStatus {
            authenticated: false,
            error: Some("Codex CLI not installed".to_string()),
        });
    }
    if wsl.enabled {
        let tool = binary_path.to_string_lossy().to_string();
        let installed = if tool.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &tool)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &tool)
        };
        if !installed {
            return Ok(CodexAuthStatus {
                authenticated: false,
                error: Some("Codex CLI not installed inside WSL".to_string()),
            });
        }
    }

    let binary_str = binary_path.to_string_lossy().to_string();
    let output = crate::platform::wsl_aware_command(&binary_str, None)
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
pub async fn get_codex_usage(app: AppHandle) -> Result<CodexUsageSnapshot, String> {
    let now_secs = current_unix_secs();
    if let Some(cached) = load_cached_codex_usage(now_secs) {
        return Ok(cached);
    }

    let binary_path = resolve_cli_binary(&app)?;
    let binary_str = binary_path.to_string_lossy();
    let (auth_source, mut auth) = load_codex_auth_for_binary(Some(&binary_str))?;
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
        if let Some(refreshed) =
            refresh_codex_access_token(&usage_client, &auth_source, &mut auth).await?
        {
            access_token = refreshed.access_token;
            let account_id = auth.tokens.as_ref().and_then(|t| t.account_id.clone());
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
        rate_limit_reached_type: None,
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
    log::debug!(
        "save_codex_versions_cache: writing {} versions to {cache_path:?}",
        versions.len()
    );
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
    let cache_path = super::config::get_cli_dir(app)
        .ok()?
        .join(CODEX_VERSIONS_CACHE_FILE);
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

    let target = resolve_codex_runtime_target()?;
    let asset_names = codex_asset_name_candidates(target);
    let versions = codex_versions_from_releases(releases, &asset_names);

    log::trace!("Found {} Codex CLI versions from API", versions.len());
    Ok(versions)
}

fn codex_versions_from_releases(
    releases: Vec<GitHubRelease>,
    asset_names: &[String],
) -> Vec<CodexReleaseInfo> {
    releases
        .into_iter()
        .filter(|r| !r.prerelease && find_matching_asset_url(r, asset_names).is_some())
        .take(5)
        .map(|r| CodexReleaseInfo {
            version: extract_version_from_tag(&r.tag_name),
            tag_name: r.tag_name,
            published_at: r.published_at,
            prerelease: r.prerelease,
        })
        .collect()
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
        return Ok("x86_64-unknown-linux-musl");
    }

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Ok("aarch64-unknown-linux-musl");
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

fn resolve_codex_runtime_target() -> Result<&'static str, String> {
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        wsl_codex_target(&wsl.distro)
    } else {
        get_codex_target()
    }
}

fn codex_asset_candidates(target: &str) -> Vec<CodexAssetCandidate> {
    let tar_gz = |binary_target: &str| CodexAssetCandidate {
        name: format!("codex-{binary_target}.tar.gz"),
        binary_target: binary_target.to_string(),
        format: CodexArchiveFormat::TarGz,
    };
    let zip = |binary_target: &str| CodexAssetCandidate {
        name: format!("codex-{binary_target}.exe.zip"),
        binary_target: binary_target.to_string(),
        format: CodexArchiveFormat::Zip,
    };

    match target {
        "x86_64-unknown-linux-musl" => vec![
            tar_gz("x86_64-unknown-linux-musl"),
            tar_gz("x86_64-unknown-linux-gnu"),
        ],
        "aarch64-unknown-linux-musl" => vec![
            tar_gz("aarch64-unknown-linux-musl"),
            tar_gz("aarch64-unknown-linux-gnu"),
        ],
        "x86_64-unknown-linux-gnu" => vec![
            tar_gz("x86_64-unknown-linux-gnu"),
            tar_gz("x86_64-unknown-linux-musl"),
        ],
        "aarch64-unknown-linux-gnu" => vec![
            tar_gz("aarch64-unknown-linux-gnu"),
            tar_gz("aarch64-unknown-linux-musl"),
        ],
        "x86_64-pc-windows-msvc" | "aarch64-pc-windows-msvc" => vec![zip(target)],
        _ => vec![tar_gz(target)],
    }
}

fn codex_asset_name_candidates(target: &str) -> Vec<String> {
    codex_asset_candidates(target)
        .into_iter()
        .map(|candidate| candidate.name)
        .collect()
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
                let target = resolve_codex_runtime_target()?;
                let asset_names = codex_asset_name_candidates(target);
                if let Some(version) = latest_codex_version_from_releases(releases, &asset_names) {
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

fn latest_codex_version_from_releases(
    releases: Vec<GitHubRelease>,
    asset_names: &[String],
) -> Option<String> {
    releases
        .into_iter()
        .find(|release| find_matching_asset_url(release, asset_names).is_some())
        .map(|release| extract_version_from_tag(&release.tag_name))
}

/// Find the download URL for a specific asset by searching recent releases
async fn find_asset_url(
    app: &AppHandle,
    version: &str,
    candidates: &[CodexAssetCandidate],
) -> Result<(String, CodexAssetCandidate), String> {
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
            if let Some((url, candidate)) = find_matching_candidate_asset(release, candidates) {
                return Ok((url, candidate));
            }
            let asset_names: Vec<&str> = candidates
                .iter()
                .map(|candidate| candidate.name.as_str())
                .collect();
            return Err(format!(
                "Assets [{}] not found in release {}",
                asset_names.join(", "),
                release.tag_name
            ));
        }
    }

    Err(format!("Release for version {version} not found"))
}

pub async fn check_codex_cli_version_exists(
    app: AppHandle,
    version: String,
) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }

    let target = resolve_codex_runtime_target()?;
    let asset_names = codex_asset_name_candidates(target);
    let client = build_github_client()?;
    let token = resolve_github_api_token(&app);
    let tags = [
        format!("rust-v{version}"),
        format!("codex-v{version}"),
        format!("v{version}"),
    ];

    for tag in tags {
        let mut request = client
            .get(format!("{CODEX_RELEASES_API}/tags/{tag}"))
            .header("Accept", GITHUB_API_ACCEPT)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION);
        if let Some(ref token) = token {
            request = request.bearer_auth(token);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Failed to check Codex version: {e}"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("GitHub API returned status: {}", response.status()));
        }
        let release: GitHubRelease = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Codex release: {e}"))?;
        return Ok(find_matching_asset_url(&release, &asset_names).is_some());
    }

    Ok(false)
}

fn find_matching_candidate_asset(
    release: &GitHubRelease,
    candidates: &[CodexAssetCandidate],
) -> Option<(String, CodexAssetCandidate)> {
    for candidate in candidates {
        for asset in &release.assets {
            if asset.name == candidate.name {
                return Some((asset.browser_download_url.clone(), candidate.clone()));
            }
        }
    }
    None
}

fn find_matching_asset_url(release: &GitHubRelease, asset_names: &[String]) -> Option<String> {
    for asset_name in asset_names {
        for asset in &release.assets {
            if asset.name == *asset_name {
                return Some(asset.browser_download_url.clone());
            }
        }
    }
    None
}

/// Pick the codex target triple for a WSL distro given the host install.
fn wsl_codex_target(distro: &str) -> Result<&'static str, String> {
    resolve_codex_runtime_target_for_wsl_arch(true, crate::platform::wsl_detect_arch(distro))
}

fn resolve_codex_runtime_target_for_wsl_arch(
    wsl_enabled: bool,
    wsl_arch: Option<&str>,
) -> Result<&'static str, String> {
    if !wsl_enabled {
        return get_codex_target();
    }

    match wsl_arch {
        Some("linux-x64") => Ok("x86_64-unknown-linux-musl"),
        Some("linux-arm64") => Ok("aarch64-unknown-linux-musl"),
        _ => Err("Unsupported WSL architecture (expected x86_64 or aarch64)".to_string()),
    }
}

/// Install Codex CLI by downloading from GitHub releases
pub async fn install_codex_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    log::trace!("Installing Codex CLI, version: {:?}", version);

    let wsl = crate::platform::get_wsl_config();

    // Emit progress: starting
    emit_progress(&app, "starting", "Preparing installation...", 0);

    // Determine version
    let version = match version {
        Some(v) => v,
        None => fetch_latest_codex_version(&app).await?,
    };

    // Target triple differs for native host vs WSL.
    let target: &str = resolve_codex_runtime_target()?;
    log::trace!("Installing version {version} for target {target}");

    let candidates = codex_asset_candidates(target);

    // Find the download URL from the release assets
    let (download_url, asset_candidate) = find_asset_url(&app, &version, &candidates).await?;
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

    // Extract the binary bytes in-memory so native and WSL can share the flow.
    // Windows zips also ship sandbox helpers next to the main binary; Codex looks
    // for them via current_exe()'s parent directory (see codex-windows-sandbox).
    let (binary_bytes, windows_helpers) = match asset_candidate.format {
        CodexArchiveFormat::Zip => {
            let extracted =
                extract_windows_codex_zip(&archive_content, &asset_candidate.binary_target)?;
            (extracted.main_binary, extracted.helpers)
        }
        CodexArchiveFormat::TarGz => (
            extract_tar_gz_binary_bytes(&archive_content, &asset_candidate.binary_target)?,
            Vec::new(),
        ),
    };

    if wsl.enabled {
        // WSL branch: stream the binary into the distro and make it executable.
        // Linux sandboxing does not use the Windows helper binaries.
        let unix_path = super::config::get_wsl_cli_binary_path(&wsl.distro)?;
        emit_progress(&app, "installing", "Installing Codex CLI into WSL...", 65);
        log::trace!("Writing codex binary into WSL at {unix_path}");
        crate::platform::wsl_write_bytes(&wsl.distro, &unix_path, &binary_bytes)
            .map_err(|e| format!("Failed to write binary into WSL: {e}"))?;
        crate::platform::wsl_chmod_exec(&wsl.distro, &unix_path)?;
        // Best-effort: ship bundled bubblewrap next to the binary so sandboxed
        // shell/apply_patch works without a system `apt install bubblewrap`.
        if let Err(e) = install_linux_bwrap_helper(
            &app,
            &version,
            target,
            None,
            Some((&wsl.distro, &unix_path)),
        )
        .await
        {
            log::warn!("Could not install bundled Codex bubblewrap into WSL: {e}");
        }
        // Best-effort: ship code-mode host next to codex. Codex 0.147+ has
        // features.code_mode_host stable and spawns this sibling binary for
        // local tool execution — without it, sessions fail with ENOENT.
        if let Err(e) = install_code_mode_host_helper(
            &app,
            &version,
            target,
            None,
            Some((&wsl.distro, &unix_path)),
        )
        .await
        {
            log::warn!("Could not install Codex code-mode host into WSL: {e}");
        }
        emit_progress(&app, "complete", "Installation complete!", 100);
        log::trace!("Codex CLI installed successfully at WSL:{unix_path}");
        return Ok(());
    }

    // Create the install dir on all platforms. Path is used for Windows helpers
    // and Linux bubblewrap; macOS only needs the side effect of ensuring the dir.
    #[cfg_attr(not(any(windows, target_os = "linux")), allow(unused_variables))]
    let cli_dir = ensure_cli_dir(&app)?;
    let binary_path = get_cli_binary_path(&app)?;

    // On Windows, a running codex.exe holds a file lock that prevents overwriting.
    // Rename the old binary out of the way before extracting the new one.
    #[cfg(windows)]
    if binary_path.exists() {
        let old_path = binary_path.with_extension("exe.old");
        let _ = std::fs::remove_file(&old_path); // Clean up previous .old if any
        if let Err(e) = std::fs::rename(&binary_path, &old_path) {
            log::warn!("Could not rename existing binary (may be unlocked): {e}");
            if let Err(e2) = std::fs::remove_file(&binary_path) {
                return Err(format!(
                    "Cannot replace existing Codex CLI binary — it may be in use by another process. \
                     Please close any running Codex sessions and try again. (rename: {e}, remove: {e2})"
                ));
            }
        }
    }

    crate::platform::write_binary_file(&binary_path, &binary_bytes)
        .map_err(|e| format!("Failed to write Codex CLI binary: {e}"))?;

    // Windows-only: sandbox helpers live next to codex.exe. macOS/Linux use
    // tar.gz (no helpers) and WSL returns earlier with the Linux binary only.
    // Issue #265 — without these, sandboxed shell/apply_patch fails with
    // "windows sandbox: spawn setup refresh".
    #[cfg(windows)]
    for helper in &windows_helpers {
        let helper_path = cli_dir.join(&helper.file_name);
        crate::platform::write_binary_file(&helper_path, &helper.bytes)
            .map_err(|e| format!("Failed to write Codex helper '{}': {e}", helper.file_name))?;
        log::info!(
            "Installed Codex Windows helper {} ({} bytes)",
            helper.file_name,
            helper.bytes.len()
        );
    }
    #[cfg(not(windows))]
    let _ = &windows_helpers;

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

    // Linux: best-effort install of Codex's bundled bubblewrap next to the
    // binary (`codex-resources/bwrap`). GitHub release tarballs ship the main
    // CLI only; sandbox needs system bwrap OR this helper.
    #[cfg(target_os = "linux")]
    {
        if let Err(e) =
            install_linux_bwrap_helper(&app, &version, target, Some(&cli_dir), None).await
        {
            log::warn!("Could not install bundled Codex bubblewrap: {e}");
        }
    }

    // All platforms: best-effort install of `codex-code-mode-host` next to the
    // main binary. Official releases ship it as a separate asset (or inside
    // codex-package-*); Jean previously only extracted the main CLI, so Codex
    // 0.147+ failed to spawn the host (ENOENT) during tool execution.
    if let Err(e) =
        install_code_mode_host_helper(&app, &version, target, Some(&cli_dir), None).await
    {
        log::warn!("Could not install Codex code-mode host: {e}");
    }

    // Remove macOS quarantine attribute
    #[cfg(target_os = "macos")]
    {
        let _ = silent_command("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&binary_path)
            .output();
        let host_path = cli_dir.join("codex-code-mode-host");
        if host_path.exists() {
            let _ = silent_command("xattr")
                .args(["-d", "com.apple.quarantine"])
                .arg(&host_path)
                .output();
        }
    }

    // Emit progress: verifying
    emit_progress(&app, "verifying", "Verifying installation...", 80);

    // Verify the binary works
    let version_output = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
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

/// Uninstall the Jean-managed Codex CLI by deleting its directory.
///
/// Refuses to run while any sessions are active. Idempotent.
pub async fn uninstall_codex_cli(app: AppHandle) -> Result<(), String> {
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot uninstall Codex CLI while {} {} running. Please stop all active sessions first.",
            count,
            if count == 1 { "session is" } else { "sessions are" }
        ));
    }

    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        let unix_path = super::config::get_wsl_cli_binary_path(&wsl.distro)?;
        crate::platform::wsl_remove_path(&wsl.distro, &unix_path)
            .map_err(|e| format!("Failed to remove Codex CLI from WSL: {e}"))?;
        log::info!("Removed Jean-managed Codex CLI at WSL:{unix_path}");
    }

    let cli_dir = get_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove Codex CLI directory: {e}"))?;
        log::info!("Removed Jean-managed Codex CLI at {:?}", cli_dir);
    }
    Ok(())
}

/// Extract the codex binary bytes from a tar.gz archive (Linux/macOS release).
fn extract_tar_gz_binary_bytes(archive_content: &[u8], target: &str) -> Result<Vec<u8>, String> {
    let expected_name = format!("codex-{target}");
    extract_tar_gz_entry_by_file_name(archive_content, &expected_name)
}

/// Extract a single file from a tar.gz by exact file name (basename match).
fn extract_tar_gz_entry_by_file_name(
    archive_content: &[u8],
    expected_name: &str,
) -> Result<Vec<u8>, String> {
    use flate2::read::GzDecoder;
    use std::io::{Cursor, Read};
    use tar::Archive;

    let cursor = Cursor::new(archive_content);
    let decoder = GzDecoder::new(cursor);
    let mut archive = Archive::new(decoder);

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
                    .map_err(|e| format!("Failed to read '{expected_name}' from archive: {e}"))?;
                return Ok(content);
            }
        }
    }

    Err(format!(
        "File '{expected_name}' not found in tar.gz archive"
    ))
}

/// Linux sandbox helper asset names for a Codex target triple.
///
/// Official Codex releases ship `bwrap-{linux-target}.tar.gz` separately from
/// the main CLI tarball. Codex looks for `codex-resources/bwrap` next to the
/// executable when system bubblewrap is missing.
fn bwrap_asset_candidates(target: &str) -> Vec<CodexAssetCandidate> {
    // Only Linux targets have bubblewrap helpers.
    if !target.contains("linux") {
        return Vec::new();
    }
    // Prefer musl static bwrap; fall back to gnu if present.
    let mut names = Vec::new();
    if target.contains("x86_64") {
        names.push("x86_64-unknown-linux-musl");
        names.push("x86_64-unknown-linux-gnu");
    } else if target.contains("aarch64") {
        names.push("aarch64-unknown-linux-musl");
        names.push("aarch64-unknown-linux-gnu");
    } else {
        names.push(target);
    }
    names
        .into_iter()
        .map(|binary_target| CodexAssetCandidate {
            name: format!("bwrap-{binary_target}.tar.gz"),
            binary_target: binary_target.to_string(),
            format: CodexArchiveFormat::TarGz,
        })
        .collect()
}

/// Download and install Codex's bundled bubblewrap next to the Jean-managed binary.
///
/// Best-effort: callers log and continue on failure so install still succeeds
/// when the asset is missing (older releases) or network fails. Users can still
/// `sudo apt install bubblewrap` for a system-wide fix.
async fn install_linux_bwrap_helper(
    app: &AppHandle,
    version: &str,
    target: &str,
    host_cli_dir: Option<&std::path::Path>,
    wsl_binary: Option<(&str, &str)>, // (distro, codex unix path)
) -> Result<(), String> {
    let candidates = bwrap_asset_candidates(target);
    if candidates.is_empty() {
        return Ok(());
    }

    let (download_url, asset_candidate) = find_asset_url(app, version, &candidates).await?;
    log::info!("Downloading Codex bubblewrap helper from {download_url}");

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client for bwrap: {e}"))?;

    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download bubblewrap helper: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download bubblewrap helper: HTTP {}",
            response.status()
        ));
    }
    let archive_content = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read bubblewrap archive: {e}"))?;

    let expected_name = format!("bwrap-{}", asset_candidate.binary_target);
    let bwrap_bytes = extract_tar_gz_entry_by_file_name(&archive_content, &expected_name)?;

    if let Some((distro, codex_unix_path)) = wsl_binary {
        let parent = std::path::Path::new(codex_unix_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        let resources_dir = format!("{parent}/codex-resources");
        let bwrap_path = format!("{resources_dir}/bwrap");
        // Ensure directory exists inside WSL
        let mkdir = crate::platform::silent_command("wsl.exe")
            .args(["-d", distro, "--", "mkdir", "-p", &resources_dir])
            .output()
            .map_err(|e| format!("Failed to create WSL codex-resources dir: {e}"))?;
        if !mkdir.status.success() {
            return Err(format!(
                "Failed to create WSL codex-resources dir: {}",
                String::from_utf8_lossy(&mkdir.stderr)
            ));
        }
        crate::platform::wsl_write_bytes(distro, &bwrap_path, &bwrap_bytes)
            .map_err(|e| format!("Failed to write bwrap into WSL: {e}"))?;
        crate::platform::wsl_chmod_exec(distro, &bwrap_path)?;
        log::info!("Installed bundled Codex bubblewrap at WSL:{bwrap_path}");
        return Ok(());
    }

    let cli_dir = host_cli_dir
        .ok_or_else(|| "Missing host CLI directory for bubblewrap install".to_string())?;
    let resources_dir = cli_dir.join("codex-resources");
    std::fs::create_dir_all(&resources_dir)
        .map_err(|e| format!("Failed to create codex-resources directory: {e}"))?;
    let bwrap_path = resources_dir.join("bwrap");
    crate::platform::write_binary_file(&bwrap_path, &bwrap_bytes)
        .map_err(|e| format!("Failed to write bundled bwrap: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&bwrap_path)
            .map_err(|e| format!("Failed to get bwrap metadata: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bwrap_path, perms)
            .map_err(|e| format!("Failed to set bwrap permissions: {e}"))?;
    }
    log::info!("Installed bundled Codex bubblewrap at {:?}", bwrap_path);
    Ok(())
}

/// Installed file name for the Codex code-mode host sibling binary.
#[cfg(windows)]
const CODE_MODE_HOST_BINARY_NAME: &str = "codex-code-mode-host.exe";
#[cfg(not(windows))]
const CODE_MODE_HOST_BINARY_NAME: &str = "codex-code-mode-host";

/// Asset candidates for the separate `codex-code-mode-host` release artifact.
///
/// Official Codex releases (0.144+) ship this as a sibling of the main CLI:
/// `codex-code-mode-host-{target}.tar.gz` / `.exe.zip`. Codex looks for
/// `codex-code-mode-host` next to `current_exe()` when `features.code_mode_host`
/// is enabled (stable in 0.147+).
fn code_mode_host_asset_candidates(target: &str) -> Vec<CodexAssetCandidate> {
    let targets: Vec<&str> = match target {
        "x86_64-unknown-linux-musl" | "x86_64-unknown-linux-gnu" => {
            vec!["x86_64-unknown-linux-musl", "x86_64-unknown-linux-gnu"]
        }
        "aarch64-unknown-linux-musl" | "aarch64-unknown-linux-gnu" => {
            vec!["aarch64-unknown-linux-musl", "aarch64-unknown-linux-gnu"]
        }
        other => vec![other],
    };

    targets
        .into_iter()
        .map(|binary_target| {
            if binary_target.contains("windows") {
                CodexAssetCandidate {
                    name: format!("codex-code-mode-host-{binary_target}.exe.zip"),
                    binary_target: binary_target.to_string(),
                    format: CodexArchiveFormat::Zip,
                }
            } else {
                CodexAssetCandidate {
                    name: format!("codex-code-mode-host-{binary_target}.tar.gz"),
                    binary_target: binary_target.to_string(),
                    format: CodexArchiveFormat::TarGz,
                }
            }
        })
        .collect()
}

fn codex_requires_code_mode_host(version: &str) -> bool {
    let mut parts = version.trim_start_matches('v').split('.');
    let Some(major) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    let Some(minor) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
        return false;
    };
    major > 0 || minor >= 147
}

/// Install only the missing code-mode host required by Jean-managed Codex
/// 0.147+. Returns true when the helper was installed.
pub async fn install_missing_codex_code_mode_host(app: AppHandle) -> Result<bool, String> {
    let preferences = crate::load_preferences_sync(&app)?;
    if preferences.codex_cli_source != "jean" {
        return Ok(false);
    }
    if !super::config::jean_managed_installed(&app) {
        return Ok(false);
    }

    let status = check_codex_cli_installed(app.clone()).await?;
    let Some(version) = status.version else {
        return Ok(false);
    };
    if !status.installed || !codex_requires_code_mode_host(&version) {
        return Ok(false);
    }

    let wsl = crate::platform::get_wsl_config();
    let target = resolve_codex_runtime_target()?;
    if wsl.enabled {
        let codex_path = super::config::get_wsl_cli_binary_path(&wsl.distro)?;
        let parent = std::path::Path::new(&codex_path)
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        let host_path = format!("{parent}/codex-code-mode-host");
        if crate::platform::wsl_file_executable(&wsl.distro, &host_path) {
            return Ok(false);
        }
        install_code_mode_host_helper(
            &app,
            &version,
            target,
            None,
            Some((&wsl.distro, &codex_path)),
        )
        .await?;
        return Ok(true);
    }

    let cli_dir = get_cli_dir(&app)?;
    let host_path = cli_dir.join(CODE_MODE_HOST_BINARY_NAME);
    if host_path.exists() {
        return Ok(false);
    }
    install_code_mode_host_helper(&app, &version, target, Some(&cli_dir), None).await?;

    #[cfg(target_os = "macos")]
    let _ = silent_command("xattr")
        .args(["-d", "com.apple.quarantine"])
        .arg(&host_path)
        .output();

    Ok(true)
}

/// Download and install `codex-code-mode-host` next to the Jean-managed binary.
///
/// Best-effort: callers log and continue on failure so install still succeeds
/// when the asset is missing (older releases) or network fails.
async fn install_code_mode_host_helper(
    app: &AppHandle,
    version: &str,
    target: &str,
    host_cli_dir: Option<&std::path::Path>,
    wsl_binary: Option<(&str, &str)>, // (distro, codex unix path)
) -> Result<(), String> {
    let candidates = code_mode_host_asset_candidates(target);
    if candidates.is_empty() {
        return Ok(());
    }

    let (download_url, asset_candidate) = find_asset_url(app, version, &candidates).await?;
    log::info!("Downloading Codex code-mode host from {download_url}");

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client for code-mode host: {e}"))?;

    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download code-mode host: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download code-mode host: HTTP {}",
            response.status()
        ));
    }
    let archive_content = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read code-mode host archive: {e}"))?;

    let host_bytes = match asset_candidate.format {
        CodexArchiveFormat::TarGz => {
            let expected_name = format!("codex-code-mode-host-{}", asset_candidate.binary_target);
            extract_tar_gz_entry_by_file_name(&archive_content, &expected_name)?
        }
        CodexArchiveFormat::Zip => {
            let expected_name =
                format!("codex-code-mode-host-{}.exe", asset_candidate.binary_target);
            extract_zip_entry_by_file_name(&archive_content, &expected_name)?
        }
    };

    if let Some((distro, codex_unix_path)) = wsl_binary {
        let parent = std::path::Path::new(codex_unix_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        let host_path = format!("{parent}/codex-code-mode-host");
        crate::platform::wsl_write_bytes(distro, &host_path, &host_bytes)
            .map_err(|e| format!("Failed to write code-mode host into WSL: {e}"))?;
        crate::platform::wsl_chmod_exec(distro, &host_path)?;
        log::info!("Installed Codex code-mode host at WSL:{host_path}");
        return Ok(());
    }

    let cli_dir = host_cli_dir
        .ok_or_else(|| "Missing host CLI directory for code-mode host install".to_string())?;
    let host_path = cli_dir.join(CODE_MODE_HOST_BINARY_NAME);
    crate::platform::write_binary_file(&host_path, &host_bytes)
        .map_err(|e| format!("Failed to write code-mode host: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&host_path)
            .map_err(|e| format!("Failed to get code-mode host metadata: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&host_path, perms)
            .map_err(|e| format!("Failed to set code-mode host permissions: {e}"))?;
    }
    log::info!("Installed Codex code-mode host at {:?}", host_path);
    Ok(())
}

/// Extract a single file from a zip by exact file name (basename match).
fn extract_zip_entry_by_file_name(
    archive_content: &[u8],
    expected_name: &str,
) -> Result<Vec<u8>, String> {
    use std::io::{Cursor, Read};

    let cursor = Cursor::new(archive_content);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let name = file.name().to_string();
        let file_name = std::path::Path::new(&name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if file_name == expected_name {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|e| format!("Failed to read zip entry '{expected_name}': {e}"))?;
            return Ok(bytes);
        }
    }

    Err(format!("File '{expected_name}' not found in zip archive"))
}

/// Windows helper binaries that Codex expects next to `codex.exe`.
///
/// Codex resolves these via `current_exe()`'s directory (or
/// `codex-resources/`). Jean-managed installs must ship them or sandboxed
/// `shell_command` / `apply_patch` fail with "windows sandbox: spawn setup refresh".
const WINDOWS_CODEX_HELPER_NAMES: &[&str] = &[
    "codex-windows-sandbox-setup.exe",
    "codex-command-runner.exe",
];

#[derive(Debug, Clone)]
struct WindowsHelperBinary {
    file_name: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
struct WindowsCodexExtract {
    main_binary: Vec<u8>,
    helpers: Vec<WindowsHelperBinary>,
}

/// Extract the main Codex binary and Windows sandbox helpers from a release zip.
///
/// The zip contains:
/// - `codex-{target}.exe` — main CLI (written as `codex.exe`)
/// - `codex-windows-sandbox-setup.exe` — elevated/unelevated sandbox setup
/// - `codex-command-runner.exe` — sandboxed command host
fn extract_windows_codex_zip(
    archive_content: &[u8],
    target: &str,
) -> Result<WindowsCodexExtract, String> {
    use std::io::{Cursor, Read};

    let cursor = Cursor::new(archive_content);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip archive: {e}"))?;

    let expected_name = format!("codex-{target}.exe");
    let mut main_binary: Option<Vec<u8>> = None;
    let mut helpers: Vec<WindowsHelperBinary> = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;

        let Some(name) = file.enclosed_name().and_then(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
        }) else {
            continue;
        };

        let is_main = name == expected_name;
        let is_helper = WINDOWS_CODEX_HELPER_NAMES
            .iter()
            .any(|helper| name.eq_ignore_ascii_case(helper));

        if !is_main && !is_helper {
            continue;
        }

        let mut content = Vec::new();
        file.read_to_end(&mut content)
            .map_err(|e| format!("Failed to read '{name}' from archive: {e}"))?;

        if is_main {
            main_binary = Some(content);
        } else {
            // Normalize helper file names so Codex's exact lookups succeed.
            let file_name = WINDOWS_CODEX_HELPER_NAMES
                .iter()
                .find(|helper| name.eq_ignore_ascii_case(helper))
                .map(|s| (*s).to_string())
                .unwrap_or(name);
            helpers.push(WindowsHelperBinary {
                file_name,
                bytes: content,
            });
        }
    }

    let main_binary = main_binary
        .ok_or_else(|| format!("Codex binary '{expected_name}' not found in zip archive"))?;

    if helpers.is_empty() {
        log::warn!(
            "Codex Windows zip did not include sandbox helpers ({}); sandboxed tools may fail until helpers are present",
            WINDOWS_CODEX_HELPER_NAMES.join(", ")
        );
    } else {
        log::debug!(
            "Extracted {} Windows Codex helper(s): {}",
            helpers.len(),
            helpers
                .iter()
                .map(|h| h.file_name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    Ok(WindowsCodexExtract {
        main_binary,
        helpers,
    })
}

/// Back-compat helper used by tests that only care about the main binary.
#[cfg(test)]
fn extract_zip_binary_bytes(archive_content: &[u8], target: &str) -> Result<Vec<u8>, String> {
    Ok(extract_windows_codex_zip(archive_content, target)?.main_binary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn make_test_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            zip.start_file(*name, options).expect("start zip entry");
            zip.write_all(bytes).expect("write zip entry");
        }
        zip.finish().expect("finish zip").into_inner()
    }

    #[test]
    fn bwrap_asset_candidates_for_linux_musl_targets() {
        let x64 = bwrap_asset_candidates("x86_64-unknown-linux-musl");
        assert_eq!(
            x64.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec![
                "bwrap-x86_64-unknown-linux-musl.tar.gz",
                "bwrap-x86_64-unknown-linux-gnu.tar.gz",
            ]
        );
        let arm = bwrap_asset_candidates("aarch64-unknown-linux-musl");
        assert_eq!(
            arm.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec![
                "bwrap-aarch64-unknown-linux-musl.tar.gz",
                "bwrap-aarch64-unknown-linux-gnu.tar.gz",
            ]
        );
        assert!(bwrap_asset_candidates("aarch64-apple-darwin").is_empty());
        assert!(bwrap_asset_candidates("x86_64-pc-windows-msvc").is_empty());
    }

    #[test]
    fn code_mode_host_asset_candidates_for_common_targets() {
        let linux = code_mode_host_asset_candidates("aarch64-unknown-linux-musl");
        assert_eq!(
            linux.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec![
                "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
                "codex-code-mode-host-aarch64-unknown-linux-gnu.tar.gz",
            ]
        );
        assert!(linux.iter().all(|c| c.format == CodexArchiveFormat::TarGz));

        let mac = code_mode_host_asset_candidates("aarch64-apple-darwin");
        assert_eq!(
            mac.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["codex-code-mode-host-aarch64-apple-darwin.tar.gz"]
        );

        let win = code_mode_host_asset_candidates("x86_64-pc-windows-msvc");
        assert_eq!(
            win.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["codex-code-mode-host-x86_64-pc-windows-msvc.exe.zip"]
        );
        assert!(win.iter().all(|c| c.format == CodexArchiveFormat::Zip));
    }

    #[test]
    fn code_mode_host_is_required_from_codex_0_147() {
        assert!(!codex_requires_code_mode_host("0.146.1"));
        assert!(codex_requires_code_mode_host("0.147.0"));
        assert!(codex_requires_code_mode_host("0.148.0-beta.1"));
        assert!(codex_requires_code_mode_host("1.0.0"));
        assert!(!codex_requires_code_mode_host("unknown"));
    }

    #[test]
    fn extract_zip_entry_by_file_name_finds_host() {
        let zip_bytes = make_test_zip(&[
            (
                "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
                b"HOST_BYTES",
            ),
            ("README.txt", b"ignore"),
        ]);
        let extracted = extract_zip_entry_by_file_name(
            &zip_bytes,
            "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
        )
        .expect("extract host");
        assert_eq!(extracted, b"HOST_BYTES");
    }

    #[test]
    fn bubblewrap_install_hint_mentions_package_manager() {
        let hint = bubblewrap_install_hint();
        assert!(hint.to_lowercase().contains("bubblewrap"));
        assert!(
            hint.contains("apt")
                || hint.contains("dnf")
                || hint.contains("pacman")
                || hint.contains("package manager")
        );
    }

    #[test]
    fn extract_tar_gz_entry_by_file_name_finds_bwrap() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use tar::Builder;

        let mut archive_buf = Vec::new();
        {
            let enc = GzEncoder::new(&mut archive_buf, Compression::none());
            let mut builder = Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            let data = b"BWRAP_BYTES";
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    "bwrap-aarch64-unknown-linux-musl",
                    data.as_slice(),
                )
                .expect("append");
            builder
                .into_inner()
                .expect("finish tar")
                .finish()
                .expect("gzip");
        }

        let extracted =
            extract_tar_gz_entry_by_file_name(&archive_buf, "bwrap-aarch64-unknown-linux-musl")
                .expect("extract bwrap");
        assert_eq!(extracted, b"BWRAP_BYTES");
    }

    #[test]
    fn extract_windows_codex_zip_includes_sandbox_helpers() {
        let zip_bytes = make_test_zip(&[
            ("codex-x86_64-pc-windows-msvc.exe", b"MAIN"),
            ("codex-windows-sandbox-setup.exe", b"SETUP"),
            ("codex-command-runner.exe", b"RUNNER"),
            ("README.txt", b"ignore me"),
        ]);

        let extracted =
            extract_windows_codex_zip(&zip_bytes, "x86_64-pc-windows-msvc").expect("extract");

        assert_eq!(extracted.main_binary, b"MAIN");
        let names: Vec<&str> = extracted
            .helpers
            .iter()
            .map(|h| h.file_name.as_str())
            .collect();
        assert!(names.contains(&"codex-windows-sandbox-setup.exe"));
        assert!(names.contains(&"codex-command-runner.exe"));
        assert_eq!(
            extracted
                .helpers
                .iter()
                .find(|h| h.file_name == "codex-windows-sandbox-setup.exe")
                .map(|h| h.bytes.as_slice()),
            Some(b"SETUP".as_slice())
        );
        assert_eq!(
            extracted
                .helpers
                .iter()
                .find(|h| h.file_name == "codex-command-runner.exe")
                .map(|h| h.bytes.as_slice()),
            Some(b"RUNNER".as_slice())
        );
    }

    #[test]
    fn extract_windows_codex_zip_requires_main_binary() {
        let zip_bytes = make_test_zip(&[("codex-windows-sandbox-setup.exe", b"SETUP")]);
        let err = extract_windows_codex_zip(&zip_bytes, "x86_64-pc-windows-msvc")
            .expect_err("missing main binary");
        assert!(err.contains("codex-x86_64-pc-windows-msvc.exe"));
    }

    #[test]
    fn extract_windows_codex_zip_tolerates_missing_helpers() {
        let zip_bytes = make_test_zip(&[("codex-x86_64-pc-windows-msvc.exe", b"MAIN")]);
        let extracted =
            extract_windows_codex_zip(&zip_bytes, "x86_64-pc-windows-msvc").expect("extract");
        assert_eq!(extracted.main_binary, b"MAIN");
        assert!(extracted.helpers.is_empty());
    }

    #[test]
    fn codex_auth_paths_prefer_wsl_home_when_wsl_binary_is_unix_path() {
        let paths = build_codex_auth_paths(
            None,
            Some(PathBuf::from(r"C:\Users\alice")),
            Some("/home/alice"),
            true,
            "Ubuntu",
            Some("/home/alice/.local/share/jean/codex-cli/codex"),
        );

        assert_eq!(
            paths[0],
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\alice\.config\codex\auth.json")
        );
        assert_eq!(
            paths[1],
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\alice\.codex\auth.json")
        );
        assert!(paths.contains(
            &PathBuf::from(r"C:\Users\alice")
                .join(".codex")
                .join("auth.json")
        ));
    }

    #[test]
    fn codex_auth_paths_use_host_paths_when_wsl_binary_is_not_unix_path() {
        let paths = build_codex_auth_paths(
            None,
            Some(PathBuf::from(r"C:\Users\alice")),
            Some("/home/alice"),
            true,
            "Ubuntu",
            Some(r"C:\Users\alice\AppData\Local\jean\codex-cli\codex.exe"),
        );

        assert_eq!(
            paths,
            vec![
                PathBuf::from(r"C:\Users\alice")
                    .join(".config")
                    .join("codex")
                    .join("auth.json"),
                PathBuf::from(r"C:\Users\alice")
                    .join(".codex")
                    .join("auth.json"),
            ]
        );
    }

    #[test]
    fn codex_asset_candidates_use_musl_for_linux_x64() {
        assert_eq!(
            codex_asset_name_candidates("x86_64-unknown-linux-musl"),
            vec![
                "codex-x86_64-unknown-linux-musl.tar.gz".to_string(),
                "codex-x86_64-unknown-linux-gnu.tar.gz".to_string(),
            ]
        );
    }

    #[test]
    fn codex_asset_candidates_use_musl_for_linux_arm64() {
        assert_eq!(
            codex_asset_name_candidates("aarch64-unknown-linux-musl"),
            vec![
                "codex-aarch64-unknown-linux-musl.tar.gz".to_string(),
                "codex-aarch64-unknown-linux-gnu.tar.gz".to_string(),
            ]
        );
    }

    #[test]
    fn codex_release_asset_filter_accepts_matching_platform_asset_only() {
        let releases = vec![
            GitHubRelease {
                tag_name: "rust-v0.130.0".to_string(),
                published_at: "2026-05-08T23:09:55Z".to_string(),
                prerelease: false,
                assets: vec![GitHubAsset {
                    name: "codex-x86_64-unknown-linux-musl.tar.gz".to_string(),
                    browser_download_url: "https://example.com/codex-linux-musl.tar.gz".to_string(),
                }],
            },
            GitHubRelease {
                tag_name: "rust-v0.129.0".to_string(),
                published_at: "2026-05-01T23:09:55Z".to_string(),
                prerelease: false,
                assets: vec![GitHubAsset {
                    name: "codex-aarch64-apple-darwin.tar.gz".to_string(),
                    browser_download_url: "https://example.com/codex-mac.tar.gz".to_string(),
                }],
            },
        ];

        let versions = codex_versions_from_releases(
            releases,
            &codex_asset_name_candidates("x86_64-unknown-linux-musl"),
        );

        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].version, "0.130.0");
        assert_eq!(versions[0].tag_name, "rust-v0.130.0");
    }

    #[test]
    fn codex_release_asset_lookup_prefers_first_matching_candidate() {
        let release = GitHubRelease {
            tag_name: "rust-v0.130.0".to_string(),
            published_at: "2026-05-08T23:09:55Z".to_string(),
            prerelease: false,
            assets: vec![
                GitHubAsset {
                    name: "codex-x86_64-unknown-linux-gnu.tar.gz".to_string(),
                    browser_download_url: "https://example.com/codex-linux-gnu.tar.gz".to_string(),
                },
                GitHubAsset {
                    name: "codex-x86_64-unknown-linux-musl.tar.gz".to_string(),
                    browser_download_url: "https://example.com/codex-linux-musl.tar.gz".to_string(),
                },
            ],
        };

        let url = find_matching_asset_url(
            &release,
            &codex_asset_name_candidates("x86_64-unknown-linux-musl"),
        );

        assert_eq!(
            url,
            Some("https://example.com/codex-linux-musl.tar.gz".to_string())
        );
    }

    #[test]
    fn latest_codex_version_skips_releases_without_platform_asset() {
        let releases = vec![
            GitHubRelease {
                tag_name: "rust-v0.131.0".to_string(),
                published_at: "2026-05-15T23:09:55Z".to_string(),
                prerelease: false,
                assets: vec![GitHubAsset {
                    name: "codex-aarch64-apple-darwin.tar.gz".to_string(),
                    browser_download_url: "https://example.com/codex-mac.tar.gz".to_string(),
                }],
            },
            GitHubRelease {
                tag_name: "rust-v0.130.0".to_string(),
                published_at: "2026-05-08T23:09:55Z".to_string(),
                prerelease: false,
                assets: vec![GitHubAsset {
                    name: "codex-x86_64-unknown-linux-musl.tar.gz".to_string(),
                    browser_download_url: "https://example.com/codex-linux-musl.tar.gz".to_string(),
                }],
            },
        ];

        let version = latest_codex_version_from_releases(
            releases,
            &codex_asset_name_candidates("x86_64-unknown-linux-musl"),
        );

        assert_eq!(version, Some("0.130.0".to_string()));
    }

    #[test]
    fn latest_codex_version_uses_wsl_linux_target_for_asset_filtering() {
        let releases = vec![
            GitHubRelease {
                tag_name: "rust-v0.131.0".to_string(),
                published_at: "2026-05-15T23:09:55Z".to_string(),
                prerelease: false,
                assets: vec![GitHubAsset {
                    name: "codex-x86_64-pc-windows-msvc.exe.zip".to_string(),
                    browser_download_url: "https://example.com/codex-windows.zip".to_string(),
                }],
            },
            GitHubRelease {
                tag_name: "rust-v0.130.0".to_string(),
                published_at: "2026-05-08T23:09:55Z".to_string(),
                prerelease: false,
                assets: vec![GitHubAsset {
                    name: "codex-x86_64-unknown-linux-musl.tar.gz".to_string(),
                    browser_download_url: "https://example.com/codex-linux-musl.tar.gz".to_string(),
                }],
            },
        ];

        let target = resolve_codex_runtime_target_for_wsl_arch(true, Some("linux-x64")).unwrap();
        let version =
            latest_codex_version_from_releases(releases, &codex_asset_name_candidates(target));

        assert_eq!(target, "x86_64-unknown-linux-musl");
        assert_eq!(version, Some("0.130.0".to_string()));
    }

    #[test]
    fn app_server_rate_limits_map_to_usage_snapshot() {
        let params = serde_json::json!({
            "rateLimits": {
                "limitId": "codex",
                "limitName": null,
                "primary": {
                    "usedPercent": 23,
                    "windowDurationMins": 300,
                    "resetsAt": 1_771_456_509
                },
                "secondary": {
                    "usedPercent": 15,
                    "windowDurationMins": 10080,
                    "resetsAt": 1_772_023_891
                },
                "credits": {
                    "hasCredits": true,
                    "unlimited": false,
                    "balance": "12.5"
                },
                "planType": "plus",
                "rateLimitReachedType": "rate_limit_reached"
            }
        });

        let snapshot = codex_usage_snapshot_from_app_server_rate_limits(&params, 1_771_450_000)
            .expect("rate limits snapshot should parse");

        assert_eq!(snapshot.plan_type.as_deref(), Some("plus"));
        assert_eq!(
            snapshot.session.as_ref().map(|w| w.used_percent),
            Some(23.0)
        );
        assert_eq!(
            snapshot.session.as_ref().and_then(|w| w.resets_at),
            Some(1_771_456_509)
        );
        assert_eq!(
            snapshot
                .session
                .as_ref()
                .and_then(|w| w.limit_window_seconds),
            Some(18_000)
        );
        assert_eq!(snapshot.weekly.as_ref().map(|w| w.used_percent), Some(15.0));
        assert_eq!(
            snapshot
                .weekly
                .as_ref()
                .and_then(|w| w.limit_window_seconds),
            Some(604_800)
        );
        assert_eq!(snapshot.credits_remaining, Some(12.5));
        assert_eq!(
            snapshot.rate_limit_reached_type.as_deref(),
            Some("rate_limit_reached")
        );
        assert_eq!(snapshot.fetched_at, 1_771_450_000);
    }
}
