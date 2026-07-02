use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::AppHandle;

use super::types::{AutoFixIssueCandidate, AutoFixStoppedEvent};
use crate::chat::types::{EffortLevel, ThinkingLevel};
use crate::http_server::EmitExt;
use crate::projects::github_issues::{GitHubComment, IssueContext};
use crate::projects::types::{Project, ProjectAutoFixSettings, Worktree, WorktreeOrigin};

const AUTO_FIX_TICK_SECONDS: u64 = 10;
const AUTO_YOLO_WATCH_SECONDS: u64 = 2;
const AUTO_YOLO_WATCH_ATTEMPTS: usize = 900; // 30 minutes
const AUTO_FIX_WORKTREE_READY_POLL_MS: u64 = 500;
const AUTO_FIX_WORKTREE_READY_ATTEMPTS: usize = 240; // 2 minutes

#[derive(Debug, Clone)]
struct PendingAutoYolo {
    project_id: String,
    project_name: String,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    backend: String,
    model: Option<String>,
}

static LAST_PROJECT_CHECKS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static PENDING_YOLO: OnceLock<Mutex<HashMap<String, PendingAutoYolo>>> = OnceLock::new();
static YOLO_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn last_project_checks() -> &'static Mutex<HashMap<String, u64>> {
    LAST_PROJECT_CHECKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_yolo() -> &'static Mutex<HashMap<String, PendingAutoYolo>> {
    PENDING_YOLO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn auto_yolo_in_flight() -> &'static Mutex<HashSet<String>> {
    YOLO_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
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
}

pub fn start_auto_fix_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            run_auto_yolo_watch(&app).await;
            run_auto_fix_scan(&app).await;
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

        let project_worktrees: Vec<Worktree> = data
            .worktrees
            .iter()
            .filter(|worktree| worktree.project_id == project.id)
            .cloned()
            .collect();

        let issues = match crate::projects::github_issues::list_github_issues(
            app.clone(),
            project.path.clone(),
            Some("open".to_string()),
        )
        .await
        {
            Ok(result) => result
                .issues
                .into_iter()
                .map(|issue| AutoFixIssueCandidate {
                    number: issue.number,
                    labels: issue.labels.into_iter().map(|label| label.name).collect(),
                })
                .collect::<Vec<_>>(),
            Err(err) => {
                log::warn!(
                    "Mr. Robot: failed to list issues for {}: {err}",
                    project.name
                );
                continue;
            }
        };
        let open_issue_numbers: HashSet<u32> = issues.iter().map(|issue| issue.number).collect();
        let closed_worktree_ids =
            closed_auto_fix_issue_worktree_ids(&project_worktrees, &open_issue_numbers);
        let ineligible_worktree_ids = ineligible_auto_fix_issue_worktree_ids(
            &project_worktrees,
            &issues,
            &settings.included_labels,
            &settings.excluded_labels,
        );
        let archived_worktree_ids: Vec<String> = closed_worktree_ids
            .into_iter()
            .chain(ineligible_worktree_ids)
            .collect();
        let archived_worktree_id_set: HashSet<String> =
            archived_worktree_ids.iter().cloned().collect();

        for worktree_id in &archived_worktree_ids {
            match crate::projects::archive_worktree(app.clone(), worktree_id.clone()).await {
                Ok(()) => log::info!(
                    "Mr. Robot: archived auto-fix worktree {worktree_id} because its GitHub issue is closed or no longer matches label filters"
                ),
                Err(err) => log::warn!(
                    "Mr. Robot: failed to archive auto-fix worktree {worktree_id}: {err}"
                ),
            }
        }

        let active_auto_fix = project_worktrees
            .iter()
            .filter(|worktree| {
                worktree.archived_at.is_none()
                    && !archived_worktree_id_set.contains(&worktree.id)
                    && matches!(worktree.origin, Some(WorktreeOrigin::AutoFix))
            })
            .count();
        let max_parallel = settings.max_parallel_worktrees.max(1) as usize;
        if active_auto_fix >= max_parallel {
            continue;
        }

        let capacity = max_parallel - active_auto_fix;
        let limit = (settings.issue_limit.max(1) as usize).min(capacity);
        let handled: HashSet<u32> = project_worktrees
            .iter()
            .filter(|worktree| !archived_worktree_id_set.contains(&worktree.id))
            .filter_map(|worktree| worktree.issue_number)
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
            tauri::async_runtime::spawn(async move {
                if let Err(err) =
                    start_issue_auto_fix(&app_clone, &project_clone, &settings_clone, issue_number)
                        .await
                {
                    log::warn!(
                        "Mr. Robot: issue #{issue_number} failed for {}: {err}",
                        project_clone.name
                    );
                    if is_backend_quota_or_auth_error(&err) {
                        emit_auto_fix_stopped(
                            &app_clone,
                            &project_clone,
                            &settings_clone.planning_backend,
                            &err,
                        );
                    }
                }
            });
        }
    }
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

fn auto_fix_active_now(settings: &ProjectAutoFixSettings) -> bool {
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
    let mut checks = last_project_checks().lock().expect("auto fix checks mutex");
    let last = checks.get(&project.id).copied().unwrap_or(0);
    if now.saturating_sub(last) < interval {
        return false;
    }
    checks.insert(project.id.clone(), now);
    true
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
    let comments: Vec<GitHubComment> = issue.comments;
    let issue_context = IssueContext {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        comments,
    };

    let pending_worktree = crate::projects::create_worktree(
        app.clone(),
        project.id.clone(),
        None,
        Some(issue_context),
        None,
        None,
        None,
        None,
        None,
        Some(false),
        Some("auto_fix".to_string()),
    )
    .await?;

    let ready_worktree = wait_for_worktree_ready(app, &pending_worktree.id).await?;
    let prefs = crate::load_preferences(app.clone()).await?;
    let prompt = build_auto_fix_investigation_prompt(&prefs, &ready_worktree);
    let model = settings
        .planning_model
        .clone()
        .unwrap_or_else(|| default_model_for_backend(&settings.planning_backend));

    let result = crate::jean_mcp_core::start_background_investigation_impl(
        app,
        ready_worktree.id.clone(),
        ready_worktree.path.clone(),
        prompt,
        model,
        settings.planning_backend.clone(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some("auto_fix".to_string()),
    )
    .await?;

    if !should_queue_auto_yolo(settings) {
        return Ok(());
    }

    let pending_session_id = result.session_id.clone();
    pending_yolo()
        .lock()
        .expect("pending auto yolo mutex")
        .insert(
            pending_session_id.clone(),
            PendingAutoYolo {
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                worktree_id: ready_worktree.id,
                worktree_path: ready_worktree.path,
                session_id: result.session_id,
                backend: settings.yolo_backend.clone(),
                model: settings.yolo_model.clone(),
            },
        );
    spawn_pending_auto_yolo_watch(app.clone(), pending_session_id);

    Ok(())
}

async fn wait_for_worktree_ready(app: &AppHandle, worktree_id: &str) -> Result<Worktree, String> {
    let mut last_error: Option<String> = None;
    for _ in 0..AUTO_FIX_WORKTREE_READY_ATTEMPTS {
        match crate::projects::get_worktree(app.clone(), worktree_id.to_string()).await {
            Ok(worktree) => return Ok(worktree),
            Err(err) => last_error = Some(err),
        }
        tokio::time::sleep(Duration::from_millis(AUTO_FIX_WORKTREE_READY_POLL_MS)).await;
    }
    Err(worktree_ready_timeout_message(
        worktree_id,
        last_error.as_deref(),
    ))
}

fn auto_fix_worktree_ready_timeout() -> Duration {
    Duration::from_millis(AUTO_FIX_WORKTREE_READY_POLL_MS * AUTO_FIX_WORKTREE_READY_ATTEMPTS as u64)
}

fn worktree_ready_timeout_message(worktree_id: &str, last_error: Option<&str>) -> String {
    let timeout_secs = auto_fix_worktree_ready_timeout().as_secs();
    let mut message = format!(
        "Timed out after {timeout_secs}s waiting for Mr. Robot worktree {worktree_id} to be ready"
    );
    if let Some(error) = last_error {
        message.push_str(&format!(". Last error: {error}"));
    }
    message
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
            } else {
                let session_id = entry.session_id.clone();
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
        linked_project_ids: Vec::new(),
        auto_fix_settings: None,
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
        None,
        None,
        None,
        None,
        None,
        Some(false),
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
        "[Mr. Robot Yolo]\nPlan approved automatically. Begin a new yolo execution turn now. Execute the approved plan, implement the fixes immediately, and do not continue planning or ask for confirmation."
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
        None,
        Some(entry.backend.clone()),
    )
    .await?;

    Ok(())
}

fn clear_pending_auto_yolo_for_project(project_id: &str) {
    pending_yolo()
        .lock()
        .expect("pending auto yolo mutex")
        .retain(|_, entry| entry.project_id != project_id);
}

fn emit_auto_fix_stopped(app: &AppHandle, project: &Project, backend: &str, error: &str) {
    clear_pending_auto_yolo_for_project(&project.id);
    disable_project_auto_fix(app, &project.id);
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

fn disable_project_auto_fix(app: &AppHandle, project_id: &str) {
    let Ok(mut data) = crate::projects::storage::load_projects_data(app) else {
        return;
    };
    let Some(project) = data.find_project_mut(project_id) else {
        return;
    };
    let Some(settings) = project.auto_fix_settings.as_mut() else {
        return;
    };
    settings.enabled = false;
    if let Err(err) = crate::projects::storage::save_projects_data(app, &data) {
        log::warn!("Mr. Robot: failed to disable project setting: {err}");
    }
}

fn default_model_for_backend(backend: &str) -> String {
    match backend {
        "codex" => "gpt-5.3-codex".to_string(),
        "opencode" => "opencode/gpt-5.5".to_string(),
        "cursor" => "cursor/auto".to_string(),
        "pi" => "pi/sonnet".to_string(),
        "commandcode" => "commandcode/default".to_string(),
        _ => "claude-opus-4-8[1m]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn worktree_ready_waits_two_minutes() {
        assert_eq!(auto_fix_worktree_ready_timeout(), Duration::from_secs(120));
    }

    #[test]
    fn worktree_ready_timeout_message_includes_last_error() {
        let message =
            worktree_ready_timeout_message("worktree-1", Some("Worktree not found: worktree-1"));

        assert!(message.contains("worktree-1"));
        assert!(message.contains("Last error: Worktree not found: worktree-1"));
    }

    #[test]
    fn default_models_cover_all_auto_fix_backends() {
        assert_eq!(
            default_model_for_backend("claude"),
            "claude-opus-4-8[1m]".to_string()
        );
        assert_eq!(
            default_model_for_backend("codex"),
            "gpt-5.3-codex".to_string()
        );
        assert_eq!(
            default_model_for_backend("opencode"),
            "opencode/gpt-5.5".to_string()
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
        };
        let entry_for_other_project = PendingAutoYolo {
            project_id: "project-2".to_string(),
            project_name: "Project 2".to_string(),
            worktree_id: "worktree-2".to_string(),
            worktree_path: "/tmp/worktree-2".to_string(),
            session_id: "session-2".to_string(),
            backend: "claude".to_string(),
            model: None,
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
            auto_yolo_enabled: false,
            yolo_backend: "claude".to_string(),
            yolo_model: None,
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
            auto_yolo_enabled: true,
            yolo_backend: "claude".to_string(),
            yolo_model: None,
            active_hours_enabled: false,
            active_hours_start: 20,
            active_hours_end: 8,
        };

        assert!(should_queue_auto_yolo(&settings));
    }
}
