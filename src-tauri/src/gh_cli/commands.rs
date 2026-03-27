//! Tauri commands for GitHub CLI management

use crate::platform::silent_command;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

use super::config::{ensure_gh_cli_dir, get_gh_cli_binary_path, resolve_gh_binary};
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
#[tauri::command]
pub async fn check_gh_cli_installed(app: AppHandle) -> Result<GhCliStatus, String> {
    log::trace!("Checking GitHub CLI installation status");

    let binary_path = resolve_gh_binary(&app);

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
    let version = match silent_command(&binary_path).arg("--version").output() {
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
#[tauri::command]
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
    if managed_gh.exists() {
        candidates.push(managed_gh);
    } else if let Ok(path) = get_gh_cli_binary_path(app) {
        if path.exists() {
            candidates.push(path);
        }
    }
    candidates.push(PathBuf::from("gh"));

    for program in candidates {
        let output = match silent_command(&program).args(["auth", "token"]).output() {
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
    let cache_path = match super::config::get_gh_cli_dir(app) {
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
    let cache_path = super::config::get_gh_cli_dir(app).ok()?.join(GH_VERSIONS_CACHE_FILE);
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

/// Install GitHub CLI by downloading from GitHub releases
#[tauri::command]
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

    let cli_dir = ensure_gh_cli_dir(&app)?;
    let binary_path = get_gh_cli_binary_path(&app)?;

    // Emit progress: starting
    emit_progress(&app, "starting", "Preparing installation...", 0);

    // Determine version (use provided or fetch latest)
    let version = match version {
        Some(v) => v,
        None => fetch_latest_gh_version(&app).await?,
    };

    // Detect platform
    let (platform, archive_ext) = get_gh_platform()?;
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

    // Create temp directory for extraction
    let temp_dir = cli_dir.join("temp");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    // Extract the archive
    let extracted_binary_path = if archive_ext == "zip" {
        extract_zip(&archive_content, &temp_dir, &version, platform)?
    } else {
        extract_tar_gz(&archive_content, &temp_dir, &version, platform)?
    };

    // Emit progress: installing
    emit_progress(&app, "installing", "Installing GitHub CLI...", 60);

    // Move binary to final location
    // Use write_binary_file to handle Windows file-locking (OS error 32)
    let binary_content = std::fs::read(&extracted_binary_path)
        .map_err(|e| format!("Failed to read extracted binary: {e}"))?;
    crate::platform::write_binary_file(&binary_path, &binary_content)
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

    // Verify the binary works
    // Use the binary directly - shell wrapper causes PowerShell parsing issues on Windows
    log::trace!("Verifying binary at {:?}", binary_path);
    let version_output = silent_command(&binary_path)
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

/// Extract gh binary from a zip archive (macOS, Windows)
fn extract_zip(
    archive_content: &[u8],
    temp_dir: &std::path::Path,
    version: &str,
    platform: &str,
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

    // The binary is at gh_{version}_{platform}/bin/gh (or gh.exe on Windows)
    // Some archives (e.g., Windows) don't have the version-platform prefix directory
    #[cfg(not(target_os = "windows"))]
    let binary_name = "gh";
    #[cfg(target_os = "windows")]
    let binary_name = "gh.exe";

    // Try with version-platform prefix directory first (Linux/macOS archives)
    let binary_path = temp_dir
        .join(format!("gh_{version}_{platform}"))
        .join("bin")
        .join(binary_name);

    if binary_path.exists() {
        return Ok(binary_path);
    }

    // Try without prefix directory (Windows archives)
    let binary_path_no_prefix = temp_dir.join("bin").join(binary_name);

    if binary_path_no_prefix.exists() {
        return Ok(binary_path_no_prefix);
    }

    Err(format!(
        "Binary not found in archive at {:?} or {:?}",
        binary_path, binary_path_no_prefix
    ))
}

/// Extract gh binary from a tar.gz archive (Linux)
fn extract_tar_gz(
    archive_content: &[u8],
    temp_dir: &std::path::Path,
    version: &str,
    platform: &str,
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

    // The binary is at gh_{version}_{platform}/bin/gh
    let binary_path = temp_dir
        .join(format!("gh_{version}_{platform}"))
        .join("bin")
        .join("gh");

    if !binary_path.exists() {
        return Err(format!("Binary not found in archive at {:?}", binary_path));
    }

    Ok(binary_path)
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
#[tauri::command]
pub async fn check_gh_cli_auth(app: AppHandle) -> Result<GhAuthStatus, String> {
    log::trace!("Checking GitHub CLI authentication status");

    let binary_path = resolve_gh_binary(&app);

    if !binary_path.exists() {
        return Ok(GhAuthStatus {
            authenticated: false,
            error: Some("GitHub CLI not installed".to_string()),
        });
    }

    // Run gh auth status to check authentication
    log::trace!("Running auth check: {:?} auth status", binary_path);

    let output = silent_command(&binary_path)
        .args(["auth", "status"])
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
#[tauri::command]
pub async fn detect_gh_in_path(app: AppHandle) -> Result<GhPathDetection, String> {
    log::trace!("Detecting GitHub CLI in system PATH");

    let jean_managed_path = get_gh_cli_binary_path(&app)
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = match silent_command(which_cmd).arg("gh").output() {
        Ok(output) if output.status.success() => {
            // On Windows, `where` can return multiple paths; take only the first line
            String::from_utf8_lossy(&output.stdout).lines().next().unwrap_or("").trim().to_string()
        }
        _ => {
            log::trace!("GitHub CLI not found in PATH");
            return Ok(GhPathDetection {
                found: false,
                path: None,
                version: None,
                package_manager: None,
            });
        }
    };

    if output.is_empty() {
        return Ok(GhPathDetection {
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
                log::trace!("Found PATH gh is the Jean-managed binary, excluding");
                return Ok(GhPathDetection {
                    found: false,
                    path: None,
                    version: None,
                    package_manager: None,
                });
            }
        }
    }

    // gh --version returns "gh version 2.40.0 (2024-01-15)"
    let version = match silent_command(&found_path).arg("--version").output() {
        Ok(ver_output) if ver_output.status.success() => {
            let ver_str = String::from_utf8_lossy(&ver_output.stdout).trim().to_string();
            ver_str
                .split_whitespace()
                .nth(2)
                .map(|s| s.to_string())
        }
        _ => None,
    };

    let package_manager = crate::platform::detect_package_manager(&found_path);

    log::trace!("Found GitHub CLI in PATH: {output} (version: {version:?}, pkg_mgr: {package_manager:?})");

    Ok(GhPathDetection {
        found: true,
        path: Some(output),
        version,
        package_manager,
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
