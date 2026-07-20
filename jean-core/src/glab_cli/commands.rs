//! Tauri commands for GitLab CLI management

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::config::{
    ensure_glab_cli_dir, get_glab_cli_binary_path, get_glab_cli_dir, resolve_glab_binary,
};
use crate::http_server::EmitExt;

/// Emergency fallback version when the API fails AND no cache exists.
/// The download URL pattern is stable for any valid version, so staleness is acceptable.
const FALLBACK_GLAB_VERSION: &str = "1.107.0";

/// Cache file name for storing fetched versions
const GLAB_VERSIONS_CACHE_FILE: &str = "glab-versions-cache.json";

/// GitLab API URL for the `glab` project's releases (project path URL-encoded).
const GITLAB_RELEASES_API: &str = "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases";

/// Base for release asset downloads. GitLab exposes a stable redirect at
/// `/-/releases/v{version}/downloads/{asset}`.
const GLAB_RELEASE_DOWNLOAD_BASE: &str = "https://gitlab.com/gitlab-org/cli/-/releases";

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
    /// Version string (e.g., "1.107.0")
    pub version: String,
    /// Git tag name (e.g., "v1.107.0")
    pub tag_name: String,
    /// Publication date in ISO format
    pub published_at: String,
    /// Whether this is a prerelease / upcoming release
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

/// GitLab API release response structure
#[derive(Debug, Deserialize)]
struct GitLabRelease {
    tag_name: String,
    #[serde(default)]
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
    #[serde(default)]
    direct_asset_url: String,
}

/// Parse a version number out of `glab --version` output.
///
/// Tolerant of the various formats glab has used ("glab 1.2.3 (date)",
/// "glab version 1.2.3") — returns the first digit-leading token.
fn parse_glab_version(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .find(|t| {
            t.chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
        })
        .map(|s| {
            s.trim_end_matches(|c: char| !c.is_ascii_alphanumeric())
                .to_string()
        })
}

/// Check if GitLab CLI is installed and get its status
pub async fn check_glab_cli_installed(app: AppHandle) -> Result<GlabCliStatus, String> {
    log::trace!("Checking GitLab CLI installation status");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_glab_binary(&app);

    if wsl.enabled {
        let tool = binary_path.to_string_lossy().to_string();
        let installed = if tool.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &tool)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &tool)
        };
        if !installed {
            return Ok(GlabCliStatus {
                installed: false,
                version: None,
                path: None,
            });
        }
        let version = crate::platform::wsl_tool_version(&wsl.distro, &tool)
            .and_then(|v| parse_glab_version(&v));
        return Ok(GlabCliStatus {
            installed: true,
            version,
            path: Some(tool),
        });
    }

    if !binary_path.exists() {
        log::trace!("GitLab CLI not found at {:?}", binary_path);
        return Ok(GlabCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    // Use the binary directly - shell wrapper causes PowerShell parsing issues on Windows
    let version = match crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let version = parse_glab_version(&version_str).unwrap_or(version_str);
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

/// Get available GitLab CLI versions from the GitLab releases API.
///
/// Falls back to disk cache or a hardcoded version if the API is unreachable.
pub async fn get_available_glab_versions(app: AppHandle) -> Result<Vec<GlabReleaseInfo>, String> {
    log::trace!("Fetching available GitLab CLI versions from GitLab API");

    match fetch_glab_versions_from_api().await {
        Ok(versions) if !versions.is_empty() => {
            save_glab_versions_cache(&app, &versions);
            Ok(versions)
        }
        Ok(_empty) => {
            log::warn!("GitLab API returned empty releases, falling back to cache");
            Ok(load_glab_versions_cache(&app).unwrap_or_else(fallback_glab_versions))
        }
        Err(e) => {
            log::warn!("GitLab API request failed ({e}), falling back to cache");
            Ok(load_glab_versions_cache(&app).unwrap_or_else(fallback_glab_versions))
        }
    }
}

/// Fetch versions directly from the GitLab API (no fallback).
async fn fetch_glab_versions_from_api() -> Result<Vec<GlabReleaseInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(format!("{GITLAB_RELEASES_API}?per_page=20"))
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

    let versions: Vec<GlabReleaseInfo> = releases
        .into_iter()
        .filter(|r| !r.assets.links.is_empty())
        .take(5)
        .map(release_to_info)
        .collect();

    log::trace!("Found {} GitLab CLI versions from API", versions.len());
    Ok(versions)
}

/// Map a raw GitLab release into the frontend-facing info struct.
fn release_to_info(r: GitLabRelease) -> GlabReleaseInfo {
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
}

pub async fn check_glab_cli_version_exists(version: String) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    // GitLab release-by-tag endpoint: /releases/:tag_name
    let response = client
        .get(format!("{GITLAB_RELEASES_API}/v{version}"))
        .send()
        .await
        .map_err(|e| format!("Failed to check GitLab CLI version: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(format!("GitLab API returned status: {}", response.status()));
    }

    let release: GitLabRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitLab release: {e}"))?;
    Ok(!release.assets.links.is_empty())
}

/// Resolve a GitLab API token from environment variables.
///
/// Only environment variables are consulted — `glab` manages its own stored
/// credentials, which our shell-outs use directly. This is provided for future
/// raw-REST-API callers (e.g. security scanning).
pub fn resolve_gitlab_api_token() -> Option<String> {
    for key in ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "GL_TOKEN"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Cached versions structure for disk persistence
#[derive(Debug, Serialize, Deserialize)]
struct CachedGlabVersions {
    versions: Vec<GlabReleaseInfo>,
    fetched_at: String,
}

/// Save fetched versions to disk cache
fn save_glab_versions_cache(app: &AppHandle, versions: &[GlabReleaseInfo]) {
    let cache_path = match ensure_glab_cli_dir(app) {
        Ok(dir) => dir.join(GLAB_VERSIONS_CACHE_FILE),
        Err(e) => {
            log::warn!("Cannot resolve glab CLI dir for cache: {e}");
            return;
        }
    };

    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();

    let cached = CachedGlabVersions {
        versions: versions.to_vec(),
        fetched_at,
    };

    match serde_json::to_string(&cached) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&cache_path, json) {
                log::warn!("Failed to write glab versions cache: {e}");
            } else {
                log::trace!("Saved {} glab versions to cache", versions.len());
            }
        }
        Err(e) => log::warn!("Failed to serialize glab versions cache: {e}"),
    }
}

/// Load cached versions from disk
fn load_glab_versions_cache(app: &AppHandle) -> Option<Vec<GlabReleaseInfo>> {
    let cache_path = get_glab_cli_dir(app).ok()?.join(GLAB_VERSIONS_CACHE_FILE);
    let contents = std::fs::read_to_string(&cache_path).ok()?;
    let cached: CachedGlabVersions = serde_json::from_str(&contents).ok()?;
    if cached.versions.is_empty() {
        return None;
    }
    log::trace!(
        "Loaded {} cached glab versions (fetched at {})",
        cached.versions.len(),
        cached.fetched_at
    );
    Some(cached.versions)
}

/// Build a single-entry fallback version list from the hardcoded constant
fn fallback_glab_versions() -> Vec<GlabReleaseInfo> {
    vec![GlabReleaseInfo {
        version: FALLBACK_GLAB_VERSION.to_string(),
        tag_name: format!("v{FALLBACK_GLAB_VERSION}"),
        published_at: String::new(),
        prerelease: false,
    }]
}

/// Get the platform string for the current system (for glab releases).
///
/// Returns `(platform_string, archive_extension)`. Note glab uses `darwin`
/// (not `macOS`) and ships macOS as tar.gz (gh ships zip).
fn get_glab_platform() -> Result<(&'static str, &'static str), String> {
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

/// Platform string + archive extension for glab's Linux releases, used when
/// installing into WSL from a Windows host.
fn wsl_glab_platform(distro: &str) -> Result<(&'static str, &'static str), String> {
    match crate::platform::wsl_detect_arch(distro) {
        Some("linux-x64") => Ok(("linux_amd64", "tar.gz")),
        Some("linux-arm64") => Ok(("linux_arm64", "tar.gz")),
        _ => Err("Unsupported WSL architecture (expected x86_64 or aarch64)".to_string()),
    }
}

/// Install GitLab CLI by downloading from GitLab releases
pub async fn install_glab_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    log::trace!("Installing GitLab CLI, version: {:?}", version);

    // Agents may shell out to glab for GitLab operations — don't swap the
    // binary out from under a running session.
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot install GitLab CLI while {} Claude {} running. Please stop all active sessions first.",
            count,
            if count == 1 { "session is" } else { "sessions are" }
        ));
    }

    let wsl = crate::platform::get_wsl_config();

    emit_progress(&app, "starting", "Preparing installation...", 0);

    let version = match version {
        Some(v) => v.trim().trim_start_matches('v').to_string(),
        None => fetch_latest_glab_version(&app).await?,
    };

    let (platform, archive_ext) = if wsl.enabled {
        wsl_glab_platform(&wsl.distro)?
    } else {
        get_glab_platform()?
    };
    log::trace!("Installing version {version} for platform {platform}");

    // Format: {base}/v{version}/downloads/glab_{version}_{platform}.{ext}
    let archive_name = format!("glab_{version}_{platform}.{archive_ext}");
    let download_url = format!("{GLAB_RELEASE_DOWNLOAD_BASE}/v{version}/downloads/{archive_name}");
    log::trace!("Downloading from: {download_url}");

    emit_progress(&app, "downloading", "Downloading GitLab CLI...", 20);

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

    emit_progress(&app, "extracting", "Extracting archive...", 40);

    let binary_bytes = if archive_ext == "zip" {
        extract_glab_binary_from_zip(&archive_content, platform)?
    } else {
        extract_glab_binary_from_tar_gz(&archive_content)?
    };

    emit_progress(&app, "installing", "Installing GitLab CLI...", 60);

    if wsl.enabled {
        let unix_path = super::config::get_wsl_glab_binary_path(&wsl.distro)?;
        log::trace!("Writing glab binary into WSL at {unix_path}");
        crate::platform::wsl_write_bytes(&wsl.distro, &unix_path, &binary_bytes)
            .map_err(|e| format!("Failed to write binary into WSL: {e}"))?;
        crate::platform::wsl_chmod_exec(&wsl.distro, &unix_path)?;
        emit_progress(&app, "complete", "Installation complete!", 100);
        log::trace!("GitLab CLI installed successfully at WSL:{unix_path}");
        return Ok(());
    }

    let _cli_dir = ensure_glab_cli_dir(&app)?;
    let binary_path = get_glab_cli_binary_path(&app)?;

    crate::platform::write_binary_file(&binary_path, &binary_bytes)
        .map_err(|e| format!("Failed to copy binary: {e}"))?;

    emit_progress(&app, "verifying", "Verifying installation...", 80);

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

    log::trace!("Verifying binary at {:?}", binary_path);
    let version_output = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
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

    emit_progress(&app, "complete", "Installation complete!", 100);

    log::trace!("GitLab CLI installed successfully at {:?}", binary_path);
    Ok(())
}

/// Uninstall the Jean-managed GitLab CLI by deleting its directory.
///
/// Idempotent: returns `Ok(())` if the directory does not exist.
pub async fn uninstall_glab_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_glab_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove GitLab CLI directory: {e}"))?;
        log::info!("Removed Jean-managed GitLab CLI at {:?}", cli_dir);
    }
    Ok(())
}

/// Fetch the latest GitLab CLI version from the GitLab API.
///
/// Falls back to disk cache or the hardcoded version if the API is unreachable.
async fn fetch_latest_glab_version(app: &AppHandle) -> Result<String, String> {
    log::trace!("Fetching latest GitLab CLI version");

    if let Ok(versions) = fetch_glab_versions_from_api().await {
        if let Some(first) = versions.into_iter().find(|v| !v.prerelease) {
            log::trace!("Latest GitLab CLI version: {}", first.version);
            return Ok(first.version);
        }
    }

    log::warn!("Failed to fetch latest glab version from API, using fallback");
    if let Some(cached) = load_glab_versions_cache(app) {
        if let Some(first) = cached.into_iter().find(|v| !v.prerelease) {
            log::trace!("Using cached version: {}", first.version);
            return Ok(first.version);
        }
    }

    log::warn!("No cache available, using hardcoded fallback: {FALLBACK_GLAB_VERSION}");
    Ok(FALLBACK_GLAB_VERSION.to_string())
}

/// Extract the `glab` binary bytes from a zip archive (Windows release).
///
/// Matches by final path segment (the binary may sit at the archive root or
/// under `bin/`), skipping directory entries.
fn extract_glab_binary_from_zip(archive_content: &[u8], platform: &str) -> Result<Vec<u8>, String> {
    use std::io::{Cursor, Read};

    let expected_name = if platform.starts_with("windows_") {
        "glab.exe"
    } else {
        "glab"
    };

    let cursor = Cursor::new(archive_content);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        if !file.is_file() {
            continue;
        }
        let Some(path) = file.enclosed_name() else {
            continue;
        };
        let is_match = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == expected_name)
            .unwrap_or(false);
        if is_match {
            let mut data = Vec::new();
            file.read_to_end(&mut data)
                .map_err(|e| format!("Failed to read binary from zip: {e}"))?;
            return Ok(data);
        }
    }

    Err(format!(
        "Binary '{expected_name}' not found inside glab zip archive"
    ))
}

/// Extract the `glab` binary bytes from a tar.gz archive (macOS/Linux release).
///
/// Matches by final path segment, skipping non-file entries.
fn extract_glab_binary_from_tar_gz(archive_content: &[u8]) -> Result<Vec<u8>, String> {
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
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| format!("Failed to read tar entry path: {e}"))?;

        let is_match = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == "glab")
            .unwrap_or(false);
        if is_match {
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|e| format!("Failed to read binary from tar.gz: {e}"))?;
            return Ok(data);
        }
    }

    Err("Binary 'glab' not found inside glab tar.gz archive".to_string())
}

/// Result of checking GitLab CLI authentication status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabAuthStatus {
    /// Whether the CLI is authenticated
    pub authenticated: bool,
    /// Error message if authentication check failed
    pub error: Option<String>,
}

/// Check if GitLab CLI is authenticated by running `glab auth status`
pub async fn check_glab_cli_auth(app: AppHandle) -> Result<GlabAuthStatus, String> {
    log::trace!("Checking GitLab CLI authentication status");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_glab_binary(&app);

    if !wsl.enabled && !binary_path.exists() {
        return Ok(GlabAuthStatus {
            authenticated: false,
            error: Some("GitLab CLI not installed".to_string()),
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
            return Ok(GlabAuthStatus {
                authenticated: false,
                error: Some("GitLab CLI not installed inside WSL".to_string()),
            });
        }
    }

    log::trace!("Running auth check: {:?} auth status", binary_path);

    let binary_str = binary_path.to_string_lossy().to_string();
    let output = crate::platform::wsl_aware_command(&binary_str, None)
        .args(["auth", "status"])
        .output()
        .map_err(|e| format!("Failed to execute GitLab CLI: {e}"))?;

    if output.status.success() {
        // glab writes status to stderr; capture both for logging.
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        log::trace!("GitLab CLI auth check successful: {}", combined.trim());
        Ok(GlabAuthStatus {
            authenticated: true,
            error: None,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("GitLab CLI auth check failed: {}", stderr);
        Ok(GlabAuthStatus {
            authenticated: false,
            error: Some(stderr),
        })
    }
}

/// Result of detecting GitLab CLI in system PATH
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

/// Detect GitLab CLI in system PATH (excluding Jean-managed binary)
pub async fn detect_glab_in_path(app: AppHandle) -> Result<GlabPathDetection, String> {
    log::trace!("Detecting GitLab CLI in system PATH");

    let jean_managed_path = get_glab_cli_binary_path(&app)
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());
    let wsl = crate::platform::get_wsl_config();
    let jean_managed_wsl = if wsl.enabled {
        super::config::get_wsl_glab_binary_path(&wsl.distro).ok()
    } else {
        None
    };

    let detection = crate::platform::detect_cli_in_path(
        "glab",
        jean_managed_path.as_deref(),
        jean_managed_wsl.as_deref(),
    );

    if !detection.found {
        log::trace!("GitLab CLI not found in PATH");
        return Ok(GlabPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    }

    let version = detection.version.and_then(|v| parse_glab_version(&v));

    log::trace!(
        "Found GitLab CLI in PATH: {:?} (version: {:?}, pkg_mgr: {:?})",
        detection.path,
        version,
        detection.package_manager
    );

    Ok(GlabPathDetection {
        found: true,
        path: detection.path,
        version,
        package_manager: detection.package_manager,
    })
}

/// Helper function to emit installation progress events
fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let progress = GlabInstallProgress {
        stage: stage.to_string(),
        message: message.to_string(),
        percent,
    };

    if let Err(e) = app.emit_all("glab-cli:install-progress", &progress) {
        log::warn!("Failed to emit install progress: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_handles_formats() {
        assert_eq!(
            parse_glab_version("glab 1.107.0 (2026-07-07)").as_deref(),
            Some("1.107.0")
        );
        assert_eq!(
            parse_glab_version("glab version 1.22.0").as_deref(),
            Some("1.22.0")
        );
        assert_eq!(parse_glab_version("no version here"), None);
    }
}
