// Cross-platform shell detection and command execution

#[cfg(unix)]
use std::env;

#[cfg(unix)]
fn shell_from_passwd(contents: &str, uid: u32) -> Option<String> {
    contents.lines().find_map(|line| {
        let fields: Vec<_> = line.split(':').collect();
        if fields.len() < 7 || fields[2].parse::<u32>().ok()? != uid {
            return None;
        }

        let shell = fields[6].trim();
        (!shell.is_empty()).then(|| shell.to_string())
    })
}

#[cfg(unix)]
fn select_default_shell(inherited_shell: Option<&str>, account_shell: Option<String>) -> String {
    account_shell
        .or_else(|| inherited_shell.map(str::to_string))
        .unwrap_or_else(|| "/bin/sh".to_string())
}

/// Returns the user's default shell path
/// - Unix: Uses the passwd entry, then a valid $SHELL, then /bin/sh
/// - Windows: Returns powershell.exe (for general shell tasks)
#[cfg(unix)]
pub fn get_default_shell() -> String {
    let inherited_shell = env::var("SHELL")
        .ok()
        .filter(|shell| !shell.trim().is_empty() && std::path::Path::new(shell).is_file());
    let account_shell = std::fs::read_to_string("/etc/passwd")
        .ok()
        .and_then(|passwd| shell_from_passwd(&passwd, unsafe { libc::geteuid() }));

    select_default_shell(inherited_shell.as_deref(), account_shell)
}

/// Load the user's interactive login-shell PATH for a Linux headless service.
///
/// systemd services normally receive a minimal PATH and do not inherit entries
/// added by shell startup files (for example `~/.bun/bin`). Browser terminals
/// should behave like terminals opened by the same user.
#[cfg(target_os = "linux")]
pub fn fix_headless_path() {
    let shell = get_default_shell();
    let output = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", "/usr/bin/printenv PATH"])
        .output();

    match output {
        Ok(output) if output.status.success() => {
            // Shell startup files may print notices. `printenv` is the final
            // command, so its last non-empty output line is the PATH value.
            let stdout = String::from_utf8_lossy(&output.stdout);
            let path = stdout
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or_default()
                .trim();
            if !path.is_empty() {
                std::env::set_var("PATH", path);
            }
        }
        Ok(output) => log::warn!(
            "Could not load PATH from login shell {shell}: exit status {}",
            output.status
        ),
        Err(error) => log::warn!("Could not start login shell {shell} to load PATH: {error}"),
    }
}

#[cfg(windows)]
pub fn get_default_shell() -> String {
    let wsl = super::wsl::get_wsl_config();
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

#[cfg(all(test, unix))]
mod tests {
    use super::{select_default_shell, shell_from_passwd};

    #[test]
    fn prefers_account_shell_over_launcher_shell() {
        assert_eq!(
            select_default_shell(Some("/bin/sh"), Some("/bin/bash".to_string())),
            "/bin/bash"
        );
    }

    #[test]
    fn finds_shell_for_uid_in_passwd() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\njean:x:1001:1001::/home/jean:/bin/zsh\n";
        assert_eq!(
            shell_from_passwd(passwd, 1001),
            Some("/bin/zsh".to_string())
        );
    }

    #[test]
    fn ignores_missing_or_empty_shells() {
        assert_eq!(
            shell_from_passwd("jean:x:1001:1001::/home/jean:\n", 1001),
            None
        );
        assert_eq!(
            shell_from_passwd("root:x:0:0:root:/root:/bin/bash\n", 1001),
            None
        );
    }
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
pub fn executable_exists(name: &str) -> bool {
    which::which(name).is_ok()
}
