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

/// Normalize PTY cols/rows before openpty/spawn.
///
/// - Degenerate sizes (< 2) become 80×24 (portable_pty asserts on 0).
/// - Command PTYs floor at 80×24 so interactive TUI CLIs get a usable viewport
///   even when the frontend fit ran during a dialog zoom-in (issue #624).
pub(crate) fn effective_pty_size(cols: u16, rows: u16, is_command: bool) -> (u16, u16) {
    let cols = if cols < 2 {
        80
    } else if is_command {
        cols.max(80)
    } else {
        cols
    };
    let rows = if rows < 2 {
        24
    } else if is_command {
        rows.max(24)
    } else {
        rows
    };
    (cols, rows)
}

fn is_windows_batch_file(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

#[cfg(unix)]
#[derive(Debug, PartialEq)]
struct ParentLocale {
    lang: Option<String>,
    lc_all: Option<String>,
    lc_ctype: Option<String>,
}

#[cfg(unix)]
fn default_utf8_locale() -> &'static str {
    if cfg!(target_os = "macos") {
        "en_US.UTF-8"
    } else {
        "C.UTF-8"
    }
}

#[cfg(unix)]
fn locale_value_is_utf8(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let normalized = value.to_ascii_lowercase();
    normalized.contains("utf-8") || normalized.contains("utf8")
}

#[cfg(unix)]
fn current_parent_locale() -> ParentLocale {
    ParentLocale {
        lang: std::env::var("LANG").ok().filter(|value| !value.is_empty()),
        lc_all: std::env::var("LC_ALL")
            .ok()
            .filter(|value| !value.is_empty()),
        lc_ctype: std::env::var("LC_CTYPE")
            .ok()
            .filter(|value| !value.is_empty()),
    }
}

#[cfg(unix)]
fn terminal_utf8_locale_overrides(parent: &ParentLocale) -> Vec<(&'static str, &'static str)> {
    if locale_value_is_utf8(parent.lc_all.as_deref())
        || locale_value_is_utf8(parent.lc_ctype.as_deref())
        || locale_value_is_utf8(parent.lang.as_deref())
    {
        return Vec::new();
    }

    if parent.lc_all.is_some() || parent.lc_ctype.is_some() {
        return Vec::new();
    }

    vec![("LC_CTYPE", default_utf8_locale())]
}

#[cfg(unix)]
fn apply_terminal_locale_env(cmd: &mut CommandBuilder) {
    for (key, value) in terminal_utf8_locale_overrides(&current_parent_locale()) {
        cmd.env(key, value);
    }
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
    session_id: Option<String>,
) -> Result<(), String> {
    log::info!(
        "spawn_terminal {terminal_id}: cols={cols}, rows={rows}, cwd={worktree_path}, command={:?}, args={:?}",
        command, command_args
    );

    let pty_system = native_pty_system();

    // Guard against degenerate dimensions that crash portable_pty.
    // Command PTYs (CLI login TUI apps) also floor at 80×24 — a tiny first
    // fit during dialog animation leaves tools like `opencode auth login`
    // stuck after "Add credential" (issue #624).
    let is_command = command.as_ref().is_some_and(|c| !c.is_empty());
    let (cols, rows) = effective_pty_size(cols, rows, is_command);
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
    #[cfg(unix)]
    apply_terminal_locale_env(&mut cmd);
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
        worktree_path: worktree_path.clone(),
        command: command.clone(),
        command_args: command_args.clone(),
        session_id,
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

/// Control bytes that should also deliver a POSIX signal to the foreground
/// process group. The PTY line discipline normally does this when `ISIG` is
/// set, but remote/WSL/ConPTY paths and raw-mode apps can leave workers
/// running while the shell redraws a prompt (issue #635).
const INTERRUPT_BYTES: &[u8] = &[0x03]; // Ctrl-C → SIGINT
const SUSPEND_BYTES: &[u8] = &[0x1a]; // Ctrl-Z → SIGTSTP

/// Best-effort: signal the PTY's foreground process group.
///
/// Used as a belt-and-suspenders complement to writing the control byte so
/// descendants that ignore cooked-mode delivery still get the signal.
#[cfg(unix)]
fn signal_foreground_process_group(session: &TerminalSession, signo: i32) {
    let Some(pgid) = session.master.process_group_leader() else {
        return;
    };
    if pgid <= 1 {
        return;
    }
    let result = unsafe { libc::kill(-pgid, signo) };
    if result != 0 {
        log::trace!(
            "signal_foreground_process_group pgid={pgid} signo={signo} failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(unix))]
fn signal_foreground_process_group(_session: &TerminalSession, _signo: i32) {}

/// Write data to a terminal
pub fn write_to_terminal(terminal_id: &str, data: &str) -> Result<(), String> {
    use std::io::Write;

    let bytes = data.as_bytes();
    let wants_interrupt = bytes.iter().any(|b| INTERRUPT_BYTES.contains(b));
    let wants_suspend = bytes.iter().any(|b| SUSPEND_BYTES.contains(b));

    super::registry::with_terminal(terminal_id, |session| {
        let mut writer = session
            .writer
            .lock()
            .map_err(|e| format!("Failed to lock writer: {e}"))?;
        writer
            .write_all(bytes)
            .map_err(|e| format!("Failed to write: {e}"))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush: {e}"))?;

        // Reinforce control signals after the byte is in the PTY. Order matters:
        // write first so cooked-mode apps still see the character; then signal
        // the FG group so workers that missed ISIG still get interrupted.
        #[cfg(unix)]
        {
            if wants_interrupt {
                signal_foreground_process_group(session, libc::SIGINT);
            }
            if wants_suspend {
                signal_foreground_process_group(session, libc::SIGTSTP);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = wants_interrupt;
            let _ = wants_suspend;
        }

        Ok(())
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

/// Tear down a terminal's shell *and* any descendants (foreground jobs,
/// package-manager workers, etc.). Killing only the shell leaves processes
/// holding ports and still writing into the PTY after the UI shows a new
/// prompt (issue #635).
fn teardown_terminal_process(session: &mut TerminalSession) {
    if let Some(pid) = session.child.process_id() {
        // Tree kill first while the shell PID is still known — on Windows
        // `taskkill /T` and on Unix the PPID walk both need a live root to
        // discover children. Terminating the shell alone first reparents
        // workers and makes them unreachable from this PID.
        if let Err(e) = crate::platform::kill_process_tree(pid) {
            log::trace!("Process tree kill of pid={pid} failed: {e}");
            // Fallback: single-process terminate if tree kill failed entirely.
            if let Err(e) = crate::platform::terminate_process(pid) {
                log::trace!("Graceful termination of pid={pid} failed: {e}");
            }
        }
    }
    let _ = session.child.kill();
}

/// Kill a terminal
pub fn kill_terminal(app: &AppHandle, terminal_id: &str) -> Result<bool, String> {
    if let Some(mut session) = unregister_terminal(terminal_id) {
        teardown_terminal_process(&mut session);

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
        teardown_terminal_process(&mut session);
        eprintln!("[TERMINAL CLEANUP] Killed terminal: {terminal_id}");
    }

    eprintln!("[TERMINAL CLEANUP] Cleanup complete, killed {count} terminal(s)");

    count
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::build_unix_shell_command;
    use super::{effective_pty_size, is_windows_batch_file};
    #[cfg(unix)]
    use super::{terminal_utf8_locale_overrides, ParentLocale};

    #[test]
    fn interrupt_and_suspend_bytes_are_recognized() {
        // Guard the constants used by write_to_terminal for issue #635 so a
        // future refactor cannot silently drop Ctrl-C / Ctrl-Z reinforcement.
        assert!(super::INTERRUPT_BYTES.contains(&0x03));
        assert!(super::SUSPEND_BYTES.contains(&0x1a));
        assert!(!super::INTERRUPT_BYTES.contains(&0x04)); // Ctrl-D is EOF, not signal
    }

    #[test]
    fn effective_pty_size_clamps_degenerate_and_command_floors() {
        assert_eq!(effective_pty_size(0, 0, false), (80, 24));
        assert_eq!(effective_pty_size(1, 1, false), (80, 24));
        assert_eq!(effective_pty_size(40, 10, false), (40, 10));
        // Command/login PTYs always get a TUI-usable floor (issue #624).
        assert_eq!(effective_pty_size(12, 5, true), (80, 24));
        assert_eq!(effective_pty_size(100, 40, true), (100, 40));
    }

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

    #[cfg(unix)]
    #[test]
    fn terminal_sets_utf8_ctype_when_parent_locale_is_not_utf8() {
        let overrides = terminal_utf8_locale_overrides(&ParentLocale {
            lang: Some("C".to_string()),
            lc_all: None,
            lc_ctype: None,
        });

        assert_eq!(overrides, vec![("LC_CTYPE", super::default_utf8_locale())]);
    }

    #[cfg(unix)]
    #[test]
    fn terminal_sets_utf8_ctype_when_parent_locale_is_unset() {
        let overrides = terminal_utf8_locale_overrides(&ParentLocale {
            lang: None,
            lc_all: None,
            lc_ctype: None,
        });

        assert_eq!(overrides, vec![("LC_CTYPE", super::default_utf8_locale())]);
    }

    #[cfg(unix)]
    #[test]
    fn terminal_sets_utf8_ctype_for_posix_lang() {
        let overrides = terminal_utf8_locale_overrides(&ParentLocale {
            lang: Some("POSIX".to_string()),
            lc_all: None,
            lc_ctype: None,
        });

        assert_eq!(overrides, vec![("LC_CTYPE", super::default_utf8_locale())]);
    }

    #[cfg(unix)]
    #[test]
    fn terminal_keeps_existing_utf8_locale() {
        let utf8_lang = terminal_utf8_locale_overrides(&ParentLocale {
            lang: Some("en_US.UTF-8".to_string()),
            lc_all: None,
            lc_ctype: None,
        });
        let utf8_lang_no_hyphen = terminal_utf8_locale_overrides(&ParentLocale {
            lang: Some("en_US.utf8".to_string()),
            lc_all: None,
            lc_ctype: None,
        });
        let utf8_lc_ctype = terminal_utf8_locale_overrides(&ParentLocale {
            lang: Some("C".to_string()),
            lc_all: None,
            lc_ctype: Some("C.UTF-8".to_string()),
        });

        assert!(utf8_lang.is_empty());
        assert!(utf8_lang_no_hyphen.is_empty());
        assert!(utf8_lc_ctype.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn terminal_does_not_override_explicit_ctype_or_lc_all() {
        let explicit_ctype = terminal_utf8_locale_overrides(&ParentLocale {
            lang: Some("C".to_string()),
            lc_all: None,
            lc_ctype: Some("C".to_string()),
        });
        let explicit_lc_all = terminal_utf8_locale_overrides(&ParentLocale {
            lang: Some("C".to_string()),
            lc_all: Some("C".to_string()),
            lc_ctype: None,
        });

        assert!(explicit_ctype.is_empty());
        assert!(explicit_lc_all.is_empty());
    }
}
