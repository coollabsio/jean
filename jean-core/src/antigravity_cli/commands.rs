use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use super::config::{
    binary_exists, ensure_cli_dir, find_system_antigravity_binary, get_cli_binary_path,
    get_cli_dir, resolve_cli_binary,
};
use crate::platform::silent_command;

const MANIFEST_BASE: &str =
    "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const AUTH_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntigravityCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAuthStatus {
    pub authenticated: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub timed_out: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityPathDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_default: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntigravityInstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntigravityReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: String,
    pub prerelease: bool,
}

fn parse_version(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .split_whitespace()
        .find(|part| {
            part.trim_start_matches('v')
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_digit())
        })
        .map(|part| part.trim_start_matches('v').to_string())
}

fn manifest_name() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin_arm64.json"),
        ("macos", "x86_64") => Ok("darwin_x64.json"),
        ("linux", "aarch64") => Ok("linux_arm64.json"),
        ("linux", "x86_64") => Ok("linux_x64.json"),
        ("windows", "aarch64") => Ok("windows_arm64.json"),
        ("windows", "x86_64") => Ok("windows_x64.json"),
        _ => Err("Antigravity CLI does not publish a build for this platform".to_string()),
    }
}

async fn latest_release() -> Result<AntigravityReleaseInfo, String> {
    let url = format!("{MANIFEST_BASE}/{}", manifest_name()?);
    let value: Value = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Failed to build Antigravity HTTP client: {error}"))?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch Antigravity version: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to fetch Antigravity version: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse Antigravity version: {error}"))?;
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "Antigravity release manifest has no version".to_string())?;
    Ok(AntigravityReleaseInfo {
        version: version.to_string(),
        tag_name: "latest".to_string(),
        published_at: String::new(),
        prerelease: version.contains('-'),
    })
}

fn run_with_timeout(mut command: std::process::Command) -> Result<std::process::Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Antigravity CLI: {error}"))?;
    let deadline = Instant::now() + AUTH_TIMEOUT;
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return child.wait_with_output().map_err(|error| error.to_string());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err("Antigravity CLI status check timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub async fn check_antigravity_cli_installed(
    app: AppHandle,
) -> Result<AntigravityCliStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(AntigravityCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }
    let version = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| parse_version(&o.stdout));
    Ok(AntigravityCliStatus {
        installed: true,
        version,
        path: Some(binary.to_string_lossy().to_string()),
    })
}

pub async fn detect_antigravity_in_path(
    app: AppHandle,
) -> Result<AntigravityPathDetection, String> {
    let Some(binary) = find_system_antigravity_binary(&app) else {
        return Ok(AntigravityPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };
    let version = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| parse_version(&o.stdout));
    Ok(AntigravityPathDetection {
        found: true,
        path: Some(binary.to_string_lossy().to_string()),
        version,
        package_manager: Some("path".to_string()),
    })
}

pub async fn check_antigravity_cli_auth(app: AppHandle) -> Result<AntigravityAuthStatus, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(AntigravityAuthStatus {
            authenticated: false,
            error: Some("Antigravity CLI not installed".to_string()),
            timed_out: false,
        });
    }
    let mut command = crate::platform::cli_command(&binary.to_string_lossy(), None);
    command.arg("models");
    match run_with_timeout(command) {
        Ok(output) if output.status.success() => Ok(AntigravityAuthStatus {
            authenticated: true,
            error: None,
            timed_out: false,
        }),
        Ok(output) => {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Ok(AntigravityAuthStatus {
                authenticated: false,
                error: Some(if error.is_empty() {
                    "Authentication required. Run `agy`.".to_string()
                } else {
                    error
                }),
                timed_out: false,
            })
        }
        Err(error) => Ok(AntigravityAuthStatus {
            authenticated: false,
            timed_out: error.contains("timed out"),
            error: Some(error),
        }),
    }
}

fn parse_models(text: &str) -> Vec<AntigravityModelInfo> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.to_ascii_lowercase().starts_with("fetching ") {
                return None;
            }
            let (id, label) = line.split_once(char::is_whitespace)?;
            if id.is_empty() || label.trim().is_empty() {
                return None;
            }
            Some(AntigravityModelInfo {
                id: id.to_string(),
                label: label.trim().to_string(),
                is_default: false,
            })
        })
        .collect()
}

pub async fn list_antigravity_models(app: AppHandle) -> Result<Vec<AntigravityModelInfo>, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(Vec::new());
    }
    let output = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("models")
        .output()
        .map_err(|error| format!("Failed to list Antigravity models: {error}"))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(parse_models(&String::from_utf8_lossy(&output.stdout)))
}

pub async fn get_available_antigravity_versions(
    _app: AppHandle,
) -> Result<Vec<AntigravityReleaseInfo>, String> {
    Ok(vec![latest_release().await?])
}
pub async fn check_antigravity_cli_version_exists(
    _app: AppHandle,
    version: String,
) -> Result<bool, String> {
    let latest = latest_release().await?;
    Ok(matches!(version.trim(), "latest" | "")
        || version.trim().trim_start_matches('v') == latest.version)
}

pub async fn get_antigravity_install_command(
    app: AppHandle,
) -> Result<AntigravityInstallCommand, String> {
    let dir = get_cli_dir(&app)?.to_string_lossy().to_string();
    #[cfg(windows)]
    return Ok(AntigravityInstallCommand { command: "powershell".to_string(), args: vec!["-NoProfile".to_string(), "-Command".to_string(), format!("& ([scriptblock]::Create((irm https://antigravity.google/cli/install.ps1))) --dir '{dir}'")], description: "Install Antigravity CLI from Google's official installer".to_string() });
    #[cfg(not(windows))]
    Ok(AntigravityInstallCommand {
        command: "sh".to_string(),
        args: vec![
            "-c".to_string(),
            format!(
                "curl -fsSL https://antigravity.google/cli/install.sh | sh -s -- --dir '{}'",
                dir.replace('\'', "'\\''")
            ),
        ],
        description: "Install Antigravity CLI from Google's official installer".to_string(),
    })
}

pub async fn install_antigravity_cli(
    app: AppHandle,
    version: Option<String>,
) -> Result<(), String> {
    if let Some(requested) = version
        .as_deref()
        .filter(|v| !v.is_empty() && *v != "latest")
    {
        if !check_antigravity_cli_version_exists(app.clone(), requested.to_string()).await? {
            return Err(format!("Antigravity CLI version {requested} is not available from the official stable manifest"));
        }
    }
    let _ = ensure_cli_dir(&app)?;
    let install = get_antigravity_install_command(app.clone()).await?;
    let output = silent_command(&install.command)
        .args(&install.args)
        .output()
        .map_err(|error| format!("Failed to install Antigravity CLI: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Antigravity CLI install failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !get_cli_binary_path(&app)?.exists() {
        return Err(
            "Antigravity CLI install completed but the `agy` binary was not found".to_string(),
        );
    }
    Ok(())
}

pub async fn uninstall_antigravity_cli(app: AppHandle) -> Result<(), String> {
    let dir = get_cli_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|error| format!("Failed to remove Antigravity CLI: {error}"))?;
    }
    Ok(())
}
pub async fn update_antigravity_cli(app: AppHandle) -> Result<(), String> {
    uninstall_antigravity_cli(app.clone()).await?;
    install_antigravity_cli(app, None).await
}
pub async fn login_antigravity_cli_device(app: AppHandle) -> Result<(), String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Err("Antigravity CLI not installed".to_string());
    }
    Err(format!(
        "Antigravity authentication is interactive. Run `{}` in a terminal and complete sign-in.",
        binary.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_cli_version() {
        assert_eq!(parse_version(b"1.1.11\n").as_deref(), Some("1.1.11"));
    }
    #[test]
    fn parses_official_model_list() {
        let models = parse_models("gemini-3.6-flash-high Gemini 3.6 Flash (High)\ngemini-3.1-pro-high Gemini 3.1 Pro (High)\n");
        assert_eq!(models[0].id, "gemini-3.6-flash-high");
        assert_eq!(models[0].label, "Gemini 3.6 Flash (High)");
    }
}
