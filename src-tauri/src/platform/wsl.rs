//! WSL (Windows Subsystem for Linux) support.
//!
//! When WSL mode is enabled, subprocess execution can be routed through
//! `wsl.exe` with path translation so Jean can operate directly inside a Linux
//! distro from a Windows host.

use std::process::Command;
use std::sync::{OnceLock, RwLock};

use super::silent_command;

/// Cached WSL configuration, initialized from app preferences.
static WSL_CONFIG: OnceLock<RwLock<WslConfig>> = OnceLock::new();

#[derive(Debug, Clone, Default)]
pub struct WslConfig {
    pub enabled: bool,
    pub distro: String,
}

/// Initialize the cached WSL config.
pub fn init_wsl_config(enabled: bool, distro: String) {
    let config = WslConfig { enabled, distro };
    let lock = WSL_CONFIG.get_or_init(|| RwLock::new(WslConfig::default()));
    if let Ok(mut guard) = lock.write() {
        *guard = config;
    }
}

/// Update the cached WSL config at runtime.
pub fn update_wsl_config(enabled: bool, distro: String) {
    if let Some(lock) = WSL_CONFIG.get() {
        if let Ok(mut guard) = lock.write() {
            guard.enabled = enabled;
            guard.distro = distro;
        }
    }
}

/// Read the current WSL config.
pub fn get_wsl_config() -> WslConfig {
    WSL_CONFIG
        .get()
        .and_then(|lock| lock.read().ok().map(|guard| guard.clone()))
        .unwrap_or_default()
}

/// Convert a Windows path to a WSL path.
pub fn win_to_wsl_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");

    for prefix in &["//wsl.localhost/", "//wsl$/"] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            if let Some(slash_pos) = rest.find('/') {
                return rest[slash_pos..].to_string();
            }
            return "/".to_string();
        }
    }

    if normalized.len() >= 3
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && &normalized[1..3] == ":/"
    {
        let drive = (normalized.as_bytes()[0] as char).to_ascii_lowercase();
        return format!("/mnt/{drive}/{}", &normalized[3..]);
    }

    normalized
}

/// Convert a path to the string form that should be passed to a WSL command.
///
/// When WSL mode is disabled, this returns the original path string.
/// When WSL mode is enabled, Windows-style paths are translated to WSL paths.
pub fn wsl_cli_path_arg(path: impl AsRef<std::path::Path>) -> String {
    let path_str = path.as_ref().to_string_lossy().to_string();
    if get_wsl_config().enabled {
        win_to_wsl_path(&path_str)
    } else {
        path_str
    }
}

/// Convert a WSL path to a Windows path.
pub fn wsl_to_win_path(unix_path: &str, distro: &str) -> String {
    if unix_path.starts_with("/mnt/") && unix_path.len() >= 6 {
        let drive = (unix_path.as_bytes()[5] as char).to_ascii_uppercase();
        let rest = if unix_path.len() > 6 {
            &unix_path[6..]
        } else {
            "\\"
        };
        return format!("{drive}:{}", rest.replace('/', "\\"));
    }

    format!(
        "\\\\wsl.localhost\\{distro}{}",
        unix_path.replace('/', "\\")
    )
}

/// Build a command that routes through WSL when enabled.
pub fn wsl_aware_command<P: AsRef<std::ffi::OsStr>>(
    program: P,
    cwd: Option<&std::path::Path>,
) -> Command {
    let config = get_wsl_config();
    let program = program.as_ref().to_string_lossy().to_string();

    if !config.enabled {
        let mut cmd = silent_command(program);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        return cmd;
    }

    let mut cmd = silent_command("wsl.exe");
    let mut args = vec!["-d".to_string(), config.distro.clone()];

    if let Some(dir) = cwd {
        let dir_str = dir.to_string_lossy();
        let unix_path = win_to_wsl_path(&dir_str);
        args.extend(["--cd".to_string(), unix_path]);
    }

    args.extend(["--".to_string(), program.to_string()]);
    cmd.args(&args);
    cmd
}

/// Check whether a resolved command path is usable in the current execution mode.
///
/// On Windows with WSL mode enabled, this validates the path inside the selected
/// WSL distro instead of checking the host filesystem.
pub fn path_available_for_execution(path: &std::path::Path) -> bool {
    let config = get_wsl_config();
    if !config.enabled {
        return path.exists();
    }

    #[cfg(windows)]
    {
        let path_str = path.to_string_lossy().to_string();
        if path_str.contains('/') || path_str.contains('\\') || path_str.contains(':') {
            let unix_path = win_to_wsl_path(&path_str);
            return wsl_file_executable(&config.distro, &unix_path);
        }

        return check_wsl_tool(&config.distro, &path_str);
    }

    #[cfg(not(windows))]
    {
        path.exists()
    }
}

#[cfg(windows)]
pub fn is_wsl_available() -> bool {
    silent_command("wsl.exe")
        .arg("--status")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn is_wsl_available() -> bool {
    false
}

#[cfg(windows)]
pub fn list_wsl_distros() -> Vec<String> {
    let output = match silent_command("wsl.exe").args(["-l", "-q"]).output() {
        Ok(output) if output.status.success() => output,
        _ => return vec![],
    };

    let stdout = &output.stdout;
    let text = if stdout.len() >= 2 && stdout[0] == 0xFF && stdout[1] == 0xFE {
        decode_utf16le(&stdout[2..])
    } else if stdout.iter().any(|&b| b == 0) {
        decode_utf16le(stdout)
    } else {
        String::from_utf8_lossy(stdout).to_string()
    };

    text.lines()
        .map(|line| line.trim().trim_matches('\0'))
        .filter(|line| !line.is_empty())
        .map(String::from)
        .collect()
}

#[cfg(not(windows))]
pub fn list_wsl_distros() -> Vec<String> {
    vec![]
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let u16s: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    String::from_utf16_lossy(&u16s)
}

/// Check whether a tool exists in a WSL distro.
#[cfg(windows)]
pub fn check_wsl_tool(distro: &str, tool: &str) -> bool {
    let script = format!("command -v {} >/dev/null 2>&1", shell_single_quote(tool));
    silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn check_wsl_tool(_distro: &str, _tool: &str) -> bool {
    false
}

/// Resolve the Unix path to a tool inside a WSL distro.
#[cfg(windows)]
pub fn wsl_which(distro: &str, tool: &str) -> Option<String> {
    let script = format!("command -v {}", shell_single_quote(tool));
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(windows))]
pub fn wsl_which(_distro: &str, _tool: &str) -> Option<String> {
    None
}

/// Get the `--version` output of a WSL tool.
#[cfg(windows)]
pub fn wsl_tool_version(distro: &str, tool: &str) -> Option<String> {
    let script = format!("{} --version", shell_single_quote(tool));
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

#[cfg(not(windows))]
pub fn wsl_tool_version(_distro: &str, _tool: &str) -> Option<String> {
    None
}

/// Detect the package manager for a WSL-installed tool from its Unix path.
pub fn wsl_detect_package_manager(unix_path: &str) -> Option<String> {
    if unix_path.contains("/homebrew/") || unix_path.contains("/linuxbrew/") {
        return Some("homebrew".to_string());
    }
    if unix_path.contains("/.bun/") {
        return Some("bun".to_string());
    }
    if unix_path.contains("/node_modules/") || unix_path.contains("/.npm/") {
        return Some("npm".to_string());
    }
    if unix_path.contains("/.cargo/") {
        return Some("cargo".to_string());
    }
    None
}

/// Detect the architecture inside a WSL distro.
#[cfg(windows)]
pub fn wsl_detect_arch(distro: &str) -> Option<&'static str> {
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "uname", "-m"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let arch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match arch.as_str() {
        "x86_64" | "amd64" => Some("linux-x64"),
        "aarch64" | "arm64" => Some("linux-arm64"),
        _ => None,
    }
}

#[cfg(not(windows))]
pub fn wsl_detect_arch(_distro: &str) -> Option<&'static str> {
    None
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(windows)]
pub fn wsl_write_bytes(distro: &str, unix_path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let dir = unix_path
        .rfind('/')
        .map(|idx| &unix_path[..idx])
        .unwrap_or("/");
    let script = format!(
        "mkdir -p {dir_q} && cat > {path_q}",
        dir_q = shell_single_quote(dir),
        path_q = shell_single_quote(unix_path),
    );

    let mut child = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-c", &script])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn wsl.exe: {e}"))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "Failed to open wsl.exe stdin".to_string())?;
        stdin
            .write_all(bytes)
            .map_err(|e| format!("Failed to stream bytes into WSL: {e}"))?;
    }

    let status = child
        .wait()
        .map_err(|e| format!("wsl.exe did not exit cleanly: {e}"))?;
    if !status.success() {
        return Err(format!("Failed to write file inside WSL (exit {status})"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn wsl_write_bytes(_distro: &str, _unix_path: &str, _bytes: &[u8]) -> Result<(), String> {
    Err("WSL is not available on this platform".to_string())
}

#[cfg(windows)]
pub fn wsl_chmod_exec(distro: &str, unix_path: &str) -> Result<(), String> {
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "chmod", "+x", unix_path])
        .output()
        .map_err(|e| format!("Failed to run wsl.exe chmod: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("chmod failed inside WSL: {stderr}"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn wsl_chmod_exec(_distro: &str, _unix_path: &str) -> Result<(), String> {
    Err("WSL is not available on this platform".to_string())
}

#[cfg(windows)]
pub fn wsl_file_executable(distro: &str, unix_path: &str) -> bool {
    silent_command("wsl.exe")
        .args(["-d", distro, "--", "test", "-x", unix_path])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn wsl_file_executable(_distro: &str, _unix_path: &str) -> bool {
    false
}

#[cfg(windows)]
pub fn get_wsl_home_dir(distro: &str) -> Result<String, String> {
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "sh", "-c", "echo $HOME"])
        .output()
        .map_err(|e| format!("Failed to run wsl.exe: {e}"))?;

    if !output.status.success() {
        return Err("Failed to get WSL home directory".to_string());
    }

    let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if home.is_empty() {
        return Err("WSL home directory is empty".to_string());
    }
    Ok(home)
}

#[cfg(not(windows))]
pub fn get_wsl_home_dir(_distro: &str) -> Result<String, String> {
    Err("WSL is not available on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_to_wsl_path_drive_letter() {
        assert_eq!(
            win_to_wsl_path(r"C:\Users\foo\project"),
            "/mnt/c/Users/foo/project"
        );
    }

    #[test]
    fn win_to_wsl_path_unc() {
        assert_eq!(
            win_to_wsl_path(r"\\wsl.localhost\Ubuntu\home\user\project"),
            "/home/user/project"
        );
    }

    #[test]
    fn wsl_cli_path_arg_translates_windows_style_paths() {
        init_wsl_config(true, "Ubuntu".to_string());
        assert_eq!(
            wsl_cli_path_arg(r"C:\Users\foo\project"),
            "/mnt/c/Users/foo/project"
        );
        update_wsl_config(false, String::new());
    }

    #[test]
    fn wsl_to_win_path_home() {
        assert_eq!(
            wsl_to_win_path("/home/user/project", "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\home\user\project"
        );
    }

    #[test]
    fn wsl_to_win_path_mnt() {
        assert_eq!(
            wsl_to_win_path("/mnt/c/Users/foo", "Ubuntu"),
            r"C:\Users\foo"
        );
    }

    #[test]
    fn decode_utf16le_roundtrip() {
        let input = "Ubuntu\0"
            .encode_utf16()
            .flat_map(|ch| ch.to_le_bytes())
            .collect::<Vec<_>>();
        let result = decode_utf16le(&input);
        assert!(result.contains("Ubuntu"));
    }
}
