//! Background task management for periodic operations
//!
//! This module provides a task manager that runs periodic background tasks,
//! such as checking git status for the active worktree.
//!
//! Polling is split into two categories:
//! - **Local**: Git commands that run locally (fast, can run frequently)
//! - **Remote**: API calls like PR status via `gh` (slower, rate-limited)

use std::collections::HashMap;
use std::env;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use crate::gh_cli::config::resolve_gh_binary;
use crate::http_server::EmitExt;
use crate::projects::git_status::{get_branch_status, ActiveWorktreeInfo, GitBranchStatus};
use crate::projects::pr_status::{get_pr_status, PrStatus};

pub mod commands;

// ============================================================================
// Local polling constants (git commands that run locally)
// ============================================================================

/// Minimum polling interval in seconds (10 seconds)
pub const MIN_POLL_INTERVAL: u64 = 10;

/// Maximum polling interval in seconds (10 minutes)
pub const MAX_POLL_INTERVAL: u64 = 600;

/// Default polling interval in seconds (1 minute)
pub const DEFAULT_POLL_INTERVAL: u64 = 60;

/// Minimum seconds between local polls (debounce for focus changes)
const MIN_LOCAL_POLL_DEBOUNCE: u64 = 10;

// ============================================================================
// Remote polling constants (API calls like PR status)
// ============================================================================

/// Minimum remote polling interval in seconds (30 seconds)
pub const MIN_REMOTE_POLL_INTERVAL: u64 = 30;

/// Maximum remote polling interval in seconds (10 minutes)
pub const MAX_REMOTE_POLL_INTERVAL: u64 = 600;

/// Default remote polling interval in seconds (1 minute)
pub const DEFAULT_REMOTE_POLL_INTERVAL: u64 = 60;

// ============================================================================
// Sweep polling constants (round-robin PR checks for non-active worktrees)
// ============================================================================

/// Default sweep polling interval in seconds (5 minutes)
pub const DEFAULT_SWEEP_POLL_INTERVAL: u64 = 300;

/// Default git sweep polling interval in seconds (60 seconds)
/// This controls how often non-active worktrees get their git status polled (round-robin).
pub const DEFAULT_GIT_SWEEP_INTERVAL: u64 = 60;

/// Default usage polling interval in seconds (5 minutes)
/// This refreshes Claude/Codex usage caches on the backend.
pub const DEFAULT_USAGE_POLL_INTERVAL: u64 = 300;

/// Default combined-context cleanup interval in seconds (1 hour)
pub const DEFAULT_CLEANUP_POLL_INTERVAL: u64 = 3600;

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
/// for the active worktree when the application is focused.
///
/// Polling is split into local (git commands) and remote (API calls) categories:
/// - Local polls run on focus changes with a short debounce (10s)
/// - Remote polls run on a separate, longer interval (default 60s)
pub struct BackgroundTaskManager {
    app: AppHandle,
    is_focused: Arc<AtomicBool>,
    active_worktree: Arc<Mutex<Option<ActiveWorktreeInfo>>>,
    /// Interval for local git status polling (background timer)
    poll_interval_secs: Arc<AtomicU64>,
    /// Interval for remote API calls (PR status, etc.)
    remote_poll_interval_secs: Arc<AtomicU64>,
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
    /// Index for round-robin sweep
    sweep_index: Arc<AtomicU64>,
    /// Timestamp of last sweep poll
    last_sweep_poll_time: Arc<AtomicU64>,
    /// All worktrees for git status sweep polling (non-active worktrees)
    all_worktrees: Arc<Mutex<Vec<ActiveWorktreeInfo>>>,
    /// Index for round-robin git sweep
    git_sweep_index: Arc<AtomicU64>,
    /// Timestamp of last git sweep poll
    last_git_sweep_time: Arc<AtomicU64>,
    /// Timestamp of last usage cache refresh poll
    last_usage_poll_time: Arc<AtomicU64>,
    /// Guard to avoid overlapping usage refresh jobs
    usage_poll_in_flight: Arc<AtomicBool>,
    /// Timestamp of last combined-context cleanup sweep
    last_cleanup_poll_time: Arc<AtomicU64>,
}

impl BackgroundTaskManager {
    /// Create a new background task manager
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            is_focused: Arc::new(AtomicBool::new(true)), // Assume focused on startup
            active_worktree: Arc::new(Mutex::new(None)),
            poll_interval_secs: Arc::new(AtomicU64::new(DEFAULT_POLL_INTERVAL)),
            remote_poll_interval_secs: Arc::new(AtomicU64::new(DEFAULT_REMOTE_POLL_INTERVAL)),
            shutdown: Arc::new(AtomicBool::new(false)),
            immediate_poll: Arc::new(AtomicBool::new(false)),
            immediate_remote_poll: Arc::new(AtomicBool::new(false)),
            last_local_poll_times: Arc::new(Mutex::new(HashMap::new())),
            last_remote_poll_times: Arc::new(Mutex::new(HashMap::new())),
            pr_worktrees: Arc::new(Mutex::new(Vec::new())),
            sweep_index: Arc::new(AtomicU64::new(0)),
            last_sweep_poll_time: Arc::new(AtomicU64::new(0)),
            all_worktrees: Arc::new(Mutex::new(Vec::new())),
            git_sweep_index: Arc::new(AtomicU64::new(0)),
            last_git_sweep_time: Arc::new(AtomicU64::new(0)),
            // Initialize to "now" so startup does not trigger an immediate usage refresh.
            last_usage_poll_time: Arc::new(AtomicU64::new(now_unix_secs())),
            usage_poll_in_flight: Arc::new(AtomicBool::new(false)),
            // Initialize to "now" so startup does not trigger an immediate cleanup
            // (the startup cleanup in cleanup_old_archives already handles that).
            last_cleanup_poll_time: Arc::new(AtomicU64::new(now_unix_secs())),
        }
    }

    /// Start the background polling loop
    ///
    /// This spawns a new thread that will periodically check git status
    /// for the active worktree when the application is focused.
    ///
    /// The polling loop handles two types of checks:
    /// - **Local**: Git commands (fast, 10s debounce on focus events)
    /// - **Remote**: PR status via `gh` (separate interval, default 60s)
    pub fn start(&self) {
        log::trace!("Starting background task manager");

        let app = self.app.clone();
        let is_focused = Arc::clone(&self.is_focused);
        let active_worktree = Arc::clone(&self.active_worktree);
        let poll_interval_secs = Arc::clone(&self.poll_interval_secs);
        let remote_poll_interval_secs = Arc::clone(&self.remote_poll_interval_secs);
        let shutdown = Arc::clone(&self.shutdown);
        let immediate_poll = Arc::clone(&self.immediate_poll);
        let immediate_remote_poll = Arc::clone(&self.immediate_remote_poll);
        let last_local_poll_times = Arc::clone(&self.last_local_poll_times);
        let last_remote_poll_times = Arc::clone(&self.last_remote_poll_times);
        let pr_worktrees = Arc::clone(&self.pr_worktrees);
        let sweep_index = Arc::clone(&self.sweep_index);
        let last_sweep_poll_time = Arc::clone(&self.last_sweep_poll_time);
        let all_worktrees = Arc::clone(&self.all_worktrees);
        let git_sweep_index = Arc::clone(&self.git_sweep_index);
        let last_git_sweep_time = Arc::clone(&self.last_git_sweep_time);
        let last_usage_poll_time = Arc::clone(&self.last_usage_poll_time);
        let usage_poll_in_flight = Arc::clone(&self.usage_poll_in_flight);
        let last_cleanup_poll_time = Arc::clone(&self.last_cleanup_poll_time);
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
                            log::trace!("Background cleanup tick (combined-contexts + pasted files)");
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
                                    log::warn!(
                                        "Background combined-context cleanup failed: {e}"
                                    );
                                }
                            }
                            match crate::chat::storage::cleanup_orphaned_pasted_files(
                                &app_handle,
                            ) {
                                Ok(deleted) => {
                                    if deleted > 0 {
                                        log::debug!(
                                            "Background cleanup: removed {deleted} orphaned pasted files"
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "Background pasted-files cleanup failed: {e}"
                                    );
                                }
                            }
                        });
                    }
                }

                // Only poll when app is focused
                if !is_focused.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }

                // Check if we have an active worktree to poll
                let worktree_info = {
                    let guard = active_worktree.lock().unwrap();
                    guard.clone()
                };

                // Active worktree ID for excluding from sweep
                let active_worktree_id = worktree_info.as_ref().map(|i| i.worktree_id.clone());

                if let Some(info) = worktree_info {
                    log::trace!(
                        "Polling loop: worktree={}, pr_number={:?}, pr_url={:?}",
                        info.worktree_id,
                        info.pr_number,
                        info.pr_url
                    );

                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    // ================================================================
                    // Local polling (git commands - fast, short debounce)
                    // ================================================================
                    let last_local = {
                        let times = last_local_poll_times.lock().unwrap();
                        times.get(&info.worktree_id).copied().unwrap_or(0)
                    };
                    let time_since_local = now.saturating_sub(last_local);
                    let is_immediate_local = immediate_poll.swap(false, Ordering::Relaxed);

                    let should_poll_local =
                        is_immediate_local || time_since_local >= MIN_LOCAL_POLL_DEBOUNCE;

                    if should_poll_local {
                        {
                            let mut times = last_local_poll_times.lock().unwrap();
                            times.insert(info.worktree_id.clone(), now);
                        }

                        match get_branch_status(&info) {
                            Ok(status) => {
                                log::trace!(
                                    "Git status for {}: behind={}, ahead={}, has_updates={}",
                                    info.worktree_id,
                                    status.behind_count,
                                    status.ahead_count,
                                    status.has_updates
                                );

                                if let Err(e) = emit_git_status(&app, status) {
                                    log::error!("Failed to emit git status event: {e}");
                                }
                            }
                            Err(e) => {
                                log::warn!(
                                    "Failed to get git status for {}: {e}",
                                    info.worktree_id
                                );
                            }
                        }
                    }

                    // ================================================================
                    // Remote polling (PR status - separate, longer interval)
                    // ================================================================
                    if let (Some(pr_number), Some(pr_url)) = (&info.pr_number, &info.pr_url) {
                        let last_remote = {
                            let times = last_remote_poll_times.lock().unwrap();
                            times.get(&info.worktree_id).copied().unwrap_or(0)
                        };
                        let time_since_remote = now.saturating_sub(last_remote);
                        let remote_interval = remote_poll_interval_secs.load(Ordering::Relaxed);
                        let is_immediate_remote =
                            immediate_remote_poll.swap(false, Ordering::Relaxed);

                        let should_poll_remote =
                            is_immediate_remote || time_since_remote >= remote_interval;

                        log::trace!(
                            "Remote poll check: should_poll={}, is_immediate={}, time_since={}s, interval={}s",
                            should_poll_remote,
                            is_immediate_remote,
                            time_since_remote,
                            remote_interval
                        );

                        if should_poll_remote {
                            log::trace!("Polling PR status for #{}", pr_number);
                            {
                                let mut times = last_remote_poll_times.lock().unwrap();
                                times.insert(info.worktree_id.clone(), now);
                            }

                            let gh = resolve_gh_binary(&app);
                            match get_pr_status(
                                &info.worktree_path,
                                *pr_number,
                                pr_url,
                                &info.worktree_id,
                                &gh,
                            ) {
                                Ok(status) => {
                                    log::trace!(
                                        "PR status for #{}: display_status={:?}, check_status={:?}",
                                        pr_number,
                                        status.display_status,
                                        status.check_status
                                    );

                                    if let Err(e) = emit_pr_status(&app, status) {
                                        log::error!("Failed to emit PR status event: {e}");
                                    }
                                }
                                Err(e) => {
                                    log::warn!("Failed to get PR status for #{}: {e}", pr_number);
                                }
                            }
                        }
                    }
                }

                // ================================================================
                // Sweep polling (round-robin PR checks for non-active worktrees)
                // Runs even when no worktree is selected on the canvas
                // ================================================================
                {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let last_sweep = last_sweep_poll_time.load(Ordering::Relaxed);
                    let time_since_sweep = now.saturating_sub(last_sweep);

                    if time_since_sweep >= DEFAULT_SWEEP_POLL_INTERVAL {
                        let worktrees = pr_worktrees.lock().unwrap().clone();

                        // Filter out the currently active worktree (already polled above)
                        let candidates: Vec<_> = worktrees
                            .iter()
                            .filter(|w| active_worktree_id.as_ref() != Some(&w.worktree_id))
                            .filter(|w| w.pr_number.is_some() && w.pr_url.is_some())
                            .collect();

                        if !candidates.is_empty() {
                            let idx = sweep_index.fetch_add(1, Ordering::Relaxed) as usize
                                % candidates.len();
                            let candidate = candidates[idx];

                            if let (Some(pr_num), Some(pr_url)) =
                                (&candidate.pr_number, &candidate.pr_url)
                            {
                                log::trace!(
                                    "Sweep: polling PR #{} for worktree {}",
                                    pr_num,
                                    candidate.worktree_id
                                );

                                let gh = resolve_gh_binary(&app);
                                match get_pr_status(
                                    &candidate.worktree_path,
                                    *pr_num,
                                    pr_url,
                                    &candidate.worktree_id,
                                    &gh,
                                ) {
                                    Ok(status) => {
                                        if let Err(e) = emit_pr_status(&app, status) {
                                            log::error!("Sweep: failed to emit PR status: {e}");
                                        }
                                    }
                                    Err(e) => {
                                        log::warn!("Sweep: failed PR status for #{}: {e}", pr_num);
                                    }
                                }
                            }
                        }

                        last_sweep_poll_time.store(now, Ordering::Relaxed);
                    }
                }

                // ================================================================
                // Git status sweep (round-robin git status for non-active worktrees)
                // Runs even when no worktree is selected on the canvas
                // ================================================================
                {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let last_git_sweep = last_git_sweep_time.load(Ordering::Relaxed);
                    let time_since_git_sweep = now.saturating_sub(last_git_sweep);

                    if time_since_git_sweep >= DEFAULT_GIT_SWEEP_INTERVAL {
                        let worktrees = all_worktrees.lock().unwrap().clone();

                        // Filter out the currently active worktree (already polled above)
                        let candidates: Vec<_> = worktrees
                            .iter()
                            .filter(|w| active_worktree_id.as_ref() != Some(&w.worktree_id))
                            .collect();

                        if !candidates.is_empty() {
                            let idx = git_sweep_index.fetch_add(1, Ordering::Relaxed) as usize
                                % candidates.len();
                            let candidate = candidates[idx];

                            log::trace!(
                                "Git sweep: polling git status for worktree {}",
                                candidate.worktree_id
                            );

                            match get_branch_status(candidate) {
                                Ok(status) => {
                                    if let Err(e) = emit_git_status(&app, status) {
                                        log::error!("Git sweep: failed to emit git status: {e}");
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "Git sweep: failed git status for {}: {e}",
                                        candidate.worktree_id
                                    );
                                }
                            }
                        }

                        last_git_sweep_time.store(now, Ordering::Relaxed);
                    }
                }

                // Wait for a short interval before next check
                // Use 1-second sleep intervals to respond to shutdown/focus/immediate changes quickly
                let interval = poll_interval_secs.load(Ordering::Relaxed);
                for _ in 0..interval {
                    // Break early if shutdown, unfocused, or immediate poll requested
                    if shutdown.load(Ordering::Relaxed)
                        || !is_focused.load(Ordering::Relaxed)
                        || immediate_poll.load(Ordering::Relaxed)
                        || immediate_remote_poll.load(Ordering::Relaxed)
                    {
                        break;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            }
        });
    }

    /// Signal the background task manager to stop
    #[allow(dead_code)]
    pub fn stop(&self) {
        log::trace!("Signaling background task manager to stop");
        self.shutdown.store(true, Ordering::Relaxed);
    }

    /// Set whether the application is focused
    ///
    /// When the app loses focus, polling will be paused.
    /// When the app regains focus, local polling will resume with a short debounce (10s).
    /// Remote polling continues on its own interval.
    pub fn set_focused(&self, focused: bool) {
        let was_focused = self.is_focused.swap(focused, Ordering::Relaxed);

        if focused && !was_focused {
            // App gained focus - check if we should poll immediately
            let worktree_info = self.active_worktree.lock().ok().and_then(|g| g.clone());

            if let Some(info) = worktree_info {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                let last_poll = {
                    let times = self.last_local_poll_times.lock().unwrap();
                    times.get(&info.worktree_id).copied().unwrap_or(0)
                };
                let time_since = now.saturating_sub(last_poll);

                log::trace!(
                    "App gained focus: worktree={}, last_poll={}s ago, debounce={}s",
                    info.worktree_id,
                    time_since,
                    MIN_LOCAL_POLL_DEBOUNCE
                );

                // Always trigger immediate local and remote poll on focus regain
                // Branch changes and PR status updates happen while the app is unfocused
                self.immediate_poll.store(true, Ordering::Relaxed);
                self.immediate_remote_poll.store(true, Ordering::Relaxed);
            } else {
                log::trace!("App gained focus: no active worktree");
            }
        } else if !focused && was_focused {
            log::trace!("App lost focus: polling paused");
        }
    }

    /// Set the active worktree for polling
    ///
    /// Pass `None` to clear the active worktree and stop polling.
    /// When a new worktree is set, triggers an immediate local poll.
    /// Remote polling will happen on its normal interval unless explicitly triggered.
    pub fn set_active_worktree(&self, info: Option<ActiveWorktreeInfo>) {
        log::trace!(
            "Active worktree changed: {:?}",
            info.as_ref().map(|i| &i.worktree_id)
        );
        let mut guard = self.active_worktree.lock().unwrap();
        let should_poll_immediately = info.is_some();
        *guard = info;
        drop(guard); // Release lock before triggering immediate poll

        // Trigger immediate local poll when a new worktree is activated
        if should_poll_immediately {
            self.immediate_poll.store(true, Ordering::Relaxed);
        }
    }

    /// Set the local polling interval in seconds
    ///
    /// The interval will be clamped to the valid range (10-600 seconds).
    pub fn set_poll_interval(&self, seconds: u64) {
        let clamped = seconds.clamp(MIN_POLL_INTERVAL, MAX_POLL_INTERVAL);
        log::trace!("Setting local git poll interval to {clamped} seconds");
        self.poll_interval_secs.store(clamped, Ordering::Relaxed);
    }

    /// Get the current local polling interval in seconds
    pub fn get_poll_interval(&self) -> u64 {
        self.poll_interval_secs.load(Ordering::Relaxed)
    }

    /// Set the remote polling interval in seconds
    ///
    /// The interval will be clamped to the valid range (30-600 seconds).
    /// This controls how often remote API calls (like PR status) are made.
    pub fn set_remote_poll_interval(&self, seconds: u64) {
        let clamped = seconds.clamp(MIN_REMOTE_POLL_INTERVAL, MAX_REMOTE_POLL_INTERVAL);
        log::trace!("Setting remote poll interval to {clamped} seconds");
        self.remote_poll_interval_secs
            .store(clamped, Ordering::Relaxed);
    }

    /// Get the current remote polling interval in seconds
    pub fn get_remote_poll_interval(&self) -> u64 {
        self.remote_poll_interval_secs.load(Ordering::Relaxed)
    }

    /// Trigger an immediate local poll
    ///
    /// This bypasses the normal polling interval and debounce timer for local git commands.
    /// Useful after git operations like pull, push, commit, etc.
    pub fn trigger_immediate_poll(&self) {
        log::trace!("Triggering immediate local git poll");
        self.immediate_poll.store(true, Ordering::Relaxed);
    }

    /// Set all worktrees with open PRs for sweep polling.
    ///
    /// The sweep polls these worktrees round-robin at a slower interval
    /// to detect PR merges even when the worktree isn't actively selected.
    pub fn set_pr_worktrees(&self, worktrees: Vec<ActiveWorktreeInfo>) {
        log::trace!("Setting {} PR worktrees for sweep polling", worktrees.len());
        let mut guard = self.pr_worktrees.lock().unwrap();
        *guard = worktrees;
    }

    /// Set all worktrees for git status sweep polling.
    ///
    /// The sweep polls these worktrees round-robin at a slow interval (60s)
    /// to keep uncommitted diff stats up to date even when not actively selected.
    pub fn set_all_worktrees(&self, worktrees: Vec<ActiveWorktreeInfo>) {
        log::trace!(
            "Setting {} worktrees for git status sweep polling",
            worktrees.len()
        );
        let mut guard = self.all_worktrees.lock().unwrap();
        *guard = worktrees;
    }

    /// Trigger an immediate remote poll
    ///
    /// This bypasses the normal remote polling interval.
    /// Useful when you want to force-refresh PR status.
    pub fn trigger_immediate_remote_poll(&self) {
        log::trace!("Triggering immediate remote poll");
        self.immediate_remote_poll.store(true, Ordering::Relaxed);
    }
}

async fn refresh_usage_caches(app: &AppHandle) {
    // Claude usage polling disabled — auth bug causes repeated logouts
    // (see UsagePane.tsx). Keep refresh_claude_usage_cache() for re-enabling later.

    if let Err(e) = refresh_codex_usage_cache(app).await {
        log::trace!("Background usage refresh (Codex) skipped/failed: {e}");
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

    let _ = crate::codex_cli::get_codex_usage().await?;
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
