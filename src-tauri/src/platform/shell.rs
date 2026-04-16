// Cross-platform shell detection and command execution

#[cfg(unix)]
use std::env;

/// Returns the user's default shell path
/// - Unix: Uses $SHELL env var, falls back to /bin/sh
/// - Windows: Returns powershell.exe (for general shell tasks)
#[cfg(unix)]
pub fn get_default_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

#[cfg(windows)]
pub fn get_default_shell() -> String {
    let wsl = super::get_wsl_config();
    if wsl.enabled {
        "wsl.exe".to_string()
    } else {
        "powershell.exe".to_string()
    }
}

/// Check if an executable exists in PATH
#[cfg(target_os = "linux")]
pub fn executable_exists(name: &str) -> bool {
    which::which(name).is_ok()
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
pub fn executable_exists(name: &str) -> bool {
    which::which(name).is_ok()
}
