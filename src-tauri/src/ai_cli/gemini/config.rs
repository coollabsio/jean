//! Gemini CLI configuration
//!
//! Path and configuration utilities for the Gemini CLI.

use std::path::PathBuf;

/// Get the path where Gemini CLI should be installed via npm
/// This returns the global npm bin directory where `gemini` command would be available
pub fn get_gemini_cli_path() -> Result<PathBuf, String> {
    // Gemini CLI is typically installed globally via npm
    // Check common locations based on platform

    #[cfg(target_os = "macos")]
    {
        // Check if installed via npm global
        if let Ok(output) = std::process::Command::new("which").arg("gemini").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }

        // Common npm global paths on macOS
        let home = dirs::home_dir().ok_or("Could not determine home directory")?;
        let paths = [
            home.join(".npm-global/bin/gemini"),
            home.join(".nvm/versions/node/*/bin/gemini"),
            PathBuf::from("/usr/local/bin/gemini"),
            PathBuf::from("/opt/homebrew/bin/gemini"),
        ];

        for path in &paths {
            if path.exists() {
                return Ok(path.clone());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = std::process::Command::new("which").arg("gemini").output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(PathBuf::from(path));
                }
            }
        }

        let home = dirs::home_dir().ok_or("Could not determine home directory")?;
        let paths = [
            home.join(".npm-global/bin/gemini"),
            home.join(".nvm/versions/node/*/bin/gemini"),
            PathBuf::from("/usr/local/bin/gemini"),
        ];

        for path in &paths {
            if path.exists() {
                return Ok(path.clone());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("where")
            .arg("gemini")
            .output()
        {
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

    Err("Gemini CLI not found".to_string())
}

/// Get the npm package name for Gemini CLI
pub fn get_npm_package_name() -> &'static str {
    "@anthropic-ai/claude-code" // Placeholder - replace with actual Gemini CLI package when available
}
