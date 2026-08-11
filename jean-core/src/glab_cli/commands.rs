//! Tauri commands for GitLab CLI (`glab`) management

use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read};
use tauri::AppHandle;

use super::config::{
    ensure_glab_cli_dir, get_glab_cli_binary_path, get_glab_cli_dir, resolve_glab_binary,
    GLAB_CLI_BINARY_NAME, GLAB_CLI_BINARY_NAME_UNIX,
};

const FALLBACK_GLAB_VERSION: &str = "1.109.0";
const GLAB_VERSIONS_CACHE_FILE: &str = "glab-versions-cache.json";
/// Official GitLab CLI project on gitlab.com
const GLAB_RELEASES_API: &str =
    "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: String,
    pub prerelease: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GlabInstallProgress {
    pub stage: String,
    pub message: String,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlabPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitLabRelease {
    tag_name: String,
    #[serde(default)]
    released_at: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    upcoming_release: bool,
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, percent: u8) {
    use crate::http_server::EmitExt;
    let _ = app.emit_all(
        "glab-cli:install-progress",
        &GlabInstallProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

pub async fn check_glab_cli_installed(app: AppHandle) -> Result<GlabCliStatus, String> {
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
        let version = crate::platform::wsl_tool_version(&wsl.distro, &tool).and_then(|v| {
            // glab version 1.x.x ...
            v.split_whitespace()
                .nth(2)
                .or_else(|| v.lines().next())
                .map(|s| s.trim().to_string())
        });
        return Ok(GlabCliStatus {
            installed: true,
            version,
            path: Some(tool),
        });
    }

    if !binary_path.exists() {
        return Ok(GlabCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    let version = match crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("version")
        .output()
    {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // "glab 1.109.0" or "glab version 1.109.0"
            let ver = text
                .split_whitespace()
                .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .unwrap_or(&text)
                .to_string();
            Some(ver)
        }
        _ => None,
    };

    Ok(GlabCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

pub async fn check_glab_cli_auth(app: AppHandle) -> Result<GlabAuthStatus, String> {
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

    let binary_str = binary_path.to_string_lossy().to_string();
    let output = crate::platform::wsl_aware_command(&binary_str, None)
        .args(["auth", "status"])
        .output()
        .map_err(|e| format!("Failed to execute GitLab CLI: {e}"))?;

    if output.status.success() {
        Ok(GlabAuthStatus {
            authenticated: true,
            error: None,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok(GlabAuthStatus {
            authenticated: false,
            error: Some(if stderr.is_empty() {
                "Not authenticated".to_string()
            } else {
                stderr
            }),
        })
    }
}

pub async fn detect_glab_in_path(app: AppHandle) -> Result<GlabPathDetection, String> {
    let jean_managed_path = get_glab_cli_binary_path(&app)
        .ok()
        .and_then(|p| std::fs::canonicalize(&p).ok());
    let wsl = crate::platform::get_wsl_config();
    let jean_managed_wsl = if wsl.enabled {
        super::config::get_wsl_glab_binary_path(&wsl.distro).ok()
    } else {
        None
    };

    if wsl.enabled {
        if let Some(unix_path) =
            crate::platform::wsl_which(&wsl.distro, "glab", jean_managed_wsl.as_deref())
        {
            if jean_managed_wsl
                .as_ref()
                .is_some_and(|p| p == &unix_path)
            {
                return Ok(GlabPathDetection {
                    found: false,
                    path: None,
                    version: None,
                    package_manager: None,
                });
            }
            let version = crate::platform::wsl_tool_version(&wsl.distro, &unix_path);
            return Ok(GlabPathDetection {
                found: true,
                path: Some(unix_path),
                version,
                package_manager: None,
            });
        }
        return Ok(GlabPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    }

    if let Some(path) = crate::platform::find_cli_in_host_path("glab", None) {
        if jean_managed_path
            .as_ref()
            .and_then(|j| std::fs::canonicalize(&path).ok().map(|c| c == *j))
            .unwrap_or(false)
        {
            return Ok(GlabPathDetection {
                found: false,
                path: None,
                version: None,
                package_manager: None,
            });
        }
        let version = crate::platform::cli_command(&path.to_string_lossy(), None)
            .arg("version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        return Ok(GlabPathDetection {
            found: true,
            path: Some(path.to_string_lossy().to_string()),
            version,
            package_manager: None,
        });
    }

    Ok(GlabPathDetection {
        found: false,
        path: None,
        version: None,
        package_manager: None,
    })
}

pub async fn get_available_glab_versions(app: AppHandle) -> Result<Vec<GlabReleaseInfo>, String> {
    match fetch_glab_versions_from_api().await {
        Ok(versions) if !versions.is_empty() => {
            save_glab_versions_cache(&app, &versions);
            Ok(versions)
        }
        Ok(_) | Err(_) => Ok(load_glab_versions_cache(&app).unwrap_or_else(fallback_glab_versions)),
    }
}

async fn fetch_glab_versions_from_api() -> Result<Vec<GlabReleaseInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Jean-App/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let response = client
        .get(format!("{GLAB_RELEASES_API}?per_page=10"))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch glab releases: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitLab API returned status: {}", response.status()));
    }

    let releases: Vec<GitLabRelease> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitLab API response: {e}"))?;

    let versions: Vec<GlabReleaseInfo> = releases
        .into_iter()
        .filter(|r| !r.upcoming_release)
        .take(5)
        .map(|r| {
            let version = r
                .tag_name
                .strip_prefix('v')
                .unwrap_or(&r.tag_name)
                .to_string();
            GlabReleaseInfo {
                version,
                tag_name: r.tag_name,
                published_at: r
                    .released_at
                    .or(r.created_at)
                    .unwrap_or_default(),
                prerelease: false,
            }
        })
        .collect();

    Ok(versions)
}

pub async fn check_glab_cli_version_exists(
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
        .get(format!("{GLAB_RELEASES_API}/v{version}"))
        .send()
        .await
        .map_err(|e| format!("Failed to check glab version: {e}"))?;
    Ok(response.status().is_success())
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedGlabVersions {
    versions: Vec<GlabReleaseInfo>,
    fetched_at: String,
}

fn save_glab_versions_cache(app: &AppHandle, versions: &[GlabReleaseInfo]) {
    let cache_path = match ensure_glab_cli_dir(app) {
        Ok(dir) => dir.join(GLAB_VERSIONS_CACHE_FILE),
        Err(_) => return,
    };
    let cached = CachedGlabVersions {
        versions: versions.to_vec(),
        fetched_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default(),
    };
    if let Ok(json) = serde_json::to_string(&cached) {
        let _ = std::fs::write(cache_path, json);
    }
}

fn load_glab_versions_cache(app: &AppHandle) -> Option<Vec<GlabReleaseInfo>> {
    let cache_path = get_glab_cli_dir(app).ok()?.join(GLAB_VERSIONS_CACHE_FILE);
    let contents = std::fs::read_to_string(cache_path).ok()?;
    let cached: CachedGlabVersions = serde_json::from_str(&contents).ok()?;
    if cached.versions.is_empty() {
        None
    } else {
        Some(cached.versions)
    }
}

fn fallback_glab_versions() -> Vec<GlabReleaseInfo> {
    vec![GlabReleaseInfo {
        version: FALLBACK_GLAB_VERSION.to_string(),
        tag_name: format!("v{FALLBACK_GLAB_VERSION}"),
        published_at: String::new(),
        prerelease: false,
    }]
}

/// Returns (platform_token, archive_ext) matching glab release asset names.
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
    Err("Unsupported platform for GitLab CLI".to_string())
}

fn wsl_glab_platform(distro: &str) -> Result<(&'static str, &'static str), String> {
    match crate::platform::wsl_detect_arch(distro) {
        Some("linux-x64") => Ok(("linux_amd64", "tar.gz")),
        Some("linux-arm64") => Ok(("linux_arm64", "tar.gz")),
        _ => Err("Unsupported WSL architecture for glab".to_string()),
    }
}

pub async fn install_glab_cli(app: AppHandle, version: Option<String>) -> Result<(), String> {
    let running_sessions = crate::chat::registry::get_running_sessions();
    if !running_sessions.is_empty() {
        return Err(format!(
            "Cannot install GitLab CLI while {} session(s) running. Stop active sessions first.",
            running_sessions.len()
        ));
    }

    let wsl = crate::platform::get_wsl_config();
    emit_progress(&app, "starting", "Preparing installation...", 0);

    let version = match version {
        Some(v) => v.trim().trim_start_matches('v').to_string(),
        None => {
            let versions = get_available_glab_versions(app.clone()).await?;
            versions
                .into_iter()
                .next()
                .map(|v| v.version)
                .unwrap_or_else(|| FALLBACK_GLAB_VERSION.to_string())
        }
    };

    let (platform, archive_ext) = if wsl.enabled {
        wsl_glab_platform(&wsl.distro)?
    } else {
        get_glab_platform()?
    };

    let archive_name = format!("glab_{version}_{platform}.{archive_ext}");
    let download_url = format!(
        "https://gitlab.com/gitlab-org/cli/-/releases/v{version}/downloads/{archive_name}"
    );

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
            "Failed to download GitLab CLI: HTTP {} ({download_url})",
            response.status()
        ));
    }

    let archive_content = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read archive: {e}"))?;

    emit_progress(&app, "extracting", "Extracting archive...", 40);

    let binary_bytes = if archive_ext == "zip" {
        extract_glab_from_zip(&archive_content)?
    } else {
        extract_glab_from_tar_gz(&archive_content)?
    };

    emit_progress(&app, "installing", "Installing GitLab CLI...", 60);

    if wsl.enabled {
        let unix_path = super::config::get_wsl_glab_binary_path(&wsl.distro)?;
        crate::platform::wsl_write_bytes(&wsl.distro, &unix_path, &binary_bytes)
            .map_err(|e| format!("Failed to write binary into WSL: {e}"))?;
        crate::platform::wsl_chmod_exec(&wsl.distro, &unix_path)?;
        emit_progress(&app, "complete", "Installation complete!", 100);
        return Ok(());
    }

    let _ = ensure_glab_cli_dir(&app)?;
    let binary_path = get_glab_cli_binary_path(&app)?;
    crate::platform::write_binary_file(&binary_path, &binary_bytes)
        .map_err(|e| format!("Failed to write binary: {e}"))?;

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

    emit_progress(&app, "verifying", "Verifying installation...", 80);

    let version_output = crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("version")
        .output()
        .map_err(|e| format!("Failed to verify GitLab CLI: {e}"))?;

    if !version_output.status.success() {
        return Err("GitLab CLI binary verification failed".to_string());
    }

    emit_progress(&app, "complete", "Installation complete!", 100);
    Ok(())
}

pub async fn uninstall_glab_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_glab_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove GitLab CLI directory: {e}"))?;
    }
    Ok(())
}

fn extract_glab_from_tar_gz(archive_content: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::read::GzDecoder;
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
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name == GLAB_CLI_BINARY_NAME_UNIX || name == "glab" {
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|e| format!("Failed to read binary from tar.gz: {e}"))?;
            return Ok(data);
        }
    }
    Err("Binary 'glab' not found inside archive".to_string())
}

fn extract_glab_from_zip(archive_content: &[u8]) -> Result<Vec<u8>, String> {
    use zip::ZipArchive;

    let cursor = Cursor::new(archive_content);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip archive: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;
        let name = file.name().to_string();
        let base = name.rsplit('/').next().unwrap_or(&name);
        if base == GLAB_CLI_BINARY_NAME || base == "glab.exe" || base == "glab" {
            let mut data = Vec::new();
            file.read_to_end(&mut data)
                .map_err(|e| format!("Failed to read binary from zip: {e}"))?;
            return Ok(data);
        }
    }
    Err("Binary 'glab' not found inside zip archive".to_string())
}
