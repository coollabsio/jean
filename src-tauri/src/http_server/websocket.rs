use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::{broadcast, mpsc};

use super::dispatch::dispatch_command;
use super::WsEvent;

#[derive(Deserialize)]
struct InvokeRequest {
    id: String,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Serialize)]
struct InvokeResponse {
    #[serde(rename = "type")]
    msg_type: String,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Maximum events to batch into a single flush cycle.
const BATCH_MAX: usize = 16;

/// Maximum time to wait for additional events before flushing a partial batch.
const BATCH_WINDOW: Duration = Duration::from_millis(4);

/// Handle a single WebSocket connection.
///
/// Architecture (optimised for multi-client streaming):
///
/// 1. **No event forwarder task** — the main select loop reads directly from
///    the broadcast channel, eliminating the intermediate mpsc hop.
///
/// 2. **Command dispatch is spawned** as separate tokio tasks so it never
///    blocks event delivery.  Responses come back via an unbounded channel.
///
/// 3. **Batched writes** — after receiving the first event, we drain up to
///    `BATCH_MAX` more within `BATCH_WINDOW` and write them all with
///    `SinkExt::feed()` before a single `SinkExt::flush()`.  Tungstenite
///    benchmarks show this roughly doubles throughput vs per-message `send()`.
///
/// 4. **Events are pre-serialized** (`Arc<str>`) in the broadcast channel,
///    so no per-client JSON work is needed here.
pub async fn handle_ws_connection(
    socket: WebSocket,
    app: AppHandle,
    mut event_rx: broadcast::Receiver<WsEvent>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Channel for command dispatch responses.  Unbounded because command
    // responses are infrequent (user-initiated) and must never be dropped.
    let (resp_tx, mut resp_rx) = mpsc::unbounded_channel::<String>();

    // Main loop — three event sources, never blocks on command dispatch.
    loop {
        tokio::select! {
            // ── Incoming command from client ──────────────────────────
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<InvokeRequest>(&text) {
                            Ok(req) => {
                                // Spawn dispatch as a separate task so the
                                // select loop stays free to drain events.
                                let app_clone = app.clone();
                                let resp_tx = resp_tx.clone();
                                tokio::spawn(async move {
                                    let id = req.id.clone();
                                    let resp = match dispatch_command(
                                        &app_clone,
                                        &req.command,
                                        req.args,
                                    )
                                    .await
                                    {
                                        Ok(data) => InvokeResponse {
                                            msg_type: "response".to_string(),
                                            id,
                                            data: Some(data),
                                            error: None,
                                        },
                                        Err(err) => InvokeResponse {
                                            msg_type: "error".to_string(),
                                            id,
                                            data: None,
                                            error: Some(err),
                                        },
                                    };
                                    if let Ok(json) = serde_json::to_string(&resp) {
                                        let _ = resp_tx.send(json);
                                    }
                                });
                            }
                            Err(e) => {
                                let resp = InvokeResponse {
                                    msg_type: "error".to_string(),
                                    id: "unknown".to_string(),
                                    data: None,
                                    error: Some(format!("Invalid request: {e}")),
                                };
                                if let Ok(json) = serde_json::to_string(&resp) {
                                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        if ws_tx.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    _ => {} // Ignore binary, pong
                }
            }

            // ── Command response from a spawned dispatch task ────────
            Some(json) = resp_rx.recv() => {
                // Command responses are rare and important — send+flush immediately.
                if ws_tx.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }

            // ── Broadcast event (direct from broadcast channel) ──────
            result = event_rx.recv() => {
                match result {
                    Ok(first_event) => {
                        // Feed the first event without flushing.
                        if ws_tx.feed(Message::Text(
                            first_event.json.to_string().into(),
                        )).await.is_err() {
                            break;
                        }

                        // Batch drain: collect up to BATCH_MAX-1 more events
                        // within BATCH_WINDOW, feeding each without flushing.
                        let mut fed = 1usize;
                        let deadline = tokio::time::Instant::now() + BATCH_WINDOW;

                        while fed < BATCH_MAX {
                            tokio::select! {
                                result = event_rx.recv() => {
                                    match result {
                                        Ok(ev) => {
                                            if ws_tx.feed(Message::Text(
                                                ev.json.to_string().into(),
                                            )).await.is_err() {
                                                break;
                                            }
                                            fed += 1;
                                        }
                                        Err(broadcast::error::RecvError::Lagged(n)) => {
                                            log::warn!("WS client lagged, skipped {n} events");
                                        }
                                        Err(broadcast::error::RecvError::Closed) => break,
                                    }
                                }
                                _ = tokio::time::sleep_until(deadline) => {
                                    break; // Batch window expired
                                }
                            }
                        }

                        // Single flush for the entire batch — this is where
                        // the syscall happens.  feed() just buffers internally.
                        if ws_tx.flush().await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("WS client lagged, skipped {n} events");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    log::trace!("WebSocket client disconnected");
}
