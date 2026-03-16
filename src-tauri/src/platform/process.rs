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

/// Check if a process is still alive
/// - Unix: Uses kill(pid, 0) to check
/// - Windows: Uses OpenProcess + GetExitCodeProcess
#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
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
pub fn is_process_alive(pid: u32) -> bool {
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

/// Kill a process and all its children (process tree)
/// - Unix: Uses kill with negative PID to kill process group
/// - Windows: Uses taskkill /T for tree kill
#[cfg(unix)]
pub fn kill_process_tree(pid: u32) -> Result<(), String> {
    // Negative PID kills the entire process group
    let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        // If process group kill fails, try killing just the process
        kill_process(pid)
    }
}

#[cfg(windows)]
pub fn kill_process_tree(pid: u32) -> Result<(), String> {
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
/// On Unix, this simply writes directly (overwriting is safe even for running binaries).
pub fn write_binary_file(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    {
        let temp_path = path.with_extension("tmp");
        let old_path = path.with_extension("old");

        // Write new binary to temp file
        std::fs::write(&temp_path, content)
            .map_err(|e| format!("Failed to write temp file: {e}"))?;

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
        std::fs::write(path, content).map_err(|e| format!("Failed to write file: {e}"))
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
    // Windows doesn't have SIGTERM, use TerminateProcess
    kill_process(pid)
}
