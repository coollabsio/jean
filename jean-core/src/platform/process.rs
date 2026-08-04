// Cross-platform process management

use std::process::Command;

/// Escape a string for safe use in a shell command.
/// Wraps in single quotes and escapes any embedded single quotes.
#[cfg(unix)]
pub fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Ensures macOS PATH has been fixed from the user's login shell.
/// Uses `std::sync::Once` so the shell is only spawned on the first call.
/// This must NOT call `silent_command()` internally to avoid recursion.
#[cfg(target_os = "macos")]
pub fn ensure_macos_path() {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let start = std::time::Instant::now();
        crate::fix_macos_path();
        log::info!(
            "fix_macos_path() completed in {:?} (lazy, on first CLI invocation)",
            start.elapsed()
        );
    });
}

/// Detect the package manager that installed a binary by resolving symlinks.
///
/// Returns `Some("homebrew")` if the canonical path contains `/homebrew/` or `/Cellar/`,
/// `Some("npm")` if it contains `/node_modules/`, `None` otherwise.
pub fn detect_package_manager(binary_path: &std::path::Path) -> Option<String> {
    let canonical = std::fs::canonicalize(binary_path).ok()?;
    let canonical_str = canonical.to_string_lossy();

    if canonical_str.contains("/homebrew/") || canonical_str.contains("/Cellar/") {
        return Some("homebrew".to_string());
    }

    // Check bun before generic node_modules — bun's global installs also use node_modules/
    // e.g. ~/.bun/install/global/node_modules/@openai/codex/bin/codex.js
    if canonical_str.contains("/.bun/") {
        return Some("bun".to_string());
    }

    if canonical_str.contains("/node_modules/") {
        return Some("npm".to_string());
    }

    None
}

/// Creates a Command that won't open a console window on Windows.
/// Use for all background operations (git, gh, claude CLI, etc.).
/// Do NOT use for commands that intentionally open UI (terminals, editors, file explorers).
pub fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    // Ensure macOS GUI app has the user's full PATH before spawning any subprocess.
    // Lazy + cached via Once — only the first call pays the shell-spawn cost (~100-500ms).
    #[cfg(target_os = "macos")]
    ensure_macos_path();

    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Open a URL in the system default browser without flashing a console window.
///
/// On Windows the shell association path is `cmd /c start "" <url>`. That
/// intermediary `cmd.exe` must use [`silent_command`] (`CREATE_NO_WINDOW`);
/// otherwise a visible Command Prompt briefly steals focus (issue #588).
/// The browser window itself still opens normally.
///
/// Prefer this helper over raw `Command::new("cmd")` / `open` / `xdg-open`
/// for any Jean-initiated URL launch.
pub fn open_url_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        silent_command("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        silent_command("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        // Empty title ("") is required so `start` treats the next token as the
        // URL rather than a window title when the URL is quoted/contains spaces.
        silent_command("cmd")
            .args(["/c", "start", "", url])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = url;
        return Err("Opening a browser is not supported on this platform".to_string());
    }

    Ok(())
}

/// Raise the open-file-descriptor soft limit (`RLIMIT_NOFILE`) to the hard limit.
///
/// macOS GUI apps launch with a low default soft limit (often 256). Jean spawns
/// many short-lived child processes (git, claude CLI, gh) — each needing pipe fds —
/// and with 100+ worktrees a bulk git-status refresh can exhaust the table, causing
/// `EMFILE` ("Too many open files"). That silently breaks git status AND coinciding
/// claude CLI spawns (the backgrounded child dies before writing any output, leaving
/// the run "completed" with empty content). Raising the soft limit to the hard limit
/// at startup prevents this. No-op on Windows (no such limit).
#[cfg(unix)]
pub fn raise_fd_limit() {
    unsafe {
        let mut rlim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) != 0 {
            log::warn!(
                "raise_fd_limit: getrlimit failed: {}",
                std::io::Error::last_os_error()
            );
            return;
        }

        let old_cur = rlim.rlim_cur;

        // Target the hard limit, but on macOS the kernel rejects values above
        // kern.maxfilesperproc (and rejects RLIM_INFINITY) with EINVAL, so clamp.
        #[cfg(not(target_os = "macos"))]
        let target = rlim.rlim_max;

        #[cfg(target_os = "macos")]
        let target = {
            let mut target = rlim.rlim_max;
            if let Some(max_per_proc) = macos_maxfilesperproc() {
                target = target.min(max_per_proc);
            }
            target
        };

        if old_cur >= target {
            log::info!("raise_fd_limit: soft fd limit already sufficient ({old_cur})");
            return;
        }

        rlim.rlim_cur = target;
        if libc::setrlimit(libc::RLIMIT_NOFILE, &rlim) != 0 {
            log::warn!(
                "raise_fd_limit: setrlimit to {target} failed: {}",
                std::io::Error::last_os_error()
            );
            return;
        }

        log::info!("raise_fd_limit: raised soft fd limit {old_cur} -> {target}");
    }
}

/// Read `kern.maxfilesperproc` — the kernel's per-process open-file ceiling.
/// `RLIMIT_NOFILE` cannot be raised above this on macOS.
#[cfg(target_os = "macos")]
fn macos_maxfilesperproc() -> Option<libc::rlim_t> {
    let mut value: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let name = b"kern.maxfilesperproc\0";
    let ret = unsafe {
        libc::sysctlbyname(
            name.as_ptr() as *const libc::c_char,
            &mut value as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret == 0 && value > 0 {
        Some(value as libc::rlim_t)
    } else {
        None
    }
}

/// No-op on Windows — there is no per-process open-file-descriptor limit to raise.
#[cfg(windows)]
pub fn raise_fd_limit() {}

/// Check if a process is still alive
/// - Unix: Uses kill(pid, 0) to check
/// - Windows: Uses OpenProcess + GetExitCodeProcess
#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
    // pid 0 is never a real spawned child: kill(0, 0) targets the caller's
    // process group and would report "alive" forever. Treat as dead so a bad
    // spawn (pid 0) can't wedge callers into an infinite liveness wait.
    if pid == 0 {
        return false;
    }
    // kill with signal 0 checks if process exists without actually sending a signal
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return true;
    }
    // If kill returns -1, check errno
    // EPERM means process exists but we don't have permission (still alive)
    // ESRCH means no such process
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    errno == libc::EPERM
}

#[cfg(windows)]
fn windows_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }

        let mut exit_code: u32 = 0;
        let result = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);

        result != 0 && exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(windows)]
pub fn is_process_alive(pid: u32) -> bool {
    // pid 0 is never a real spawned child. In WSL mode `kill -0 0` targets the
    // process group and always succeeds, which would report a failed spawn
    // (pid 0) as "alive" forever and wedge the tailer until its startup timeout.
    if pid == 0 {
        return false;
    }
    // When WSL is enabled, PIDs are WSL-internal — check via wsl.exe
    let wsl = super::wsl::get_wsl_config();
    if wsl.enabled {
        return silent_command("wsl.exe")
            .args(["-d", &wsl.distro, "--", "kill", "-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }

    windows_process_alive(pid)
}

/// Kill a single process
/// - Unix: Uses SIGKILL
/// - Windows: Uses TerminateProcess
#[cfg(unix)]
pub fn kill_process(pid: u32) -> Result<(), String> {
    let result = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Failed to kill process {}: {}",
            pid,
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(windows)]
pub fn kill_process(pid: u32) -> Result<(), String> {
    // When WSL is enabled, PIDs are WSL-internal — kill via wsl.exe
    let wsl = super::wsl::get_wsl_config();
    if wsl.enabled {
        let output = silent_command("wsl.exe")
            .args(["-d", &wsl.distro, "--", "kill", "-9", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to run wsl kill: {e}"))?;
        return if output.status.success() {
            Ok(())
        } else {
            Err(format!("WSL kill failed for PID {pid}"))
        };
    }

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(format!(
                "Failed to open process {}: {}",
                pid,
                std::io::Error::last_os_error()
            ));
        }

        let result = TerminateProcess(handle, 1);
        CloseHandle(handle);

        if result != 0 {
            Ok(())
        } else {
            Err(format!(
                "Failed to terminate process {}: {}",
                pid,
                std::io::Error::last_os_error()
            ))
        }
    }
}

/// Collect every process that has `root` as an ancestor via PPID walk.
///
/// Process-group kill alone is not enough for terminal shells: foreground jobs
/// usually run in a *different* process group (job control), and tools like
/// bun/node often reparent workers. Closing a Jean terminal must still reap
/// those descendants or they keep holding ports (issue #635).
#[cfg(unix)]
fn collect_descendant_pids(root: u32) -> Vec<u32> {
    let output = match silent_command("ps").args(["-eo", "pid=,ppid="]).output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pid_s), Some(ppid_s)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid_s.parse::<u32>(), ppid_s.parse::<u32>()) else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
    }

    let mut stack = vec![root];
    let mut descendants = Vec::new();
    let mut visited = std::collections::HashSet::new();
    visited.insert(root);
    while let Some(current) = stack.pop() {
        let Some(kids) = children.get(&current) else {
            continue;
        };
        for &kid in kids {
            if visited.insert(kid) {
                descendants.push(kid);
                stack.push(kid);
            }
        }
    }
    descendants
}

/// Kill a process and all its children (process tree)
/// - Unix: process-group SIGKILL plus PPID-walk of descendants (job-control
///   children often live in a different process group than the shell)
/// - Windows: Uses taskkill /T for tree kill
#[cfg(unix)]
pub fn kill_process_tree(pid: u32) -> Result<(), String> {
    // Snapshot the PPID tree *before* any kills. Once the shell dies, job
    // control children reparent to init and become unreachable from `pid`.
    let descendants = collect_descendant_pids(pid);

    // 1) Kill the process group (shell is usually session/group leader).
    let _ = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };

    // 2) Kill descendants that live in other process groups (foreground jobs,
    // package-manager workers). These are not covered by the group signal.
    for child_pid in descendants {
        let _ = unsafe { libc::kill(child_pid as i32, libc::SIGKILL) };
    }

    // 3) Always target the root itself as a final fallback. ESRCH means it is
    // already gone (group kill succeeded) — that is success, not failure.
    match kill_process(pid) {
        Ok(()) => Ok(()),
        Err(_) if !is_process_alive(pid) => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
pub fn kill_process_tree(pid: u32) -> Result<(), String> {
    // When WSL is enabled, PIDs are WSL-internal — kill process group via wsl.exe
    let wsl = super::wsl::get_wsl_config();
    if wsl.enabled {
        // Negative PID kills the process group inside WSL
        let neg_pid = format!("-{pid}");
        let output = silent_command("wsl.exe")
            .args(["-d", &wsl.distro, "--", "kill", "-9", &neg_pid])
            .output()
            .map_err(|e| format!("Failed to run wsl kill: {e}"))?;
        return if output.status.success() {
            Ok(())
        } else {
            // Fallback to killing just the process
            kill_process(pid)
        };
    }

    // Use taskkill with /T flag for tree kill
    let output = silent_command("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| format!("Failed to run taskkill: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("taskkill failed: {}", stderr))
    }
}

/// Write binary data to a file path, handling Windows file-locking.
///
/// On Windows, if the target file is in use by another process (e.g., background version
/// checks), `File::create` fails with OS error 32. This function works around it by:
/// 1. Writing to a `.tmp` file in the same directory
/// 2. Renaming the existing file to `.old` (Windows allows renaming locked files)
/// 3. Renaming the `.tmp` file to the target path
/// 4. Best-effort cleanup of the `.old` file
///
/// On macOS, overwriting a running binary in-place (same inode) causes the kernel's code-signing
/// enforcement to taint the inode, resulting in SIGKILL for all subsequent executions from that
/// path. To avoid this, we always write to a temp file and atomically rename it into place,
/// which allocates a new inode while the old one stays alive for any running process.
pub fn write_binary_file(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    let temp_path = path.with_extension("tmp");

    // Write new binary to temp file (always a new inode)
    std::fs::write(&temp_path, content).map_err(|e| format!("Failed to write temp file: {e}"))?;

    #[cfg(windows)]
    {
        let old_path = path.with_extension("old");

        // Move existing file out of the way (Windows allows renaming locked files)
        if path.exists() {
            let _ = std::fs::remove_file(&old_path);
            if let Err(e) = std::fs::rename(path, &old_path) {
                let _ = std::fs::remove_file(&temp_path);
                return Err(format!("Failed to replace existing file: {e}"));
            }
        }

        // Move temp file into place
        if let Err(e) = std::fs::rename(&temp_path, path) {
            let _ = std::fs::rename(&old_path, path);
            return Err(format!("Failed to install new file: {e}"));
        }

        // Best-effort cleanup
        let _ = std::fs::remove_file(&old_path);
        Ok(())
    }

    #[cfg(not(windows))]
    {
        // Atomic rename: replaces the directory entry so `path` points to the new inode.
        // The old inode (if any running process has it mapped) stays alive until that process exits.
        if let Err(e) = std::fs::rename(&temp_path, path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!("Failed to install new file: {e}"));
        }
        Ok(())
    }
}

/// Send SIGTERM to gracefully terminate a process (Unix only)
/// On Windows, this falls back to TerminateProcess
#[cfg(unix)]
pub fn terminate_process(pid: u32) -> Result<(), String> {
    let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Failed to terminate process {}: {}",
            pid,
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(windows)]
pub fn terminate_process(pid: u32) -> Result<(), String> {
    // When WSL is enabled, send SIGTERM via wsl.exe
    let wsl = super::wsl::get_wsl_config();
    if wsl.enabled {
        let output = silent_command("wsl.exe")
            .args(["-d", &wsl.distro, "--", "kill", "-15", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to run wsl kill: {e}"))?;
        return if output.status.success() {
            Ok(())
        } else {
            Err(format!("WSL terminate failed for PID {pid}"))
        };
    }
    // Windows doesn't have SIGTERM, use TerminateProcess
    kill_process(pid)
}

#[cfg(all(test, unix))]
mod process_tree_tests {
    use super::{collect_descendant_pids, kill_process_tree};
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn collect_descendant_pids_finds_nested_children() {
        // shell -c 'sleep 60 & sleep 60 & wait' creates children under a shell.
        let mut child = Command::new("sh")
            .args(["-c", "sleep 60 & sleep 60 & wait"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn shell with sleep children");
        let root = child.id();
        // Give the shell a moment to spawn its sleeps.
        thread::sleep(Duration::from_millis(200));

        let descendants = collect_descendant_pids(root);
        // Kill before asserting so we never leak sleep processes on failure.
        let _ = kill_process_tree(root);
        let _ = child.kill();
        let _ = child.wait();

        assert!(
            !descendants.is_empty(),
            "expected nested sleep children under shell pid {root}, got {descendants:?}"
        );
    }

    #[test]
    fn kill_process_tree_reaps_job_control_children() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 120 & sleep 120 & wait"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn shell");
        let root = child.id();
        thread::sleep(Duration::from_millis(200));
        let descendants = collect_descendant_pids(root);
        assert!(!descendants.is_empty(), "precondition: children exist");

        kill_process_tree(root).expect("kill tree");
        let _ = child.wait();
        thread::sleep(Duration::from_millis(100));

        // None of the previously-seen descendants should still be alive.
        for pid in descendants {
            let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
            assert!(
                !alive,
                "descendant pid {pid} should be dead after tree kill"
            );
        }
    }
}

#[cfg(test)]
mod windows_console_flash_audit {
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Canonical home for silent `cmd /c start` URL launching (issue #588).
    const ALLOWED_CMD_START_PATH_SUFFIX: &str = "platform/process.rs";

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("jean-core should live under the repo root")
            .to_path_buf()
    }

    fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rust_files(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    /// Build needles at runtime so this audit module cannot match its own source.
    fn cmd_start_needle() -> String {
        // ["/c", "start"] without writing that exact contiguous form in this file.
        format!("\"/{}\", \"{}\"", "c", "start")
    }

    fn command_new_cmd_patterns() -> Vec<String> {
        let cmd = format!("\"{}\"", "cmd");
        let cmd_exe = format!("\"{}\"", "cmd.exe");
        vec![
            format!("Command::new({cmd})"),
            format!("Command::new({cmd_exe})"),
            format!("std::process::Command::new({cmd})"),
            format!("std::process::Command::new({cmd_exe})"),
        ]
    }

    fn line_number(source: &str, byte_offset: usize) -> usize {
        source[..byte_offset]
            .bytes()
            .filter(|&b| b == b'\n')
            .count()
            + 1
    }

    /// Normalize path separators so Windows `\` matches Unix-style suffixes.
    fn path_key(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    /// Drop this audit module (and its constructed needles) from scans of process.rs.
    fn production_source(path: &Path, source: &str) -> String {
        if !path_key(path).ends_with(ALLOWED_CMD_START_PATH_SUFFIX) {
            return source.to_string();
        }
        // Keep production helpers; strip only the #[cfg(test)] audit module.
        if let Some(idx) = source.find("mod windows_console_flash_audit") {
            // Include the preceding #[cfg(test)] attribute if present.
            let cut = source[..idx].rfind("#[cfg(test)]").unwrap_or(idx);
            return source[..cut].to_string();
        }
        source.to_string()
    }

    /// True when a `Command::new("cmd")` occurrence is covered by CREATE_NO_WINDOW
    /// or `silent_command("cmd")` within a nearby window of source lines.
    fn cmd_launch_is_silenced(source: &str, match_byte_offset: usize) -> bool {
        let before = &source[..match_byte_offset];
        let after = &source[match_byte_offset..];

        // Prefer looking at the same statement chain and a few lines of context.
        let context_before = before
            .rsplit_once('\n')
            .map(|(head, _)| {
                let lines: Vec<&str> = head.lines().rev().take(12).collect();
                lines.into_iter().rev().collect::<Vec<_>>().join("\n")
            })
            .unwrap_or_default();
        let context_after: String = after.lines().take(12).collect::<Vec<_>>().join("\n");
        let window = format!("{context_before}\n{context_after}");

        let silent_cmd = format!("silent_command(\"{}\")", "cmd");
        let silent_cmd_exe = format!("silent_command(\"{}\")", "cmd.exe");

        window.contains("CREATE_NO_WINDOW")
            || window.contains(&silent_cmd)
            || window.contains(&silent_cmd_exe)
            || window.contains("open_url_in_browser")
    }

    #[test]
    fn cmd_start_url_launchers_must_use_silent_helper() {
        let root = repo_root();
        let mut files = Vec::new();
        collect_rust_files(&root.join("jean-core/src"), &mut files);
        collect_rust_files(&root.join("src-tauri/src"), &mut files);

        let needle = cmd_start_needle();
        let silent_cmd = format!("silent_command(\"{}\")", "cmd");
        let mut violations = Vec::new();

        for path in &files {
            let Ok(raw) = fs::read_to_string(path) else {
                continue;
            };
            let source = production_source(path, &raw);
            for (idx, _) in source.match_indices(&needle) {
                let rel = path.strip_prefix(&root).unwrap_or(path);
                let rel_str = path_key(rel);
                let line = line_number(&source, idx);
                if rel_str.ends_with(ALLOWED_CMD_START_PATH_SUFFIX)
                    && source[idx.saturating_sub(400)..idx].contains(&silent_cmd)
                {
                    continue;
                }
                violations.push(format!(
                    "{rel_str}:{line}: raw cmd/start URL launcher without silent_command — use open_url_in_browser()"
                ));
            }
        }

        assert!(
            violations.is_empty(),
            "Unsilenced Windows cmd/start launchers found (issue #588):\n{}",
            violations.join("\n")
        );
    }

    #[test]
    fn command_new_cmd_must_set_create_no_window() {
        let root = repo_root();
        let mut files = Vec::new();
        collect_rust_files(&root.join("jean-core/src"), &mut files);
        collect_rust_files(&root.join("src-tauri/src"), &mut files);

        let patterns = command_new_cmd_patterns();
        let mut violations = Vec::new();

        for path in &files {
            let Ok(raw) = fs::read_to_string(path) else {
                continue;
            };
            let source = production_source(path, &raw);
            let rel = path.strip_prefix(&root).unwrap_or(path);
            let rel_str = rel.to_string_lossy();

            for pattern in &patterns {
                let mut search_from = 0;
                while let Some(rel_idx) = source[search_from..].find(pattern.as_str()) {
                    let idx = search_from + rel_idx;
                    if !cmd_launch_is_silenced(&source, idx) {
                        let line = line_number(&source, idx);
                        violations.push(format!(
                            "{rel_str}:{line}: {pattern} without CREATE_NO_WINDOW/silent_command nearby"
                        ));
                    }
                    search_from = idx + pattern.len();
                }
            }
        }

        assert!(
            violations.is_empty(),
            "Windows cmd.exe launches missing CREATE_NO_WINDOW (issue #588):\n{}",
            violations.join("\n")
        );
    }
}
