//! Native-terminal Claude Code "needs attention" detection.
//!
//! Jean Chat runs Claude headless and parses its JSONL stream, so it knows when
//! a turn finishes or the agent needs the user, and surfaces that through the
//! unread bell / "Waiting" indicator. A native-terminal Claude session is just
//! a raw PTY, so Jean is otherwise blind to that lifecycle.
//!
//! To restore those signals we inject Claude Code hooks (`Stop`,
//! `Notification`, `UserPromptSubmit`) via the CLI `--settings` flag. Each hook
//! appends its event name to a per-session signal file; a tailer thread bound
//! to the PTY lifetime maps those events onto the session's `waiting_for_input`
//! state and invalidates the sessions cache so the UI updates.
//!
//! Scope: Claude Code, Unix/macOS only (mirrors the detached-process module).

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::chat::storage::with_existing_metadata_mut;
use crate::chat::tail::NdjsonTailer;
use crate::http_server::EmitExt;

/// Directory under app-data holding per-session terminal signal files.
fn signal_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("terminal-hooks");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create terminal-hooks dir: {e}"))?;
    Ok(dir)
}

/// Absolute path to a session's terminal signal file.
fn signal_file(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    // session_id is a server-generated UUID, safe as a file name.
    Ok(signal_dir(app)?.join(format!("{session_id}.log")))
}

/// Absolute path to a session's captured-prompt file (latest UserPromptSubmit
/// stdin JSON), used to auto-name the session from the first prompt.
fn prompt_file(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    Ok(signal_dir(app)?.join(format!("{session_id}.prompt")))
}

/// True when the terminal command is the Claude Code CLI (bare name or path).
pub fn is_claude_command(command: &str) -> bool {
    Path::new(command)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "claude" || n == "claude.exe")
        .unwrap_or(false)
}

/// POSIX single-quote-escape a string for safe embedding inside a `'...'` shell
/// literal: every `'` becomes `'\''`. Guards against app-data paths that contain
/// an apostrophe (e.g. a home dir like `/home/o'brien`), which would otherwise
/// break the hook command or open a shell-injection surface.
fn sh_single_quote_escape(s: &str) -> String {
    s.replace('\'', "'\\''")
}

/// Build the `--settings` JSON wiring Claude Code hooks. `Stop`/`Notification`
/// append their event name to `signal_path` (hooks run through the shell, so
/// `echo <Event> >>` writes one newline-terminated line per event). The
/// `UserPromptSubmit` hook also captures its stdin JSON to `prompt_path` so the
/// first prompt can drive iso session/branch auto-naming; it writes the prompt
/// file BEFORE the marker so the tailer always sees a complete payload.
fn hook_settings_json(signal_path: &Path, prompt_path: &Path) -> String {
    // Paths are wrapped in single quotes (so spaces like macOS "Application
    // Support" are safe) and any embedded `'` is POSIX-escaped first.
    let signal = sh_single_quote_escape(&signal_path.to_string_lossy());
    let prompt = sh_single_quote_escape(&prompt_path.to_string_lossy());
    let echo = |event: &str| {
        serde_json::json!({
            "hooks": [ {
                "type": "command",
                "command": format!("echo {event} >> '{signal}'"),
            } ]
        })
    };
    let user_prompt = serde_json::json!({
        "hooks": [ {
            "type": "command",
            "command": format!("cat > '{prompt}'; echo UserPromptSubmit >> '{signal}'"),
        } ]
    });
    serde_json::json!({
        "hooks": {
            "Stop": [ echo("Stop") ],
            "Notification": [ echo("Notification") ],
            "UserPromptSubmit": [ user_prompt ],
        }
    })
    .to_string()
}

/// For a Claude terminal session, reset the signal file and append
/// `--settings <hooks-json>` to the args. Returns the (possibly augmented) args
/// and the signal-file path when hooks were injected. Unix/macOS only.
pub fn inject_claude_hooks(
    app: &AppHandle,
    session_id: &str,
    command: &str,
    mut args: Vec<String>,
) -> (Vec<String>, Option<PathBuf>) {
    if !cfg!(unix) || !is_claude_command(command) {
        return (args, None);
    }
    let signal_path = match signal_file(app, session_id) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("terminal hooks: cannot resolve signal file: {e}");
            return (args, None);
        }
    };
    // Truncate any stale lines from a previous run of this same session.
    if let Err(e) = std::fs::write(&signal_path, b"") {
        log::warn!("terminal hooks: cannot reset signal file: {e}");
        return (args, None);
    }
    let prompt_path = match prompt_file(app, session_id) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("terminal hooks: cannot resolve prompt file: {e}");
            return (args, None);
        }
    };
    // Drop any stale captured prompt from a previous run of this session.
    let _ = std::fs::remove_file(&prompt_path);
    args.push("--settings".to_string());
    args.push(hook_settings_json(&signal_path, &prompt_path));
    log::debug!("terminal hooks: injected for session {session_id}");
    (args, Some(signal_path))
}

/// Tail `signal_path` until the PTY is gone, mapping Claude Code hook events
/// onto the session's waiting state. Runs on a dedicated thread.
pub fn spawn_signal_tailer(
    app: AppHandle,
    session_id: String,
    terminal_id: String,
    signal_path: PathBuf,
) {
    std::thread::spawn(move || {
        // The file was just truncated/created by inject_claude_hooks.
        let mut tailer = match NdjsonTailer::new_from_start(&signal_path) {
            Ok(t) => t,
            Err(e) => {
                log::warn!(
                    "terminal hooks: cannot tail {}: {e}",
                    signal_path.display()
                );
                return;
            }
        };
        // Auto-naming is attempted once per tailer; the backend also guards via
        // session_naming_completed so a restarted tailer never re-names.
        let mut naming_attempted = false;
        let mut handle = |app: &AppHandle, line: &str| {
            apply_terminal_signal(app, &session_id, line);
            if line == "UserPromptSubmit" && !naming_attempted {
                naming_attempted = true;
                maybe_trigger_naming(app, &session_id);
            }
        };
        loop {
            match tailer.poll() {
                Ok(lines) => {
                    for line in lines {
                        handle(&app, line.trim());
                    }
                }
                Err(e) => {
                    log::debug!("terminal hooks: tail error: {e}");
                    break;
                }
            }
            if !super::registry::has_terminal(&terminal_id) {
                // Final drain to catch a line written just before the PTY died.
                if let Ok(lines) = tailer.poll() {
                    for line in lines {
                        handle(&app, line.trim());
                    }
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let _ = std::fs::remove_file(&signal_path);
        if let Ok(p) = prompt_file(&app, &session_id) {
            let _ = std::fs::remove_file(p);
        }
        log::debug!("terminal hooks: tailer stopped for session {session_id}");
    });
}

/// Read the captured first prompt and kick off iso session/branch auto-naming.
/// Best-effort: silently no-ops if the prompt file is missing/unparseable.
fn maybe_trigger_naming(app: &AppHandle, session_id: &str) {
    let Ok(prompt_path) = prompt_file(app, session_id) else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&prompt_path) else {
        return;
    };
    // UserPromptSubmit stdin JSON: { ..., "prompt": "<text>" }.
    let prompt = serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .and_then(|v| {
            v.get("prompt")
                .and_then(|p| p.as_str())
                .map(|s| s.to_string())
        });
    let Some(prompt) = prompt else {
        return;
    };
    if prompt.trim().is_empty() {
        return;
    }
    let app = app.clone();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        crate::chat::trigger_terminal_session_naming(app, session_id, prompt).await;
    });
}

/// Map one hook event onto the session's waiting state and notify clients.
fn apply_terminal_signal(app: &AppHandle, session_id: &str, event: &str) {
    // Claude finished a turn or is asking for the user → it's their turn now.
    let is_wait = matches!(event, "Stop" | "Notification");
    // User submitted a prompt → Claude is working again.
    let is_clear = event == "UserPromptSubmit";
    if !is_wait && !is_clear {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mutated = with_existing_metadata_mut(app, session_id, |m| {
        if is_wait {
            m.waiting_for_input = true;
            m.waiting_for_input_type = Some("question".to_string());
            // Bump only when entering the waiting state so the session rises in
            // the unread bell; clearing must NOT bump (else typing re-marks it).
            m.terminal_activity_at = Some(now);
        } else {
            m.waiting_for_input = false;
            m.waiting_for_input_type = None;
        }
    });
    match mutated {
        Ok(()) => {
            crate::chat::emit_sessions_cache_invalidation(app);
            if is_wait {
                // Let the UI clear it immediately if the user is actively viewing
                // this session (so the active session never shows as waiting).
                if let Err(e) = app.emit_all(
                    "terminal:attention",
                    &serde_json::json!({ "sessionId": session_id }),
                ) {
                    log::debug!("terminal hooks: terminal:attention emit failed: {e}");
                }
            }
        }
        Err(e) => {
            log::debug!("terminal hooks: cannot apply '{event}' to {session_id}: {e}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_claude_command_by_name_and_path() {
        assert!(is_claude_command("claude"));
        assert!(is_claude_command("/home/u/.local/share/com.jean.desktop/claude-cli/claude"));
        assert!(is_claude_command("claude.exe"));
        assert!(!is_claude_command("codex"));
        assert!(!is_claude_command("/usr/bin/bash"));
        assert!(!is_claude_command(""));
    }

    #[test]
    fn settings_json_wires_all_three_hooks_to_signal_file() {
        let json = hook_settings_json(Path::new("/tmp/sess-1.log"), Path::new("/tmp/sess-1.prompt"));
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let hooks = &value["hooks"];
        for event in ["Stop", "Notification", "UserPromptSubmit"] {
            let command = hooks[event][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(command.contains(&format!("echo {event}")));
            assert!(command.contains("'/tmp/sess-1.log'"));
        }
        // UserPromptSubmit additionally captures stdin (the prompt JSON) to the
        // prompt file so the first prompt can drive auto-naming.
        let user_prompt_cmd = hooks["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(user_prompt_cmd.contains("cat > '/tmp/sess-1.prompt'"));
    }

    #[test]
    fn settings_json_posix_escapes_apostrophes_in_paths() {
        let json = hook_settings_json(
            Path::new("/home/o'brien/sess.log"),
            Path::new("/home/o'brien/sess.prompt"),
        );
        // Still valid JSON, and the apostrophe is POSIX-escaped as '\'' so the
        // single-quoted shell literal stays well-formed.
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let cmd = value["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(cmd.contains(r"'\''"));
        assert!(cmd.contains(r"'/home/o'\''brien/sess.log'"));
    }
}
