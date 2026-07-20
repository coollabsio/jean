//! Codex app-server manager
//!
//! Manages a `codex app-server` process that communicates via JSON-RPC 2.0.
//!
//! On Unix the server is spawned **detached** (nohup + own process group) and
//! listens on a Unix domain socket (`--listen unix://<path>`, WebSocket
//! framing). Jean connects as a WebSocket client. Because the server is not a
//! child of Jean and holds no pipes to it, in-flight turns survive Jean
//! quitting; on restart Jean reconnects to the live server and re-subscribes
//! to threads via `thread/resume`.
//!
//! On Windows (and with `JEAN_CODEX_STDIO=1` on Unix) the legacy transport is
//! used: a piped child process speaking newline-delimited JSON over stdio,
//! killed when Jean exits.

use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

use crate::codex_cli::resolve_cli_binary;
use crate::platform::is_process_alive;

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
    /// Server process died (EOF on stdout) or the connection to a detached
    /// server was lost.
    ServerDied,
}

/// Per-session context registered while a turn is active.
pub struct SessionContext {
    pub session_id: String,
    pub worktree_id: String,
    pub event_tx: std::sync::mpsc::Sender<ServerEvent>,
}

type PendingRequests =
    Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>>;
type ActiveSessions = Arc<Mutex<HashMap<String, SessionContext>>>;

/// How Jean talks to the app-server.
enum Transport {
    /// Legacy: piped child process, newline-delimited JSON over stdio.
    /// Used on Windows and as an explicit fallback (`JEAN_CODEX_STDIO=1`).
    Stdio {
        child: Child,
        stdin_writer: Arc<Mutex<BufWriter<ChildStdin>>>,
    },
    /// Detached server reached over WebSocket-on-Unix-socket. Outgoing
    /// messages are queued to the async writer task.
    #[cfg(unix)]
    Socket {
        outgoing_tx: tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>,
        socket_path: PathBuf,
    },
}

/// The app-server connection and its communication channels.
struct CodexAppServerInner {
    transport: Transport,
    /// PID of the app-server process (the detached server on Unix, the piped
    /// child on stdio transport).
    server_pid: u32,
    next_request_id: AtomicU64,
    /// Pending request responses: id → oneshot sender
    pending_requests: PendingRequests,
    /// Active sessions keyed by codex thread_id
    active_sessions: ActiveSessions,
    /// True when the connection to the server is dead. For the socket
    /// transport this does NOT imply the server process is dead.
    server_dead: Arc<AtomicBool>,
}

// Global singleton
static CODEX_SERVER: Lazy<Mutex<Option<CodexAppServerInner>>> = Lazy::new(|| Mutex::new(None));

/// Cached AppHandle for PID file path resolution
static APP_HANDLE: once_cell::sync::OnceCell<AppHandle> = once_cell::sync::OnceCell::new();

/// Number of active sessions using the server. When this drops to 0, a delayed
/// shutdown is scheduled (matching the opencode server pattern).
static USAGE_COUNT: AtomicU64 = AtomicU64::new(0);

/// Generation counter incremented each time a new server is spawned or adopted.
/// Used by the delayed shutdown thread to avoid killing a newly-spawned server.
static SERVER_GENERATION: AtomicU64 = AtomicU64::new(0);

// =============================================================================
// PID file for crash-recovery
// =============================================================================

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ServerPidRecord {
    jean_pid: u32,
    server_pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proxy_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    socket_path: Option<PathBuf>,
}

fn pid_file_path() -> Option<PathBuf> {
    APP_HANDLE
        .get()
        .and_then(|app| app.path().app_data_dir().ok())
        .map(|d| d.join("codex-app-server.pid"))
}

fn write_pid_file(record: &ServerPidRecord) {
    let Some(path) = pid_file_path() else { return };
    if let Ok(json) = serde_json::to_string(&record) {
        let _ = std::fs::write(&path, json);
    }
}

fn read_pid_file() -> Option<ServerPidRecord> {
    let path = pid_file_path()?;
    let json = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<ServerPidRecord>(&json).ok()
}

fn remove_pid_file() {
    if let Some(path) = pid_file_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn remove_socket_file(path: Option<&PathBuf>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

fn has_incomplete_codex_runs(app: &AppHandle) -> bool {
    let Ok(session_ids) = super::storage::list_all_session_ids(app) else {
        return false;
    };

    session_ids.into_iter().any(|session_id| {
        let Ok(Some(metadata)) = super::storage::load_metadata(app, &session_id) else {
            return false;
        };

        if metadata.backend != super::types::Backend::Codex {
            return false;
        }

        metadata.runs.iter().any(|run| {
            matches!(
                run.status,
                super::types::RunStatus::Running | super::types::RunStatus::Resumable
            )
        })
    })
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

    // Only clean up if the PID file was written by a different Jean process.
    // If that Jean process is still alive, this is a second app instance — do
    // not kill the server it owns.
    if record.jean_pid != std::process::id() {
        if is_process_alive(record.jean_pid) {
            log::info!(
                "Preserving codex app-server (pid={}) owned by live Jean pid={}",
                record.server_pid,
                record.jean_pid
            );
            return;
        }

        // If Codex turns were in-flight when the previous Jean exited, the
        // detached app-server may still be the process doing the work.
        // Preserve it (and its pid/socket files) so recovery can reconnect
        // and observe the thread state.
        if has_incomplete_codex_runs(app) {
            log::warn!(
                "Preserving orphaned codex app-server (pid={}, from jean pid={}) because Codex runs are still incomplete",
                record.server_pid,
                record.jean_pid
            );
            return;
        }

        log::info!(
            "Cleaning up orphaned codex app-server (pid={}, from jean pid={})",
            record.server_pid,
            record.jean_pid
        );
        use crate::platform::{kill_process, kill_process_tree};
        if let Some(proxy_pid) = record.proxy_pid {
            let _ = kill_process_tree(proxy_pid);
            let _ = kill_process(proxy_pid);
        }
        let _ = kill_process_tree(record.server_pid);
        let _ = kill_process(record.server_pid);
    }
    remove_socket_file(record.socket_path.as_ref());
    let _ = std::fs::remove_file(&path);
}

/// Shut down the server connection. Call on app exit.
///
/// When the server is detached (socket transport) and incomplete Codex runs
/// exist, the server process is preserved so in-flight turns keep running —
/// only the connection is dropped. Recovery reconnects on next launch.
pub fn shutdown_server() {
    let mut guard = CODEX_SERVER.lock().unwrap();
    let Some(server) = guard.take() else { return };

    #[cfg(unix)]
    if matches!(server.transport, Transport::Socket { .. }) {
        let preserve = APP_HANDLE
            .get()
            .map(has_incomplete_codex_runs)
            .unwrap_or(false);
        if preserve {
            log::info!(
                "Preserving detached codex app-server (pid={}) — incomplete Codex runs exist",
                server.server_pid
            );
            // Dropping the transport closes the WebSocket; pid + socket files
            // stay in place for reconnect/adoption.
            return;
        }
    }

    log::info!("Shutting down codex app-server (pid={})", server.server_pid);
    kill_server(server);
}

/// Kill the server process and clean up pid/socket files.
fn kill_server(mut server: CodexAppServerInner) {
    match server.transport {
        Transport::Stdio { ref mut child, .. } => {
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(unix)]
        Transport::Socket {
            ref socket_path, ..
        } => {
            use crate::platform::{kill_process, kill_process_tree};
            let _ = kill_process_tree(server.server_pid);
            let _ = kill_process(server.server_pid);
            remove_socket_file(Some(socket_path));
        }
    }
    remove_pid_file();
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

/// Whether the legacy stdio transport should be used.
fn use_stdio_transport() -> bool {
    if cfg!(windows) {
        return true;
    }
    std::env::var("JEAN_CODEX_STDIO").is_ok_and(|v| v == "1")
}

fn ensure_running_inner(app: &AppHandle) -> Result<(), String> {
    let mut guard = CODEX_SERVER.lock().unwrap();

    // Check if existing connection is still alive
    if let Some(ref server) = *guard {
        if !server.server_dead.load(Ordering::SeqCst) {
            return Ok(());
        }
        // Connection died — clean up. For the socket transport a dead
        // connection does not imply a dead server: leave the process and its
        // pid/socket files alone so the reconnect path below can adopt it.
        log::warn!("Codex app-server connection died, reconnecting/respawning...");
        if let Some(mut old) = guard.take() {
            match old.transport {
                Transport::Stdio { ref mut child, .. } => {
                    let _ = child.kill();
                    let _ = child.wait();
                    remove_pid_file();
                }
                #[cfg(unix)]
                Transport::Socket {
                    ref socket_path, ..
                } => {
                    if !is_process_alive(old.server_pid) {
                        remove_socket_file(Some(socket_path));
                        remove_pid_file();
                    }
                }
            }
        }
    }

    let cli_path = resolve_cli_binary(app)?;
    if !crate::platform::resolved_cli_exists(&cli_path) {
        return Err(format!(
            "Codex CLI not found at {}. Please install it in Settings > General.",
            cli_path.display()
        ));
    }

    #[cfg(unix)]
    if !use_stdio_transport() {
        return ensure_running_socket(app, &cli_path, &mut guard);
    }

    ensure_running_stdio(&cli_path, &mut guard)
}

// =============================================================================
// Socket transport (Unix): detached server + WebSocket-over-UDS client
// =============================================================================

/// Resolve the Unix socket path for the app-server.
///
/// Prefers the app data dir; falls back to the system temp dir when the
/// resulting path would exceed the `sun_path` limit (104 bytes on macOS).
/// Paths are canonicalized because codex rejects symlinked socket parents
/// (e.g. `/tmp` on macOS).
#[cfg(unix)]
fn server_socket_path(app: &AppHandle) -> Result<PathBuf, String> {
    const SOCKET_NAME: &str = "codex-app-server.sock";
    // Leave headroom below the 104-byte macOS sun_path limit.
    const MAX_LEN: usize = 100;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let app_data = app_data.canonicalize().unwrap_or(app_data);
    let candidate = app_data.join(SOCKET_NAME);
    if candidate.as_os_str().len() <= MAX_LEN {
        return Ok(candidate);
    }

    let tmp = std::env::temp_dir();
    let tmp = tmp.canonicalize().unwrap_or(tmp);
    let uid = unsafe { libc::getuid() };
    let fallback = tmp.join(format!("jean-codex-{uid}.sock"));
    if fallback.as_os_str().len() <= MAX_LEN {
        return Ok(fallback);
    }

    Err(format!(
        "No usable socket path: {} and {} both exceed {MAX_LEN} bytes",
        candidate.display(),
        fallback.display()
    ))
}

#[cfg(unix)]
fn server_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("codex-app-server.log"))
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))
}

/// Wait until the server accepts connections on the socket.
#[cfg(unix)]
fn wait_for_socket_ready(
    socket_path: &std::path::Path,
    server_pid: u32,
    log_path: &std::path::Path,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    loop {
        if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
            return Ok(());
        }
        if !is_process_alive(server_pid) {
            let log_tail = std::fs::read_to_string(log_path)
                .map(|s| {
                    s.lines()
                        .rev()
                        .take(10)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            return Err(format!(
                "Codex app-server (pid={server_pid}) exited before its socket became ready.\n{log_tail}"
            ));
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "Timed out waiting for codex app-server socket at {}",
                socket_path.display()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Run a future on the tauri async runtime and block the current (std) thread
/// until it completes. Callers of this module run on dedicated std threads,
/// never on tokio workers, so blocking here is safe.
#[cfg(unix)]
fn run_on_runtime<F, T>(fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let _ = tx.send(fut.await);
    });
    rx.recv().map_err(|_| "Async task dropped".to_string())
}

/// Connect to a listening app-server socket and start the async reader/writer
/// tasks. Returns the outgoing message sender.
#[cfg(unix)]
fn connect_socket_transport(
    socket_path: &std::path::Path,
    server_pid: u32,
    pending_requests: PendingRequests,
    active_sessions: ActiveSessions,
    server_dead: Arc<AtomicBool>,
) -> Result<tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let path = socket_path.to_path_buf();
    let (outgoing_tx, mut outgoing_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let pong_tx = outgoing_tx.clone();

    let ws = run_on_runtime(async move {
        let stream = tokio::net::UnixStream::connect(&path)
            .await
            .map_err(|e| format!("Failed to connect to codex app-server socket: {e}"))?;
        // The URI authority is a dummy value for the Host header; the server
        // only cares about the HTTP Upgrade handshake.
        let (ws, _resp) = tokio_tungstenite::client_async("ws://localhost/", stream)
            .await
            .map_err(|e| format!("WebSocket handshake with codex app-server failed: {e}"))?;
        Ok::<_, String>(ws)
    })??;

    let (mut sink, mut stream) = ws.split();

    // Writer task: drain outgoing channel into the WebSocket. SinkExt::send
    // flushes each message, so queued pongs go out promptly too.
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = outgoing_rx.recv().await {
            if let Err(e) = sink.send(msg).await {
                log::warn!("Codex app-server WebSocket write failed: {e}");
                break;
            }
        }
        let _ = sink.close().await;
    });

    // Reader task: route incoming frames; on close/error mark connection dead.
    let socket_path_owned = socket_path.to_path_buf();
    tauri::async_runtime::spawn(async move {
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => {
                    handle_server_line(text.as_str(), &pending_requests, &active_sessions);
                }
                Some(Ok(Message::Ping(payload))) => {
                    let _ = pong_tx.send(Message::Pong(payload));
                }
                Some(Ok(Message::Close(_))) | None => {
                    log::warn!("Codex app-server WebSocket closed");
                    break;
                }
                Some(Err(e)) => {
                    log::warn!("Codex app-server WebSocket read error: {e}");
                    break;
                }
                Some(Ok(_)) => {}
            }
        }

        fail_connection(&pending_requests, &active_sessions, &server_dead);

        // Connection death only implies process death if the PID is gone.
        if !is_process_alive(server_pid) {
            log::warn!("Codex app-server process (pid={server_pid}) is dead");
            remove_socket_file(Some(&socket_path_owned));
            remove_pid_file();
        }
    });

    Ok(outgoing_tx)
}

/// Try to adopt a live detached server recorded in the pid file.
#[cfg(unix)]
fn try_adopt_existing_server() -> Option<CodexAppServerInner> {
    let record = read_pid_file()?;
    let socket_path = record.socket_path.clone()?;
    if !is_process_alive(record.server_pid) {
        remove_socket_file(Some(&socket_path));
        remove_pid_file();
        return None;
    }

    let pending_requests: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let active_sessions: ActiveSessions = Arc::new(Mutex::new(HashMap::new()));
    let server_dead = Arc::new(AtomicBool::new(false));

    match connect_socket_transport(
        &socket_path,
        record.server_pid,
        pending_requests.clone(),
        active_sessions.clone(),
        server_dead.clone(),
    ) {
        Ok(outgoing_tx) => {
            log::info!(
                "Adopted detached codex app-server (pid={}) at {}",
                record.server_pid,
                socket_path.display()
            );
            // Take ownership of the server.
            write_pid_file(&ServerPidRecord {
                jean_pid: std::process::id(),
                server_pid: record.server_pid,
                proxy_pid: None,
                socket_path: Some(socket_path.clone()),
            });
            Some(CodexAppServerInner {
                transport: Transport::Socket {
                    outgoing_tx,
                    socket_path,
                },
                server_pid: record.server_pid,
                next_request_id: AtomicU64::new(1),
                pending_requests,
                active_sessions,
                server_dead,
            })
        }
        Err(e) => {
            log::warn!(
                "Failed to connect to recorded codex app-server (pid={}): {e}; killing and respawning",
                record.server_pid
            );
            use crate::platform::{kill_process, kill_process_tree};
            let _ = kill_process_tree(record.server_pid);
            let _ = kill_process(record.server_pid);
            remove_socket_file(Some(&socket_path));
            remove_pid_file();
            None
        }
    }
}

#[cfg(unix)]
fn ensure_running_socket(
    app: &AppHandle,
    cli_path: &std::path::Path,
    guard: &mut std::sync::MutexGuard<'_, Option<CodexAppServerInner>>,
) -> Result<(), String> {
    // 1. Adopt a live detached server from a previous Jean process (or a
    //    previous connection of this process).
    if let Some(server) = try_adopt_existing_server() {
        **guard = Some(server);
        SERVER_GENERATION.fetch_add(1, Ordering::SeqCst);
        return do_initialize(guard);
    }

    // 2. Spawn a fresh detached server.
    let socket_path = server_socket_path(app)?;
    let log_path = server_log_path(app)?;
    let _ = std::fs::remove_file(&socket_path);

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    log::info!(
        "Starting detached codex app-server: {} app-server --listen unix://{}",
        cli_path.display(),
        socket_path.display()
    );

    let args = vec![
        "app-server".to_string(),
        "--listen".to_string(),
        format!("unix://{}", socket_path.display()),
    ];
    let pid = super::detached::spawn_detached_process(cli_path, &args, &log_path, &app_data)?;

    write_pid_file(&ServerPidRecord {
        jean_pid: std::process::id(),
        server_pid: pid,
        proxy_pid: None,
        socket_path: Some(socket_path.clone()),
    });
    SERVER_GENERATION.fetch_add(1, Ordering::SeqCst);
    log::info!("Detached codex app-server spawned with PID: {pid}");

    wait_for_socket_ready(
        &socket_path,
        pid,
        &log_path,
        std::time::Duration::from_secs(15),
    )?;

    let pending_requests: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let active_sessions: ActiveSessions = Arc::new(Mutex::new(HashMap::new()));
    let server_dead = Arc::new(AtomicBool::new(false));

    let outgoing_tx = connect_socket_transport(
        &socket_path,
        pid,
        pending_requests.clone(),
        active_sessions.clone(),
        server_dead.clone(),
    )?;

    **guard = Some(CodexAppServerInner {
        transport: Transport::Socket {
            outgoing_tx,
            socket_path,
        },
        server_pid: pid,
        next_request_id: AtomicU64::new(1),
        pending_requests,
        active_sessions,
        server_dead,
    });

    do_initialize(guard)
}

// =============================================================================
// Stdio transport (Windows + fallback): piped child process
// =============================================================================

fn ensure_running_stdio(
    cli_path: &std::path::Path,
    guard: &mut std::sync::MutexGuard<'_, Option<CodexAppServerInner>>,
) -> Result<(), String> {
    log::info!(
        "Starting codex app-server (stdio): {} app-server",
        cli_path.display()
    );

    let mut child = crate::platform::resolved_cli_command(cli_path, None)
        .arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn codex app-server: {e}"))?;

    let pid = child.id();
    write_pid_file(&ServerPidRecord {
        jean_pid: std::process::id(),
        server_pid: pid,
        proxy_pid: None,
        socket_path: None,
    });
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

    let pending_requests: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let active_sessions: ActiveSessions = Arc::new(Mutex::new(HashMap::new()));
    let server_dead = Arc::new(AtomicBool::new(false));

    // Background reader thread
    let pr = pending_requests.clone();
    let as_ = active_sessions.clone();
    let dead = server_dead.clone();
    std::thread::spawn(move || {
        reader_loop(stdout, pr, as_, dead);
    });

    **guard = Some(CodexAppServerInner {
        transport: Transport::Stdio {
            child,
            stdin_writer,
        },
        server_pid: pid,
        next_request_id: AtomicU64::new(1),
        pending_requests,
        active_sessions,
        server_dead,
    });

    do_initialize(guard)
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

    write_message(&server.transport, &request)?;

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
    write_message(&server.transport, &notification)?;

    log::info!("Codex app-server handshake complete");
    Ok(())
}

// =============================================================================
// JSON-RPC transport
// =============================================================================

/// Write a JSON-RPC message to the server.
fn write_message(transport: &Transport, msg: &Value) -> Result<(), String> {
    let line = serde_json::to_string(msg).map_err(|e| format!("JSON serialize error: {e}"))?;
    match transport {
        Transport::Stdio { stdin_writer, .. } => {
            let mut w = stdin_writer
                .lock()
                .map_err(|e| format!("Stdin lock error: {e}"))?;
            w.write_all(line.as_bytes())
                .map_err(|e| format!("Stdin write error: {e}"))?;
            w.write_all(b"\n")
                .map_err(|e| format!("Stdin write error: {e}"))?;
            w.flush().map_err(|e| format!("Stdin flush error: {e}"))?;
            Ok(())
        }
        #[cfg(unix)]
        Transport::Socket { outgoing_tx, .. } => outgoing_tx
            .send(tokio_tungstenite::tungstenite::Message::text(line))
            .map_err(|_| "Codex app-server connection closed".to_string()),
    }
}

fn request_debug_summary(method: &str, params: &Value) -> Option<Value> {
    let keys: &[&str] = match method {
        "thread/start" | "thread/resume" => &[
            "threadId",
            "model",
            "serviceTier",
            "cwd",
            "sandbox",
            "approvalPolicy",
            "config",
        ],
        "turn/start" => &["threadId", "effort", "cwd", "sandboxPolicy"],
        _ => return None,
    };

    let mut summary = serde_json::Map::new();
    for key in keys {
        if let Some(value) = params.get(*key) {
            summary.insert((*key).to_string(), value.clone());
        }
    }
    Some(Value::Object(summary))
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

    if let Some(summary) = request_debug_summary(method, &request["params"]) {
        log::debug!("Codex app-server request {method}: {summary}");
    }

    // Register response handler BEFORE writing (prevent race with reader thread)
    let (tx, rx) = tokio::sync::oneshot::channel();
    server.pending_requests.lock().unwrap().insert(id, tx);

    write_message(&server.transport, &request)?;

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

    write_message(&server.transport, &response)
}

/// Send a JSON-RPC error response.
pub fn send_error_response(id: u64, code: i64, message: &str) -> Result<(), String> {
    let guard = CODEX_SERVER.lock().unwrap();
    let server = guard.as_ref().ok_or("Codex app-server not running")?;

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        },
    });

    write_message(&server.transport, &response)
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

    write_message(&server.transport, &notification)
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

/// Check if the server connection is alive.
pub fn is_server_alive() -> bool {
    let guard = CODEX_SERVER.lock().unwrap();
    match *guard {
        Some(ref server) => !server.server_dead.load(Ordering::SeqCst),
        None => false,
    }
}

// =============================================================================
// Incoming message handling (shared by stdio reader thread and socket reader task)
// =============================================================================

/// Parse and route one JSON-RPC message line from the server.
fn handle_server_line(
    line: &str,
    pending_requests: &PendingRequests,
    active_sessions: &ActiveSessions,
) {
    if line.trim().is_empty() {
        return;
    }

    let msg: Value = match serde_json::from_str(line) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("Failed to parse app-server message: {e}: {line}");
            return;
        }
    };

    let method_name = msg.get("method").and_then(|v| v.as_str());
    if method_name != Some("item/agentMessage/delta") {
        log::debug!("[codex-raw] {line}");
    }

    let has_method = method_name.is_some();
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

        route_notification(active_sessions, method, params);
    } else if has_method && has_id {
        // Server request (needs client response) — e.g., approval requests
        let id = msg["id"].as_u64().unwrap_or(0);
        let method = msg["method"].as_str().unwrap_or("").to_string();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        route_server_request(active_sessions, id, method, params);
    } else if method_name != Some("item/agentMessage/delta") {
        log::debug!("[codex-raw] Unclassified message: {line}");
    }
}

/// Mark the connection dead, notify sessions, and fail pending requests.
fn fail_connection(
    pending_requests: &PendingRequests,
    active_sessions: &ActiveSessions,
    server_dead: &Arc<AtomicBool>,
) {
    if server_dead.swap(true, Ordering::SeqCst) {
        return;
    }

    // Notify all active sessions
    let sessions = active_sessions.lock().unwrap();
    for ctx in sessions.values() {
        let _ = ctx.event_tx.send(ServerEvent::ServerDied);
    }
    drop(sessions);

    // Fail all pending requests
    let mut pr = pending_requests.lock().unwrap();
    for (_id, sender) in pr.drain() {
        let _ = sender.send(Err("Server died".to_string()));
    }
}

// =============================================================================
// Background reader thread (stdio transport)
// =============================================================================

fn reader_loop(
    stdout: std::process::ChildStdout,
    pending_requests: PendingRequests,
    active_sessions: ActiveSessions,
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

        handle_server_line(&line, &pending_requests, &active_sessions);
    }

    // EOF — server died (stdio transport: connection death == process death)
    log::warn!("Codex app-server stdout EOF — server died");
    fail_connection(&pending_requests, &active_sessions, &server_dead);
    remove_pid_file();
}

/// Route a server notification to the appropriate session by threadId.
fn route_notification(active_sessions: &ActiveSessions, method: String, params: Value) {
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
        for ctx in sessions.values() {
            let _ = ctx.event_tx.send(ServerEvent::Notification {
                method: method.clone(),
                params: params.clone(),
            });
        }
    }
}

/// Route a server request (approval) to the appropriate session.
fn route_server_request(active_sessions: &ActiveSessions, id: u64, method: String, params: Value) {
    let thread_id = params
        .get("threadId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if let Some(tid) = thread_id {
        let sessions = active_sessions.lock().unwrap();
        if let Some(ctx) = sessions.get(&tid) {
            let session_id = ctx.session_id.clone();
            if let Err(e) = ctx
                .event_tx
                .send(ServerEvent::ServerRequest { id, method, params })
            {
                log::error!(
                    "Failed to route approval to session {session_id} (thread {tid}, rpc_id={id}): {e}"
                );
            }
        } else {
            log::warn!("No active session for approval request on thread {tid}");
        }
    } else {
        log::warn!("Approval request without threadId: {method}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_pid_record_roundtrip_with_socket_path() {
        let record = ServerPidRecord {
            jean_pid: 1,
            server_pid: 2,
            proxy_pid: None,
            socket_path: Some(PathBuf::from("/tmp/jean-codex.sock")),
        };
        let json = serde_json::to_string(&record).unwrap();
        let parsed: ServerPidRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.jean_pid, 1);
        assert_eq!(parsed.server_pid, 2);
        assert_eq!(
            parsed.socket_path,
            Some(PathBuf::from("/tmp/jean-codex.sock"))
        );
    }

    #[test]
    fn server_pid_record_parses_legacy_record_without_socket_path() {
        let json = r#"{"jean_pid":10,"server_pid":20}"#;
        let parsed: ServerPidRecord = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.jean_pid, 10);
        assert_eq!(parsed.server_pid, 20);
        assert!(parsed.proxy_pid.is_none());
        assert!(parsed.socket_path.is_none());
    }

    #[test]
    fn handle_server_line_routes_response_to_pending_request() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let sessions: ActiveSessions = Arc::new(Mutex::new(HashMap::new()));

        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert(7, tx);

        handle_server_line(
            r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#,
            &pending,
            &sessions,
        );

        let result = rx.blocking_recv().unwrap().unwrap();
        assert_eq!(result["ok"], true);
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn handle_server_line_routes_notification_to_session_by_thread_id() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let sessions: ActiveSessions = Arc::new(Mutex::new(HashMap::new()));

        let (event_tx, event_rx) = std::sync::mpsc::channel();
        sessions.lock().unwrap().insert(
            "thread-1".to_string(),
            SessionContext {
                session_id: "session-1".to_string(),
                worktree_id: "worktree-1".to_string(),
                event_tx,
            },
        );

        handle_server_line(
            r#"{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-1"}}"#,
            &pending,
            &sessions,
        );

        match event_rx.try_recv().unwrap() {
            ServerEvent::Notification { method, params } => {
                assert_eq!(method, "turn/started");
                assert_eq!(params["threadId"], "thread-1");
            }
            other => panic!("Expected notification, got {other:?}"),
        }
    }

    /// End-to-end check of the socket transport against a real codex CLI.
    /// Requires `codex` on PATH; run manually:
    /// `cargo test --lib codex_socket_transport_e2e -- --ignored --nocapture`
    #[test]
    #[ignore]
    #[cfg(unix)]
    fn codex_socket_transport_e2e() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        tauri::async_runtime::set(rt.handle().clone());

        let codex = which::which("codex").expect("codex CLI on PATH");
        let tmp = tempfile::tempdir().unwrap();
        let tmp_path = tmp.path().canonicalize().unwrap();
        let socket_path = tmp_path.join("e2e.sock");
        let log_path = tmp_path.join("e2e.log");

        let args = vec![
            "app-server".to_string(),
            "--listen".to_string(),
            format!("unix://{}", socket_path.display()),
        ];
        let pid =
            super::super::detached::spawn_detached_process(&codex, &args, &log_path, &tmp_path)
                .expect("spawn detached server");

        wait_for_socket_ready(
            &socket_path,
            pid,
            &log_path,
            std::time::Duration::from_secs(15),
        )
        .expect("socket ready");

        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let sessions: ActiveSessions = Arc::new(Mutex::new(HashMap::new()));
        let dead = Arc::new(AtomicBool::new(false));

        let outgoing_tx = connect_socket_transport(
            &socket_path,
            pid,
            pending.clone(),
            sessions.clone(),
            dead.clone(),
        )
        .expect("connect");

        // initialize round-trip through the real transport
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert(1, tx);
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {"name": "jean-test", "title": "Jean Test", "version": "0.0.0"},
                "capabilities": {"experimentalApi": true}
            },
        });
        outgoing_tx
            .send(tokio_tungstenite::tungstenite::Message::text(
                serde_json::to_string(&request).unwrap(),
            ))
            .expect("send initialize");

        let response = rx.blocking_recv().expect("response").expect("init ok");
        assert!(response.get("userAgent").is_some(), "got: {response}");
        assert!(!dead.load(Ordering::SeqCst));

        // Kill the server tree (node wrapper + native child); the reader task
        // must mark the connection dead.
        let _ = crate::platform::kill_process_tree(pid);
        let _ = crate::platform::kill_process(pid);
        let start = std::time::Instant::now();
        while !dead.load(Ordering::SeqCst) {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "connection not marked dead after server kill"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    #[test]
    fn fail_connection_notifies_sessions_and_fails_pending_once() {
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let sessions: ActiveSessions = Arc::new(Mutex::new(HashMap::new()));
        let dead = Arc::new(AtomicBool::new(false));

        let (event_tx, event_rx) = std::sync::mpsc::channel();
        sessions.lock().unwrap().insert(
            "thread-1".to_string(),
            SessionContext {
                session_id: "session-1".to_string(),
                worktree_id: "worktree-1".to_string(),
                event_tx,
            },
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.lock().unwrap().insert(1, tx);

        fail_connection(&pending, &sessions, &dead);

        assert!(dead.load(Ordering::SeqCst));
        assert!(matches!(
            event_rx.try_recv().unwrap(),
            ServerEvent::ServerDied
        ));
        assert!(rx.blocking_recv().unwrap().is_err());

        // Second call is a no-op (no panic, no duplicate events)
        fail_connection(&pending, &sessions, &dead);
        assert!(event_rx.try_recv().is_err());
    }
}
