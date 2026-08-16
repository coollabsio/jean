//! Lifecycle signals for backend CLI sessions running in Jean's native terminal.
//!
//! Codex reports turn completion through its `notify` config hook; Claude Code
//! reports through `UserPromptSubmit` / `Stop` / `Notification` hooks injected
//! with an inline `--settings` JSON. Both write one NDJSON line per event into
//! a per-terminal signal file that a tailer thread turns into `terminal:working`
//! / `terminal:attention` / `terminal:idle` events.

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

use crate::chat::storage::with_existing_metadata_mut;
use crate::chat::tail::NdjsonTailer;
use crate::http_server::EmitExt;

static TERMINAL_SESSIONS: Lazy<Mutex<HashMap<String, (AppHandle, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Grace period before an unregistered terminal's signal file is reclaimed.
const FRESH_SIGNAL_FILE: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct CodexNotification {
    #[serde(rename = "type")]
    event_type: String,
    thread_id: Option<String>,
    #[serde(default)]
    input_messages: Vec<String>,
}

/// Claude Code hook payload (delivered on the hook's stdin).
#[derive(Debug, Deserialize)]
struct ClaudeHookEvent {
    hook_event_name: String,
    prompt: Option<String>,
    notification_type: Option<String>,
}

/// A lifecycle transition parsed out of a signal file line.
#[derive(Debug, PartialEq)]
enum Signal {
    /// The user submitted a prompt: the session is working again.
    TurnStart { first_prompt: Option<String> },
    /// The agent finished or needs input: the session wants attention.
    Attention {
        thread_id: Option<String>,
        first_prompt: Option<String>,
    },
    /// The CLI exited while the terminal stayed open: nothing to wait for.
    Idle,
}

/// Keyed by terminal id, not session id: the tailer thread that deletes this
/// file exits with its terminal. A session-keyed path would let the outgoing
/// tailer of a reopened session terminal unlink the incoming terminal's file.
fn signal_file(app: &AppHandle, terminal_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?
        .join("terminal-notifications");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create terminal notification dir: {error}"))?;
    sweep_orphaned_signal_files(&dir);
    let safe_terminal_id = crate::chat::storage::sanitize_filename(terminal_id);
    Ok(dir.join(format!("{safe_terminal_id}.jsonl")))
}

/// The tailer deletes its own signal file, but it dies with the process on a
/// crash or force quit. Reclaim files whose terminal is gone whenever a new
/// instrumented terminal starts.
fn sweep_orphaned_signal_files(dir: &Path) {
    let live: Vec<String> = super::registry::get_all_terminal_ids()
        .iter()
        .map(|id| crate::chat::storage::sanitize_filename(id))
        .collect();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_live = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| live.iter().any(|id| id == stem));
        // A terminal starting right now has already written its file but is not
        // registered until it spawns, so leave fresh files alone.
        let is_fresh = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age < FRESH_SIGNAL_FILE));
        if !is_live && !is_fresh {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn command_basename_is(command: &str, name: &str) -> bool {
    Path::new(command)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .is_some_and(|file_name| file_name == name || file_name == format!("{name}.exe"))
}

pub fn is_codex_command(command: &str) -> bool {
    command_basename_is(command, "codex")
}

pub fn is_claude_command(command: &str) -> bool {
    command_basename_is(command, "claude")
}

#[cfg(unix)]
fn notify_command(signal_path: &Path) -> Vec<String> {
    let path = crate::platform::shell_escape(&signal_path.to_string_lossy());
    vec![
        "sh".to_string(),
        "-c".to_string(),
        format!("printf '%s\\n' \"$1\" >> {path}"),
        "jean-codex-notify".to_string(),
    ]
}

#[cfg(windows)]
fn notify_command(signal_path: &Path) -> Vec<String> {
    let path = signal_path.to_string_lossy().replace('\'', "''");
    vec![
        "powershell.exe".to_string(),
        "-NoProfile".to_string(),
        "-Command".to_string(),
        format!("Add-Content -LiteralPath '{path}' -Value $args[0]"),
    ]
}

/// Shell command a Claude hook runs: append its stdin JSON as one NDJSON line.
///
/// Built as a single `printf` so hooks do not interleave a half line into the
/// signal file. `O_APPEND` only makes that atomic below `PIPE_BUF`, but the
/// hooks Jean registers never fire concurrently in practice.
#[cfg(unix)]
fn claude_hook_command(signal_path: &Path) -> String {
    let path = crate::platform::shell_escape(&signal_path.to_string_lossy());
    format!("printf '%s\\n' \"$(tr -d '\\n')\" >> {path}")
}

#[cfg(windows)]
fn claude_hook_command(signal_path: &Path) -> String {
    let path = signal_path.to_string_lossy().replace('\'', "''");
    format!(
        "powershell.exe -NoProfile -Command \"Add-Content -LiteralPath '{path}' -Value ([Console]::In.ReadToEnd() -replace '[\\r\\n]','')\""
    )
}

/// Claude Code lifecycle hooks, as an inline `--settings` JSON payload.
///
/// `UserPromptSubmit` marks the session working, `Stop` and permission prompts
/// mark it as needing attention, and `SessionEnd` clears both so a session whose
/// CLI exited does not sit on a stale waiting badge.
pub(super) fn claude_hook_args(signal_path: &Path, args: Vec<String>) -> Vec<String> {
    // Two `--settings` flags means one silently loses. A custom launch config
    // that already carries one keeps it; that terminal just does not report.
    if args.iter().any(|arg| arg == "--settings") {
        log::warn!("terminal notifications: launch args already set --settings, not instrumenting");
        return args;
    }
    let command = claude_hook_command(signal_path);
    let hooks = serde_json::json!([{ "type": "command", "command": command }]);
    let entry = serde_json::json!([{ "hooks": hooks.clone() }]);
    let settings = serde_json::json!({
        "hooks": {
            "UserPromptSubmit": entry.clone(),
            "Stop": entry.clone(),
            // No matcher: every end reason (clear, resume, logout,
            // prompt_input_exit, ...) should release the waiting state.
            "SessionEnd": entry,
            "Notification": [{
                "matcher": "permission_prompt",
                "hooks": hooks,
            }],
        }
    });
    let mut augmented = vec!["--settings".to_string(), settings.to_string()];
    augmented.extend(args);
    augmented
}

pub(super) fn codex_notify_args(signal_path: &Path, args: Vec<String>) -> Vec<String> {
    // Same silent-loss problem as the Claude `--settings` guard: one of the two
    // `notify` overrides wins and the other vanishes. Keep the user's.
    if args
        .windows(2)
        .any(|pair| pair[0] == "-c" && pair[1].starts_with("notify="))
    {
        log::warn!("terminal notifications: launch args already set notify=, not instrumenting");
        return args;
    }
    let notify = serde_json::to_string(&notify_command(signal_path)).unwrap_or_default();
    let mut augmented = vec!["-c".to_string(), format!("notify={notify}")];
    augmented.extend(args);
    augmented
}

/// Prepend the backend's lifecycle-hook arguments so it reports turn state into
/// a per-terminal signal file. Returns the args unchanged for backends we cannot
/// instrument.
pub fn inject_lifecycle_hook(
    app: &AppHandle,
    terminal_id: &str,
    command: &str,
    args: Vec<String>,
) -> (Vec<String>, Option<PathBuf>) {
    let build_args: fn(&Path, Vec<String>) -> Vec<String> = if is_codex_command(command) {
        codex_notify_args
    } else if is_claude_command(command) {
        claude_hook_args
    } else {
        return (args, None);
    };
    let path = match signal_file(app, terminal_id) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("terminal notifications: {error}");
            return (args, None);
        }
    };
    if let Err(error) = std::fs::write(&path, b"") {
        log::warn!("terminal notifications: cannot reset signal file: {error}");
        return (args, None);
    }
    (build_args(&path, args), Some(path))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

fn parse_codex_notification(line: &str) -> Option<Signal> {
    let notification: CodexNotification = serde_json::from_str(line).ok()?;
    if notification.event_type != "agent-turn-complete" {
        return None;
    }
    let first_prompt = notification
        .input_messages
        .into_iter()
        .find(|message| !message.trim().is_empty());
    Some(Signal::Attention {
        thread_id: notification.thread_id,
        first_prompt,
    })
}

fn parse_claude_hook(line: &str) -> Option<Signal> {
    let event: ClaudeHookEvent = serde_json::from_str(line).ok()?;
    match event.hook_event_name.as_str() {
        "UserPromptSubmit" => Some(Signal::TurnStart {
            first_prompt: non_empty(event.prompt),
        }),
        "Stop" => Some(Signal::Attention {
            thread_id: None,
            first_prompt: None,
        }),
        // The CLI matches `matcher` as an unanchored regex, so subagent prompts
        // (`worker_permission_prompt`) reach us too. They block the turn just
        // like a top-level prompt, so treat both as attention.
        "Notification"
            if event
                .notification_type
                .as_deref()
                .is_some_and(|kind| kind.ends_with("permission_prompt")) =>
        {
            Some(Signal::Attention {
                thread_id: None,
                first_prompt: None,
            })
        }
        "SessionEnd" => Some(Signal::Idle),
        _ => None,
    }
}

fn parse_signal_line(line: &str) -> Option<Signal> {
    parse_codex_notification(line).or_else(|| parse_claude_hook(line))
}

fn set_waiting(app: &AppHandle, session_id: &str, waiting: bool, codex_thread_id: Option<&str>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let result = with_existing_metadata_mut(app, session_id, |metadata| {
        metadata.waiting_for_input = waiting;
        metadata.waiting_for_input_type = waiting.then(|| "question".to_string());
        if let Some(thread_id) = codex_thread_id {
            metadata.codex_thread_id = Some(thread_id.to_string());
        }
        // Both prompt submit and turn-complete count as terminal activity so
        // session ordering stays fresh without Jean run history.
        metadata.terminal_activity_at = Some(now);
    });
    match result {
        Ok(()) => crate::chat::emit_sessions_cache_invalidation(app),
        Err(error) => {
            log::debug!("terminal notifications: cannot update {session_id}: {error}");
        }
    }
}

pub fn spawn_signal_tailer(
    app: AppHandle,
    session_id: String,
    terminal_id: String,
    signal_path: PathBuf,
) {
    TERMINAL_SESSIONS
        .lock()
        .unwrap()
        .insert(terminal_id.clone(), (app.clone(), session_id.clone()));
    std::thread::spawn(move || {
        let mut naming_attempted = false;
        let mut maybe_name_session = |first_prompt: Option<String>| {
            if naming_attempted {
                return;
            }
            let Some(prompt) = first_prompt else {
                return;
            };
            naming_attempted = true;
            let app = app.clone();
            let session_id = session_id.clone();
            tauri::async_runtime::spawn(async move {
                crate::chat::trigger_terminal_session_naming(app, session_id, prompt).await;
            });
        };
        let handle_line = |line: &str| {
            let Some(signal) = parse_signal_line(line.trim()) else {
                return;
            };
            let (waiting, event, thread_id, first_prompt) = match signal {
                Signal::TurnStart { first_prompt } => {
                    (false, "terminal:working", None, first_prompt)
                }
                Signal::Attention {
                    thread_id,
                    first_prompt,
                } => (true, "terminal:attention", thread_id, first_prompt),
                Signal::Idle => (false, "terminal:idle", None, None),
            };
            set_waiting(&app, &session_id, waiting, thread_id.as_deref());
            maybe_name_session(first_prompt);
            let _ = app.emit_all(event, &serde_json::json!({ "sessionId": session_id }));
        };
        tail_until_closed(
            &signal_path,
            || super::registry::has_terminal(&terminal_id),
            handle_line,
        );
        TERMINAL_SESSIONS.lock().unwrap().remove(&terminal_id);
        // The CLI is gone, whatever ended it (`/exit`, Ctrl-C, crash, kill).
        // Without this the session keeps whichever state its last signal left —
        // and submitting `/exit` itself counts as input, so the last state is
        // "working". Codex has no session-end event of its own to report with;
        // for Claude this just repeats an already-handled `SessionEnd`.
        set_waiting(&app, &session_id, false, None);
        let _ = app.emit_all(
            "terminal:idle",
            &serde_json::json!({ "sessionId": session_id }),
        );
    });
}

/// Tail `signal_path` until `is_open` goes false, then delete it.
///
/// Drains once more after the terminal is gone so a final `Stop` written during
/// teardown is not dropped. Always removes the file, including on open failure.
fn tail_until_closed(
    signal_path: &Path,
    mut is_open: impl FnMut() -> bool,
    mut handle_line: impl FnMut(&str),
) {
    let mut tailer = match NdjsonTailer::new_from_start(signal_path) {
        Ok(tailer) => tailer,
        Err(error) => {
            log::warn!("terminal notifications: cannot tail signal file: {error}");
            let _ = std::fs::remove_file(signal_path);
            return;
        }
    };
    let mut drain = |tailer: &mut NdjsonTailer| {
        if let Ok(lines) = tailer.poll() {
            for line in lines {
                handle_line(&line);
            }
        }
    };
    loop {
        drain(&mut tailer);
        if !is_open() {
            drain(&mut tailer);
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = std::fs::remove_file(signal_path);
}

fn input_submits_prompt(data: &str) -> bool {
    data.contains('\r') || data.contains('\n')
}

pub fn clear_attention_on_input(terminal_id: &str, data: &str) {
    if !input_submits_prompt(data) {
        return;
    }
    let entry = TERMINAL_SESSIONS.lock().unwrap().get(terminal_id).cloned();
    let Some((app, session_id)) = entry else {
        return;
    };
    set_waiting(&app, &session_id, false, None);
    let _ = app.emit_all(
        "terminal:working",
        &serde_json::json!({ "sessionId": session_id }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_codex_command_by_name_and_path() {
        assert!(is_codex_command("codex"));
        assert!(is_codex_command("/opt/Jean/codex-cli/codex"));
        assert!(is_codex_command("codex.exe"));
        assert!(!is_codex_command("claude"));
        assert!(!is_codex_command(""));
    }

    #[test]
    fn detects_claude_command_by_name_and_path() {
        assert!(is_claude_command("claude"));
        assert!(is_claude_command(
            "/Users/x/Library/Application Support/jean/claude-cli/claude"
        ));
        assert!(is_claude_command("claude.exe"));
        assert!(!is_claude_command("codex"));
        assert!(!is_claude_command("claude-extra"));
        assert!(!is_claude_command(""));
    }

    #[test]
    fn terminal_signal_filename_cannot_escape_notification_directory() {
        let safe_session_id = crate::chat::storage::sanitize_filename("../../session/1");

        assert_eq!(safe_session_id, "------session-1");
        assert!(!safe_session_id.contains('/'));
        assert!(!safe_session_id.contains(".."));
    }

    #[test]
    fn notify_override_is_inserted_before_resume_subcommand() {
        let result = codex_notify_args(
            Path::new("/tmp/session.log"),
            vec!["resume".to_string(), "thread-123".to_string()],
        );
        assert_eq!(result[0], "-c");
        assert!(result[1].starts_with("notify="));
        assert_eq!(&result[2..], ["resume", "thread-123"]);
        assert!(result[1].contains("session.log"));
    }

    #[test]
    fn parses_agent_turn_complete_payload() {
        let payload = parse_signal_line(
            r#"{"type":"agent-turn-complete","thread-id":"thread-1","input-messages":["Fix the terminal state"],"last-assistant-message":"Done"}"#,
        )
        .unwrap();
        assert_eq!(
            payload,
            Signal::Attention {
                thread_id: Some("thread-1".to_string()),
                first_prompt: Some("Fix the terminal state".to_string()),
            }
        );
    }

    #[test]
    fn ignores_other_notification_events() {
        assert!(parse_signal_line(r#"{"type":"other"}"#).is_none());
        assert!(parse_signal_line("not-json").is_none());
    }

    #[test]
    fn claude_settings_hook_is_inserted_before_resume_args() {
        let result = claude_hook_args(
            Path::new("/tmp/session.jsonl"),
            vec!["--resume".to_string(), "abc".to_string()],
        );
        assert_eq!(result[0], "--settings");
        assert_eq!(&result[2..], ["--resume", "abc"]);

        let settings: serde_json::Value = serde_json::from_str(&result[1]).unwrap();
        let hooks = &settings["hooks"];
        for event in ["UserPromptSubmit", "Stop", "SessionEnd", "Notification"] {
            let command = hooks[event][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(command.contains("session.jsonl"), "{event}: {command}");
            assert_eq!(hooks[event][0]["hooks"][0]["type"], "command");
        }
        assert_eq!(hooks["Notification"][0]["matcher"], "permission_prompt");
    }

    #[test]
    fn parses_claude_stop_and_permission_prompt_as_attention() {
        let attention = Signal::Attention {
            thread_id: None,
            first_prompt: None,
        };
        assert_eq!(
            parse_signal_line(r#"{"hook_event_name":"Stop","session_id":"s1"}"#).unwrap(),
            attention
        );
        assert_eq!(
            parse_signal_line(
                r#"{"hook_event_name":"Notification","notification_type":"permission_prompt"}"#
            )
            .unwrap(),
            attention
        );
    }

    #[test]
    fn parses_claude_user_prompt_submit_as_turn_start_with_prompt() {
        assert_eq!(
            parse_signal_line(
                r#"{"hook_event_name":"UserPromptSubmit","prompt":"Fix the terminal state"}"#
            )
            .unwrap(),
            Signal::TurnStart {
                first_prompt: Some("Fix the terminal state".to_string()),
            }
        );
        assert_eq!(
            parse_signal_line(r#"{"hook_event_name":"UserPromptSubmit","prompt":"   "}"#).unwrap(),
            Signal::TurnStart { first_prompt: None }
        );
    }

    #[test]
    fn parses_claude_session_end_as_idle() {
        assert_eq!(
            parse_signal_line(r#"{"hook_event_name":"SessionEnd","session_id":"s1"}"#).unwrap(),
            Signal::Idle
        );
    }

    #[test]
    fn ignores_unrelated_claude_hook_events() {
        assert!(parse_signal_line(r#"{"hook_event_name":"PreToolUse"}"#).is_none());
        assert!(parse_signal_line(
            r#"{"hook_event_name":"Notification","notification_type":"idle_prompt"}"#
        )
        .is_none());
    }

    #[test]
    fn subagent_permission_prompts_also_ask_for_attention() {
        assert_eq!(
            parse_signal_line(
                r#"{"hook_event_name":"Notification","notification_type":"worker_permission_prompt"}"#
            ),
            Some(Signal::Attention {
                thread_id: None,
                first_prompt: None,
            })
        );
    }

    #[test]
    fn tailer_drains_teardown_writes_then_deletes_the_signal_file() {
        use std::io::Write;
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("signal.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"hook_event_name":"UserPromptSubmit","prompt":"hi"}}"#
        )
        .unwrap();

        // Closes after the first poll, and writes a final line during teardown:
        // the extra drain has to pick it up.
        let open = AtomicBool::new(true);
        let mut seen = Vec::new();
        tail_until_closed(
            &path,
            || {
                if open.swap(false, Ordering::SeqCst) {
                    writeln!(file, r#"{{"hook_event_name":"Stop"}}"#).unwrap();
                    true
                } else {
                    false
                }
            },
            |line| seen.push(parse_signal_line(line.trim())),
        );

        assert_eq!(
            seen,
            vec![
                Some(Signal::TurnStart {
                    first_prompt: Some("hi".to_string())
                }),
                Some(Signal::Attention {
                    thread_id: None,
                    first_prompt: None,
                }),
            ]
        );
        assert!(!path.exists(), "signal file must not outlive its terminal");
    }

    /// `is_open` never goes false here: an unopenable signal file has to bail
    /// out instead of spinning forever.
    #[test]
    fn tailer_gives_up_when_the_signal_file_cannot_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.jsonl");
        tail_until_closed(&path, || true, |_| panic!("no lines expected"));
        assert!(!path.exists());
    }

    #[test]
    fn enter_input_is_the_only_terminal_input_that_clears_attention() {
        assert!(input_submits_prompt("hello\r"));
        assert!(input_submits_prompt("hello\n"));
        assert!(!input_submits_prompt("hello"));
        assert!(!input_submits_prompt("\u{1b}[A"));
    }
}
