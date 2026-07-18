//! Tauri commands for CodeRabbit CLI management.

use crate::http_server::EmitExt;
use crate::platform::silent_command;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime};
use tauri::AppHandle;

use super::config::{
    ensure_coderabbit_cli_dir, find_system_coderabbit_binary, get_coderabbit_binary_path,
    get_coderabbit_cli_dir, resolve_coderabbit_binary,
};

const CODERABBIT_RELEASES_BASE_URL: &str = "https://cli.coderabbit.ai/releases";
const CODERABBIT_VERSIONS_CACHE_FILE: &str = "coderabbit-versions-cache.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRabbitCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRabbitAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRabbitPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeRabbitInstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRabbitReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: String,
    pub prerelease: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedCodeRabbitVersions {
    versions: Vec<CodeRabbitReleaseInfo>,
    fetched_at: String,
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let _ = app.emit_all(
        "coderabbit-cli:install-progress",
        &CodeRabbitInstallProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

fn parse_version(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .split_whitespace()
        .find(|part| part.chars().any(|c| c.is_ascii_digit()) && part.contains('.'))
        .map(|s| s.trim_start_matches('v').to_string())
        .or_else(|| Some(trimmed.to_string()))
}

fn get_version(binary: &std::path::Path) -> Option<String> {
    let output = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

fn sanitize_latest_version(raw: &str) -> Option<String> {
    parse_version(raw).map(|version| version.trim_start_matches('v').to_string())
}

fn versions_cache_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(ensure_coderabbit_cli_dir(app)?.join(CODERABBIT_VERSIONS_CACHE_FILE))
}

fn save_versions_cache(app: &AppHandle, versions: &[CodeRabbitReleaseInfo]) {
    let path = match versions_cache_path(app) {
        Ok(path) => path,
        Err(e) => {
            log::warn!("Cannot resolve CodeRabbit versions cache path: {e}");
            return;
        }
    };
    let cached = CachedCodeRabbitVersions {
        versions: versions.to_vec(),
        fetched_at: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default(),
    };
    match serde_json::to_string(&cached) {
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                log::warn!("Failed to write CodeRabbit versions cache: {e}");
            }
        }
        Err(e) => log::warn!("Failed to serialize CodeRabbit versions cache: {e}"),
    }
}

fn load_versions_cache(app: &AppHandle) -> Option<Vec<CodeRabbitReleaseInfo>> {
    let path = get_coderabbit_cli_dir(app)
        .ok()?
        .join(CODERABBIT_VERSIONS_CACHE_FILE);
    let contents = std::fs::read_to_string(path).ok()?;
    let cached: CachedCodeRabbitVersions = serde_json::from_str(&contents).ok()?;
    if cached.versions.is_empty() {
        return None;
    }
    Some(cached.versions)
}

async fn fetch_latest_release_info() -> Result<CodeRabbitReleaseInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let response = client
        .get(format!("{CODERABBIT_RELEASES_BASE_URL}/latest/VERSION"))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch CodeRabbit latest version: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "CodeRabbit version endpoint returned status: {}",
            response.status()
        ));
    }
    let raw = response
        .text()
        .await
        .map_err(|e| format!("Failed to read CodeRabbit latest version: {e}"))?;
    let version =
        sanitize_latest_version(&raw).ok_or("CodeRabbit version endpoint returned no version")?;
    Ok(CodeRabbitReleaseInfo {
        tag_name: version.clone(),
        version,
        published_at: String::new(),
        prerelease: false,
    })
}

pub async fn get_available_coderabbit_versions(
    app: AppHandle,
) -> Result<Vec<CodeRabbitReleaseInfo>, String> {
    match fetch_latest_release_info().await {
        Ok(version) => {
            let versions = vec![version];
            save_versions_cache(&app, &versions);
            Ok(versions)
        }
        Err(e) => {
            log::warn!("CodeRabbit latest version request failed ({e}), falling back to cache");
            Ok(load_versions_cache(&app).unwrap_or_default())
        }
    }
}

pub async fn check_coderabbit_cli_version_exists(
    _app: AppHandle,
    version: String,
) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let response = client
        .get(format!("{CODERABBIT_RELEASES_BASE_URL}/{version}/VERSION"))
        .send()
        .await
        .map_err(|e| format!("Failed to check CodeRabbit version: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(format!(
            "CodeRabbit version endpoint returned status: {}",
            response.status()
        ));
    }
    let raw = response
        .text()
        .await
        .map_err(|e| format!("Failed to read CodeRabbit version: {e}"))?;
    Ok(sanitize_latest_version(&raw).is_some_and(|found| found == version))
}

pub async fn check_coderabbit_cli_installed(app: AppHandle) -> Result<CodeRabbitCliStatus, String> {
    let binary_path = resolve_coderabbit_binary(&app);
    if !binary_path.exists() {
        return Ok(CodeRabbitCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    Ok(CodeRabbitCliStatus {
        installed: true,
        version: get_version(&binary_path),
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

pub async fn detect_coderabbit_in_path(app: AppHandle) -> Result<CodeRabbitPathDetection, String> {
    let Some(found_path) = find_system_coderabbit_binary(&app) else {
        return Ok(CodeRabbitPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };

    let version = get_version(&found_path);
    let package_manager = crate::platform::detect_package_manager(&found_path);

    Ok(CodeRabbitPathDetection {
        found: true,
        path: Some(found_path.to_string_lossy().to_string()),
        version,
        package_manager,
    })
}

pub async fn check_coderabbit_cli_auth(app: AppHandle) -> Result<CodeRabbitAuthStatus, String> {
    let binary_path = resolve_coderabbit_binary(&app);
    if !binary_path.exists() {
        return Ok(CodeRabbitAuthStatus {
            authenticated: false,
            error: Some("CodeRabbit CLI not installed".to_string()),
        });
    }

    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            crate::platform::cli_command(&binary_path.to_string_lossy(), None)
                .args(["auth", "status", "--agent"])
                .output()
        }),
    )
    .await
    .map_err(|_| "CodeRabbit auth status timed out".to_string())?
    .map_err(|e| format!("Failed to join auth status task: {e}"))?
    .map_err(|e| format!("Failed to check CodeRabbit auth status: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        let lower = stdout.to_lowercase();
        let authenticated = stdout.lines().any(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|value| {
                    value
                        .get("authenticated")
                        .and_then(|v| v.as_bool())
                        .or_else(|| value.get("loggedIn").and_then(|v| v.as_bool()))
                        .or_else(|| value.get("logged_in").and_then(|v| v.as_bool()))
                })
                .unwrap_or(false)
        }) || lower.contains("authenticated")
            || lower.contains("logged in");
        return Ok(CodeRabbitAuthStatus {
            authenticated: authenticated || stdout.trim().is_empty(),
            error: None,
        });
    }

    Ok(CodeRabbitAuthStatus {
        authenticated: false,
        error: Some(if stderr.is_empty() { stdout } else { stderr }),
    })
}

pub async fn install_coderabbit_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        return Err("CodeRabbit CLI install script currently supports macOS and Linux. Install CodeRabbit in WSL or add it to PATH.".to_string());
    }

    let cli_dir = ensure_coderabbit_cli_dir(&app)?;
    emit_progress(
        &app,
        "starting",
        "Preparing CodeRabbit CLI installation...",
        0,
    );
    emit_progress(
        &app,
        "downloading",
        "Running official CodeRabbit installer...",
        25,
    );

    let script = "curl -fsSL https://cli.coderabbit.ai/install.sh | sh";
    let mut command = silent_command("sh");
    command
        .arg("-c")
        .arg(script)
        .env("CODERABBIT_INSTALL_DIR", &cli_dir);
    if let Some(version) = version.as_ref().filter(|v| !v.trim().is_empty()) {
        command.env("CODERABBIT_VERSION", version.trim());
    }
    let output = command
        .output()
        .map_err(|e| format!("Failed to run CodeRabbit installer: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(format!(
            "CodeRabbit installer failed: {}",
            if stderr.is_empty() { stdout } else { stderr }
        ));
    }

    emit_progress(&app, "verifying", "Verifying CodeRabbit CLI...", 85);
    let binary_path = get_coderabbit_binary_path(&app)?;
    if !binary_path.exists() {
        return Err(format!(
            "CodeRabbit installer completed but binary was not found at {}",
            binary_path.display()
        ));
    }

    let verify = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to verify CodeRabbit CLI: {e}"))?;
    if !verify.status.success() {
        return Err("CodeRabbit CLI verification failed".to_string());
    }

    emit_progress(&app, "complete", "CodeRabbit CLI installed.", 100);
    Ok(())
}

pub async fn uninstall_coderabbit_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_coderabbit_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove CodeRabbit CLI directory: {e}"))?;
    }
    Ok(())
}

pub async fn update_coderabbit_cli(app: AppHandle) -> Result<(), String> {
    let binary_path = resolve_coderabbit_binary(&app);
    if !binary_path.exists() {
        return Err("CodeRabbit CLI not installed".to_string());
    }
    let output = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("update")
        .output()
        .map_err(|e| format!("Failed to update CodeRabbit CLI: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_latest_version_strips_whitespace_and_v() {
        assert_eq!(
            sanitize_latest_version(" v0.4.5\n").as_deref(),
            Some("0.4.5")
        );
    }

    #[test]
    fn sanitize_latest_version_accepts_plain_semver() {
        assert_eq!(sanitize_latest_version("0.4.5").as_deref(), Some("0.4.5"));
    }
}
