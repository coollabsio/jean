//! Live permission prompts for Claude CLI Supervised runs.
//!
//! Headless `claude -p` denies every permission ask unless a
//! `--permission-prompt-tool` answers it. Supervised runs route that tool to
//! Jean MCP, which holds the MCP call open until the user answers the approval
//! card. Requests reuse `chat:permission_denied` with `rpc_id` set, and the
//! frontend answers through `respond_claude_permission`.
//! Response format: https://docs.anthropic.com/en/docs/claude-code/sdk

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use tauri::AppHandle;
use tokio::sync::oneshot;

use super::types::{PermissionDenial, PermissionDeniedEvent, RunStatus};
use crate::http_server::EmitExt;

/// Claude CLI MCP tool timeout (ms) for runs with live prompts. Some CLI
/// versions default to 60s (or less), which would deny a slow answer.
pub const LIVE_PROMPT_MCP_TIMEOUT_MS: &str = "86400000";

/// rpc_id -> (Jean session id, answer channel)
static PENDING: Lazy<Mutex<HashMap<u64, (String, oneshot::Sender<bool>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
/// Tool uses the user denied live. The CLI still lists them in the final
/// `permission_denials`; skip them there so the card does not show twice.
static DENIED_LIVE: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// How often a waiting request checks that its run is still active.
const RUN_CHECK_INTERVAL: Duration = Duration::from_secs(2);

/// Execution mode and worktree of the session's active run, if any.
pub fn active_run(app: &AppHandle, session_id: &str) -> Option<(Option<String>, String)> {
    let metadata = super::storage::load_metadata(app, session_id).ok()??;
    let run = metadata
        .runs
        .iter()
        .rev()
        .find(|run| matches!(run.status, RunStatus::Running | RunStatus::Resumable))?;
    Some((run.execution_mode.clone(), metadata.worktree_id.clone()))
}

/// Show the approval card and wait for the user's answer. Returns false when
/// the user denies, or when the run stops before the user answers.
pub async fn ask_user(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    tool_name: &str,
    tool_use_id: &str,
    tool_input: serde_json::Value,
) -> bool {
    let rpc_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = oneshot::channel();
    lock(&PENDING).insert(rpc_id, (session_id.to_string(), tx));

    let event = PermissionDeniedEvent {
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        denials: vec![PermissionDenial {
            tool_name: tool_name.to_string(),
            tool_use_id: tool_use_id.to_string(),
            tool_input,
            rpc_id: Some(rpc_id),
        }],
    };
    if let Err(e) = app.emit_all("chat:permission_denied", &event) {
        log::error!("Failed to emit Claude permission request: {e}");
        lock(&PENDING).remove(&rpc_id);
        return false;
    }

    let approved = loop {
        tokio::select! {
            answer = &mut rx => break answer.unwrap_or(false),
            _ = tokio::time::sleep(RUN_CHECK_INTERVAL) => {
                if active_run(app, session_id).is_none() {
                    log::trace!("Claude permission request {rpc_id} expired: run stopped");
                    lock(&PENDING).remove(&rpc_id);
                    break false;
                }
            }
        }
    };

    if !approved && !tool_use_id.is_empty() {
        lock(&DENIED_LIVE).insert(tool_use_id.to_string());
    }
    approved
}

/// Answer a pending live permission request of a session.
pub fn respond(session_id: &str, rpc_id: u64, approved: bool) -> Result<(), String> {
    let mut pending = lock(&PENDING);
    if pending.get(&rpc_id).map(|(owner, _)| owner.as_str()) != Some(session_id) {
        return Err(format!(
            "No pending Claude permission request {rpc_id} for this session"
        ));
    }
    let (_, tx) = pending.remove(&rpc_id).expect("checked above");
    drop(pending);
    tx.send(approved)
        .map_err(|_| format!("Claude permission request {rpc_id} is no longer waiting"))
}

/// True once for a tool use the user already denied live.
pub fn take_denied_live(tool_use_id: &str) -> bool {
    lock(&DENIED_LIVE).remove(tool_use_id)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn respond_delivers_answer_once_to_owning_session() {
        let (tx, rx) = oneshot::channel();
        let rpc_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        lock(&PENDING).insert(rpc_id, ("session-a".to_string(), tx));

        assert!(respond("session-b", rpc_id, true).is_err());
        respond("session-a", rpc_id, true).unwrap();
        assert!(rx.await.unwrap());
        assert!(respond("session-a", rpc_id, true).is_err());
    }

    #[test]
    fn denied_live_is_taken_once() {
        lock(&DENIED_LIVE).insert("toolu_test".to_string());
        assert!(take_denied_live("toolu_test"));
        assert!(!take_denied_live("toolu_test"));
    }
}
