use serde::Serialize;

use crate::platform::silent_command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPrerequisites {
    pub git_installed: bool,
    pub git_version: Option<String>,
    pub node_installed: bool,
    pub node_version: Option<String>,
    pub npm_installed: bool,
    pub npm_version: Option<String>,
    pub platform: String,
    pub automatic_install_supported: bool,
    pub automatic_install_command: Option<String>,
    pub manual_install_url: String,
}

fn version(command: &str) -> Option<String> {
    let output = silent_command(command).arg("--version").output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn check_system_prerequisites() -> SystemPrerequisites {
    let git_version = version("git");
    let node_version = version("node");
    let npm_version = version("npm");

    #[cfg(target_os = "linux")]
    let automatic_install_command = Some(
        "set -e; if ! command -v git >/dev/null; then if command -v apt-get >/dev/null; then sudo apt-get update && sudo apt-get install -y git; elif command -v dnf >/dev/null; then sudo dnf install -y git; elif command -v pacman >/dev/null; then sudo pacman -S --needed git; else echo 'Install Git from https://git-scm.com/download/linux'; exit 1; fi; fi; if ! command -v node >/dev/null || ! command -v npm >/dev/null; then printf '\\nInstalling the current Node.js LTS with the official nvm installer (not the often outdated distro Node.js package)...\\n'; export NVM_DIR=\"$HOME/.nvm\"; curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; . \"$NVM_DIR/nvm.sh\"; nvm install --lts; nvm alias default 'lts/*'; fi; git --version; node --version; npm --version".to_string(),
    );
    #[cfg(not(target_os = "linux"))]
    let automatic_install_command = None;

    SystemPrerequisites {
        git_installed: git_version.is_some(),
        git_version,
        node_installed: node_version.is_some(),
        node_version,
        npm_installed: npm_version.is_some(),
        npm_version,
        platform: crate::server_platform_name().to_string(),
        automatic_install_supported: automatic_install_command.is_some(),
        automatic_install_command,
        manual_install_url: "https://nodejs.org/en/download".to_string(),
    }
}

pub fn require_npm(tool: &str) -> Result<(), String> {
    if version("node").is_some() && version("npm").is_some() {
        return Ok(());
    }
    Err(format!(
        "{tool} requires Node.js and npm. Install a supported Node.js LTS using the official instructions at https://nodejs.org/en/download (distribution packages can be outdated), then retry. Jean onboarding can also install it automatically on supported Linux servers."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prerequisite_status_has_official_node_url() {
        assert_eq!(
            check_system_prerequisites().manual_install_url,
            "https://nodejs.org/en/download"
        );
    }
}
