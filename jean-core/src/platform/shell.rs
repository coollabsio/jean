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

/// Load the user's interactive login-shell PATH on Linux.
///
/// systemd services and desktop launchers start Jean with a minimal PATH that
/// misses entries added by shell startup files (for example `~/.bun/bin`,
/// mise, or nvm), so CLIs installed there are not found. Entries already on
/// PATH (such as tools bundled in an AppImage) are kept after the login-shell
/// entries.
#[cfg(target_os = "linux")]
pub fn fix_linux_path() {
    let shell = get_default_shell();
    let output = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", "/usr/bin/printenv PATH"])
        .stdin(std::process::Stdio::null())
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
                let current = std::env::var("PATH").ok();
                std::env::set_var("PATH", merge_login_shell_path(path, current.as_deref()));
            }
        }
        Ok(output) => log::warn!(
            "Could not load PATH from login shell {shell}: exit status {}",
            output.status
        ),
        Err(error) => log::warn!("Could not start login shell {shell} to load PATH: {error}"),
    }
}

/// Login-shell PATH entries first, then current entries it does not contain.
#[cfg(any(target_os = "linux", test))]
fn merge_login_shell_path(login_path: &str, current_path: Option<&str>) -> String {
    let mut entries: Vec<&str> = Vec::new();
    for entry in login_path
        .split(':')
        .chain(current_path.unwrap_or_default().split(':'))
    {
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    entries.join(":")
}

/// Add fnm's default Node.js to PATH when the Windows app cannot find Node.
///
/// fnm puts Node on PATH only from shell profiles (`fnm env`), so Jean started
/// from the Start menu cannot find `node`/`npm` (issue #797). Appending fnm's
/// `aliases\default` directory makes npm installs and npm CLI shims work.
/// No-op on other platforms, where the login-shell PATH is loaded instead.
pub fn add_fnm_node_to_path() {
    #[cfg(windows)]
    {
        use std::env::var_os;
        let fnm_dirs = [
            var_os("FNM_DIR").map(std::path::PathBuf::from),
            var_os("APPDATA").map(|dir| std::path::Path::new(&dir).join("fnm")),
            var_os("USERPROFILE").map(|dir| std::path::Path::new(&dir).join(".fnm")),
        ];
        if let Some(path) =
            path_with_fnm_default_node(var_os("PATH").as_deref(), fnm_dirs.into_iter().flatten())
        {
            std::env::set_var("PATH", path);
        }
    }
}

/// Return PATH with fnm's default Node.js directory appended, or `None` when
/// PATH already has `node.exe` or no fnm default version exists.
#[cfg(any(windows, test))]
fn path_with_fnm_default_node(
    path: Option<&std::ffi::OsStr>,
    fnm_dirs: impl IntoIterator<Item = std::path::PathBuf>,
) -> Option<std::ffi::OsString> {
    let mut entries: Vec<_> = path
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect();
    if entries.iter().any(|dir| dir.join("node.exe").is_file()) {
        return None;
    }
    let node_dir = fnm_dirs
        .into_iter()
        .map(|dir| dir.join("aliases").join("default"))
        .find(|dir| dir.join("node.exe").is_file())?;
    entries.push(node_dir);
    std::env::join_paths(entries).ok()
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
    use super::{merge_login_shell_path, select_default_shell, shell_from_passwd};

    #[test]
    fn login_shell_path_comes_first_and_keeps_current_entries() {
        assert_eq!(
            merge_login_shell_path(
                "/home/u/.local/share/mise/shims:/usr/bin:/bin",
                Some("/tmp/.mount_jean/usr/bin:/usr/bin:/bin")
            ),
            "/home/u/.local/share/mise/shims:/usr/bin:/bin:/tmp/.mount_jean/usr/bin"
        );
    }

    #[test]
    fn merge_drops_empty_and_duplicate_entries() {
        assert_eq!(merge_login_shell_path("/a::/b:/a", None), "/a:/b");
        assert_eq!(merge_login_shell_path("/a", Some("")), "/a");
    }

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

#[cfg(test)]
mod fnm_path_tests {
    use super::path_with_fnm_default_node;
    use std::path::{Path, PathBuf};

    fn fnm_dir_with_default_node(root: &Path) -> PathBuf {
        let fnm_dir = root.join("fnm");
        let default_dir = fnm_dir.join("aliases").join("default");
        std::fs::create_dir_all(&default_dir).expect("create fnm default dir");
        std::fs::write(default_dir.join("node.exe"), b"").expect("write node.exe");
        fnm_dir
    }

    #[test]
    fn appends_fnm_default_when_node_is_missing_from_path() {
        let root = tempfile::tempdir().expect("tempdir");
        let fnm_dir = fnm_dir_with_default_node(root.path());
        let system = root.path().join("system32");
        let path = std::env::join_paths([&system]).unwrap();

        let updated = path_with_fnm_default_node(
            Some(&path),
            [root.path().join("missing-fnm"), fnm_dir.clone()],
        )
        .expect("fnm default should be added");

        assert_eq!(
            std::env::split_paths(&updated).collect::<Vec<_>>(),
            vec![system, fnm_dir.join("aliases").join("default")]
        );
    }

    #[test]
    fn keeps_path_when_node_is_already_on_path() {
        let root = tempfile::tempdir().expect("tempdir");
        let fnm_dir = fnm_dir_with_default_node(root.path());
        let nodejs = root.path().join("nodejs");
        std::fs::create_dir_all(&nodejs).unwrap();
        std::fs::write(nodejs.join("node.exe"), b"").unwrap();
        let path = std::env::join_paths([&nodejs]).unwrap();

        assert_eq!(path_with_fnm_default_node(Some(&path), [fnm_dir]), None);
    }

    #[test]
    fn keeps_path_when_fnm_has_no_default_version() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(root.path().join("fnm").join("aliases")).unwrap();

        assert_eq!(
            path_with_fnm_default_node(None, [root.path().join("fnm")]),
            None
        );
    }
}
