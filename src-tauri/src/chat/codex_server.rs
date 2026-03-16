//! Codex app-server manager
//!
//! Manages a persistent `codex app-server` child process that communicates via
//! JSON-RPC 2.0 over newline-delimited JSON on stdio.
//!
//! Replaces the per-message `codex exec --json` process spawning with a single
//! long-lived server. Threads and turns are managed via JSON-RPC requests;
//! streamed responses arrive as notifications.

use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

use crate::codex_cli::resolve_cli_binary;
use crate::platform::silent_command;

// =============================================================================
// Types
// =============================================================================

/// Events routed from the background reader to per-session consumers.
#[derive(Debug)]
pub enum ServerEvent {
    /// JSON-RPC notification from server (has `method` + `params`, no `id`)
    Notification { method: String, params: Value },
    /// JSON-RPC request from server needing client response (approval)
    ServerRequest {
        id: u64,
        method: String,
        params: Value,
    },
    /// Server process died (EOF on stdout)
    ServerDied,
}

/// Per-session context registered while a turn is active.
pub struct SessionContext {
    pub session_id: String,
    pub worktree_id: String,
    pub event_tx: std::sync::mpsc::Sender<ServerEvent>,
}

/// The app-server process and its communication channels.
struct CodexAppServerInner {
    child: Child,
    stdin_writer: Arc<Mutex<BufWriter<ChildStdin>>>,
    next_request_id: AtomicU64,
    /// Pending request responses: id → oneshot sender
    pending_requests: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>>,
    /// Active sessions keyed by codex thread_id
    active_sessions: Arc<Mutex<HashMap<String, SessionContext>>>,
    /// Reader thread handle
    _reader_handle: std::thread::JoinHandle<()>,
    /// True when the reader thread detects EOF
    server_dead: Arc<AtomicBool>,
}

// Global singleton
static CODEX_SERVER: Lazy<Mutex<Option<CodexAppServerInner>>> = Lazy::new(|| Mutex::new(None));

/// Cached AppHandle for PID file path resolution
static APP_HANDLE: once_cell::sync::OnceCell<AppHandle> = once_cell::sync::OnceCell::new();

/// Number of active sessions using the server. When this drops to 0, a delayed
/// shutdown is scheduled (matching the opencode server pattern).
static USAGE_COUNT: AtomicU64 = AtomicU64::new(0);

/// Generation counter incremented each time a new server is spawned.
/// Used by the delayed shutdown thread to avoid killing a newly-spawned server.
static SERVER_GENERATION: AtomicU64 = AtomicU64::new(0);

// =============================================================================
// PID file for crash-recovery
// =============================================================================

#[derive(serde::Serialize, serde::Deserialize)]
struct ServerPidRecord {
    jean_pid: u32,
    server_pid: u32,
}

fn pid_file_path() -> Option<PathBuf> {
    APP_HANDLE
        .get()
        .and_then(|app| app.path().app_data_dir().ok())
        .map(|d| d.join("codex-app-server.pid"))
}

fn write_pid_file(server_pid: u32) {
    let Some(path) = pid_file_path() else { return };
    let record = ServerPidRecord {
        jean_pid: std::process::id(),
        server_pid,
    };
    if let Ok(json) = serde_json::to_string(&record) {
        let _ = std::fs::write(&path, json);
    }
}

fn remove_pid_file() {
    if let Some(path) = pid_file_path() {
        let _ = std::fs::remove_file(path);
    }
}

// =============================================================================
// Lifecycle
// =============================================================================

/// Kill orphaned server from a previous Jean crash.
/// Call once at app startup.
pub fn cleanup_orphaned_server(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());

    let Some(path) = pid_file_path() else { return };
    let Ok(json) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(record) = serde_json::from_str::<ServerPidRecord>(&json) else {
        let _ = std::fs::remove_file(&path);
        return;
    };

    // Only kill if the PID file was written by a different Jean process
    if record.jean_pid != std::process::id() {
        log::info!(
            "Cleaning up orphaned codex app-server (pid={}, from jean pid={})",
            record.server_pid,
            record.jean_pid
        );
        use crate::platform::{kill_process, kill_process_tree};
        let _ = kill_process_tree(record.server_pid);
        let _ = kill_process(record.server_pid);
    }
    let _ = std::fs::remove_file(&path);
}

/// Shut down the server. Call on app exit.
pub fn shutdown_server() {
    let mut guard = CODEX_SERVER.lock().unwrap();
    if let Some(mut server) = guard.take() {
        log::info!("Shutting down codex app-server");
        let _ = server.child.kill();
        let _ = server.child.wait();
        remove_pid_file();
    }
}

/// Ensure the server is running. Spawns + initializes if needed.
/// Increments usage count — caller MUST call `unregister_session` when done.
pub fn ensure_running(app: &AppHandle) -> Result<(), String> {
    let _ = APP_HANDLE.set(app.clone());

    USAGE_COUNT.fetch_add(1, Ordering::SeqCst);

    match ensure_running_inner(app) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Roll back usage count on failure so we don't leave a phantom user
            USAGE_COUNT.fetch_sub(1, Ordering::SeqCst);
            Err(e)
        }
    }
}

fn ensure_running_inner(app: &AppHandle) -> Result<(), String> {
    let mut guard = CODEX_SERVER.lock().unwrap();

    // Check if existing server is still alive
    if let Some(ref server) = *guard {
        if !server.server_dead.load(Ordering::SeqCst) {
            return Ok(());
        }
        // Server died — clean up and respawn
        log::warn!("Codex app-server died, respawning...");
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        remove_pid_file();
    }

    // Spawn new server
    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err(format!(
            "Codex CLI not found at {}. Please install it in Settings > General.",
            cli_path.display()
        ));
    }

    log::info!(
        "Starting codex app-server: {} app-server",
        cli_path.display()
    );

    let mut child = silent_command(&cli_path)
        .arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn codex app-server: {e}"))?;

    let pid = child.id();
    write_pid_file(pid);
    SERVER_GENERATION.fetch_add(1, Ordering::SeqCst);
    log::info!("Codex app-server spawned with PID: {pid}");

    // Take stdin for writing
    let stdin = child
        .stdin
        .take()
        .ok_or("Failed to take stdin from app-server")?;
    let stdin_writer = Arc::new(Mutex::new(BufWriter::new(stdin)));

    // Take stdout for reading
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to take stdout from app-server")?;

    // Spawn stderr logger
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) if !l.trim().is_empty() => {
                        log::debug!("codex-app-server stderr: {l}");
                    }
                    _ => {}
                }
            }
        });
    }

    let pending_requests: Arc<
        Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
    > = Arc::new(Mutex::new(HashMap::new()));
    let active_sessions: Arc<Mutex<HashMap<String, SessionContext>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let server_dead = Arc::new(AtomicBool::new(false));

    // Background reader thread
    let pr = pending_requests.clone();
    let as_ = active_sessions.clone();
    let dead = server_dead.clone();
    let reader_handle = std::thread::spawn(move || {
        reader_loop(stdout, pr, as_, dead);
    });

    let server = CodexAppServerInner {
        child,
        stdin_writer,
        next_request_id: AtomicU64::new(1),
        pending_requests,
        active_sessions,
        _reader_handle: reader_handle,
        server_dead,
    };

    *guard = Some(server);

    // Perform initialization handshake (must be done while holding the lock
    // to prevent other threads from sending requests before init completes)
    do_initialize(&guard)?;

    Ok(())
}

/// Send the initialize request + initialized notification.
fn do_initialize(
    guard: &std::sync::MutexGuard<'_, Option<CodexAppServerInner>>,
) -> Result<(), String> {
    let server = guard.as_ref().ok_or("Server not running")?;

    let init_params = serde_json::json!({
        "clientInfo": {
            "name": "jean",
            "title": "Jean",
            "version": "1.0.0"
        },
        "capabilities": {
            "experimentalApi": true
        }
    });

    // Send initialize request
    let id = server.next_request_id.fetch_add(1, Ordering::SeqCst);
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "initialize",
        "id": id,
        "params": init_params,
    });

    // Register response handler BEFORE writing (prevent race with reader thread)
    let (tx, rx) = tokio::sync::oneshot::channel();
    server.pending_requests.lock().unwrap().insert(id, tx);

    write_message(&server.stdin_writer, &request)?;

    // Drop the mutex guard temporarily is not possible here since we hold it,
    // so we rely on the reader thread running concurrently.
    // Use a blocking recv with timeout.
    let response = rx
        .blocking_recv()
        .map_err(|_| "Initialize response channel dropped")?;

    match response {
        Ok(result) => {
            log::info!("Codex app-server initialized: {result}");
        }
        Err(e) => {
            return Err(format!("Initialize failed: {e}"));
        }
    }

    // Send initialized notification (no id)
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "initialized",
        "params": {},
    });
    write_message(&server.stdin_writer, &notification)?;

    log::info!("Codex app-server handshake complete");
    Ok(())
}

// =============================================================================
// JSON-RPC transport
// =============================================================================

/// Write a JSON-RPC message to the server's stdin.
fn write_message(writer: &Arc<Mutex<BufWriter<ChildStdin>>>, msg: &Value) -> Result<(), String> {
    let line = serde_json::to_string(msg).map_err(|e| format!("JSON serialize error: {e}"))?;
    let mut w = writer
        .lock()
        .map_err(|e| format!("Stdin lock error: {e}"))?;
    w.write_all(line.as_bytes())
        .map_err(|e| format!("Stdin write error: {e}"))?;
    w.write_all(b"\n")
        .map_err(|e| format!("Stdin write error: {e}"))?;
    w.flush().map_err(|e| format!("Stdin flush error: {e}"))?;
    Ok(())
}

/// Send a JSON-RPC request and wait for the response.
pub fn send_request(method: &str, params: Value) -> Result<Value, String> {
    let guard = CODEX_SERVER.lock().unwrap();
    let server = guard.as_ref().ok_or("Codex app-server not running")?;

    if server.server_dead.load(Ordering::SeqCst) {
        return Err("Codex app-server is dead".to_string());
    }

    let id = server.next_request_id.fetch_add(1, Ordering::SeqCst);
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "id": id,
        "params": params,
    });

    // Register response handler BEFORE writing (prevent race with reader thread)
    let (tx, rx) = tokio::sync::oneshot::channel();
    server.pending_requests.lock().unwrap().insert(id, tx);

    write_message(&server.stdin_writer, &request)?;

    // Drop the server lock before blocking
    drop(guard);

    rx.blocking_recv()
        .map_err(|_| format!("Response channel dropped for {method}"))?
}

/// Send a JSON-RPC response (for server requests like approvals).
pub fn send_response(id: u64, result: Value) -> Result<(), String> {
    let guard = CODEX_SERVER.lock().unwrap();
    let server = guard.as_ref().ok_or("Codex app-server not running")?;

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    });

    write_message(&server.stdin_writer, &response)
}

/// Send a JSON-RPC notification (no id, no response expected).
#[allow(dead_code)]
pub fn send_notification(method: &str, params: Value) -> Result<(), String> {
    let guard = CODEX_SERVER.lock().unwrap();
    let server = guard.as_ref().ok_or("Codex app-server not running")?;

    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });

    write_message(&server.stdin_writer, &notification)
}

// =============================================================================
// Session registration
// =============================================================================

/// Register a session to receive events for a given codex thread_id.
pub fn register_session(thread_id: &str, ctx: SessionContext) {
    let guard = CODEX_SERVER.lock().unwrap();
    if let Some(ref server) = *guard {
        server
            .active_sessions
            .lock()
            .unwrap()
            .insert(thread_id.to_string(), ctx);
    }
}

/// Decrement the usage count without unregistering a session or scheduling shutdown.
/// Used when `ensure_running()` succeeded but thread start failed before a session
/// was registered (so there's nothing to unregister, but the count is inflated).
pub fn decrement_usage_count() {
    USAGE_COUNT.fetch_sub(1, Ordering::SeqCst);
}

/// Unregister a session and schedule delayed shutdown if no sessions remain.
pub fn unregister_session(thread_id: &str) {
    let guard = CODEX_SERVER.lock().unwrap();
    if let Some(ref server) = *guard {
        server.active_sessions.lock().unwrap().remove(thread_id);
    }
    drop(guard);

    let prev = USAGE_COUNT.fetch_sub(1, Ordering::SeqCst);
    if prev == 1 {
        // Last session finished — schedule delayed shutdown (10min grace period
        // to keep server warm for typical work sessions).
        // Capture generation so we don't kill a newly-spawned server.
        let gen = SERVER_GENERATION.load(Ordering::SeqCst);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(600));
            if USAGE_COUNT.load(Ordering::SeqCst) == 0
                && SERVER_GENERATION.load(Ordering::SeqCst) == gen
            {
                log::info!("No active codex sessions — shutting down app-server");
                shutdown_server();
            }
        });
    }
}

/// Send a `turn/interrupt` request to cancel an in-progress turn.
pub fn interrupt_turn(thread_id: &str, turn_id: &str) -> Result<(), String> {
    let params = serde_json::json!({
        "threadId": thread_id,
        "turnId": turn_id,
    });
    send_request("turn/interrupt", params).map(|_| ())
}

/// Check if the server is alive.
pub fn is_server_alive() -> bool {
    let guard = CODEX_SERVER.lock().unwrap();
    match *guard {
        Some(ref server) => !server.server_dead.load(Ordering::SeqCst),
        None => false,
    }
}

// =============================================================================
// Background reader thread
// =============================================================================

fn reader_loop(
    stdout: std::process::ChildStdout,
    pending_requests: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>>,
    active_sessions: Arc<Mutex<HashMap<String, SessionContext>>>,
    server_dead: Arc<AtomicBool>,
) {
    let reader = std::io::BufReader::new(stdout);

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                log::error!("Codex app-server stdout read error: {e}");
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Failed to parse app-server message: {e}: {line}");
                continue;
            }
        };

        let has_method = msg.get("method").is_some();
        let has_id = msg.get("id").is_some();
        let has_result = msg.get("result").is_some();
        let has_error = msg.get("error").is_some();

        if !has_method && has_id && (has_result || has_error) {
            // Response to a client request
            let id = msg["id"].as_u64().unwrap_or(0);
            let mut pr = pending_requests.lock().unwrap();
            if let Some(sender) = pr.remove(&id) {
                if has_error {
                    let error_msg = msg["error"]["message"]
                        .as_str()
                        .unwrap_or("Unknown error")
                        .to_string();
                    let _ = sender.send(Err(error_msg));
                } else {
                    let _ = sender.send(Ok(msg["result"].clone()));
                }
            } else {
                log::trace!("No pending request for response id={id}");
            }
        } else if has_method && !has_id {
            // Server notification
            let method = msg["method"].as_str().unwrap_or("").to_string();
            let params = msg.get("params").cloned().unwrap_or(Value::Null);

            route_notification(&active_sessions, method, params);
        } else if has_method && has_id {
            // Server request (needs client response) — e.g., approval requests
            let id = msg["id"].as_u64().unwrap_or(0);
            let method = msg["method"].as_str().unwrap_or("").to_string();
            let params = msg.get("params").cloned().unwrap_or(Value::Null);

            route_server_request(&active_sessions, id, method, params);
        } else {
            log::trace!("Unclassified app-server message: {line}");
        }
    }

    // EOF — server died
    log::warn!("Codex app-server stdout EOF — server died");
    server_dead.store(true, Ordering::SeqCst);

    // Notify all active sessions
    let sessions = active_sessions.lock().unwrap();
    for (_tid, ctx) in sessions.iter() {
        let _ = ctx.event_tx.send(ServerEvent::ServerDied);
    }

    // Fail all pending requests
    let mut pr = pending_requests.lock().unwrap();
    for (_id, sender) in pr.drain() {
        let _ = sender.send(Err("Server died".to_string()));
    }

    remove_pid_file();
}

/// Route a server notification to the appropriate session by threadId.
fn route_notification(
    active_sessions: &Arc<Mutex<HashMap<String, SessionContext>>>,
    method: String,
    params: Value,
) {
    // Extract threadId from params (most notifications have it)
    let thread_id = params
        .get("threadId")
        .or_else(|| {
            // thread/started has it nested: params.thread.id
            params.get("thread").and_then(|t| t.get("id"))
        })
        .and_then(|v| v.as_str());

    if let Some(tid) = thread_id {
        let sessions = active_sessions.lock().unwrap();
        if let Some(ctx) = sessions.get(tid) {
            let _ = ctx
                .event_tx
                .send(ServerEvent::Notification { method, params });
        } else {
            log::trace!("No active session for thread {tid}, notification: {method}");
        }
    } else {
        // Broadcast to all sessions (global notifications)
        log::trace!("Broadcasting notification without threadId: {method}");
        let sessions = active_sessions.lock().unwrap();
        for (_tid, ctx) in sessions.iter() {
            let _ = ctx.event_tx.send(ServerEvent::Notification {
                method: method.clone(),
                params: params.clone(),
            });
        }
    }
}

/// Route a server request (approval) to the appropriate session.
fn route_server_request(
    active_sessions: &Arc<Mutex<HashMap<String, SessionContext>>>,
    id: u64,
    method: String,
    params: Value,
) {
    let thread_id = params.get("threadId").and_then(|v| v.as_str());

    if let Some(tid) = thread_id {
        let sessions = active_sessions.lock().unwrap();
        if let Some(ctx) = sessions.get(tid) {
            let _ = ctx
                .event_tx
                .send(ServerEvent::ServerRequest { id, method, params });
        } else {
            log::warn!("No active session for approval request on thread {tid}");
        }
    } else {
        log::warn!("Approval request without threadId: {method}");
    }
}
