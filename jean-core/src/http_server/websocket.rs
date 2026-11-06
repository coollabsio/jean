use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::sync::{broadcast, mpsc};

use super::dispatch::{dispatch_command_off_runtime, from_field, set_active_worktree_for_polling};
use super::{WsBroadcaster, WsEvent};
use crate::background_tasks::{BackgroundTaskManager, UiClient};

static NEXT_WS_CLIENT_ID: AtomicU64 = AtomicU64::new(1);

/// Commands that must preserve WebSocket receive order.
///
/// Terminal input is the critical case: xterm.js emits small `onData` chunks
/// that the browser forwards as independent `terminal_write` invokes. If each
/// invoke is spawned as an independent task, those tasks can race for the PTY
/// writer lock and reorder typed characters (e.g. `hello world` → `hewollo ld`).
fn command_must_run_in_ws_order(command: &str) -> bool {
    matches!(command, "terminal_write")
}

async fn dispatch_invoke_response(
    app: AppHandle,
    id: String,
    command: String,
    args: Value,
) -> InvokeResponse {
    invoke_response(id, dispatch_command_off_runtime(app, command, args).await)
}

fn invoke_response(id: String, result: Result<Value, String>) -> InvokeResponse {
    match result {
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
    }
}

fn spawn_dispatch_response(
    app: AppHandle,
    id: String,
    command: String,
    args: Value,
    tx: mpsc::UnboundedSender<String>,
) {
    tokio::spawn(async move {
        let resp = dispatch_invoke_response(app, id, command, args).await;
        if let Ok(json) = serde_json::to_string(&resp) {
            let _ = tx.send(json);
        }
    });
}

/// Spawn a command that must preserve WebSocket receive order.
///
/// Each task waits for the previous ordered task before dispatching, so
/// independent PTY writer lock acquisitions cannot reorder input chunks.
/// The connection select loop stays free for heartbeats and broadcast events
/// (unlike awaiting dispatch inline in the receive arm).
fn spawn_ordered_dispatch_response(
    app: AppHandle,
    id: String,
    command: String,
    args: Value,
    tx: mpsc::UnboundedSender<String>,
    previous: Option<tokio::task::JoinHandle<()>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Some(previous) = previous {
            // A cancelled/panicked predecessor must not drop subsequent ordered
            // input forever — continue the chain regardless of join outcome.
            let _ = previous.await;
        }
        let resp = dispatch_invoke_response(app, id, command, args).await;
        if let Ok(json) = serde_json::to_string(&resp) {
            let _ = tx.send(json);
        }
    })
}

/// Focus and the active worktree are tracked per connection, so they are
/// handled here where the connection id is known instead of in the generic
/// dispatch arm.
fn set_ws_client_focus(app: &AppHandle, client: UiClient, args: &Value) -> Result<Value, String> {
    let focused: bool = from_field(args, "focused")?;
    app.state::<BackgroundTaskManager>()
        .set_client_focus(client, focused);
    Ok(Value::Null)
}

/// Route a client invoke: ordered commands chain serially; everything else
/// dispatches independently so long-running work cannot block the WS loop.
fn dispatch_client_invoke(
    app: &AppHandle,
    ui_client: UiClient,
    id: String,
    command: String,
    args: Value,
    resp_tx: &mpsc::UnboundedSender<String>,
    ordered_tail: &mut Option<tokio::task::JoinHandle<()>>,
) {
    if command == "set_app_focus_state" {
        let resp = invoke_response(id, set_ws_client_focus(app, ui_client, &args));
        if let Ok(json) = serde_json::to_string(&resp) {
            let _ = resp_tx.send(json);
        }
    } else if command == "set_active_worktree_for_polling" {
        // Per connection like focus, but it reads projects data from disk, so
        // it runs on the blocking pool. Chained on the ordered tail so rapid
        // selections apply in order and disconnect cleanup runs after them.
        let app = app.clone();
        let resp_tx = resp_tx.clone();
        let previous = ordered_tail.take();
        *ordered_tail = Some(tokio::spawn(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            let result = tokio::task::spawn_blocking(move || {
                set_active_worktree_for_polling(&app, ui_client, &args)
            })
            .await
            .unwrap_or_else(|error| Err(format!("Command task failed: {error}")));
            if let Ok(json) = serde_json::to_string(&invoke_response(id, result)) {
                let _ = resp_tx.send(json);
            }
        }));
    } else if command_must_run_in_ws_order(&command) {
        *ordered_tail = Some(spawn_ordered_dispatch_response(
            app.clone(),
            id,
            command,
            args,
            resp_tx.clone(),
            ordered_tail.take(),
        ));
    } else {
        spawn_dispatch_response(app.clone(), id, command, args, resp_tx.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::command_must_run_in_ws_order;

    #[test]
    fn terminal_input_writes_run_in_websocket_order() {
        assert!(command_must_run_in_ws_order("terminal_write"));
        assert!(!command_must_run_in_ws_order("terminal_resize"));
        assert!(!command_must_run_in_ws_order("create_session"));
    }
}

/// Typed client message parsed from JSON with `"type"` tag.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum WsClientMessage {
    /// Standard command invocation: `{ type: "invoke", id, command, args }`.
    #[serde(rename = "invoke")]
    Invoke {
        id: String,
        command: String,
        #[serde(default)]
        args: Value,
    },
    /// Request buffered terminal events after a full page refresh.
    #[serde(rename = "terminal_replay")]
    TerminalReplay { terminal_id: String, last_seq: u64 },
}

/// Legacy invoke request without `type` field (backwards compat).
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

/// Handle a single WebSocket connection.
///
/// Architecture (optimised for multi-client streaming):
///
/// 1. **No event forwarder task** — the main select loop reads directly from
///    the broadcast channel, eliminating the intermediate mpsc hop.
///
/// 2. **Command dispatch is spawned** as separate tokio tasks so it never
///    blocks event delivery. Responses come back via an unbounded channel.
///    Order-sensitive commands (`terminal_write`) chain through
///    `spawn_ordered_dispatch_response` so receive order is preserved without
///    awaiting inline in the select loop.
///
/// 3. **Batched writes** — after receiving the first message, we drain
///    additional pending messages with `try_recv()` and write them all with
///    `SinkExt::feed()` before a single `SinkExt::flush()`.
///
/// 4. **Events are pre-serialized** (`Arc<str>`) in the broadcast channel,
///    so no per-client JSON work is needed here.
pub async fn handle_ws_connection(
    socket: WebSocket,
    app: AppHandle,
    mut event_rx: broadcast::Receiver<WsEvent>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let ui_client = UiClient::Ws(NEXT_WS_CLIENT_ID.fetch_add(1, Ordering::Relaxed));

    // Channel for command dispatch responses. Unbounded because command
    // responses are infrequent (user-initiated) and must never be dropped.
    let (resp_tx, mut resp_rx) = mpsc::unbounded_channel::<String>();

    // Tail of the per-connection ordered-command chain. Only `terminal_write`
    // (and any future `command_must_run_in_ws_order` entries) use this; other
    // commands still fan out independently.
    let mut ordered_dispatch_tail: Option<tokio::task::JoinHandle<()>> = None;

    // Heartbeat: server-driven protocol ping every PING_INTERVAL. If no
    // inbound traffic (pong, text, ping) for PONG_TIMEOUT, treat connection as
    // dead and break — the client reloads and performs a fresh bootstrap.
    //
    // Also send an app-level heartbeat text frame. Browser JS does not expose
    // protocol ping/pong frames to `WebSocket.onmessage`, so the frontend
    // liveness watchdog needs a normal message during otherwise-idle terminal
    // sessions. The heartbeat carries its interval so the client can drop a
    // silent socket (for example after a Wi-Fi to cellular switch) within a
    // few missed beats, while still tolerating older servers.
    const PING_INTERVAL: Duration = Duration::from_secs(5);
    const PONG_TIMEOUT: Duration = Duration::from_secs(45);
    let interval_ms = PING_INTERVAL.as_millis();
    let app_heartbeat_json = format!(r#"{{"type":"heartbeat","interval_ms":{interval_ms}}}"#);
    let mut ping_interval = tokio::time::interval(PING_INTERVAL);
    ping_interval.tick().await; // skip immediate fire
    let mut last_inbound = Instant::now();

    // Main loop — four event sources, never blocks on command dispatch.
    loop {
        tokio::select! {
            // ── Heartbeat tick ───────────────────────────────────────
            _ = ping_interval.tick() => {
                if last_inbound.elapsed() > PONG_TIMEOUT {
                    log::warn!("WS client idle > {PONG_TIMEOUT:?}, dropping connection");
                    break;
                }
                if ws_tx.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
                if ws_tx
                    .send(Message::Text(app_heartbeat_json.as_str().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }

            // ── Incoming command from client ──────────────────────────
            msg = ws_rx.next() => {
                last_inbound = Instant::now();
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<WsClientMessage>(&text) {
                            Ok(WsClientMessage::Invoke { id, command, args }) => {
                                dispatch_client_invoke(
                                    &app,
                                    ui_client,
                                    id,
                                    command,
                                    args,
                                    &resp_tx,
                                    &mut ordered_dispatch_tail,
                                );
                            }
                            Ok(WsClientMessage::TerminalReplay { terminal_id, last_seq }) => {
                                // Restore terminal output after a full page refresh.
                                // Batch feed+single flush (same coalescing as live
                                // event delivery) instead of one flush per event.
                                if let Some(broadcaster) = app.try_state::<WsBroadcaster>() {
                                    let events = broadcaster.replay_terminal_events(&terminal_id, last_seq);
                                    if feed_terminal_replay(&mut ws_tx, events).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(e) => {
                                // Try legacy format (no "type" field — old clients send bare invoke)
                                match serde_json::from_str::<InvokeRequest>(&text) {
                                    Ok(req) => {
                                        dispatch_client_invoke(
                                            &app,
                                            ui_client,
                                            req.id,
                                            req.command,
                                            req.args,
                                            &resp_tx,
                                            &mut ordered_dispatch_tail,
                                        );
                                    }
                                    Err(_) => {
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
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        if ws_tx.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {} // liveness already bumped above
                    _ => {} // Ignore binary
                }
            }

            // ── Command response from a spawned dispatch task ────────
            Some(json) = resp_rx.recv() => {
                // Feed this response then drain any other pending messages.
                if feed_and_drain(&mut ws_tx, &mut event_rx, &mut resp_rx, json).await.is_err() {
                    break;
                }
            }

            // ── Broadcast event (direct from broadcast channel) ──────
            result = event_rx.recv() => {
                match result {
                    Ok(first_event) => {
                        if feed_and_drain(&mut ws_tx, &mut event_rx, &mut resp_rx, first_event.json.to_string()).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("WS client lagged, skipped {n} events; requesting resync");
                        if ws_tx.send(Message::Text(RESYNC_EVENT_JSON.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    // Let a queued active-worktree update land before removing the client,
    // or it would re-add the closed connection's worktree.
    if let Some(tail) = ordered_dispatch_tail.take() {
        let _ = tail.await;
    }
    if let Some(manager) = app.try_state::<BackgroundTaskManager>() {
        manager.remove_client(ui_client);
    }
    log::trace!("WebSocket client disconnected");
}

/// Sent to a client that lagged behind the broadcast channel. Skipped events can
/// include chat:sending/chat:done, so the client must resync session state.
const RESYNC_EVENT_JSON: &str = r#"{"type":"event","event":"ws:resync","payload":{}}"#;

/// Maximum additional messages to drain after the first in a single flush cycle.
const DRAIN_MAX: usize = 32;

/// Feed the first message, then non-blocking drain up to `DRAIN_MAX` more
/// pending messages from both the broadcast and command response channels.
/// Finishes with a single `flush()` to coalesce into fewer syscalls.
async fn feed_and_drain(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event_rx: &mut broadcast::Receiver<WsEvent>,
    resp_rx: &mut mpsc::UnboundedReceiver<String>,
    first: String,
) -> Result<(), axum::Error> {
    ws_tx.feed(Message::Text(first.into())).await?;

    // Non-blocking drain: grab whatever is already pending.
    for _ in 0..DRAIN_MAX {
        // Try broadcast events first (high volume during streaming)
        match event_rx.try_recv() {
            Ok(ev) => {
                ws_tx
                    .feed(Message::Text(ev.json.to_string().into()))
                    .await?;
                continue;
            }
            Err(broadcast::error::TryRecvError::Lagged(n)) => {
                log::warn!("WS client lagged during drain, skipped {n} events; requesting resync");
                ws_tx.feed(Message::Text(RESYNC_EVENT_JSON.into())).await?;
                continue;
            }
            _ => {}
        }
        // Try command responses
        match resp_rx.try_recv() {
            Ok(json) => {
                ws_tx.feed(Message::Text(json.into())).await?;
                continue;
            }
            Err(_) => break, // Nothing pending — stop draining
        }
    }

    ws_tx.flush().await?;
    Ok(())
}

/// Batch-send pre-serialized terminal replay events with a single flush.
///
/// Full-refresh terminal replay can be thousands of `terminal:output` frames;
/// flushing once per frame multiplies syscalls. `Message::Text` still needs
/// an owned string (axum/tungstenite), so `Arc<str>::to_string()` is
/// unavoidable here — the win is write coalescing, not allocation avoidance.
async fn feed_terminal_replay(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    events: Vec<(u64, std::sync::Arc<str>)>,
) -> Result<(), axum::Error> {
    if events.is_empty() {
        return Ok(());
    }

    for (_seq, json) in events {
        ws_tx.feed(Message::Text(json.to_string().into())).await?;
    }
    ws_tx.flush().await?;
    Ok(())
}
