//! Shared CLI path detection that understands WSL mode.

use std::path::{Path, PathBuf};

use super::{detect_package_manager, silent_command};

#[derive(Debug, Clone)]
pub struct CliDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub package_manager: Option<String>,
}

impl CliDetection {
    pub fn not_found() -> Self {
        Self {
            found: false,
            path: None,
            version: None,
            package_manager: None,
        }
    }
}

/// Detect a CLI tool in PATH, returning a WSL path when WSL mode is enabled.
pub fn detect_cli_in_path(tool: &str, jean_managed: Option<&Path>) -> CliDetection {
    let wsl = super::get_wsl_config();
    if wsl.enabled {
        let Some(unix_path) = super::wsl_which(&wsl.distro, tool) else {
            return CliDetection::not_found();
        };
        let version = super::wsl_tool_version(&wsl.distro, tool);
        let package_manager = super::wsl_detect_package_manager(&unix_path);
        return CliDetection {
            found: true,
            path: Some(unix_path),
            version,
            package_manager,
        };
    }

    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = match silent_command(which_cmd).arg(tool).output() {
        Ok(output) if output.status.success() => output,
        _ => return CliDetection::not_found(),
    };

    let found = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if found.is_empty() {
        return CliDetection::not_found();
    }

    let found_path = PathBuf::from(&found);
    if let Some(jean_path) = jean_managed {
        if let Ok(canonical_found) = std::fs::canonicalize(&found_path) {
            if canonical_found == jean_path {
                return CliDetection::not_found();
            }
        }
    }

    let version = match silent_command(&found_path).arg("--version").output() {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => None,
    };

    CliDetection {
        found: true,
        path: Some(found),
        version,
        package_manager: detect_package_manager(&found_path),
    }
}

#[cfg(test)]
mod tests {
    use super::super::wsl_detect_package_manager;

    #[test]
    fn wsl_pkg_mgr_homebrew() {
        assert_eq!(
            wsl_detect_package_manager("/home/linuxbrew/.linuxbrew/bin/gh"),
            Some("homebrew".to_string())
        );
    }
}
