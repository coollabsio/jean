//! Tauri commands for Antigravity CLI management.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::AppHandle;

use super::config::{
    binary_exists, ensure_cli_dir, find_system_antigravity_binary, get_cli_dir, resolve_cli_binary,
};
use crate::platform::silent_command;

const STATUS_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const MODELS_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

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
pub struct AntigravityReleaseInfo {
    pub version: String,
    pub published_at: String,
}

fn fallback_models() -> Vec<AntigravityModelInfo> {
    vec![
        AntigravityModelInfo {
            id: "Gemini 3.5 Flash (Low)".to_string(),
            label: "Gemini 3.5 Flash (Low)".to_string(),
            is_default: true,
        },
        AntigravityModelInfo {
            id: "Gemini 3.5 Flash (Medium)".to_string(),
            label: "Gemini 3.5 Flash (Medium)".to_string(),
            is_default: false,
        },
        AntigravityModelInfo {
            id: "Gemini 3.5 Flash (High)".to_string(),
            label: "Gemini 3.5 Flash (High)".to_string(),
            is_default: false,
        },
        AntigravityModelInfo {
            id: "Gemini 3.1 Pro (Low)".to_string(),
            label: "Gemini 3.1 Pro (Low)".to_string(),
            is_default: false,
        },
        AntigravityModelInfo {
            id: "Gemini 3.1 Pro (High)".to_string(),
            label: "Gemini 3.1 Pro (High)".to_string(),
            is_default: false,
        },
        AntigravityModelInfo {
            id: "Claude Sonnet 4.6 (Thinking)".to_string(),
            label: "Claude Sonnet 4.6 (Thinking)".to_string(),
            is_default: false,
        },
        AntigravityModelInfo {
            id: "Claude Opus 4.6 (Thinking)".to_string(),
            label: "Claude Opus 4.6 (Thinking)".to_string(),
            is_default: false,
        },
        AntigravityModelInfo {
            id: "GPT-OSS 120B (Medium)".to_string(),
            label: "GPT-OSS 120B (Medium)".to_string(),
            is_default: false,
        },
    ]
}

pub fn parse_version(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    let out = String::from_utf8_lossy(stdout);
    let err = String::from_utf8_lossy(stderr);
    let combined = format!("{out}\n{err}");
    for line in combined.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && trimmed.chars().next().map_or(false, |c| c.is_ascii_digit()) {
            return Some(trimmed.to_string());
        }
    }
    None
}

pub fn parse_models(stdout: &[u8]) -> Vec<AntigravityModelInfo> {
    let out = String::from_utf8_lossy(stdout).replace('\r', "\n");
    let mut models = Vec::new();
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.contains("Fetching")
            || trimmed.contains("⠋")
            || trimmed.contains("⠙")
            || trimmed.contains("⠹")
            || trimmed.contains("⠸")
            || trimmed.contains("⠼")
            || trimmed.contains("⠴")
            || trimmed.contains("⠦")
            || trimmed.contains("⠧")
            || trimmed.contains("⠇")
            || trimmed.contains("⠏")
        {
            continue;
        }
        models.push(AntigravityModelInfo {
            id: trimmed.to_string(),
            label: trimmed.to_string(),
            is_default: trimmed.contains("Low") || trimmed.contains("default"),
        });
    }
    models
}

enum TimedCommandResult {
    Output(std::process::Output),
    Timeout,
    Error(String),
}

fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<TimedCommandResult, String> {
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    let (sender, receiver) = std::sync::mpsc::channel();
    let child_id = child.id();

    let t = std::thread::spawn(move || {
        let res = child.wait_with_output();
        let _ = sender.send(res);
    });

    match receiver.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(TimedCommandResult::Output(output)),
        Ok(Err(e)) => Ok(TimedCommandResult::Error(e.to_string())),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            log::warn!("Command timed out after {:?}", timeout);
            let _ = crate::platform::kill_process(child_id);
            let _ = t.join();
            Ok(TimedCommandResult::Timeout)
        }
        Err(e) => Err(format!("Channel error: {e}")),
    }
}

#[tauri::command]
pub async fn check_antigravity_cli_installed(
    app: AppHandle,
) -> Result<AntigravityCliStatus, String> {
    let path = resolve_cli_binary(&app);
    if !binary_exists(&path) {
        return Ok(AntigravityCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }

    let mut cmd = silent_command(path.to_string_lossy().as_ref());
    cmd.arg("--version");

    match run_command_with_timeout(cmd, STATUS_CHECK_TIMEOUT)? {
        TimedCommandResult::Output(output) => {
            let version = parse_version(&output.stdout, &output.stderr);
            Ok(AntigravityCliStatus {
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            })
        }
        _ => Ok(AntigravityCliStatus {
            installed: true,
            version: None,
            path: Some(path.to_string_lossy().to_string()),
        }),
    }
}

#[tauri::command]
pub async fn detect_antigravity_in_path(app: AppHandle) -> Result<Option<String>, String> {
    Ok(find_system_antigravity_binary(&app).map(|p| p.to_string_lossy().to_string()))
}

/// Auto-migrate credentials from ~/.gemini/oauth_creds.json to ~/.gemini/antigravity-cli/antigravity-oauth-token
fn attempt_credential_migration() {
    if let Some(home) = dirs::home_dir() {
        let creds_file = home.join(".gemini").join("oauth_creds.json");
        let token_file = home
            .join(".gemini")
            .join("antigravity-cli")
            .join("antigravity-oauth-token");

        if creds_file.exists()
            && (!token_file.exists()
                || std::fs::metadata(&token_file).map(|m| m.len()).unwrap_or(0) == 0)
        {
            if let Ok(content) = std::fs::read_to_string(&creds_file) {
                if let Ok(value) = serde_json::from_str::<Value>(&content) {
                    if let (Some(access_token), Some(refresh_token)) = (
                        value.get("access_token").and_then(Value::as_str),
                        value.get("refresh_token").and_then(Value::as_str),
                    ) {
                        let expiry_ms = value
                            .get("expiry_date")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        let expiry_str = if expiry_ms > 0 {
                            let secs = expiry_ms / 1000;
                            let nsecs = (expiry_ms % 1000) * 1_000_000;
                            if let Some(dt) = chrono::DateTime::from_timestamp(secs, nsecs as u32) {
                                dt.to_rfc3339()
                            } else {
                                "".to_string()
                            }
                        } else {
                            "".to_string()
                        };

                        let token_obj = serde_json::json!({
                            "token": {
                                "access_token": access_token,
                                "token_type": value.get("token_type").and_then(Value::as_str).unwrap_or("Bearer"),
                                "refresh_token": refresh_token,
                                "expiry": expiry_str
                            },
                            "auth_method": "consumer"
                        });

                        if let Some(parent) = token_file.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        let _ = std::fs::write(
                            &token_file,
                            serde_json::to_string_pretty(&token_obj).unwrap_or_default(),
                        );
                        log::info!("[Antigravity] Auto-migrated credentials from oauth_creds.json");
                    }
                }
            }
        }
    }
}

/// Auto-trust the current workspace directory in ~/.gemini/antigravity-cli/settings.json
pub fn auto_trust_workspace(_app: &AppHandle, working_dir: &std::path::Path) {
    if let Some(home) = dirs::home_dir() {
        let settings_file = home
            .join(".gemini")
            .join("antigravity-cli")
            .join("settings.json");
        let dir_str = working_dir.to_string_lossy().to_string();

        if let Ok(content) = std::fs::read_to_string(&settings_file) {
            if let Ok(mut value) = serde_json::from_str::<Value>(&content) {
                let mut changed = false;
                if let Some(trusted) = value
                    .get_mut("trustedWorkspaces")
                    .and_then(Value::as_array_mut)
                {
                    if !trusted.iter().any(|v| v.as_str() == Some(&dir_str)) {
                        trusted.push(Value::String(dir_str));
                        changed = true;
                    }
                } else if let Some(obj) = value.as_object_mut() {
                    obj.insert(
                        "trustedWorkspaces".to_string(),
                        serde_json::json!([dir_str]),
                    );
                    changed = true;
                }

                if changed {
                    let _ = std::fs::write(
                        &settings_file,
                        serde_json::to_string_pretty(&value).unwrap_or_default(),
                    );
                }
            }
        }
    }
}

#[tauri::command]
pub async fn check_antigravity_cli_auth(app: AppHandle) -> Result<AntigravityAuthStatus, String> {
    attempt_credential_migration();

    let path = resolve_cli_binary(&app);
    if !binary_exists(&path) {
        return Ok(AntigravityAuthStatus {
            authenticated: false,
            error: Some("Antigravity CLI not installed".to_string()),
        });
    }

    // Check if token file exists and is populated
    if let Some(home) = dirs::home_dir() {
        let token_file = home
            .join(".gemini")
            .join("antigravity-cli")
            .join("antigravity-oauth-token");
        if token_file.exists() && std::fs::metadata(&token_file).map(|m| m.len()).unwrap_or(0) > 10
        {
            return Ok(AntigravityAuthStatus {
                authenticated: true,
                error: None,
            });
        }
    }

    Ok(AntigravityAuthStatus {
        authenticated: false,
        error: Some("Not authenticated. Please log in.".to_string()),
    })
}

#[tauri::command]
pub async fn list_antigravity_models(app: AppHandle) -> Result<Vec<AntigravityModelInfo>, String> {
    let path = resolve_cli_binary(&app);
    if !binary_exists(&path) {
        return Ok(fallback_models());
    }

    let mut cmd = silent_command(path.to_string_lossy().as_ref());
    cmd.arg("models");

    match run_command_with_timeout(cmd, MODELS_CHECK_TIMEOUT)? {
        TimedCommandResult::Output(output) if output.status.success() => {
            let models = parse_models(&output.stdout);
            Ok(if models.is_empty() {
                fallback_models()
            } else {
                models
            })
        }
        _ => Ok(fallback_models()),
    }
}

#[tauri::command]
pub async fn get_available_antigravity_versions(
    _app: AppHandle,
) -> Result<Vec<AntigravityReleaseInfo>, String> {
    // Return a default version array representing the currently running/known version
    Ok(vec![AntigravityReleaseInfo {
        version: "1.0.16".to_string(),
        published_at: "2026-07-03T00:00:00Z".to_string(),
    }])
}

#[tauri::command]
pub async fn check_antigravity_cli_version_exists(
    _app: AppHandle,
    version: String,
) -> Result<bool, String> {
    Ok(version == "1.0.16")
}

#[tauri::command]
pub async fn install_antigravity_cli(
    app: AppHandle,
    _version: Option<String>,
) -> Result<(), String> {
    let cli_dir = ensure_cli_dir(&app)?;

    // Direct download/run of the bootstrapper script
    let mut command = if cfg!(windows) {
        let mut cmd = silent_command("powershell");
        cmd.args([
            "-Command",
            "irm https://antigravity.google/cli/install.ps1 | iex",
        ]);
        cmd
    } else {
        let mut cmd = silent_command("sh");
        cmd.arg("-c").arg(format!(
            "curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir {}",
            cli_dir.to_string_lossy()
        ));
        cmd
    };

    let status = command
        .status()
        .map_err(|e| format!("Failed to spawn installer: {e}"))?;
    if !status.success() {
        return Err("Installer script returned non-zero status".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn uninstall_antigravity_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_cli_dir(&app)?;
    if cli_dir.exists() {
        let _ = std::fs::remove_dir_all(&cli_dir);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_version() {
        let stdout = b"1.0.16\n";
        let stderr = b"";
        assert_eq!(parse_version(stdout, stderr), Some("1.0.16".to_string()));
    }

    #[test]
    fn test_parse_models() {
        let output = b"\xE2\xA0\x8B Fetching available models...\nGemini 3.5 Flash (Low)\nGemini 3.5 Flash (High)\n";
        let models = parse_models(output);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "Gemini 3.5 Flash (Low)");
        assert!(models[0].is_default);
        assert_eq!(models[1].id, "Gemini 3.5 Flash (High)");
        assert!(!models[1].is_default);
    }

    #[test]
    fn test_parse_models_with_carriage_returns() {
        let output = b"\xE2\xA0\x8B Fetching...\r\xE2\xA0\x99 Fetching...\rGemini 3.5 Flash (Low)\nGemini 3.5 Flash (High)\n";
        let models = parse_models(output);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "Gemini 3.5 Flash (Low)");
        assert_eq!(models[1].id, "Gemini 3.5 Flash (High)");
    }

    #[test]
    fn test_fallback_models() {
        let models = fallback_models();
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.is_default));
    }
}
