//! Tauri commands for GitHub CLI management

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

use super::config::{ensure_gh_cli_dir, get_gh_cli_binary_path, get_gh_cli_dir, resolve_gh_binary};
use crate::http_server::EmitExt;

/// Emergency fallback version when API fails AND no cache exists.
/// The download URL pattern is stable for any valid version, so staleness is acceptable.
const FALLBACK_GH_VERSION: &str = "2.74.0";

/// Cache file name for storing fetched versions
const GH_VERSIONS_CACHE_FILE: &str = "gh-versions-cache.json";

/// GitHub API URL for releases
const GITHUB_RELEASES_API: &str = "https://api.github.com/repos/cli/cli/releases";
const GITHUB_API_ACCEPT: &str = "application/vnd.github+json";
const GITHUB_API_VERSION: &str = "2022-11-28";

/// Status of the GitHub CLI installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhCliStatus {
    /// Whether GitHub CLI is installed
    pub installed: bool,
    /// Installed version (if any)
    pub version: Option<String>,
    /// Path to the CLI binary (if installed)
    pub path: Option<String>,
}

/// Information about a GitHub CLI release
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhReleaseInfo {
    /// Version string (e.g., "2.40.0")
    pub version: String,
    /// Git tag name (e.g., "v2.40.0")
    pub tag_name: String,
    /// Publication date in ISO format
    pub published_at: String,
    /// Whether this is a prerelease
    pub prerelease: bool,
}

/// Progress event for CLI installation
#[derive(Debug, Clone, Serialize)]
pub struct GhInstallProgress {
    /// Current stage of installation
    pub stage: String,
    /// Progress message
    pub message: String,
    /// Percentage complete (0-100)
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

/// Check if GitHub CLI is installed and get its status
pub async fn check_gh_cli_installed(app: AppHandle) -> Result<GhCliStatus, String> {
    log::trace!("Checking GitHub CLI installation status");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_gh_binary(&app);

    if wsl.enabled {
        let tool = binary_path.to_string_lossy().to_string();
        let installed = if tool.starts_with('/') {
            crate::platform::wsl_file_executable(&wsl.distro, &tool)
        } else {
            crate::platform::check_wsl_tool(&wsl.distro, &tool)
        };
        if !installed {
            return Ok(GhCliStatus {
                installed: false,
                version: None,
                path: None,
            });
        }
        let version = crate::platform::wsl_tool_version(&wsl.distro, &tool)
            .and_then(|v| v.split_whitespace().nth(2).map(|s| s.to_string()));
        return Ok(GhCliStatus {
            installed: true,
            version,
            path: Some(tool),
        });
    }

    if !binary_path.exists() {
        log::trace!("GitHub CLI not found at {:?}", binary_path);
        return Ok(GhCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    // Try to get the version by running gh --version
    // Use the binary directly - shell wrapper causes PowerShell parsing issues on Windows
    let version = match crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                // gh --version returns "gh version 2.40.0 (2024-01-15)"
                // Extract just the version number
                let version = version_str
                    .split_whitespace()
                    .nth(2)
                    .map(|s| s.to_string())
                    .unwrap_or(version_str);
                log::trace!("GitHub CLI version: {}", version);
                Some(version)
            } else {
                log::warn!("Failed to get GitHub CLI version");
                None
            }
        }
        Err(e) => {
            log::warn!("Failed to execute GitHub CLI: {}", e);
            None
        }
    };

    Ok(GhCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

/// Get available GitHub CLI versions from GitHub releases API.
///
/// Falls back to disk cache or a hardcoded version if the API is unreachable
/// (e.g., rate-limited on unauthenticated requests during first-time onboarding).
pub async fn get_available_gh_versions(app: AppHandle) -> Result<Vec<GhReleaseInfo>, String> {
    log::trace!("Fetching available GitHub CLI versions from GitHub API");

    match fetch_gh_versions_from_api(&app).await {
        Ok(versions) if !versions.is_empty() => {
            save_gh_versions_cache(&app, &versions);
            Ok(versions)
        }
        Ok(_empty) => {
            log::warn!("GitHub API returned empty releases, falling back to cache");
            Ok(load_gh_versions_cache(&app).unwrap_or_else(fallback_gh_versions))
        }
        Err(e) => {
            log::warn!("GitHub API request failed ({e}), falling back to cache");
            Ok(load_gh_versions_cache(&app).unwrap_or_else(fallback_gh_versions))
        }
    }
}

/// Fetch versions directly from the GitHub API (no fallback).
async fn fetch_gh_versions_from_api(app: &AppHandle) -> Result<Vec<GhReleaseInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let token = resolve_github_api_token(app);
    let mut request = client
        .get(GITHUB_RELEASES_API)
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

    let versions: Vec<GhReleaseInfo> = releases
        .into_iter()
        .filter(|r| !r.assets.is_empty())
        .take(5)
        .map(|r| {
            let version = r
                .tag_name
                .strip_prefix('v')
                .unwrap_or(&r.tag_name)
                .to_string();
            GhReleaseInfo {
                version,
                tag_name: r.tag_name,
                published_at: r.published_at,
                prerelease: r.prerelease,
            }
        })
        .collect();

    log::trace!("Found {} GitHub CLI versions from API", versions.len());
    Ok(versions)
}

pub async fn check_gh_cli_version_exists(app: AppHandle, version: String) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let token = resolve_github_api_token(&app);
    let mut request = client
        .get(format!("{GITHUB_RELEASES_API}/tags/v{version}"))
        .header("Accept", GITHUB_API_ACCEPT)
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION);
    if let Some(ref token) = token {
        request = request.bearer_auth(token);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to check GitHub CLI version: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub release: {e}"))?;
    Ok(!release.assets.is_empty())
}

/// Resolve a GitHub API token from environment or gh auth.
///
/// Priority:
/// 1) GH_TOKEN / GITHUB_TOKEN env vars
/// 2) `gh auth token` from Jean-managed gh binary
/// 3) `gh auth token` from PATH
pub fn resolve_github_api_token(app: &AppHandle) -> Option<String> {
    for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    let managed_gh = resolve_gh_binary(app);
    if crate::platform::resolved_cli_exists(&managed_gh) {
        candidates.push(managed_gh);
    } else if let Ok(path) = get_gh_cli_binary_path(app) {
        if path.exists() {
            candidates.push(path);
        }
    }
    candidates.push(PathBuf::from("gh"));

    for program in candidates {
        let output = match crate::platform::resolved_cli_command(&program, None)
            .args(["auth", "token"])
            .output()
        {
            Ok(output) => output,
            Err(_) => continue,
        };
        if !output.status.success() {
            continue;
        }
        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !token.is_empty() {
            return Some(token);
        }
    }

    None
}

/// Cached versions structure for disk persistence
#[derive(Debug, Serialize, Deserialize)]
struct CachedGhVersions {
    versions: Vec<GhReleaseInfo>,
    fetched_at: String,
}

/// Save fetched versions to disk cache
fn save_gh_versions_cache(app: &AppHandle, versions: &[GhReleaseInfo]) {
    let cache_path = match super::config::ensure_gh_cli_dir(app) {
        Ok(dir) => dir.join(GH_VERSIONS_CACHE_FILE),
        Err(e) => {
            log::warn!("Cannot resolve gh CLI dir for cache: {e}");
            return;
        }
    };

    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();

    let cached = CachedGhVersions {
        versions: versions.to_vec(),
        fetched_at,
    };

    match serde_json::to_string(&cached) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&cache_path, json) {
                log::warn!("Failed to write gh versions cache: {e}");
            } else {
                log::trace!("Saved {} gh versions to cache", versions.len());
            }
        }
        Err(e) => log::warn!("Failed to serialize gh versions cache: {e}"),
    }
}

/// Load cached versions from disk
fn load_gh_versions_cache(app: &AppHandle) -> Option<Vec<GhReleaseInfo>> {
    let cache_path = super::config::get_gh_cli_dir(app)
        .ok()?
        .join(GH_VERSIONS_CACHE_FILE);
    let contents = std::fs::read_to_string(&cache_path).ok()?;
    let cached: CachedGhVersions = serde_json::from_str(&contents).ok()?;
    if cached.versions.is_empty() {
        return None;
    }
    log::trace!(
        "Loaded {} cached gh versions (fetched at {})",
        cached.versions.len(),
        cached.fetched_at
    );
    Some(cached.versions)
}

/// Build a single-entry fallback version list from the hardcoded constant
fn fallback_gh_versions() -> Vec<GhReleaseInfo> {
    vec![GhReleaseInfo {
        version: FALLBACK_GH_VERSION.to_string(),
        tag_name: format!("v{FALLBACK_GH_VERSION}"),
        published_at: String::new(),
        prerelease: false,
    }]
}

/// Get the platform string for the current system (for gh releases)
fn get_gh_platform() -> Result<(&'static str, &'static str), String> {
    // Returns (platform_string, archive_extension)
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok(("macOS_arm64", "zip"));
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok(("macOS_amd64", "zip"));
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

/// Platform string + archive extension for gh's Linux releases, used when
/// installing into WSL from a Windows host.
fn wsl_gh_platform(distro: &str) -> Result<(&'static str, &'static str), String> {
    match crate::platform::wsl_detect_arch(distro) {
        Some("linux-x64") => Ok(("linux_amd64", "tar.gz")),
        Some("linux-arm64") => Ok(("linux_arm64", "tar.gz")),
        _ => Err("Unsupported WSL architecture (expected x86_64 or aarch64)".to_string()),
    }
}

/// Install GitHub CLI by downloading from GitHub releases
pub async fn install_gh_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    log::trace!("Installing GitHub CLI, version: {:?}", version);

    // Check if any Claude processes are running - Claude may use gh for GitHub operations
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        let count = running_sessions.len();
        return Err(format!(
            "Cannot install GitHub CLI while {} Claude {} running. Please stop all active sessions first.",
            count,
            if count == 1 { "session is" } else { "sessions are" }
        ));
    }

    let wsl = crate::platform::get_wsl_config();

    // Emit progress: starting
    emit_progress(&app, "starting", "Preparing installation...", 0);

    // Determine version (use provided or fetch latest)
    let version = match version {
        Some(v) => v,
        None => fetch_latest_gh_version(&app).await?,
    };

    // Detect platform — native host vs WSL distro.
    let (platform, archive_ext) = if wsl.enabled {
        wsl_gh_platform(&wsl.distro)?
    } else {
        get_gh_platform()?
    };
    log::trace!("Installing version {version} for platform {platform}");

    // Build download URL
    // Format: https://github.com/cli/cli/releases/download/v{version}/gh_{version}_{platform}.{ext}
    let archive_name = format!("gh_{version}_{platform}.{archive_ext}");
    let download_url =
        format!("https://github.com/cli/cli/releases/download/v{version}/{archive_name}");
    log::trace!("Downloading from: {download_url}");

    // Emit progress: downloading
    emit_progress(&app, "downloading", "Downloading GitHub CLI...", 20);

    // Download the archive
    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download GitHub CLI: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download GitHub CLI: HTTP {}",
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

    // Extract the `gh` binary bytes from the archive in-memory. Works for
    // both native installs and WSL (target filesystem is decided below).
    let binary_bytes = if archive_ext == "zip" {
        extract_gh_binary_from_zip(&archive_content, &version, platform)?
    } else {
        extract_gh_binary_from_tar_gz(&archive_content, &version, platform)?
    };

    emit_progress(&app, "installing", "Installing GitHub CLI...", 60);

    if wsl.enabled {
        // WSL branch: stream the binary into the distro and make it executable.
        let unix_path = super::config::get_wsl_gh_binary_path(&wsl.distro)?;
        log::trace!("Writing gh binary into WSL at {unix_path}");
        crate::platform::wsl_write_bytes(&wsl.distro, &unix_path, &binary_bytes)
            .map_err(|e| format!("Failed to write binary into WSL: {e}"))?;
        crate::platform::wsl_chmod_exec(&wsl.distro, &unix_path)?;
        emit_progress(&app, "complete", "Installation complete!", 100);
        log::trace!("GitHub CLI installed successfully at WSL:{unix_path}");
        return Ok(());
    }

    let _cli_dir = ensure_gh_cli_dir(&app)?;
    let binary_path = get_gh_cli_binary_path(&app)?;

    // Write the binary to the final location.
    // Use write_binary_file to handle Windows file-locking (OS error 32).
    crate::platform::write_binary_file(&binary_path, &binary_bytes)
        .map_err(|e| format!("Failed to copy binary: {e}"))?;

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

    // Verify the binary works
    // Use the binary directly - shell wrapper causes PowerShell parsing issues on Windows
    log::trace!("Verifying binary at {:?}", binary_path);
    let version_output = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to verify GitHub CLI: {e}"))?;

    if !version_output.status.success() {
        let stderr = String::from_utf8_lossy(&version_output.stderr);
        let stdout = String::from_utf8_lossy(&version_output.stdout);
        log::error!(
            "GitHub CLI verification failed - exit code: {:?}, stdout: {}, stderr: {}",
            version_output.status.code(),
            stdout,
            stderr
        );
        return Err(format!(
            "GitHub CLI binary verification failed: {}",
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
    log::trace!("Verified GitHub CLI version: {installed_version}");

    // Emit progress: complete
    emit_progress(&app, "complete", "Installation complete!", 100);

    log::trace!("GitHub CLI installed successfully at {:?}", binary_path);
    Ok(())
}

/// Uninstall the Jean-managed GitHub CLI by deleting its directory.
///
/// Idempotent: returns `Ok(())` if the directory does not exist.
pub async fn uninstall_gh_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_gh_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove GitHub CLI directory: {e}"))?;
        log::info!("Removed Jean-managed GitHub CLI at {:?}", cli_dir);
    }
    Ok(())
}

/// Fetch the latest GitHub CLI version from GitHub API.
///
/// Falls back to disk cache or hardcoded version if the API is unreachable.
async fn fetch_latest_gh_version(app: &AppHandle) -> Result<String, String> {
    log::trace!("Fetching latest GitHub CLI version");

    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(format!("{GITHUB_RELEASES_API}/latest"))
        .send()
        .await;

    if let Ok(resp) = response {
        if resp.status().is_success() {
            if let Ok(release) = resp.json::<GitHubRelease>().await {
                let version = release
                    .tag_name
                    .strip_prefix('v')
                    .unwrap_or(&release.tag_name)
                    .to_string();
                log::trace!("Latest GitHub CLI version: {version}");
                return Ok(version);
            }
        }
    }

    // API failed — try disk cache, then hardcoded fallback
    log::warn!("Failed to fetch latest gh version from API, using fallback");
    if let Some(cached) = load_gh_versions_cache(app) {
        if let Some(first) = cached.into_iter().find(|v| !v.prerelease) {
            log::trace!("Using cached version: {}", first.version);
            return Ok(first.version);
        }
    }

    log::warn!("No cache available, using hardcoded fallback: {FALLBACK_GH_VERSION}");
    Ok(FALLBACK_GH_VERSION.to_string())
}

/// Extract the `gh` binary bytes from a zip archive (macOS/Windows release).
///
/// The archive may place the binary under `gh_<version>_<platform>/bin/gh[.exe]`
/// (macOS) or under `bin/gh.exe` (Windows) — match by final path segment.
fn extract_gh_binary_from_zip(
    archive_content: &[u8],
    _version: &str,
    platform: &str,
) -> Result<Vec<u8>, String> {
    use std::io::{Cursor, Read};

    let expected_name = if platform.starts_with("windows_") {
        "gh.exe"
    } else {
        "gh"
    };

    let cursor = Cursor::new(archive_content);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let Some(path) = file.enclosed_name() else {
            continue;
        };
        let is_match = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == expected_name)
            .unwrap_or(false)
            && path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|n| n == "bin")
                .unwrap_or(false);
        if is_match {
            let mut data = Vec::new();
            file.read_to_end(&mut data)
                .map_err(|e| format!("Failed to read binary from zip: {e}"))?;
            return Ok(data);
        }
    }

    Err(format!(
        "Binary '{expected_name}' not found inside gh zip archive"
    ))
}

/// Extract the `gh` binary bytes from a tar.gz archive (Linux release).
///
/// The binary lives at `gh_<version>_<platform>/bin/gh`; match by final
/// path segment so we don't depend on the version substring (and stay
/// tolerant of any future layout tweaks).
fn extract_gh_binary_from_tar_gz(
    archive_content: &[u8],
    _version: &str,
    _platform: &str,
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
            .map_err(|e| format!("Failed to read tar entry path: {e}"))?;

        let is_match = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == "gh")
            .unwrap_or(false)
            && path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|n| n == "bin")
                .unwrap_or(false);
        if is_match {
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|e| format!("Failed to read binary from tar.gz: {e}"))?;
            return Ok(data);
        }
    }

    Err("Binary 'gh' not found inside gh tar.gz archive".to_string())
}

/// Result of checking GitHub CLI authentication status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhAuthStatus {
    /// Whether the CLI is authenticated
    pub authenticated: bool,
    /// Error message if authentication check failed
    pub error: Option<String>,
}

/// Check if GitHub CLI is authenticated by running `gh auth status`
pub async fn check_gh_cli_auth(app: AppHandle) -> Result<GhAuthStatus, String> {
    log::trace!("Checking GitHub CLI authentication status");

    let wsl = crate::platform::get_wsl_config();
    let binary_path = resolve_gh_binary(&app);

    if !wsl.enabled && !binary_path.exists() {
        return Ok(GhAuthStatus {
            authenticated: false,
            error: Some("GitHub CLI not installed".to_string()),
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
            return Ok(GhAuthStatus {
                authenticated: false,
                error: Some("GitHub CLI not installed inside WSL".to_string()),
            });
        }
    }

    // Run gh auth status to check authentication
    log::trace!("Running auth check: {:?} auth status --active", binary_path);

    let binary_str = binary_path.to_string_lossy().to_string();
    let output = crate::platform::wsl_aware_command(&binary_str, None)
        .args(["auth", "status", "--active"])
        .output()
        .map_err(|e| format!("Failed to execute GitHub CLI: {e}"))?;

    // gh auth status returns exit code 0 if authenticated, non-zero otherwise
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        log::trace!("GitHub CLI auth check successful: {}", stdout);
        Ok(GhAuthStatus {
            authenticated: true,
            error: None,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("GitHub CLI auth check failed: {}", stderr);
        Ok(GhAuthStatus {
            authenticated: false,
            error: Some(stderr),
        })
    }
}

/// Result of detecting GitHub CLI in system PATH
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GhPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

/// Detect GitHub CLI in system PATH (excluding Jean-managed binary)
pub async fn detect_gh_in_path(app: AppHandle) -> Result<GhPathDetection, String> {
    log::trace!("Detecting GitHub CLI in system PATH");

    let jean_managed_path = get_gh_cli_binary_path(&app)
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());
    let wsl = crate::platform::get_wsl_config();
    let jean_managed_wsl = if wsl.enabled {
        super::config::get_wsl_gh_binary_path(&wsl.distro).ok()
    } else {
        None
    };

    let detection = crate::platform::detect_cli_in_path(
        "gh",
        jean_managed_path.as_deref(),
        jean_managed_wsl.as_deref(),
    );

    if !detection.found {
        log::trace!("GitHub CLI not found in PATH");
        return Ok(GhPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    }

    let version = detection
        .version
        .and_then(|v| v.split_whitespace().nth(2).map(|s| s.to_string()));

    log::trace!(
        "Found GitHub CLI in PATH: {:?} (version: {:?}, pkg_mgr: {:?})",
        detection.path,
        version,
        detection.package_manager
    );

    Ok(GhPathDetection {
        found: true,
        path: detection.path,
        version,
        package_manager: detection.package_manager,
    })
}

/// Helper function to emit installation progress events
fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    let progress = GhInstallProgress {
        stage: stage.to_string(),
        message: message.to_string(),
        percent,
    };

    if let Err(e) = app.emit_all("gh-cli:install-progress", &progress) {
        log::warn!("Failed to emit install progress: {}", e);
    }
}
