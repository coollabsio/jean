use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use super::claude::CancelledEvent;
use super::run_log;
use super::storage;
use crate::http_server::EmitExt;
use once_cell::sync::Lazy;
use tauri::AppHandle;

/// Global registry of running Claude process PIDs by session_id
/// Allows cancellation of in-progress chat requests via SIGKILL
/// Key is session_id (not worktree_id) to support multiple concurrent sessions per worktree
static PROCESS_REGISTRY: Lazy<Mutex<HashMap<String, u32>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Sessions where cancel was requested before the CLI process was registered.
/// When `register_process` is called for a pending session, the process is killed immediately.
static PENDING_CANCELS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Cancel flags for OpenCode sessions (HTTP-based, no PID to kill).
/// When cancel is requested, the flag is set so the blocking HTTP thread can detect it.
/// Stores the cancel flag plus request context needed for server-side interrupt.
#[derive(Clone)]
struct OpenCodeCancelEntry {
    flag: Arc<AtomicBool>,
    opencode_session_id: Option<String>,
    working_dir: Option<String>,
}

static CANCEL_FLAGS: Lazy<Mutex<HashMap<String, OpenCodeCancelEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Codex app-server turn registry: maps session_id → (thread_id, turn_id).
/// Used to send `turn/interrupt` on cancellation instead of killing a process.
static CODEX_TURN_REGISTRY: Lazy<Mutex<HashMap<String, (String, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Sessions in PROCESS_REGISTRY whose process is fully detached (survives Jean
/// quitting). Claude CLI and host-backed Pi/Grok/Kimi runs are detached.
static DETACHED_SESSIONS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

fn lock_recover<'a, T>(mutex: &'a Mutex<T>, name: &str) -> std::sync::MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::error!("[Registry] recovering poisoned mutex: {name}");
            poisoned.into_inner()
        }
    }
}

fn emit_cancelled_event(app: &AppHandle, session_id: &str, worktree_id: &str, undo_send: bool) {
    let emitted_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let run_id = super::storage::load_metadata(app, session_id)
        .ok()
        .flatten()
        .and_then(|metadata| metadata.runs.last().map(|run| run.run_id.clone()));

    let event = CancelledEvent {
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        undo_send,
        emitted_at_ms,
        run_id,
    };
    if let Err(e) = app.emit_all("chat:cancelled", &event) {
        log::error!("Failed to emit chat:cancelled event: {e}");
    }
}

#[cfg(unix)]
fn try_abort_pi_rpc_host(app: &AppHandle, session_id: &str) {
    let run_id = super::storage::load_metadata(app, session_id)
        .ok()
        .flatten()
        .and_then(|metadata| {
            metadata
                .runs
                .iter()
                .rev()
                .find(|run| {
                    run.status == super::types::RunStatus::Running
                        && run.backend == Some(super::types::Backend::Pi)
                })
                .map(|run| run.run_id.clone())
        });
    let Some(run_id) = run_id else { return };
    let Ok(app_data) = app.path().app_data_dir() else {
        log::warn!("Failed to resolve app data dir for Pi RPC abort");
        return;
    };
    let socket_path = super::pi::pi_rpc_socket_path(&app_data, session_id, &run_id);
    let line = super::pi::serialize_pi_rpc_command("abort", None, Some(&format!("abort-{run_id}")));
    if let Err(e) = super::pi::send_pi_rpc_host_command(&socket_path, &line) {
        log::warn!("Failed to send Pi RPC abort before kill for session {session_id}: {e}");
    }
}

#[cfg(not(unix))]
fn try_abort_pi_rpc_host(_app: &AppHandle, _session_id: &str) {}

#[cfg(unix)]
fn try_abort_grok_acp_host(app: &AppHandle, session_id: &str) {
    let run_id = super::storage::load_metadata(app, session_id)
        .ok()
        .flatten()
        .and_then(|metadata| {
            metadata
                .runs
                .iter()
                .rev()
                .find(|run| {
                    run.status == super::types::RunStatus::Running
                        && run.backend == Some(super::types::Backend::Grok)
                })
                .map(|run| run.run_id.clone())
        });
    let Some(run_id) = run_id else { return };
    let Ok(app_data) = app.path().app_data_dir() else {
        log::warn!("Failed to resolve app data dir for Grok ACP abort");
        return;
    };
    let socket_path = super::grok::grok_acp_socket_path(&app_data, session_id, &run_id);
    let line =
        super::grok::serialize_grok_host_command("abort", None, Some(&format!("abort-{run_id}")));
    if let Err(e) = super::grok::send_grok_acp_host_command(&socket_path, &line) {
        log::warn!("Failed to send Grok ACP abort before kill for session {session_id}: {e}");
    }
}

#[cfg(not(unix))]
fn try_abort_grok_acp_host(_app: &AppHandle, _session_id: &str) {}

#[cfg(unix)]
fn try_abort_kimi_acp_host(app: &AppHandle, session_id: &str) {
    let run_id = super::storage::load_metadata(app, session_id)
        .ok()
        .flatten()
        .and_then(|metadata| {
            metadata
                .runs
                .iter()
                .rev()
                .find(|run| {
                    run.status == super::types::RunStatus::Running
                        && run.backend == Some(super::types::Backend::Kimi)
                })
                .map(|run| run.run_id.clone())
        });
    let Some(run_id) = run_id else { return };
    let Ok(app_data) = app.path().app_data_dir() else {
        log::warn!("Failed to resolve app data dir for Kimi ACP abort");
        return;
    };
    let socket_path = super::kimi::kimi_acp_socket_path(&app_data, session_id, &run_id);
    let line = super::kimi::serialize_kimi_host_command("abort", None);
    if let Err(error) = super::kimi::send_kimi_acp_host_command(&socket_path, &line) {
        log::warn!("Failed to send Kimi ACP abort before kill for session {session_id}: {error}");
    }
}

#[cfg(not(unix))]
fn try_abort_kimi_acp_host(_app: &AppHandle, _session_id: &str) {}

/// Register a running Claude process PID for a session.
/// Returns `false` if the session was cancelled before registration (process is killed immediately).
pub fn register_process(session_id: String, pid: u32) -> bool {
    // Check pending cancels first
    {
        let mut pending = lock_recover(&PENDING_CANCELS, "PENDING_CANCELS");
        log::info!(
            "[Registry] register_process session={session_id} pid={pid} pending_cancels={:?}",
            pending.iter().collect::<Vec<_>>()
        );
        if pending.remove(&session_id) {
            log::warn!(
                "[Registry] Session {session_id} was cancelled before process registered, killing PID {pid}"
            );
            use crate::platform::{kill_process, kill_process_tree};
            let _ = kill_process_tree(pid);
            let _ = kill_process(pid);
            return false;
        }
    }

    let mut registry = lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY");
    log::info!(
        "[Registry] Registering process pid={pid} for session={session_id}, registry_keys={:?}",
        registry.keys().collect::<Vec<_>>()
    );
    registry.insert(session_id, pid);
    true
}

/// Register a running detached process PID for a session (e.g. Claude CLI).
/// Detached processes survive Jean quitting, so they don't block app exit.
/// Returns `false` if the session was cancelled before registration.
pub fn register_detached_process(session_id: String, pid: u32) -> bool {
    let registered = register_process(session_id.clone(), pid);
    if registered {
        lock_recover(&DETACHED_SESSIONS, "DETACHED_SESSIONS").insert(session_id);
    }
    registered
}

/// Remove a process from the registry (called after completion or cancellation)
pub fn unregister_process(session_id: &str) {
    let mut registry = lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY");
    if let Some(pid) = registry.remove(session_id) {
        log::trace!("Unregistered Claude process {pid} for session: {session_id}");
    }
    drop(registry);
    lock_recover(&DETACHED_SESSIONS, "DETACHED_SESSIONS").remove(session_id);
}

/// Register a cancellation flag for an OpenCode session.
/// Returns `false` if the session was already cancelled (flag is set immediately).
pub fn register_cancel_flag(session_id: String, flag: Arc<AtomicBool>) -> bool {
    // Check pending cancels: if cancel was requested before we registered, cancel immediately
    {
        let mut pending = lock_recover(&PENDING_CANCELS, "PENDING_CANCELS");
        if pending.remove(&session_id) {
            log::warn!(
                "Session {session_id} was cancelled before cancel flag registered, setting flag"
            );
            flag.store(true, Ordering::SeqCst);
            return false;
        }
    }

    lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS").insert(
        session_id,
        OpenCodeCancelEntry {
            flag,
            opencode_session_id: None,
            working_dir: None,
        },
    );
    true
}

/// Update the OpenCode session ID and working directory for a registered cancel flag.
/// Called after the OpenCode session is created so that `cancel_process` can
/// send a server-side interrupt request.
pub fn update_cancel_flag_context(
    session_id: &str,
    opencode_session_id: String,
    working_dir: String,
) {
    let mut flags = lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS");
    if let Some(entry) = flags.get_mut(session_id) {
        entry.opencode_session_id = Some(opencode_session_id);
        entry.working_dir = Some(working_dir);
    }
}

/// The OpenCode session id of the CURRENTLY RUNNING turn for this Jean session,
/// as recorded by `update_cancel_flag_context`. Available mid-run — including the
/// first turn of a brand-new session, before the id is persisted to session
/// metadata — so steering can resolve the live session id.
pub fn get_opencode_session_id(session_id: &str) -> Option<String> {
    lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS")
        .get(session_id)
        .and_then(|entry| entry.opencode_session_id.clone())
}

/// Fire-and-forget server-side abort for a running OpenCode session.
///
/// OpenCode exposes `POST /session/{id}/abort`. Jean still keeps a local
/// cancellation flag so the in-process request can return promptly even if
/// the server abort request is slow or fails.
pub fn abort_opencode_session(opencode_session_id: String, working_dir: Option<String>) {
    std::thread::spawn(move || {
        let Some(base_url) = crate::opencode_server::get_current_url() else {
            log::warn!("OpenCode: no server URL available for abort");
            return;
        };

        let abort_url = format!("{base_url}/session/{opencode_session_id}/abort");
        log::info!("OpenCode: sending abort to {abort_url}");
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build();
        match client {
            Ok(c) => {
                let mut request = c.post(&abort_url);
                if let Some(dir) = working_dir {
                    request = request.query(&[("directory", dir)]);
                }
                match request.send() {
                    Ok(resp) => log::info!("OpenCode abort response: status={}", resp.status()),
                    Err(e) => log::warn!("OpenCode abort request failed: {e}"),
                }
            }
            Err(e) => log::warn!("OpenCode abort client build failed: {e}"),
        }
    });
}

/// Register a Codex app-server turn for a session.
/// Returns `false` if the session was already pending cancellation.
pub fn register_codex_turn(session_id: String, thread_id: String, turn_id: String) -> bool {
    // Check pending cancels first
    {
        let mut pending = lock_recover(&PENDING_CANCELS, "PENDING_CANCELS");
        if pending.remove(&session_id) {
            log::warn!("Session {session_id} was cancelled before turn registered, interrupting");
            let tid = thread_id.clone();
            let tuid = turn_id.clone();
            std::thread::spawn(move || {
                let _ = super::codex_server::interrupt_turn(&tid, &tuid);
            });
            return false;
        }
    }

    lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY")
        .insert(session_id, (thread_id, turn_id));
    true
}

/// Remove a Codex app-server turn from the registry (called after turn completion).
pub fn unregister_codex_turn(session_id: &str) {
    lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY").remove(session_id);
}

/// Get the registered Codex (thread_id, turn_id) for a session, if any.
/// Used by `turn/steer` to inject user input into the active turn.
pub fn get_codex_turn(session_id: &str) -> Option<(String, String)> {
    lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY")
        .get(session_id)
        .cloned()
}

/// Remove all registry state for a session after a backend crash or thread panic.
pub fn cleanup_session_registrations(session_id: &str) {
    let removed_pid = lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY").remove(session_id);
    lock_recover(&DETACHED_SESSIONS, "DETACHED_SESSIONS").remove(session_id);
    let removed_pending = lock_recover(&PENDING_CANCELS, "PENDING_CANCELS").remove(session_id);
    let removed_flag = lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS")
        .remove(session_id)
        .is_some();
    let removed_turn = lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY")
        .remove(session_id)
        .is_some();

    if removed_pid.is_some() || removed_pending || removed_flag || removed_turn {
        log::warn!(
            "[Registry] cleaned stale state for session={session_id} pid={removed_pid:?} pending={removed_pending} cancel_flag={removed_flag} codex_turn={removed_turn}"
        );
    }
}

/// Clear only a queued pre-registration cancel for an otherwise idle session.
/// Used before starting a fresh send so stale pending cancel state from a
/// previous idle-cancel race cannot poison the next run.
pub fn clear_pending_cancel(session_id: &str) -> bool {
    lock_recover(&PENDING_CANCELS, "PENDING_CANCELS").remove(session_id)
}

/// Check if a session has a running process
#[allow(dead_code)]
pub fn is_process_running(session_id: &str) -> bool {
    lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY").contains_key(session_id)
}

/// Get all session IDs that currently have running processes
pub fn get_running_sessions() -> Vec<String> {
    let mut sessions: Vec<String> = get_actively_managed_sessions().into_iter().collect();
    sessions.sort();
    sessions
}

/// Get all session IDs that are actively managed (running process, cancel flag, or codex turn).
/// Used by recover_incomplete_runs to skip sessions that don't need recovery.
pub fn get_actively_managed_sessions() -> HashSet<String> {
    let mut sessions: HashSet<String> = lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY")
        .keys()
        .cloned()
        .collect();
    sessions.extend(lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS").keys().cloned());
    sessions.extend(
        lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY")
            .keys()
            .cloned(),
    );
    sessions
}

/// Check if any running session would NOT survive Jean quitting.
///
/// Survivable: detached Claude CLI processes, host-backed Pi/Grok/Kimi ACP hosts,
/// and Codex app-server turns on Unix (server/host runs independently of Jean).
/// Non-survivable: OpenCode sessions (managed server dies with Jean), piped
/// CLI children (Cursor, Windows Grok/Pi/Kimi), and Codex turns on Windows.
pub fn has_nonsurvivable_running_sessions() -> bool {
    if !lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS").is_empty() {
        return true;
    }

    if cfg!(not(unix)) && !lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY").is_empty() {
        return true;
    }

    let detached = lock_recover(&DETACHED_SESSIONS, "DETACHED_SESSIONS");
    lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY")
        .keys()
        .any(|session_id| !detached.contains(session_id))
}

/// Check if a specific session is actively managed (has a running process, cancel flag, or codex turn).
/// Used by resume_session to avoid starting a duplicate tail.
pub fn is_session_actively_managed(session_id: &str) -> bool {
    lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY").contains_key(session_id)
        || lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS").contains_key(session_id)
        || lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY").contains_key(session_id)
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    static TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn clear_registries() {
        lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY").clear();
        lock_recover(&PENDING_CANCELS, "PENDING_CANCELS").clear();
        lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS").clear();
        lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY").clear();
    }

    #[test]
    fn get_running_sessions_includes_all_backend_registries() {
        let _guard = lock_recover(&TEST_LOCK, "TEST_LOCK");
        clear_registries();

        assert!(register_process("claude-session".to_string(), 4242));
        assert!(register_cancel_flag(
            "opencode-session".to_string(),
            Arc::new(AtomicBool::new(false))
        ));
        assert!(register_codex_turn(
            "codex-session".to_string(),
            "thread-1".to_string(),
            "turn-1".to_string()
        ));

        let running = get_running_sessions();
        assert_eq!(
            running,
            vec![
                "claude-session".to_string(),
                "codex-session".to_string(),
                "opencode-session".to_string()
            ]
        );

        clear_registries();
    }

    #[test]
    fn get_opencode_session_id_returns_live_id_after_context_update() {
        let _guard = lock_recover(&TEST_LOCK, "TEST_LOCK");
        clear_registries();

        // Before the run registers, there is no live id.
        assert_eq!(get_opencode_session_id("oc-session"), None);

        assert!(register_cancel_flag(
            "oc-session".to_string(),
            Arc::new(AtomicBool::new(false))
        ));
        // Registered but no OpenCode session id yet (first-turn window).
        assert_eq!(get_opencode_session_id("oc-session"), None);

        update_cancel_flag_context("oc-session", "ses_live_123".to_string(), "/tmp".to_string());
        assert_eq!(
            get_opencode_session_id("oc-session"),
            Some("ses_live_123".to_string())
        );

        clear_registries();
    }

    #[test]
    fn get_codex_turn_returns_registered_pair() {
        let _guard = lock_recover(&TEST_LOCK, "TEST_LOCK");
        clear_registries();

        assert!(register_codex_turn(
            "codex-session".to_string(),
            "thread-1".to_string(),
            "turn-1".to_string()
        ));

        assert_eq!(
            get_codex_turn("codex-session"),
            Some(("thread-1".to_string(), "turn-1".to_string()))
        );
        assert_eq!(get_codex_turn("unknown-session"), None);

        unregister_codex_turn("codex-session");
        assert_eq!(get_codex_turn("codex-session"), None);

        clear_registries();
    }

    #[test]
    fn cleanup_session_registrations_clears_opencode_active_flag() {
        let _guard = lock_recover(&TEST_LOCK, "TEST_LOCK");
        clear_registries();

        assert!(register_cancel_flag(
            "opencode-session".to_string(),
            Arc::new(AtomicBool::new(false))
        ));
        assert!(is_session_actively_managed("opencode-session"));

        cleanup_session_registrations("opencode-session");

        assert!(!is_session_actively_managed("opencode-session"));

        clear_registries();
    }

    #[test]
    fn clear_pending_cancel_leaves_active_registrations_intact() {
        let _guard = lock_recover(&TEST_LOCK, "TEST_LOCK");
        clear_registries();

        assert!(register_cancel_flag(
            "active-session".to_string(),
            Arc::new(AtomicBool::new(false))
        ));
        lock_recover(&PENDING_CANCELS, "PENDING_CANCELS").insert("active-session".to_string());

        assert!(clear_pending_cancel("active-session"));
        assert!(is_session_actively_managed("active-session"));

        clear_registries();
    }
}

/// Cancel a running Claude process for a session by sending SIGKILL to the process group
/// Returns true if a process was found and signal sent, false otherwise
///
/// SAFETY: We kill the entire process group (negative PID) to ensure all child processes
/// spawned by Claude CLI are also terminated. This is safe because:
/// 1. Claude is spawned with process_group(0), creating a NEW group separate from Jean
/// 2. We guard against dangerous PIDs (0, 1) that could affect system processes
pub fn cancel_process(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Result<bool, String> {
    log::warn!("cancel_process called for session: {session_id}");
    let pid = {
        let mut registry = lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY");
        log::warn!("Registry state: {:?}", registry.iter().collect::<Vec<_>>());
        registry.remove(session_id)
    };
    lock_recover(&DETACHED_SESSIONS, "DETACHED_SESSIONS").remove(session_id);

    if let Some(pid) = pid {
        // SAFETY: Never kill PID 0 (would kill our own process group) or PID 1 (init/launchd)
        if pid == 0 || pid == 1 {
            log::error!("Refusing to kill dangerous PID: {pid}");
            return Err(format!("Invalid PID: {pid}"));
        }

        try_abort_pi_rpc_host(app, session_id);
        try_abort_grok_acp_host(app, session_id);
        try_abort_kimi_acp_host(app, session_id);
        log::trace!("Cancelling Claude process group {pid} for session: {session_id}");

        // Kill the entire process tree to ensure child processes are also terminated
        // Uses platform-specific implementation from the platform module
        use crate::platform::{is_process_alive, kill_process, kill_process_tree};

        log::trace!("Killing process tree for pid={pid}");

        // First, check if the process exists
        if !is_process_alive(pid) {
            log::warn!("Process {pid} check failed (may have exited)");
        } else {
            log::trace!("Process {pid} exists, proceeding with kill");
        }

        // Kill the process tree (process group on Unix, taskkill /T on Windows)
        if let Err(e) = kill_process_tree(pid) {
            log::error!("Failed to kill process tree for pid={pid}: {e}");
        } else {
            log::trace!("Successfully sent kill to process tree pid={pid}");
        }

        // Also try killing the process directly as fallback
        if let Err(e) = kill_process(pid) {
            log::trace!("Direct kill of pid={pid} failed (may be redundant): {e}");
        } else {
            log::trace!("Direct kill of pid={pid} succeeded");
        }

        // Update manifest SYNCHRONOUSLY before emitting event
        // This ensures any frontend refetch sees "Cancelled" status, not "Running"
        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        // Emit cancelled event for responsive UI
        emit_cancelled_event(app, session_id, worktree_id, false);

        return Ok(true);
    }

    let codex_turn = {
        let mut registry = lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY");
        registry.remove(session_id)
    };
    if let Some((thread_id, turn_id)) = codex_turn {
        // Codex app-server session: send turn/interrupt
        // Must run on a separate thread because interrupt_turn uses blocking_recv,
        // which panics if called from within a tokio async runtime.
        log::warn!("Codex app-server session {session_id}: interrupting turn {turn_id}");
        std::thread::spawn(move || {
            if let Err(e) = super::codex_server::interrupt_turn(&thread_id, &turn_id) {
                log::error!("Failed to interrupt Codex turn: {e}");
            }
        });

        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        emit_cancelled_event(app, session_id, worktree_id, false);

        return Ok(true);
    }

    let flag_entry = {
        lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS")
            .get(session_id)
            .cloned()
    };
    if let Some(entry) = flag_entry {
        // OpenCode session: set the cancel flag so the HTTP thread detects it
        log::warn!("OpenCode session {session_id}: setting cancel flag");
        entry.flag.store(true, Ordering::SeqCst);

        // Fire-and-forget: call the OpenCode interrupt endpoint to abort server-side processing.
        // The in-process OpenCode request also watches the cancel flag and drops
        // its HTTP future so Jean can unregister the session promptly.
        if let Some(oc_sid) = entry.opencode_session_id {
            abort_opencode_session(oc_sid, entry.working_dir.clone());
        }

        // Mark run as cancelled immediately (before HTTP call returns)
        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        // Emit cancelled event with undo_send=false — content may have already
        // streamed to the frontend via SSE events. The frontend will decide
        // based on actual streamed content whether to undo or preserve.
        emit_cancelled_event(app, session_id, worktree_id, false);

        return Ok(true);
    }

    // Process not yet registered — queue for pending cancellation.
    // When register_process or register_cancel_flag is called later, the cancel is applied immediately.
    {
        let mut pending = lock_recover(&PENDING_CANCELS, "PENDING_CANCELS");
        log::warn!("[Registry] cancel_process: no PID/flag for session={session_id}, adding to PENDING_CANCELS (before={:?})", pending.iter().collect::<Vec<_>>());
        pending.insert(session_id.to_string());
    }

    // Try to mark run as cancelled (may not exist yet if still preparing, that's ok)
    let _ = run_log::mark_running_run_cancelled(app, session_id);

    // Emit cancelled event so frontend handles it immediately
    emit_cancelled_event(app, session_id, worktree_id, true);

    Ok(true)
}

/// Cancel a running Claude process only if one is actively registered.
/// Unlike `cancel_process`, this does NOT add to PENDING_CANCELS and does NOT emit
/// `chat:cancelled` when the session is idle. Safe to call on idle sessions during
/// close/archive operations to avoid spurious "Request cancelled" events.
pub fn cancel_process_if_running(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Result<bool, String> {
    let pid = {
        let mut registry = lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY");
        registry.remove(session_id)
    };
    lock_recover(&DETACHED_SESSIONS, "DETACHED_SESSIONS").remove(session_id);

    if let Some(pid) = pid {
        if pid == 0 || pid == 1 {
            log::error!("Refusing to kill dangerous PID: {pid}");
            return Err(format!("Invalid PID: {pid}"));
        }

        try_abort_pi_rpc_host(app, session_id);
        try_abort_grok_acp_host(app, session_id);
        try_abort_kimi_acp_host(app, session_id);
        log::trace!("Cancelling Claude process group {pid} for session: {session_id}");

        use crate::platform::{is_process_alive, kill_process, kill_process_tree};

        if !is_process_alive(pid) {
            log::warn!("Process {pid} check failed (may have exited)");
        }

        if let Err(e) = kill_process_tree(pid) {
            log::error!("Failed to kill process tree for pid={pid}: {e}");
        }
        let _ = kill_process(pid);

        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        emit_cancelled_event(app, session_id, worktree_id, false);

        return Ok(true);
    }

    let codex_turn = {
        let mut registry = lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY");
        registry.remove(session_id)
    };
    if let Some((thread_id, turn_id)) = codex_turn {
        // Codex app-server session actively running — interrupt turn
        // Must run on a separate thread because interrupt_turn uses blocking_recv,
        // which panics if called from within a tokio async runtime.
        log::trace!(
            "Codex app-server session {session_id} is running, interrupting turn {turn_id}"
        );
        std::thread::spawn(move || {
            if let Err(e) = super::codex_server::interrupt_turn(&thread_id, &turn_id) {
                log::error!("Failed to interrupt Codex turn: {e}");
            }
        });

        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        emit_cancelled_event(app, session_id, worktree_id, false);

        return Ok(true);
    }

    let flag_entry = {
        lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS")
            .get(session_id)
            .cloned()
    };
    if let Some(entry) = flag_entry {
        // OpenCode session actively running — set the cancel flag
        log::trace!("OpenCode session {session_id} is running, setting cancel flag");
        entry.flag.store(true, Ordering::SeqCst);

        // Fire-and-forget abort
        if let Some(oc_sid) = entry.opencode_session_id {
            abort_opencode_session(oc_sid, entry.working_dir.clone());
        }

        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        // Match the regular OpenCode cancel path: streamed SSE content may already
        // exist, so let the frontend decide whether to restore or preserve based on
        // actual partial output rather than forcing undo-send.
        emit_cancelled_event(app, session_id, worktree_id, false);

        return Ok(true);
    }

    // Session is idle — do nothing. No PENDING_CANCELS, no event emission.
    log::trace!("Session {session_id} has no running process, skipping cancel");
    Ok(false)
}

/// Cancel all running Claude processes for a given worktree
/// Called before worktree deletion to clean up orphaned processes
pub fn cancel_processes_for_worktree(app: &AppHandle, worktree_id: &str) {
    log::trace!("Cancelling all Claude processes for worktree: {worktree_id}");

    // Load sessions for this worktree from app data directory
    match storage::load_sessions_by_id(app, worktree_id) {
        Ok(sessions) => {
            let mut cancelled_count = 0;
            for session in &sessions.sessions {
                if let Ok(true) = cancel_process(app, &session.id, worktree_id) {
                    cancelled_count += 1;
                }
            }
            if cancelled_count > 0 {
                log::trace!(
                    "Cancelled {cancelled_count} Claude process(es) for worktree: {worktree_id}"
                );
            }
        }
        Err(e) => {
            // Not an error - worktree may have no sessions yet
            log::trace!("No sessions found for worktree {worktree_id}: {e}");
        }
    }
}
