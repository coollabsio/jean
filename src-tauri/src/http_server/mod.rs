pub mod auth;
pub mod dispatch;
pub mod server;
pub mod websocket;

use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast;

/// Broadcast channel for sending events to all connected WebSocket clients.
/// Managed as Tauri state so any code with an AppHandle can broadcast.
pub struct WsBroadcaster {
    tx: broadcast::Sender<WsEvent>,
}

/// A pre-serialized WebSocket event.
/// The JSON string is wrapped in `Arc<str>` so cloning across N broadcast
/// receivers is a cheap reference-count increment instead of N allocations.
#[derive(Clone, Debug)]
pub struct WsEvent {
    pub json: Arc<str>,
}

/// Wire-format envelope serialized once in `broadcast()`.
#[derive(Serialize)]
struct WsEnvelope<'a, S: Serialize> {
    #[serde(rename = "type")]
    msg_type: &'static str,
    event: &'a str,
    payload: &'a S,
}

impl WsBroadcaster {
    pub fn new() -> (Self, broadcast::Sender<WsEvent>) {
        // Buffer 8192 events — generous headroom for burst streaming with
        // multiple clients. Each WsEvent is ~16 bytes (Arc pointer + len).
        let (tx, _) = broadcast::channel(8192);
        let tx_clone = tx.clone();
        (Self { tx }, tx_clone)
    }

    /// Serialize the payload once into the wire-format JSON envelope.
    /// Each broadcast receiver gets an `Arc<str>` clone (cheap ref-count
    /// increment) instead of re-serializing per client.
    pub fn broadcast<S: Serialize>(&self, event: &str, payload: &S) {
        let envelope = WsEnvelope {
            msg_type: "event",
            event,
            payload,
        };
        let json = match serde_json::to_string(&envelope) {
            Ok(s) => s,
            Err(e) => {
                log::error!("Failed to serialize WS event '{event}': {e}");
                return;
            }
        };
        // Ignore send errors (no active receivers is fine)
        let _ = self.tx.send(WsEvent {
            json: Arc::from(json),
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WsEvent> {
        self.tx.subscribe()
    }
}

/// Extension trait on AppHandle that sends to both Tauri IPC and WebSocket clients.
/// Use `app.emit_all("event", &payload)` instead of `app.emit("event", &payload)`.
pub trait EmitExt {
    fn emit_all<S: Serialize + Clone>(&self, event: &str, payload: &S) -> Result<(), String>;
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
}
