use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use tauri::AppHandle;

use super::claude::CancelledEvent;
use super::run_log;
use super::storage;
use crate::http_server::EmitExt;

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

    let event = CancelledEvent {
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        undo_send,
        emitted_at_ms,
    };
    if let Err(e) = app.emit_all("chat:cancelled", &event) {
        log::error!("Failed to emit chat:cancelled event: {e}");
    }
}

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

/// Remove a process from the registry (called after completion or cancellation)
pub fn unregister_process(session_id: &str) {
    let mut registry = lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY");
    if let Some(pid) = registry.remove(session_id) {
        log::trace!("Unregistered Claude process {pid} for session: {session_id}");
    }
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

/// Remove all registry state for a session after a backend crash or thread panic.
pub fn cleanup_session_registrations(session_id: &str) {
    let removed_pid = lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY").remove(session_id);
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

/// Check if a session has a running process
#[allow(dead_code)]
pub fn is_process_running(session_id: &str) -> bool {
    lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY").contains_key(session_id)
}

/// Get all session IDs that currently have running processes
pub fn get_running_sessions() -> Vec<String> {
    lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY")
        .keys()
        .cloned()
        .collect()
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

/// Check if a specific session is actively managed (has a running process, cancel flag, or codex turn).
/// Used by resume_session to avoid starting a duplicate tail.
pub fn is_session_actively_managed(session_id: &str) -> bool {
    lock_recover(&PROCESS_REGISTRY, "PROCESS_REGISTRY").contains_key(session_id)
        || lock_recover(&CANCEL_FLAGS, "CANCEL_FLAGS").contains_key(session_id)
        || lock_recover(&CODEX_TURN_REGISTRY, "CODEX_TURN_REGISTRY").contains_key(session_id)
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

    if let Some(pid) = pid {
        // SAFETY: Never kill PID 0 (would kill our own process group) or PID 1 (init/launchd)
        if pid == 0 || pid == 1 {
            log::error!("Refusing to kill dangerous PID: {pid}");
            return Err(format!("Invalid PID: {pid}"));
        }

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
        // This makes the in-flight blocking POST return immediately.
        if let Some(oc_sid) = entry.opencode_session_id {
            if let Some(base_url) = crate::opencode_server::get_current_url() {
                let interrupt_url = format!("{base_url}/session/{oc_sid}/interrupt");
                let working_dir = entry.working_dir.clone();
                std::thread::spawn(move || {
                    log::info!("OpenCode: sending interrupt to {interrupt_url}");
                    let client = reqwest::blocking::Client::builder()
                        .timeout(std::time::Duration::from_secs(5))
                        .build();
                    match client {
                        Ok(c) => {
                            let mut request = c.post(&interrupt_url);
                            if let Some(dir) = working_dir {
                                request = request.query(&[("directory", dir)]);
                            }
                            match request.send() {
                                Ok(resp) => {
                                    log::info!(
                                        "OpenCode interrupt response: status={}",
                                        resp.status()
                                    )
                                }
                                Err(e) => log::warn!("OpenCode interrupt request failed: {e}"),
                            }
                        }
                        Err(e) => log::warn!("OpenCode interrupt client build failed: {e}"),
                    }
                });
            } else {
                log::warn!("OpenCode: no server URL available for interrupt");
            }
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

    if let Some(pid) = pid {
        if pid == 0 || pid == 1 {
            log::error!("Refusing to kill dangerous PID: {pid}");
            return Err(format!("Invalid PID: {pid}"));
        }

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

        // Fire-and-forget interrupt
        if let Some(oc_sid) = entry.opencode_session_id {
            if let Some(base_url) = crate::opencode_server::get_current_url() {
                let interrupt_url = format!("{base_url}/session/{oc_sid}/interrupt");
                let working_dir = entry.working_dir.clone();
                std::thread::spawn(move || {
                    log::info!("OpenCode: sending interrupt to {interrupt_url}");
                    let client = reqwest::blocking::Client::builder()
                        .timeout(std::time::Duration::from_secs(5))
                        .build();
                    if let Ok(c) = client {
                        let mut request = c.post(&interrupt_url);
                        if let Some(dir) = working_dir {
                            request = request.query(&[("directory", dir)]);
                        }
                        let _ = request.send();
                    }
                });
            }
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
