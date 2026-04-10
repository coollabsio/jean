use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use tauri::AppHandle;

use super::checks::{all_checks, find_check};
use super::storage;
use super::types::*;
use crate::chat::storage::{save_empty_index, with_sessions_mut};
use crate::chat::types::{Backend, Session};
use crate::http_server::EmitExt;
use crate::projects::storage::{get_project_worktrees_dir, load_projects_data, save_projects_data};
use crate::projects::types::Worktree;

// ============================================================================
// Cancellation tracking
// ============================================================================

/// Set of run_ids that have been cancelled
static NIGHTSHIFT_CANCELLED: Lazy<Mutex<std::collections::HashSet<String>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

/// Check if a run has been cancelled
pub fn is_run_cancelled(run_id: &str) -> bool {
    NIGHTSHIFT_CANCELLED.lock().unwrap().contains(run_id)
}

fn mark_cancelled(run_id: &str) {
    NIGHTSHIFT_CANCELLED
        .lock()
        .unwrap()
        .insert(run_id.to_string());
}

fn cleanup_run(run_id: &str) {
    NIGHTSHIFT_CANCELLED.lock().unwrap().remove(run_id);
    COMPLETION_CHANNELS.lock().unwrap().remove(run_id);
}

/// Cancel a nightshift run
pub fn cancel_run(run_id: &str) -> Result<bool, String> {
    mark_cancelled(run_id);
    // Wake up any waiting channel so the engine unblocks
    if let Some(tx) = COMPLETION_CHANNELS.lock().unwrap().remove(run_id) {
        let _ = tx.send(CheckCompletion {
            session_id: String::new(),
            success: false,
            error: Some("Cancelled".to_string()),
        });
    }
    Ok(true)
}

// ============================================================================
// Running projects tracking (prevent double-scheduling)
// ============================================================================

static RUNNING_PROJECTS: Lazy<Mutex<std::collections::HashSet<String>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

fn mark_project_running(project_id: &str) {
    RUNNING_PROJECTS
        .lock()
        .unwrap()
        .insert(project_id.to_string());
}

fn mark_project_done(project_id: &str) {
    RUNNING_PROJECTS.lock().unwrap().remove(project_id);
}

fn is_project_running(project_id: &str) -> bool {
    RUNNING_PROJECTS.lock().unwrap().contains(project_id)
}

// ============================================================================
// Completion signaling (frontend → backend)
// ============================================================================

/// Channels for frontend to signal check completion back to the engine.
/// Keyed by run_id — one channel per run (checks are sequential).
static COMPLETION_CHANNELS: Lazy<Mutex<HashMap<String, mpsc::Sender<CheckCompletion>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Called by the `nightshift_report_check_done` Tauri command
pub fn report_check_done(
    run_id: &str,
    _check_id: &str,
    session_id: String,
    success: bool,
    error: Option<String>,
) {
    let tx = COMPLETION_CHANNELS.lock().unwrap().get(run_id).cloned();
    if let Some(tx) = tx {
        let _ = tx.send(CheckCompletion {
            session_id,
            success,
            error,
        });
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Format a unix timestamp as "DD-MM-YYYY @ HH.MM" in local time
fn format_local_timestamp(ts: u64) -> String {
    // Convert to local time using libc (avoids adding time crate dependency)
    let secs = ts as i64;
    #[cfg(unix)]
    {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&secs, &mut tm) };
        format!(
            "{:02}-{:02}-{} @ {:02}.{:02}",
            tm.tm_mday,
            tm.tm_mon + 1,
            tm.tm_year + 1900,
            tm.tm_hour,
            tm.tm_min,
        )
    }
    #[cfg(windows)]
    {
        // On Windows, use the _localtime64_s equivalent via chrono-free approach
        // Fall back to UTC-based formatting
        let secs_in_day = 86400u64;
        let days = ts / secs_in_day;
        let time_of_day = ts % secs_in_day;
        let hour = time_of_day / 3600;
        let min = (time_of_day % 3600) / 60;

        // Simple days-to-date conversion
        let mut y = 1970i64;
        let mut remaining = days as i64;
        loop {
            let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
            if remaining < days_in_year {
                break;
            }
            remaining -= days_in_year;
            y += 1;
        }
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let mut m = 0;
        for &md in &month_days {
            if remaining < md {
                break;
            }
            remaining -= md;
            m += 1;
        }
        format!("{:02}-{:02}-{} @ {:02}.{:02}", remaining + 1, m + 1, y, hour, min)
    }
}

/// Get current local time as "HH:MM"
fn current_time_hhmm() -> String {
    let ts = now();
    let secs = ts as i64;
    #[cfg(unix)]
    {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&secs, &mut tm) };
        format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
    }
    #[cfg(windows)]
    {
        let time_of_day = ts % 86400;
        format!("{:02}:{:02}", time_of_day / 3600, (time_of_day % 3600) / 60)
    }
}

// ============================================================================
// Prompt resolution
// ============================================================================

/// Get the prompt for a check, respecting per-check custom prompt overrides
fn get_check_prompt(config: &NightshiftConfig, check_id: &str) -> String {
    // Check for per-check custom prompt override
    if let Some(check_config) = config.check_configs.get(check_id) {
        if let Some(ref custom) = check_config.custom_prompt {
            if !custom.is_empty() {
                return custom.clone();
            }
        }
    }
    // Fall back to built-in default
    find_check(check_id)
        .map(|c| c.prompt_template.to_string())
        .unwrap_or_default()
}

/// Get the effective cooldown for a check
fn get_check_cooldown(config: &NightshiftConfig, check_id: &str) -> u32 {
    if let Some(check_config) = config.check_configs.get(check_id) {
        if let Some(override_hours) = check_config.cooldown_hours_override {
            return override_hours;
        }
    }
    find_check(check_id)
        .map(|c| c.check.cooldown_hours)
        .unwrap_or(24)
}

// ============================================================================
// Worktree + session creation
// ============================================================================

/// Get the existing "nightshift" worktree for a project, or create one if it doesn't exist.
fn get_or_create_nightshift_worktree(
    app: &AppHandle,
    project_id: &str,
) -> Result<Worktree, String> {
    let data = load_projects_data(app)?;
    let project = data
        .find_project(project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();

    // Check if a "nightshift" worktree already exists for this project
    if let Some(existing) = data.worktrees.iter().find(|w| {
        w.project_id == project_id && w.name == "nightshift"
    }) {
        log::trace!("Reusing existing nightshift worktree: {}", existing.id);
        return Ok(existing.clone());
    }

    // Create a new one
    let worktree_name = "nightshift";
    let branch_name = "nightshift";

    let project_worktrees_dir = get_project_worktrees_dir(&project.name, project.worktrees_dir.as_deref())?;
    let worktree_path = project_worktrees_dir.join(worktree_name);
    let worktree_path_str = worktree_path
        .to_str()
        .ok_or_else(|| "Invalid worktree path".to_string())?
        .to_string();

    let base_branch = project.default_branch.clone();

    // Create git worktree — try new branch first, fall back to existing branch
    let create_result = crate::projects::git::create_worktree(
        &project.path,
        &worktree_path_str,
        branch_name,
        &base_branch,
    );
    if let Err(e) = create_result {
        // Branch might already exist from a previous run — try using existing branch
        log::trace!("New branch failed ({e}), trying existing branch");
        crate::projects::git::create_worktree_from_existing_branch(
            &project.path,
            &worktree_path_str,
            branch_name,
        )?;
    }

    // Run jean.json setup script if configured (e.g. `bun install`)
    let (setup_output, setup_script, setup_success) =
        crate::projects::git::run_setup_if_configured(&worktree_path_str, &project.path, branch_name);

    // Register worktree in ProjectsData
    let worktree_id = uuid::Uuid::new_v4().to_string();
    let mut worktree = Worktree::new(
        worktree_id.clone(),
        project_id.to_string(),
        worktree_name.to_string(),
        worktree_path_str.clone(),
        branch_name.to_string(),
        999,
    );
    worktree.setup_output = setup_output;
    worktree.setup_script = setup_script;
    worktree.setup_success = setup_success;

    let mut data = load_projects_data(app)?;
    data.worktrees.push(worktree.clone());
    save_projects_data(app, &data)?;

    // Initialize empty session index (no "Session 1", auto-naming disabled)
    save_empty_index(app, &worktree_id)?;

    // Notify frontend so the worktree appears without manual refresh
    let _ = app.emit_all(
        "worktrees:changed",
        &serde_json::json!({ "project_id": project_id }),
    );

    log::trace!(
        "Created nightshift worktree: {} at {}",
        worktree_id,
        worktree_path_str
    );

    Ok(worktree)
}

/// Create a session within the worktree for a nightshift check
fn create_nightshift_session(
    app: &AppHandle,
    worktree: &Worktree,
    check_id: &str,
    check_name: &str,
    run_id: &str,
    config: &NightshiftConfig,
) -> Result<Session, String> {
    let backend = match config.backend.as_deref() {
        Some("codex") => Backend::Codex,
        Some("opencode") => Backend::Opencode,
        _ => Backend::Claude,
    };

    // Session name: "DD-MM-YYYY @ HH.MM - Check Name"
    let session_name = format!("{} - {}", format_local_timestamp(now()), check_name);

    let session = with_sessions_mut(app, &worktree.path, &worktree.id, |sessions| {
        let mut session = Session::new(
            session_name,
            sessions.sessions.len() as u32,
            backend,
        );
        session.selected_model = config.model.clone();
        session.selected_provider = config.provider.clone();
        session.session_naming_completed = true; // Skip auto-naming for nightshift
        session.source = Some("nightshift".to_string());
        session.nightshift_check_id = Some(check_id.to_string());
        session.nightshift_run_id = Some(run_id.to_string());

        sessions.sessions.push(session.clone());
        sessions.active_session_id = Some(session.id.clone());

        Ok(session)
    })?;

    log::trace!(
        "Created nightshift session: {} for check {}",
        session.id,
        check_id
    );

    Ok(session)
}

// ============================================================================
// Check filtering
// ============================================================================

/// Determine which checks to run based on config and cooldowns.
/// Manual triggers run only the single most-overdue check.
/// Scheduled triggers run all checks that are past their cooldown.
fn get_enabled_checks(
    app: &AppHandle,
    project_id: &str,
    config: &NightshiftConfig,
    trigger: &RunTrigger,
) -> Vec<String> {
    let is_manual = matches!(trigger, RunTrigger::Manual);
    let all = all_checks();
    let mut candidates: Vec<(String, u64)> = Vec::new(); // (check_id, last_run_time)

    for def in &all {
        let id = &def.check.id;

        // Skip explicitly disabled checks
        if config.disabled_checks.contains(id) {
            continue;
        }

        // Include if default-enabled or explicitly enabled
        if def.check.default_enabled || config.extra_enabled_checks.contains(id) {
            let last_run = storage::get_last_check_run_time(app, project_id, id)
                .ok()
                .flatten()
                .unwrap_or(0);

            // For scheduled runs, enforce cooldown
            if !is_manual {
                let cooldown_hours = get_check_cooldown(config, id);
                let cooldown_secs = (cooldown_hours as u64) * 3600;
                if now() < last_run + cooldown_secs {
                    log::trace!("Skipping check {id}: still in cooldown");
                    continue;
                }
            }

            candidates.push((id.clone(), last_run));
        }
    }

    if is_manual {
        // Manual: pick only the single most-overdue check (oldest last_run)
        candidates.sort_by_key(|(_, last_run)| *last_run);
        candidates.into_iter().take(1).map(|(id, _)| id).collect()
    } else {
        // Scheduled: run all checks past cooldown
        candidates.into_iter().map(|(id, _)| id).collect()
    }
}

// ============================================================================
// Run execution
// ============================================================================

/// Parameters for executing a nightshift run
pub struct RunParams<'a> {
    pub app: &'a AppHandle,
    pub project_id: &'a str,
    pub config: &'a NightshiftConfig,
    pub trigger: RunTrigger,
    pub run_id: &'a str,
    /// When set, skip get_enabled_checks() and run only this check
    pub check_id_override: Option<String>,
}

/// Execute a full nightshift run for a project (called from background thread)
/// Drop guard that ensures `cleanup_run` and `mark_project_done` are always called,
/// even if the thread panics or returns early.
struct RunGuard {
    run_id: String,
    project_id: String,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        cleanup_run(&self.run_id);
        mark_project_done(&self.project_id);
        log::trace!(
            "RunGuard dropped: cleaned up run {} for project {}",
            self.run_id,
            self.project_id
        );
    }
}

pub fn execute_run(params: &RunParams<'_>) {
    let RunParams {
        app,
        project_id,
        config,
        trigger,
        run_id,
        ..
    } = params;
    let trigger = trigger.clone();
    log::trace!("Starting nightshift run {run_id} for project {project_id}");

    // Guard ensures cleanup_run + mark_project_done are always called on exit
    let _guard = RunGuard {
        run_id: run_id.to_string(),
        project_id: project_id.to_string(),
    };

    // 1. Get or create the single nightshift worktree
    let worktree = match get_or_create_nightshift_worktree(app, project_id) {
        Ok(w) => w,
        Err(e) => {
            log::error!("Failed to get/create nightshift worktree: {e}");
            let _ = app.emit_all(
                "nightshift:run-failed",
                &RunFailedEvent {
                    run_id: run_id.to_string(),
                    project_id: project_id.to_string(),
                    error: format!("Failed to get/create worktree: {e}"),
                },
            );
            return; // _guard handles cleanup
        }
    };

    let mut run = NightshiftRun {
        id: run_id.to_string(),
        project_id: project_id.to_string(),
        started_at: now(),
        completed_at: None,
        status: RunStatus::Running,
        trigger,
        check_results: vec![],
        worktree_id: Some(worktree.id.clone()),
        worktree_path: Some(worktree.path.clone()),
        branch_name: Some(worktree.branch.clone()),
        pr_url: None,
        pr_number: None,
    };

    // Save initial run state
    if let Err(e) = storage::save_run(app, &run) {
        log::error!("Failed to save initial nightshift run: {e}");
    }

    // Emit run started event
    let _ = app.emit_all(
        "nightshift:run-started",
        &RunStartedEvent {
            run_id: run_id.to_string(),
            project_id: project_id.to_string(),
        },
    );

    // 2. Determine which checks to run
    let check_ids = if let Some(ref id) = params.check_id_override {
        vec![id.clone()]
    } else {
        get_enabled_checks(app, project_id, config, &run.trigger)
    };
    if check_ids.is_empty() {
        log::trace!("No checks to run for project {project_id}");
        run.status = RunStatus::Completed;
        run.completed_at = Some(now());
        let _ = storage::save_run(app, &run);
        let _ = app.emit_all(
            "nightshift:run-completed",
            &RunCompletedEvent {
                run_id: run_id.to_string(),
                project_id: project_id.to_string(),
                status: RunStatus::Completed,
                total_checks: 0,
                worktree_id: Some(worktree.id.clone()),
            },
        );
        return; // _guard handles cleanup
    }

    // Set up completion channel for this run
    let (tx, rx) = mpsc::channel::<CheckCompletion>();
    COMPLETION_CHANNELS
        .lock()
        .unwrap()
        .insert(run_id.to_string(), tx);

    let mut has_failures = false;

    // 3. Execute each check sequentially
    for check_id in &check_ids {
        // Check for cancellation
        if is_run_cancelled(run_id) {
            log::trace!("Nightshift run {run_id} was cancelled");
            run.status = RunStatus::Cancelled;
            run.completed_at = Some(now());
            let _ = storage::save_run(app, &run);
            return; // _guard handles cleanup
        }

        let check_name = find_check(check_id)
            .map(|c| c.check.name.clone())
            .unwrap_or_else(|| check_id.clone());

        // Create session for this check
        let session = match create_nightshift_session(
            app,
            &worktree,
            check_id,
            &check_name,
            run_id,
            config,
        ) {
            Ok(s) => s,
            Err(e) => {
                log::error!("Failed to create session for check {check_id}: {e}");
                run.check_results.push(CheckResult {
                    check_id: check_id.clone(),
                    status: RunStatus::Failed,
                    session_id: None,
    
                    duration_secs: 0,
                    error: Some(format!("Failed to create session: {e}")),
                });
                has_failures = true;
                continue;
            }
        };

        // Get the prompt for this check
        let prompt = get_check_prompt(config, check_id);

        // Emit check started
        let _ = app.emit_all(
            "nightshift:check-started",
            &CheckStartedEvent {
                run_id: run_id.to_string(),
                check_id: check_id.clone(),
                check_name: check_name.clone(),
            },
        );

        // Emit execute-check event for the frontend to pick up and send_chat_message
        let _ = app.emit_all(
            "nightshift:execute-check",
            &ExecuteCheckEvent {
                run_id: run_id.to_string(),
                project_id: project_id.to_string(),
                check_id: check_id.clone(),
                check_name: check_name.clone(),
                session_id: session.id.clone(),
                worktree_id: worktree.id.clone(),
                worktree_path: worktree.path.clone(),
                prompt,
                model: config.model.clone(),
                provider: config.provider.clone(),
                backend: config.backend.clone(),
            },
        );

        let start = std::time::Instant::now();

        // Wait for frontend to report completion (with 10-minute timeout per check)
        let completion = rx.recv_timeout(Duration::from_secs(600));

        let check_result = match completion {
            Ok(_) if is_run_cancelled(run_id) => CheckResult {
                check_id: check_id.clone(),
                status: RunStatus::Cancelled,
                session_id: Some(session.id.clone()),

                duration_secs: start.elapsed().as_secs(),
                error: Some("Cancelled".to_string()),
            },
            Ok(c) if c.success => CheckResult {
                check_id: check_id.clone(),
                status: RunStatus::Completed,
                session_id: Some(c.session_id),

                duration_secs: start.elapsed().as_secs(),
                error: None,
            },
            Ok(c) => {
                has_failures = true;
                CheckResult {
                    check_id: check_id.clone(),
                    status: RunStatus::Failed,
                    session_id: Some(c.session_id),
    
                    duration_secs: start.elapsed().as_secs(),
                    error: c.error,
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                has_failures = true;
                CheckResult {
                    check_id: check_id.clone(),
                    status: RunStatus::Failed,
                    session_id: Some(session.id.clone()),
    
                    duration_secs: start.elapsed().as_secs(),
                    error: Some("Check timed out (10 minutes)".to_string()),
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                has_failures = true;
                CheckResult {
                    check_id: check_id.clone(),
                    status: RunStatus::Failed,
                    session_id: Some(session.id.clone()),
    
                    duration_secs: start.elapsed().as_secs(),
                    error: Some("Channel disconnected".to_string()),
                }
            }
        };

        if check_result.status == RunStatus::Cancelled {
            run.check_results.push(check_result);
            run.status = RunStatus::Cancelled;
            run.completed_at = Some(now());
            let _ = storage::save_run(app, &run);
            return; // _guard handles cleanup
        }

        // Emit check done
        let _ = app.emit_all(
            "nightshift:check-done",
            &CheckDoneEvent {
                run_id: run_id.to_string(),
                check_id: check_id.clone(),
                status: check_result.status.clone(),
            },
        );

        run.check_results.push(check_result);

        // Save intermediate state
        if let Err(e) = storage::save_run(app, &run) {
            log::error!("Failed to save intermediate nightshift run: {e}");
        }
    }

    // 4. Finalize run
    run.completed_at = Some(now());
    run.status = if has_failures {
        RunStatus::PartiallyCompleted
    } else {
        RunStatus::Completed
    };

    if let Err(e) = storage::save_run(app, &run) {
        log::error!("Failed to save final nightshift run: {e}");
    }

    log::trace!(
        "Nightshift run {run_id} completed: status={:?}, checks={}",
        run.status,
        run.check_results.len()
    );

    // Release project lock BEFORE notifying frontend — prevents "already running"
    // race where user clicks Run Now immediately after seeing the completion toast
    drop(_guard);

    let _ = app.emit_all(
        "nightshift:run-completed",
        &RunCompletedEvent {
            run_id: run_id.to_string(),
            project_id: project_id.to_string(),
            status: run.status.clone(),
            total_checks: run.check_results.len(),
            worktree_id: Some(worktree.id.clone()),
        },
    );
}

/// Start a nightshift run in a background thread. Returns the run ID.
pub fn start_run(app: &AppHandle, project_id: &str, trigger: RunTrigger) -> Result<String, String> {
    let data = load_projects_data(app)?;

    let project = data
        .find_project(project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    if project.is_folder {
        return Err("Cannot run Nightshift on a folder".to_string());
    }
    if project.path.is_empty() {
        return Err("Project has no path".to_string());
    }
    if is_project_running(project_id) {
        return Err("Nightshift is already running for this project".to_string());
    }

    let config = project.nightshift_config.clone().unwrap_or_default();

    let run_id = uuid::Uuid::new_v4().to_string();
    let app_clone = app.clone();
    let project_id = project_id.to_string();
    let run_id_clone = run_id.clone();

    mark_project_running(&project_id);

    std::thread::spawn(move || {
        execute_run(&RunParams {
            app: &app_clone,
            project_id: &project_id,
            config: &config,
            trigger,
            run_id: &run_id_clone,
            check_id_override: None,
        });
    });

    Ok(run_id)
}

/// Start a nightshift run for a single specific check. Returns the run ID.
pub fn start_single_check_run(
    app: &AppHandle,
    project_id: &str,
    check_id: &str,
) -> Result<String, String> {
    // Validate the check_id exists
    find_check(check_id)
        .ok_or_else(|| format!("Unknown check: {check_id}"))?;

    let data = load_projects_data(app)?;
    let project = data
        .find_project(project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    if project.is_folder {
        return Err("Cannot run Nightshift on a folder".to_string());
    }
    if project.path.is_empty() {
        return Err("Project has no path".to_string());
    }
    if is_project_running(project_id) {
        return Err("Nightshift is already running for this project".to_string());
    }

    let config = project.nightshift_config.clone().unwrap_or_default();
    let run_id = uuid::Uuid::new_v4().to_string();
    let app_clone = app.clone();
    let project_id = project_id.to_string();
    let run_id_clone = run_id.clone();
    let check_id = check_id.to_string();

    mark_project_running(&project_id);

    std::thread::spawn(move || {
        execute_run(&RunParams {
            app: &app_clone,
            project_id: &project_id,
            config: &config,
            trigger: RunTrigger::Manual,
            run_id: &run_id_clone,
            check_id_override: Some(check_id),
        });
    });

    Ok(run_id)
}

// ============================================================================
// Scheduler
// ============================================================================

/// Start the nightshift scheduler. Checks every minute if any project has a
/// scheduled nightshift run that should fire now.
pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        log::trace!("Nightshift scheduler started");
        loop {
            std::thread::sleep(Duration::from_secs(60));
            check_and_run_scheduled(&app);
        }
    });
}

fn check_and_run_scheduled(app: &AppHandle) {
    let data = match load_projects_data(app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("Nightshift scheduler: failed to load projects: {e}");
            return;
        }
    };

    let now_hhmm = current_time_hhmm();

    for project in &data.projects {
        if project.is_folder || project.path.is_empty() {
            continue;
        }

        let config = match &project.nightshift_config {
            Some(c) if c.enabled => c,
            _ => continue,
        };

        let schedule = match &config.schedule_time {
            Some(t) if !t.is_empty() => t.as_str(),
            _ => continue,
        };

        if schedule != now_hhmm {
            continue;
        }

        if is_project_running(&project.id) {
            continue;
        }

        log::trace!(
            "Nightshift scheduler: triggering run for project {} at {}",
            project.name,
            now_hhmm
        );

        match start_run(app, &project.id, RunTrigger::Scheduled) {
            Ok(run_id) => {
                log::trace!("Nightshift scheduler: started run {run_id} for {}", project.name);
            }
            Err(e) => {
                log::error!("Nightshift scheduler: failed to start run for {}: {e}", project.name);
            }
        }
    }
}
