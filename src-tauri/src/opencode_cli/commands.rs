//! Tauri commands for OpenCode CLI management

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::config::{ensure_cli_dir, resolve_cli_binary};
use crate::http_server::EmitExt;
use crate::platform::silent_command;

/// GitHub owner/repo for OpenCode releases.
const GITHUB_REPO: &str = "anomalyco/opencode";

/// Status of the OpenCode CLI installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Auth status of the OpenCode CLI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
}

/// Information about an OpenCode CLI release
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: String,
    pub prerelease: bool,
}

/// Progress event for CLI installation
#[derive(Debug, Clone, Serialize)]
pub struct OpenCodeInstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
}

/// GitHub release response (subset of fields we need)
#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    published_at: Option<String>,
    prerelease: bool,
}

/// Platform-specific asset info for download.
struct PlatformAsset {
    /// e.g. `opencode-darwin-arm64.zip` or `opencode-linux-arm64.tar.gz`
    asset_name: String,
    /// Archive format: `zip` or `tar.gz`
    format: ArchiveFormat,
}

#[allow(dead_code)] // Variants are platform-gated via #[cfg]
enum ArchiveFormat {
    Zip,
    TarGz,
}

/// List available OpenCode models by refreshing from the OpenCode CLI cache source.
#[tauri::command]
pub async fn list_opencode_models(app: AppHandle) -> Result<Vec<String>, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_path.exists() {
        return Err(format!(
            "OpenCode CLI not found at {}. Install it in Settings > General.",
            binary_path.display()
        ));
    }

    let output = silent_command(&binary_path)
        .args(["models", "--refresh", "--verbose"])
        .output()
        .map_err(|e| format!("Failed to execute OpenCode CLI models command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "OpenCode models command failed".to_string()
        } else {
            format!("OpenCode models command failed: {stderr}")
        });
    }

    let stdout_raw = String::from_utf8_lossy(&output.stdout).to_string();
    let stdout = strip_ansi(&stdout_raw);

    let mut models = Vec::new();
    for line in stdout.lines() {
        let candidate = line.trim();
        if is_model_identifier(candidate) {
            models.push(candidate.to_string());
        }
    }

    models.sort();
    models.dedup();
    Ok(models)
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let _ = app.emit_all(
        "opencode-cli:install-progress",
        &OpenCodeInstallProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

/// Check if OpenCode CLI is installed and get its status.
#[tauri::command]
pub async fn check_opencode_cli_installed(app: AppHandle) -> Result<OpenCodeCliStatus, String> {
    log::trace!("Checking OpenCode CLI installation status");

    let binary_path = resolve_cli_binary(&app);

    if !binary_path.exists() {
        return Ok(OpenCodeCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    let version = match silent_command(&binary_path).arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let cleaned = version_str
                .split_whitespace()
                .last()
                .unwrap_or(&version_str)
                .trim_start_matches('v')
                .to_string();
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        }
        _ => None,
    };

    Ok(OpenCodeCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().is_some_and(|c| *c == '[') {
                let _ = chars.next();
                while let Some(c) = chars.next() {
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

fn is_model_identifier(value: &str) -> bool {
    let Some((provider, model)) = value.split_once('/') else {
        return false;
    };

    if provider.is_empty() || model.is_empty() || model.contains('/') {
        return false;
    }

    fn allowed(s: &str) -> bool {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }

    allowed(provider) && allowed(model)
}

/// Check if OpenCode CLI has any configured credentials.
#[tauri::command]
pub async fn check_opencode_cli_auth(app: AppHandle) -> Result<OpenCodeAuthStatus, String> {
    log::trace!("Checking OpenCode CLI authentication status");

    let binary_path = resolve_cli_binary(&app);

    if !binary_path.exists() {
        return Ok(OpenCodeAuthStatus {
            authenticated: false,
            error: Some("OpenCode CLI not installed".to_string()),
        });
    }

    let output = silent_command(&binary_path)
        .args(["auth", "list"])
        .output()
        .map_err(|e| format!("Failed to execute OpenCode CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Ok(OpenCodeAuthStatus {
            authenticated: false,
            error: if stderr.is_empty() {
                Some("Not authenticated".to_string())
            } else {
                Some(stderr)
            },
        });
    }

    let stdout_raw = String::from_utf8_lossy(&output.stdout).to_string();
    let stdout = strip_ansi(&stdout_raw).to_lowercase();
    let has_credentials = stdout.contains("credential") && !stdout.contains("0 credentials");

    Ok(OpenCodeAuthStatus {
        authenticated: has_credentials,
        error: if has_credentials {
            None
        } else {
            Some("No credentials configured. Run `opencode auth login`.".to_string())
        },
    })
}

/// Get the platform-specific asset info for GitHub release downloads.
///
/// Asset naming from anomalyco/opencode releases:
/// - macOS:   `opencode-darwin-arm64.zip`, `opencode-darwin-x64.zip`
/// - Linux:   `opencode-linux-arm64.tar.gz`, `opencode-linux-x64.tar.gz`
/// - Windows: `opencode-windows-x64.zip`
fn get_platform_asset() -> Result<PlatformAsset, String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok(PlatformAsset {
            asset_name: "opencode-darwin-arm64.zip".to_string(),
            format: ArchiveFormat::Zip,
        });
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok(PlatformAsset {
            asset_name: "opencode-darwin-x64.zip".to_string(),
            format: ArchiveFormat::Zip,
        });
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Ok(PlatformAsset {
            asset_name: "opencode-linux-arm64.tar.gz".to_string(),
            format: ArchiveFormat::TarGz,
        });
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Ok(PlatformAsset {
            asset_name: "opencode-linux-x64.tar.gz".to_string(),
            format: ArchiveFormat::TarGz,
        });
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok(PlatformAsset {
            asset_name: "opencode-windows-x64.zip".to_string(),
            format: ArchiveFormat::Zip,
        });
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

/// Get available OpenCode versions from GitHub releases.
#[tauri::command]
pub async fn get_available_opencode_versions() -> Result<Vec<OpenCodeReleaseInfo>, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases");
    log::info!("Fetching available OpenCode versions from {url}");

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "jean-desktop")
        .query(&[("per_page", "20")])
        .send()
        .await
        .map_err(|e| {
            log::error!("OpenCode versions fetch failed: {e}");
            format!("Failed to fetch GitHub releases: {e}")
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        log::error!("OpenCode versions API returned {status}: {body}");
        return Err(format!("GitHub API returned status: {status}"));
    }

    let body = response.text().await.map_err(|e| {
        log::error!("OpenCode versions: failed to read response body: {e}");
        format!("Failed to read response: {e}")
    })?;

    let releases: Vec<GitHubRelease> = serde_json::from_str(&body).map_err(|e| {
        log::error!("OpenCode versions: failed to parse JSON: {e}, body: {}", &body[..body.len().min(500)]);
        format!("Failed to parse GitHub releases: {e}")
    })?;

    log::info!("OpenCode versions: got {} releases", releases.len());

    let result: Vec<OpenCodeReleaseInfo> = releases
        .into_iter()
        .map(|r| {
            let version = r.tag_name.trim_start_matches('v').to_string();
            OpenCodeReleaseInfo {
                version,
                tag_name: r.tag_name,
                published_at: r.published_at.unwrap_or_default(),
                prerelease: r.prerelease,
            }
        })
        .collect();

    log::info!("OpenCode versions: returning {} versions", result.len());
    Ok(result)
}

/// Install OpenCode CLI by downloading the binary from GitHub releases.
#[tauri::command]
pub async fn install_opencode_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    log::trace!("Installing OpenCode CLI: {version:?}");

    emit_progress(&app, "starting", "Preparing OpenCode installation", 5);

    let cli_dir = ensure_cli_dir(&app)?;
    let platform_asset = get_platform_asset()?;

    // Determine version
    let version = match version.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => v.trim_start_matches('v').to_string(),
        None => fetch_latest_version().await?,
    };

    let tag = format!("v{version}");
    let download_url = format!(
        "https://github.com/{GITHUB_REPO}/releases/download/{tag}/{}",
        platform_asset.asset_name
    );
    log::trace!("Downloading from: {download_url}");

    emit_progress(&app, "downloading", "Downloading OpenCode CLI", 30);

    let client = reqwest::Client::new();
    let response = client
        .get(&download_url)
        .header("User-Agent", "jean-desktop")
        .send()
        .await
        .map_err(|e| format!("Failed to download OpenCode CLI: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download OpenCode CLI: HTTP {}",
            response.status()
        ));
    }

    let archive_bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {e}"))?;

    log::trace!("Downloaded {} bytes", archive_bytes.len());

    emit_progress(&app, "extracting", "Extracting OpenCode binary", 60);

    let binary_name = if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    };

    let binary_data = match platform_asset.format {
        ArchiveFormat::Zip => extract_binary_from_zip(&archive_bytes, binary_name)?,
        ArchiveFormat::TarGz => extract_binary_from_tar_gz(&archive_bytes, binary_name)?,
    };

    let binary_path = cli_dir.join(binary_name);
    std::fs::write(&binary_path, &binary_data)
        .map_err(|e| format!("Failed to write binary: {e}"))?;

    // Set executable permissions
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

    emit_progress(&app, "verifying", "Verifying OpenCode CLI", 85);

    let status = check_opencode_cli_installed(app.clone()).await?;
    if !status.installed {
        return Err("OpenCode CLI install completed but binary was not found".to_string());
    }

    emit_progress(&app, "complete", "OpenCode CLI installed", 100);
    Ok(())
}

/// Extract a named binary from a tar.gz archive.
fn extract_binary_from_tar_gz(archive_bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, String> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    use tar::Archive;

    let decoder = GzDecoder::new(archive_bytes);
    let mut archive = Archive::new(decoder);

    let entries = archive
        .entries()
        .map_err(|e| format!("Failed to read tar entries: {e}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Failed to read tar entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("Failed to read entry path: {e}"))?;

        if let Some(name) = path.file_name() {
            if name == binary_name {
                let mut data = Vec::new();
                entry
                    .read_to_end(&mut data)
                    .map_err(|e| format!("Failed to read binary from archive: {e}"))?;
                return Ok(data);
            }
        }
    }

    Err(format!(
        "Could not find '{binary_name}' binary in the tar.gz archive"
    ))
}

/// Extract a named binary from a zip archive.
fn extract_binary_from_zip(archive_bytes: &[u8], binary_name: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let cursor = std::io::Cursor::new(archive_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to read zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;

        let path = std::path::Path::new(file.name());
        if let Some(name) = path.file_name() {
            if name == binary_name {
                let mut data = Vec::new();
                file.read_to_end(&mut data)
                    .map_err(|e| format!("Failed to read binary from zip: {e}"))?;
                return Ok(data);
            }
        }
    }

    Err(format!(
        "Could not find '{binary_name}' binary in the zip archive"
    ))
}

/// Fetch the latest release version from GitHub.
async fn fetch_latest_version() -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!(
            "https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
        ))
        .header("User-Agent", "jean-desktop")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest version: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch latest version: HTTP {}",
            response.status()
        ));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse latest release: {e}"))?;

    Ok(release.tag_name.trim_start_matches('v').to_string())
}

#[cfg(test)]
mod tests {
    use super::is_model_identifier;

    #[test]
    fn accepts_valid_model_identifiers() {
        assert!(is_model_identifier("opencode/gpt-5"));
        assert!(is_model_identifier("anthropic/claude-sonnet-4-5-20250929"));
        assert!(is_model_identifier("moonshotai/kimi-k2.5"));
    }

    #[test]
    fn rejects_non_model_lines_from_verbose_output() {
        assert!(!is_model_identifier("Models cache refreshed"));
        assert!(!is_model_identifier("{"));
        assert!(!is_model_identifier("\"id\": \"gpt-5\","));
        assert!(!is_model_identifier(
            "\"url\": \"https://opencode.ai/zen/v1\","
        ));
        assert!(!is_model_identifier("https://opencode.ai/zen/v1"));
    }

    #[test]
    fn get_platform_asset_returns_valid_name() {
        let asset = super::get_platform_asset();
        assert!(asset.is_ok(), "get_platform_asset() should succeed");
        let a = asset.unwrap();
        assert!(
            a.asset_name.starts_with("opencode-"),
            "unexpected asset name: {}",
            a.asset_name
        );
    }
}
