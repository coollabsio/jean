//! Tauri commands for Devin CLI management.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

use super::config::{
    binary_exists, find_system_devin_binary, get_cli_binary_path, resolve_cli_binary,
};

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestTarget {
    version: String,
    platform: String,
    arch: String,
    url: String,
    published_at: String,
    prerelease: bool,
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
            .unwrap_or_else(|| value.get("user").is_some() || value.get("email").is_some());
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
        .get("id")
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
    let mut models = match source {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| model_from_value(None, item))
            .collect::<Vec<_>>(),
        Value::Object(map) => map
            .iter()
            .filter_map(|(id, item)| model_from_value(Some(id), item))
            .collect::<Vec<_>>(),
        _ => Vec::new(),
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

fn current_manifest_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
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
    let version = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
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
    let version = crate::platform::cli_command(&binary.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
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
    let result = tokio::time::timeout(AUTH_TIMEOUT, async {
        crate::platform::cli_command(&binary.to_string_lossy(), None)
            .args(["auth", "status"])
            .output()
    })
    .await;
    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("Failed to check Devin auth: {error}")),
        Err(_) => {
            return Ok(DevinAuthStatus {
                authenticated: false,
                error: Some("Devin auth check timed out".to_string()),
                timed_out: true,
            })
        }
    };
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut status = parse_auth_status(&combined);
    if !output.status.success() && status.error.is_none() {
        status.error = Some("Not authenticated. Run `devin auth login`.".to_string());
    }
    Ok(status)
}

pub async fn list_devin_models(app: AppHandle) -> Result<Vec<DevinModelInfo>, String> {
    let binary = resolve_cli_binary(&app);
    if !binary_exists(&binary) {
        return Ok(Vec::new());
    }
    let result = tokio::time::timeout(MODELS_TIMEOUT, async {
        crate::platform::cli_command(&binary.to_string_lossy(), None)
            .args(["models", "list", "--format", "json"])
            .output()
    })
    .await;
    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("Failed to list Devin models: {error}")),
        Err(_) => return Ok(Vec::new()),
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }
    parse_models_json(&String::from_utf8_lossy(&output.stdout))
}

pub async fn get_available_devin_versions(
    _app: AppHandle,
) -> Result<Vec<DevinReleaseInfo>, String> {
    let manifest = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Failed to build Devin HTTP client: {error}"))?
        .get(DEVIN_MANIFEST_URL)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch Devin versions: {error}"))?
        .text()
        .await
        .map_err(|error| format!("Failed to read Devin versions: {error}"))?;
    let targets = parse_manifest_targets(&manifest)?;
    let platform = current_manifest_platform();
    let arch = std::env::consts::ARCH;
    let mut releases = targets
        .iter()
        .filter(|target| {
            target.platform == platform
                && select_manifest_target(&[(*target).clone()], platform, arch).is_some()
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

pub async fn check_devin_cli_version_exists(
    app: AppHandle,
    version: String,
) -> Result<bool, String> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return Ok(false);
    }
    Ok(get_available_devin_versions(app)
        .await?
        .iter()
        .any(|release| release.version == version))
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

pub async fn install_devin_cli(_app: AppHandle, _version: Option<String>) -> Result<(), String> {
    Err(
        "Jean cannot install Devin CLI automatically yet. Run `curl -fsSL https://cli.devin.ai/install.sh | bash` (macOS/Linux) or the official PowerShell installer on Windows, then restart Jean."
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
