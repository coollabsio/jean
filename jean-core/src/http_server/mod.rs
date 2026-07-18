pub mod assets;
pub mod auth;
pub mod dispatch;
pub mod server;
pub mod websocket;

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tokio::sync::broadcast;

/// Global monotonic sequence counter for event replay.
static EVENT_SEQ: AtomicU64 = AtomicU64::new(1);

/// Maximum events buffered per session for replay.
const SESSION_BUFFER_CAP: usize = 2000;

/// Maximum events buffered per terminal for replay after a page refresh.
/// Keeps tiny output bursts bounded by count even when byte usage is low.
const TERMINAL_BUFFER_MAX_EVENTS: usize = 12000;

/// Maximum serialized JSON bytes buffered per terminal for replay after refresh.
/// Terminal output chunks can be several KiB each, so this byte budget is the
/// real per-terminal memory guard; the event cap above is only a secondary
/// small-event guard.
const TERMINAL_BUFFER_MAX_BYTES: usize = 3 * 1024 * 1024;

/// Events that are worth buffering for bootstrap replay after a page refresh.
const REPLAYABLE_EVENTS: &[&str] = &[
    "chat:sending",
    "chat:chunk",
    "chat:tool_use",
    "chat:tool_block",
    "chat:tool_result",
    "chat:thinking",
    "chat:permission_denied",
    "chat:codex_command_approval_request",
    "chat:codex_permission_request",
    "chat:codex_user_input_request",
    "chat:codex_mcp_elicitation_request",
    "chat:codex_dynamic_tool_call_request",
    "chat:done",
    "chat:cancelled",
    "chat:error",
];

/// Terminal events buffered for replay after a page refresh.
/// Keyed by `terminal_id` field in payload.
const TERMINAL_REPLAYABLE_EVENTS: &[&str] = &["terminal:output", "terminal:started"];

/// Broadcast channel for sending events to all connected WebSocket clients.
/// Managed as Tauri state so any code with an AppHandle can broadcast.
pub struct WsBroadcaster {
    tx: broadcast::Sender<WsEvent>,
    /// True while the HTTP server is running. When false, `broadcast()` is a
    /// no-op so native-only usage pays zero serialization/buffering cost on
    /// every emitted event.
    active: AtomicBool,
    /// Per-session ring buffer for event replay during page bootstrap.
    /// Key: session_id extracted from the event payload.
    session_buffers: Mutex<HashMap<String, VecDeque<(u64, Arc<str>)>>>,
    /// Per-terminal ring buffer for event replay after a page refresh.
    /// Key: terminal_id extracted from the event payload.
    terminal_buffers: Mutex<HashMap<String, TerminalReplayBuffer>>,
}

/// A pre-serialized WebSocket event.
/// The JSON string is wrapped in `Arc<str>` so cloning across N broadcast
/// receivers is a cheap reference-count increment instead of N allocations.
#[derive(Clone, Debug)]
pub struct WsEvent {
    pub json: Arc<str>,
    /// Monotonic sequence number for replay ordering.
    pub seq: u64,
}

/// Wire-format envelope serialized once in `broadcast()`.
#[derive(Serialize)]
struct WsEnvelope<'a, S: Serialize> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    event: &'a str,
    payload: &'a S,
    /// Monotonic sequence number for replay ordering.
    seq: u64,
}

#[derive(Debug, Default)]
struct TerminalReplayBuffer {
    events: VecDeque<(u64, Arc<str>)>,
    bytes: usize,
}

impl TerminalReplayBuffer {
    fn push(&mut self, seq: u64, json: Arc<str>) {
        let event_bytes = json.len();

        // A single oversize event cannot be represented without violating the
        // per-terminal memory budget. Drop it from replay instead of retaining
        // an unbounded terminal buffer; live clients still receive it through
        // the broadcast channel below.
        if event_bytes > TERMINAL_BUFFER_MAX_BYTES {
            self.events.clear();
            self.bytes = 0;
            return;
        }

        while !self.events.is_empty()
            && (self.events.len() >= TERMINAL_BUFFER_MAX_EVENTS
                || self.bytes + event_bytes > TERMINAL_BUFFER_MAX_BYTES)
        {
            if let Some((_, old_json)) = self.events.pop_front() {
                self.bytes = self.bytes.saturating_sub(old_json.len());
            }
        }

        self.bytes += event_bytes;
        self.events.push_back((seq, json));
    }

    fn replay_after(&self, after_seq: u64) -> Vec<(u64, Arc<str>)> {
        self.events
            .iter()
            .filter(|(seq, _)| *seq > after_seq)
            .cloned()
            .collect()
    }
}

impl WsBroadcaster {
    pub fn new() -> (Self, broadcast::Sender<WsEvent>) {
        // Buffer 8192 events — generous headroom for burst streaming with
        // multiple clients. Each WsEvent is ~16 bytes (Arc pointer + len).
        let (tx, _) = broadcast::channel(8192);
        let tx_clone = tx.clone();
        (
            Self {
                tx,
                active: AtomicBool::new(false),
                session_buffers: Mutex::new(HashMap::new()),
                terminal_buffers: Mutex::new(HashMap::new()),
            },
            tx_clone,
        )
    }

    /// Serialize the payload once into the wire-format JSON envelope.
    /// Each broadcast receiver gets an `Arc<str>` clone (cheap ref-count
    /// increment) instead of re-serializing per client.
    /// Mark the broadcaster active/inactive alongside HTTP server start/stop.
    /// Deactivating clears replay buffers — a stopped server has no clients to
    /// replay to, and this frees the buffered event memory.
    pub fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::Relaxed);
        if !active {
            if let Ok(mut buffers) = self.session_buffers.lock() {
                buffers.clear();
            }
            if let Ok(mut buffers) = self.terminal_buffers.lock() {
                buffers.clear();
            }
        }
    }

    pub fn broadcast<S: Serialize>(&self, event: &str, payload: &S) {
        // Skip all serialization/buffering when the HTTP server isn't running.
        if !self.active.load(Ordering::Relaxed) {
            return;
        }
        let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
        let envelope = WsEnvelope {
            msg_type: "event",
            event,
            payload,
            seq,
        };
        let json = match serde_json::to_string(&envelope) {
            Ok(s) => s,
            Err(e) => {
                log::error!("Failed to serialize WS event '{event}': {e}");
                return;
            }
        };
        let json_arc: Arc<str> = Arc::from(json);

        // Buffer replayable events per session
        if REPLAYABLE_EVENTS.contains(&event) {
            // Try to extract session_id from the payload
            if let Ok(val) = serde_json::to_value(payload) {
                if let Some(sid) = val.get("session_id").and_then(|v| v.as_str()) {
                    if let Ok(mut buffers) = self.session_buffers.lock() {
                        let buf = buffers
                            .entry(sid.to_string())
                            .or_insert_with(|| VecDeque::with_capacity(SESSION_BUFFER_CAP));
                        if buf.len() >= SESSION_BUFFER_CAP {
                            buf.pop_front();
                        }
                        buf.push_back((seq, json_arc.clone()));
                    }
                }
            }
        }

        // Clean up session buffer on chat:done or chat:cancelled
        if event == "chat:done" || event == "chat:cancelled" {
            if let Ok(val) = serde_json::to_value(payload) {
                if let Some(sid) = val.get("session_id").and_then(|v| v.as_str()) {
                    if let Ok(mut buffers) = self.session_buffers.lock() {
                        buffers.remove(sid);
                    }
                }
            }
        }

        // Buffer replayable terminal events keyed by terminal_id
        if TERMINAL_REPLAYABLE_EVENTS.contains(&event) {
            if let Ok(val) = serde_json::to_value(payload) {
                if let Some(tid) = val.get("terminal_id").and_then(|v| v.as_str()) {
                    if let Ok(mut buffers) = self.terminal_buffers.lock() {
                        buffers
                            .entry(tid.to_string())
                            .or_default()
                            .push(seq, json_arc.clone());
                    }
                }
            }
        }

        // Drop terminal buffer on terminal:stopped — no further output expected
        if event == "terminal:stopped" {
            if let Ok(val) = serde_json::to_value(payload) {
                if let Some(tid) = val.get("terminal_id").and_then(|v| v.as_str()) {
                    if let Ok(mut buffers) = self.terminal_buffers.lock() {
                        buffers.remove(tid);
                    }
                }
            }
        }

        // Ignore send errors (no active receivers is fine)
        let _ = self.tx.send(WsEvent {
            json: json_arc,
            seq,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WsEvent> {
        self.tx.subscribe()
    }

    /// Replay buffered events for a session after the given sequence number.
    /// Returns events in order, each with its sequence number and pre-serialized JSON.
    pub fn replay_events(&self, session_id: &str, after_seq: u64) -> Vec<(u64, Arc<str>)> {
        let buffers = match self.session_buffers.lock() {
            Ok(b) => b,
            Err(_) => return Vec::new(),
        };
        match buffers.get(session_id) {
            Some(buf) => buf
                .iter()
                .filter(|(seq, _)| *seq > after_seq)
                .cloned()
                .collect(),
            None => Vec::new(),
        }
    }

    /// Replay buffered terminal events after the given sequence number.
    pub fn replay_terminal_events(
        &self,
        terminal_id: &str,
        after_seq: u64,
    ) -> Vec<(u64, Arc<str>)> {
        let buffers = match self.terminal_buffers.lock() {
            Ok(b) => b,
            Err(_) => return Vec::new(),
        };
        match buffers.get(terminal_id) {
            Some(buf) => buf.replay_after(after_seq),
            None => Vec::new(),
        }
    }
}

/// Extension trait on AppHandle that sends to both Tauri IPC and WebSocket clients.
/// Use `app.emit_all("event", &payload)` instead of `app.emit("event", &payload)`.
pub trait EmitExt {
    fn emit_all<S: Serialize + Clone>(&self, event: &str, payload: &S) -> Result<(), String>;
    /// Like `emit_all` but takes ownership of the payload, avoiding a caller-side clone
    /// on the hot path (e.g. high-frequency terminal output chunks).
    fn emit_all_owned<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String>;
}

impl EmitExt for AppHandle {
    fn emit_all<S: Serialize + Clone>(&self, event: &str, payload: &S) -> Result<(), String> {
        // Send to Tauri frontend (native app)
        self.emit(event, payload.clone())
            .map_err(|e| format!("Tauri emit failed: {e}"))?;

        // Broadcast to WebSocket clients (if server is running).
        // Serializes directly from &S → JSON in one pass (no intermediate Value).
        if let Some(ws) = self.try_state::<WsBroadcaster>() {
            ws.broadcast(event, payload);
        }

        Ok(())
    }

    fn emit_all_owned<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String> {
        // Broadcast to WebSocket clients first (borrows payload, no clone needed here).
        if let Some(ws) = self.try_state::<WsBroadcaster>() {
            ws.broadcast(event, &payload);
        }

        // Send to Tauri frontend — consumes payload (Tauri's emit requires Clone internally).
        self.emit(event, payload)
            .map_err(|e| format!("Tauri emit failed: {e}"))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn parse_event(json: &Arc<str>) -> Value {
        serde_json::from_str(json).expect("event json should parse")
    }

    fn active_broadcaster() -> (WsBroadcaster, broadcast::Sender<WsEvent>) {
        let (broadcaster, tx) = WsBroadcaster::new();
        broadcaster.set_active(true);
        (broadcaster, tx)
    }

    #[test]
    fn inactive_broadcaster_skips_buffering() {
        let (broadcaster, _tx) = WsBroadcaster::new();

        broadcaster.broadcast(
            "terminal:output",
            &json!({ "terminal_id": "term-1", "data": "dropped" }),
        );
        broadcaster.broadcast(
            "chat:chunk",
            &json!({ "session_id": "s1", "content": "hi" }),
        );

        assert!(broadcaster.replay_terminal_events("term-1", 0).is_empty());
        assert!(broadcaster.replay_events("s1", 0).is_empty());
    }

    #[test]
    fn deactivating_clears_replay_buffers() {
        let (broadcaster, _tx) = active_broadcaster();

        broadcaster.broadcast(
            "terminal:output",
            &json!({ "terminal_id": "term-1", "data": "live" }),
        );
        broadcaster.broadcast(
            "chat:chunk",
            &json!({ "session_id": "s1", "content": "hi" }),
        );
        assert_eq!(broadcaster.replay_terminal_events("term-1", 0).len(), 1);
        assert_eq!(broadcaster.replay_events("s1", 0).len(), 1);

        broadcaster.set_active(false);

        assert!(broadcaster.replay_terminal_events("term-1", 0).is_empty());
        assert!(broadcaster.replay_events("s1", 0).is_empty());
    }

    #[test]
    fn terminal_replay_buffers_only_matching_terminal_events() {
        let (broadcaster, _tx) = active_broadcaster();

        broadcaster.broadcast(
            "terminal:started",
            &json!({ "terminal_id": "term-1", "cols": 80, "rows": 24 }),
        );
        broadcaster.broadcast(
            "terminal:output",
            &json!({ "terminal_id": "term-2", "data": "other" }),
        );
        broadcaster.broadcast(
            "terminal:output",
            &json!({ "terminal_id": "term-1", "data": "hello" }),
        );
        broadcaster.broadcast("terminal:output", &json!({ "data": "missing id" }));

        let events = broadcaster.replay_terminal_events("term-1", 0);
        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .all(|(_, event)| { parse_event(event)["payload"]["terminal_id"] == json!("term-1") }));
        assert_eq!(
            parse_event(&events[0].1)["event"],
            json!("terminal:started")
        );
        assert_eq!(parse_event(&events[1].1)["event"], json!("terminal:output"));
    }

    #[test]
    fn terminal_replay_respects_after_sequence() {
        let (broadcaster, _tx) = active_broadcaster();

        broadcaster.broadcast(
            "terminal:output",
            &json!({ "terminal_id": "term-1", "data": "one" }),
        );
        let first_seq = broadcaster.replay_terminal_events("term-1", 0)[0].0;
        broadcaster.broadcast(
            "terminal:output",
            &json!({ "terminal_id": "term-1", "data": "two" }),
        );

        let events = broadcaster.replay_terminal_events("term-1", first_seq);
        assert_eq!(events.len(), 1);
        assert_eq!(parse_event(&events[0].1)["payload"]["data"], json!("two"));
    }

    #[test]
    fn terminal_stopped_drops_terminal_replay_buffer() {
        let (broadcaster, _tx) = active_broadcaster();

        broadcaster.broadcast(
            "terminal:output",
            &json!({ "terminal_id": "term-1", "data": "live" }),
        );
        assert_eq!(broadcaster.replay_terminal_events("term-1", 0).len(), 1);

        broadcaster.broadcast(
            "terminal:stopped",
            &json!({ "terminal_id": "term-1", "exit_code": 0, "signal": null }),
        );

        assert!(broadcaster.replay_terminal_events("term-1", 0).is_empty());
    }

    #[test]
    fn terminal_replay_buffer_is_capped_by_payload_bytes() {
        let (broadcaster, _tx) = active_broadcaster();
        const REPLAY_PAYLOAD_BUDGET_BYTES: usize = 3 * 1024 * 1024;
        const CHUNK_BYTES: usize = 4096;
        let chunk = "x".repeat(CHUNK_BYTES);
        let event_count = (REPLAY_PAYLOAD_BUDGET_BYTES / CHUNK_BYTES) + 128;

        for _ in 0..event_count {
            broadcaster.broadcast(
                "terminal:output",
                &json!({ "terminal_id": "term-1", "data": chunk }),
            );
        }

        let replayed_payload_bytes: usize = broadcaster
            .replay_terminal_events("term-1", 0)
            .iter()
            .map(|(_, event)| {
                parse_event(event)["payload"]["data"]
                    .as_str()
                    .expect("terminal output data should be string")
                    .len()
            })
            .sum();

        assert!(
            replayed_payload_bytes <= REPLAY_PAYLOAD_BUDGET_BYTES,
            "terminal replay retained {replayed_payload_bytes} bytes, expected at most {REPLAY_PAYLOAD_BUDGET_BYTES}"
        );
    }
}
