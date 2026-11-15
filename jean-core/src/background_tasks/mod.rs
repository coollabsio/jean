//! Background task management for periodic operations
//!
//! This module provides a task manager that runs periodic background tasks,
//! such as checking git status for the worktree each focused UI client has selected.
//!
//! Polling is split into two categories:
//! - **Local**: Git commands that run locally (fast, can run frequently)
//! - **Remote**: API calls like PR status via `gh` (slower, rate-limited)
//!
//! Worktrees that are not fast-polled are refreshed by periodic sweeps that cover every
//! worktree each cycle with a small bounded worker pool.

use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use crate::http_server::EmitExt;
use crate::projects::git_status::{try_get_branch_status, ActiveWorktreeInfo, GitBranchStatus};
use crate::projects::pr_status::{get_pr_status, MergeableStatus, PrStatus};

pub mod commands;

// ============================================================================
// Local polling constants (git commands that run locally)
// ============================================================================

/// Local git status polling interval in seconds (10 seconds)
pub const GIT_POLL_INTERVAL: u64 = 10;

/// Minimum seconds between local polls (debounce for focus changes)
const MIN_LOCAL_POLL_DEBOUNCE: u64 = 10;

// ============================================================================
// Remote polling constants (API calls like PR status)
// ============================================================================

/// Remote polling interval in seconds (30 seconds)
pub const REMOTE_POLL_INTERVAL: u64 = 30;

// ============================================================================
// Sweep polling constants (all non-active worktrees per cycle)
// ============================================================================

/// Git status sweep interval for non-active worktrees in seconds (2 minutes)
const GIT_SWEEP_POLL_INTERVAL: u64 = 120;

/// Each git status runs ~8-10 git subprocesses; more workers risk fd exhaustion.
const GIT_SWEEP_WORKERS: usize = 4;

/// PR status sweep interval for non-active worktrees in seconds (5 minutes)
pub const DEFAULT_SWEEP_POLL_INTERVAL: u64 = 300;

/// Kept low so a sweep does not burst the GitHub quota.
const PR_SWEEP_WORKERS: usize = 2;

/// Default usage polling interval in seconds (5 minutes)
/// This refreshes Claude/Codex usage caches on the backend.
pub const DEFAULT_USAGE_POLL_INTERVAL: u64 = 300;

/// Default combined-context cleanup interval in seconds (1 hour)
pub const DEFAULT_CLEANUP_POLL_INTERVAL: u64 = 3600;

/// Wakeup scheduler tick interval (seconds). How often we scan for
/// `ScheduledWakeup` entries whose `fire_at_unix <= now`.
pub const DEFAULT_WAKEUP_POLL_INTERVAL: u64 = 10;

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn poll_interval_elapsed(now: u64, last: Option<u64>, interval_secs: u64) -> bool {
    match last {
        Some(last) => now.saturating_sub(last) >= interval_secs,
        None => true,
    }
}

type WakeSignal = Arc<(Mutex<()>, Condvar)>;

/// One connected UI: the native app or one WebSocket connection. Focus and
/// the selected (active) worktree are tracked per client.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UiClient {
    Native,
    Ws(u64),
}

/// Which clients currently have focus. Polling runs while any client is
/// focused, or before any client has reported (headless server with no UI yet).
#[derive(Debug, Default)]
enum FocusState {
    #[default]
    Unreported,
    Reported(HashSet<UiClient>),
}

impl FocusState {
    fn is_focused(&self) -> bool {
        match self {
            FocusState::Unreported => true,
            FocusState::Reported(focused) => !focused.is_empty(),
        }
    }

    fn is_client_focused(&self, client: UiClient) -> bool {
        match self {
            FocusState::Unreported => true,
            FocusState::Reported(focused) => focused.contains(&client),
        }
    }

    fn report(&mut self, client: UiClient, focused: bool) {
        if matches!(self, FocusState::Unreported) {
            *self = FocusState::Reported(HashSet::new());
        }
        if let FocusState::Reported(clients) = self {
            if focused {
                clients.insert(client);
            } else {
                clients.remove(&client);
            }
        }
    }

    fn remove(&mut self, client: UiClient) {
        if let FocusState::Reported(clients) = self {
            clients.remove(&client);
        }
    }
}

/// Active worktrees of focused clients (every client's before any focus is
/// reported), one entry per worktree id. These get fast polling; every other
/// worktree is left to the sweeps.
fn fast_poll_targets(
    focus: &FocusState,
    active: &HashMap<UiClient, ActiveWorktreeInfo>,
) -> Vec<ActiveWorktreeInfo> {
    let mut targets: Vec<ActiveWorktreeInfo> = active
        .iter()
        .filter(|(client, _)| focus.is_client_focused(**client))
        .map(|(_, info)| info.clone())
        .collect();
    targets.sort_by(|a, b| a.worktree_id.cmp(&b.worktree_id));
    targets.dedup_by(|a, b| a.worktree_id == b.worktree_id);
    targets
}

/// Worktrees the sweeps refresh: all of them except the fast-poll targets.
fn sweep_candidates(
    worktrees: &[ActiveWorktreeInfo],
    targets: &[ActiveWorktreeInfo],
) -> Vec<ActiveWorktreeInfo> {
    worktrees
        .iter()
        .filter(|w| !targets.iter().any(|t| t.worktree_id == w.worktree_id))
        .cloned()
        .collect()
}

/// Run `f` over `items` on at most `workers` threads, returning when all finish.
pub(crate) fn for_each_bounded<T: Send>(items: Vec<T>, workers: usize, f: impl Fn(T) + Sync) {
    let worker_count = workers.max(1).min(items.len());
    let queue = Mutex::new(items.into_iter());
    thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| loop {
                let next = queue.lock().unwrap_or_else(|e| e.into_inner()).next();
                let Some(item) = next else { break };
                f(item);
            });
        }
    });
}

/// Clears an in-flight flag on drop, so a panicking sweep cannot block later sweeps.
struct InFlightGuard(Arc<AtomicBool>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Start `sweep` on its own thread unless the previous run is still in flight.
fn spawn_sweep(in_flight: &Arc<AtomicBool>, sweep: impl FnOnce() + Send + 'static) -> bool {
    if in_flight.swap(true, Ordering::AcqRel) {
        return false;
    }
    let guard = InFlightGuard(Arc::clone(in_flight));
    thread::spawn(move || {
        let _guard = guard;
        sweep();
    });
    true
}

fn sweep_git_status(app: &AppHandle, worktrees: Vec<ActiveWorktreeInfo>) {
    for_each_bounded(worktrees, GIT_SWEEP_WORKERS, |worktree| {
        log::trace!(
            "Git sweep: polling git status for worktree {}",
            worktree.worktree_id
        );
        match try_get_branch_status(&worktree) {
            Ok(Some(status)) => {
                if let Err(e) = emit_git_status(app, status) {
                    log::error!("Git sweep: failed to emit git status: {e}");
                }
            }
            Ok(None) => {
                log::trace!(
                    "Git sweep: skipping overlapping status poll for {}",
                    worktree.worktree_id
                );
            }
            Err(e) => {
                log::warn!(
                    "Git sweep: failed git status for {}: {e}",
                    worktree.worktree_id
                );
            }
        }
    });
}

fn sweep_pr_status(app: &AppHandle, worktrees: Vec<ActiveWorktreeInfo>) {
    for_each_bounded(worktrees, PR_SWEEP_WORKERS, |worktree| {
        let (Some(pr_num), Some(pr_url)) = (worktree.pr_number, &worktree.pr_url) else {
            return;
        };
        log::trace!(
            "Sweep: polling PR #{pr_num} for worktree {}",
            worktree.worktree_id
        );
        match get_pr_status(
            app,
            &worktree.worktree_path,
            pr_num,
            pr_url,
            &worktree.worktree_id,
        ) {
            Ok(status) => {
                if let Err(e) = emit_pr_status(app, status) {
                    log::error!("Sweep: failed to emit PR status: {e}");
                }
            }
            Err(e) => {
                log::warn!("Sweep: failed PR status for #{pr_num}: {e}");
            }
        }
    });
}

/// Seconds before the first PR status check after a push, so GitHub has seen it.
const POST_PUSH_FIRST_CHECK_SECS: u64 = 3;
/// Seconds between retries while GitHub still computes `mergeable`.
const POST_PUSH_RETRY_SECS: u64 = 5;
const POST_PUSH_MAX_CHECKS: usize = 4;

/// Refresh a worktree's PR status (including conflict state) after a push.
///
/// A push can clear or create PR conflicts, but GitHub computes `mergeable`
/// in the background, so it can be unknown for some seconds. Check again
/// until it is known, then stop. Runs on its own thread.
pub fn refresh_pr_status_after_push(
    app: &AppHandle,
    worktree_id: String,
    worktree_path: String,
    pr_number: u32,
    pr_url: String,
) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(POST_PUSH_FIRST_CHECK_SECS));
        for attempt in 1..=POST_PUSH_MAX_CHECKS {
            match get_pr_status(&app, &worktree_path, pr_number, &pr_url, &worktree_id) {
                Ok(status) => {
                    let known = !matches!(status.mergeable, Some(MergeableStatus::Unknown));
                    if let Err(e) = emit_pr_status(&app, status) {
                        log::error!("Post-push: failed to emit PR status: {e}");
                    }
                    if known {
                        return;
                    }
                }
                Err(e) => {
                    log::warn!("Post-push: failed PR status for #{pr_number}: {e}");
                    return;
                }
            }
            if attempt < POST_PUSH_MAX_CHECKS {
                thread::sleep(Duration::from_secs(POST_PUSH_RETRY_SECS));
            }
        }
    });
}

#[derive(Clone, Copy)]
struct ActivePollRequest {
    immediate_local: bool,
    immediate_remote: bool,
}

/// Fast-poll one active worktree: local git status every `GIT_POLL_INTERVAL`,
/// PR status every `REMOTE_POLL_INTERVAL` when it has a PR.
fn poll_active_worktree(
    app: &AppHandle,
    info: &ActiveWorktreeInfo,
    request: ActivePollRequest,
    last_local_poll_times: &Mutex<HashMap<String, u64>>,
    last_remote_poll_times: &Mutex<HashMap<String, u64>>,
) {
    log::trace!(
        "Polling loop: worktree={}, pr_number={:?}, pr_url={:?}",
        info.worktree_id,
        info.pr_number,
        info.pr_url
    );
    let now = now_unix_secs();

    let last_local = last_local_poll_times
        .lock()
        .unwrap()
        .get(&info.worktree_id)
        .copied();
    if should_poll_local(now, last_local, request.immediate_local, GIT_POLL_INTERVAL) {
        last_local_poll_times
            .lock()
            .unwrap()
            .insert(info.worktree_id.clone(), now);

        match try_get_branch_status(info) {
            Ok(Some(status)) => {
                log::trace!(
                    "Git status for {}: behind={}, ahead={}, has_updates={}",
                    info.worktree_id,
                    status.behind_count,
                    status.ahead_count,
                    status.has_updates
                );
                if let Err(e) = emit_git_status(app, status) {
                    log::error!("Failed to emit git status event: {e}");
                }
            }
            Ok(None) => {
                log::trace!(
                    "Skipping overlapping git status poll for {}",
                    info.worktree_id
                );
            }
            Err(e) => {
                log::warn!("Failed to get git status for {}: {e}", info.worktree_id);
            }
        }
    }

    let (Some(pr_number), Some(pr_url)) = (info.pr_number, &info.pr_url) else {
        return;
    };
    let last_remote = last_remote_poll_times
        .lock()
        .unwrap()
        .get(&info.worktree_id)
        .copied();
    let should_poll_remote =
        request.immediate_remote || poll_interval_elapsed(now, last_remote, REMOTE_POLL_INTERVAL);
    log::trace!(
        "Remote poll check: should_poll={}, is_immediate={}, interval={}s",
        should_poll_remote,
        request.immediate_remote,
        REMOTE_POLL_INTERVAL
    );
    if !should_poll_remote {
        return;
    }

    log::trace!("Polling PR status for #{pr_number}");
    last_remote_poll_times
        .lock()
        .unwrap()
        .insert(info.worktree_id.clone(), now);
    match get_pr_status(
        app,
        &info.worktree_path,
        pr_number,
        pr_url,
        &info.worktree_id,
    ) {
        Ok(status) => {
            log::trace!(
                "PR status for #{}: display_status={:?}, check_status={:?}",
                pr_number,
                status.display_status,
                status.check_status
            );
            if let Err(e) = emit_pr_status(app, status) {
                log::error!("Failed to emit PR status event: {e}");
            }
        }
        Err(e) => {
            log::warn!("Failed to get PR status for #{pr_number}: {e}");
        }
    }
}

fn should_poll_local(now: u64, last: Option<u64>, is_immediate: bool, interval_secs: u64) -> bool {
    is_immediate || poll_interval_elapsed(now, last, interval_secs)
}

fn take_immediate_poll_requests(
    immediate_poll: &AtomicBool,
    immediate_remote_poll: &AtomicBool,
) -> (bool, bool) {
    (
        immediate_poll.swap(false, Ordering::Relaxed),
        immediate_remote_poll.swap(false, Ordering::Relaxed),
    )
}

fn wait_for_wake_signal(wake_signal: &WakeSignal, duration: Duration) {
    let (lock, cvar) = &**wake_signal;
    let guard = lock.lock().unwrap();
    match cvar.wait_timeout(guard, duration) {
        Ok((_guard, _timeout)) => {}
        Err(_poisoned) => {}
    }
}

fn notify_wake_signal(wake_signal: &WakeSignal) {
    let (_, cvar) = &**wake_signal;
    cvar.notify_all();
}

fn dev_usage_poll_override_enabled() -> bool {
    match env::var("JEAN_DEV_USAGE_POLL") {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    }
}

fn usage_polling_enabled() -> bool {
    if cfg!(debug_assertions) {
        return dev_usage_poll_override_enabled();
    }
    true
}

/// Manages background tasks for the application
///
/// The task manager runs a polling loop that periodically checks git status
/// for the worktree each focused UI client has selected (see `fast_poll_targets`).
///
/// Polling is split into local (git commands) and remote (API calls) categories:
/// - Local polls run every 10s, with a short focus debounce (10s)
/// - Remote polls run on a separate, longer interval (30s)
pub struct BackgroundTaskManager {
    app: AppHandle,
    /// Lock order: `focus` before `active_worktrees`.
    focus: Arc<Mutex<FocusState>>,
    /// Cached `focus.is_focused()` for the polling loop; written only under the `focus` lock.
    is_focused: Arc<AtomicBool>,
    /// Worktree each UI client has selected.
    active_worktrees: Arc<Mutex<HashMap<UiClient, ActiveWorktreeInfo>>>,
    shutdown: Arc<AtomicBool>,
    /// Flag to trigger immediate local poll (set when worktree changes or app regains focus)
    immediate_poll: Arc<AtomicBool>,
    /// Flag to trigger immediate remote poll
    immediate_remote_poll: Arc<AtomicBool>,
    /// Per-worktree timestamps of last local poll (for debouncing focus-triggered polls)
    last_local_poll_times: Arc<Mutex<HashMap<String, u64>>>,
    /// Per-worktree timestamps of last remote poll
    last_remote_poll_times: Arc<Mutex<HashMap<String, u64>>>,
    /// All worktrees with open PRs (for sweep polling of non-active worktrees)
    pr_worktrees: Arc<Mutex<Vec<ActiveWorktreeInfo>>>,
    /// Timestamp of last sweep poll
    last_sweep_poll_time: Arc<AtomicU64>,
    pr_sweep_in_flight: Arc<AtomicBool>,
    /// All worktrees for git status sweep polling (non-active worktrees)
    all_worktrees: Arc<Mutex<Vec<ActiveWorktreeInfo>>>,
    /// Timestamp of last git sweep poll
    last_git_sweep_time: Arc<AtomicU64>,
    git_sweep_in_flight: Arc<AtomicBool>,
    /// Timestamp of last usage cache refresh poll
    last_usage_poll_time: Arc<AtomicU64>,
    /// Guard to avoid overlapping usage refresh jobs
    usage_poll_in_flight: Arc<AtomicBool>,
    /// Timestamp of last combined-context cleanup sweep
    last_cleanup_poll_time: Arc<AtomicU64>,
    /// Timestamp of last wakeup scheduler tick
    last_wakeup_poll_time: Arc<AtomicU64>,
    /// Wakes the polling loop when state changes instead of sleeping in 1s chunks.
    wake_signal: WakeSignal,
}

impl BackgroundTaskManager {
    /// Create a new background task manager
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            focus: Arc::new(Mutex::new(FocusState::Unreported)),
            is_focused: Arc::new(AtomicBool::new(FocusState::Unreported.is_focused())),
            active_worktrees: Arc::new(Mutex::new(HashMap::new())),
            shutdown: Arc::new(AtomicBool::new(false)),
            immediate_poll: Arc::new(AtomicBool::new(false)),
            immediate_remote_poll: Arc::new(AtomicBool::new(false)),
            last_local_poll_times: Arc::new(Mutex::new(HashMap::new())),
            last_remote_poll_times: Arc::new(Mutex::new(HashMap::new())),
            pr_worktrees: Arc::new(Mutex::new(Vec::new())),
            last_sweep_poll_time: Arc::new(AtomicU64::new(0)),
            pr_sweep_in_flight: Arc::new(AtomicBool::new(false)),
            all_worktrees: Arc::new(Mutex::new(Vec::new())),
            last_git_sweep_time: Arc::new(AtomicU64::new(0)),
            git_sweep_in_flight: Arc::new(AtomicBool::new(false)),
            // Initialize to "now" so startup does not trigger an immediate usage refresh.
            last_usage_poll_time: Arc::new(AtomicU64::new(now_unix_secs())),
            usage_poll_in_flight: Arc::new(AtomicBool::new(false)),
            // Initialize to "now" so startup does not trigger an immediate cleanup
            // (the startup run of cleanup_deleted_items already handles that).
            last_cleanup_poll_time: Arc::new(AtomicU64::new(now_unix_secs())),
            // Initialize to 0 so the first tick fires promptly after startup,
            // allowing any wakeups that expired while the app was closed to run.
            last_wakeup_poll_time: Arc::new(AtomicU64::new(0)),
            wake_signal: Arc::new((Mutex::new(()), Condvar::new())),
        }
    }

    /// Start the background polling loop
    ///
    /// This spawns a new thread that will periodically check git status
    /// for the active worktrees of focused clients.
    ///
    /// The polling loop handles two types of checks:
    /// - **Local**: Git commands (fast, 10s debounce on focus events)
    /// - **Remote**: PR status via `gh` (separate interval, 30s)
    pub fn start(&self) {
        log::trace!("Starting background task manager");

        let app = self.app.clone();
        let is_focused = Arc::clone(&self.is_focused);
        let focus = Arc::clone(&self.focus);
        let active_worktrees = Arc::clone(&self.active_worktrees);
        let shutdown = Arc::clone(&self.shutdown);
        let immediate_poll = Arc::clone(&self.immediate_poll);
        let immediate_remote_poll = Arc::clone(&self.immediate_remote_poll);
        let last_local_poll_times = Arc::clone(&self.last_local_poll_times);
        let last_remote_poll_times = Arc::clone(&self.last_remote_poll_times);
        let pr_worktrees = Arc::clone(&self.pr_worktrees);
        let last_sweep_poll_time = Arc::clone(&self.last_sweep_poll_time);
        let pr_sweep_in_flight = Arc::clone(&self.pr_sweep_in_flight);
        let all_worktrees = Arc::clone(&self.all_worktrees);
        let last_git_sweep_time = Arc::clone(&self.last_git_sweep_time);
        let git_sweep_in_flight = Arc::clone(&self.git_sweep_in_flight);
        let last_usage_poll_time = Arc::clone(&self.last_usage_poll_time);
        let usage_poll_in_flight = Arc::clone(&self.usage_poll_in_flight);
        let last_cleanup_poll_time = Arc::clone(&self.last_cleanup_poll_time);
        let last_wakeup_poll_time = Arc::clone(&self.last_wakeup_poll_time);
        let wake_signal = Arc::clone(&self.wake_signal);
        let usage_poll_enabled = usage_polling_enabled();

        thread::spawn(move || {
            log::trace!("Background task polling loop started");
            if cfg!(debug_assertions) {
                if usage_poll_enabled {
                    log::trace!(
                        "Background usage polling enabled in dev via JEAN_DEV_USAGE_POLL override"
                    );
                } else {
                    log::trace!("Background usage polling disabled in dev");
                }
            }

            loop {
                // Check for shutdown signal
                if shutdown.load(Ordering::Relaxed) {
                    log::trace!("Background task manager shutting down");
                    break;
                }

                // ================================================================
                // Usage polling (backend cache refresh every 5 minutes)
                // Runs independently from app focus/worktree polling.
                // ================================================================
                if usage_poll_enabled {
                    let now = now_unix_secs();
                    let last_usage = last_usage_poll_time.load(Ordering::Relaxed);
                    let time_since_usage = now.saturating_sub(last_usage);

                    if time_since_usage >= DEFAULT_USAGE_POLL_INTERVAL
                        && !usage_poll_in_flight.swap(true, Ordering::Relaxed)
                    {
                        last_usage_poll_time.store(now, Ordering::Relaxed);
                        let app_handle = app.clone();
                        let in_flight_guard = Arc::clone(&usage_poll_in_flight);
                        tauri::async_runtime::spawn(async move {
                            log::trace!("Background usage refresh tick");
                            refresh_usage_caches(&app_handle).await;
                            in_flight_guard.store(false, Ordering::Relaxed);
                        });
                    }
                }

                // ================================================================
                // Combined-context cleanup (orphan sweep every hour)
                // Runs independently from app focus/worktree polling.
                // ================================================================
                {
                    let now = now_unix_secs();
                    let last_cleanup = last_cleanup_poll_time.load(Ordering::Relaxed);
                    let time_since_cleanup = now.saturating_sub(last_cleanup);

                    if time_since_cleanup >= DEFAULT_CLEANUP_POLL_INTERVAL {
                        last_cleanup_poll_time.store(now, Ordering::Relaxed);
                        let app_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            log::trace!("Background cleanup tick (combined-contexts)");
                            match crate::chat::storage::cleanup_orphaned_combined_contexts(
                                &app_handle,
                            ) {
                                Ok(deleted) => {
                                    if deleted > 0 {
                                        log::debug!(
                                            "Background cleanup: removed {deleted} orphaned combined-context files"
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::warn!("Background combined-context cleanup failed: {e}");
                                }
                            }
                        });
                    }
                }

                // ================================================================
                // Wakeup scheduler tick (runs regardless of focus/active worktree)
                // Fires any ScheduleWakeup entries whose fire_at_unix <= now.
                // ================================================================
                {
                    let now = now_unix_secs();
                    let last_wakeup = last_wakeup_poll_time.load(Ordering::Relaxed);
                    if now.saturating_sub(last_wakeup) >= DEFAULT_WAKEUP_POLL_INTERVAL {
                        last_wakeup_poll_time.store(now, Ordering::Relaxed);
                        let app_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            crate::chat::wakeup::fire_due(&app_handle);
                        });
                    }
                }

                // Only poll while some UI client is focused (see FocusState)
                if !is_focused.load(Ordering::Relaxed) {
                    wait_for_wake_signal(
                        &wake_signal,
                        Duration::from_secs(DEFAULT_WAKEUP_POLL_INTERVAL),
                    );
                    continue;
                }

                let targets = {
                    let focus = focus.lock().unwrap_or_else(|e| e.into_inner());
                    let active = active_worktrees.lock().unwrap_or_else(|e| e.into_inner());
                    fast_poll_targets(&focus, &active)
                };
                // Consume both wake requests before checking worktree capabilities.
                // If a request cannot run (for example, a remote refresh on a
                // worktree without a PR), leaving it set makes the loop skip its
                // wait forever and consume a full CPU core.
                let (is_immediate_local, is_immediate_remote) =
                    take_immediate_poll_requests(&immediate_poll, &immediate_remote_poll);

                for info in &targets {
                    poll_active_worktree(
                        &app,
                        info,
                        ActivePollRequest {
                            immediate_local: is_immediate_local,
                            immediate_remote: is_immediate_remote,
                        },
                        &last_local_poll_times,
                        &last_remote_poll_times,
                    );
                }

                // ================================================================
                // Sweeps: every worktree not fast-polled above, on their own
                // threads so active-worktree polling is never blocked.
                // Runs even when no worktree is selected on the canvas.
                // ================================================================
                {
                    let now = now_unix_secs();
                    let last_sweep = last_sweep_poll_time.load(Ordering::Relaxed);
                    if poll_interval_elapsed(now, Some(last_sweep), DEFAULT_SWEEP_POLL_INTERVAL) {
                        let mut candidates =
                            sweep_candidates(&pr_worktrees.lock().unwrap(), &targets);
                        candidates.retain(|w| w.pr_number.is_some() && w.pr_url.is_some());
                        let app = app.clone();
                        if spawn_sweep(&pr_sweep_in_flight, move || {
                            sweep_pr_status(&app, candidates)
                        }) {
                            last_sweep_poll_time.store(now, Ordering::Relaxed);
                        }
                    }

                    let last_git_sweep = last_git_sweep_time.load(Ordering::Relaxed);
                    if poll_interval_elapsed(now, Some(last_git_sweep), GIT_SWEEP_POLL_INTERVAL) {
                        let candidates = sweep_candidates(&all_worktrees.lock().unwrap(), &targets);
                        let app = app.clone();
                        if spawn_sweep(&git_sweep_in_flight, move || {
                            sweep_git_status(&app, candidates)
                        }) {
                            last_git_sweep_time.store(now, Ordering::Relaxed);
                        }
                    }
                }

                // Wait until the next scheduler tick, or wake immediately on state changes.
                if shutdown.load(Ordering::Relaxed)
                    || !is_focused.load(Ordering::Relaxed)
                    || immediate_poll.load(Ordering::Relaxed)
                    || immediate_remote_poll.load(Ordering::Relaxed)
                {
                    continue;
                }

                let wait_secs = GIT_POLL_INTERVAL.min(DEFAULT_WAKEUP_POLL_INTERVAL);
                wait_for_wake_signal(&wake_signal, Duration::from_secs(wait_secs));
            }
        });
    }

    /// Signal the background task manager to stop
    #[allow(dead_code)]
    pub fn stop(&self) {
        log::trace!("Signaling background task manager to stop");
        self.shutdown.store(true, Ordering::Relaxed);
        notify_wake_signal(&self.wake_signal);
    }

    /// Record a client's window focus.
    ///
    /// Polling pauses once every reporting client has blurred. When focus is
    /// regained overall, local polling resumes with a short debounce (10s).
    pub fn set_client_focus(&self, client: UiClient, focused: bool) {
        self.update_focus(|state, _| state.report(client, focused));
    }

    /// Forget a client that went away (for example a closed WebSocket):
    /// its focus and its active worktree.
    pub fn remove_client(&self, client: UiClient) {
        self.update_focus(|state, active| {
            state.remove(client);
            active.remove(&client);
        });
    }

    fn update_focus(
        &self,
        change: impl FnOnce(&mut FocusState, &mut HashMap<UiClient, ActiveWorktreeInfo>),
    ) {
        let (was_focused, focused, gained) = {
            let mut state = self.focus.lock().unwrap_or_else(|e| e.into_inner());
            let mut active = self
                .active_worktrees
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let before = fast_poll_targets(&state, &active);
            change(&mut state, &mut active);
            let gained: Vec<_> = fast_poll_targets(&state, &active)
                .into_iter()
                .filter(|t| !before.iter().any(|b| b.worktree_id == t.worktree_id))
                .collect();
            let focused = state.is_focused();
            (
                self.is_focused.swap(focused, Ordering::Relaxed),
                focused,
                gained,
            )
        };

        // A worktree that just became a fast-poll target (its client regained
        // focus) polls immediately unless it was polled very recently.
        let now = now_unix_secs();
        for info in &gained {
            let last_poll = self
                .last_local_poll_times
                .lock()
                .unwrap()
                .get(&info.worktree_id)
                .copied();
            let should_poll_local = poll_interval_elapsed(now, last_poll, MIN_LOCAL_POLL_DEBOUNCE);
            log::trace!(
                "Client gained focus: worktree={}, should_poll_local={}, debounce={}s",
                info.worktree_id,
                should_poll_local,
                MIN_LOCAL_POLL_DEBOUNCE
            );
            if should_poll_local {
                self.immediate_poll.store(true, Ordering::Relaxed);
            }

            if info.pr_number.is_some() && info.pr_url.is_some() {
                let last_remote_poll = self
                    .last_remote_poll_times
                    .lock()
                    .unwrap()
                    .get(&info.worktree_id)
                    .copied();
                if poll_interval_elapsed(now, last_remote_poll, REMOTE_POLL_INTERVAL) {
                    self.immediate_remote_poll.store(true, Ordering::Relaxed);
                }
            }
        }

        if focused && !was_focused {
            log::trace!("App gained focus: polling resumed");
        } else if !focused && was_focused {
            log::trace!("App lost focus: polling paused");
        }

        notify_wake_signal(&self.wake_signal);
    }

    /// Set the worktree `client` has selected, or clear it with `None`.
    ///
    /// Selecting a worktree triggers an immediate local poll. Remote polling
    /// happens on its normal interval unless explicitly triggered.
    pub fn set_active_worktree(&self, client: UiClient, info: Option<ActiveWorktreeInfo>) {
        log::trace!(
            "Active worktree changed for {client:?}: {:?}",
            info.as_ref().map(|i| &i.worktree_id)
        );
        let should_poll_immediately = info.is_some();
        {
            let mut active = self
                .active_worktrees
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match info {
                Some(info) => active.insert(client, info),
                None => active.remove(&client),
            };
        }

        if should_poll_immediately {
            self.immediate_poll.store(true, Ordering::Relaxed);
        }

        notify_wake_signal(&self.wake_signal);
    }

    /// Trigger an immediate local poll
    ///
    /// This bypasses the normal polling interval and debounce timer for local git commands.
    /// Useful after git operations like pull, push, commit, etc.
    pub fn trigger_immediate_poll(&self) {
        log::trace!("Triggering immediate local git poll");
        self.immediate_poll.store(true, Ordering::Relaxed);
        notify_wake_signal(&self.wake_signal);
    }

    /// Set all worktrees with open PRs for sweep polling.
    ///
    /// Every 5 minutes the sweep refreshes all of them except the fast-polled ones,
    /// to detect PR merges even when the worktree isn't actively selected.
    pub fn set_pr_worktrees(&self, worktrees: Vec<ActiveWorktreeInfo>) {
        log::trace!("Setting {} PR worktrees for sweep polling", worktrees.len());
        {
            let mut guard = self.pr_worktrees.lock().unwrap();
            *guard = worktrees;
        }
        notify_wake_signal(&self.wake_signal);
    }

    /// Set all worktrees for git status sweep polling.
    ///
    /// Every 2 minutes the sweep refreshes all of them except the fast-polled ones,
    /// to keep uncommitted diff stats up to date even when not actively selected.
    pub fn set_all_worktrees(&self, worktrees: Vec<ActiveWorktreeInfo>) {
        log::trace!(
            "Setting {} worktrees for git status sweep polling",
            worktrees.len()
        );
        {
            let mut guard = self.all_worktrees.lock().unwrap();
            *guard = worktrees;
        }
        notify_wake_signal(&self.wake_signal);
    }

    /// Trigger an immediate remote poll
    ///
    /// This bypasses the normal remote polling interval.
    /// Useful when you want to force-refresh PR status.
    pub fn trigger_immediate_remote_poll(&self) {
        log::trace!("Triggering immediate remote poll");
        self.immediate_remote_poll.store(true, Ordering::Relaxed);
        notify_wake_signal(&self.wake_signal);
    }
}

async fn refresh_usage_caches(app: &AppHandle) {
    // Claude usage is safe again: CAS credential writes + no forced refresh when
    // expires_at is missing (OpenUsage-aligned). Cache absorbs 429s.
    if let Err(e) = refresh_claude_usage_cache(app).await {
        log::trace!("Background usage refresh (Claude) skipped/failed: {e}");
    }

    if let Err(e) = refresh_codex_usage_cache(app).await {
        log::trace!("Background usage refresh (Codex) skipped/failed: {e}");
    }

    if let Err(e) = refresh_grok_usage_cache(app).await {
        log::trace!("Background usage refresh (Grok) skipped/failed: {e}");
    }
}

async fn refresh_claude_usage_cache(app: &AppHandle) -> Result<(), String> {
    let status = crate::claude_cli::check_claude_cli_installed(app.clone()).await?;
    if !status.installed {
        return Ok(());
    }

    let auth = crate::claude_cli::check_claude_cli_auth(app.clone()).await?;
    if !auth.authenticated {
        return Ok(());
    }

    let _ = crate::claude_cli::get_claude_usage_with_source("background").await?;
    Ok(())
}

async fn refresh_codex_usage_cache(app: &AppHandle) -> Result<(), String> {
    let status = crate::codex_cli::check_codex_cli_installed(app.clone()).await?;
    if !status.installed {
        return Ok(());
    }

    let auth = crate::codex_cli::check_codex_cli_auth(app.clone()).await?;
    if !auth.authenticated {
        return Ok(());
    }

    let _ = crate::codex_cli::get_codex_usage(app.clone()).await?;
    Ok(())
}

async fn refresh_grok_usage_cache(app: &AppHandle) -> Result<(), String> {
    let status = crate::grok_cli::check_grok_cli_installed(app.clone()).await?;
    if !status.installed {
        return Ok(());
    }

    let auth = crate::grok_cli::check_grok_cli_auth(app.clone()).await?;
    if !auth.authenticated {
        return Ok(());
    }

    let _ = crate::grok_cli::get_grok_usage(app.clone()).await?;
    Ok(())
}

/// Emit a git status event to the frontend
fn emit_git_status(app: &AppHandle, status: GitBranchStatus) -> Result<(), String> {
    app.emit_all("git:status-update", &status)
        .map_err(|e| format!("Failed to emit git:status-update event: {e}"))
}

/// Emit a PR status event to the frontend
fn emit_pr_status(app: &AppHandle, status: PrStatus) -> Result<(), String> {
    app.emit_all("pr:status-update", &status)
        .map_err(|e| format!("Failed to emit pr:status-update event: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_interval_elapsed_when_no_previous_poll_exists() {
        assert!(poll_interval_elapsed(100, None, 60));
    }

    #[test]
    fn poll_interval_elapsed_only_after_configured_interval() {
        assert!(!poll_interval_elapsed(159, Some(100), 60));
        assert!(poll_interval_elapsed(160, Some(100), 60));
    }

    #[test]
    fn normal_local_poll_uses_configured_interval() {
        assert!(!should_poll_local(159, Some(100), false, 60));
        assert!(should_poll_local(160, Some(100), false, 60));
        assert!(should_poll_local(101, Some(100), true, 600));
    }

    #[test]
    fn immediate_poll_requests_are_consumed_together() {
        let local = AtomicBool::new(true);
        let remote = AtomicBool::new(true);

        assert_eq!(take_immediate_poll_requests(&local, &remote), (true, true));
        assert_eq!(
            take_immediate_poll_requests(&local, &remote),
            (false, false)
        );
    }

    fn manager() -> (tempfile::TempDir, BackgroundTaskManager) {
        let temp = tempfile::tempdir().unwrap();
        let app = crate::RuntimeContext::new(temp.path().join("data"), temp.path().into()).unwrap();
        (temp, BackgroundTaskManager::new(app))
    }

    fn polling(manager: &BackgroundTaskManager) -> bool {
        manager.is_focused.load(Ordering::Relaxed)
    }

    #[test]
    fn polls_before_any_client_reports_focus() {
        let (_temp, manager) = manager();
        assert!(polling(&manager));
    }

    #[test]
    fn one_focused_client_keeps_polling_while_another_blurs() {
        let (_temp, manager) = manager();
        manager.set_client_focus(UiClient::Native, true);
        manager.set_client_focus(UiClient::Ws(1), false);
        assert!(polling(&manager));

        manager.set_client_focus(UiClient::Native, false);
        assert!(!polling(&manager));
    }

    #[test]
    fn disconnecting_the_last_focused_client_pauses_polling() {
        let (_temp, manager) = manager();
        manager.set_client_focus(UiClient::Native, false);
        manager.set_client_focus(UiClient::Ws(7), true);
        assert!(polling(&manager));

        manager.remove_client(UiClient::Ws(7));
        assert!(!polling(&manager));
    }

    #[test]
    fn regaining_focus_requests_an_immediate_poll() {
        let (_temp, manager) = manager();
        manager.set_client_focus(UiClient::Ws(1), false);
        manager.set_active_worktree(
            UiClient::Ws(2),
            Some(ActiveWorktreeInfo {
                pr_number: Some(3),
                pr_url: Some("https://github.com/o/r/pull/3".to_string()),
                ..worktree("wt")
            }),
        );
        manager.immediate_poll.store(false, Ordering::Relaxed);

        manager.set_client_focus(UiClient::Ws(2), true);
        assert_eq!(
            take_immediate_poll_requests(&manager.immediate_poll, &manager.immediate_remote_poll),
            (true, true)
        );

        manager.set_client_focus(UiClient::Native, true);
        assert_eq!(
            take_immediate_poll_requests(&manager.immediate_poll, &manager.immediate_remote_poll),
            (false, false)
        );
    }

    fn worktree(id: &str) -> ActiveWorktreeInfo {
        ActiveWorktreeInfo {
            worktree_id: id.to_string(),
            worktree_path: format!("/tmp/{id}"),
            base_branch: "main".to_string(),
            base_remote: None,
            pr_number: None,
            pr_url: None,
            pr_push_remote: None,
            pr_push_branch: None,
        }
    }

    fn target_ids(manager: &BackgroundTaskManager) -> Vec<String> {
        let focus = manager.focus.lock().unwrap();
        let active = manager.active_worktrees.lock().unwrap();
        fast_poll_targets(&focus, &active)
            .into_iter()
            .map(|t| t.worktree_id)
            .collect()
    }

    #[test]
    fn each_clients_active_worktree_is_fast_polled() {
        let (_temp, manager) = manager();
        manager.set_active_worktree(UiClient::Native, Some(worktree("desktop")));
        manager.set_active_worktree(UiClient::Ws(1), Some(worktree("phone")));
        assert_eq!(target_ids(&manager), ["desktop", "phone"]);

        manager.set_client_focus(UiClient::Native, true);
        manager.set_client_focus(UiClient::Ws(1), true);
        assert_eq!(target_ids(&manager), ["desktop", "phone"]);
    }

    #[test]
    fn blurred_clients_worktree_is_not_fast_polled() {
        let (_temp, manager) = manager();
        manager.set_active_worktree(UiClient::Native, Some(worktree("desktop")));
        manager.set_active_worktree(UiClient::Ws(1), Some(worktree("phone")));
        manager.set_client_focus(UiClient::Native, true);
        manager.set_client_focus(UiClient::Ws(1), false);
        assert_eq!(target_ids(&manager), ["desktop"]);
    }

    #[test]
    fn removing_a_client_drops_its_focus_and_worktree() {
        let (_temp, manager) = manager();
        manager.set_active_worktree(UiClient::Native, Some(worktree("desktop")));
        manager.set_active_worktree(UiClient::Ws(1), Some(worktree("phone")));
        manager.set_client_focus(UiClient::Native, false);
        manager.set_client_focus(UiClient::Ws(1), true);

        manager.remove_client(UiClient::Ws(1));
        assert!(!polling(&manager));
        manager.set_client_focus(UiClient::Native, true);
        manager.set_client_focus(UiClient::Ws(1), true);
        assert_eq!(target_ids(&manager), ["desktop"]);
    }

    #[test]
    fn clearing_a_clients_worktree_stops_fast_polling_it() {
        let (_temp, manager) = manager();
        manager.set_active_worktree(UiClient::Ws(1), Some(worktree("phone")));
        manager.set_active_worktree(UiClient::Ws(1), None);
        assert!(target_ids(&manager).is_empty());
    }

    #[test]
    fn worktree_selected_by_two_clients_is_polled_once() {
        let (_temp, manager) = manager();
        manager.set_active_worktree(UiClient::Native, Some(worktree("shared")));
        manager.set_active_worktree(UiClient::Ws(1), Some(worktree("shared")));
        assert_eq!(target_ids(&manager), ["shared"]);
    }

    #[test]
    fn sweeps_skip_every_fast_polled_worktree() {
        let (_temp, manager) = manager();
        manager.set_active_worktree(UiClient::Native, Some(worktree("desktop")));
        manager.set_active_worktree(UiClient::Ws(1), Some(worktree("phone")));
        let targets = {
            let focus = manager.focus.lock().unwrap();
            let active = manager.active_worktrees.lock().unwrap();
            fast_poll_targets(&focus, &active)
        };
        let all = [worktree("desktop"), worktree("phone"), worktree("other")];

        let swept: Vec<_> = sweep_candidates(&all, &targets)
            .into_iter()
            .map(|w| w.worktree_id)
            .collect();
        assert_eq!(swept, ["other"]);
    }

    #[test]
    fn another_client_gaining_focus_polls_its_worktree_immediately() {
        let (_temp, manager) = manager();
        manager.set_client_focus(UiClient::Native, true);
        manager.set_client_focus(UiClient::Ws(1), false);
        manager.set_active_worktree(UiClient::Ws(1), Some(worktree("phone")));
        manager.immediate_poll.store(false, Ordering::Relaxed);

        manager.set_client_focus(UiClient::Ws(1), true);
        assert_eq!(
            take_immediate_poll_requests(&manager.immediate_poll, &manager.immediate_remote_poll),
            (true, false)
        );
    }

    #[test]
    fn for_each_bounded_processes_every_item_once_within_the_worker_cap() {
        let seen = Mutex::new(Vec::new());
        let running = AtomicU64::new(0);
        let max_running = AtomicU64::new(0);

        for_each_bounded((0..40).collect(), 3, |item: u32| {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            max_running.fetch_max(now, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(5));
            seen.lock().unwrap().push(item);
            running.fetch_sub(1, Ordering::SeqCst);
        });

        let mut seen = seen.into_inner().unwrap();
        seen.sort_unstable();
        assert_eq!(seen, (0..40).collect::<Vec<_>>());
        assert_eq!(max_running.load(Ordering::SeqCst), 3);
    }
}
