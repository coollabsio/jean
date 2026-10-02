//! ACP permission requests use the existing command approval UI.
//! Protocol: https://agentclientprotocol.com/protocol/v1/tool-calls

use crate::http_server::EmitExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

// Keep bridge IDs separate from Codex IDs and inside JavaScript's safe integer range.
const FIRST_ID: u64 = 1 << 52;
const LAST_ID: u64 = (1 << 53) - 1;
// A new process gets a new range, so persisted stale cards cannot match IDs
// restarted from zero. Leave half the safe range for the process counter.
static NEXT_ID: LazyLock<AtomicU64> =
    LazyLock::new(|| AtomicU64::new(FIRST_ID + rand::random::<u64>() % (1 << 51)));
type Pending = HashMap<(String, u64), mpsc::Sender<Value>>;
static PENDING: LazyLock<Mutex<Pending>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn cancelled_outcome() -> Value {
    json!({"outcome": {"outcome": "cancelled"}})
}

fn selected_outcome(request: &Value, kind: &str) -> Value {
    request
        .pointer("/params/options")
        .and_then(Value::as_array)
        .and_then(|options| options.iter().find(|option| option["kind"] == kind))
        .and_then(|option| option["optionId"].as_str())
        .map(|id| json!({"outcome": {"outcome": "selected", "optionId": id}}))
        .unwrap_or_else(cancelled_outcome)
}

/// Reserved but stale IDs must never reach the Codex server.
pub(crate) fn respond(
    session_id: &str,
    rpc_id: u64,
    response: Value,
) -> Option<Result<(), String>> {
    if !(FIRST_ID..=LAST_ID).contains(&rpc_id) {
        return None;
    }
    Some((|| {
        let mut pending = PENDING.lock().map_err(|_| "Devin permission lock failed")?;
        let key = (session_id.to_string(), rpc_id);
        let sender = pending
            .remove(&key)
            .ok_or("Devin permission request has expired")?;
        sender
            .send(response)
            .map_err(|_| "Devin permission request has expired".to_string())
    })())
}

fn wait_for_decision(
    receiver: &mpsc::Receiver<Value>,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
            return json!({"decision": "cancel"});
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(response) => {
                return if cancelled.load(Ordering::Acquire) {
                    json!({"decision": "cancel"})
                } else {
                    response
                };
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return json!({"decision": "cancel"}),
        }
    }
}

fn decision_outcome(
    request: &Value,
    mut decision: Value,
    cancelled: &AtomicBool,
    auto_approve: &AtomicBool,
) -> Value {
    if cancelled.load(Ordering::Acquire) {
        return cancelled_outcome();
    }
    let promote = super::commands::prepare_codex_command_approval_response(&mut decision);
    match decision["decision"].as_str() {
        Some("accept" | "acceptForSession") => {
            if promote {
                auto_approve.store(true, Ordering::Release);
            }
            selected_outcome(request, "allow_once")
        }
        Some("decline") => selected_outcome(request, "reject_once"),
        _ => {
            cancelled.store(true, Ordering::Release);
            cancelled_outcome()
        }
    }
}

pub(crate) fn request_permission(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    request: &Value,
    execution_mode: Option<&str>,
    cancelled: &AtomicBool,
    auto_approve: &AtomicBool,
) -> Result<Value, String> {
    if cancelled.load(Ordering::Acquire) {
        return Ok(cancelled_outcome());
    }
    if matches!(execution_mode, None | Some("plan")) {
        return Ok(selected_outcome(request, "reject_once"));
    }
    if execution_mode == Some("yolo") || auto_approve.load(Ordering::Acquire) {
        return Ok(selected_outcome(request, "allow_once"));
    }
    let rpc_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    if rpc_id > LAST_ID {
        return Err("Devin permission ID range exhausted".to_string());
    }
    let (sender, receiver) = mpsc::channel();
    let key = (session_id.to_string(), rpc_id);
    PENDING
        .lock()
        .map_err(|_| "Devin permission lock failed")?
        .insert(key.clone(), sender);
    let tool = &request["params"]["toolCall"];
    let mut decisions = vec![json!("cancel")];
    for (kind, decision) in [("allow_once", "accept"), ("reject_once", "decline")] {
        if selected_outcome(request, kind)["outcome"]["outcome"] == "selected" {
            decisions.push(json!(decision));
        }
    }
    let emitted = app.emit_all(
        "chat:codex_command_approval_request",
        &json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "request": {
                "rpc_id": rpc_id,
                "item_id": tool["toolCallId"].as_str().unwrap_or("devin-tool"),
                "thread_id": request["params"]["sessionId"].as_str().unwrap_or_default(),
                "turn_id": "",
                "command": tool["title"].as_str().unwrap_or("Devin tool"),
                "additional_permissions": tool.get("rawInput"),
                "available_decisions": decisions
            }
        }),
    );
    let decision = if emitted.is_ok() {
        wait_for_decision(&receiver, cancelled, Duration::from_secs(600))
    } else {
        json!({"decision": "cancel"})
    };
    PENDING
        .lock()
        .map_err(|_| "Devin permission lock failed")?
        .remove(&key);
    let _ = app.emit_all(
        "chat:devin_permission_resolved",
        &json!({
            "session_id": session_id, "worktree_id": worktree_id, "rpc_id": rpc_id
        }),
    );
    Ok(decision_outcome(request, decision, cancelled, auto_approve))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_substitutes_persistent_permission_for_once() {
        let request = json!({"params": {"options": [
            {"kind": "allow_always", "optionId": "always"},
            {"kind": "reject_once", "optionId": "deny"}
        ]}});
        assert_eq!(
            selected_outcome(&request, "allow_once"),
            cancelled_outcome()
        );
        assert_eq!(
            selected_outcome(&request, "reject_once")["outcome"]["optionId"],
            "deny"
        );
    }

    #[test]
    fn routes_by_session_and_rejects_stale_reserved_ids() {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        PENDING
            .lock()
            .unwrap()
            .insert(("permission-test".into(), id), sender);
        assert!(respond("other-session", id, json!({"decision": "accept"}))
            .unwrap()
            .is_err());
        assert!(
            respond("permission-test", id, json!({"decision": "decline"}))
                .unwrap()
                .is_ok()
        );
        assert_eq!(receiver.recv().unwrap()["decision"], "decline");
        assert!(respond("permission-test", id, json!({})).unwrap().is_err());
        assert!(respond("permission-test", 42, json!({})).is_none());
    }

    #[test]
    fn cancel_stops_turn_but_decline_does_not_promote_or_cancel() {
        let auto_approve = AtomicBool::new(false);
        let cancelled = AtomicBool::new(false);
        let request = json!({"params":{"options":[{"kind":"reject_once","optionId":"deny"}]}});
        let result = decision_outcome(
            &request,
            json!({"decision":"decline","promoteToYolo":true}),
            &cancelled,
            &auto_approve,
        );
        assert_eq!(result["outcome"]["optionId"], "deny");
        assert!(!cancelled.load(Ordering::Acquire));
        assert!(!auto_approve.load(Ordering::Acquire));
        assert_eq!(
            decision_outcome(
                &request,
                json!({"decision":"cancel"}),
                &cancelled,
                &auto_approve
            ),
            cancelled_outcome()
        );
        assert!(cancelled.load(Ordering::Acquire));
        decision_outcome(
            &request,
            json!({"decision":"accept","promoteToYolo":true}),
            &cancelled,
            &auto_approve,
        );
        assert!(!auto_approve.load(Ordering::Acquire));
    }

    #[test]
    fn explicit_promotion_changes_only_this_turn() {
        let request = json!({"params":{"options":[{"kind":"allow_once","optionId":"once"}]}});
        let cancelled = AtomicBool::new(false);
        let current_turn = AtomicBool::new(false);
        let next_turn = AtomicBool::new(false);
        let outcome = decision_outcome(
            &request,
            json!({"decision":"accept","promoteToYolo":true}),
            &cancelled,
            &current_turn,
        );
        assert_eq!(outcome["outcome"]["optionId"], "once");
        assert!(current_turn.load(Ordering::Acquire));
        assert!(!next_turn.load(Ordering::Acquire));
    }

    #[test]
    fn cancellation_overrides_queued_approval_and_timeout_cancels() {
        let (sender, receiver) = mpsc::channel();
        sender.send(json!({"decision": "accept"})).unwrap();
        assert_eq!(
            wait_for_decision(&receiver, &AtomicBool::new(true), Duration::from_secs(1))
                ["decision"],
            "cancel"
        );
        assert_eq!(
            wait_for_decision(&receiver, &AtomicBool::new(false), Duration::ZERO)["decision"],
            "cancel"
        );
    }
}
