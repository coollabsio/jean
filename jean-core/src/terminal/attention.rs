//! Lifecycle signals for Codex sessions running in Jean's native terminal.

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct CodexNotification {
    #[serde(rename = "type")]
    event_type: String,
    thread_id: Option<String>,
    #[serde(default)]
    input_messages: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct ParsedNotification {
    thread_id: Option<String>,
    first_prompt: Option<String>,
}

fn signal_file(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?
        .join("terminal-notifications");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create terminal notification dir: {error}"))?;
    let safe_session_id = crate::chat::storage::sanitize_filename(session_id);
    Ok(dir.join(format!("{safe_session_id}.jsonl")))
}

pub fn is_codex_command(command: &str) -> bool {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "codex" || name == "codex.exe")
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

fn codex_notify_args(signal_path: &Path, args: Vec<String>) -> Vec<String> {
    let notify = serde_json::to_string(&notify_command(signal_path)).unwrap_or_default();
    let mut augmented = vec!["-c".to_string(), format!("notify={notify}")];
    augmented.extend(args);
    augmented
}

pub fn inject_codex_notify(
    app: &AppHandle,
    session_id: &str,
    command: &str,
    args: Vec<String>,
) -> (Vec<String>, Option<PathBuf>) {
    if !is_codex_command(command) {
        return (args, None);
    }
    let path = match signal_file(app, session_id) {
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
    (codex_notify_args(&path, args), Some(path))
}

fn parse_codex_notification(line: &str) -> Option<ParsedNotification> {
    let notification: CodexNotification = serde_json::from_str(line).ok()?;
    if notification.event_type != "agent-turn-complete" {
        return None;
    }
    let first_prompt = notification
        .input_messages
        .into_iter()
        .find(|message| !message.trim().is_empty());
    Some(ParsedNotification {
        thread_id: notification.thread_id,
        first_prompt,
    })
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
        let mut tailer = match NdjsonTailer::new_from_start(&signal_path) {
            Ok(tailer) => tailer,
            Err(error) => {
                log::warn!("terminal notifications: cannot tail signal file: {error}");
                TERMINAL_SESSIONS.lock().unwrap().remove(&terminal_id);
                return;
            }
        };
        let mut naming_attempted = false;
        let mut handle_line = |line: &str| {
            let Some(notification) = parse_codex_notification(line.trim()) else {
                return;
            };
            set_waiting(&app, &session_id, true, notification.thread_id.as_deref());
            if !naming_attempted {
                if let Some(prompt) = notification.first_prompt {
                    naming_attempted = true;
                    let app = app.clone();
                    let session_id = session_id.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::chat::trigger_terminal_session_naming(app, session_id, prompt).await;
                    });
                }
            }
            let _ = app.emit_all(
                "terminal:attention",
                &serde_json::json!({ "sessionId": session_id }),
            );
        };
        loop {
            if let Ok(lines) = tailer.poll() {
                for line in lines {
                    handle_line(&line);
                }
            }
            if !super::registry::has_terminal(&terminal_id) {
                if let Ok(lines) = tailer.poll() {
                    for line in lines {
                        handle_line(&line);
                    }
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        TERMINAL_SESSIONS.lock().unwrap().remove(&terminal_id);
        let _ = std::fs::remove_file(signal_path);
    });
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
        let payload = parse_codex_notification(
            r#"{"type":"agent-turn-complete","thread-id":"thread-1","input-messages":["Fix the terminal state"],"last-assistant-message":"Done"}"#,
        )
        .unwrap();
        assert_eq!(payload.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(
            payload.first_prompt.as_deref(),
            Some("Fix the terminal state")
        );
    }

    #[test]
    fn ignores_other_notification_events() {
        assert!(parse_codex_notification(r#"{"type":"other"}"#).is_none());
        assert!(parse_codex_notification("not-json").is_none());
    }

    #[test]
    fn enter_input_is_the_only_terminal_input_that_clears_attention() {
        assert!(input_submits_prompt("hello\r"));
        assert!(input_submits_prompt("hello\n"));
        assert!(!input_submits_prompt("hello"));
        assert!(!input_submits_prompt("\u{1b}[A"));
    }
}
