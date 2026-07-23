//! Host self-update for Web Access / remote clients (user-triggered only).
//!
//! Web Access clients call `check_server_update` / `apply_server_update`.
//! There is no background install — the operator must confirm via UI.
//!
//! Two host channels:
//! - **Server** (`JEAN_HEADLESS=1`): fetch `server-latest.json` → download arch
//!   tarball → verify SHA-256 → atomic binary replace → systemd restart or re-exec.
//!   Docker/containers are skipped — update the image instead of the binary.
//! - **Desktop** (native Jean hosting Web Access): fetch desktop `latest.json`
//!   and report availability. Apply emits `host:install-desktop-update` so the
//!   native shell runs Tauri's updater (web clients cannot install installers).

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tar::Archive;
use tauri::AppHandle;

use crate::http_server::EmitExt;

const MANIFEST_URL: &str =
    "https://github.com/coollabsio/jean/releases/latest/download/server-latest.json";
const DESKTOP_MANIFEST_URL: &str =
    "https://github.com/coollabsio/jean/releases/latest/download/latest.json";
const USER_AGENT: &str = "jean-server-updater";
const RESTART_GRACE: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAsset {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerUpdateManifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    pub platforms: HashMap<String, PlatformAsset>,
}

/// Which host update channel produced the status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum HostUpdateChannel {
    /// Headless `jean-server` binary (server-latest.json).
    #[default]
    Server,
    /// Desktop Jean hosting Web Access (latest.json + native Tauri install).
    Desktop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerUpdateStatus {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    /// False in containers, when the binary is not writable, or when only the
    /// native desktop shell can install (still true when desktop can be asked).
    pub can_update: bool,
    pub reason: Option<String>,
    #[serde(default)]
    pub channel: HostUpdateChannel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerUpdateApplyResult {
    pub success: bool,
    pub version: String,
    pub message: String,
    pub restart_scheduled: bool,
}

/// Desktop updater manifest (`latest.json`) — version check only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateManifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Check GitHub for a newer host release. Does not install anything.
///
/// Headless hosts use `server-latest.json`. Desktop hosts (Web Access on the
/// native app, including macOS/Windows) use desktop `latest.json` so web
/// clients can show the same update badge/modal as the native shell.
pub async fn check_server_update(_app: &AppHandle) -> Result<ServerUpdateStatus, String> {
    if is_headless_host() {
        check_headless_server_update().await
    } else {
        check_desktop_host_update().await
    }
}

async fn check_headless_server_update() -> Result<ServerUpdateStatus, String> {
    // Must use the host binary version (jean-server), not jean-core's crate version.
    let current_version = crate::app_version().to_string();
    let eligibility = update_eligibility();
    if let Some(reason) = &eligibility.block_reason {
        if eligibility.hard_block {
            return Ok(ServerUpdateStatus {
                update_available: false,
                current_version,
                latest_version: None,
                notes: None,
                can_update: false,
                reason: Some(reason.clone()),
                channel: HostUpdateChannel::Server,
            });
        }
    }

    let manifest = fetch_manifest(MANIFEST_URL).await?;
    let latest = normalize_version(&manifest.version);
    let available = is_newer_version(&latest, &current_version);

    let mut can_update = eligibility.can_update;
    let mut reason = eligibility.block_reason;
    if available {
        let platform = current_platform_key()?;
        if !manifest.platforms.contains_key(platform) {
            can_update = false;
            reason = Some(format!(
                "No update asset for platform '{platform}' in server-latest.json"
            ));
        }
    }

    Ok(ServerUpdateStatus {
        update_available: available,
        current_version,
        latest_version: Some(latest),
        notes: manifest.notes,
        can_update,
        reason,
        channel: HostUpdateChannel::Server,
    })
}

async fn check_desktop_host_update() -> Result<ServerUpdateStatus, String> {
    let current_version = crate::app_version().to_string();
    let manifest = fetch_desktop_manifest().await?;
    let latest = normalize_version(&manifest.version);
    let available = is_newer_version(&latest, &current_version);

    Ok(ServerUpdateStatus {
        update_available: available,
        current_version,
        latest_version: Some(latest),
        notes: manifest.notes.filter(|n| !n.trim().is_empty()),
        // Install is performed by the native shell via host:install-desktop-update.
        can_update: available,
        reason: if available {
            Some(
                "Install runs on the host Jean desktop app (native updater)".to_string(),
            )
        } else {
            None
        },
        channel: HostUpdateChannel::Desktop,
    })
}

/// Download, verify, install, and schedule restart. Must be invoked by the user.
///
/// On desktop hosts, asks the native shell to run Tauri's updater instead of
/// replacing the binary in-process.
pub async fn apply_server_update(app: AppHandle) -> Result<ServerUpdateApplyResult, String> {
    if !is_headless_host() {
        return apply_desktop_host_update(app).await;
    }

    let eligibility = update_eligibility();
    if !eligibility.can_update {
        return Err(eligibility
            .block_reason
            .unwrap_or_else(|| "Server update is not available on this host".to_string()));
    }

    let running = crate::chat::registry::get_running_sessions();
    if !running.is_empty() {
        return Err(format!(
            "Cannot update jean-server while {} session{} running. Stop active sessions first.",
            running.len(),
            if running.len() == 1 { " is" } else { "s are" }
        ));
    }

    let manifest = fetch_manifest(MANIFEST_URL).await?;
    let latest = normalize_version(&manifest.version);
    let current = crate::app_version();
    if !is_newer_version(&latest, current) {
        return Ok(ServerUpdateApplyResult {
            success: true,
            version: current.to_string(),
            message: "Already running the latest version".to_string(),
            restart_scheduled: false,
        });
    }

    let platform = current_platform_key()?;
    let asset = manifest.platforms.get(platform).ok_or_else(|| {
        format!("No update asset for platform '{platform}' in server-latest.json")
    })?;

    let _ = app.emit_all(
        "server:update-progress",
        &serde_json::json!({ "stage": "downloading", "version": latest }),
    );

    let archive = download_bytes(&asset.url).await?;
    verify_sha256(&archive, &asset.sha256)?;

    let _ = app.emit_all(
        "server:update-progress",
        &serde_json::json!({ "stage": "installing", "version": latest }),
    );

    let binary = extract_server_binary(&archive)?;
    install_binary_atomically(&binary)?;

    let _ = app.emit_all(
        "server:update-progress",
        &serde_json::json!({ "stage": "restarting", "version": latest }),
    );

    schedule_restart();

    Ok(ServerUpdateApplyResult {
        success: true,
        version: latest.clone(),
        message: format!("Installed jean-server {latest}; restart scheduled"),
        restart_scheduled: true,
    })
}

async fn apply_desktop_host_update(app: AppHandle) -> Result<ServerUpdateApplyResult, String> {
    let running = crate::chat::registry::get_running_sessions();
    if !running.is_empty() {
        return Err(format!(
            "Cannot update Jean while {} session{} running. Stop active sessions first.",
            running.len(),
            if running.len() == 1 { " is" } else { "s are" }
        ));
    }

    let status = check_desktop_host_update().await?;
    let latest = status
        .latest_version
        .clone()
        .unwrap_or_else(|| crate::app_version().to_string());

    if !status.update_available {
        return Ok(ServerUpdateApplyResult {
            success: true,
            version: status.current_version,
            message: "Already running the latest version".to_string(),
            restart_scheduled: false,
        });
    }

    // Native App.tsx listens and runs @tauri-apps/plugin-updater.
    app.emit_all(
        "host:install-desktop-update",
        &serde_json::json!({ "version": latest }),
    )?;

    Ok(ServerUpdateApplyResult {
        success: true,
        version: latest.clone(),
        message: format!(
            "Update {latest} requested on the host desktop app; it will download and install there"
        ),
        restart_scheduled: false,
    })
}

/// True when running the headless `jean-server` binary (`JEAN_HEADLESS=1`).
fn is_headless_host() -> bool {
    match std::env::var("JEAN_HEADLESS") {
        Ok(value) => {
            let v = value.trim();
            v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    }
}

async fn fetch_manifest(url: &str) -> Result<ServerUpdateManifest, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch server update manifest: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch server update manifest: HTTP {}",
            response.status()
        ));
    }

    response
        .json::<ServerUpdateManifest>()
        .await
        .map_err(|e| format!("Invalid server update manifest: {e}"))
}

async fn fetch_desktop_manifest() -> Result<DesktopUpdateManifest, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(DESKTOP_MANIFEST_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch desktop update manifest: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch desktop update manifest: HTTP {}",
            response.status()
        ));
    }

    response
        .json::<DesktopUpdateManifest>()
        .await
        .map_err(|e| format!("Invalid desktop update manifest: {e}"))
}

async fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download server update: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download server update: HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read server update bytes: {e}"))?;
    Ok(bytes.to_vec())
}

fn verify_sha256(data: &[u8], expected: &str) -> Result<(), String> {
    let expected = expected.trim().to_lowercase();
    // Accept "hash  filename" lines from shasum -a 256
    let expected_hash = expected
        .split_whitespace()
        .next()
        .unwrap_or(&expected)
        .to_string();

    let actual = format!("{:x}", Sha256::digest(data));
    if actual != expected_hash {
        return Err(format!(
            "Server update checksum mismatch (expected {expected_hash}, got {actual})"
        ));
    }
    Ok(())
}

fn extract_server_binary(archive_content: &[u8]) -> Result<Vec<u8>, String> {
    let cursor = Cursor::new(archive_content);
    let decoder = GzDecoder::new(cursor);
    let mut archive = Archive::new(decoder);

    for entry in archive
        .entries()
        .map_err(|e| format!("Failed to read server update tar entries: {e}"))?
    {
        let mut entry =
            entry.map_err(|e| format!("Failed to read server update tar entry: {e}"))?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| format!("Failed to read tar entry path: {e}"))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        // Release assets are named jean-server-linux-amd64 / jean-server-linux-arm64
        // Local builds are plain jean-server.
        if name == "jean-server" || name.starts_with("jean-server-linux-") {
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|e| format!("Failed to read jean-server from archive: {e}"))?;
            if data.is_empty() {
                return Err("Extracted jean-server binary is empty".to_string());
            }
            return Ok(data);
        }
    }

    Err("jean-server binary not found inside update archive".to_string())
}

fn install_binary_atomically(binary: &[u8]) -> Result<(), String> {
    let target = current_executable_path()?;
    let parent = target
        .parent()
        .ok_or_else(|| "Cannot determine install directory for jean-server".to_string())?;

    let temp = parent.join(format!(
        "{}.new-{}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("jean-server"),
        std::process::id()
    ));

    if let Err(error) = std::fs::write(&temp, binary) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Failed to write update binary: {error}"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&temp)
            .map_err(|e| format!("Failed to read temp binary metadata: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        if let Err(error) = std::fs::set_permissions(&temp, perms) {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("Failed to set update binary permissions: {error}"));
        }
    }

    if let Err(error) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "Failed to replace jean-server binary at {}: {error}",
            target.display()
        ));
    }

    Ok(())
}

fn schedule_restart() {
    tokio::spawn(async {
        tokio::time::sleep(RESTART_GRACE).await;
        if let Err(error) = restart_server_process() {
            log::error!("Failed to restart jean-server after update: {error}");
            // Last resort: exit and hope a process supervisor restarts us.
            std::process::exit(0);
        }
    });
}

fn restart_server_process() -> Result<(), String> {
    if try_systemd_restart() {
        // Current process will be stopped by systemd shortly.
        std::process::exit(0);
    }

    let exe = current_executable_path()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut command = std::process::Command::new(&exe);
    command.args(&args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        Err(format!("Failed to re-exec jean-server: {error}"))
    }
    #[cfg(not(unix))]
    {
        command
            .spawn()
            .map_err(|e| format!("Failed to spawn updated jean-server: {e}"))?;
        std::process::exit(0);
    }
}

fn try_systemd_restart() -> bool {
    let service = std::env::var("JEAN_SERVER_SERVICE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "jean-server.service".to_string());

    let show = std::process::Command::new("systemctl")
        .args(["show", "--property=LoadState", "--value", &service])
        .output();

    let Ok(output) = show else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let load_state = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if load_state != "loaded" {
        return false;
    }

    let restart = std::process::Command::new("systemctl")
        .args(["restart", "--no-block", &service])
        .status();

    matches!(restart, Ok(status) if status.success())
}

#[derive(Debug, Clone)]
struct Eligibility {
    can_update: bool,
    hard_block: bool,
    block_reason: Option<String>,
}

fn update_eligibility() -> Eligibility {
    if !cfg!(target_os = "linux") {
        return Eligibility {
            can_update: false,
            hard_block: true,
            block_reason: Some("Server update is only supported on Linux".to_string()),
        };
    }

    if is_containerized() {
        return Eligibility {
            can_update: false,
            hard_block: true,
            block_reason: Some(
                "Running in a container; update the jean-server image instead".to_string(),
            ),
        };
    }

    match current_executable_path() {
        Ok(path) => {
            if !path_is_writable(&path) {
                return Eligibility {
                    can_update: false,
                    hard_block: false,
                    block_reason: Some(format!(
                        "Cannot write to jean-server binary at {}",
                        path.display()
                    )),
                };
            }
        }
        Err(error) => {
            return Eligibility {
                can_update: false,
                hard_block: false,
                block_reason: Some(error),
            };
        }
    }

    if current_platform_key().is_err() {
        return Eligibility {
            can_update: false,
            hard_block: true,
            block_reason: Some("Unsupported CPU architecture for server updates".to_string()),
        };
    }

    Eligibility {
        can_update: true,
        hard_block: false,
        block_reason: None,
    }
}

fn path_is_writable(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let probe = parent.join(format!(".jean-update-probe-{}", std::process::id()));
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn current_executable_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("Failed to resolve jean-server path: {e}"))
}

fn current_platform_key() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("linux-amd64"),
        "aarch64" => Ok("linux-arm64"),
        other => Err(format!(
            "Unsupported architecture for server updates: {other}"
        )),
    }
}

fn is_containerized() -> bool {
    if Path::new("/.dockerenv").exists() {
        return true;
    }
    if std::env::var_os("container").is_some() {
        return true;
    }
    if let Ok(cgroup) = std::fs::read_to_string("/proc/1/cgroup") {
        if cgroup.contains("docker")
            || cgroup.contains("containerd")
            || cgroup.contains("kubepods")
            || cgroup.contains("podman")
        {
            return true;
        }
    }
    false
}

fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_string()
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    compare_versions(candidate, current) > 0
}

fn compare_versions(a: &str, b: &str) -> i32 {
    let a_parts = version_parts(a);
    let b_parts = version_parts(b);
    let len = a_parts.len().max(b_parts.len());
    for i in 0..len {
        let av = a_parts.get(i).copied().unwrap_or(0);
        let bv = b_parts.get(i).copied().unwrap_or(0);
        if av != bv {
            return if av > bv { 1 } else { -1 };
        }
    }
    0
}

fn version_parts(version: &str) -> Vec<u32> {
    let cleaned = normalize_version(version);
    let main = cleaned.split('-').next().unwrap_or(&cleaned);
    main.split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use tar::Builder;

    #[test]
    fn compares_semver_versions() {
        assert!(is_newer_version("0.1.68", "0.1.67"));
        assert!(is_newer_version("v0.2.0", "0.1.99"));
        assert!(!is_newer_version("0.1.67", "0.1.67"));
        assert!(!is_newer_version("0.1.66", "0.1.67"));
    }

    #[test]
    fn current_version_uses_host_override_not_library_crate() {
        // Regression: self-update used env!("CARGO_PKG_VERSION") from jean-core
        // (e.g. 0.1.67) while jean-server was already 0.1.68, so "update available"
        // never cleared after install.
        crate::set_app_version("9.9.9-host");
        assert_eq!(crate::app_version(), "9.9.9-host");
    }

    #[test]
    fn normalizes_sha256_lines() {
        let data = b"hello";
        let hash = format!("{:x}", Sha256::digest(data));
        assert!(verify_sha256(data, &hash).is_ok());
        assert!(verify_sha256(data, &format!("{hash}  jean-server.tar.gz")).is_ok());
        assert!(verify_sha256(data, "deadbeef").is_err());
    }

    #[test]
    fn extracts_jean_server_from_tar_gz() {
        let mut raw = Vec::new();
        {
            let enc = GzEncoder::new(&mut raw, Compression::default());
            let mut builder = Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            let payload = b"#!/bin/sh\necho jean-server\n";
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "jean-server-linux-amd64", payload.as_slice())
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let extracted = extract_server_binary(&raw).unwrap();
        assert_eq!(extracted, b"#!/bin/sh\necho jean-server\n");
    }

    #[test]
    fn platform_key_is_linux_only_shape() {
        let key = current_platform_key();
        if cfg!(target_os = "linux") {
            let key = key.expect("linux arch should map");
            assert!(key == "linux-amd64" || key == "linux-arm64");
        }
    }

    #[test]
    fn manifest_deserializes_camel_case() {
        let json = r#"{
          "version": "0.1.70",
          "notes": "server fixes",
          "platforms": {
            "linux-amd64": {
              "url": "https://example.com/a.tar.gz",
              "sha256": "abc"
            }
          }
        }"#;
        let manifest: ServerUpdateManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.version, "0.1.70");
        assert_eq!(
            manifest.platforms["linux-amd64"].url,
            "https://example.com/a.tar.gz"
        );
    }

    #[test]
    fn desktop_manifest_deserializes_version() {
        let json = r#"{
          "version": "0.1.70",
          "notes": "",
          "pub_date": "2026-07-20T10:49:34.137Z",
          "platforms": {
            "darwin-aarch64": {
              "signature": "sig",
              "url": "https://example.com/Jean.app.tar.gz"
            }
          }
        }"#;
        let manifest: DesktopUpdateManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.version, "0.1.70");
    }

    #[test]
    fn status_defaults_channel_to_server_for_back_compat() {
        let json = r#"{
          "updateAvailable": true,
          "currentVersion": "0.1.0",
          "latestVersion": "0.1.1",
          "canUpdate": true
        }"#;
        let status: ServerUpdateStatus = serde_json::from_str(json).unwrap();
        assert_eq!(status.channel, HostUpdateChannel::Server);
    }

    #[test]
    fn headless_env_detection() {
        // Do not assert global env permanently — only that the helper is pure
        // logic over JEAN_HEADLESS when set for this process (may already be set).
        let before = std::env::var("JEAN_HEADLESS").ok();
        // SAFETY: test-only temporary env mutation in single-threaded unit test.
        unsafe {
            std::env::set_var("JEAN_HEADLESS", "1");
        }
        assert!(is_headless_host());
        unsafe {
            std::env::set_var("JEAN_HEADLESS", "false");
        }
        assert!(!is_headless_host());
        unsafe {
            match before {
                Some(value) => std::env::set_var("JEAN_HEADLESS", value),
                None => std::env::remove_var("JEAN_HEADLESS"),
            }
        }
    }
}
