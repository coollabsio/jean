//! Tauri commands for Antigravity CLI (`agy`) management.
//!
//! Antigravity is a standalone Go binary resolved from PATH. It authenticates via
//! a Google account and shares Gemini's `~/.gemini` config tree. There is no
//! documented machine-readable `auth status` subcommand, so auth is detected
//! heuristically from the presence of credential files under `~/.gemini`.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::config::{
    binary_exists, ensure_cli_dir, find_system_antigravity_binary, get_cli_binary_path,
    get_cli_dir, resolve_cli_binary,
};
use crate::platform::silent_command;

/// Official Antigravity CLI installer (referenced from PR #469). The bootstrapper
/// downloads the `agy` binary into `--dir`. Verify against antigravity.google docs
/// if installs fail.
const ANTIGRAVITY_INSTALL_URL: &str = "https://antigravity.google/cli/install.sh";

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

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().is_some_and(|c| *c == '[') {
                let _ = chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
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

fn parse_version(stdout: &[u8]) -> Option<String> {
    let text = strip_ansi(&String::from_utf8_lossy(stdout));
    text.split_whitespace()
        .find(|part| part.chars().any(|ch| ch.is_ascii_digit()) && part.contains('.'))
        .map(|part| part.trim_start_matches('v').to_string())
        .or_else(|| {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
}

/// Antigravity shares Gemini's `~/.gemini` config tree; Google-account OAuth
/// credentials live there. Used as a best-effort authentication signal.
fn antigravity_credentials_present() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let gemini = home.join(".gemini");
    gemini.join("oauth_creds.json").exists()
        || gemini.join("antigravity-cli").exists()
        || gemini.join("google_accounts.json").exists()
}

pub fn fallback_models() -> Vec<AntigravityModelInfo> {
    vec![
        AntigravityModelInfo {
            id: "antigravity/gemini-3-pro".to_string(),
            label: "Gemini 3 Pro".to_string(),
            is_default: true,
        },
        AntigravityModelInfo {
            id: "antigravity/gemini-3.5-flash-medium".to_string(),
            label: "Gemini 3.5 Flash (Medium)".to_string(),
            is_default: false,
        },
    ]
}

pub async fn check_antigravity_cli_installed(app: AppHandle) -> Result<AntigravityCliStatus, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_exists(&binary_path) {
        return Ok(AntigravityCliStatus {
            installed: false,
            version: None,
            path: None,
        });
    }
    let version = match crate::platform::cli_command(&binary_path.to_string_lossy(), None)
        .arg("--version")
        .output()
    {
        Ok(output) if output.status.success() => parse_version(&output.stdout),
        _ => None,
    };
    Ok(AntigravityCliStatus {
        installed: true,
        version,
        path: Some(binary_path.to_string_lossy().to_string()),
    })
}

pub async fn detect_antigravity_in_path(app: AppHandle) -> Result<AntigravityPathDetection, String> {
    let Some(path) = find_system_antigravity_binary(&app) else {
        return Ok(AntigravityPathDetection {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        });
    };
    let version = crate::platform::cli_command(&path.to_string_lossy(), None)
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| parse_version(&out.stdout));
    Ok(AntigravityPathDetection {
        found: true,
        path: Some(path.to_string_lossy().to_string()),
        version,
        package_manager: Some("path".to_string()),
    })
}

pub async fn check_antigravity_cli_auth(app: AppHandle) -> Result<AntigravityAuthStatus, String> {
    let binary_path = resolve_cli_binary(&app);
    if !binary_exists(&binary_path) {
        return Ok(AntigravityAuthStatus {
            authenticated: false,
            error: Some("Antigravity CLI (`agy`) not installed".to_string()),
            timed_out: false,
        });
    }
    if antigravity_credentials_present() {
        Ok(AntigravityAuthStatus {
            authenticated: true,
            error: None,
            timed_out: false,
        })
    } else {
        Ok(AntigravityAuthStatus {
            authenticated: false,
            error: Some("Sign in with `agy` (Google account) to authenticate.".to_string()),
            timed_out: false,
        })
    }
}

pub async fn list_antigravity_models(_app: AppHandle) -> Result<Vec<AntigravityModelInfo>, String> {
    Ok(fallback_models())
}

/// Install the Antigravity CLI into Jean's managed app-data directory via the
/// official installer script (`curl … | bash -s -- --dir <cli_dir>/bin`).
/// Requires `curl` + `bash`; the user still signs in with `agy` afterwards.
pub async fn install_antigravity_cli(
    app: AppHandle,
    _version: Option<String>,
) -> Result<(), String> {
    let cli_dir = ensure_cli_dir(&app)?;
    let bin_dir = cli_dir.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create Antigravity bin directory: {e}"))?;

    let script = format!(
        "curl -fsSL {ANTIGRAVITY_INSTALL_URL} | bash -s -- --dir {}",
        bin_dir.to_string_lossy()
    );
    let output = silent_command("bash")
        .arg("-c")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to run Antigravity installer: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(format!(
            "Antigravity CLI install failed: {}",
            if stderr.is_empty() { stdout } else { stderr }
        ));
    }

    let binary_path = get_cli_binary_path(&app)?;
    if !binary_path.exists() {
        return Err(format!(
            "Antigravity install completed but binary was not found at {}",
            binary_path.display()
        ));
    }
    Ok(())
}

pub async fn uninstall_antigravity_cli(app: AppHandle) -> Result<(), String> {
    let cli_dir = get_cli_dir(&app)?;
    if cli_dir.exists() {
        std::fs::remove_dir_all(&cli_dir)
            .map_err(|e| format!("Failed to remove Antigravity CLI directory: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_extracts_semver_token() {
        assert_eq!(parse_version(b"agy version 1.4.2"), Some("1.4.2".to_string()));
        assert_eq!(parse_version(b"v0.9.0"), Some("0.9.0".to_string()));
    }

    #[test]
    fn fallback_models_has_single_default() {
        let models = fallback_models();
        assert_eq!(models.iter().filter(|m| m.is_default).count(), 1);
    }
}
