//! Gemini CLI Tauri commands
//!
//! Commands for checking, installing, and authenticating with the Gemini CLI.

use super::config::get_gemini_cli_path;
use crate::ai_cli::types::{AiCliAuthStatus, AiCliStatus};
use std::process::Command;

/// Check if Gemini CLI is installed and get version info
#[tauri::command]
pub fn check_gemini_cli_installed() -> AiCliStatus {
    log::trace!("Checking Gemini CLI installation");

    match get_gemini_cli_path() {
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

/// Check if Gemini CLI is authenticated
/// Gemini CLI uses OAuth and stores credentials in ~/.gemini/oauth_creds.json
#[tauri::command]
pub fn check_gemini_cli_auth() -> AiCliAuthStatus {
    log::trace!("Checking Gemini CLI authentication");

    // Check if OAuth credentials file exists and is not empty
    if let Some(home) = dirs::home_dir() {
        let oauth_path = home.join(".gemini").join("oauth_creds.json");
        if oauth_path.exists() {
            // Check if the file has content (not empty)
            if let Ok(metadata) = std::fs::metadata(&oauth_path) {
                if metadata.len() > 10 {
                    // Has some content
                    log::trace!("Gemini OAuth credentials found at {:?}", oauth_path);
                    return AiCliAuthStatus {
                        authenticated: true,
                        error: None,
                    };
                }
            }
        }
    }

    // Also check environment variables as fallback
    let has_gemini_key = std::env::var("GEMINI_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    let has_google_key = std::env::var("GOOGLE_API_KEY")
        .map(|k| !k.is_empty())
        .unwrap_or(false);

    if has_gemini_key || has_google_key {
        log::trace!("Gemini API key is set via environment variable");
        return AiCliAuthStatus {
            authenticated: true,
            error: None,
        };
    }

    AiCliAuthStatus {
        authenticated: false,
        error: Some("Not logged in. Run 'gemini' to authenticate via OAuth.".to_string()),
    }
}

/// Install Gemini CLI via npm
#[tauri::command]
pub async fn install_gemini_cli() -> Result<String, String> {
    log::info!("Installing Gemini CLI via npm");

    // Install via npm global
    let output = Command::new("npm")
        .args(["install", "-g", "@anthropic-ai/claude-code"])
        .output()
        .map_err(|e| format!("Failed to run npm: {e}"))?;

    if output.status.success() {
        Ok("Gemini CLI installed successfully".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to install Gemini CLI: {stderr}"))
    }
}
