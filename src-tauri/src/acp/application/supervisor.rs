//! SDK-driven supervisor for ACP adapter processes.
//!
//! One [`Provider`] = one long-lived adapter subprocess driven by the
//! `agent-client-protocol` SDK. Multiple ACP sessions multiplex over the
//! same process, keyed by `sessionId`.
//!
//! Architecture:
//!   - `connect_with` runs the protocol loop in a background task and parks
//!     on a `driver_loop` future that receives [`DriverCmd`] messages from
//!     callers via an mpsc channel.
//!   - Each Tauri command (`acp_*`) sends a typed `DriverCmd` and awaits
//!     the response on a oneshot channel embedded in the command.
//!   - `on_receive_notification` (session updates) and `on_receive_request`
//!     (permission requests) are handled by closures registered on the
//!     builder. Notifications append to the per-session JSONL log and
//!     broadcast as `acp:event` to the frontend; permission requests are
//!     bridged to the UI and resolved asynchronously.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use agent_client_protocol::schema::{
    AgentCapabilities, CancelNotification, ClientCapabilities, ContentBlock,
    FileSystemCapabilities, ImageContent, Implementation, InitializeRequest, LoadSessionRequest,
    LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse,
    ProtocolVersion, ReadTextFileRequest, RequestPermissionRequest, ResumeSessionRequest,
    ResumeSessionResponse, SessionConfigId, SessionConfigValueId, SessionId, SessionModeId,
    SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse,
    SetSessionModeRequest, SetSessionModeResponse, SetSessionModelRequest, SetSessionModelResponse,
    TextContent, WriteTextFileRequest,
};
use agent_client_protocol::{Agent, Client, ConnectionTo};
use agent_client_protocol_tokio::AcpAgent;
use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot, watch, Mutex, RwLock};

use crate::acp::api::client_handlers;
use crate::acp::application::session_state;
use crate::acp::domain::session::SessionInfoState;
use crate::acp::infrastructure::session_log::{Direction, SessionLog};
use crate::acp::provider::AcpProvider;

/// One provider entry — `tx` is the only handle the rest of the app holds.
/// `capabilities` is populated once (after the SDK's `initialize` handshake
/// resolves) and stable for the lifetime of the supervisor.
struct Provider {
    tx: mpsc::Sender<DriverCmd>,
    capabilities: Arc<OnceLock<AgentCapabilities>>,
    /// Readiness signal for the `initialize` handshake. Driven from inside
    /// the supervisor's `connect_with` callback. `get_or_spawn` awaits a
    /// non-`Pending` state on this receiver before handing the provider to
    /// callers — see the comment on `get_or_spawn` for the race this
    /// closes. Multi-consumer (concurrent commands during cold start all
    /// observe the same transition).
    init_rx: watch::Receiver<InitState>,
}

/// Lifecycle of the per-provider `initialize` handshake. `Pending` until the
/// connect callback either succeeds (`Ready`) or fails (`Failed`). Wrapped
/// in a `tokio::sync::watch` channel so we can `wait_for(|s| !pending)`
/// from many concurrent callers without lost-wakeup races.
#[derive(Clone, Debug)]
enum InitState {
    Pending,
    Ready,
    Failed(String),
}

/// Outbound commands sent from Tauri command handlers into the driver loop.
enum DriverCmd {
    NewSession {
        cwd: PathBuf,
        reply: oneshot::Sender<Result<NewSessionResponse, String>>,
    },
    /// Resume an existing ACP session by id. The agent restores its
    /// in-memory context for that session without replaying the
    /// transcript — that's the whole reason we prefer `session/resume`
    /// over `session/load`. Caller must verify the agent advertises
    /// `sessionCapabilities.resume` first via [`session_resume_supported`].
    ResumeSession {
        session_id: SessionId,
        cwd: PathBuf,
        reply: oneshot::Sender<Result<ResumeSessionResponse, String>>,
    },
    /// Load an existing ACP session by id. This is the stable fallback when
    /// the agent does not advertise `sessionCapabilities.resume`.
    LoadSession {
        session_id: SessionId,
        cwd: PathBuf,
        reply: oneshot::Sender<Result<LoadSessionResponse, String>>,
    },
    Prompt {
        session_id: SessionId,
        text: String,
        /// Base64-encoded image data + MIME type pairs. Empty for text-only
        /// prompts. Agents MUST advertise `prompt_capabilities.image` for any
        /// of these to be included — callers enforce the gate.
        images: Vec<(String, String)>,
        /// Pre-expanded `@file` mentions as ACP content blocks (either
        /// `Resource` for inline embeds or `ResourceLink` as the universal
        /// fallback). Resolution + capability gating happens in the caller
        /// — this layer just splices them onto the prompt array.
        mentions: Vec<ContentBlock>,
        reply: oneshot::Sender<Result<PromptResponse, String>>,
    },
    Cancel {
        session_id: SessionId,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetModel {
        session_id: SessionId,
        model_id: String,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    SetMode {
        session_id: SessionId,
        mode_id: String,
        reply: oneshot::Sender<Result<Value, String>>,
    },
    /// Set a generic ACP `configOption`. Surfaced today for thought
    /// level, but the wire mechanism (`session/set_config_option`) is
    /// generic — `config_id` selects which option, `value_id` is the
    /// new selection. Mirrors `SetMode` in shape so callers can use the
    /// exact same request/response pattern.
    SetConfigOption {
        session_id: SessionId,
        config_id: String,
        value_id: String,
        reply: oneshot::Sender<Result<Value, String>>,
    },
}

/// Global registry of provider supervisors keyed by [`AcpProvider`].
static REGISTRY: Lazy<RwLock<HashMap<AcpProvider, Arc<Provider>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
static SESSION_RPC_TXNS: Lazy<RwLock<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

fn provider_agent(provider: AcpProvider) -> Result<AcpAgent, String> {
    AcpAgent::from_args(provider.adapter_argv().iter().copied())
        .map_err(|e| format!("failed to build {provider} AcpAgent: {e}"))
}

/// Capabilities we advertise to the agent in `initialize`. Currently:
///   - `fs.readTextFile` / `fs.writeTextFile` — handled in
///     `client_handlers::fs`.
/// Terminal stays off until we wire `client_handlers::terminal`. Per
/// spec, an unset capability is treated as unsupported and the agent
/// MUST NOT call the corresponding methods, so it's safe to flip them
/// on incrementally as handlers land.
fn client_capabilities() -> ClientCapabilities {
    ClientCapabilities::new().fs(FileSystemCapabilities::default()
        .read_text_file(true)
        .write_text_file(true))
}

/// Get-or-spawn the supervisor for `provider`. Idempotent; subsequent
/// calls return the existing channel sender.
///
/// **Initialization gate**: the `initialize` JSON-RPC handshake runs once
/// per agent process, inside the SDK's `connect_with` callback (see
/// `run_supervisor`). It establishes `agentCapabilities` (`loadSession`,
/// `sessionCapabilities.{resume, fork, …}`) — values that callers like
/// `session_resume_supported` need to read *before* deciding which
/// `session/*` RPC to send. The handshake takes several seconds against
/// real adapters (~5–10 s for claude-agent-acp on cold start).
///
/// Without a gate, any command racing the cold start would observe an
/// empty capability cell and silently behave as if the agent didn't
/// support the feature (e.g. resume → "does not advertise
/// sessionCapabilities.resume", refusing to restore prior context). To
/// avoid that, we await `init_rx.wait_for(|s| !Pending)` here so every
/// caller sees a fully-initialized provider — including the very first
/// one after app open. After init, the watch is `Ready` and the wait is
/// a no-op for every subsequent call. If initialize *failed* we
/// propagate the error up to the caller instead of returning a half-dead
/// provider.
async fn get_or_spawn(app: &AppHandle, provider: AcpProvider) -> Result<Arc<Provider>, String> {
    if let Some(p) = REGISTRY.read().await.get(&provider).cloned() {
        return wait_for_init(p).await;
    }
    let mut guard = REGISTRY.write().await;
    if let Some(p) = guard.get(&provider).cloned() {
        drop(guard);
        return wait_for_init(p).await;
    }

    let agent = provider_agent(provider)?;
    let (tx, rx) = mpsc::channel::<DriverCmd>(64);
    let capabilities = Arc::new(OnceLock::new());
    let (init_tx, init_rx) = watch::channel(InitState::Pending);
    let provider_entry = Arc::new(Provider {
        tx: tx.clone(),
        capabilities: capabilities.clone(),
        init_rx: init_rx.clone(),
    });
    guard.insert(provider, provider_entry.clone());
    drop(guard);

    let app_for_task = app.clone();
    // Clone the init sender so the post-supervisor cleanup can flip the
    // state to `Failed` if the supervisor exits before the connect
    // callback ever signaled (e.g. transport dies during the JSON-RPC
    // handshake). Without this, awaiters would hang on `wait_for`.
    let init_tx_for_fail = init_tx.clone();
    tokio::spawn(async move {
        let result = run_supervisor(app_for_task, provider, agent, rx, capabilities, init_tx).await;
        if let Err(e) = &result {
            log::error!("[acp] supervisor for {provider} exited: {e}");
        }
        // Only downgrade if we never reached `Ready` — a clean exit AFTER
        // a successful initialize is just normal shutdown, not an init
        // failure, and shouldn't poison the state for future spawns.
        init_tx_for_fail.send_if_modified(|s| {
            if matches!(s, InitState::Pending) {
                let msg = result.as_ref().err().cloned().unwrap_or_else(|| {
                    format!("supervisor for {provider} exited before initialize")
                });
                *s = InitState::Failed(msg);
                true
            } else {
                false
            }
        });
        REGISTRY.write().await.remove(&provider);
        log::info!("[acp] provider {provider} unregistered");
    });

    wait_for_init(provider_entry).await
}

/// Block until the provider's `initialize` handshake has resolved.
/// Returns the provider on success, or the captured init error string
/// on failure (so the caller surfaces a real reason instead of hanging
/// or silently misbehaving).
async fn wait_for_init(p: Arc<Provider>) -> Result<Arc<Provider>, String> {
    let mut rx = p.init_rx.clone();
    // `wait_for` returns the borrow once the predicate matches. Tokio
    // wakes us deterministically when the sender flips the state, so
    // there's no Notify-style lost-wakeup window here.
    let state = rx
        .wait_for(|s| !matches!(s, InitState::Pending))
        .await
        .map_err(|_| "acp supervisor init signal dropped before completion".to_string())?
        .clone();
    match state {
        InitState::Ready => Ok(p),
        InitState::Failed(e) => Err(e),
        InitState::Pending => unreachable!("wait_for predicate excludes Pending"),
    }
}

async fn run_supervisor(
    app: AppHandle,
    provider: AcpProvider,
    agent: AcpAgent,
    rx: mpsc::Receiver<DriverCmd>,
    capabilities: Arc<OnceLock<AgentCapabilities>>,
    init_tx: watch::Sender<InitState>,
) -> Result<(), String> {
    let app_for_notif = app.clone();
    let app_for_perm = app.clone();
    let app_for_fs_read = app.clone();
    let app_for_fs_write = app.clone();

    Client
        .builder()
        .name("jean-acp-labs")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                handle_session_notification(&app_for_notif, provider, notification).await;
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let response =
                    client_handlers::permission::handle(&app_for_perm, provider, request)
                        .await;
                responder.respond(response)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ReadTextFileRequest, responder, _cx| {
                match client_handlers::fs::handle_read(&app_for_fs_read, provider, request)
                    .await
                {
                    Ok(resp) => responder.respond(resp),
                    Err(e) => responder.respond_with_error(e),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WriteTextFileRequest, responder, _cx| {
                match client_handlers::fs::handle_write(&app_for_fs_write, provider, request)
                    .await
                {
                    Ok(resp) => responder.respond(resp),
                    Err(e) => responder.respond_with_error(e),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            log::info!("[acp] connected to {provider}, initializing");
            // The initialize handshake establishes per-process capabilities;
            // every later session/* RPC depends on its result. Signal
            // Ready/Failed on the watch channel so `get_or_spawn` callers
            // gated on `wait_for_init` can resume (or surface the error).
            let init = match connection
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1)
                        .client_capabilities(client_capabilities())
                        .client_info(
                            Implementation::new("jean", env!("CARGO_PKG_VERSION"))
                                .title("Jean"),
                        ),
                )
                .block_task()
                .await
            {
                Ok(init) => init,
                Err(e) => {
                    let msg = format!("initialize: {e}");
                    let _ = init_tx.send(InitState::Failed(msg.clone()));
                    return Err(e);
                }
            };
            log::info!(
                "[acp] {provider} initialized: agent={:?}, load_session={}, session_resume={}, prompt_image={}, prompt_embedded_context={}",
                init.agent_info,
                init.agent_capabilities.load_session,
                init.agent_capabilities
                    .session_capabilities
                    .resume
                    .is_some(),
                init.agent_capabilities.prompt_capabilities.image,
                init.agent_capabilities.prompt_capabilities.embedded_context,
            );
            // Capture for the lifetime of the supervisor so callers can ask
            // "do you support session/resume?" before issuing the request.
            let _ = capabilities.set(init.agent_capabilities.clone());
            // Order matters: populate `capabilities` BEFORE flipping the
            // gate so any waiter that wakes up immediately and reads the
            // OnceLock sees the value.
            let _ = init_tx.send(InitState::Ready);

            driver_loop(connection, rx).await;
            Ok(())
        })
        .await
        .map_err(|e| format!("acp supervisor: {e}"))
}

async fn driver_loop(cx: ConnectionTo<Agent>, mut rx: mpsc::Receiver<DriverCmd>) {
    // Each command runs in its own task so a slow `Prompt` (which blocks
    // for the entire turn) doesn't starve every other command — including
    // `Cancel`, which is the whole reason cancellation needs to be able
    // to race a prompt. `ConnectionTo` is cheap to clone (it's an
    // `Arc`-backed handle) and the JSON-RPC layer demultiplexes
    // concurrent in-flight requests by id, so this is exactly the
    // pattern the SDK is designed for.
    while let Some(cmd) = rx.recv().await {
        let cx = cx.clone();
        tokio::spawn(handle_cmd(cx, cmd));
    }
    log::info!("[acp] driver_loop exiting (channel closed)");
}

async fn handle_cmd(cx: ConnectionTo<Agent>, cmd: DriverCmd) {
    let txn = session_rpc_txn(&cmd).await;
    let _txn = if requires_session_serialization(&cmd) {
        Some(txn.lock().await)
    } else {
        None
    };
    match cmd {
        DriverCmd::NewSession { cwd, reply } => {
            let result = cx
                .send_request(NewSessionRequest::new(cwd))
                .block_task()
                .await
                .map_err(|e| format!("session/new: {e}"));
            let _ = reply.send(result);
        }
        DriverCmd::ResumeSession {
            session_id,
            cwd,
            reply,
        } => {
            let acp_id = session_id.0.as_ref().to_string();
            log_to_session(
                &acp_id,
                Direction::ClientToAgent,
                &serde_json::json!({
                    "method": "session/resume",
                    "params": { "sessionId": acp_id, "cwd": cwd },
                }),
            )
            .await;
            let result = cx
                .send_request(ResumeSessionRequest::new(session_id, cwd))
                .block_task()
                .await
                .map_err(|e| format!("session/resume: {e}"));
            let result_value = result
                .as_ref()
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null));
            log_response(
                &acp_id,
                "session/resume",
                match &result_value {
                    Ok(v) => Ok(v),
                    Err(e) => Err(e.as_str()),
                },
            )
            .await;
            let _ = reply.send(result);
        }
        DriverCmd::LoadSession {
            session_id,
            cwd,
            reply,
        } => {
            let acp_id = session_id.0.as_ref().to_string();
            log_to_session(
                &acp_id,
                Direction::ClientToAgent,
                &serde_json::json!({
                    "method": "session/load",
                    "params": { "sessionId": acp_id, "cwd": cwd },
                }),
            )
            .await;
            let result = cx
                .send_request(LoadSessionRequest::new(session_id, cwd))
                .block_task()
                .await
                .map_err(|e| format!("session/load: {e}"));
            let result_value = result
                .as_ref()
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null));
            log_response(
                &acp_id,
                "session/load",
                match &result_value {
                    Ok(v) => Ok(v),
                    Err(e) => Err(e.as_str()),
                },
            )
            .await;
            let _ = reply.send(result);
        }
        DriverCmd::Prompt {
            session_id,
            text,
            images,
            mentions,
            reply,
        } => {
            let acp_id = session_id.0.as_ref().to_string();
            let mut blocks = vec![ContentBlock::Text(TextContent::new(text.clone()))];
            for (data, mime_type) in &images {
                blocks.push(ContentBlock::Image(ImageContent::new(
                    data.clone(),
                    mime_type.clone(),
                )));
            }
            for block in &mentions {
                blocks.push(block.clone());
            }
            let req = PromptRequest::new(session_id.clone(), blocks);
            // Log text + image metadata (full base64 included so replay can
            // reconstruct the user turn without any external file reference).
            // Mentions are logged as full content blocks so replay also captures
            // the embed body — keeps the events.jsonl self-contained.
            log_to_session(
                &acp_id,
                Direction::ClientToAgent,
                &serde_json::json!({
                    "method": "session/prompt",
                    "params": {
                        "sessionId": &acp_id,
                        "text": text,
                        "images": images.iter().map(|(data, mime_type)| {
                            serde_json::json!({ "data": data, "mimeType": mime_type })
                        }).collect::<Vec<_>>(),
                        "mentions": mentions,
                    },
                }),
            )
            .await;
            let result = cx
                .send_request(req)
                .block_task()
                .await
                .map_err(|e| format!("session/prompt: {e}"));
            let result_value = result
                .as_ref()
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null));
            log_response(
                &acp_id,
                "session/prompt",
                match &result_value {
                    Ok(v) => Ok(v),
                    Err(e) => Err(e.as_str()),
                },
            )
            .await;
            let _ = reply.send(result);
        }
        DriverCmd::Cancel { session_id, reply } => {
            let acp_id = session_id.0.as_ref().to_string();
            log_to_session(
                &acp_id,
                Direction::ClientToAgent,
                &serde_json::json!({
                    "method": "session/cancel",
                    "params": { "sessionId": &acp_id },
                }),
            )
            .await;
            let result = cx
                .send_notification(CancelNotification::new(session_id))
                .map(|_| ())
                .map_err(|e| format!("session/cancel: {e}"));
            let _ = reply.send(result);
        }
        DriverCmd::SetModel {
            session_id,
            model_id,
            reply,
        } => {
            let acp_id = session_id.0.as_ref().to_string();
            log_to_session(
                &acp_id,
                Direction::ClientToAgent,
                &serde_json::json!({
                    "method": "session/set_model",
                    "params": { "sessionId": &acp_id, "modelId": &model_id },
                }),
            )
            .await;
            let result = set_model_via_sdk(&cx, session_id, model_id).await;
            log_response(
                &acp_id,
                "session/set_model",
                match &result {
                    Ok(v) => Ok(v),
                    Err(e) => Err(e.as_str()),
                },
            )
            .await;
            let _ = reply.send(result);
        }
        DriverCmd::SetMode {
            session_id,
            mode_id,
            reply,
        } => {
            let acp_id = session_id.0.as_ref().to_string();
            log_to_session(
                &acp_id,
                Direction::ClientToAgent,
                &serde_json::json!({
                    "method": "session/set_mode",
                    "params": { "sessionId": &acp_id, "modeId": &mode_id },
                }),
            )
            .await;
            let result = set_mode_via_sdk(&cx, session_id, mode_id).await;
            log_response(
                &acp_id,
                "session/set_mode",
                match &result {
                    Ok(v) => Ok(v),
                    Err(e) => Err(e.as_str()),
                },
            )
            .await;
            let _ = reply.send(result);
        }
        DriverCmd::SetConfigOption {
            session_id,
            config_id,
            value_id,
            reply,
        } => {
            let acp_id = session_id.0.as_ref().to_string();
            log_to_session(
                &acp_id,
                Direction::ClientToAgent,
                &serde_json::json!({
                    "method": "session/set_config_option",
                    "params": {
                        "sessionId": &acp_id,
                        "configId": &config_id,
                        "value": &value_id,
                    },
                }),
            )
            .await;
            let result = set_config_option_via_sdk(&cx, session_id, config_id, value_id).await;
            log_response(
                &acp_id,
                "session/set_config_option",
                match &result {
                    Ok(v) => Ok(v),
                    Err(e) => Err(e.as_str()),
                },
            )
            .await;
            let _ = reply.send(result);
        }
    }
}

fn requires_session_serialization(cmd: &DriverCmd) -> bool {
    matches!(
        cmd,
        DriverCmd::ResumeSession { .. }
            | DriverCmd::LoadSession { .. }
            | DriverCmd::Prompt { .. }
            | DriverCmd::SetModel { .. }
            | DriverCmd::SetMode { .. }
            | DriverCmd::SetConfigOption { .. }
    )
}

async fn session_rpc_txn(cmd: &DriverCmd) -> Arc<Mutex<()>> {
    let session_id = match cmd {
        DriverCmd::ResumeSession { session_id, .. }
        | DriverCmd::LoadSession { session_id, .. }
        | DriverCmd::Prompt { session_id, .. }
        | DriverCmd::Cancel { session_id, .. }
        | DriverCmd::SetModel { session_id, .. }
        | DriverCmd::SetMode { session_id, .. }
        | DriverCmd::SetConfigOption { session_id, .. } => session_id.0.as_ref().to_string(),
        DriverCmd::NewSession { .. } => return Arc::new(Mutex::new(())),
    };

    if let Some(txn) = SESSION_RPC_TXNS.read().await.get(&session_id).cloned() {
        return txn;
    }
    let mut txns = SESSION_RPC_TXNS.write().await;
    txns.entry(session_id)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Append a frame to the log registered for `acp_session_id`, if one exists.
/// No-op when the session has no log (e.g. a request fires before the
/// session is registered, or for short-circuited error paths).
pub(crate) async fn log_to_session(acp_session_id: &str, direction: Direction, frame: &Value) {
    session_state::log_to_session(acp_session_id, direction, frame).await;
}

/// Look up the stable jean session id for an ACP session id, if its log
/// is registered. Used by client-side request handlers (e.g. permission)
/// to stamp Tauri event payloads with a frontend-routable id.
pub(crate) async fn lookup_jean_session_id(acp_session_id: &str) -> Option<String> {
    session_state::lookup_jean_session_id(acp_session_id).await
}

/// Stamp a `result` or `error` frame against `method`. Frame shape is
/// `{ "method": ..., "result": ... }` on success and
/// `{ "method": ..., "error": "<message>" }` on failure — ids are not
/// included since the JSONL already preserves request/response order.
async fn log_response(acp_session_id: &str, method: &str, result: Result<&Value, &str>) {
    let frame = match result {
        Ok(v) => serde_json::json!({ "method": method, "result": v }),
        Err(e) => serde_json::json!({ "method": method, "error": e }),
    };
    log_to_session(acp_session_id, Direction::AgentToClient, &frame).await;
}

async fn set_model_via_sdk(
    cx: &ConnectionTo<Agent>,
    session_id: SessionId,
    model_id: String,
) -> Result<Value, String> {
    let resp: SetSessionModelResponse = cx
        .send_request(SetSessionModelRequest::new(session_id, model_id))
        .block_task()
        .await
        .map_err(|e| format!("session/set_model: {e}"))?;
    serde_json::to_value(resp).map_err(|e| format!("encode set_model response: {e}"))
}

async fn set_mode_via_sdk(
    cx: &ConnectionTo<Agent>,
    session_id: SessionId,
    mode_id: String,
) -> Result<Value, String> {
    let resp: SetSessionModeResponse = cx
        .send_request(SetSessionModeRequest::new(
            session_id,
            SessionModeId::from(mode_id),
        ))
        .block_task()
        .await
        .map_err(|e| format!("session/set_mode: {e}"))?;
    serde_json::to_value(resp).map_err(|e| format!("encode set_mode response: {e}"))
}

async fn set_config_option_via_sdk(
    cx: &ConnectionTo<Agent>,
    session_id: SessionId,
    config_id: String,
    value_id: String,
) -> Result<Value, String> {
    let resp: SetSessionConfigOptionResponse = cx
        .send_request(SetSessionConfigOptionRequest::new(
            session_id,
            SessionConfigId::from(config_id),
            SessionConfigValueId::from(value_id),
        ))
        .block_task()
        .await
        .map_err(|e| format!("session/set_config_option: {e}"))?;
    serde_json::to_value(resp).map_err(|e| format!("encode set_config_option response: {e}"))
}

async fn handle_session_notification(
    app: &AppHandle,
    provider: AcpProvider,
    notification: SessionNotification,
) {
    let sid = notification.session_id.0.as_ref().to_string();
    // Best-effort: if a frame can't be serialized, log it and bail rather
    // than panicking the supervisor.
    let frame = match serde_json::to_value(&notification) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[acp:{provider}] failed to serialize SessionNotification: {e}");
            return;
        }
    };
    session_state::handle_session_notification(app, provider, sid, frame).await;
}

// ---------------------------------------------------------------------------
// Public API used by `commands.rs`
// ---------------------------------------------------------------------------

/// Spawn (or reuse) the provider, then issue `session/new` for `cwd`.
///
/// `cwd` MUST be absolute — the ACP spec requires it. Callers are expected
/// to validate at their own boundary (see `commands::acp_create_session`);
/// this assert catches any future caller that forgets.
pub async fn create_session(
    app: &AppHandle,
    provider: AcpProvider,
    cwd: PathBuf,
) -> Result<NewSessionResponse, String> {
    debug_assert!(
        cwd.is_absolute(),
        "ACP session/new cwd must be absolute; got {cwd:?}"
    );
    let p = get_or_spawn(app, provider).await?;
    let (tx, rx) = oneshot::channel();
    p.tx.send(DriverCmd::NewSession { cwd, reply: tx })
        .await
        .map_err(|e| format!("provider channel closed: {e}"))?;
    rx.await
        .map_err(|e| format!("provider dropped reply: {e}"))?
}

/// Spawn (or reuse) the provider, then issue `session/resume` for an
/// existing `acp_session_id`. Returns the typed response (carrying
/// `models`, `modes`, `config_options`) on success. Unlike
/// `session/load`, this does NOT cause the agent to replay the
/// transcript — the on-disk JSONL stays authoritative for the UI.
///
/// Caller MUST first verify the agent advertises `sessionCapabilities.resume`
/// via [`session_resume_supported`].
pub async fn resume_session(
    app: &AppHandle,
    provider: AcpProvider,
    acp_session_id: String,
    cwd: PathBuf,
) -> Result<ResumeSessionResponse, String> {
    debug_assert!(
        cwd.is_absolute(),
        "ACP session/resume cwd must be absolute; got {cwd:?}"
    );
    let p = get_or_spawn(app, provider).await?;
    let (tx, rx) = oneshot::channel();
    p.tx.send(DriverCmd::ResumeSession {
        session_id: SessionId::new(acp_session_id.clone()),
        cwd,
        reply: tx,
    })
    .await
    .map_err(|e| format!("provider channel closed: {e}"))?;
    rx.await
        .map_err(|e| format!("provider dropped reply: {e}"))?
}

/// Spawn (or reuse) the provider, then issue `session/load` for an existing
/// `acp_session_id`. This is the stable fallback when the agent does not
/// advertise `sessionCapabilities.resume` but does advertise `loadSession`.
pub async fn load_session(
    app: &AppHandle,
    provider: AcpProvider,
    acp_session_id: String,
    cwd: PathBuf,
) -> Result<LoadSessionResponse, String> {
    debug_assert!(
        cwd.is_absolute(),
        "ACP session/load cwd must be absolute; got {cwd:?}"
    );
    let p = get_or_spawn(app, provider).await?;
    let (tx, rx) = oneshot::channel();
    p.tx.send(DriverCmd::LoadSession {
        session_id: SessionId::new(acp_session_id.clone()),
        cwd,
        reply: tx,
    })
    .await
    .map_err(|e| format!("provider channel closed: {e}"))?;
    rx.await
        .map_err(|e| format!("provider dropped reply: {e}"))?
}

/// `true` if the provider's `initialize` handshake reported
/// `agent_capabilities.session_capabilities.resume`. `get_or_spawn`
/// awaits init completion before returning, so by the time we reach the
/// `capabilities.get()` read below the OnceLock is already populated for
/// successful inits — `unwrap_or(false)` only triggers when the agent
/// genuinely doesn't advertise resume.
pub async fn session_resume_supported(app: &AppHandle, provider: AcpProvider) -> bool {
    let Ok(p) = get_or_spawn(app, provider).await else {
        return false;
    };
    p.capabilities
        .get()
        .map(|c| c.session_capabilities.resume.is_some())
        .unwrap_or(false)
}

/// `true` if the provider's `initialize` handshake reported `load_session`.
pub async fn load_session_supported(app: &AppHandle, provider: AcpProvider) -> bool {
    let Ok(p) = get_or_spawn(app, provider).await else {
        return false;
    };
    p.capabilities
        .get()
        .map(|c| c.load_session)
        .unwrap_or(false)
}

/// `true` if the provider's `initialize` handshake reported
/// `agent_capabilities.prompt_capabilities.image`. When `true`, the
/// agent accepts image content blocks in `session/prompt` requests.
/// The client MUST NOT send images to agents that don't advertise this
/// capability. Defaults to `false` when capabilities aren't yet populated
/// (shouldn't happen in practice — called after `get_or_spawn`).
pub async fn prompt_image_supported(app: &AppHandle, provider: AcpProvider) -> bool {
    let Ok(p) = get_or_spawn(app, provider).await else {
        return false;
    };
    p.capabilities
        .get()
        .map(|c| c.prompt_capabilities.image)
        .unwrap_or(false)
}

/// `true` if the provider's `initialize` handshake reported
/// `agent_capabilities.prompt_capabilities.embedded_context`. Drives the
/// embed-vs-link choice for `@file` mentions in [`mentions::expand_mentions`].
pub async fn prompt_embedded_context_supported(app: &AppHandle, provider: AcpProvider) -> bool {
    let Ok(p) = get_or_spawn(app, provider).await else {
        return false;
    };
    p.capabilities
        .get()
        .map(|c| c.prompt_capabilities.embedded_context)
        .unwrap_or(false)
}

/// Fire-and-forget pre-warm: spawn the supervisor for every known
/// provider so the (~5–10 s) `initialize` handshake completes in the
/// background while the user is doing other things on app open. By the
/// time they actually open an ACP session, capabilities are already
/// populated and `get_or_spawn` returns instantly. Errors are logged but
/// not surfaced — pre-warm is best-effort. If it fails, the on-demand
/// spawn at first use will simply re-attempt and surface the error then.
///
/// Uses `tauri::async_runtime::spawn` (NOT `tokio::spawn`) because this
/// is called from `setup()`, which runs on the main thread without an
/// ambient tokio runtime — `tokio::spawn` would panic with
/// "there is no reactor running, must be called from the context of a
/// Tokio 1.x runtime", and panicking inside the Cocoa
/// `applicationDidFinishLaunching:` delegate aborts the whole process
/// (no unwind allowed across the FFI boundary).
pub fn prewarm_all(app: &AppHandle) {
    for &provider in AcpProvider::ALL {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            log::info!("[acp] prewarming {provider}");
            match get_or_spawn(&app, provider).await {
                Ok(_) => log::info!("[acp] prewarm complete for {provider}"),
                Err(e) => log::warn!("[acp] prewarm failed for {provider}: {e}"),
            }
        });
    }
}

pub async fn register_session_log(
    app: &AppHandle,
    provider: AcpProvider,
    acp_session_id: String,
    log: Arc<SessionLog>,
) -> Result<SessionInfoState, String> {
    get_or_spawn(app, provider).await?;
    session_state::register_session_log(app, provider, acp_session_id, log).await
}

pub async fn send_prompt(
    app: &AppHandle,
    provider: AcpProvider,
    session_id: String,
    text: String,
    images: Vec<(String, String)>,
    mentions: Vec<ContentBlock>,
) -> Result<PromptResponse, String> {
    let p = get_or_spawn(app, provider).await?;
    let (tx, rx) = oneshot::channel();
    p.tx.send(DriverCmd::Prompt {
        session_id: SessionId::new(session_id),
        text,
        images,
        mentions,
        reply: tx,
    })
    .await
    .map_err(|e| format!("provider channel closed: {e}"))?;
    rx.await
        .map_err(|e| format!("provider dropped reply: {e}"))?
}

pub async fn cancel(
    app: &AppHandle,
    provider: AcpProvider,
    session_id: String,
) -> Result<(), String> {
    let p = get_or_spawn(app, provider).await?;
    let (tx, rx) = oneshot::channel();
    p.tx.send(DriverCmd::Cancel {
        session_id: SessionId::new(session_id),
        reply: tx,
    })
    .await
    .map_err(|e| format!("provider channel closed: {e}"))?;
    rx.await
        .map_err(|e| format!("provider dropped reply: {e}"))?
}

pub async fn set_model(
    app: &AppHandle,
    provider: AcpProvider,
    session_id: String,
    model_id: String,
) -> Result<Value, String> {
    let p = get_or_spawn(app, provider).await?;
    let (tx, rx) = oneshot::channel();
    p.tx.send(DriverCmd::SetModel {
        session_id: SessionId::new(session_id),
        model_id,
        reply: tx,
    })
    .await
    .map_err(|e| format!("provider channel closed: {e}"))?;
    rx.await
        .map_err(|e| format!("provider dropped reply: {e}"))?
}

pub async fn set_mode(
    app: &AppHandle,
    provider: AcpProvider,
    session_id: String,
    mode_id: String,
) -> Result<Value, String> {
    let p = get_or_spawn(app, provider).await?;
    let (tx, rx) = oneshot::channel();
    p.tx.send(DriverCmd::SetMode {
        session_id: SessionId::new(session_id),
        mode_id,
        reply: tx,
    })
    .await
    .map_err(|e| format!("provider channel closed: {e}"))?;
    rx.await
        .map_err(|e| format!("provider dropped reply: {e}"))?
}

/// Send a `session/set_config_option` for one of the agent's generic
/// configurable knobs (today thought level is the one surfaced in the
/// UI). The agent decides whether to honor the change and returns the
/// full updated `configOptions` list, which the caller forwards as-is.
pub async fn set_config_option(
    app: &AppHandle,
    provider: AcpProvider,
    session_id: String,
    config_id: String,
    value_id: String,
) -> Result<Value, String> {
    let p = get_or_spawn(app, provider).await?;
    let (tx, rx) = oneshot::channel();
    p.tx.send(DriverCmd::SetConfigOption {
        session_id: SessionId::new(session_id),
        config_id,
        value_id,
        reply: tx,
    })
    .await
    .map_err(|e| format!("provider channel closed: {e}"))?;
    rx.await
        .map_err(|e| format!("provider dropped reply: {e}"))?
}
