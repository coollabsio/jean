//! Codex CLI configuration
//!
//! Path and configuration utilities for the OpenAI Codex CLI.

use std::path::PathBuf;

/// Get the path where Codex CLI should be installed
pub fn get_codex_cli_path() -> Result<PathBuf, String> {
    // Codex CLI can be installed via npm or as a standalone binary

    #[cfg(target_os = "macos")]
    {
        // Check if installed via npm global or standalone
        if let Ok(output) = std::process::Command::new("which").arg("codex").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }

        // Common paths on macOS
        let home = dirs::home_dir().ok_or("Could not determine home directory")?;
        let paths = [
            home.join(".npm-global/bin/codex"),
            home.join(".nvm/versions/node/*/bin/codex"),
            PathBuf::from("/usr/local/bin/codex"),
            PathBuf::from("/opt/homebrew/bin/codex"),
            // Standalone installation path
            home.join(".local/bin/codex"),
        ];

        for path in &paths {
            if path.exists() {
                return Ok(path.clone());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = std::process::Command::new("which").arg("codex").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }

        let home = dirs::home_dir().ok_or("Could not determine home directory")?;
        let paths = [
            home.join(".npm-global/bin/codex"),
            home.join(".nvm/versions/node/*/bin/codex"),
            PathBuf::from("/usr/local/bin/codex"),
            home.join(".local/bin/codex"),
        ];

        for path in &paths {
            if path.exists() {
                return Ok(path.clone());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("where").arg("codex").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }
    }

    Err("Codex CLI not found".to_string())
}

/// Get the npm package name for Codex CLI
pub fn get_npm_package_name() -> &'static str {
    "@openai/codex"
}
