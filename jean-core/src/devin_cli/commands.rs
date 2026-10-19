//! Tauri commands for Devin CLI management.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::config::{
    binary_exists, ensure_cli_dir, find_system_devin_binary, get_cli_binary_path, get_cli_dir,
    get_wsl_cli_binary_path, resolve_cli_binary,
};
use crate::http_server::EmitExt;

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const MODELS_TIMEOUT: Duration = Duration::from_secs(10);
const DEVIN_MANIFEST_URL: &str = "https://static.devin.ai/cli/current/manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevinCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevinAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevinPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevinModelInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevinReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: String,
    pub prerelease: bool,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevinInstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevinInstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestTarget {
    version: String,
    platform: String,
    arch: String,
    url: String,
    sha256: Option<String>,
    published_at: String,
    prerelease: bool,
}

struct DevinInstallTarget {
    platform: &'static str,
    arch: &'static str,
    binary_name: &'static str,
    wsl_distro: Option<String>,
}

// Run blocking process work outside the async executor. Drain both pipes while
// polling, so a large model list cannot fill a pipe and block process exit.
async fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<Option<Output>, String> {
    tokio::task::spawn_blocking(move || {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let deadline = Instant::now() + timeout;
        let (tx, rx) = std::sync::mpsc::channel();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        for (is_stdout, mut pipe) in [
            (true, Box::new(stdout) as Box<dyn Read + Send>),
            (false, Box::new(stderr) as Box<dyn Read + Send>),
        ] {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let result = pipe.read_to_end(&mut bytes).map(|_| bytes);
                let _ = tx.send((is_stdout, result));
            });
        }
        drop(tx);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {}
                Err(error) => {
                    crate::platform::kill_and_reap(&mut child);
                    return Err(error.to_string());
                }
            }
            if Instant::now() >= deadline {
                crate::platform::kill_and_reap(&mut child);
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut output = Output {
            status,
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        for _ in 0..2 {
            // A descendant can retain a pipe after the CLI exits. Keep that
            // wait bounded as well, rather than joining the reader threads.
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok((is_stdout, result)) => {
                    let bytes = result.map_err(|error| error.to_string())?;
                    if is_stdout {
                        output.stdout = bytes;
                    } else {
                        output.stderr = bytes;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Ok(None),
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(Some(output))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn auth_status_from_output(output: &Output) -> DevinAuthStatus {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // Keep JSON stdout separate from diagnostic stderr.
    let mut status = if stdout.trim().is_empty() {
        parse_auth_status(&stderr)
    } else {
        parse_auth_status(&stdout)
    };
    if !output.status.success() {
        status.authenticated = false;
        status.error = Some(if stderr.trim().is_empty() {
            "Not authenticated. Run `devin auth login`.".to_string()
        } else {
            stderr.trim().to_string()
        });
    }
    status
}

fn parse_version(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout)
        .split_whitespace()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|ch| ch == 'v' || ch.is_ascii_digit())
        })
        .map(|part| part.trim_start_matches('v').to_string())
        .filter(|part| part.chars().any(|ch| ch.is_ascii_digit()))
}

fn parse_auth_status(output: &str) -> DevinAuthStatus {
    let trimmed = output.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        let authenticated = value
            .get("authenticated")
            .or_else(|| value.get("logged_in"))
            .or_else(|| value.get("loggedIn"))
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                ["user", "email"].iter().any(|key| {
                    value.get(key).is_some_and(|identity| {
                        identity
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                            || identity
                                .as_object()
                                .is_some_and(|object| !object.is_empty())
                    })
                })
            });
        let error = value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty() && !authenticated)
            .map(ToString::to_string);
        return DevinAuthStatus {
            authenticated,
            error,
            timed_out: false,
        };
    }

    let lower = trimmed.to_lowercase();
    let authenticated = !lower.contains("not authenticated")
        && !lower.contains("not logged in")
        && !lower.contains("login required")
        && !lower.contains("not signed in")
        && !lower.contains("unauthenticated")
        && (lower.contains("authenticated")
            || lower.contains("logged in")
            || lower.contains("signed in"));
    DevinAuthStatus {
        authenticated,
        error: if authenticated || trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        },
        timed_out: false,
    }
}

fn model_from_value(id_hint: Option<&str>, value: &Value) -> Option<DevinModelInfo> {
    let id = value
        .get("model_uid")
        .or_else(|| value.get("id"))
        .or_else(|| value.get("model"))
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .or(id_hint)?;
    let label = value
        .get("label")
        .or_else(|| value.get("displayName"))
        .or_else(|| value.get("display_name"))
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .filter(|label| *label != id)
        .unwrap_or(id);
    Some(DevinModelInfo {
        id: id.to_string(),
        label: label.to_string(),
    })
}

fn parse_models_json(output: &str) -> Result<Vec<DevinModelInfo>, String> {
    let value: Value = serde_json::from_str(output)
        .map_err(|error| format!("Failed to parse Devin model list: {error}"))?;
    let source = value.get("models").unwrap_or(&value);
    let mut models = if let Some(families) = value.get("families").and_then(Value::as_array) {
        families
            .iter()
            .filter_map(|family| family.get("variants").and_then(Value::as_array))
            .flatten()
            .filter_map(|variant| model_from_value(None, variant))
            .collect::<Vec<_>>()
    } else {
        match source {
            Value::Array(items) => items
                .iter()
                .filter_map(|item| model_from_value(None, item))
                .collect::<Vec<_>>(),
            Value::Object(map) => map
                .iter()
                .filter_map(|(id, item)| model_from_value(Some(id), item))
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        }
    };
    models.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.id.cmp(&right.id))
    });
    models.dedup_by(|left, right| left.id == right.id);
    Ok(models)
}

fn target_from_value(
    version: &str,
    published_at: &str,
    prerelease: bool,
    value: &Value,
) -> Option<ManifestTarget> {
    Some(ManifestTarget {
        version: version.to_string(),
        platform: value
            .get("platform")
            .or_else(|| value.get("os"))
            .and_then(Value::as_str)?
            .to_string(),
        arch: value
            .get("arch")
            .or_else(|| value.get("architecture"))
            .and_then(Value::as_str)?
            .to_string(),
        url: value
            .get("url")
            .or_else(|| value.get("downloadUrl"))
            .and_then(Value::as_str)?
            .to_string(),
        sha256: value
            .get("sha256")
            .and_then(Value::as_str)
            .map(|checksum| checksum.to_string()),
        published_at: published_at.to_string(),
        prerelease,
    })
}

fn parse_manifest_targets(output: &str) -> Result<Vec<ManifestTarget>, String> {
    let value: Value = serde_json::from_str(output)
        .map_err(|error| format!("Failed to parse Devin manifest: {error}"))?;
    let mut targets = Vec::new();
    if let Some(versions) = value.get("versions").and_then(Value::as_array) {
        for release in versions {
            let version = release
                .get("version")
                .or_else(|| release.get("tagName"))
                .and_then(Value::as_str)
                .unwrap_or("latest");
            let published_at = release
                .get("publishedAt")
                .or_else(|| release.get("published_at"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let prerelease = release
                .get("prerelease")
                .and_then(Value::as_bool)
                .unwrap_or(version.contains('-'));
            if let Some(items) = release.get("targets").and_then(Value::as_array) {
                targets.extend(
                    items.iter().filter_map(|item| {
                        target_from_value(version, published_at, prerelease, item)
                    }),
                );
            }
        }
    } else if let Some(platforms) = value.get("platforms").and_then(Value::as_object) {
        let version = value
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("latest");
        for (triple, item) in platforms {
            let Some((platform, arch)) = platform_arch_from_devin_triple(triple) else {
                continue;
            };
            let Some(url) = item.get("url").and_then(Value::as_str) else {
                continue;
            };
            targets.push(ManifestTarget {
                version: version.to_string(),
                platform: platform.to_string(),
                arch: arch.to_string(),
                url: url.to_string(),
                sha256: item
                    .get("sha256")
                    .and_then(Value::as_str)
                    .map(|checksum| checksum.to_string()),
                published_at: String::new(),
                prerelease: version.contains('-'),
            });
        }
    } else if let Some(items) = value.get("targets").and_then(Value::as_array) {
        let version = value
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("latest");
        let published_at = value
            .get("publishedAt")
            .or_else(|| value.get("published_at"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let prerelease = value
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(version.contains('-'));
        targets.extend(
            items
                .iter()
                .filter_map(|item| target_from_value(version, published_at, prerelease, item)),
        );
    }
    Ok(targets)
}

fn platform_arch_from_devin_triple(triple: &str) -> Option<(&'static str, &'static str)> {
    let platform = if triple.contains("apple-darwin") {
        "darwin"
    } else if triple.contains("unknown-linux") {
        "linux"
    } else if triple.contains("pc-windows") {
        "windows"
    } else {
        return None;
    };
    let arch = if triple.starts_with("aarch64") {
        "arm64"
    } else if triple.starts_with("x86_64") {
        "x64"
    } else {
        return None;
    };
    Some((platform, arch))
}

fn select_manifest_target(
    targets: &[ManifestTarget],
    platform: &str,
    arch: &str,
) -> Option<ManifestTarget> {
    let normalized_arch = match arch {
        "x86_64" | "amd64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    targets
        .iter()
        .find(|target| target.platform == platform && target.arch == normalized_arch)
        .cloned()
}

fn version_sort_key(version: &str) -> Vec<u64> {
    version
        .split(['.', '-'])
        .take(3)
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

pub async fn check_devin_cli_installed(app: AppHandle) -> Result<DevinCliStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(DevinCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }
    let mut command = crate::platform::cli_command(&binary.to_string_lossy(), None);
    command.arg("--version");
    let version = run_command_with_timeout(command, AUTH_TIMEOUT)
        .await
        .ok()
        .flatten()
        .and_then(|output| {
            if output.status.success() {
                parse_version(&output.stdout)
            } else {
                None
            }
        });
    Ok(DevinCliStatus {
        installed: true,
        version,
        path: Some(binary.to_string_lossy().to_string()),
    })
}

pub async fn detect_devin_in_path(app: AppHandle) -> Result<DevinPathDetection, String> {
    let Some(binary) = find_system_devin_binary(&app) else {
        return Ok(DevinPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };
    let mut command = crate::platform::cli_command(&binary.to_string_lossy(), None);
    command.arg("--version");
    let version = run_command_with_timeout(command, AUTH_TIMEOUT)
        .await
        .ok()
        .flatten()
        .and_then(|output| {
            if output.status.success() {
                parse_version(&output.stdout)
            } else {
                None
            }
        });
    Ok(DevinPathDetection {
        found: true,
        path: Some(binary.to_string_lossy().to_string()),
        version,
        package_manager: crate::platform::detect_package_manager(&binary),
    })
}

pub async fn check_devin_cli_auth(app: AppHandle) -> Result<DevinAuthStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(DevinAuthStatus {
            authenticated: false,
            error: Some("Devin CLI not installed".to_string()),
            timed_out: false,
        });
    }
    let mut command = crate::platform::cli_command(&binary.to_string_lossy(), None);
    command.args(["auth", "status"]);
    match run_command_with_timeout(command, AUTH_TIMEOUT)
        .await
        .map_err(|error| format!("Failed to check Devin auth: {error}"))?
    {
        Some(output) => Ok(auth_status_from_output(&output)),
        None => Ok(DevinAuthStatus {
            authenticated: false,
            error: Some("Devin auth check timed out".to_string()),
            timed_out: true,
        }),
    }
}

pub async fn list_devin_models(app: AppHandle) -> Result<Vec<DevinModelInfo>, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(Vec::new());
    }
    let mut command = crate::platform::cli_command(&binary.to_string_lossy(), None);
    command.args(["models", "list", "--format", "json"]);
    let Some(output) = run_command_with_timeout(command, MODELS_TIMEOUT)
        .await
        .map_err(|error| format!("Failed to list Devin models: {error}"))?
    else {
        return Ok(Vec::new());
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }
    parse_models_json(&String::from_utf8_lossy(&output.stdout))
}

pub async fn get_available_devin_versions(
    _app: AppHandle,
) -> Result<Vec<DevinReleaseInfo>, String> {
    let install_target = devin_install_target()?;
    let manifest = fetch_manifest_text(&manifest_url_for_version(None)).await?;
    releases_for_target(&manifest, &install_target)
}

pub async fn check_devin_cli_version_exists(
    _app: AppHandle,
    version: String,
) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }
    let install_target = devin_install_target()?;
    let url = manifest_url_for_version(Some(version));
    let response = devin_http_client()?
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("Failed to check Devin CLI version: {error}"))?;
    if response.status().as_u16() == 404 {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Failed to check Devin CLI version: HTTP {}",
            response.status()
        ));
    }
    let manifest = response
        .text()
        .await
        .map_err(|error| format!("Failed to read Devin manifest: {error}"))?;
    let targets = parse_manifest_targets(&manifest)?;
    let Some(target) =
        select_manifest_target(&targets, install_target.platform, install_target.arch)
    else {
        return Ok(false);
    };
    if version == "latest" {
        return Ok(true);
    }
    Ok(target.version == version || target.version == "latest")
}

pub async fn get_devin_cli_binary_path(app: AppHandle) -> Result<String, String> {
    Ok(get_cli_binary_path(&app)?.to_string_lossy().to_string())
}

pub async fn get_devin_install_command(_app: AppHandle) -> Result<DevinInstallCommand, String> {
    if cfg!(windows) {
        Ok(DevinInstallCommand {
            command: "powershell".to_string(),
            args: vec![
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                "irm https://static.devin.ai/cli/setup.ps1 | iex".to_string(),
            ],
            description: "Install Devin CLI with the official PowerShell installer".to_string(),
        })
    } else {
        Ok(DevinInstallCommand {
            command: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                "curl -fsSL https://cli.devin.ai/install.sh | bash".to_string(),
            ],
            description: "Install Devin CLI with the official shell installer".to_string(),
        })
    }
}

pub async fn install_devin_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot install Devin CLI while {count} {} running. Please stop all active sessions first.",
            if count == 1 { "session is" } else { "sessions are" }
        ));
    }

    emit_progress(&app, "starting", "Preparing Devin CLI installation", 5);
    let install_target = devin_install_target()?;
    let requested = version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let manifest_url = manifest_url_for_version(requested);
    emit_progress(&app, "downloading", "Fetching Devin CLI release", 15);
    let manifest = fetch_manifest_text(&manifest_url).await?;
    let targets = parse_manifest_targets(&manifest)?;
    let Some(target) =
        select_manifest_target(&targets, install_target.platform, install_target.arch)
    else {
        return Err(format!(
            "Devin CLI {} has no {} {} build. Official builds cover macOS, Linux, and Windows on x64 and arm64.",
            requested.unwrap_or("latest"),
            install_target.platform,
            install_target.arch
        ));
    };
    let Some(expected_sha) = target
        .sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(
            "Devin CLI manifest is missing a sha256 checksum for this platform.".to_string(),
        );
    };

    emit_progress(&app, "downloading", "Downloading Devin CLI", 30);
    let response = devin_http_client()?
        .get(&target.url)
        .header("User-Agent", "jean-desktop")
        .send()
        .await
        .map_err(|error| format!("Failed to download Devin CLI: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download Devin CLI: HTTP {}",
            response.status()
        ));
    }
    let archive_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read Devin CLI download: {error}"))?;
    verify_sha256(&archive_bytes, expected_sha)?;

    emit_progress(&app, "extracting", "Extracting Devin CLI", 70);
    let binary_data =
        extract_devin_binary(&archive_bytes, &target.url, install_target.binary_name)?;

    if let Some(distro) = install_target.wsl_distro.as_deref() {
        let unix_path = get_wsl_cli_binary_path(distro)?;
        crate::platform::wsl_write_bytes(distro, &unix_path, &binary_data)
            .map_err(|error| format!("Failed to write Devin CLI into WSL: {error}"))?;
        crate::platform::wsl_chmod_exec(distro, &unix_path)?;
        verify_installed_binary(&unix_path).await?;
        #[cfg(windows)]
        crate::expose_managed_cli_in_wsl(distro, "devin", &unix_path);
        emit_progress(&app, "complete", "Devin CLI installed", 100);
        return Ok(());
    }

    let cli_dir = ensure_cli_dir(&app)?;
    let binary_path = cli_dir.join(install_target.binary_name);
    crate::platform::write_binary_file(&binary_path, &binary_data)
        .map_err(|error| format!("Failed to write Devin CLI: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&binary_path)
            .map_err(|error| format!("Failed to read Devin CLI metadata: {error}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&binary_path, perms)
            .map_err(|error| format!("Failed to mark Devin CLI executable: {error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = crate::platform::silent_command("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&binary_path)
            .output();
    }

    emit_progress(&app, "verifying", "Verifying Devin CLI", 90);
    verify_installed_binary(&binary_path.to_string_lossy()).await?;
    crate::expose_managed_cli("devin", &binary_path);
    emit_progress(&app, "complete", "Devin CLI installed", 100);
    Ok(())
}

pub async fn uninstall_devin_cli(app: AppHandle) -> Result<(), String> {
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot uninstall Devin CLI while {count} {} running. Please stop all active sessions first.",
            if count == 1 { "session is" } else { "sessions are" }
        ));
    }

    let wsl = crate::platform::get_wsl_config();
    if cfg!(windows) && wsl.enabled {
        let unix_path = get_wsl_cli_binary_path(&wsl.distro)?;
        crate::platform::wsl_remove_file(&wsl.distro, &unix_path)
            .map_err(|error| format!("Failed to remove Devin CLI from WSL: {error}"))?;
        return Ok(());
    }

    let cli_dir = get_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|error| format!("Failed to remove Devin CLI directory: {error}"))?;
    }
    Ok(())
}

pub async fn update_devin_cli(app: AppHandle) -> Result<(), String> {
    install_devin_cli(app, None).await
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let _ = app.emit_all(
        "devin-cli:install-progress",
        &DevinInstallProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

fn devin_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("Failed to build Devin HTTP client: {error}"))
}

fn manifest_url_for_version(version: Option<&str>) -> String {
    match version
        .map(str::trim)
        .map(|value| value.trim_start_matches('v'))
        .filter(|value| !value.is_empty() && *value != "latest")
    {
        Some(version) => format!("https://static.devin.ai/cli/{version}/manifest.json"),
        None => DEVIN_MANIFEST_URL.to_string(),
    }
}

async fn fetch_manifest_text(url: &str) -> Result<String, String> {
    let response = devin_http_client()?
        .get(url)
        .header("User-Agent", "jean-desktop")
        .send()
        .await
        .map_err(|error| format!("Failed to fetch Devin manifest: {error}"))?;
    if response.status().as_u16() == 404 {
        return Err(format!("Devin CLI release was not found at {url}"));
    }
    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch Devin manifest: HTTP {}",
            response.status()
        ));
    }
    response
        .text()
        .await
        .map_err(|error| format!("Failed to read Devin manifest: {error}"))
}

fn releases_for_target(
    manifest: &str,
    install_target: &DevinInstallTarget,
) -> Result<Vec<DevinReleaseInfo>, String> {
    let targets = parse_manifest_targets(manifest)?;
    let mut releases = targets
        .iter()
        .filter(|target| {
            target.platform == install_target.platform && target.arch == install_target.arch
        })
        .map(|target| DevinReleaseInfo {
            version: target.version.clone(),
            tag_name: target.version.clone(),
            published_at: target.published_at.clone(),
            prerelease: target.prerelease,
            url: Some(target.url.clone()),
        })
        .collect::<Vec<_>>();
    releases.sort_by_key(|release| std::cmp::Reverse(version_sort_key(&release.version)));
    releases.dedup_by(|left, right| left.version == right.version);
    Ok(releases)
}

fn devin_install_target() -> Result<DevinInstallTarget, String> {
    let wsl = crate::platform::get_wsl_config();
    if cfg!(windows) && wsl.enabled {
        let arch = match crate::platform::wsl_detect_arch(&wsl.distro) {
            Some("linux-x64") => "x64",
            Some("linux-arm64") => "arm64",
            _ => {
                return Err(
                    "Devin CLI has no build for this WSL architecture. Official Linux builds are x64 and arm64."
                        .to_string(),
                );
            }
        };
        return Ok(DevinInstallTarget {
            platform: "linux",
            arch,
            binary_name: "devin",
            wsl_distro: Some(wsl.distro),
        });
    }

    let (platform, arch, binary_name) =
        platform_arch_for_os(std::env::consts::OS, std::env::consts::ARCH)?;
    Ok(DevinInstallTarget {
        platform,
        arch,
        binary_name,
        wsl_distro: None,
    })
}

fn platform_arch_for_os(
    os: &str,
    arch: &str,
) -> Result<(&'static str, &'static str, &'static str), String> {
    let platform = match os {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        other => {
            return Err(format!(
                "Devin CLI does not publish a build for {other}. Official builds cover macOS, Linux, and Windows."
            ));
        }
    };
    let arch = match arch {
        "aarch64" | "arm64" => "arm64",
        "x86_64" | "amd64" => "x64",
        other => {
            return Err(format!(
                "Devin CLI does not publish a {platform} build for {other}. Supported architectures are x64 and arm64."
            ));
        }
    };
    let binary_name = if platform == "windows" {
        "devin.exe"
    } else {
        "devin"
    };
    Ok((platform, arch, binary_name))
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(expected.trim()) {
        return Err(format!(
            "Devin CLI checksum mismatch. Expected {expected}, got {actual}."
        ));
    }
    Ok(())
}

fn path_is_devin_binary(path: &std::path::Path, binary_name: &str) -> u8 {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized == format!("bin/{binary_name}")
        || normalized.ends_with(&format!("/bin/{binary_name}"))
    {
        2
    } else if path.file_name().and_then(|name| name.to_str()) == Some(binary_name) {
        1
    } else {
        0
    }
}

fn extract_devin_binary(
    archive_bytes: &[u8],
    url: &str,
    binary_name: &str,
) -> Result<Vec<u8>, String> {
    let lowered = url.to_ascii_lowercase();
    if lowered.contains(".zip") {
        extract_binary_from_zip(archive_bytes, binary_name)
    } else if lowered.contains(".tar.gz") || lowered.ends_with(".tgz") {
        extract_binary_from_tar_gz(archive_bytes, binary_name)
    } else {
        Err(format!(
            "Unsupported Devin CLI archive format at {url}. Expected tar.gz or zip."
        ))
    }
}

fn extract_binary_from_tar_gz(archive_bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, String> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    let decoder = GzDecoder::new(archive_bytes);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Failed to read Devin archive: {error}"))?;
    let mut best: Option<(u8, Vec<u8>)> = None;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("Failed to read Devin archive entry: {error}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|error| format!("Failed to read Devin archive path: {error}"))?;
        let rank = path_is_devin_binary(&path, binary_name);
        if rank == 0 {
            continue;
        }
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|error| format!("Failed to read Devin binary from archive: {error}"))?;
        if best.as_ref().is_none_or(|(current, _)| rank > *current) {
            best = Some((rank, data));
        }
    }
    best.map(|(_, data)| data)
        .ok_or_else(|| format!("Could not find bin/{binary_name} in the Devin tar.gz archive"))
}

fn extract_binary_from_zip(archive_bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, String> {
    let cursor = std::io::Cursor::new(archive_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("Failed to read Devin zip archive: {error}"))?;
    let mut best: Option<(u8, Vec<u8>)> = None;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read Devin zip entry: {error}"))?;
        if file.is_dir() {
            continue;
        }
        let path = std::path::PathBuf::from(file.name());
        let rank = path_is_devin_binary(&path, binary_name);
        if rank == 0 {
            continue;
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|error| format!("Failed to read Devin binary from zip: {error}"))?;
        if best.as_ref().is_none_or(|(current, _)| rank > *current) {
            best = Some((rank, data));
        }
    }
    best.map(|(_, data)| data)
        .ok_or_else(|| format!("Could not find bin/{binary_name} in the Devin zip archive"))
}

async fn verify_installed_binary(path: &str) -> Result<(), String> {
    let mut command = crate::platform::cli_command(path, None);
    command.arg("--version");
    match run_command_with_timeout(command, AUTH_TIMEOUT).await? {
        Some(output) if output.status.success() => Ok(()),
        Some(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            };
            Err(format!("Devin CLI verification failed: {detail}"))
        }
        None => Err("Devin CLI verification timed out".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_identity_is_not_authenticated() {
        assert!(!parse_auth_status(r#"{"user":null,"email":null}"#).authenticated);
        assert!(!parse_auth_status("Not signed in").authenticated);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_timeout_kills_child() {
        let mut command = crate::platform::silent_command("sh");
        command.args(["-c", "exec sleep 10"]);
        let start = std::time::Instant::now();
        assert!(
            run_command_with_timeout(command, Duration::from_millis(100))
                .await
                .unwrap()
                .is_none()
        );
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_drains_large_output_without_deadlock() {
        let mut command = crate::platform::silent_command("sh");
        command.args(["-c", "head -c 131072 /dev/zero; printf warning >&2"]);
        let output = run_command_with_timeout(command, Duration::from_secs(3))
            .await
            .unwrap()
            .expect("command completes");
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 131072);
        assert_eq!(output.stderr, b"warning");
    }

    #[cfg(unix)]
    #[test]
    fn failed_auth_command_is_not_authenticated() {
        use std::os::unix::process::ExitStatusExt;
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(256),
            stdout: b"Authenticated".to_vec(),
            stderr: Vec::new(),
        };
        let status = auth_status_from_output(&output);
        assert!(!status.authenticated);
        assert!(status.error.is_some());
    }

    #[test]
    fn parses_devin_version_from_cli_output() {
        assert_eq!(parse_version(b"devin 1.2.3\n").as_deref(), Some("1.2.3"));
        assert_eq!(parse_version(b"v0.9.0\n").as_deref(), Some("0.9.0"));
    }

    #[test]
    fn parses_auth_status_json_and_text() {
        let authed = parse_auth_status(r#"{"authenticated":true,"email":"dev@example.com"}"#);
        assert!(authed.authenticated);
        assert_eq!(authed.error, None);

        let missing = parse_auth_status("Not authenticated. Run devin auth login.");
        assert!(!missing.authenticated);
        assert_eq!(
            missing.error.as_deref(),
            Some("Not authenticated. Run devin auth login.")
        );
    }

    #[test]
    fn parses_model_family_variants_by_model_uid() {
        let models = parse_models_json(
            r#"{
            "families": [{
                "family_label": "SWE-2", "family_uid": "swe-2", "slug": "swe-2",
                "variants": [
                    {"model_uid": "swe-2-medium", "label": "SWE-2 Medium"},
                    {"model_uid": "swe-2-high", "label": "SWE-2 High"}
                ]
            }]
        }"#,
        )
        .expect("family variants parse");
        assert_eq!(
            models,
            vec![
                DevinModelInfo {
                    id: "swe-2-high".to_string(),
                    label: "SWE-2 High".to_string()
                },
                DevinModelInfo {
                    id: "swe-2-medium".to_string(),
                    label: "SWE-2 Medium".to_string()
                },
            ]
        );
        assert!(parse_models_json(r#"{"families":[]}"#).unwrap().is_empty());
    }

    #[test]
    fn parses_models_list_json_array_and_object_wrappers() {
        let models = parse_models_json(
            r#"[{"id":"devin-1","name":"Devin 1"},{"model":"devin-2","displayName":"Devin 2"}]"#,
        )
        .expect("models parse");
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["devin-1", "devin-2"]
        );
        assert_eq!(models[1].label, "Devin 2");

        let wrapped = parse_models_json(r#"{"models":{"devin-3":{"label":"Devin 3"}}}"#)
            .expect("wrapped models parse");
        assert_eq!(wrapped[0].id, "devin-3");
        assert_eq!(wrapped[0].label, "Devin 3");
    }

    #[test]
    fn selects_manifest_target_for_platform_and_arch() {
        let manifest = parse_manifest_targets(
            r#"{"versions":[{"version":"1.2.3","targets":[{"platform":"darwin","arch":"arm64","url":"https://static.devin.ai/devin-aarch64-apple-darwin.tar.gz"},{"platform":"linux","arch":"x64","url":"https://static.devin.ai/devin-x86_64-linux.tar.gz"}]}]}"#,
        )
        .expect("manifest parse");
        let target = select_manifest_target(&manifest, "darwin", "arm64").expect("target");
        assert_eq!(target.version, "1.2.3");
        assert_eq!(
            target.url,
            "https://static.devin.ai/devin-aarch64-apple-darwin.tar.gz"
        );
    }

    #[test]
    fn parses_current_static_devin_manifest_shape() {
        let manifest = parse_manifest_targets(
            r#"{"version":"3000.2.17","platforms":{"aarch64-apple-darwin":{"url":"https://static.devin.ai/cli/3000.2.17/devin-3000.2.17-aarch64-apple-darwin.tar.gz","sha256":"abc"},"x86_64-unknown-linux":{"url":"https://static.devin.ai/cli/3000.2.17/devin-3000.2.17-x86_64-unknown-linux.tar.gz","sha256":"def"}}}"#,
        )
        .expect("manifest parse");

        let target = select_manifest_target(&manifest, "darwin", "arm64").expect("target");
        assert_eq!(target.version, "3000.2.17");
        assert_eq!(target.platform, "darwin");
        assert_eq!(target.arch, "arm64");
        assert_eq!(target.sha256.as_deref(), Some("abc"));

        let linux = select_manifest_target(&manifest, "linux", "x64").expect("linux");
        assert_eq!(linux.sha256.as_deref(), Some("def"));
        assert!(select_manifest_target(&manifest, "windows", "arm64").is_none());
    }

    #[test]
    fn maps_official_platforms_and_rejects_unsupported_hosts() {
        assert_eq!(
            platform_arch_for_os("macos", "aarch64").unwrap(),
            ("darwin", "arm64", "devin")
        );
        assert_eq!(
            platform_arch_for_os("linux", "x86_64").unwrap(),
            ("linux", "x64", "devin")
        );
        assert_eq!(
            platform_arch_for_os("windows", "aarch64").unwrap(),
            ("windows", "arm64", "devin.exe")
        );
        assert!(platform_arch_for_os("freebsd", "x86_64")
            .unwrap_err()
            .contains("does not publish"));
        assert!(platform_arch_for_os("linux", "i686")
            .unwrap_err()
            .contains("x64 and arm64"));
    }

    #[test]
    fn versioned_manifest_url_uses_static_devin_path() {
        assert_eq!(
            manifest_url_for_version(Some("v3000.11.92")),
            "https://static.devin.ai/cli/3000.11.92/manifest.json"
        );
        assert_eq!(
            manifest_url_for_version(Some("latest")),
            "https://static.devin.ai/cli/current/manifest.json"
        );
        assert_eq!(
            manifest_url_for_version(None),
            "https://static.devin.ai/cli/current/manifest.json"
        );
    }

    #[test]
    fn rejects_checksum_mismatch() {
        use sha2::{Digest, Sha256};
        let error = verify_sha256(b"devin", "deadbeef").unwrap_err();
        assert!(error.contains("checksum mismatch"));
        let actual = format!("{:x}", Sha256::digest(b"devin"));
        assert!(verify_sha256(b"devin", &actual).is_ok());
        assert!(verify_sha256(b"devin", &actual.to_ascii_uppercase()).is_ok());
    }

    #[test]
    fn extracts_bin_devin_from_tar_gz_and_zip() {
        let tar_gz = sample_tar_gz("bin/devin", b"unix-devin");
        assert_eq!(
            extract_binary_from_tar_gz(&tar_gz, "devin").unwrap(),
            b"unix-devin"
        );
        let zip = sample_zip(&[
            ("share/devin/docs/readme", b"docs"),
            ("bin/devin.exe", b"win-devin"),
        ]);
        assert_eq!(
            extract_binary_from_zip(&zip, "devin.exe").unwrap(),
            b"win-devin"
        );
        assert!(
            extract_devin_binary(&tar_gz, "https://static.devin.ai/devin.tar.gz", "devin").is_ok()
        );
        assert!(extract_devin_binary(b"nope", "https://example.com/devin.bin", "devin").is_err());
    }

    fn sample_tar_gz(path: &str, contents: &[u8]) -> Vec<u8> {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_size(contents.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append(&header, contents).unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn sample_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;

        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            for (name, contents) in files {
                archive.start_file(*name, options).unwrap();
                archive.write_all(contents).unwrap();
            }
            archive.finish().unwrap();
        }
        cursor.into_inner()
    }
}
