//! WSL (Windows Subsystem for Linux) support
//!
//! When WSL mode is enabled, all subprocess execution is routed through `wsl.exe`
//! with proper path translation. Native Windows remains the default.

use std::process::Command;
use std::sync::{OnceLock, RwLock};

use super::silent_command;

/// Cached WSL configuration, initialized at app startup from preferences.
static WSL_CONFIG: OnceLock<RwLock<WslConfig>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct WslConfig {
    pub enabled: bool,
    pub distro: String,
}

impl Default for WslConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            distro: String::new(),
        }
    }
}

fn normalize_wsl_config(enabled: bool, distro: String) -> WslConfig {
    if enabled && distro.trim().is_empty() {
        WslConfig {
            enabled: false,
            distro: String::new(),
        }
    } else {
        WslConfig { enabled, distro }
    }
}

/// Initialize the WSL config cache from app preferences.
/// Called once at app startup.
pub fn init_wsl_config(enabled: bool, distro: String) {
    let config = normalize_wsl_config(enabled, distro);
    let lock = WSL_CONFIG.get_or_init(|| RwLock::new(WslConfig::default()));
    if let Ok(mut w) = lock.write() {
        *w = config;
    }
}

/// Read the current WSL config (cheap clone).
pub fn get_wsl_config() -> WslConfig {
    WSL_CONFIG
        .get()
        .and_then(|lock| lock.read().ok().map(|r| r.clone()))
        .unwrap_or_default()
}

#[cfg(any(target_os = "linux", test))]
fn detect_wsl_runtime(
    has_wsl_interop: bool,
    has_wsl_distro_name: bool,
    kernel_release: Option<&str>,
) -> bool {
    has_wsl_interop
        || has_wsl_distro_name
        || kernel_release.is_some_and(|release| release.to_ascii_lowercase().contains("microsoft"))
}

#[cfg(target_os = "linux")]
pub fn is_running_in_wsl() -> bool {
    detect_wsl_runtime(
        std::env::var_os("WSL_INTEROP").is_some(),
        std::env::var_os("WSL_DISTRO_NAME").is_some(),
        std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .ok()
            .as_deref(),
    )
}

#[cfg(not(target_os = "linux"))]
pub fn is_running_in_wsl() -> bool {
    false
}

/// Update WSL config at runtime (e.g., when preferences change).
pub fn update_wsl_config(enabled: bool, distro: String) {
    let config = normalize_wsl_config(enabled, distro);
    if let Some(lock) = WSL_CONFIG.get() {
        if let Ok(mut w) = lock.write() {
            *w = config;
        }
    }
}

/// Convert a Windows path to a WSL Unix path.
///
/// Handles:
/// - UNC paths: `\\wsl.localhost\Ubuntu\home\user` -> `/home/user`
/// - UNC paths: `\\wsl$\Ubuntu\home\user` -> `/home/user`
/// - Drive paths: `C:\Users\foo` -> `/mnt/c/Users/foo`
pub fn win_to_wsl_path(path: &str) -> String {
    // Normalize backslashes
    let normalized = path.replace('\\', "/");

    // Handle \\wsl.localhost\Distro\... or \\wsl$\Distro\...
    for prefix in &["//wsl.localhost/", "//wsl$/"] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            // rest = "Ubuntu/home/user/..."
            // Skip the distro name to get the Unix path
            if let Some(slash_pos) = rest.find('/') {
                return rest[slash_pos..].to_string();
            }
            // Path is just the distro root
            return "/".to_string();
        }
    }

    // Handle drive letter paths: C:\... -> /mnt/c/...
    if normalized.len() >= 3
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && &normalized[1..3] == ":/"
    {
        let drive = (normalized.as_bytes()[0] as char).to_ascii_lowercase();
        return format!("/mnt/{drive}/{}", &normalized[3..]);
    }

    // Already a Unix path or unknown format — return as-is
    normalized
}

/// Convert a WSL Unix path to a Windows UNC path.
///
/// `/home/user` -> `\\wsl.localhost\<distro>\home\user`
pub fn wsl_to_win_path(unix_path: &str, distro: &str) -> String {
    if unix_path.starts_with("/mnt/") && unix_path.len() >= 6 {
        // /mnt/c/Users/foo -> C:\Users\foo
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

/// Create a Command that routes through WSL when enabled.
///
/// On non-Windows or when WSL is disabled, this is equivalent to `silent_command(program)`
/// with an optional `current_dir`.
pub fn wsl_aware_command(program: &str, cwd: Option<&std::path::Path>) -> Command {
    if !cfg!(windows) {
        let mut cmd = silent_command(program);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        return cmd;
    }

    let config = get_wsl_config();

    if !config.enabled {
        let mut cmd = silent_command(program);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        return cmd;
    }

    // Route through wsl.exe
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

fn is_windows_batch_file(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliLaunchPlan {
    program: String,
    args: Vec<String>,
    cwd: Option<std::path::PathBuf>,
}

fn cli_launch_plan(
    program: &str,
    cwd: Option<&std::path::Path>,
    is_windows: bool,
    wsl_enabled: bool,
    wsl_distro: &str,
) -> CliLaunchPlan {
    if is_windows && wsl_enabled {
        let mut args = vec!["-d".to_string(), wsl_distro.to_string()];
        if let Some(dir) = cwd {
            args.extend(["--cd".to_string(), win_to_wsl_path(&dir.to_string_lossy())]);
        }
        args.extend(["--".to_string(), program.to_string()]);
        return CliLaunchPlan {
            program: "wsl.exe".to_string(),
            args,
            cwd: None,
        };
    }

    // Prefer a CreateProcessW-friendly sibling (.exe/.cmd/.bat) when the
    // resolved path is an extensionless npm shim (os error 193 / issue #265).
    let program = if is_windows {
        crate::platform::prefer_windows_executable_sibling(std::path::PathBuf::from(program))
            .to_string_lossy()
            .into_owned()
    } else {
        program.to_string()
    };

    if is_windows && is_windows_batch_file(&program) {
        return CliLaunchPlan {
            program: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), program],
            cwd: cwd.map(std::path::Path::to_path_buf),
        };
    }

    CliLaunchPlan {
        program,
        args: Vec::new(),
        cwd: cwd.map(std::path::Path::to_path_buf),
    }
}

/// Create a Command for a resolved CLI path.
///
/// This routes Unix paths through WSL when WSL mode is enabled and wraps
/// Windows `.cmd`/`.bat` npm shims in `cmd.exe /C`, because CreateProcessW
/// cannot launch those scripts directly.
pub fn cli_command(program: &str, cwd: Option<&std::path::Path>) -> Command {
    let config = get_wsl_config();
    let plan = cli_launch_plan(program, cwd, cfg!(windows), config.enabled, &config.distro);
    let mut cmd = silent_command(plan.program);
    cmd.args(plan.args);
    if let Some(dir) = plan.cwd {
        cmd.current_dir(dir);
    }
    cmd
}

/// True when `path` is a Unix-style absolute path that only exists inside WSL.
pub fn is_wsl_unix_path(path: &std::path::Path) -> bool {
    path.to_string_lossy().starts_with('/')
}

/// Check whether a resolved CLI path/tool is available in the current execution
/// context. In WSL mode, Unix paths must be checked inside the distro instead
/// of with Windows filesystem APIs.
pub fn resolved_cli_exists(path: &std::path::Path) -> bool {
    let config = get_wsl_config();
    if cfg!(windows) && config.enabled {
        let tool = path.to_string_lossy();
        if tool.starts_with('/') {
            return wsl_file_executable(&config.distro, &tool);
        }
        return check_wsl_tool(&config.distro, &tool);
    }

    path.exists()
}

/// Build a command for a resolved CLI path/tool in the current execution
/// context. In WSL mode this routes through `wsl.exe --cd <cwd> -- <tool>`.
pub fn resolved_cli_command(path: &std::path::Path, cwd: Option<&std::path::Path>) -> Command {
    let program = path.to_string_lossy();
    wsl_aware_command(&program, cwd)
}

/// Check if WSL is available on this system.
#[cfg(windows)]
pub fn is_wsl_available() -> bool {
    silent_command("wsl.exe")
        .arg("--status")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn is_wsl_available() -> bool {
    false
}

/// List available WSL distributions.
#[cfg(windows)]
pub fn list_wsl_distros() -> Vec<String> {
    let output = match silent_command("wsl.exe").args(["-l", "-q"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };

    // wsl -l -q on Windows outputs UTF-16LE
    let stdout = &output.stdout;
    let text = if stdout.len() >= 2 && stdout[0] == 0xFF && stdout[1] == 0xFE {
        // UTF-16LE BOM
        decode_utf16le(&stdout[2..])
    } else if stdout.contains(&0) {
        // No BOM but has null bytes — likely UTF-16LE
        decode_utf16le(stdout)
    } else {
        String::from_utf8_lossy(stdout).to_string()
    };

    text.lines()
        .map(|l| l.trim().trim_matches('\0'))
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

#[cfg(not(windows))]
pub fn list_wsl_distros() -> Vec<String> {
    vec![]
}

/// Decode a byte slice as UTF-16LE to a String.
fn decode_utf16le(bytes: &[u8]) -> String {
    let u16s: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    String::from_utf16_lossy(&u16s)
}

/// Check if a tool exists inside a WSL distro.
///
/// Uses a login shell (`bash -lc`) so `$PATH` modifications from `~/.profile`,
/// `~/.bash_profile`, and (via Ubuntu's default `.profile`) `~/.bashrc`
/// are applied. Without this, tools installed via nvm / bun / volta / npm
/// global (which modify PATH in rc files) appear "not installed".
#[cfg(windows)]
pub fn check_wsl_tool(distro: &str, tool: &str) -> bool {
    let script = format!("command -v {} >/dev/null 2>&1", shell_single_quote(tool));
    silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn check_wsl_tool(_distro: &str, _tool: &str) -> bool {
    false
}

fn select_wsl_which_candidate(output: &str, jean_managed: Option<&str>) -> Option<String> {
    let jean_managed = jean_managed.map(str::trim).filter(|p| !p.is_empty());

    output
        .lines()
        .map(str::trim)
        .find(|path| {
            !path.is_empty()
                && jean_managed
                    .map(|jean_path| *path != jean_path)
                    .unwrap_or(true)
        })
        .map(ToString::to_string)
}

#[cfg(any(windows, test))]
fn build_wsl_which_script(tool: &str, jean_managed: Option<&str>) -> String {
    let jean_init = if let Some(jean_path) = jean_managed.map(str::trim).filter(|p| !p.is_empty()) {
        format!(
            "jean={}; jean_real=$(readlink -f -- \"$jean\" 2>/dev/null || printf '%s' \"$jean\");",
            shell_single_quote(jean_path)
        )
    } else {
        "jean=''; jean_real='';".to_string()
    };

    format!(
        "{jean_init} \
         tool={tool}; \
         emit_candidate() {{ \
           candidate=\"$1\"; \
           [ -n \"$candidate\" ] || return 0; \
           [ -x \"$candidate\" ] || return 0; \
           candidate_real=$(readlink -f -- \"$candidate\" 2>/dev/null || printf '%s' \"$candidate\"); \
           if [ -z \"$jean_real\" ] || [ \"$candidate_real\" != \"$jean_real\" ]; then printf '%s\\n' \"$candidate\"; exit 0; fi; \
         }}; \
         while IFS= read -r candidate; do emit_candidate \"$candidate\"; done < <(type -P -a \"$tool\" 2>/dev/null); \
         for dir in \"$HOME/.local/bin\" \"$HOME/.npm-global/bin\" \"$HOME/.bun/bin\"; do emit_candidate \"$dir/$tool\"; done; \
         exit 1",
        tool = shell_single_quote(tool),
    )
}

/// Resolve the Unix path of a tool inside a WSL distro via `type -P -a`
/// in a login shell, optionally excluding Jean's managed binary.
#[cfg(windows)]
pub fn wsl_which(distro: &str, tool: &str, jean_managed: Option<&str>) -> Option<String> {
    let script = build_wsl_which_script(tool, jean_managed);
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    select_wsl_which_candidate(&String::from_utf8_lossy(&output.stdout), None)
}

#[cfg(not(windows))]
pub fn wsl_which(_distro: &str, _tool: &str, _jean_managed: Option<&str>) -> Option<String> {
    None
}

/// Get the `--version` output of a tool inside a WSL distro.
///
/// Runs the command in a login shell so rc-file `$PATH` additions apply.
/// If `tool` is an absolute path it executes directly regardless of PATH.
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
    let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if ver.is_empty() {
        None
    } else {
        Some(ver)
    }
}

#[cfg(not(windows))]
pub fn wsl_tool_version(_distro: &str, _tool: &str) -> Option<String> {
    None
}

/// Detect the package manager for a tool installed inside WSL, based on its Unix path.
/// Pure string inspection — no process spawn.
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

/// Detect the CPU architecture inside a WSL distro.
/// Returns the key used by the Claude distribution manifest
/// (`"linux-x64"` / `"linux-arm64"`), or `None` if unsupported.
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

/// Shell-escape a string for use inside single-quoted bash.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn wsl_remove_path_script(unix_path: &str) -> String {
    format!("rm -rf -- {}", shell_single_quote(unix_path))
}

fn wsl_remove_file_script(unix_path: &str) -> String {
    format!("rm -f -- {}", shell_single_quote(unix_path))
}

/// Write `bytes` to `unix_path` inside a WSL distro.
/// Creates any missing parent directories. Transfers bytes via stdin into
/// `bash -c "mkdir -p <dir> && cat > <path>"` so no intermediate file is
/// required on the Windows side.
#[cfg(windows)]
pub fn wsl_write_bytes(distro: &str, unix_path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let dir = unix_path.rfind('/').map(|i| &unix_path[..i]).unwrap_or("/");
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

/// Remove a file inside a WSL distro. Missing files are ignored.
#[cfg(windows)]
pub fn wsl_remove_file(distro: &str, unix_path: &str) -> Result<(), String> {
    let script = wsl_remove_file_script(unix_path);
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-c", &script])
        .output()
        .map_err(|e| format!("Failed to run wsl.exe rm: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rm failed inside WSL: {stderr}"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn wsl_remove_file(_distro: &str, _unix_path: &str) -> Result<(), String> {
    Err("WSL is not available on this platform".to_string())
}

/// Remove a file or directory inside a WSL distro. Missing paths are ignored.
#[cfg(windows)]
pub fn wsl_remove_path(distro: &str, unix_path: &str) -> Result<(), String> {
    let script = wsl_remove_path_script(unix_path);
    let output = silent_command("wsl.exe")
        .args(["-d", distro, "--", "bash", "-c", &script])
        .output()
        .map_err(|e| format!("Failed to run wsl.exe rm: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rm failed inside WSL: {stderr}"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn wsl_remove_path(_distro: &str, _unix_path: &str) -> Result<(), String> {
    Err("WSL is not available on this platform".to_string())
}

/// Make a file executable (chmod +x) inside a WSL distro.
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

/// Check that a file exists and is executable inside a WSL distro.
#[cfg(windows)]
pub fn wsl_file_executable(distro: &str, unix_path: &str) -> bool {
    silent_command("wsl.exe")
        .args(["-d", distro, "--", "test", "-x", unix_path])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn wsl_file_executable(_distro: &str, _unix_path: &str) -> bool {
    false
}

/// Get the home directory inside a WSL distro.
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
    fn detect_wsl_runtime_accepts_environment_markers() {
        assert!(detect_wsl_runtime(true, false, None));
        assert!(detect_wsl_runtime(false, true, None));
    }

    #[test]
    fn detect_wsl_runtime_accepts_microsoft_kernel_release() {
        assert!(detect_wsl_runtime(
            false,
            false,
            Some("5.15.153.1-microsoft-standard-WSL2")
        ));
    }

    #[test]
    fn detect_wsl_runtime_rejects_native_linux() {
        assert!(!detect_wsl_runtime(false, false, Some("6.8.0-52-generic")));
    }

    #[test]
    fn test_normalize_wsl_config_disables_empty_enabled_distro() {
        let config = normalize_wsl_config(true, String::new());

        assert!(!config.enabled);
        assert_eq!(config.distro, "");
    }

    #[test]
    fn test_normalize_wsl_config_disables_whitespace_enabled_distro() {
        let config = normalize_wsl_config(true, "   \t\n  ".to_string());

        assert!(!config.enabled);
        assert_eq!(config.distro, "");
    }

    #[test]
    fn test_normalize_wsl_config_preserves_valid_enabled_distro() {
        let config = normalize_wsl_config(true, "Ubuntu".to_string());

        assert!(config.enabled);
        assert_eq!(config.distro, "Ubuntu");
    }

    #[test]
    fn test_normalize_wsl_config_keeps_disabled_state() {
        let config = normalize_wsl_config(false, String::new());

        assert!(!config.enabled);
        assert_eq!(config.distro, "");
    }

    #[test]
    fn test_win_to_wsl_path_unc_localhost() {
        assert_eq!(
            win_to_wsl_path(r"\\wsl.localhost\Ubuntu\home\user\project"),
            "/home/user/project"
        );
    }

    #[test]
    fn test_is_wsl_unix_path_detects_linux_absolute_path() {
        assert!(is_wsl_unix_path(std::path::Path::new(
            "/home/alice/.local/share/jean/gh-cli/gh"
        )));
    }

    #[test]
    fn test_is_wsl_unix_path_rejects_windows_path() {
        assert!(!is_wsl_unix_path(std::path::Path::new(
            r"C:\Users\alice\AppData\Roaming\jean\gh-cli\gh.exe"
        )));
    }

    #[test]
    fn test_win_to_wsl_path_unc_wsl_dollar() {
        assert_eq!(win_to_wsl_path(r"\\wsl$\Ubuntu\home\user"), "/home/user");
    }

    #[test]
    fn test_win_to_wsl_path_drive_letter() {
        assert_eq!(
            win_to_wsl_path(r"C:\Users\foo\project"),
            "/mnt/c/Users/foo/project"
        );
    }

    #[test]
    fn test_win_to_wsl_path_unix_passthrough() {
        assert_eq!(win_to_wsl_path("/home/user"), "/home/user");
    }

    #[test]
    fn test_wsl_to_win_path_home() {
        assert_eq!(
            wsl_to_win_path("/home/user/project", "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\home\user\project"
        );
    }

    #[test]
    fn test_wsl_to_win_path_mnt() {
        assert_eq!(
            wsl_to_win_path("/mnt/c/Users/foo", "Ubuntu"),
            r"C:\Users\foo"
        );
    }

    #[test]
    fn test_wsl_aware_command_disabled() {
        // With default (disabled) config, should behave like silent_command
        let cmd = wsl_aware_command("git", Some(std::path::Path::new("/tmp")));
        let program = format!("{:?}", cmd.get_program());
        assert!(program.contains("git"));
    }

    #[cfg(not(windows))]
    #[test]
    fn test_wsl_aware_command_non_windows_ignores_enabled_config() {
        init_wsl_config(true, "Ubuntu".to_string());

        let cwd = std::path::Path::new("/tmp");
        let cmd = wsl_aware_command("git", Some(cwd));
        let program = format!("{:?}", cmd.get_program());

        assert!(program.contains("git"));
        assert!(!program.contains("wsl.exe"));
        assert_eq!(cmd.get_current_dir(), Some(cwd));
    }

    #[test]
    fn cli_launch_plan_wraps_windows_cmd_shim() {
        let plan = cli_launch_plan(
            r"C:\Users\u\AppData\Roaming\npm\codex.cmd",
            Some(std::path::Path::new(r"C:\tmp")),
            true,
            false,
            "Ubuntu",
        );

        assert_eq!(plan.program, "cmd.exe");
        assert_eq!(
            plan.args,
            vec!["/C", r"C:\Users\u\AppData\Roaming\npm\codex.cmd"]
        );
        assert_eq!(plan.cwd, Some(std::path::PathBuf::from(r"C:\tmp")));
    }

    #[test]
    fn cli_launch_plan_wraps_windows_bat_shim() {
        let plan = cli_launch_plan(r"C:\tools\run.bat", None, true, false, "Ubuntu");

        assert_eq!(plan.program, "cmd.exe");
        assert_eq!(plan.args, vec!["/C", r"C:\tools\run.bat"]);
        assert_eq!(plan.cwd, None);
    }

    #[test]
    fn cli_launch_plan_routes_windows_wsl_mode_through_wsl_exe() {
        let plan = cli_launch_plan(
            "/home/u/.local/bin/codex",
            Some(std::path::Path::new(r"C:\Users\u\repo")),
            true,
            true,
            "Ubuntu",
        );

        assert_eq!(plan.program, "wsl.exe");
        assert_eq!(
            plan.args,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/mnt/c/Users/u/repo",
                "--",
                "/home/u/.local/bin/codex"
            ]
        );
        assert_eq!(plan.cwd, None);
    }

    #[test]
    fn cli_launch_plan_uses_direct_binary_for_normal_host_exe() {
        let plan = cli_launch_plan(
            r"C:\tools\codex.exe",
            Some(std::path::Path::new(r"C:\repo")),
            true,
            false,
            "Ubuntu",
        );

        assert_eq!(plan.program, r"C:\tools\codex.exe");
        assert!(plan.args.is_empty());
        assert_eq!(plan.cwd, Some(std::path::PathBuf::from(r"C:\repo")));
    }

    #[test]
    fn test_decode_utf16le() {
        let input = "Ubuntu\0"
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect::<Vec<_>>();
        let result = decode_utf16le(&input);
        assert!(result.contains("Ubuntu"));
    }

    #[test]
    fn select_wsl_which_candidate_skips_jean_managed_path() {
        let candidates = "/home/u/.local/share/jean/codex-cli/codex\n/usr/bin/codex\n";

        assert_eq!(
            select_wsl_which_candidate(
                candidates,
                Some("/home/u/.local/share/jean/codex-cli/codex")
            ),
            Some("/usr/bin/codex".to_string())
        );
    }

    #[test]
    fn select_wsl_which_candidate_returns_none_when_only_jean_managed_path_exists() {
        let candidates = "/home/u/.local/share/jean/gh-cli/gh\n";

        assert_eq!(
            select_wsl_which_candidate(candidates, Some("/home/u/.local/share/jean/gh-cli/gh")),
            None
        );
    }

    #[test]
    fn build_wsl_which_script_falls_back_to_home_local_bin() {
        let script = build_wsl_which_script("claude", None);

        assert!(script.contains("$HOME/.local/bin"));
        assert!(script.contains("[ -x \"$candidate\" ]"));
    }

    #[test]
    fn test_wsl_remove_path_script_quotes_path() {
        let script = wsl_remove_path_script("/home/o'hara/.local/share/jean/claude-cli");

        assert_eq!(
            script,
            "rm -rf -- '/home/o'\\''hara/.local/share/jean/claude-cli'"
        );
    }

    #[test]
    fn test_wsl_remove_file_script_quotes_path() {
        let script = wsl_remove_file_script("/home/o'hara/.local/share/jean/opencode-cli/opencode");

        assert_eq!(
            script,
            "rm -f -- '/home/o'\\''hara/.local/share/jean/opencode-cli/opencode'"
        );
    }
}
