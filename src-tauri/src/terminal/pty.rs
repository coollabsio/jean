use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter};

use super::registry::{register_terminal, unregister_terminal};
use super::types::{
    TerminalOutputEvent, TerminalSession, TerminalStartedEvent, TerminalStoppedEvent,
};

/// Detect user's default shell (cross-platform)
fn get_user_shell() -> String {
    crate::platform::get_default_shell()
}

/// Spawn a terminal, optionally running a command
///
/// When `command_args` is provided alongside `command`, the binary at `command`
/// is invoked directly with the given args (no shell wrapper). This avoids
/// argument-parsing issues on Windows where PowerShell mangles quoted paths.
pub fn spawn_terminal(
    app: &AppHandle,
    terminal_id: String,
    worktree_path: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    command_args: Option<Vec<String>>,
) -> Result<(), String> {
    log::trace!("Spawning terminal {terminal_id} at {worktree_path}");
    if let Some(ref cmd) = command {
        log::trace!("Running command: {cmd}");
    }
    if let Some(ref args) = command_args {
        log::trace!("Command args: {args:?}");
    }

    let pty_system = native_pty_system();

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

    // Build command - either run a specific command or start interactive shell
    let mut cmd = if let Some(ref run_command) = command {
        if let Some(ref args) = command_args {
            // Direct binary invocation — bypass shell to avoid argument mangling.
            // Validate absolute paths exist upfront for a clear error message.
            if run_command.starts_with('/') && !std::path::Path::new(run_command).exists() {
                return Err(format!("Binary not found: {run_command}"));
            }
            let mut c = CommandBuilder::new(run_command);
            for arg in args {
                c.arg(arg);
            }
            c
        } else {
            // Run the command wrapped in a shell
            let mut c = CommandBuilder::new(&shell);
            #[cfg(windows)]
            {
                c.arg("-Command");
                c.arg(run_command.to_string());
            }
            #[cfg(not(windows))]
            {
                c.arg("-c");
                c.arg(run_command);
            }
            c
        }
    } else {
        CommandBuilder::new(&shell)
    };
    // Use the requested working directory if it exists, otherwise fall back to
    // the system temp directory. This is critical on Windows where `/tmp` doesn't
    // exist — CLI login terminals pass `/tmp` as a placeholder path.
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
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("JEAN_WORKTREE_PATH", &worktree_path);

    // Spawn the shell
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

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
    if let Err(e) = app.emit("terminal:started", &started_event) {
        log::error!("Failed to emit terminal:started event: {e}");
    }

    // Spawn reader thread
    let app_clone = app.clone();
    let terminal_id_clone = terminal_id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF - terminal closed
                    log::trace!("Terminal EOF for: {terminal_id_clone}");
                    break;
                }
                Ok(n) => {
                    // Convert bytes to string (lossy conversion for non-UTF8)
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let event = TerminalOutputEvent {
                        terminal_id: terminal_id_clone.clone(),
                        data,
                    };
                    if let Err(e) = app_clone.emit("terminal:output", &event) {
                        log::error!("Failed to emit terminal:output event: {e}");
                    }
                }
                Err(e) => {
                    log::error!("Error reading from terminal: {e}");
                    break;
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
            if let Err(e) = app_clone.emit("terminal:stopped", &stopped_event) {
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
        if let Err(e) = app.emit("terminal:stopped", &stopped_event) {
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
