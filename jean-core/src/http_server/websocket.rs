use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::sync::{broadcast, mpsc};

use super::dispatch::dispatch_command;
use super::{WsBroadcaster, WsEvent};

fn command_should_run_on_blocking_pool(command: &str) -> bool {
    matches!(
        command,
        "get_sessions"
            | "list_native_cli_sessions"
            | "create_commit_with_ai"
            | "create_pr_with_ai_content"
            | "run_review_with_ai"
            | "generate_release_notes"
            | "execute_summarization"
            | "install_claude_cli"
            | "install_codex_cli"
            | "install_opencode_cli"
            | "install_pi_cli"
            | "install_grok_cli"
            | "update_grok_cli"
            | "install_gh_cli"
            | "install_coderabbit_cli"
            | "update_coderabbit_cli"
            | "run_coderabbit_review"
            | "trigger_coderabbit_pr_review"
    )
}

async fn dispatch_invoke_response(
    app: AppHandle,
    id: String,
    command: String,
    args: Value,
) -> InvokeResponse {
    match dispatch_command(&app, &command, args).await {
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
    if command_should_run_on_blocking_pool(&command) {
        // These commands perform synchronous git/CLI/process work under an
        // async dispatch signature. Running them on the core runtime can starve
        // the WebSocket loop in web/mobile access, making unrelated actions
        // (for example creating a new session) appear stuck until the command
        // finishes.
        tokio::task::spawn_blocking(move || {
            let resp =
                tauri::async_runtime::block_on(dispatch_invoke_response(app, id, command, args));
            if let Ok(json) = serde_json::to_string(&resp) {
                let _ = tx.send(json);
            }
        });
        return;
    }

    tokio::spawn(async move {
        let resp = dispatch_invoke_response(app, id, command, args).await;
        if let Ok(json) = serde_json::to_string(&resp) {
            let _ = tx.send(json);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::command_should_run_on_blocking_pool;

    #[test]
    fn commit_generation_runs_on_blocking_pool() {
        assert!(command_should_run_on_blocking_pool("create_commit_with_ai"));
    }

    #[test]
    fn session_history_loading_runs_on_blocking_pool() {
        assert!(command_should_run_on_blocking_pool("get_sessions"));
        assert!(command_should_run_on_blocking_pool(
            "list_native_cli_sessions"
        ));
    }

    #[test]
    fn lightweight_session_creation_stays_on_async_runtime() {
        assert!(!command_should_run_on_blocking_pool("create_session"));
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

    // Channel for command dispatch responses. Unbounded because command
    // responses are infrequent (user-initiated) and must never be dropped.
    let (resp_tx, mut resp_rx) = mpsc::unbounded_channel::<String>();

    // Heartbeat: server-driven protocol ping every PING_INTERVAL. If no
    // inbound traffic (pong, text, ping) for PONG_TIMEOUT, treat connection as
    // dead and break — the client reloads and performs a fresh bootstrap.
    //
    // Also send an app-level heartbeat text frame. Browser JS does not expose
    // protocol ping/pong frames to `WebSocket.onmessage`, so the frontend
    // liveness watchdog needs a normal message during otherwise-idle terminal
    // sessions. Without this, web access reloads every ~50s of no app events.
    const PING_INTERVAL: Duration = Duration::from_secs(20);
    const PONG_TIMEOUT: Duration = Duration::from_secs(45);
    const APP_HEARTBEAT_JSON: &str = r#"{"type":"heartbeat"}"#;
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
                    .send(Message::Text(APP_HEARTBEAT_JSON.into()))
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
                                // Spawn dispatch as a separate task so the
                                // select loop stays free to drain events.
                                spawn_dispatch_response(
                                    app.clone(),
                                    id,
                                    command,
                                    args,
                                    resp_tx.clone(),
                                );
                            }
                            Ok(WsClientMessage::TerminalReplay { terminal_id, last_seq }) => {
                                // Restore terminal output after a full page refresh.
                                if let Some(broadcaster) = app.try_state::<WsBroadcaster>() {
                                    let events = broadcaster.replay_terminal_events(&terminal_id, last_seq);
                                    for (_seq, json) in events {
                                        if ws_tx.send(Message::Text(json.to_string().into())).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                // Try legacy format (no "type" field — old clients send bare invoke)
                                match serde_json::from_str::<InvokeRequest>(&text) {
                                    Ok(req) => {
                                        spawn_dispatch_response(
                                            app.clone(),
                                            req.id,
                                            req.command,
                                            req.args,
                                            resp_tx.clone(),
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
                        log::warn!("WS client lagged, skipped {n} events");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    log::trace!("WebSocket client disconnected");
}

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
                log::warn!("WS client lagged during drain, skipped {n} events");
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
