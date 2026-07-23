use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::Mutex;
use std::thread;
use tauri::AppHandle;

use crate::http_server::EmitExt;

use super::registry::{register_terminal, unregister_terminal};
use super::types::{
    TerminalOutputEvent, TerminalSession, TerminalStartedEvent, TerminalStoppedEvent,
};

/// Detect user's default shell (cross-platform)
fn get_user_shell() -> String {
    crate::platform::get_default_shell()
}

fn is_windows_batch_file(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

#[cfg(unix)]
fn build_unix_shell_command(
    shell: &str,
    command: &str,
    command_args: Option<&[String]>,
) -> CommandBuilder {
    let command = match command_args {
        Some(args) => std::iter::once(command)
            .chain(args.iter().map(String::as_str))
            .map(crate::platform::shell_escape)
            .collect::<Vec<_>>()
            .join(" "),
        None => command.to_string(),
    };

    let mut builder = CommandBuilder::new(shell);
    builder.args(["-l", "-i", "-c", &command]);
    builder
}

/// Spawn a terminal, optionally running a command
///
/// On Unix, commands run through the user's interactive login shell so they
/// receive the same PATH as a normal terminal. On Windows, structured command
/// arguments are invoked directly to avoid PowerShell rewriting quoted paths.
pub fn spawn_terminal(
    app: &AppHandle,
    terminal_id: String,
    worktree_path: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    command_args: Option<Vec<String>>,
) -> Result<(), String> {
    log::info!(
        "spawn_terminal {terminal_id}: cols={cols}, rows={rows}, cwd={worktree_path}, command={:?}, args={:?}",
        command, command_args
    );

    let pty_system = native_pty_system();

    // Guard against degenerate dimensions that crash portable_pty
    let cols = if cols == 0 { 80 } else { cols };
    let rows = if rows == 0 { 24 } else { rows };
    log::info!("spawn_terminal {terminal_id}: effective size={cols}x{rows}");

    // Create PTY pair
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // Get user's shell
    let shell = get_user_shell();
    log::trace!("Using shell: {shell}");

    // Resolve working directory: use requested path if it exists, else temp dir
    let cwd = if std::path::Path::new(&worktree_path).is_dir() {
        worktree_path.clone()
    } else {
        let fallback = std::env::temp_dir().to_string_lossy().to_string();
        log::warn!(
            "Worktree path '{}' does not exist, falling back to '{}'",
            worktree_path,
            fallback
        );
        fallback
    };

    // Check if we should route through WSL
    #[cfg(windows)]
    let wsl_config = crate::platform::get_wsl_config();
    #[cfg(not(windows))]
    let wsl_config = crate::platform::wsl::WslConfig::default();

    // Build command - either run a specific command or start interactive shell
    let mut cmd = if wsl_config.enabled {
        // WSL mode: route everything through wsl.exe
        let unix_cwd = crate::platform::win_to_wsl_path(&cwd);
        if let Some(ref run_command) = command {
            if run_command.is_empty() {
                return Err("Command is empty".to_string());
            }
            let mut c = CommandBuilder::new("wsl.exe");
            c.arg("-d");
            c.arg(&wsl_config.distro);
            c.arg("--cd");
            c.arg(&unix_cwd);
            c.arg("--");
            if let Some(ref args) = command_args {
                // Direct binary invocation inside WSL
                c.arg(run_command);
                for arg in args {
                    c.arg(arg);
                }
            } else {
                // Shell-wrapped command inside WSL
                c.arg("sh");
                c.arg("-c");
                c.arg(run_command);
            }
            c
        } else {
            // Interactive WSL shell
            let mut c = CommandBuilder::new("wsl.exe");
            c.arg("-d");
            c.arg(&wsl_config.distro);
            c.arg("--cd");
            c.arg(&unix_cwd);
            c
        }
    } else if let Some(ref run_command) = command {
        if run_command.is_empty() {
            return Err("Command is empty".to_string());
        }
        #[cfg(unix)]
        {
            // Match a normally opened terminal so version managers and user PATH
            // entries (for example ~/.bun/bin) are available to launched scripts.
            build_unix_shell_command(&shell, run_command, command_args.as_deref())
        }
        #[cfg(windows)]
        {
            if let Some(ref args) = command_args {
                // Validate absolute paths exist upfront for a clear error message.
                if run_command.starts_with('/') && !std::path::Path::new(run_command).exists() {
                    return Err(format!("Binary not found: {run_command}"));
                }

                // Extensionless npm shims (e.g. C:\Program Files\nodejs\codex) are
                // not valid Win32 images (os error 193). Prefer a sibling .cmd/.exe.
                let resolved = crate::platform::prefer_windows_executable_sibling(
                    std::path::PathBuf::from(run_command),
                );
                let resolved_command = resolved.to_string_lossy().to_string();
                if resolved_command != *run_command {
                    log::info!(
                        "Terminal {terminal_id}: resolved Windows CLI '{run_command}' -> '{resolved_command}'"
                    );
                }

                let mut c = if is_windows_batch_file(&resolved_command) {
                    let mut c = CommandBuilder::new("cmd.exe");
                    c.arg("/C");
                    c.arg(&resolved_command);
                    c
                } else {
                    // Direct binary invocation — CommandBuilder handles spaces in
                    // paths natively without PowerShell parsing the arguments.
                    CommandBuilder::new(&resolved_command)
                };
                for arg in args {
                    c.arg(arg);
                }
                c
            } else {
                let mut c = CommandBuilder::new(&shell);
                c.arg("-Command");
                c.arg(run_command);
                c
            }
        }
    } else {
        CommandBuilder::new(&shell)
    };

    log::debug!(
        "Terminal {terminal_id}: cwd={cwd}, command={:?}, args={:?}, wsl={}",
        command,
        command_args,
        wsl_config.enabled
    );
    // WSL mode handles cwd via --cd flag; native mode uses cwd() on the command
    if !wsl_config.enabled {
        cmd.cwd(&cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("JEAN_WORKTREE_PATH", &worktree_path);

    // Spawn the shell
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        log::error!(
            "Failed to spawn terminal {terminal_id}: {e} (cwd={cwd}, command={:?}, args={:?})",
            command,
            command_args
        );
        format!("Failed to spawn shell: {e}")
    })?;

    log::trace!("Spawned terminal process");

    // Get reader from master
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {e}"))?;

    // Get writer from master (must be taken once and stored)
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {e}"))?;

    // Register the session
    let session = TerminalSession {
        terminal_id: terminal_id.clone(),
        master: pair.master,
        writer: Mutex::new(writer),
        child,
        cols,
        rows,
    };
    register_terminal(session);

    // Emit started event
    let started_event = TerminalStartedEvent {
        terminal_id: terminal_id.clone(),
        cols,
        rows,
    };
    if let Err(e) = app.emit_all("terminal:started", &started_event) {
        log::error!("Failed to emit terminal:started event: {e}");
    }

    // Spawn reader thread.
    //
    // Streaming UTF-8 decode: a `read()` can split a multi-byte codepoint at
    // the buffer boundary. `from_utf8_lossy` would emit `U+FFFD` for the split
    // bytes — corrupting valid output. Instead we carry up to 3 trailing bytes
    // of an incomplete codepoint into the next read. Genuine invalid sequences
    // still produce one `U+FFFD` per bad sequence, matching `from_utf8_lossy`.
    let app_clone = app.clone();
    let terminal_id_clone = terminal_id.clone();
    thread::spawn(move || {
        const BUF_SIZE: usize = 4096;
        let mut buf = [0u8; BUF_SIZE];
        // Bytes carried from previous read (incomplete UTF-8 prefix). Max 3.
        let mut carry: [u8; 3] = [0; 3];
        let mut carry_len: usize = 0;
        loop {
            // Stage carry at start of buf; read after it. Zero-alloc combine.
            buf[..carry_len].copy_from_slice(&carry[..carry_len]);
            let read_n = match reader.read(&mut buf[carry_len..]) {
                Ok(0) => {
                    log::trace!("Terminal EOF for: {terminal_id_clone}");
                    if carry_len > 0 {
                        // Drain remaining carry as replacement chars (one per
                        // dangling byte — matches `from_utf8_lossy` end-of-stream).
                        let mut s = String::with_capacity(carry_len * 3);
                        for _ in 0..carry_len {
                            s.push('\u{FFFD}');
                        }
                        let event = TerminalOutputEvent {
                            terminal_id: terminal_id_clone.clone(),
                            data: s,
                        };
                        let _ = app_clone.emit_all_owned("terminal:output", event);
                    }
                    break;
                }
                Ok(n) => n,
                Err(e) => {
                    log::error!("Error reading from terminal: {e}");
                    break;
                }
            };
            let total = carry_len + read_n;
            carry_len = 0;

            // Decode in place. Fast path: whole buf valid UTF-8 → zero-alloc
            // (we hand the underlying bytes straight to a new String via
            // copy_from_slice into a Vec sized exactly to total).
            let bytes = &buf[..total];
            match std::str::from_utf8(bytes) {
                Ok(_) => {
                    // SAFETY: validated above.
                    let data = unsafe { String::from_utf8_unchecked(bytes.to_vec()) };
                    let event = TerminalOutputEvent {
                        terminal_id: terminal_id_clone.clone(),
                        data,
                    };
                    if let Err(e) = app_clone.emit_all_owned("terminal:output", event) {
                        log::error!("Failed to emit terminal:output event: {e}");
                    }
                }
                Err(first_err) => {
                    // Slow path: contains invalid bytes or incomplete tail.
                    // Build output with one allocation sized to input.
                    let mut out = String::with_capacity(total);
                    let mut cursor = 0usize;
                    let mut err = first_err;
                    loop {
                        let valid_up_to = err.valid_up_to();
                        // SAFETY: from_utf8 verified [cursor..cursor+valid_up_to].
                        out.push_str(unsafe {
                            std::str::from_utf8_unchecked(&bytes[cursor..cursor + valid_up_to])
                        });
                        match err.error_len() {
                            None => {
                                // Incomplete tail — stash for next read.
                                let tail_start = cursor + valid_up_to;
                                let tail_len = total - tail_start;
                                debug_assert!(tail_len <= 3);
                                carry[..tail_len].copy_from_slice(&bytes[tail_start..total]);
                                carry_len = tail_len;
                                break;
                            }
                            Some(bad_len) => {
                                out.push('\u{FFFD}');
                                cursor += valid_up_to + bad_len;
                                if cursor >= total {
                                    break;
                                }
                                match std::str::from_utf8(&bytes[cursor..]) {
                                    Ok(s) => {
                                        out.push_str(s);
                                        break;
                                    }
                                    Err(e) => err = e,
                                }
                            }
                        }
                    }
                    if !out.is_empty() {
                        let event = TerminalOutputEvent {
                            terminal_id: terminal_id_clone.clone(),
                            data: out,
                        };
                        if let Err(e) = app_clone.emit_all_owned("terminal:output", event) {
                            log::error!("Failed to emit terminal:output event: {e}");
                        }
                    }
                }
            }
        }

        // Terminal has exited, get exit code and cleanup
        if let Some(mut session) = unregister_terminal(&terminal_id_clone) {
            let (exit_code, signal) = session
                .child
                .wait()
                .map(|s| {
                    if s.success() {
                        (Some(0), None)
                    } else {
                        // Display format: "Terminated by {signal}" or "Exited with code {code}"
                        let display = format!("{s}");
                        let signal = display
                            .strip_prefix("Terminated by ")
                            .map(|sig| sig.to_string());
                        (Some(s.exit_code() as i32), signal)
                    }
                })
                .unwrap_or((None, None));

            let stopped_event = TerminalStoppedEvent {
                terminal_id: terminal_id_clone,
                exit_code,
                signal,
            };
            if let Err(e) = app_clone.emit_all("terminal:stopped", &stopped_event) {
                log::error!("Failed to emit terminal:stopped event: {e}");
            }
        }
    });

    Ok(())
}

/// Write data to a terminal
pub fn write_to_terminal(terminal_id: &str, data: &str) -> Result<(), String> {
    use std::io::Write;

    super::registry::with_terminal(terminal_id, |session| {
        let mut writer = session
            .writer
            .lock()
            .map_err(|e| format!("Failed to lock writer: {e}"))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write: {e}"))?;
        writer.flush().map_err(|e| format!("Failed to flush: {e}"))
    })
    .ok_or_else(|| "Terminal not found".to_string())?
}

/// Resize a terminal
pub fn resize_terminal(terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    super::registry::with_terminal(terminal_id, |session| {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize: {e}"))?;
        session.cols = cols;
        session.rows = rows;
        Ok(())
    })
    .ok_or_else(|| "Terminal not found".to_string())?
}

/// Kill a terminal
pub fn kill_terminal(app: &AppHandle, terminal_id: &str) -> Result<bool, String> {
    if let Some(mut session) = unregister_terminal(terminal_id) {
        // Kill the child process - try graceful termination first
        if let Some(pid) = session.child.process_id() {
            if let Err(e) = crate::platform::terminate_process(pid) {
                log::trace!("Graceful termination of pid={pid} failed: {e}");
            }
        }

        // Wait for the process to exit
        let _ = session.child.kill();

        // Emit stopped event
        let stopped_event = TerminalStoppedEvent {
            terminal_id: terminal_id.to_string(),
            exit_code: None,
            signal: None,
        };
        if let Err(e) = app.emit_all("terminal:stopped", &stopped_event) {
            log::error!("Failed to emit terminal:stopped event: {e}");
        }

        Ok(true)
    } else {
        Ok(false)
    }
}

/// Kill all active terminals (used during app shutdown)
pub fn kill_all_terminals() -> usize {
    use super::registry::TERMINAL_SESSIONS;

    eprintln!("[TERMINAL CLEANUP] kill_all_terminals called");

    let mut sessions = TERMINAL_SESSIONS.lock().unwrap();
    let count = sessions.len();

    eprintln!("[TERMINAL CLEANUP] Found {count} active terminal(s)");

    for (terminal_id, mut session) in sessions.drain() {
        eprintln!("[TERMINAL CLEANUP] Killing terminal: {terminal_id}");

        if let Some(pid) = session.child.process_id() {
            eprintln!("[TERMINAL CLEANUP] Sending terminate signal to PID {pid}");
            if let Err(e) = crate::platform::terminate_process(pid) {
                eprintln!("[TERMINAL CLEANUP] Graceful termination failed: {e}");
            }
        }

        let _ = session.child.kill();
        eprintln!("[TERMINAL CLEANUP] Killed terminal: {terminal_id}");
    }

    eprintln!("[TERMINAL CLEANUP] Cleanup complete, killed {count} terminal(s)");

    count
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::build_unix_shell_command;
    use super::is_windows_batch_file;

    #[cfg(unix)]
    #[test]
    fn command_with_args_runs_through_interactive_login_shell() {
        let command = build_unix_shell_command(
            "/bin/bash",
            "bun",
            Some(&[
                "run".to_string(),
                "dev server".to_string(),
                "it's-safe".to_string(),
            ]),
        );

        let argv = command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(argv[0..4], ["/bin/bash", "-l", "-i", "-c"]);
        assert_eq!(argv[4], "'bun' 'run' 'dev server' 'it'\\''s-safe'");
    }

    #[test]
    fn detects_windows_batch_shims_case_insensitively() {
        assert!(is_windows_batch_file(
            r"C:\Users\u\AppData\Roaming\npm\opencode.CMD"
        ));
        assert!(is_windows_batch_file(r"C:\tools\run.bat"));
        assert!(!is_windows_batch_file(r"C:\tools\opencode.exe"));
        assert!(!is_windows_batch_file(r"C:\tools\opencode"));
    }
}
