use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::AppHandle;

use super::types::{
    AutoFixActivity, AutoFixFailedIssue, AutoFixIssueCandidate, AutoFixIssuePreview, AutoFixStatus,
    AutoFixStatusError, AutoFixStoppedEvent,
};
use crate::chat::types::{EffortLevel, ThinkingLevel};
use crate::http_server::EmitExt;
use crate::projects::github_issues::{GitHubComment, IssueContext};
use crate::projects::types::{Project, ProjectAutoFixSettings, Worktree, WorktreeOrigin};

const AUTO_FIX_TICK_SECONDS: u64 = 10;
/// Start/recovery/yolo attempts per issue or session before Mr. Robot gives up.
const AUTO_FIX_MAX_ATTEMPTS: u32 = 3;
const GITHUB_RATE_LIMIT_BACKOFF_SECS: u64 = 15 * 60;
const AUTO_YOLO_WATCH_SECONDS: u64 = 2;
const AUTO_YOLO_WATCH_ATTEMPTS: usize = 900; // 30 minutes
                                             // Worktree creation can include long setup scripts. Waiting too briefly left
                                             // worktrees that finished later without a session, so allow a generous cap.
                                             // Any worktree that still ends up without a session is recovered by the scan.
const AUTO_FIX_WORKTREE_CREATION_TIMEOUT_SECS: u64 = 30 * 60;

#[derive(Debug)]
enum WorktreeCreationOutcome {
    Created(Box<Worktree>),
    Failed { id: String, error: String },
}

impl WorktreeCreationOutcome {
    fn id(&self) -> &str {
        match self {
            Self::Created(worktree) => &worktree.id,
            Self::Failed { id, .. } => id,
        }
    }
}

#[derive(Deserialize)]
struct WorktreeCreatedPayload {
    worktree: Worktree,
}

#[derive(Deserialize)]
struct WorktreeCreateErrorPayload {
    id: String,
    error: String,
}

fn parse_worktree_created_event(payload: &str) -> Result<WorktreeCreationOutcome, String> {
    serde_json::from_str::<WorktreeCreatedPayload>(payload)
        .map(|event| WorktreeCreationOutcome::Created(Box::new(event.worktree)))
        .map_err(|err| format!("Failed to parse worktree:created event: {err}"))
}

fn parse_worktree_create_error_event(payload: &str) -> Result<WorktreeCreationOutcome, String> {
    serde_json::from_str::<WorktreeCreateErrorPayload>(payload)
        .map(|event| WorktreeCreationOutcome::Failed {
            id: event.id,
            error: event.error,
        })
        .map_err(|err| format!("Failed to parse worktree:error event: {err}"))
}

#[derive(Debug, Clone)]
struct PendingAutoYolo {
    project_id: String,
    project_name: String,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    backend: String,
    model: Option<String>,
    /// Claude custom CLI profile name (None = Anthropic direct).
    provider: Option<String>,
    /// Failed yolo start attempts so far.
    attempts: u32,
}

static PROJECT_RUNTIME: OnceLock<Mutex<HashMap<String, ProjectRuntime>>> = OnceLock::new();
static PENDING_YOLO: OnceLock<Mutex<HashMap<String, PendingAutoYolo>>> = OnceLock::new();
static YOLO_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// `(project_id, issue_number)` pairs whose worktree/session start is in progress.
/// Worktrees are persisted only after `git worktree add` finishes, so without
/// this a scan during creation would start the same issue twice.
static STARTING_ISSUES: OnceLock<Mutex<HashSet<(String, u32)>>> = OnceLock::new();

/// Cached knowledge of whether any project has auto-fix enabled, so idle
/// scheduler ticks can skip reading and parsing projects.json entirely.
/// `UNKNOWN` (boot) forces one full scan, which refreshes the cache through
/// `load_projects_data`; afterwards every projects.json load/save keeps it
/// current via `refresh_auto_fix_scan_cache`.
const AUTO_FIX_CACHE_UNKNOWN: u8 = 0;
const AUTO_FIX_CACHE_DISABLED: u8 = 1;
const AUTO_FIX_CACHE_ENABLED: u8 = 2;
static AUTO_FIX_ENABLED_CACHE: AtomicU8 = AtomicU8::new(AUTO_FIX_CACHE_UNKNOWN);

fn any_project_has_auto_fix_enabled(projects: &[Project]) -> bool {
    projects.iter().any(|project| {
        !project.is_folder
            && project
                .auto_fix_settings
                .as_ref()
                .is_some_and(|settings| settings.enabled)
    })
}

/// Refresh the scheduler gate from freshly loaded/saved projects data.
/// Called from `projects::storage` so every projects.json mutation updates it.
pub fn refresh_auto_fix_scan_cache(projects: &[Project]) {
    let state = if any_project_has_auto_fix_enabled(projects) {
        AUTO_FIX_CACHE_ENABLED
    } else {
        AUTO_FIX_CACHE_DISABLED
    };
    AUTO_FIX_ENABLED_CACHE.store(state, Ordering::Relaxed);
}

fn auto_fix_scan_may_be_needed() -> bool {
    AUTO_FIX_ENABLED_CACHE.load(Ordering::Relaxed) != AUTO_FIX_CACHE_DISABLED
}

/// Per-project scan timing, errors and issue failures. In memory only: a
/// restart clears it, which also gives failed issues a fresh set of attempts.
#[derive(Debug, Default)]
struct ProjectRuntime {
    last_scan_at: Option<u64>,
    next_scan_at: u64,
    rate_limited_until: Option<u64>,
    last_error: Option<AutoFixStatusError>,
    failed_issues: HashMap<u32, AutoFixFailedIssue>,
    scanning: bool,
    last_scan_summary: Option<String>,
    activity: Vec<AutoFixActivity>,
}

fn project_runtime() -> &'static Mutex<HashMap<String, ProjectRuntime>> {
    PROJECT_RUNTIME.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_project_runtime<T>(project_id: &str, f: impl FnOnce(&mut ProjectRuntime) -> T) -> T {
    let mut runtime = project_runtime().lock().expect("auto fix runtime mutex");
    f(runtime.entry(project_id.to_string()).or_default())
}

fn record_activity(project_id: &str, message: String, issue_number: Option<u32>) {
    with_project_runtime(project_id, |runtime| {
        runtime.activity.insert(
            0,
            AutoFixActivity {
                at: now_unix_secs(),
                message,
                issue_number,
            },
        );
        runtime.activity.truncate(30);
    });
}

/// Request the next scheduler tick, without bypassing safety limits.
pub fn request_auto_fix_scan(project_id: &str) -> Result<(), String> {
    with_project_runtime(project_id, |runtime| {
        if runtime.scanning {
            return Err("A scan is already running".to_string());
        }
        if runtime
            .rate_limited_until
            .is_some_and(|until| until > now_unix_secs())
        {
            return Err("Waiting for the GitHub rate limit to reset".to_string());
        }
        runtime.next_scan_at = 0;
        Ok(())
    })
}

// Always release the scan guard, including error and capacity exits.
struct ScanGuard(String);
impl Drop for ScanGuard {
    fn drop(&mut self) {
        with_project_runtime(&self.0, |runtime| runtime.scanning = false);
    }
}

pub async fn preview_auto_fix_issues(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<AutoFixIssuePreview>, String> {
    let data = crate::projects::storage::load_projects_data(&app)?;
    let project = data
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .ok_or("Project not found")?;
    let settings = project
        .auto_fix_settings
        .clone()
        .ok_or("Configure Mr. Robot first")?;
    if get_auto_fix_status(&project_id)
        .rate_limited_until
        .is_some()
    {
        return Err("Waiting for the GitHub rate limit to reset".to_string());
    }
    let issues =
        crate::projects::github_issues::list_open_issue_labels(app, project.path.clone()).await?;
    let worktrees: Vec<Worktree> = data
        .worktrees
        .iter()
        .filter(|worktree| worktree.project_id == project_id)
        .cloned()
        .collect();
    Ok(build_issue_preview(
        &issues,
        &worktrees,
        &settings,
        &starting_issue_numbers(&project_id),
        &gave_up_issue_numbers(&project_id),
    ))
}

fn build_issue_preview(
    issues: &[AutoFixIssueCandidate],
    worktrees: &[Worktree],
    settings: &ProjectAutoFixSettings,
    starting: &HashSet<u32>,
    gave_up: &HashSet<u32>,
) -> Vec<AutoFixIssuePreview> {
    let included = normalized_label_set(&settings.included_labels);
    let excluded = normalized_label_set(&settings.excluded_labels);
    let open: HashSet<u32> = issues.iter().map(|issue| issue.number).collect();
    let inactive: HashSet<String> = closed_auto_fix_issue_worktree_ids(worktrees, &open)
        .into_iter()
        .chain(ineligible_auto_fix_issue_worktree_ids(
            worktrees,
            issues,
            &settings.included_labels,
            &settings.excluded_labels,
        ))
        .collect();
    let active = worktrees
        .iter()
        .filter(|worktree| {
            worktree.archived_at.is_none()
                && matches!(worktree.origin, Some(WorktreeOrigin::AutoFix))
                && !inactive.contains(&worktree.id)
        })
        .count()
        + starting.len();
    let capacity = (settings.max_parallel_worktrees.max(1) as usize).saturating_sub(active);
    let handled: HashSet<u32> = worktrees
        .iter()
        .filter_map(|worktree| worktree.issue_number)
        .chain(starting.iter().copied())
        .chain(gave_up.iter().copied())
        .collect();
    let selected: HashSet<u32> = select_issue_numbers_to_start(
        issues,
        &handled,
        &settings.included_labels,
        &settings.excluded_labels,
        capacity.min(settings.issue_limit.max(1) as usize),
    )
    .into_iter()
    .collect();
    issues
        .iter()
        .map(|issue| {
            let reason = if issue_has_excluded_label(issue, &excluded) {
                "Excluded label"
            } else if !issue_matches_included_labels(issue, &included) {
                "No included label"
            } else if starting.contains(&issue.number) {
                "Starting"
            } else if gave_up.contains(&issue.number) {
                "Retry required"
            } else if handled.contains(&issue.number) {
                "Worktree already exists"
            } else if selected.contains(&issue.number) {
                "Next scan candidate"
            } else if capacity == 0 {
                "Waiting for capacity"
            } else {
                "Waiting for a later scan"
            };
            AutoFixIssuePreview {
                issue_number: issue.number,
                labels: issue.labels.clone(),
                reason: reason.to_string(),
                selected: selected.contains(&issue.number),
            }
        })
        .collect()
}

fn record_project_error(project_id: &str, message: impl Into<String>) {
    let message = message.into();
    record_activity(project_id, message.clone(), None);
    with_project_runtime(project_id, |runtime| {
        runtime.last_error = Some(AutoFixStatusError {
            message,
            at: now_unix_secs(),
        });
    });
}

fn record_issue_failure(project_id: &str, issue_number: u32, error: &str) {
    record_activity(
        project_id,
        format!("Start failed: {error}"),
        Some(issue_number),
    );
    with_project_runtime(project_id, |runtime| {
        let failure = runtime
            .failed_issues
            .entry(issue_number)
            .or_insert_with(|| AutoFixFailedIssue {
                issue_number,
                attempts: 0,
                error: String::new(),
                failed_at: 0,
                gave_up: false,
            });
        failure.attempts += 1;
        failure.error = error.to_string();
        failure.failed_at = now_unix_secs();
        failure.gave_up = failure.attempts >= AUTO_FIX_MAX_ATTEMPTS;
    });
}

fn clear_issue_failure(project_id: &str, issue_number: u32) {
    with_project_runtime(project_id, |runtime| {
        runtime.failed_issues.remove(&issue_number);
    });
}

fn gave_up_issue_numbers(project_id: &str) -> HashSet<u32> {
    with_project_runtime(project_id, |runtime| {
        runtime
            .failed_issues
            .values()
            .filter(|failure| failure.gave_up)
            .map(|failure| failure.issue_number)
            .collect()
    })
}

fn is_github_rate_limit_error(error: &str) -> bool {
    error.to_lowercase().contains("rate limit")
}

fn defer_project_for_rate_limit(project_id: &str) {
    let until = now_unix_secs() + GITHUB_RATE_LIMIT_BACKOFF_SECS;
    with_project_runtime(project_id, |runtime| {
        runtime.rate_limited_until = Some(until);
        runtime.next_scan_at = runtime.next_scan_at.max(until);
    });
}

pub fn get_auto_fix_status(project_id: &str) -> AutoFixStatus {
    let pending_yolo_sessions = pending_yolo()
        .lock()
        .expect("pending auto yolo mutex")
        .values()
        .filter(|entry| entry.project_id == project_id)
        .count();
    let mut starting_issues: Vec<u32> = starting_issue_numbers(project_id).into_iter().collect();
    starting_issues.sort_unstable();
    let now = now_unix_secs();
    with_project_runtime(project_id, |runtime| {
        let mut failed_issues: Vec<AutoFixFailedIssue> =
            runtime.failed_issues.values().cloned().collect();
        failed_issues.sort_by_key(|failure| failure.issue_number);
        AutoFixStatus {
            last_scan_at: runtime.last_scan_at,
            next_scan_at: runtime.last_scan_at.map(|_| runtime.next_scan_at),
            rate_limited_until: runtime.rate_limited_until.filter(|until| *until > now),
            last_error: runtime.last_error.clone(),
            failed_issues,
            starting_issues,
            pending_yolo_sessions,
            scanning: runtime.scanning,
            active_now: true, // The dispatch fills this using server-local active hours.
            last_scan_summary: runtime.last_scan_summary.clone(),
            activity: runtime.activity.clone(),
        }
    })
}

/// Forget failed issues and the last error so failed issues are retried.
pub fn clear_auto_fix_failures(project_id: &str) {
    with_project_runtime(project_id, |runtime| {
        runtime.failed_issues.clear();
        runtime.last_error = None;
    });
    record_activity(
        project_id,
        "Failed issues cleared for retry".to_string(),
        None,
    );
}

fn pending_yolo() -> &'static Mutex<HashMap<String, PendingAutoYolo>> {
    PENDING_YOLO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn auto_yolo_in_flight() -> &'static Mutex<HashSet<String>> {
    YOLO_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

fn starting_issues() -> &'static Mutex<HashSet<(String, u32)>> {
    STARTING_ISSUES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn starting_issue_numbers(project_id: &str) -> HashSet<u32> {
    starting_issues()
        .lock()
        .expect("starting issues mutex")
        .iter()
        .filter(|(id, _)| id == project_id)
        .map(|(_, issue_number)| *issue_number)
        .collect()
}

fn mark_auto_yolo_in_flight(in_flight: &mut HashSet<String>, session_id: &str) -> bool {
    in_flight.insert(session_id.to_string())
}

fn clear_auto_yolo_in_flight(in_flight: &mut HashSet<String>, session_id: &str) {
    in_flight.remove(session_id);
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn select_issue_numbers_to_start(
    issues: &[AutoFixIssueCandidate],
    handled_issue_numbers: &HashSet<u32>,
    included_labels: &[String],
    excluded_labels: &[String],
    limit: usize,
) -> Vec<u32> {
    let included_labels = normalized_label_set(included_labels);
    let excluded_labels = normalized_label_set(excluded_labels);
    issues
        .iter()
        .filter(|issue| !handled_issue_numbers.contains(&issue.number))
        .filter(|issue| issue_is_label_eligible(issue, &included_labels, &excluded_labels))
        .take(limit)
        .map(|issue| issue.number)
        .collect()
}

fn normalized_label_set(labels: &[String]) -> HashSet<String> {
    labels
        .iter()
        .map(|label| normalized_label_name(label))
        .filter(|label| !label.is_empty())
        .collect()
}

fn normalized_label_name(label: &str) -> String {
    label
        .trim()
        .chars()
        .filter(|ch| !matches!(ch, '\u{fe0e}' | '\u{fe0f}'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn issue_has_excluded_label(
    issue: &AutoFixIssueCandidate,
    excluded_labels: &HashSet<String>,
) -> bool {
    issue
        .labels
        .iter()
        .map(|label| normalized_label_name(label))
        .any(|label| excluded_labels.contains(&label))
}

fn issue_matches_included_labels(
    issue: &AutoFixIssueCandidate,
    included_labels: &HashSet<String>,
) -> bool {
    if included_labels.is_empty() {
        return true;
    }

    issue
        .labels
        .iter()
        .map(|label| normalized_label_name(label))
        .any(|label| included_labels.contains(&label))
}

fn issue_is_label_eligible(
    issue: &AutoFixIssueCandidate,
    included_labels: &HashSet<String>,
    excluded_labels: &HashSet<String>,
) -> bool {
    issue_matches_included_labels(issue, included_labels)
        && !issue_has_excluded_label(issue, excluded_labels)
}

pub fn is_backend_quota_or_auth_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("quota")
        || lower.contains("rate limit")
        || lower.contains("usage limit")
        || lower.contains("out of tokens")
        || lower.contains("token expired")
        || lower.contains("not authenticated")
        || lower.contains("authrequired")
        // Claude CLI headless auth prompts (issue #387)
        || lower.contains("not logged in")
        || lower.contains("please run /login")
        || lower.contains("session expired")
        || (lower.contains("isn't available in this environment") && lower.contains("login"))
}

#[derive(Deserialize)]
struct ChatErrorPayload {
    session_id: String,
    error: String,
}

fn record_session_activity(app: &AppHandle, session_id: &str, message: String) {
    let Ok(Some(metadata)) = crate::chat::storage::load_metadata(app, session_id) else {
        return;
    };
    let Ok(data) = crate::projects::storage::load_projects_data(app) else {
        return;
    };
    if let Some(worktree) = data.find_worktree(&metadata.worktree_id) {
        if matches!(worktree.origin, Some(WorktreeOrigin::AutoFix)) {
            record_activity(&worktree.project_id, message, worktree.issue_number);
        }
    }
}

pub fn start_auto_fix_scheduler(app: AppHandle) {
    // Planning/yolo turns run through the chat queue, so backend quota/auth
    // failures only surface as `chat:error` events, not as scheduler errors.
    let error_app = app.clone();
    app.listen("chat:error", move |event| {
        let Ok(payload) = serde_json::from_str::<ChatErrorPayload>(event.payload()) else {
            return;
        };
        record_session_activity(
            &error_app,
            &payload.session_id,
            format!("Session failed: {}", payload.error),
        );
        if !is_backend_quota_or_auth_error(&payload.error) {
            return;
        }
        let app = error_app.clone();
        tauri::async_runtime::spawn(async move {
            stop_auto_fix_for_session_error(&app, &payload.session_id, &payload.error);
        });
    });

    for (event_name, message) in [
        ("chat:done", "Turn completed"),
        ("chat:cancelled", "Turn cancelled"),
    ] {
        let activity_app = app.clone();
        app.listen(event_name, move |event| {
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                return;
            };
            let Some(session_id) = payload
                .get("session_id")
                .or_else(|| payload.get("sessionId"))
                .and_then(|id| id.as_str())
            else {
                return;
            };
            record_session_activity(&activity_app, session_id, message.to_string());
        });
    }

    tauri::async_runtime::spawn(async move {
        loop {
            run_auto_yolo_watch(&app).await;
            if auto_fix_scan_may_be_needed() {
                run_auto_fix_scan(&app).await;
            }
            tokio::time::sleep(Duration::from_secs(AUTO_FIX_TICK_SECONDS)).await;
        }
    });
}

async fn run_auto_fix_scan(app: &AppHandle) {
    let data = match crate::projects::storage::load_projects_data(app) {
        Ok(data) => data,
        Err(err) => {
            log::warn!("Mr. Robot: failed to load projects data: {err}");
            return;
        }
    };

    for project in data.projects.iter().filter(|project| !project.is_folder) {
        let Some(settings) = project.auto_fix_settings.clone() else {
            continue;
        };
        if !settings.enabled {
            continue;
        }
        if !auto_fix_active_now(&settings) {
            continue;
        }
        if !project_due(project, &settings) {
            continue;
        }

        let _scan_guard = ScanGuard(project.id.clone());
        record_activity(&project.id, "Scan started".to_string(), None);

        let project_worktrees: Vec<Worktree> = data
            .worktrees
            .iter()
            .filter(|worktree| worktree.project_id == project.id)
            .cloned()
            .collect();

        let issues = match crate::projects::github_issues::list_open_issue_labels(
            app.clone(),
            project.path.clone(),
        )
        .await
        {
            Ok(issues) => issues,
            Err(err) => {
                log::warn!(
                    "Mr. Robot: failed to list issues for {}: {err}",
                    project.name
                );
                if is_github_rate_limit_error(&err) {
                    defer_project_for_rate_limit(&project.id);
                }
                record_project_error(&project.id, format!("Failed to list GitHub issues: {err}"));
                continue;
            }
        };
        let preview = build_issue_preview(
            &issues,
            &project_worktrees,
            &settings,
            &starting_issue_numbers(&project.id),
            &gave_up_issue_numbers(&project.id),
        );
        let candidates = preview.iter().filter(|issue| issue.selected).count();
        let summary = format!(
            "{} open issues · {candidates} next scan candidates",
            issues.len()
        );
        with_project_runtime(&project.id, |runtime| {
            runtime.last_scan_summary = Some(summary.clone());
            runtime.last_error = None;
        });
        record_activity(&project.id, summary, None);
        let open_issue_numbers: HashSet<u32> = issues.iter().map(|issue| issue.number).collect();
        // Worktrees whose issue closed or no longer matches the label filters are
        // not archived (they may hold uncommitted work), but they stop using
        // capacity, their investigation is stopped, and they never go to yolo.
        let inactive_worktree_ids: HashSet<String> =
            closed_auto_fix_issue_worktree_ids(&project_worktrees, &open_issue_numbers)
                .into_iter()
                .chain(ineligible_auto_fix_issue_worktree_ids(
                    &project_worktrees,
                    &issues,
                    &settings.included_labels,
                    &settings.excluded_labels,
                ))
                .collect();
        clear_pending_auto_yolo_for_worktrees(&inactive_worktree_ids);
        for worktree in project_worktrees
            .iter()
            .filter(|worktree| inactive_worktree_ids.contains(&worktree.id))
        {
            stop_auto_fix_investigation(app, worktree).await;
        }

        let starting = starting_issue_numbers(&project.id);
        let gave_up = gave_up_issue_numbers(&project.id);
        let active_worktrees: Vec<&Worktree> = project_worktrees
            .iter()
            .filter(|worktree| {
                worktree.archived_at.is_none()
                    && !inactive_worktree_ids.contains(&worktree.id)
                    && matches!(worktree.origin, Some(WorktreeOrigin::AutoFix))
            })
            .collect();
        recover_auto_fix_worktrees(
            app,
            project,
            &settings,
            &active_worktrees,
            &starting,
            &gave_up,
        )
        .await;

        let active_auto_fix = active_worktrees.len() + starting.len();
        let max_parallel = settings.max_parallel_worktrees.max(1) as usize;
        if active_auto_fix >= max_parallel {
            continue;
        }

        let capacity = max_parallel - active_auto_fix;
        let limit = (settings.issue_limit.max(1) as usize).min(capacity);
        let handled: HashSet<u32> = project_worktrees
            .iter()
            .filter_map(|worktree| worktree.issue_number)
            .chain(starting)
            .chain(gave_up)
            .collect();

        for issue_number in select_issue_numbers_to_start(
            &issues,
            &handled,
            &settings.included_labels,
            &settings.excluded_labels,
            limit,
        ) {
            let app_clone = app.clone();
            let project_clone = project.clone();
            let settings_clone = settings.clone();
            let starting_key = (project.id.clone(), issue_number);
            starting_issues()
                .lock()
                .expect("starting issues mutex")
                .insert(starting_key.clone());
            tauri::async_runtime::spawn(async move {
                // Errors here come from GitHub, git, or session storage. Backend
                // quota/auth failures arrive later via `chat:error`.
                match start_issue_auto_fix(
                    &app_clone,
                    &project_clone,
                    &settings_clone,
                    issue_number,
                )
                .await
                {
                    Ok(()) => {
                        clear_issue_failure(&project_clone.id, issue_number);
                        record_activity(
                            &project_clone.id,
                            "Planning started".to_string(),
                            Some(issue_number),
                        );
                    }
                    Err(err) => {
                        log::warn!(
                            "Mr. Robot: issue #{issue_number} failed for {}: {err}",
                            project_clone.name
                        );
                        if is_github_rate_limit_error(&err) {
                            // Not the issue's fault: wait, and keep its attempts.
                            defer_project_for_rate_limit(&project_clone.id);
                            record_project_error(&project_clone.id, err);
                        } else {
                            record_issue_failure(&project_clone.id, issue_number, &err);
                        }
                    }
                }
                starting_issues()
                    .lock()
                    .expect("starting issues mutex")
                    .remove(&starting_key);
            });
        }
    }
}

/// Repair Mr. Robot state that lives only in memory or was interrupted:
/// worktrees that never got their investigation (app restart or crash during
/// creation), and plans waiting for approval whose auto-yolo queue entry was
/// lost on restart.
async fn recover_auto_fix_worktrees(
    app: &AppHandle,
    project: &Project,
    settings: &ProjectAutoFixSettings,
    worktrees: &[&Worktree],
    starting: &HashSet<u32>,
    gave_up: &HashSet<u32>,
) {
    for worktree in worktrees {
        if worktree.issue_number.is_some_and(|issue_number| {
            starting.contains(&issue_number) || gave_up.contains(&issue_number)
        }) {
            continue;
        }
        let sessions = match crate::chat::storage::load_sessions(app, &worktree.path, &worktree.id)
        {
            Ok(sessions) => sessions.sessions,
            Err(err) => {
                log::warn!(
                    "Mr. Robot: failed to load sessions for worktree {}: {err}",
                    worktree.id
                );
                continue;
            }
        };
        if worktree_needs_investigation(&sessions) {
            log::info!(
                "Mr. Robot: starting missing investigation for worktree {}",
                worktree.id
            );
            let result = start_auto_fix_investigation(app, project, settings, worktree).await;
            match (result, worktree.issue_number) {
                (Ok(()), Some(issue_number)) => clear_issue_failure(&project.id, issue_number),
                (Ok(()), None) => {}
                (Err(err), issue_number) => {
                    log::warn!(
                        "Mr. Robot: failed to recover worktree {}: {err}",
                        worktree.id
                    );
                    match issue_number {
                        Some(issue_number) => record_issue_failure(&project.id, issue_number, &err),
                        None => record_project_error(&project.id, err),
                    }
                }
            }
            continue;
        }

        if !should_queue_auto_yolo(settings) {
            continue;
        }
        for session in sessions
            .iter()
            .filter(|session| session.archived_at.is_none())
        {
            if session.waiting_for_input_type.as_deref() == Some("plan")
                && session.pending_plan_message_id.is_some()
            {
                queue_pending_auto_yolo(project, settings, worktree, session.id.clone());
            }
        }
    }
}

/// Stop investigation work in a worktree whose issue closed or became
/// ineligible: drop the investigation prompt if it never started, and cancel a
/// running plan-mode turn. Yolo turns are left alone because they may be in
/// the middle of editing files.
async fn stop_auto_fix_investigation(app: &AppHandle, worktree: &Worktree) {
    let sessions = match crate::chat::storage::load_sessions(app, &worktree.path, &worktree.id) {
        Ok(sessions) => sessions.sessions,
        Err(err) => {
            log::warn!(
                "Mr. Robot: failed to load sessions for worktree {}: {err}",
                worktree.id
            );
            return;
        }
    };
    for session in sessions
        .iter()
        .filter(|session| session.archived_at.is_none())
    {
        match investigation_stop_action(
            session,
            crate::chat::registry::is_session_actively_managed(&session.id),
        ) {
            InvestigationStopAction::None => {}
            InvestigationStopAction::ClearQueue => {
                log::info!(
                    "Mr. Robot: dropping queued investigation in worktree {} (issue no longer active)",
                    worktree.id
                );
                if let Err(err) = crate::chat::clear_message_queue(
                    app.clone(),
                    worktree.id.clone(),
                    worktree.path.clone(),
                    session.id.clone(),
                )
                .await
                {
                    log::warn!("Mr. Robot: failed to clear queue for {}: {err}", session.id);
                }
            }
            InvestigationStopAction::Cancel => {
                log::info!(
                    "Mr. Robot: cancelling investigation in worktree {} (issue no longer active)",
                    worktree.id
                );
                if let Err(err) = crate::chat::cancel_chat_message(
                    app.clone(),
                    session.id.clone(),
                    worktree.id.clone(),
                )
                .await
                {
                    log::warn!("Mr. Robot: failed to cancel {}: {err}", session.id);
                }
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum InvestigationStopAction {
    None,
    ClearQueue,
    Cancel,
}

fn investigation_stop_action(
    session: &crate::chat::types::Session,
    actively_running: bool,
) -> InvestigationStopAction {
    if actively_running {
        return if session.last_run_execution_mode.as_deref() == Some("plan") {
            InvestigationStopAction::Cancel
        } else {
            InvestigationStopAction::None
        };
    }
    // Queued prompt of a session that never ran = the unstarted investigation.
    if session.total_runs == 0 && !session.queued_messages.is_empty() {
        return InvestigationStopAction::ClearQueue;
    }
    InvestigationStopAction::None
}

/// True when no non-archived session ever ran or queued a message, i.e. the
/// investigation was never started for this worktree.
fn worktree_needs_investigation(sessions: &[crate::chat::types::Session]) -> bool {
    sessions
        .iter()
        .filter(|session| session.archived_at.is_none())
        .all(|session| session.total_runs == 0 && session.queued_messages.is_empty())
}

fn within_active_window(start: u8, end: u8, hour: u8) -> bool {
    if start == end {
        return true; // empty/full = no restriction
    }
    if start < end {
        hour >= start && hour < end
    } else {
        hour >= start || hour < end // crosses midnight (e.g. 20->8)
    }
}

pub fn auto_fix_active_now(settings: &ProjectAutoFixSettings) -> bool {
    if !settings.active_hours_enabled {
        return true;
    }
    use chrono::Timelike;
    let hour = chrono::Local::now().hour() as u8;
    within_active_window(settings.active_hours_start, settings.active_hours_end, hour)
}

fn should_queue_auto_yolo(settings: &ProjectAutoFixSettings) -> bool {
    settings.auto_yolo_enabled
}

fn project_due(project: &Project, settings: &ProjectAutoFixSettings) -> bool {
    let now = now_unix_secs();
    let interval = settings.interval_minutes.max(1) * 60;
    with_project_runtime(&project.id, |runtime| {
        if runtime.scanning || now < runtime.next_scan_at {
            return false;
        }
        runtime.scanning = true;
        runtime.last_scan_at = Some(now);
        runtime.next_scan_at = now + interval;
        true
    })
}

fn closed_auto_fix_issue_worktree_ids(
    worktrees: &[Worktree],
    open_issue_numbers: &HashSet<u32>,
) -> Vec<String> {
    worktrees
        .iter()
        .filter(|worktree| {
            worktree.archived_at.is_none()
                && matches!(worktree.origin, Some(WorktreeOrigin::AutoFix))
                && worktree
                    .issue_number
                    .is_some_and(|issue_number| !open_issue_numbers.contains(&issue_number))
        })
        .map(|worktree| worktree.id.clone())
        .collect()
}

fn ineligible_auto_fix_issue_worktree_ids(
    worktrees: &[Worktree],
    issues: &[AutoFixIssueCandidate],
    included_labels: &[String],
    excluded_labels: &[String],
) -> Vec<String> {
    let included_labels = normalized_label_set(included_labels);
    let excluded_labels = normalized_label_set(excluded_labels);
    let issues_by_number: HashMap<u32, &AutoFixIssueCandidate> =
        issues.iter().map(|issue| (issue.number, issue)).collect();

    worktrees
        .iter()
        .filter(|worktree| {
            worktree.archived_at.is_none()
                && matches!(worktree.origin, Some(WorktreeOrigin::AutoFix))
                && worktree
                    .issue_number
                    .and_then(|issue_number| issues_by_number.get(&issue_number))
                    .is_some_and(|issue| {
                        !issue_is_label_eligible(issue, &included_labels, &excluded_labels)
                    })
        })
        .map(|worktree| worktree.id.clone())
        .collect()
}

fn build_auto_fix_investigation_prompt(
    prefs: &crate::AppPreferences,
    worktree: &Worktree,
) -> String {
    let worktree_value = serde_json::to_value(worktree).unwrap_or_else(|_| serde_json::json!({}));
    crate::jean_mcp_core::build_investigation_prompt(
        prefs,
        &worktree_value,
        crate::jean_mcp_core::InvestigationKind::Issue,
    )
}

async fn start_issue_auto_fix(
    app: &AppHandle,
    project: &Project,
    settings: &ProjectAutoFixSettings,
    issue_number: u32,
) -> Result<(), String> {
    let issue = crate::projects::github_issues::get_github_issue(
        app.clone(),
        project.path.clone(),
        issue_number,
    )
    .await?;
    // The issue may have closed between the scan and this fetch.
    if !issue.state.eq_ignore_ascii_case("open") {
        log::info!("Mr. Robot: skipping issue #{issue_number} because it is no longer open");
        return Ok(());
    }
    let comments: Vec<GitHubComment> = issue.comments;
    let issue_context = IssueContext {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        comments,
    };

    let ready_worktree = create_auto_fix_worktree(app, project.id.clone(), issue_context).await?;
    start_auto_fix_investigation(app, project, settings, &ready_worktree).await
}

async fn start_auto_fix_investigation(
    app: &AppHandle,
    project: &Project,
    settings: &ProjectAutoFixSettings,
    worktree: &Worktree,
) -> Result<(), String> {
    let prefs = crate::load_preferences(app.clone()).await?;
    let prompt = build_auto_fix_investigation_prompt(&prefs, worktree);
    let model = settings
        .planning_model
        .clone()
        .unwrap_or_else(|| default_model_for_backend(&settings.planning_backend));
    let planning_provider = normalize_claude_provider(
        &settings.planning_backend,
        settings.planning_provider.as_deref(),
    );

    let result = crate::jean_mcp_core::start_background_investigation_impl(
        app,
        worktree.id.clone(),
        worktree.path.clone(),
        prompt,
        model,
        settings.planning_backend.clone(),
        planning_provider.clone(),
        None,
        planning_provider.clone(),
        None,
        None,
        None,
        None,
        Some("auto_fix".to_string()),
        None,
        false,
    )
    .await?;

    if !should_queue_auto_yolo(settings) {
        return Ok(());
    }

    if queue_pending_auto_yolo(project, settings, worktree, result.session_id.clone()) {
        spawn_pending_auto_yolo_watch(app.clone(), result.session_id);
    }

    Ok(())
}

/// Queue a session for automatic plan approval + yolo. Returns false when the
/// session is already queued or its yolo start is in flight.
fn queue_pending_auto_yolo(
    project: &Project,
    settings: &ProjectAutoFixSettings,
    worktree: &Worktree,
    session_id: String,
) -> bool {
    if auto_yolo_in_flight()
        .lock()
        .expect("auto yolo in flight mutex")
        .contains(&session_id)
    {
        return false;
    }
    let mut pending = pending_yolo().lock().expect("pending auto yolo mutex");
    if pending.contains_key(&session_id) {
        return false;
    }
    pending.insert(
        session_id.clone(),
        PendingAutoYolo {
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            worktree_id: worktree.id.clone(),
            worktree_path: worktree.path.clone(),
            session_id,
            backend: settings.yolo_backend.clone(),
            model: settings.yolo_model.clone(),
            provider: normalize_claude_provider(
                &settings.yolo_backend,
                settings.yolo_provider.as_deref(),
            ),
            attempts: 0,
        },
    );
    true
}

async fn create_auto_fix_worktree(
    app: &AppHandle,
    project_id: String,
    issue_context: IssueContext,
) -> Result<Worktree, String> {
    let (outcome_tx, mut outcome_rx) = tokio::sync::mpsc::unbounded_channel();
    let created_tx = outcome_tx.clone();
    let created_listener =
        app.listen(
            "worktree:created",
            move |event| match parse_worktree_created_event(event.payload()) {
                Ok(outcome) => {
                    let _ = created_tx.send(outcome);
                }
                Err(err) => log::warn!("Mr. Robot: {err}"),
            },
        );
    let error_listener =
        app.listen(
            "worktree:error",
            move |event| match parse_worktree_create_error_event(event.payload()) {
                Ok(outcome) => {
                    let _ = outcome_tx.send(outcome);
                }
                Err(err) => log::warn!("Mr. Robot: {err}"),
            },
        );

    let pending_result = crate::projects::create_worktree(
        app.clone(),
        project_id,
        None,
        Some(issue_context),
        None,
        None,
        None,
        None,
        None,
        None,
        Some(false),
        Some("auto_fix".to_string()),
    )
    .await;

    let pending_worktree = match pending_result {
        Ok(worktree) => worktree,
        Err(err) => {
            app.unlisten(created_listener);
            app.unlisten(error_listener);
            return Err(err);
        }
    };

    let result = tokio::time::timeout(
        Duration::from_secs(AUTO_FIX_WORKTREE_CREATION_TIMEOUT_SECS),
        async {
            while let Some(outcome) = outcome_rx.recv().await {
                if outcome.id() != pending_worktree.id {
                    continue;
                }
                return match outcome {
                    WorktreeCreationOutcome::Created(worktree) => Ok(*worktree),
                    WorktreeCreationOutcome::Failed { error, .. } => Err(error),
                };
            }
            Err(format!(
                "Worktree creation event channel closed for {}",
                pending_worktree.id
            ))
        },
    )
    .await
    .unwrap_or_else(|_| {
        Err(format!(
            "Timed out after {AUTO_FIX_WORKTREE_CREATION_TIMEOUT_SECS}s waiting for Mr. Robot worktree {} creation to finish",
            pending_worktree.id
        ))
    });

    app.unlisten(created_listener);
    app.unlisten(error_listener);
    result
}

async fn run_auto_yolo_watch(app: &AppHandle) {
    let pending_session_ids: Vec<String> = pending_yolo()
        .lock()
        .expect("pending auto yolo mutex")
        .keys()
        .cloned()
        .collect();

    for session_id in pending_session_ids {
        try_start_auto_yolo_if_ready(app, &session_id).await;
    }
}

fn spawn_pending_auto_yolo_watch(app: AppHandle, session_id: String) {
    tauri::async_runtime::spawn(async move {
        for _ in 0..AUTO_YOLO_WATCH_ATTEMPTS {
            if !pending_yolo()
                .lock()
                .expect("pending auto yolo mutex")
                .contains_key(&session_id)
            {
                return;
            }
            if auto_yolo_in_flight()
                .lock()
                .expect("auto yolo in flight mutex")
                .contains(&session_id)
            {
                return;
            }

            try_start_auto_yolo_if_ready(&app, &session_id).await;

            tokio::time::sleep(Duration::from_secs(AUTO_YOLO_WATCH_SECONDS)).await;
        }
    });
}

async fn try_start_auto_yolo_if_ready(app: &AppHandle, session_id: &str) {
    let Some(entry) = pending_yolo()
        .lock()
        .expect("pending auto yolo mutex")
        .get(session_id)
        .cloned()
    else {
        return;
    };

    let Ok(status) = crate::chat::get_session_status(app.clone(), entry.session_id.clone()).await
    else {
        return;
    };
    if status
        .get("waitingForInputType")
        .and_then(|value| value.as_str())
        != Some("plan")
    {
        return;
    }

    // Mr. Robot (or its auto-yolo option) may have been switched off while the
    // plan was running. Never approve and execute a plan after that.
    if !project_auto_yolo_enabled(app, &entry.project_id) {
        log::info!(
            "Mr. Robot: skipping auto-yolo for session {} because it is disabled",
            entry.session_id
        );
        pending_yolo()
            .lock()
            .expect("pending auto yolo mutex")
            .remove(&entry.session_id);
        return;
    }

    {
        let mut in_flight = auto_yolo_in_flight()
            .lock()
            .expect("auto yolo in flight mutex");
        if !mark_auto_yolo_in_flight(&mut in_flight, &entry.session_id) {
            return;
        }
    }

    pending_yolo()
        .lock()
        .expect("pending auto yolo mutex")
        .remove(&entry.session_id);
    record_activity(&entry.project_id, "Building started".to_string(), None);
    spawn_auto_yolo_start(app.clone(), entry);
}

fn spawn_auto_yolo_start(app: AppHandle, entry: PendingAutoYolo) {
    tauri::async_runtime::spawn(async move {
        let result = approve_plan_and_start_yolo(&app, &entry).await;
        clear_auto_yolo_in_flight(
            &mut auto_yolo_in_flight()
                .lock()
                .expect("auto yolo in flight mutex"),
            &entry.session_id,
        );

        if let Err(err) = result {
            log::warn!("Mr. Robot: yolo start failed: {err}");
            if is_backend_quota_or_auth_error(&err) {
                let project = project_from_pending_auto_yolo(&entry);
                emit_auto_fix_stopped(&app, &project, &entry.backend, &err);
            } else if entry.attempts + 1 >= AUTO_FIX_MAX_ATTEMPTS {
                record_project_error(
                    &entry.project_id,
                    format!(
                        "Gave up running the plan with Full access for session {} after {AUTO_FIX_MAX_ATTEMPTS} attempts: {err}",
                        entry.session_id
                    ),
                );
            } else {
                let session_id = entry.session_id.clone();
                let entry = PendingAutoYolo {
                    attempts: entry.attempts + 1,
                    ..entry
                };
                pending_yolo()
                    .lock()
                    .expect("pending auto yolo mutex")
                    .insert(entry.session_id.clone(), entry);
                spawn_pending_auto_yolo_watch(app.clone(), session_id);
            }
        }
    });
}

fn project_from_pending_auto_yolo(entry: &PendingAutoYolo) -> Project {
    Project {
        id: entry.project_id.clone(),
        name: entry.project_name.clone(),
        path: String::new(),
        default_branch: String::new(),
        added_at: 0,
        order: 0,
        parent_id: None,
        is_folder: false,
        avatar_path: None,
        default_avatar_path: None,
        enabled_mcp_servers: None,
        known_mcp_servers: Vec::new(),
        custom_system_prompt: None,
        default_provider: None,
        default_backend: None,
        worktrees_dir: None,
        linear_api_key: None,
        linear_team_id: None,
        sentry_auth_token: None,
        sentry_organization_slug: None,
        sentry_project_slug: None,
        sentry_base_url: None,
        linked_project_ids: Vec::new(),
        auto_fix_settings: None,
        server: None,
    }
}

async fn approve_plan_and_start_yolo(
    app: &AppHandle,
    entry: &PendingAutoYolo,
) -> Result<(), String> {
    let session = crate::chat::get_session(
        app.clone(),
        entry.worktree_id.clone(),
        entry.worktree_path.clone(),
        entry.session_id.clone(),
        Some(20),
    )
    .await?;
    if let Some(message_id) = session.pending_plan_message_id.clone() {
        crate::chat::mark_plan_approved(
            app.clone(),
            entry.worktree_id.clone(),
            entry.worktree_path.clone(),
            entry.session_id.clone(),
            message_id,
        )
        .await?;
    }

    let model = entry
        .model
        .clone()
        .unwrap_or_else(|| default_model_for_backend(&entry.backend));
    crate::chat::set_session_backend(
        app.clone(),
        entry.worktree_id.clone(),
        entry.worktree_path.clone(),
        entry.session_id.clone(),
        entry.backend.clone(),
    )
    .await?;
    crate::chat::set_session_model(
        app.clone(),
        entry.worktree_id.clone(),
        entry.worktree_path.clone(),
        entry.session_id.clone(),
        model.clone(),
    )
    .await?;
    crate::chat::set_session_provider(
        app.clone(),
        entry.worktree_id.clone(),
        entry.worktree_path.clone(),
        entry.session_id.clone(),
        entry.provider.clone(),
    )
    .await?;

    crate::chat::update_session_state(
        app.clone(),
        entry.worktree_id.clone(),
        entry.worktree_path.clone(),
        entry.session_id.clone(),
        None,
        None,
        None,
        None,
        None,
        None, // pending_opencode_permission_requests
        None,
        None,
        None,
        None,
        None,
        Some(false),
        None, // status_override
        Some(false),
        Some(None),
        None,
        Some(None),
        None,
        None,
        None,
        None,
        Some(Some("yolo".to_string())),
        None,
        None, // hidden_table_checklists
        None, // pinned_tables
        None, // selected_permission_mode
    )
    .await?;
    let _ = crate::chat::broadcast_session_setting(
        app.clone(),
        entry.session_id.clone(),
        "executionMode".to_string(),
        "yolo".to_string(),
    )
    .await;
    let _ = crate::chat::broadcast_session_setting(
        app.clone(),
        entry.session_id.clone(),
        "waitingForInput".to_string(),
        "false".to_string(),
    )
    .await;

    crate::chat::send_chat_message(
        app.clone(),
        entry.session_id.clone(),
        entry.worktree_id.clone(),
        entry.worktree_path.clone(),
        "[Mr. Robot Full access]\nPlan approved automatically. Begin a new Full access execution turn now. Execute the approved plan, implement the fixes immediately, and do not continue planning or ask for confirmation."
            .to_string(),
        Some(model),
        Some("yolo".to_string()),
        Some(ThinkingLevel::Off),
        Some(EffortLevel::Medium),
        None,
        None,
        None,
        None,
        None,
        entry.provider.clone(),
        Some(entry.backend.clone()),
        None,
    )
    .await?;

    Ok(())
}

fn clear_pending_auto_yolo_for_worktrees(worktree_ids: &HashSet<String>) {
    if worktree_ids.is_empty() {
        return;
    }
    pending_yolo()
        .lock()
        .expect("pending auto yolo mutex")
        .retain(|_, entry| !worktree_ids.contains(&entry.worktree_id));
}

fn clear_pending_auto_yolo_for_project(project_id: &str) {
    pending_yolo()
        .lock()
        .expect("pending auto yolo mutex")
        .retain(|_, entry| entry.project_id != project_id);
}

fn project_auto_yolo_enabled(app: &AppHandle, project_id: &str) -> bool {
    let Ok(data) = crate::projects::storage::load_projects_data(app) else {
        return false;
    };
    data.projects
        .iter()
        .find(|project| project.id == project_id)
        .and_then(|project| project.auto_fix_settings.as_ref())
        .is_some_and(|settings| settings.enabled && settings.auto_yolo_enabled)
}

/// Stop Mr. Robot for the project owning `session_id` when a backend quota/auth
/// error hits one of its worktrees. Sessions outside Mr. Robot worktrees are ignored.
fn stop_auto_fix_for_session_error(app: &AppHandle, session_id: &str, error: &str) {
    let Ok(Some(metadata)) = crate::chat::storage::load_metadata(app, session_id) else {
        return;
    };
    let Ok(data) = crate::projects::storage::load_projects_data(app) else {
        return;
    };
    let Some(worktree) = data.find_worktree(&metadata.worktree_id) else {
        return;
    };
    if !matches!(worktree.origin, Some(WorktreeOrigin::AutoFix)) {
        return;
    }
    let Some(project) = data
        .projects
        .iter()
        .find(|project| project.id == worktree.project_id)
    else {
        return;
    };
    let backend = serde_json::to_value(&metadata.backend)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    emit_auto_fix_stopped(app, project, &backend, error);
}

fn emit_auto_fix_stopped(app: &AppHandle, project: &Project, backend: &str, error: &str) {
    clear_pending_auto_yolo_for_project(&project.id);
    record_project_error(
        &project.id,
        format!("Stopped after a {backend} quota/auth error: {error}"),
    );
    // The same failure can be reported by both `chat:error` and the yolo start
    // path. Only notify once, when this call actually switched Mr. Robot off.
    if !disable_project_auto_fix(app, &project.id) {
        return;
    }
    let event = AutoFixStoppedEvent {
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        backend: backend.to_string(),
        error: error.to_string(),
    };
    if let Err(err) = app.emit_all("auto-fix:stopped", &event) {
        log::warn!("Mr. Robot: failed to emit stop notification: {err}");
    }
}

/// Returns true when Mr. Robot was enabled and is now disabled.
fn disable_project_auto_fix(app: &AppHandle, project_id: &str) -> bool {
    let Ok(mut data) = crate::projects::storage::load_projects_data(app) else {
        return false;
    };
    let Some(project) = data.find_project_mut(project_id) else {
        return false;
    };
    let Some(settings) = project.auto_fix_settings.as_mut() else {
        return false;
    };
    if !settings.enabled {
        return false;
    }
    settings.enabled = false;
    if let Err(err) = crate::projects::storage::save_projects_data(app, &data) {
        log::warn!("Mr. Robot: failed to disable project setting: {err}");
        return false;
    }
    true
}

/// Only Claude custom CLI profiles are valid providers; other backends ignore them.
fn normalize_claude_provider(backend: &str, provider: Option<&str>) -> Option<String> {
    if backend != "claude" {
        return None;
    }
    let trimmed = provider?.trim();
    if trimmed.is_empty()
        || trimmed == "__anthropic__"
        || trimmed == "__default__"
        || trimmed.eq_ignore_ascii_case("anthropic")
        || trimmed.eq_ignore_ascii_case("default")
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn default_model_for_backend(backend: &str) -> String {
    match backend {
        "codex" => crate::default_codex_model(),
        "opencode" => crate::default_opencode_model(),
        "cursor" => "cursor/auto".to_string(),
        "pi" => "pi/sonnet".to_string(),
        "commandcode" => "commandcode/default".to_string(),
        "grok" => "grok/grok-4.6".to_string(),
        "antigravity" => "antigravity/auto".to_string(),
        _ => "claude-opus-5-5".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_auto_fix_settings(enabled: bool) -> ProjectAutoFixSettings {
        ProjectAutoFixSettings {
            enabled,
            interval_minutes: 15,
            issue_limit: 1,
            max_parallel_worktrees: 1,
            included_labels: Vec::new(),
            excluded_labels: Vec::new(),
            planning_backend: "claude".to_string(),
            planning_model: None,
            planning_provider: None,
            auto_yolo_enabled: false,
            yolo_backend: "claude".to_string(),
            yolo_model: None,
            yolo_provider: None,
            active_hours_enabled: false,
            active_hours_start: 20,
            active_hours_end: 8,
        }
    }

    fn test_project(
        id: &str,
        auto_fix_settings: Option<ProjectAutoFixSettings>,
        is_folder: bool,
    ) -> Project {
        Project {
            id: id.to_string(),
            name: id.to_string(),
            path: String::new(),
            default_branch: String::new(),
            added_at: 0,
            order: 0,
            parent_id: None,
            is_folder,
            avatar_path: None,
            default_avatar_path: None,
            enabled_mcp_servers: None,
            known_mcp_servers: Vec::new(),
            custom_system_prompt: None,
            default_provider: None,
            default_backend: None,
            worktrees_dir: None,
            linear_api_key: None,
            linear_team_id: None,
            sentry_auth_token: None,
            sentry_organization_slug: None,
            sentry_project_slug: None,
            sentry_base_url: None,
            linked_project_ids: Vec::new(),
            auto_fix_settings,
            server: None,
        }
    }

    fn test_worktree(
        id: &str,
        issue_number: Option<u32>,
        origin: Option<WorktreeOrigin>,
        archived_at: Option<u64>,
    ) -> Worktree {
        Worktree {
            id: id.to_string(),
            project_id: "project".to_string(),
            name: id.to_string(),
            path: format!("/tmp/{id}"),
            branch: id.to_string(),
            base_branch: Some("main".to_string()),
            base_remote: None,
            created_at: 1,
            setup_output: None,
            setup_script: None,
            setup_success: None,
            session_type: crate::projects::types::SessionType::Worktree,
            pr_number: None,
            pr_url: None,
            issue_number,
            linear_issue_identifier: None,
            security_alert_number: None,
            security_alert_url: None,
            advisory_ghsa_id: None,
            advisory_url: None,
            cached_pr_status: None,
            cached_check_status: None,
            cached_behind_count: None,
            cached_ahead_count: None,
            cached_status_at: None,
            cached_uncommitted_added: None,
            cached_uncommitted_removed: None,
            cached_branch_diff_added: None,
            cached_branch_diff_removed: None,
            cached_base_branch_ahead_count: None,
            cached_base_branch_behind_count: None,
            cached_worktree_ahead_count: None,
            cached_unpushed_count: None,
            pr_push_remote: None,
            pr_push_branch: None,
            order: 0,
            origin,
            archived_at,
            labels: Vec::new(),
            label: None,
            last_opened_at: None,
        }
    }

    #[test]
    fn detects_any_project_with_auto_fix_enabled() {
        assert!(!any_project_has_auto_fix_enabled(&[]));
        assert!(!any_project_has_auto_fix_enabled(&[
            test_project("no-settings", None, false),
            test_project("disabled", Some(test_auto_fix_settings(false)), false),
        ]));
        // Folders are skipped by the scan, so they must not keep the gate open.
        assert!(!any_project_has_auto_fix_enabled(&[test_project(
            "folder",
            Some(test_auto_fix_settings(true)),
            true,
        )]));
        assert!(any_project_has_auto_fix_enabled(&[
            test_project("disabled", Some(test_auto_fix_settings(false)), false),
            test_project("enabled", Some(test_auto_fix_settings(true)), false),
        ]));
    }

    #[test]
    fn scan_cache_skips_ticks_only_when_known_disabled() {
        // Unknown (boot) must scan so the cache can be populated.
        AUTO_FIX_ENABLED_CACHE.store(AUTO_FIX_CACHE_UNKNOWN, Ordering::Relaxed);
        assert!(auto_fix_scan_may_be_needed());

        refresh_auto_fix_scan_cache(&[test_project(
            "disabled",
            Some(test_auto_fix_settings(false)),
            false,
        )]);
        assert!(!auto_fix_scan_may_be_needed());

        refresh_auto_fix_scan_cache(&[test_project(
            "enabled",
            Some(test_auto_fix_settings(true)),
            false,
        )]);
        assert!(auto_fix_scan_may_be_needed());
    }

    #[test]
    fn skips_handled_issues_and_respects_limit() {
        let issues = vec![
            AutoFixIssueCandidate {
                number: 1,
                labels: Vec::new(),
            },
            AutoFixIssueCandidate {
                number: 2,
                labels: Vec::new(),
            },
            AutoFixIssueCandidate {
                number: 3,
                labels: Vec::new(),
            },
            AutoFixIssueCandidate {
                number: 4,
                labels: Vec::new(),
            },
        ];
        let handled = HashSet::from([2, 4]);

        let selected = select_issue_numbers_to_start(&issues, &handled, &[], &[], 2);

        assert_eq!(selected, vec![1, 3]);
    }

    #[test]
    fn skips_issues_with_excluded_labels_case_insensitively() {
        let issues = vec![
            AutoFixIssueCandidate {
                number: 1,
                labels: vec!["bug".to_string()],
            },
            AutoFixIssueCandidate {
                number: 2,
                labels: vec!["wontfix".to_string()],
            },
            AutoFixIssueCandidate {
                number: 3,
                labels: vec!["Do Not Fix".to_string()],
            },
        ];
        let excluded_labels = vec!["WONTFIX".to_string(), "do not fix".to_string()];

        let selected =
            select_issue_numbers_to_start(&issues, &HashSet::new(), &[], &excluded_labels, 3);

        assert_eq!(selected, vec![1]);
    }

    #[test]
    fn skips_issues_when_emoji_label_differs_only_by_variation_selector() {
        let issues = vec![
            AutoFixIssueCandidate {
                number: 1,
                labels: vec!["bug".to_string()],
            },
            AutoFixIssueCandidate {
                number: 2,
                labels: vec!["🤖️ mr robot skip".to_string()],
            },
        ];
        let excluded_labels = vec!["🤖 mr robot skip".to_string()];

        let selected =
            select_issue_numbers_to_start(&issues, &HashSet::new(), &[], &excluded_labels, 2);

        assert_eq!(selected, vec![1]);
    }

    #[test]
    fn included_labels_union_then_excluded_labels_remove_matches() {
        let issues = vec![
            AutoFixIssueCandidate {
                number: 1,
                labels: vec!["bug".to_string()],
            },
            AutoFixIssueCandidate {
                number: 2,
                labels: vec!["enhancement".to_string()],
            },
            AutoFixIssueCandidate {
                number: 3,
                labels: vec!["bug".to_string(), "wontfix".to_string()],
            },
            AutoFixIssueCandidate {
                number: 4,
                labels: vec!["question".to_string()],
            },
        ];
        let included_labels = vec!["BUG".to_string(), "enhancement".to_string()];
        let excluded_labels = vec!["wontfix".to_string()];

        let selected = select_issue_numbers_to_start(
            &issues,
            &HashSet::new(),
            &included_labels,
            &excluded_labels,
            10,
        );

        assert_eq!(selected, vec![1, 2]);
    }

    #[test]
    fn active_window_same_day() {
        assert!(within_active_window(8, 17, 8));
        assert!(within_active_window(8, 17, 12));
        assert!(!within_active_window(8, 17, 17));
        assert!(!within_active_window(8, 17, 7));
        assert!(!within_active_window(8, 17, 20));
    }

    #[test]
    fn active_window_crosses_midnight() {
        assert!(within_active_window(20, 8, 22));
        assert!(within_active_window(20, 8, 2));
        assert!(within_active_window(20, 8, 20));
        assert!(!within_active_window(20, 8, 8));
        assert!(!within_active_window(20, 8, 12));
    }

    #[test]
    fn active_window_equal_bounds_always_active() {
        assert!(within_active_window(0, 0, 0));
        assert!(within_active_window(9, 9, 23));
    }

    #[test]
    fn detects_backend_quota_or_auth_errors() {
        assert!(is_backend_quota_or_auth_error(
            "Codex token expired. Run `codex` to log in again."
        ));
        assert!(is_backend_quota_or_auth_error(
            "Claude usage limit reached for this plan"
        ));
        assert!(is_backend_quota_or_auth_error(
            "Not logged in · Please run /login"
        ));
        assert!(is_backend_quota_or_auth_error(
            "/login isn't available in this environment."
        ));
        assert!(!is_backend_quota_or_auth_error(
            "worktree path already exists"
        ));
    }

    #[test]
    fn auto_yolo_in_flight_guard_prevents_duplicate_starts() {
        let mut in_flight = HashSet::new();

        assert!(mark_auto_yolo_in_flight(&mut in_flight, "session-1"));
        assert!(!mark_auto_yolo_in_flight(&mut in_flight, "session-1"));

        clear_auto_yolo_in_flight(&mut in_flight, "session-1");
        assert!(mark_auto_yolo_in_flight(&mut in_flight, "session-1"));
    }

    #[test]
    fn creation_events_return_the_completed_worktree_or_exact_error() {
        let worktree = test_worktree("worktree-1", Some(42), Some(WorktreeOrigin::AutoFix), None);
        let created_payload = serde_json::json!({
            "worktree": worktree,
            "autoOpenInJean": false,
        })
        .to_string();
        let error_payload = serde_json::json!({
            "id": "worktree-1",
            "project_id": "project",
            "error": "git worktree add failed",
        })
        .to_string();

        let created = parse_worktree_created_event(&created_payload).unwrap();
        let failed = parse_worktree_create_error_event(&error_payload).unwrap();

        assert_eq!(created.id(), "worktree-1");
        assert_eq!(failed.id(), "worktree-1");
        assert!(matches!(
            created,
            WorktreeCreationOutcome::Created(worktree) if worktree.issue_number == Some(42)
        ));
        assert!(matches!(
            failed,
            WorktreeCreationOutcome::Failed { error, .. } if error == "git worktree add failed"
        ));
    }

    #[test]
    fn default_models_cover_all_auto_fix_backends() {
        assert_eq!(
            default_model_for_backend("claude"),
            "claude-opus-5-5".to_string()
        );
        assert_eq!(
            default_model_for_backend("codex"),
            "gpt-6.1-sol".to_string()
        );
        assert_eq!(
            default_model_for_backend("opencode"),
            "opencode/gpt-6.1-sol".to_string()
        );
        assert_eq!(
            default_model_for_backend("grok"),
            "grok/grok-4.6".to_string()
        );
        assert_eq!(
            default_model_for_backend("antigravity"),
            "antigravity/auto".to_string()
        );
        assert_eq!(
            default_model_for_backend("cursor"),
            "cursor/auto".to_string()
        );
        assert_eq!(default_model_for_backend("pi"), "pi/sonnet".to_string());
        assert_eq!(
            default_model_for_backend("commandcode"),
            "commandcode/default".to_string()
        );
    }

    #[test]
    fn selects_only_open_auto_fix_worktrees_with_closed_issues_for_archive() {
        let open_issue_numbers = HashSet::from([1, 3]);
        let worktrees = vec![
            test_worktree("auto-open", Some(1), Some(WorktreeOrigin::AutoFix), None),
            test_worktree("auto-closed", Some(2), Some(WorktreeOrigin::AutoFix), None),
            test_worktree("manual-closed", Some(2), Some(WorktreeOrigin::Manual), None),
            test_worktree(
                "archived-auto-closed",
                Some(2),
                Some(WorktreeOrigin::AutoFix),
                Some(123),
            ),
            test_worktree("auto-no-issue", None, Some(WorktreeOrigin::AutoFix), None),
        ];

        let selected = closed_auto_fix_issue_worktree_ids(&worktrees, &open_issue_numbers);

        assert_eq!(selected, vec!["auto-closed".to_string()]);
    }

    #[test]
    fn selects_auto_fix_worktrees_whose_issue_is_no_longer_label_eligible_for_archive() {
        let issues = vec![
            AutoFixIssueCandidate {
                number: 1,
                labels: vec!["bug".to_string()],
            },
            AutoFixIssueCandidate {
                number: 2,
                labels: vec!["🤖 mr robot skip".to_string()],
            },
            AutoFixIssueCandidate {
                number: 3,
                labels: vec!["enhancement".to_string()],
            },
        ];
        let worktrees = vec![
            test_worktree(
                "auto-eligible",
                Some(1),
                Some(WorktreeOrigin::AutoFix),
                None,
            ),
            test_worktree(
                "auto-excluded",
                Some(2),
                Some(WorktreeOrigin::AutoFix),
                None,
            ),
            test_worktree(
                "manual-excluded",
                Some(2),
                Some(WorktreeOrigin::Manual),
                None,
            ),
            test_worktree(
                "archived-auto-excluded",
                Some(2),
                Some(WorktreeOrigin::AutoFix),
                Some(123),
            ),
            test_worktree(
                "auto-not-included",
                Some(3),
                Some(WorktreeOrigin::AutoFix),
                None,
            ),
        ];

        let selected = ineligible_auto_fix_issue_worktree_ids(
            &worktrees,
            &issues,
            &["bug".to_string(), "🤖 mr robot skip".to_string()],
            &["🤖 mr robot skip".to_string()],
        );

        assert_eq!(
            selected,
            vec!["auto-excluded".to_string(), "auto-not-included".to_string()]
        );
    }

    #[test]
    fn auto_fix_investigation_prompt_reuses_investigate_issue_prompt() {
        let mut prefs = crate::AppPreferences::default();
        prefs.magic_prompts.investigate_issue =
            Some("Custom investigate {issueWord} prompt for {issueRefs}".to_string());
        let worktree = test_worktree("auto-issue", Some(42), Some(WorktreeOrigin::AutoFix), None);

        let prompt = build_auto_fix_investigation_prompt(&prefs, &worktree);

        assert_eq!(prompt, "Custom investigate issue prompt for #42");
    }

    #[test]
    fn clears_pending_auto_yolo_entries_for_stopped_project() {
        let entry_for_stopped_project = PendingAutoYolo {
            project_id: "project-1".to_string(),
            project_name: "Project 1".to_string(),
            worktree_id: "worktree-1".to_string(),
            worktree_path: "/tmp/worktree-1".to_string(),
            session_id: "session-1".to_string(),
            backend: "claude".to_string(),
            model: None,
            provider: None,
            attempts: 0,
        };
        let entry_for_other_project = PendingAutoYolo {
            project_id: "project-2".to_string(),
            project_name: "Project 2".to_string(),
            worktree_id: "worktree-2".to_string(),
            worktree_path: "/tmp/worktree-2".to_string(),
            session_id: "session-2".to_string(),
            backend: "claude".to_string(),
            model: None,
            provider: None,
            attempts: 0,
        };
        {
            let mut pending = pending_yolo().lock().expect("pending auto yolo mutex");
            pending.clear();
            pending.insert("session-1".to_string(), entry_for_stopped_project);
            pending.insert("session-2".to_string(), entry_for_other_project);
        }

        clear_pending_auto_yolo_for_project("project-1");

        let pending = pending_yolo().lock().expect("pending auto yolo mutex");
        assert!(!pending.contains_key("session-1"));
        assert!(pending.contains_key("session-2"));
    }

    #[test]
    fn does_not_queue_yolo_when_plan_only_is_enabled() {
        let settings = ProjectAutoFixSettings {
            enabled: true,
            interval_minutes: 15,
            issue_limit: 1,
            max_parallel_worktrees: 1,
            included_labels: Vec::new(),
            excluded_labels: Vec::new(),
            planning_backend: "claude".to_string(),
            planning_model: None,
            planning_provider: None,
            auto_yolo_enabled: false,
            yolo_backend: "claude".to_string(),
            yolo_model: None,
            yolo_provider: None,
            active_hours_enabled: false,
            active_hours_start: 20,
            active_hours_end: 8,
        };

        assert!(!should_queue_auto_yolo(&settings));
    }

    #[test]
    fn queues_yolo_when_enabled() {
        let settings = ProjectAutoFixSettings {
            enabled: true,
            interval_minutes: 15,
            issue_limit: 1,
            max_parallel_worktrees: 1,
            included_labels: Vec::new(),
            excluded_labels: Vec::new(),
            planning_backend: "claude".to_string(),
            planning_model: None,
            planning_provider: None,
            auto_yolo_enabled: true,
            yolo_backend: "claude".to_string(),
            yolo_model: None,
            yolo_provider: None,
            active_hours_enabled: false,
            active_hours_start: 20,
            active_hours_end: 8,
        };

        assert!(should_queue_auto_yolo(&settings));
    }

    #[test]
    fn normalize_claude_provider_only_keeps_claude_profiles() {
        assert_eq!(
            normalize_claude_provider("claude", Some("OpenRouter")),
            Some("OpenRouter".to_string())
        );
        assert_eq!(normalize_claude_provider("claude", Some("  ")), None);
        assert_eq!(
            normalize_claude_provider("claude", Some("__anthropic__")),
            None
        );
        assert_eq!(normalize_claude_provider("codex", Some("OpenRouter")), None);
    }

    fn test_session(
        total_runs: usize,
        queued: usize,
        archived: bool,
    ) -> crate::chat::types::Session {
        let mut session = crate::chat::types::Session::new(
            "Session 1".to_string(),
            0,
            crate::chat::types::Backend::Claude,
        );
        session.total_runs = total_runs;
        session.queued_messages = vec![serde_json::json!({}); queued];
        session.archived_at = archived.then_some(1);
        session
    }

    #[test]
    fn worktree_without_runs_or_queued_messages_needs_investigation() {
        assert!(worktree_needs_investigation(&[]));
        assert!(worktree_needs_investigation(&[test_session(0, 0, false)]));
        // Archived sessions do not count as started work.
        assert!(worktree_needs_investigation(&[test_session(3, 0, true)]));
    }

    #[test]
    fn worktree_with_run_or_queued_message_does_not_need_investigation() {
        assert!(!worktree_needs_investigation(&[test_session(1, 0, false)]));
        assert!(!worktree_needs_investigation(&[test_session(0, 1, false)]));
        assert!(!worktree_needs_investigation(&[
            test_session(0, 0, false),
            test_session(2, 0, false),
        ]));
    }

    #[test]
    fn queue_pending_auto_yolo_skips_duplicates_and_in_flight_sessions() {
        let project = test_project("queue-project", Some(test_auto_fix_settings(true)), false);
        let settings = test_auto_fix_settings(true);
        let worktree = test_worktree(
            "queue-worktree",
            Some(7),
            Some(WorktreeOrigin::AutoFix),
            None,
        );

        assert!(queue_pending_auto_yolo(
            &project,
            &settings,
            &worktree,
            "queue-a".to_string()
        ));
        assert!(!queue_pending_auto_yolo(
            &project,
            &settings,
            &worktree,
            "queue-a".to_string()
        ));

        auto_yolo_in_flight()
            .lock()
            .unwrap()
            .insert("queue-b".to_string());
        assert!(!queue_pending_auto_yolo(
            &project,
            &settings,
            &worktree,
            "queue-b".to_string()
        ));

        clear_pending_auto_yolo_for_project("queue-project");
        auto_yolo_in_flight().lock().unwrap().remove("queue-b");
    }

    #[test]
    fn chat_error_payload_parses_snake_case_event() {
        let payload: ChatErrorPayload = serde_json::from_str(
            r#"{"session_id":"s1","worktree_id":"w1","error":"Not logged in"}"#,
        )
        .unwrap();
        assert_eq!(payload.session_id, "s1");
        assert!(is_backend_quota_or_auth_error(&payload.error));
    }

    #[test]
    fn issue_gives_up_after_max_attempts_and_clear_resets() {
        let project_id = "retry-project";
        for attempt in 1..AUTO_FIX_MAX_ATTEMPTS {
            record_issue_failure(project_id, 42, "git failed");
            assert!(
                !gave_up_issue_numbers(project_id).contains(&42),
                "attempt {attempt} should still retry"
            );
        }
        record_issue_failure(project_id, 42, "git failed again");
        assert!(gave_up_issue_numbers(project_id).contains(&42));

        let status = get_auto_fix_status(project_id);
        assert_eq!(status.failed_issues.len(), 1);
        assert_eq!(status.failed_issues[0].attempts, AUTO_FIX_MAX_ATTEMPTS);
        assert_eq!(status.failed_issues[0].error, "git failed again");
        assert!(status.failed_issues[0].gave_up);

        clear_auto_fix_failures(project_id);
        assert!(gave_up_issue_numbers(project_id).is_empty());
        assert!(get_auto_fix_status(project_id).failed_issues.is_empty());
    }

    #[test]
    fn successful_start_clears_issue_failure() {
        let project_id = "retry-success-project";
        record_issue_failure(project_id, 7, "timeout");
        clear_issue_failure(project_id, 7);
        assert!(get_auto_fix_status(project_id).failed_issues.is_empty());
    }

    #[test]
    fn preview_matches_scheduler_selection_and_explains_exclusions() {
        let mut settings = test_auto_fix_settings(true);
        settings.max_parallel_worktrees = 10;
        settings.included_labels = vec!["bug".to_string()];
        settings.excluded_labels = vec!["hold".to_string()];
        let issues: Vec<AutoFixIssueCandidate> = vec![
            (1, vec!["BUG"]),
            (2, vec!["bug", "hold"]),
            (3, vec!["feature"]),
            (4, vec!["bug"]),
            (5, vec!["bug"]),
            (6, vec!["bug"]),
            (7, vec!["bug"]),
        ]
        .into_iter()
        .map(|(number, labels)| AutoFixIssueCandidate {
            number,
            labels: labels.into_iter().map(str::to_string).collect(),
        })
        .collect();
        let worktrees = vec![test_worktree(
            "normal",
            Some(4),
            Some(WorktreeOrigin::Manual),
            None,
        )];
        let starting = HashSet::from([5]);
        let gave_up = HashSet::from([6]);
        let preview = build_issue_preview(&issues, &worktrees, &settings, &starting, &gave_up);
        let selected: Vec<u32> = preview
            .iter()
            .filter(|issue| issue.selected)
            .map(|issue| issue.issue_number)
            .collect();
        assert_eq!(
            selected,
            select_issue_numbers_to_start(
                &issues,
                &HashSet::from([4, 5, 6]),
                &settings.included_labels,
                &settings.excluded_labels,
                1
            )
        );
        let reasons: Vec<&str> = preview.iter().map(|issue| issue.reason.as_str()).collect();
        assert_eq!(
            reasons,
            vec![
                "Next scan candidate",
                "Excluded label",
                "No included label",
                "Worktree already exists",
                "Starting",
                "Retry required",
                "Waiting for a later scan"
            ]
        );
    }

    #[test]
    fn preview_capacity_ignores_closed_ineligible_and_archived_robot_worktrees() {
        let settings = test_auto_fix_settings(true);
        let issues = vec![AutoFixIssueCandidate {
            number: 1,
            labels: vec![],
        }];
        let active = vec![test_worktree(
            "robot",
            Some(1),
            Some(WorktreeOrigin::AutoFix),
            None,
        )];
        let with_other_issue = vec![
            AutoFixIssueCandidate {
                number: 2,
                labels: vec![],
            },
            issues[0].clone(),
        ];
        let preview = build_issue_preview(
            &with_other_issue,
            &active,
            &settings,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(preview[0].reason, "Waiting for capacity");
        assert!(!preview[0].selected);
        let closed = vec![test_worktree(
            "closed",
            Some(999),
            Some(WorktreeOrigin::AutoFix),
            None,
        )];
        assert!(
            build_issue_preview(
                &issues,
                &closed,
                &settings,
                &HashSet::new(),
                &HashSet::new()
            )[0]
            .selected
        );
        let archived = vec![test_worktree(
            "archived",
            Some(999),
            Some(WorktreeOrigin::AutoFix),
            Some(1),
        )];
        assert!(
            build_issue_preview(
                &issues,
                &archived,
                &settings,
                &HashSet::new(),
                &HashSet::new()
            )[0]
            .selected
        );
    }

    #[test]
    fn scan_request_respects_backoff_and_scan_guard() {
        let project = test_project("manual-scan-test", None, false);
        let settings = test_auto_fix_settings(true);
        with_project_runtime(&project.id, |runtime| {
            runtime.next_scan_at = now_unix_secs() + 600
        });
        assert!(!project_due(&project, &settings));
        request_auto_fix_scan(&project.id).unwrap();
        assert!(project_due(&project, &settings));
        assert!(request_auto_fix_scan(&project.id).is_err());
        drop(ScanGuard(project.id.clone()));
        request_auto_fix_scan(&project.id).unwrap();
        defer_project_for_rate_limit(&project.id);
        assert!(request_auto_fix_scan(&project.id).is_err());
        assert!(!project_due(&project, &settings));
    }

    #[test]
    fn activity_is_newest_first_bounded_and_project_scoped() {
        for number in 0..35 {
            record_activity("activity-test", format!("event {number}"), Some(number));
        }
        let status = get_auto_fix_status("activity-test");
        assert_eq!(status.activity.len(), 30);
        assert_eq!(status.activity[0].issue_number, Some(34));
        assert_eq!(status.activity[29].issue_number, Some(5));
        assert!(get_auto_fix_status("activity-other-project")
            .activity
            .is_empty());
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["activity"][0]["issueNumber"], 34);
        assert_eq!(value["scanning"], false);
    }

    #[test]
    fn rate_limit_defers_next_scan() {
        let project = test_project("rate-limit-project", None, false);
        let settings = test_auto_fix_settings(true);
        assert!(project_due(&project, &settings));
        assert!(!project_due(&project, &settings));

        with_project_runtime(&project.id, |runtime| runtime.scanning = false);
        defer_project_for_rate_limit(&project.id);
        let status = get_auto_fix_status(&project.id);
        let until = status.rate_limited_until.expect("rate limited");
        assert!(until >= now_unix_secs() + GITHUB_RATE_LIMIT_BACKOFF_SECS - 1);
        assert!(status.next_scan_at.unwrap() >= until);
    }

    #[test]
    fn stop_action_cancels_only_running_plan_turns() {
        let mut plan = test_session(1, 0, false);
        plan.last_run_execution_mode = Some("plan".to_string());
        assert_eq!(
            investigation_stop_action(&plan, true),
            InvestigationStopAction::Cancel
        );
        // Finished plan: nothing to stop.
        assert_eq!(
            investigation_stop_action(&plan, false),
            InvestigationStopAction::None
        );

        let mut yolo = test_session(2, 0, false);
        yolo.last_run_execution_mode = Some("yolo".to_string());
        assert_eq!(
            investigation_stop_action(&yolo, true),
            InvestigationStopAction::None
        );
    }

    #[test]
    fn stop_action_clears_only_never_started_investigation_queue() {
        assert_eq!(
            investigation_stop_action(&test_session(0, 1, false), false),
            InvestigationStopAction::ClearQueue
        );
        // Session already ran: queued messages belong to the user.
        assert_eq!(
            investigation_stop_action(&test_session(1, 1, false), false),
            InvestigationStopAction::None
        );
        assert_eq!(
            investigation_stop_action(&test_session(0, 0, false), false),
            InvestigationStopAction::None
        );
    }

    #[test]
    fn detects_github_rate_limit_errors() {
        assert!(is_github_rate_limit_error(
            "gh issue list failed: API rate limit exceeded for user"
        ));
        assert!(is_github_rate_limit_error(
            "You have exceeded a secondary rate limit"
        ));
        assert!(!is_github_rate_limit_error("Could not resolve repository"));
    }
}
