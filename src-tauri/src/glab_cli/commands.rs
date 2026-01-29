//! Tauri commands for GitLab CLI management

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::config::{ensure_glab_cli_dir, get_glab_cli_binary_path};

/// GitLab API URL for glab releases (glab is hosted on GitLab)
const GLAB_RELEASES_API: &str = "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases";

/// Status of the GitLab CLI installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabCliStatus {
    /// Whether GitLab CLI is installed
    pub installed: bool,
    /// Installed version (if any)
    pub version: Option<String>,
    /// Path to the CLI binary (if installed)
    pub path: Option<String>,
}

/// Information about a GitLab CLI release
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabReleaseInfo {
    /// Version string (e.g., "1.36.0")
    pub version: String,
    /// Git tag name (e.g., "v1.36.0")
    pub tag_name: String,
    /// Publication date in ISO format
    pub published_at: String,
    /// Whether this is a prerelease
    pub prerelease: bool,
}

/// Progress event for CLI installation
#[derive(Debug, Clone, Serialize)]
pub struct GlabInstallProgress {
    /// Current stage of installation
    pub stage: String,
    /// Progress message
    pub message: String,
    /// Percentage complete (0-100)
    pub percent: u8,
}

/// Result of checking GitLab CLI authentication status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabAuthStatus {
    /// Whether the CLI is authenticated
    pub authenticated: bool,
    /// Error message if authentication check failed
    pub error: Option<String>,
    /// GitLab host (gitlab.com or self-hosted URL)
    pub host: Option<String>,
}

/// GitLab API release response structure
#[derive(Debug, Deserialize)]
struct GitLabRelease {
    tag_name: String,
    released_at: String,
    #[serde(default)]
    upcoming_release: bool,
    #[serde(default)]
    assets: GitLabAssets,
}

#[derive(Debug, Deserialize, Default)]
struct GitLabAssets {
    #[serde(default)]
    links: Vec<GitLabAssetLink>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct GitLabAssetLink {
    name: String,
    url: String,
}

/// Check if GitLab CLI is installed and get its status
#[tauri::command]
pub async fn check_glab_cli_installed(app: AppHandle) -> Result<GlabCliStatus, String> {
    log::trace!("Checking GitLab CLI installation status");

    let binary_path = get_glab_cli_binary_path(&app)?;

    if !binary_path.exists() {
        log::trace!("GitLab CLI not found at {:?}", binary_path);
        return Ok(GlabCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    // Try to get the version by running glab --version
    // Use shell wrapper to bypass macOS security restrictions
    let shell_cmd = format!("{:?} --version", binary_path);
    let version = match crate::platform::shell_command(&shell_cmd).output() {
        Ok(output) => {
            if output.status.success() {
                let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                // glab --version returns "glab version 1.36.0 (2024-01-15)"
                // Extract just the version number
                let version = version_str
                    .split_whitespace()
                    .nth(2)
                    .map(|s| s.to_string())
                    .unwrap_or(version_str);
                log::trace!("GitLab CLI version: {}", version);
                Some(version)
            } else {
                log::warn!("Failed to get GitLab CLI version");
                None
            }
        }
        Err(e) => {
            log::warn!("Failed to execute GitLab CLI: {}", e);
            None
        }
    };

    Ok(GlabCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

/// Get available GitLab CLI versions from GitLab releases API
#[tauri::command]
pub async fn get_available_glab_versions() -> Result<Vec<GlabReleaseInfo>, String> {
    log::trace!("Fetching available GitLab CLI versions from GitLab API");

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(GLAB_RELEASES_API)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitLab API returned status: {}", response.status()));
    }

    let releases: Vec<GitLabRelease> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitLab API response: {e}"))?;

    // Convert to our format
    let versions: Vec<GlabReleaseInfo> = releases
        .into_iter()
        .filter(|r| !r.upcoming_release) // Filter out upcoming releases
        .take(5) // Only take 5 most recent
        .map(|r| {
            // Remove 'v' prefix from tag_name for version
            let version = r
                .tag_name
                .strip_prefix('v')
                .unwrap_or(&r.tag_name)
                .to_string();
            GlabReleaseInfo {
                version,
                tag_name: r.tag_name,
                published_at: r.released_at,
                prerelease: r.upcoming_release,
            }
        })
        .collect();

    log::trace!("Found {} GitLab CLI versions", versions.len());
    Ok(versions)
}

/// Get the platform string for the current system (for glab releases)
fn get_glab_platform() -> Result<(&'static str, &'static str), String> {
    // Returns (platform_string, archive_extension)
    // glab release format: glab_{version}_{os}_{arch}.tar.gz
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok(("darwin_arm64", "tar.gz"));
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok(("darwin_amd64", "tar.gz"));
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Ok(("linux_amd64", "tar.gz"));
    }

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Ok(("linux_arm64", "tar.gz"));
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok(("windows_amd64", "zip"));
    }

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Ok(("windows_arm64", "zip"));
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform".to_string())
}

/// Install GitLab CLI by downloading from GitHub releases
#[tauri::command]
pub async fn install_glab_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    log::trace!("Installing GitLab CLI, version: {:?}", version);

    // Check if any Claude processes are running
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot install GitLab CLI while {} Claude {} running. Please stop all active sessions first.",
            count,
            if count == 1 { "session is" } else { "sessions are" }
        ));
    }

    let cli_dir = ensure_glab_cli_dir(&app)?;
    let binary_path = get_glab_cli_binary_path(&app)?;

    // Emit progress: starting
    emit_progress(&app, "starting", "Preparing installation...", 0);

    // Determine version (use provided or fetch latest)
    let version = match version {
        Some(v) => v,
        None => fetch_latest_glab_version().await?,
    };

    // Detect platform
    let (platform, archive_ext) = get_glab_platform()?;
    log::trace!("Installing version {version} for platform {platform}");

    // Build download URL using GitLab's package registry
    // Format: https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/{version}/glab_{version}_{platform}.{ext}
    // Note: Version in URL uses URL encoding (. becomes %2E)
    let version_encoded = version.replace('.', "%2E");
    let archive_name = format!("glab_{version}_{platform}.{archive_ext}");
    let archive_name_encoded = archive_name.replace('.', "%2E");
    let download_url = format!(
        "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/{version_encoded}/{archive_name_encoded}"
    );
    log::trace!("Downloading from: {download_url}");

    // Emit progress: downloading
    emit_progress(&app, "downloading", "Downloading GitLab CLI...", 20);

    // Download the archive
    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download GitLab CLI: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download GitLab CLI: HTTP {}",
            response.status()
        ));
    }

    let archive_content = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read archive content: {e}"))?;

    log::trace!("Downloaded {} bytes", archive_content.len());

    // Emit progress: extracting
    emit_progress(&app, "extracting", "Extracting archive...", 40);

    // Create temp directory for extraction
    let temp_dir = cli_dir.join("temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    // Extract the archive
    let extracted_binary_path = if archive_ext == "zip" {
        extract_zip(&archive_content, &temp_dir)?
    } else {
        extract_tar_gz(&archive_content, &temp_dir)?
    };

    // Emit progress: installing
    emit_progress(&app, "installing", "Installing GitLab CLI...", 60);

    // Move binary to final location
    std::fs::copy(&extracted_binary_path, &binary_path)
        .map_err(|e| format!("Failed to copy binary: {e}"))?;

    // Clean up temp directory
    let _ = std::fs::remove_dir_all(&temp_dir);

    // Emit progress: verifying
    emit_progress(&app, "verifying", "Verifying installation...", 80);

    // Make sure the binary is executable
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
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&binary_path)
            .output();
    }

    // Verify the binary works
    let shell_cmd = format!("{:?} --version", binary_path);
    log::trace!("Running via shell: {:?}", shell_cmd);
    let version_output = crate::platform::shell_command(&shell_cmd)
        .output()
        .map_err(|e| format!("Failed to verify GitLab CLI: {e}"))?;

    if !version_output.status.success() {
        let stderr = String::from_utf8_lossy(&version_output.stderr);
        let stdout = String::from_utf8_lossy(&version_output.stdout);
        log::error!(
            "GitLab CLI verification failed - exit code: {:?}, stdout: {}, stderr: {}",
            version_output.status.code(),
            stdout,
            stderr
        );
        return Err(format!(
            "GitLab CLI binary verification failed: {}",
            if !stderr.is_empty() {
                stderr.to_string()
            } else {
                "Unknown error".to_string()
            }
        ));
    }

    let installed_version = String::from_utf8_lossy(&version_output.stdout)
        .trim()
        .to_string();
    log::trace!("Verified GitLab CLI version: {installed_version}");

    // Emit progress: complete
    emit_progress(&app, "complete", "Installation complete!", 100);

    log::trace!("GitLab CLI installed successfully at {:?}", binary_path);
    Ok(())
}

/// Fetch the latest GitLab CLI version from GitLab API
async fn fetch_latest_glab_version() -> Result<String, String> {
    log::trace!("Fetching latest GitLab CLI version");

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    // GitLab API doesn't have /latest endpoint, fetch first release from list
    let response = client
        .get(format!("{GLAB_RELEASES_API}?per_page=1"))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch latest release: HTTP {}",
            response.status()
        ));
    }

    let releases: Vec<GitLabRelease> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {e}"))?;

    let release = releases
        .first()
        .ok_or_else(|| "No releases found".to_string())?;

    let version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();
    log::trace!("Latest GitLab CLI version: {version}");
    Ok(version)
}

/// Extract glab binary from a zip archive (Windows)
fn extract_zip(
    archive_content: &[u8],
    temp_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::io::Cursor;

    let cursor = Cursor::new(archive_content);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip archive: {e}"))?;

    // Extract all files
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;

        let outpath = match file.enclosed_name() {
            Some(path) => temp_dir.join(path),
            None => continue,
        };

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory: {e}"))?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p)
                        .map_err(|e| format!("Failed to create parent directory: {e}"))?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create file: {e}"))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to extract file: {e}"))?;
        }
    }

    // glab releases have the binary at the root: bin/glab or just glab
    #[cfg(not(target_os = "windows"))]
    let binary_name = "glab";
    #[cfg(target_os = "windows")]
    let binary_name = "glab.exe";

    // Try bin/glab first, then root glab
    let binary_path = temp_dir.join("bin").join(binary_name);
    if binary_path.exists() {
        return Ok(binary_path);
    }

    let binary_path = temp_dir.join(binary_name);
    if binary_path.exists() {
        return Ok(binary_path);
    }

    Err(format!("Binary not found in archive at {:?}", temp_dir))
}

/// Extract glab binary from a tar.gz archive (macOS, Linux)
fn extract_tar_gz(
    archive_content: &[u8],
    temp_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use flate2::read::GzDecoder;
    use std::io::Cursor;
    use tar::Archive;

    let cursor = Cursor::new(archive_content);
    let decoder = GzDecoder::new(cursor);
    let mut archive = Archive::new(decoder);

    archive
        .unpack(temp_dir)
        .map_err(|e| format!("Failed to extract tar.gz archive: {e}"))?;

    // glab releases have the binary at: bin/glab
    let binary_path = temp_dir.join("bin").join("glab");
    if binary_path.exists() {
        return Ok(binary_path);
    }

    // Or at the root
    let binary_path = temp_dir.join("glab");
    if binary_path.exists() {
        return Ok(binary_path);
    }

    Err(format!("Binary not found in archive at {:?}", temp_dir))
}

/// Check if GitLab CLI is authenticated by running `glab auth status`
#[tauri::command]
pub async fn check_glab_cli_auth(app: AppHandle) -> Result<GlabAuthStatus, String> {
    log::trace!("Checking GitLab CLI authentication status");

    let binary_path = get_glab_cli_binary_path(&app)?;

    if !binary_path.exists() {
        return Ok(GlabAuthStatus {
            authenticated: false,
            error: Some("GitLab CLI not installed".to_string()),
            host: None,
        });
    }

    // Run glab auth status to check authentication
    let shell_cmd = format!("{:?} auth status", binary_path);

    log::trace!("Running auth check: {:?}", shell_cmd);

    let output = crate::platform::shell_command(&shell_cmd)
        .output()
        .map_err(|e| format!("Failed to execute GitLab CLI: {e}"))?;

    // glab auth status returns exit code 0 if authenticated, non-zero otherwise
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        log::trace!("GitLab CLI auth check successful: {}", stdout);

        // Try to extract host from output (e.g., "Logged in to gitlab.com as username")
        let host = stdout
            .lines()
            .find(|line| line.contains("Logged in to"))
            .and_then(|line| {
                line.split("Logged in to ")
                    .nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .map(|s| s.to_string())
            });

        Ok(GlabAuthStatus {
            authenticated: true,
            error: None,
            host,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("GitLab CLI auth check failed: {}", stderr);
        Ok(GlabAuthStatus {
            authenticated: false,
            error: Some(stderr),
            host: None,
        })
    }
}

/// Helper function to emit installation progress events
fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let progress = GlabInstallProgress {
        stage: stage.to_string(),
        message: message.to_string(),
        percent,
    };

    if let Err(e) = app.emit("glab-cli:install-progress", &progress) {
        log::warn!("Failed to emit install progress: {}", e);
    }
}
