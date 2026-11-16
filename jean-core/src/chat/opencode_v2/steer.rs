//! Steering user messages into a running OpenCode 2.x turn.
//!
//! A steer posts its message only while the turn is registered, and the
//! turn unregisters only when no steer is pending, both under one lock. So a
//! steer either becomes part of the running turn or fails before it posts,
//! and the caller can send it as a normal message instead.

use super::V2Client;
use crate::opencode_server::OpenCodeServer;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// OpenCode session id → inbox ids of steers the turn has not picked up.
static ACTIVE_TURNS: Lazy<Mutex<HashMap<String, Vec<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn turns() -> MutexGuard<'static, HashMap<String, Vec<String>>> {
    ACTIVE_TURNS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Registers a running turn for steering. Unregisters on drop.
pub(super) struct ActiveTurn {
    session_id: String,
}

impl ActiveTurn {
    pub(super) fn register(session_id: &str) -> Self {
        turns().insert(session_id.to_string(), Vec::new());
        Self {
            session_id: session_id.to_string(),
        }
    }
}

impl Drop for ActiveTurn {
    fn drop(&mut self) {
        turns().remove(&self.session_id);
    }
}

/// Steers sent since the last call. Empty for unregistered sessions.
pub(super) fn take_steers(session_id: &str) -> Vec<String> {
    turns()
        .get_mut(session_id)
        .map(std::mem::take)
        .unwrap_or_default()
}

/// Unregister the turn unless steers are pending; returns those steers.
/// An empty result means the turn may end.
pub(super) fn close_unless_steered(session_id: &str) -> Vec<String> {
    let mut turns = turns();
    match turns.get_mut(session_id) {
        Some(pending) if !pending.is_empty() => std::mem::take(pending),
        _ => {
            turns.remove(session_id);
            Vec::new()
        }
    }
}

pub fn steer(server: &OpenCodeServer, session_id: &str, text: &str) -> Result<(), String> {
    let client = V2Client::new(server, Duration::from_secs(30))?;
    let mut turns = turns();
    let pending = turns
        .get_mut(session_id)
        .ok_or_else(|| format!("No running OpenCode 2.x turn for session {session_id}"))?;
    pending.push(client.prompt(session_id, text, "steer")?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_closes_only_without_pending_steers() {
        let turn = ActiveTurn::register("ses_steer_test");
        turns()
            .get_mut("ses_steer_test")
            .unwrap()
            .push("msg_s".to_string());
        assert_eq!(
            close_unless_steered("ses_steer_test"),
            vec!["msg_s".to_string()]
        );
        assert!(
            turns().contains_key("ses_steer_test"),
            "still open for the steer"
        );
        assert!(close_unless_steered("ses_steer_test").is_empty());
        assert!(!turns().contains_key("ses_steer_test"));
        drop(turn);
        assert!(take_steers("ses_steer_test").is_empty());
    }
}
