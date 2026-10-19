//! Tauri commands for GitLab CLI management

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

fn missing_glab_status() -> GlabCliStatus {
    GlabCliStatus {
        installed: false,
        version: None,
        path: None,
    }
}

/// Status for a binary that exists. Version text is parsed when possible and
/// otherwise kept as the trimmed command output.
fn installed_glab_status(version_output: Option<&str>, path: String) -> GlabCliStatus {
    let version = version_output.map(|raw| {
        let trimmed = raw.trim();
        parse_glab_version(trimmed).unwrap_or_else(|| trimmed.to_string())
    });
    GlabCliStatus {
        installed: true,
        version,
        path: Some(path),
    }
}

/// Official archive filename, shared by the download URL and checksums.txt.
fn glab_archive_name(version: &str, platform: &str, archive_ext: &str) -> String {
    format!("glab_{version}_{platform}.{archive_ext}")
}

/// Official glab release asset URL for one version and platform.
fn glab_release_asset_url(version: &str, platform: &str, archive_ext: &str) -> String {
    format!(
        "{GLAB_RELEASE_DOWNLOAD_BASE}/v{version}/downloads/{}",
        glab_archive_name(version, platform, archive_ext)
    )
}

/// SHA256 manifest published next to the release archives.
fn glab_checksums_url(version: &str) -> String {
    format!("{GLAB_RELEASE_DOWNLOAD_BASE}/v{version}/downloads/checksums.txt")
}

/// Find the hex digest for `archive_name` in a `checksums.txt` body.
///
/// Accepts `sha256sum` lines (`<digest>  <name>` and `<digest> *<name>`).
fn expected_glab_checksum<'a>(checksums: &'a str, archive_name: &str) -> Option<&'a str> {
    checksums.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let mut parts = line.split_whitespace();
        let checksum = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == archive_name).then_some(checksum)
    })
}

/// Compare the archive bytes to the matching `checksums.txt` entry.
fn verify_glab_archive_checksum(
    archive: &[u8],
    checksums: &str,
    archive_name: &str,
) -> Result<(), String> {
    let expected = expected_glab_checksum(checksums, archive_name)
        .ok_or_else(|| format!("GitLab CLI checksums.txt has no entry for {archive_name}"))?;
    let actual = format!("{:x}", Sha256::digest(archive));
    if !actual.eq_ignore_ascii_case(expected.trim()) {
        return Err(format!(
            "GitLab CLI checksum mismatch for {archive_name}: expected {expected}, got {actual}"
        ));
    }
    Ok(())
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
            return Ok(missing_glab_status());
        }
        let version_output = crate::platform::wsl_tool_version(&wsl.distro, &tool);
        return Ok(installed_glab_status(version_output.as_deref(), tool));
    }

    if !binary_path.exists() {
        log::trace!("GitLab CLI not found at {:?}", binary_path);
        return Ok(missing_glab_status());
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

    Ok(installed_glab_status(
        version.as_deref(),
        binary_path.to_string_lossy().to_string(),
    ))
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
            "Cannot install GitLab CLI while {count} {} running. Please stop all active sessions first.",
            if count == 1 {
                "session is"
            } else {
                "sessions are"
            }
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

    let archive_name = glab_archive_name(&version, platform, archive_ext);
    let download_url = glab_release_asset_url(&version, platform, archive_ext);
    let checksums_url = glab_checksums_url(&version);
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

    let checksums_response = client
        .get(&checksums_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download GitLab CLI checksums: {e}"))?;
    if !checksums_response.status().is_success() {
        return Err(format!(
            "Failed to download GitLab CLI checksums: HTTP {}",
            checksums_response.status()
        ));
    }
    let checksums = checksums_response
        .text()
        .await
        .map_err(|e| format!("Failed to read GitLab CLI checksums: {e}"))?;
    verify_glab_archive_checksum(&archive_content, &checksums, &archive_name)?;

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

        emit_progress(&app, "verifying", "Verifying installation...", 80);
        let Some(installed_version) = crate::platform::wsl_tool_version(&wsl.distro, &unix_path)
        else {
            return Err(
                "GitLab CLI binary verification failed: could not run glab --version inside WSL"
                    .to_string(),
            );
        };
        log::trace!("Verified GitLab CLI version: {installed_version}");

        emit_progress(&app, "complete", "Installation complete!", 100);
        #[cfg(windows)]
        crate::expose_managed_cli_in_wsl(&wsl.distro, "glab", &unix_path);
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
    crate::expose_managed_cli("glab", &binary_path);
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

/// Arguments for `glab auth status`.
///
/// A known project or remote host is passed as `--hostname`. An empty host is
/// omitted so the caller can treat any configured instance as signed in.
fn glab_auth_status_args(hostname: Option<&str>) -> Vec<String> {
    let mut args = vec!["auth".to_string(), "status".to_string()];
    if let Some(host) = hostname.map(str::trim).filter(|host| !host.is_empty()) {
        args.push("--hostname".to_string());
        args.push(host.to_string());
    }
    args
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
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

/// Hosts with a successful `Logged in to <host> as` line.
///
/// `glab auth status` prints that line only after the user API call succeeds.
/// Checkmarks on protocol/token lines are not authentication.
fn glab_logged_in_hosts(output: &str) -> Vec<String> {
    let plain = strip_ansi(output);
    let mut hosts = Vec::new();
    for line in plain.lines() {
        let lower = line.to_ascii_lowercase();
        let Some(idx) = lower.find("logged in to ") else {
            continue;
        };
        if lower[..idx].ends_with("not ") {
            continue;
        }
        let rest = line[idx + "logged in to ".len()..].trim();
        let Some(host) = rest.split_whitespace().next() else {
            continue;
        };
        let host = host.trim_matches(|c: char| matches!(c, ',' | '.' | '(' | ')'));
        if host.is_empty() || host.eq_ignore_ascii_case("as") {
            continue;
        }
        hosts.push(host.to_string());
    }
    hosts
}

/// Whether `glab auth status` output means the user is signed in.
///
/// With a hostname, only that host counts. A targeted command that exits 0
/// still counts when the success line cannot be parsed. With no hostname, any
/// configured host that is logged in counts — `glab` exits 1 when another
/// instance fails (`could not authenticate to one or more of the configured
/// GitLab instances`).
fn glab_auth_status_authenticated(exit_ok: bool, output: &str, hostname: Option<&str>) -> bool {
    let hosts = glab_logged_in_hosts(output);
    if let Some(host) = hostname.map(str::trim).filter(|host| !host.is_empty()) {
        if hosts
            .iter()
            .any(|logged_in| logged_in.eq_ignore_ascii_case(host))
        {
            return true;
        }
        return exit_ok && hosts.is_empty();
    }
    !hosts.is_empty() || exit_ok
}

/// Check if GitLab CLI is authenticated by running `glab auth status`.
///
/// `hostname` is the project or remote GitLab host when one is known.
pub async fn check_glab_cli_auth(
    app: AppHandle,
    hostname: Option<String>,
) -> Result<GlabAuthStatus, String> {
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

    let hostname = hostname
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty());
    let args = glab_auth_status_args(hostname);
    log::trace!("Running auth check: {:?} {}", binary_path, args.join(" "));

    let binary_str = binary_path.to_string_lossy().to_string();
    let output = crate::platform::wsl_aware_command(&binary_str, None)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute GitLab CLI: {e}"))?;

    // glab writes status to stderr. A non-zero exit only means every checked
    // host failed when no hostname was requested.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}{stderr}");
    if glab_auth_status_authenticated(output.status.success(), &combined, hostname) {
        log::trace!("GitLab CLI auth check successful: {}", combined.trim());
        Ok(GlabAuthStatus {
            authenticated: true,
            error: None,
        })
    } else {
        let stderr = stderr.trim();
        let detail = if stderr.is_empty() {
            stdout.trim()
        } else {
            stderr
        };
        log::warn!("GitLab CLI auth check failed: {detail}");
        Ok(GlabAuthStatus {
            authenticated: false,
            error: Some(if detail.is_empty() {
                "GitLab CLI is not authenticated".to_string()
            } else {
                detail.to_string()
            }),
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

    #[test]
    fn missing_status_reports_not_installed() {
        let status = missing_glab_status();
        assert!(!status.installed);
        assert!(status.version.is_none());
        assert!(status.path.is_none());
    }

    #[test]
    fn installed_status_parses_version_and_keeps_path() {
        let status = installed_glab_status(
            Some("glab 1.107.0 (2026-07-07)\n"),
            "/home/user/.local/share/jean/glab-cli/glab".to_string(),
        );
        assert!(status.installed);
        assert_eq!(status.version.as_deref(), Some("1.107.0"));
        assert_eq!(
            status.path.as_deref(),
            Some("/home/user/.local/share/jean/glab-cli/glab")
        );
    }

    #[test]
    fn release_asset_urls_match_official_glab_names() {
        assert_eq!(
            glab_release_asset_url("1.107.0", "linux_amd64", "tar.gz"),
            "https://gitlab.com/gitlab-org/cli/-/releases/v1.107.0/downloads/glab_1.107.0_linux_amd64.tar.gz"
        );
        assert_eq!(
            glab_release_asset_url("1.107.0", "linux_arm64", "tar.gz"),
            "https://gitlab.com/gitlab-org/cli/-/releases/v1.107.0/downloads/glab_1.107.0_linux_arm64.tar.gz"
        );
        assert_eq!(
            glab_release_asset_url("1.107.0", "darwin_arm64", "tar.gz"),
            "https://gitlab.com/gitlab-org/cli/-/releases/v1.107.0/downloads/glab_1.107.0_darwin_arm64.tar.gz"
        );
        assert_eq!(
            glab_release_asset_url("1.107.0", "darwin_amd64", "tar.gz"),
            "https://gitlab.com/gitlab-org/cli/-/releases/v1.107.0/downloads/glab_1.107.0_darwin_amd64.tar.gz"
        );
        assert_eq!(
            glab_release_asset_url("1.107.0", "windows_amd64", "zip"),
            "https://gitlab.com/gitlab-org/cli/-/releases/v1.107.0/downloads/glab_1.107.0_windows_amd64.zip"
        );
        assert_eq!(
            glab_release_asset_url("1.107.0", "windows_arm64", "zip"),
            "https://gitlab.com/gitlab-org/cli/-/releases/v1.107.0/downloads/glab_1.107.0_windows_arm64.zip"
        );
    }

    #[test]
    fn current_platform_uses_an_official_asset_name() {
        let (platform, ext) = get_glab_platform().expect("supported platform");
        let url = glab_release_asset_url("1.107.0", platform, ext);
        assert!(url.starts_with("https://gitlab.com/gitlab-org/cli/-/releases/v1.107.0/downloads/"));
        assert!(url.ends_with(&format!("glab_1.107.0_{platform}.{ext}")));
        assert_eq!(
            glab_checksums_url("1.107.0"),
            "https://gitlab.com/gitlab-org/cli/-/releases/v1.107.0/downloads/checksums.txt"
        );
    }

    #[test]
    fn auth_status_args_include_hostname_only_when_known() {
        assert_eq!(
            glab_auth_status_args(None),
            vec!["auth".to_string(), "status".to_string()]
        );
        assert_eq!(
            glab_auth_status_args(Some("  ")),
            vec!["auth".to_string(), "status".to_string()]
        );
        assert_eq!(
            glab_auth_status_args(Some(" git.example.com ")),
            vec![
                "auth".to_string(),
                "status".to_string(),
                "--hostname".to_string(),
                "git.example.com".to_string(),
            ]
        );
    }

    fn mixed_host_status() -> &'static str {
        "\
gitlab.com
  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}
  ✓ Git operations for gitlab.com configured to use ssh protocol.
  ✓ Token found: **************************
git.example.com
  \u{1b}[32m✓\u{1b}[0m Logged in to git.example.com as alice (keyring)
  ✓ Git operations for git.example.com configured to use https protocol.
x could not authenticate to one or more of the configured GitLab instances.
"
    }

    #[test]
    fn auth_status_treats_any_logged_in_host_as_signed_in() {
        let output = mixed_host_status();
        assert!(glab_auth_status_authenticated(false, output, None));
        assert!(glab_auth_status_authenticated(
            false,
            output,
            Some("git.example.com")
        ));
        assert!(glab_auth_status_authenticated(
            false,
            output,
            Some("Git.Example.com")
        ));
        assert!(!glab_auth_status_authenticated(
            false,
            output,
            Some("gitlab.com")
        ));
        assert_eq!(
            glab_logged_in_hosts(output),
            vec!["git.example.com".to_string()]
        );
    }

    #[test]
    fn auth_status_without_a_login_line_follows_the_exit_code() {
        let failed = "\
gitlab.com
  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401
x could not authenticate to one or more of the configured GitLab instances.
";
        assert!(!glab_auth_status_authenticated(false, failed, None));
        assert!(!glab_auth_status_authenticated(
            false,
            "not logged in to git.example.com",
            None
        ));
        assert!(glab_auth_status_authenticated(
            true,
            "gitlab.com\n",
            Some("gitlab.com")
        ));
        assert!(!glab_auth_status_authenticated(
            false,
            "",
            Some("gitlab.com")
        ));
    }

    #[test]
    fn checksums_txt_selects_the_archive_line() {
        let checksums = "\
abc  glab_1.107.0_linux_arm64.tar.gz\n\
eb42f56eb1a789cf4f22aa5960ff0ef60cf1e7fc1295327501f9f59030d5ae2c  glab_1.107.0_linux_amd64.tar.gz\n\
def *glab_1.107.0_windows_amd64.zip\n";
        assert_eq!(
            expected_glab_checksum(checksums, "glab_1.107.0_linux_amd64.tar.gz"),
            Some("eb42f56eb1a789cf4f22aa5960ff0ef60cf1e7fc1295327501f9f59030d5ae2c")
        );
        assert_eq!(
            expected_glab_checksum(checksums, "glab_1.107.0_windows_amd64.zip"),
            Some("def")
        );
        assert_eq!(
            expected_glab_checksum(checksums, "glab_1.107.0_darwin_arm64.tar.gz"),
            None
        );
    }

    #[test]
    fn checksum_mismatch_and_missing_entry_fail() {
        let bytes = b"not-a-real-archive";
        let actual = format!("{:x}", Sha256::digest(bytes));
        let name = "glab_1.2.3_linux_amd64.tar.gz";

        let mismatch =
            verify_glab_archive_checksum(bytes, &format!("deadbeef  {name}\n"), name).unwrap_err();
        assert!(mismatch.contains("checksum mismatch"), "{mismatch}");
        assert!(mismatch.contains(name), "{mismatch}");
        assert!(mismatch.contains("deadbeef"), "{mismatch}");
        assert!(mismatch.contains(&actual), "{mismatch}");

        let missing = verify_glab_archive_checksum(bytes, "abc  other.tar.gz\n", name).unwrap_err();
        assert!(missing.contains("no entry"), "{missing}");
        assert!(missing.contains(name), "{missing}");

        let ok = format!("{actual}  {name}\n");
        assert!(verify_glab_archive_checksum(bytes, &ok, name).is_ok());
    }
}
