//! Codex CLI Tauri commands
//!
//! Commands for checking, installing, and authenticating with the OpenAI Codex CLI.

use super::config::get_codex_cli_path;
use crate::ai_cli::types::{AiCliAuthStatus, AiCliStatus};
use std::process::Command;

/// Check if Codex CLI is installed and get version info
#[tauri::command]
pub fn check_codex_cli_installed() -> AiCliStatus {
    log::trace!("Checking Codex CLI installation");

    match get_codex_cli_path() {
        Ok(path) => {
            // Try to get version
            let version = Command::new(&path)
                .arg("--version")
                .output()
                .ok()
                .and_then(|output| {
                    if output.status.success() {
                        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
                    } else {
                        None
                    }
                });

            AiCliStatus {
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            }
        }
        Err(_) => AiCliStatus {
            installed: false,
            version: None,
            path: None,
        },
    }
}

/// Check if Codex CLI is authenticated
/// Codex CLI uses `codex login status` to check authentication
#[tauri::command]
pub fn check_codex_cli_auth() -> AiCliAuthStatus {
    log::trace!("Checking Codex CLI authentication");

    let path = match get_codex_cli_path() {
        Ok(p) => p,
        Err(e) => {
            return AiCliAuthStatus {
                authenticated: false,
                error: Some(format!("Codex CLI not installed: {e}")),
            }
        }
    };

    // Run `codex login status` to check authentication
    match Command::new(&path).args(["login", "status"]).output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            // Check if logged in (output contains "Logged in")
            if stdout.contains("Logged in") || stderr.contains("Logged in") {
                log::trace!("Codex CLI is authenticated: {}", stdout.trim());
                AiCliAuthStatus {
                    authenticated: true,
                    error: None,
                }
            } else {
                log::trace!("Codex CLI not authenticated: stdout={}, stderr={}", stdout, stderr);
                AiCliAuthStatus {
                    authenticated: false,
                    error: Some("Not logged in. Run 'codex login' to authenticate.".to_string()),
                }
            }
        }
        Err(e) => AiCliAuthStatus {
            authenticated: false,
            error: Some(format!("Failed to check auth: {e}")),
        },
    }
}

/// Install Codex CLI via npm
#[tauri::command]
pub async fn install_codex_cli() -> Result<String, String> {
    log::info!("Installing Codex CLI via npm");

    // Install via npm global
    let output = Command::new("npm")
        .args(["install", "-g", "@openai/codex"])
        .output()
        .map_err(|e| format!("Failed to run npm: {e}"))?;

    if output.status.success() {
        Ok("Codex CLI installed successfully".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to install Codex CLI: {stderr}"))
    }
}
