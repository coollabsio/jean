//! Background polling loop: tracks each PR-linked worktree's pipeline, asks the
//! desktop app for a notification banner when a build breaks or recovers (via
//! `jenkins:notify`), and broadcasts a `jenkins:status-update` event for the
//! live UI.
//!
//! Self-contained: spawned once from `initialize_runtime`. Keeps last-seen results in
//! memory so transitions are detected across polls. Skips projects without
//! Jenkins config and worktrees without a PR.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Notify;

use super::client::JenkinsClient;
use super::commands::{
    assemble_status, deployed_revision, fetch_pr_checks_for, resolve_preview_freshness,
    PIPELINE_JOB, PREVIEW_JOB,
};
use super::parse::{self, Transition, STATUS_FAILURE, STATUS_SUCCESS};
use super::{config, types::JenkinsWorktreeStatus};
use crate::http_server::EmitExt;
use crate::projects::storage::load_projects_data;

/// How long a pipeline may sit in the Jenkins queue before we say so. Below
/// this, waiting is normal (the pipeline serializes); above it, the run is stuck
/// behind something and the user wants to know without watching the queue.
const QUEUE_ALERT: Duration = Duration::from_secs(15 * 60);

/// Idle cadence when nothing is building.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Faster cadence while a build is in progress / queued, so the CI pills feel
/// live during a run without hammering Jenkins the rest of the time.
const ACTIVE_POLL_INTERVAL: Duration = Duration::from_secs(12);
const STATUS_EVENT: &str = "jenkins:status-update";
/// Desktop-notification request. The core runtime is Tauri-free, so it cannot
/// raise an OS banner itself: the frontend listens for this and forwards it to
/// the `send_native_notification` desktop command.
const NOTIFY_EVENT: &str = "jenkins:notify";

/// Ask the desktop app to raise an OS notification banner.
fn notify_desktop(app: &AppHandle, title: String, body: String) {
    let _ = app.emit_all(
        NOTIFY_EVENT,
        &serde_json::json!({ "title": title, "body": body }),
    );
}

/// Wake signal: lets the UI force an immediate poll (e.g. on window focus)
/// instead of waiting out the current interval. Managed in Tauri state and
/// awaited by [`start_poller`]. Cheap — just nudges the existing loop.
#[derive(Clone, Default)]
pub struct JenkinsPollSignal(pub Arc<Notify>);

impl JenkinsPollSignal {
    /// Wake the poller now. Coalesces if it's mid-cycle (at most one extra run).
    pub fn poke(&self) {
        self.0.notify_one();
    }
}

/// Run the polling loop forever. Errors in a single cycle are logged and retried.
///
/// Adaptive cadence: polls every [`ACTIVE_POLL_INTERVAL`] while any tracked
/// build is BUILDING/QUEUED, else every [`IDLE_POLL_INTERVAL`]. A `signal.poke()`
/// (window focus) wakes it immediately regardless of the current interval.
pub async fn start_poller(app: AppHandle, signal: JenkinsPollSignal) -> Result<(), String> {
    log::info!(
        "Jenkins poller started (idle {}s / active {}s, focus-triggered)",
        IDLE_POLL_INTERVAL.as_secs(),
        ACTIVE_POLL_INTERVAL.as_secs()
    );
    let mut memory = PollMemory::default();

    loop {
        let any_active = match poll_cycle(&app, &mut memory).await {
            Ok(active) => active,
            Err(e) => {
                log::debug!("Jenkins poll cycle error: {e}");
                false
            }
        };
        let interval = if any_active {
            ACTIVE_POLL_INTERVAL
        } else {
            IDLE_POLL_INTERVAL
        };

        // Wake on whichever comes first: the interval elapsing, or a focus poke.
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = signal.0.notified() => {
                log::debug!("Jenkins poll: woken early (focus/poke)");
            }
        }
    }
}

/// What the poller remembers between cycles, so it can notify on *changes*
/// rather than on every observation.
///
/// Keyed by `(project_id, pr_id)`. Everything here is anti-spam state: without
/// it the same red build would notify every 60 seconds.
#[derive(Default)]
struct PollMemory {
    /// Last terminal overall status (SUCCESS/FAILURE) — green↔red transitions.
    results: HashMap<(String, String), String>,
    /// Last preview freshness seen, so "preview is up to date again" fires once.
    preview_freshness: HashMap<(String, String), String>,
    /// PRs already flagged as stuck in the queue; cleared when they leave it.
    queue_alerted: std::collections::HashSet<(String, String)>,
}

/// Returns `true` if any tracked worktree is BUILDING/QUEUED — the caller speeds
/// up the cadence while something is in flight.
async fn poll_cycle(app: &AppHandle, memory: &mut PollMemory) -> Result<bool, String> {
    let data = load_projects_data(app)?;

    // Per-cycle observability: how many projects are Jenkins-configured and how
    // many PR-linked worktrees we actually polled. Logged at info so the poller
    // is visible in prod without trace logging (notif-diagnostic cause D).
    let mut configured_projects = 0usize;
    let mut polled_worktrees = 0usize;
    // Any in-flight build/queue this cycle → caller polls faster next time.
    let mut any_active = false;

    for project in &data.projects {
        // Skip projects without Jenkins configured.
        let Ok(cfg) = config::config_from_project(project) else {
            log::debug!(
                "Jenkins poll: skip project '{}' — no Jenkins config",
                project.name
            );
            continue;
        };
        configured_projects += 1;
        let client = JenkinsClient::new(&cfg.url, &cfg.user, &cfg.token);

        // Fetch each job's builds once per project, then match per worktree.
        let Ok(pipeline_builds) = client.fetch_builds(PIPELINE_JOB).await else {
            log::debug!(
                "Jenkins poll: project '{}' — failed to fetch {PIPELINE_JOB} builds",
                project.name
            );
            continue;
        };
        let preview_builds = client.fetch_builds(PREVIEW_JOB).await.unwrap_or_default();
        let queue_json = client.fetch_queue().await.unwrap_or_default();
        // One `gh` call for the whole project: the GitHub verdict that survives
        // Jenkins' build rotation, plus each PR head (reused by the freshness
        // probe instead of a `gh pr view` per worktree).
        let gh_checks = fetch_pr_checks_for(app, &project.path).await;

        for worktree in data
            .worktrees
            .iter()
            .filter(|w| w.project_id == project.id && w.archived_at.is_none())
        {
            // v1: only track worktrees linked to a PR.
            let Some(pr_number) = worktree.pr_number else {
                log::debug!(
                    "Jenkins poll: skip worktree '{}' — no linked PR",
                    worktree.name
                );
                continue;
            };
            polled_worktrees += 1;
            let pr_id = pr_number.to_string();
            // Cloned, not removed: two worktrees may point at the same PR.
            let gh_check = gh_checks.get(&pr_number).cloned().unwrap_or_default();

            let mut status = assemble_status(
                &client,
                &pipeline_builds,
                &preview_builds,
                &queue_json,
                &worktree.id,
                Some(&pr_id),
                Some(&worktree.branch),
                cfg.preview_url_template.as_deref(),
                gh_check.verdict.as_deref(),
            )
            .await;

            status.preview_freshness = resolve_preview_freshness(
                app,
                &worktree.path,
                status.pr_id.as_deref(),
                worktree.pr_number,
                cfg.preview_url_template.as_deref(),
                gh_check.head_sha,
                deployed_revision(
                    &preview_builds,
                    status.pr_id.as_deref(),
                    Some(&worktree.branch),
                ),
            )
            .await;

            if matches!(status.overall_status.as_str(), "BUILDING" | "QUEUED") {
                any_active = true;
            }

            let _ = app.emit_all(STATUS_EVENT, &status);
            track_transition(app, &mut memory.results, &project.id, &pr_id, &status);
            track_preview_freshness(app, memory, &project.id, &pr_id, &status);
            track_queue_wait(app, memory, &project.id, &pr_id, &status);
        }
    }

    log::info!(
        "Jenkins poll cycle: {configured_projects} configured project(s), {polled_worktrees} PR-linked worktree(s) polled{}",
        if any_active { " — active build" } else { "" }
    );

    Ok(any_active)
}

/// Notify on a green↔red transition of a completed pipeline build.
fn track_transition(
    app: &AppHandle,
    last_results: &mut HashMap<(String, String), String>,
    project_id: &str,
    pr_id: &str,
    status: &JenkinsWorktreeStatus,
) {
    // Only consider completed builds — ignore in-progress/unknown.
    let Some(pipeline) = &status.pipeline else {
        return;
    };
    if pipeline.building {
        return;
    }
    let new_status = status.overall_status.as_str();
    if new_status != STATUS_SUCCESS && new_status != STATUS_FAILURE {
        return;
    }

    let key = (project_id.to_string(), pr_id.to_string());
    let previous = last_results.get(&key).map(String::as_str);

    if let Some(transition) = parse::detect_transition(previous, new_status) {
        notify(app, transition, pr_id, status);
    } else if previous.is_none() {
        // First terminal result seen for this PR since startup: recorded as the
        // baseline, no notification (anti-spam). We only notify on a flip while
        // the app is running. Logged so this expected silence is observable
        // (notif-diagnostic cause A).
        log::debug!(
            "Jenkins poll: PR #{pr_id} baseline = {new_status} (no notification at startup)"
        );
    }
    last_results.insert(key, new_status.to_string());
}

/// Notify when the PR preview finishes catching up with the PR head.
///
/// The deploy is asynchronous and slower than the pipeline, so "is the preview
/// serving my last commit yet?" is a question that otherwise gets answered by
/// reloading the page until it works.
fn track_preview_freshness(
    app: &AppHandle,
    memory: &mut PollMemory,
    project_id: &str,
    pr_id: &str,
    status: &JenkinsWorktreeStatus,
) {
    let Some(freshness) = &status.preview_freshness else {
        return;
    };
    let key = (project_id.to_string(), pr_id.to_string());
    let previous = memory
        .preview_freshness
        .insert(key, freshness.status.clone());

    // Only a real known-not-ready → UP_TO_DATE flip notifies: the first
    // observation is a baseline (same anti-spam rule as build transitions).
    if freshness.status != "UP_TO_DATE" {
        return;
    }
    if status.overall_status != STATUS_SUCCESS {
        return;
    }
    if previous
        .as_deref()
        .is_none_or(|value| value == "UP_TO_DATE")
    {
        return;
    }

    log::info!("Jenkins notification (PR #{pr_id}): testable");
    notify_desktop(
        app,
        format!("✅ PR #{pr_id} testable"),
        "CI verte et preview à jour sur le dernier commit".to_string(),
    );
}

/// Notify once when a queued pipeline has been waiting past [`QUEUE_ALERT`].
fn track_queue_wait(
    app: &AppHandle,
    memory: &mut PollMemory,
    project_id: &str,
    pr_id: &str,
    status: &JenkinsWorktreeStatus,
) {
    let key = (project_id.to_string(), pr_id.to_string());
    let Some(queue) = &status.queue else {
        // Left the queue → re-arm for the next time.
        memory.queue_alerted.remove(&key);
        return;
    };

    let waited_ms = now_ms().saturating_sub(queue.since_ms);
    if waited_ms < QUEUE_ALERT.as_millis() as i64 {
        return;
    }
    if !memory.queue_alerted.insert(key) {
        return; // Already told the user about this one.
    }

    let minutes = waited_ms / 60_000;
    let detail = queue
        .why
        .clone()
        .unwrap_or_else(|| "En attente d'un exécuteur Jenkins".to_string());
    log::info!("Jenkins notification (PR #{pr_id}): queued for {minutes} min");
    notify_desktop(
        app,
        format!("⏳ En file depuis {minutes} min — PR #{pr_id}"),
        format!("{} ({}/{})", detail, queue.position, queue.total),
    );
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn notify(app: &AppHandle, transition: Transition, pr_id: &str, status: &JenkinsWorktreeStatus) {
    let (title, body) = match transition {
        Transition::Broke => {
            // Verdict is the whole pipeline's result; name the failed stage as detail.
            let detail = status
                .stages
                .iter()
                .find(|s| s.status == "FAILED")
                .map_or_else(
                    || "Le pipeline a échoué".to_string(),
                    |s| format!("Stage en échec : « {} »", s.name),
                );
            (format!("❌ {PIPELINE_JOB} en échec — PR #{pr_id}"), detail)
        }
        Transition::Recovered => (
            format!("✅ {PIPELINE_JOB} repassé au vert — PR #{pr_id}"),
            "Le pipeline de la PR est de nouveau vert".to_string(),
        ),
    };

    log::info!("Jenkins notification (PR #{pr_id}): {title}");
    notify_desktop(app, title, body);
}
