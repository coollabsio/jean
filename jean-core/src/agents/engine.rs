//! Backend loop of the agents infrastructure. It runs without any client:
//! 1. `chat:done` / `chat:error` / `chat:cancelled` mark delegations and
//!    tasks to check.
//! 2. Delegation checks read the finished session and queue an update for
//!    the session that started the work (its origin).
//! 3. Due schedules queue updates.
//! 4. Updates with a target session go there; updates without one start a
//!    new task session (background work, apart from the user's chat).
//! 5. Long chats are archived and continue in a new chat. The end is saved
//!    as carry-over and a shorter copy is stored as a journal entry. Old task
//!    sessions are archived, then deleted.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::Notify;

use super::db;
use crate::chat::types::{Backend, EffortLevel, MessageRole, RunStatus, ThinkingLevel};

const TICK: Duration = Duration::from_secs(5);
/// Wait after a run ends before reading its final state (waiting-for-input
/// and the last message are saved right after the event on some backends).
const CHECK_DELAY_SECS: i64 = 2;
const BUSY_RETRY_SECS: i64 = 5;
const SUMMARY_CHARS: usize = 1500;
/// Most agent-to-agent hops in one chain.
pub const MAX_AGENT_HOPS: i64 = 3;
/// A chat with this many messages continues in a new chat when idle.
/// Test override: `JEAN_AGENT_CHAT_ROTATE_MESSAGES`.
const CHAT_ROTATE_MESSAGES: u32 = 40;
/// Idle time before a long chat is rotated (not during a conversation).
/// Test override: `JEAN_AGENT_CHAT_ROTATE_IDLE_SECS`.
const CHAT_ROTATE_IDLE_SECS: u64 = 10 * 60;
/// Characters of the old chat's end carried into the new chat's prompt.
const CARRY_OVER_CHARS: usize = 6000;
/// Finished task sessions are archived after this, deleted after the next.
/// Test override: `JEAN_AGENT_TASK_ARCHIVE_SECS`.
const TASK_ARCHIVE_AFTER_SECS: i64 = 3 * 86_400;
const TASK_DELETE_AFTER_SECS: i64 = 30 * 86_400;
/// Timestamped session/archive event keys only dedup repeats of one emit.
const EVENT_KEY_RETENTION_SECS: i64 = 86_400;
const MAINTENANCE_INTERVAL_SECS: i64 = 60;
static LAST_MAINTENANCE: AtomicI64 = AtomicI64::new(0);

/// A limit from the environment (for tests), or its default.
fn env_limit<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

static WAKE: Lazy<Notify> = Lazy::new(Notify::new);

/// Run the engine soon (new event, run ended, approval decided).
pub fn nudge() {
    WAKE.notify_one();
}

/// Start listeners and the loop. Call once after `agents::init`.
pub fn start(app: AppHandle) {
    for event_name in ["chat:done", "chat:error", "chat:cancelled"] {
        let listener_app = app.clone();
        app.listen(event_name, move |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            let Some(session_id) = payload
                .get("session_id")
                .or_else(|| payload.get("sessionId"))
                .and_then(Value::as_str)
            else {
                return;
            };
            let kind = event_name.trim_start_matches("chat:");
            let error = payload.get("error").and_then(Value::as_str);
            on_run_ended(&listener_app, session_id, kind, error);
        });
    }

    // Runs that ended while Jean was closed did not emit events: check every
    // active delegation once (a check of a still-running session waits).
    let at = db::now() + 20;
    if let Err(e) = super::with_db(&app, |conn| db::requeue_active_delegations(conn, at)) {
        log::warn!("[Agents] requeue failed: {e}");
    }

    {
        let listener_app = app.clone();
        app.listen("worktree:archived", move |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            let Some((key, context)) = worktree_archived_trigger(&payload, db::now()) else {
                return;
            };
            emit_schedule_trigger(&listener_app, "worktree_archived", &key, &context);
        });
    }
    {
        let listener_app = app.clone();
        app.listen("pr:status-update", move |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            let Some((key, context)) = pr_merged_trigger(&payload) else {
                return;
            };
            emit_schedule_trigger(&listener_app, "pr_merged", &key, &context);
        });
    }

    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = tick(&app).await {
                log::warn!("[Agents] tick failed: {e}");
            }
            tokio::select! {
                _ = tokio::time::sleep(TICK) => {}
                _ = WAKE.notified() => {}
            }
        }
    });
}

fn on_run_ended(app: &AppHandle, session_id: &str, kind: &str, error: Option<&str>) {
    let agent_session = super::agent_for_session(app, session_id).is_some();
    let marked = super::with_db(app, |conn| {
        let at = db::now() + CHECK_DELAY_SECS;
        Ok(
            db::mark_delegation_run_ended(conn, session_id, kind, error, at)?
                + db::mark_task_run_ended(conn, session_id, kind, at)?,
        )
    })
    .unwrap_or(0);
    // An agent's own run ended: its queued updates can be delivered now.
    if marked > 0 || agent_session {
        super::notify_changed(app);
    }
    // Agent and delegated sessions already wake their agent. Firing them again
    // would loop: the routine's task (or the work it delegates) would finish
    // and wake the same routine.
    if let Some(trigger) = session_trigger_name(kind, agent_session || marked > 0) {
        // A session runs many times: key on the run that ended, so a repeated
        // emit of one run dedups and the next run fires again.
        let run_id = crate::chat::storage::load_metadata(app, session_id)
            .ok()
            .flatten()
            .and_then(|metadata| metadata.runs.last().map(|run| run.run_id.clone()));
        let key = session_event_key(session_id, kind, run_id.as_deref(), db::now());
        let context = match (kind, error) {
            ("error", Some(message)) => format!("Session {session_id} failed: {message}"),
            ("error", None) => format!("Session {session_id} failed."),
            _ => format!("Session {session_id} finished."),
        };
        emit_schedule_trigger(app, trigger, &key, &context);
    }
}

/// `done` / `error` on a project session. Sessions that already wake an
/// agent (its own chat and tasks, and delegated sessions) are excluded.
pub(crate) fn session_trigger_name(kind: &str, wakes_agent: bool) -> Option<&'static str> {
    if wakes_agent {
        return None;
    }
    match kind {
        "done" => Some("session_finished"),
        "error" => Some("session_failed"),
        _ => None,
    }
}

/// Dedup key of one ended run. Falls back to the clock when the run is unknown.
pub(crate) fn session_event_key(
    session_id: &str,
    kind: &str,
    run_id: Option<&str>,
    at: i64,
) -> String {
    match run_id.filter(|id| !id.is_empty()) {
        Some(run_id) => format!("session:{session_id}:{kind}:{run_id}"),
        None => format!("session:{session_id}:{kind}:{at}"),
    }
}

pub(crate) fn worktree_archived_trigger(payload: &Value, at: i64) -> Option<(String, String)> {
    let id = payload.get("id").and_then(Value::as_str)?;
    if id.is_empty() {
        return None;
    }
    let project_id = payload
        .get("project_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    Some((
        format!("archive:{id}:{at}"),
        format!("Worktree {id} in project {project_id} was archived."),
    ))
}

pub(crate) fn pr_merged_trigger(payload: &Value) -> Option<(String, String)> {
    let state = payload.get("state").and_then(Value::as_str)?;
    if state != "merged" {
        return None;
    }
    let worktree_id = payload.get("worktree_id").and_then(Value::as_str)?;
    if worktree_id.is_empty() {
        return None;
    }
    let pr_number = payload
        .get("pr_number")
        .and_then(Value::as_i64)
        .or_else(|| {
            payload
                .get("pr_number")
                .and_then(Value::as_u64)
                .map(|number| number as i64)
        })?;
    Some((
        format!("pr:{worktree_id}:{pr_number}"),
        format!("Pull request #{pr_number} on worktree {worktree_id} was merged."),
    ))
}

fn emit_schedule_trigger(app: &AppHandle, event_name: &str, event_key: &str, context: &str) {
    match super::with_db(app, |conn| {
        db::fire_event_schedules(conn, event_name, event_key, context)
    }) {
        Ok(fired) if !fired.is_empty() => super::notify_changed(app),
        Ok(_) => {}
        Err(error) => log::warn!("[Agents] event {event_name} failed: {error}"),
    }
}

async fn tick(app: &AppHandle) -> Result<(), String> {
    let mut changed = false;
    let checks = super::with_db(app, |conn| db::due_delegation_checks(conn, db::now()))?;
    for delegation in checks {
        changed |= check_delegation(app, &delegation).await?;
    }
    let task_checks = super::with_db(app, |conn| db::due_task_checks(conn, db::now()))?;
    for task in task_checks {
        changed |= check_task(app, &task).await?;
    }
    let fired = super::with_db(app, |conn| db::fire_due_schedules(conn, db::now()))?;
    changed |= !fired.is_empty();
    let agents = super::with_db(app, |conn| db::agents_with_pending_events(conn))?;
    for agent_id in agents {
        changed |= deliver(app, &agent_id).await?;
    }
    let now = db::now();
    if now - LAST_MAINTENANCE.load(Ordering::Relaxed) >= MAINTENANCE_INTERVAL_SECS {
        LAST_MAINTENANCE.store(now, Ordering::Relaxed);
        changed |= maintenance(app).await?;
    }
    if changed {
        use crate::http_server::EmitExt;
        let _ = app.emit_all("cache:invalidate", &json!({ "keys": ["agents"] }));
    }
    Ok(())
}

/// Path of a worktree for session lookups (agent worktrees use their folder).
fn worktree_path(app: &AppHandle, worktree_id: &str) -> Option<String> {
    if let Some(path) = super::workdir_for_worktree(app, worktree_id) {
        return Some(path);
    }
    crate::projects::storage::load_projects_data(app)
        .ok()?
        .find_worktree(worktree_id)
        .map(|w| w.path.clone())
}

/// "project / worktree" label (or the agent name for agent sessions).
fn worktree_label(app: &AppHandle, worktree_id: &str) -> String {
    if let Some(agent) = super::agent_for_worktree(app, worktree_id) {
        return format!("agent {}", agent.name);
    }
    let Ok(data) = crate::projects::storage::load_projects_data(app) else {
        return worktree_id.to_string();
    };
    let Some(wt) = data.find_worktree(worktree_id) else {
        return worktree_id.to_string();
    };
    let project = data
        .projects
        .iter()
        .find(|p| p.id == wt.project_id)
        .map(|p| p.name.as_str())
        .unwrap_or("?");
    format!("{project} / {}", wt.name)
}

pub(crate) fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}…")
}

/// Map a finished session to a delegation status.
pub(crate) fn outcome_status(
    waiting_for_input: bool,
    last_event: Option<&str>,
    last_run_status: Option<&RunStatus>,
) -> &'static str {
    if waiting_for_input {
        return "waiting";
    }
    match (last_event, last_run_status) {
        (Some("error"), _) | (_, Some(RunStatus::Crashed)) => "failed",
        (Some("cancelled"), _) | (_, Some(RunStatus::Cancelled)) => "cancelled",
        _ => "done",
    }
}

/// Returns true when the delegation produced an update.
async fn check_delegation(app: &AppHandle, d: &db::Delegation) -> Result<bool, String> {
    if crate::chat::registry::is_session_actively_managed(&d.session_id) {
        super::with_db(app, |conn| {
            db::defer_delegation_check(conn, d.id, Some(db::now() + BUSY_RETRY_SECS))
        })?;
        return Ok(false);
    }
    let label = worktree_label(app, &d.worktree_id);
    let session = match worktree_path(app, &d.worktree_id) {
        Some(path) => crate::chat::get_session(
            app.clone(),
            d.worktree_id.clone(),
            path,
            d.session_id.clone(),
            Some(6),
        )
        .await
        .ok(),
        None => None,
    };
    let Some(session) = session else {
        let body = format!(
            "Session {} ({label}) is gone: its worktree or session no longer exists.",
            d.session_id
        );
        super::with_db(app, |conn| {
            db::add_event(conn, &follow_up_event(d, "Follow-up: session gone", &body))?;
            db::finish_delegation(conn, d.id, "failed", "Session no longer exists")
        })?;
        return Ok(true);
    };
    // A detached run still going (e.g. resumed after restart): wait for its event.
    if matches!(
        session.last_run_status,
        Some(RunStatus::Running) | Some(RunStatus::Resumable)
    ) && d.last_event.is_none()
    {
        super::with_db(app, |conn| db::defer_delegation_check(conn, d.id, None))?;
        return Ok(false);
    }

    let status = outcome_status(
        session.waiting_for_input,
        d.last_event.as_deref(),
        session.last_run_status.as_ref(),
    );
    let reply = last_reply(&session, SUMMARY_CHARS);
    let verb = match status {
        "waiting" => match session.waiting_for_input_type.as_deref() {
            Some("plan") => "is waiting for plan approval",
            Some("question") => "is asking a question",
            _ => "is waiting for input",
        },
        "failed" => "failed",
        "cancelled" => "was cancelled",
        _ => "finished",
    };
    let mut body = format!(
        "Session \"{}\" ({label}, sessionId {}) {verb}.",
        session.name, d.session_id
    );
    if let Some(error) = d.last_error.as_deref().filter(|_| status == "failed") {
        body.push_str(&format!("\nError: {}", truncate(error, 500)));
    }
    if !reply.is_empty() {
        body.push_str(&format!("\nLast reply:\n{reply}"));
    }
    let summary = truncate(&reply, 300);
    let title = format!("Follow-up: {}", session.name);
    super::with_db(app, |conn| {
        db::add_event(conn, &follow_up_event(d, &title, &body))?;
        db::finish_delegation(conn, d.id, status, &summary)
    })?;
    Ok(true)
}

/// Update about delegated work, sent back to the session that started it.
fn follow_up_event<'a>(d: &'a db::Delegation, title: &'a str, body: &'a str) -> db::NewEvent<'a> {
    db::NewEvent {
        agent_id: &d.agent_id,
        kind: "delegation",
        title,
        body,
        hop: d.hop,
        target_session_id: d.origin_session_id.as_deref(),
        ..Default::default()
    }
}

fn last_reply(session: &crate::chat::types::Session, max: usize) -> String {
    session
        .messages
        .iter()
        .rev()
        .find(|m| m.role == MessageRole::Assistant && !m.content.trim().is_empty())
        .map(|m| truncate(&m.content, max))
        .unwrap_or_default()
}

/// A task session's run ended: save its status and one-line result.
/// Returns true when the task changed.
async fn check_task(app: &AppHandle, task: &db::Task) -> Result<bool, String> {
    if crate::chat::registry::is_session_actively_managed(&task.session_id) {
        super::with_db(app, |conn| {
            db::defer_task_check(conn, task.id, Some(db::now() + BUSY_RETRY_SECS))
        })?;
        return Ok(false);
    }
    let worktree_id = db::agent_tasks_worktree_id(&task.agent_id);
    let path = super::agent_workdir(app, &task.agent_id)?;
    let Ok(session) = crate::chat::get_session(
        app.clone(),
        worktree_id,
        path,
        task.session_id.clone(),
        Some(4),
    )
    .await
    else {
        super::with_db(app, |conn| {
            db::finish_task(conn, task.id, "failed", "Task session no longer exists")
        })?;
        return Ok(true);
    };
    let open = super::with_db(app, |conn| {
        db::open_delegations_from(conn, &task.session_id)
    })?;
    let status = if open > 0 && !session.waiting_for_input {
        "waiting"
    } else {
        outcome_status(
            session.waiting_for_input,
            task.last_event.as_deref(),
            session.last_run_status.as_ref(),
        )
    };
    let summary = last_reply(&session, 300);
    super::with_db(app, |conn| db::finish_task(conn, task.id, status, &summary))?;
    Ok(true)
}

/// The agent's home session: the active (or first) session of its worktree.
/// A new session has no saved mode yet (it would load as Plan, which blocks
/// the Jean MCP tools), so save the default mode once.
pub(crate) async fn home_session(
    app: &AppHandle,
    agent: &db::Agent,
) -> Result<(crate::chat::types::Session, String), String> {
    let path = super::agent_workdir(app, &agent.id)?;
    let sessions = crate::chat::get_sessions(
        app.clone(),
        agent.worktree_id.clone(),
        path.clone(),
        None,
        None,
    )
    .await?;
    let mut session = sessions
        .active_session_id
        .as_deref()
        .and_then(|id| sessions.sessions.iter().find(|s| s.id == id))
        .or_else(|| sessions.sessions.first())
        .cloned()
        .ok_or_else(|| format!("Agent {} has no session", agent.id))?;
    ensure_session_mode(app, &agent.worktree_id, &path, &mut session).await?;
    Ok((session, path))
}

/// Put the agent's run configuration on its home chat while that chat is
/// unused, so the toolbar shows it. Called when the agent is created or its
/// configuration changes, not on every list, so a choice the user makes in
/// the toolbar before the first message is kept.
pub(crate) async fn apply_run_config_to_home(
    app: &AppHandle,
    agent: &db::Agent,
) -> Result<(), String> {
    let (mut session, path) = home_session(app, agent).await?;
    if !should_stamp_agent_run(session.total_runs, session.message_count.unwrap_or(0))
        || crate::chat::registry::is_session_actively_managed(&session.id)
    {
        return Ok(());
    }
    stamp_agent_run_config(app, agent, &agent.worktree_id, &path, &mut session).await
}

/// Save the default execution mode once on a session that has none yet.
async fn ensure_session_mode(
    app: &AppHandle,
    worktree_id: &str,
    path: &str,
    session: &mut crate::chat::types::Session,
) -> Result<(), String> {
    if !matches!(
        crate::chat::storage::load_metadata(app, &session.id),
        Ok(None)
    ) {
        return Ok(());
    }
    let default_mode = crate::load_preferences(app.clone())
        .await
        .ok()
        .map(|prefs| prefs.default_execution_mode);
    let mode = wake_execution_mode(default_mode.as_deref())
        .or(default_mode.as_deref())
        .unwrap_or("build")
        .to_string();
    crate::chat::set_session_execution_mode(
        app.clone(),
        worktree_id.to_string(),
        path.to_string(),
        session.id.clone(),
        mode.clone(),
    )
    .await?;
    session.selected_execution_mode = Some(mode);
    Ok(())
}

/// Wake-ups need the Jean MCP tools, which Plan mode blocks: keep the
/// session's mode (the user's default), use Build only instead of Plan.
pub(crate) fn wake_execution_mode(selected: Option<&str>) -> Option<&'static str> {
    match selected {
        Some("build") | Some("yolo") | Some("supervised") | Some("auto") => None,
        _ => Some("build"),
    }
}

/// Cursor has no Build mode. Wakes still have to leave Plan, so they use Yolo.
pub(crate) fn wake_execution_mode_for(
    selected: Option<&str>,
    backend: Option<&str>,
) -> Option<&'static str> {
    if backend == Some("cursor") {
        return match selected {
            Some("yolo") => None,
            _ => Some("yolo"),
        };
    }
    wake_execution_mode(selected)
}

/// A subagent type can pin plan, build, or yolo. Cursor has no Build mode.
/// Without a pin, wakes use [`wake_execution_mode_for`].
pub(crate) fn wake_permission_mode(
    selected: Option<&str>,
    backend: Option<&str>,
    permission_mode: Option<&str>,
) -> Option<&'static str> {
    match permission_mode
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some("plan") => Some("plan"),
        Some("yolo") => Some("yolo"),
        Some("build") if backend == Some("cursor") => Some("yolo"),
        Some("build") => Some("build"),
        _ => wake_execution_mode_for(selected, backend),
    }
}

/// Only an unused session is stamped. A used session changes backend on the
/// next wake instead: `send_chat_message` saves the wake's backend and hands
/// the history over to it.
pub(crate) fn should_stamp_agent_run(total_runs: usize, message_count: u32) -> bool {
    total_runs == 0 && message_count == 0
}

fn trimmed_opt(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn backend_id(backend: &Backend) -> &'static str {
    match backend {
        Backend::Claude => "claude",
        Backend::Codex => "codex",
        Backend::Opencode => "opencode",
        Backend::Cursor => "cursor",
        Backend::Pi => "pi",
        Backend::Commandcode => "commandcode",
        Backend::Grok => "grok",
        Backend::Kimi => "kimi",
        Backend::Antigravity => "antigravity",
        Backend::Muse => "muse",
        Backend::Devin => "devin",
    }
}

/// Explicit `send_chat_message` fields for a wake. Unset agent fields are omitted
/// so the session and user defaults apply.
pub(crate) fn agent_wake_overrides(agent: &db::Agent) -> Value {
    let mut overrides = json!({});
    if let Some(backend) = trimmed_opt(&agent.backend) {
        overrides["backend"] = json!(backend);
    }
    if let Some(model) = trimmed_opt(&agent.model) {
        overrides["model"] = json!(model);
    }
    if let Some(effort) = trimmed_opt(&agent.effort) {
        overrides["effortLevel"] = json!(effort);
    }
    if let Some(thinking) = trimmed_opt(&agent.thinking_level) {
        overrides["thinkingLevel"] = json!(thinking);
    }
    overrides
}

/// A chosen backend with no model must not keep another backend's session model.
/// Fill the preference default for that backend.
pub(crate) fn wake_needs_default_model(agent: &db::Agent) -> bool {
    trimmed_opt(&agent.backend).is_some() && trimmed_opt(&agent.model).is_none()
}

pub(crate) fn fill_wake_model(overrides: &mut Value, default_model: Option<&str>) {
    let has_backend = overrides
        .get("backend")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let has_model = overrides
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    if has_backend && !has_model {
        if let Some(model) = default_model
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            overrides["model"] = json!(model);
        }
    }
}

/// Append skill markers that are not already in the message.
pub(crate) fn message_with_agent_skills(message: &str, skills: &[db::AgentSkill]) -> String {
    let refs: Vec<String> = skills
        .iter()
        .filter_map(|skill| {
            let path = skill.path.trim();
            if path.is_empty() {
                return None;
            }
            let marker = super::skill_instruction(path);
            if message.contains(&marker) {
                None
            } else {
                Some(marker)
            }
        })
        .collect();
    if refs.is_empty() {
        return message.to_string();
    }
    let mut out = message.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&refs.join("\n"));
    out
}

/// Create a task or rotated chat on the agent's backend, then store its model
/// and reasoning choices.
pub(crate) async fn open_agent_session(
    app: &AppHandle,
    agent: &db::Agent,
    worktree_id: &str,
    path: &str,
    name: Option<String>,
) -> Result<crate::chat::types::Session, String> {
    let mut session = crate::chat::create_session(
        app.clone(),
        worktree_id.to_string(),
        path.to_string(),
        name,
        agent.backend.clone(),
        None,
        None,
        None,
        None,
        None,
    )
    .await?;
    ensure_session_mode(app, worktree_id, path, &mut session).await?;
    if let Err(e) = stamp_agent_run_config(app, agent, worktree_id, path, &mut session).await {
        log::warn!(
            "[Agents] run config for {} was not saved on {}: {e}",
            agent.id,
            session.id
        );
    }
    Ok(session)
}

/// Persist the agent's backend, model, and reasoning on a session that has no
/// messages yet. Unset backend and model mean what a new chat would use: the
/// preference backend and that backend's preference model. Unset effort and
/// thinking clear any stored choice.
async fn stamp_agent_run_config(
    app: &AppHandle,
    agent: &db::Agent,
    worktree_id: &str,
    path: &str,
    session: &mut crate::chat::types::Session,
) -> Result<(), String> {
    let prefs = crate::load_preferences(app.clone()).await.ok();
    let backend: Backend =
        serde_json::from_value(json!(trimmed_opt(&agent.backend)
            .or(prefs.as_ref().map(|prefs| prefs.default_backend.as_str()))))
        .unwrap_or_default();
    if session.backend != backend {
        crate::chat::set_session_backend(
            app.clone(),
            worktree_id.to_string(),
            path.to_string(),
            session.id.clone(),
            backend_id(&backend).to_string(),
        )
        .await?;
        session.backend = backend;
    }
    if session.backend == Backend::Cursor
        && session.selected_execution_mode.as_deref() == Some("build")
    {
        crate::chat::set_session_execution_mode(
            app.clone(),
            worktree_id.to_string(),
            path.to_string(),
            session.id.clone(),
            "yolo".to_string(),
        )
        .await?;
        session.selected_execution_mode = Some("yolo".to_string());
    }
    let model = trimmed_opt(&agent.model).map(str::to_string).or_else(|| {
        prefs
            .as_ref()
            .and_then(|prefs| crate::chat::default_model_for_backend(&session.backend, prefs))
    });
    if let Some(model) = model {
        if session.selected_model.as_deref() != Some(model.as_str()) {
            crate::chat::set_session_model(
                app.clone(),
                worktree_id.to_string(),
                path.to_string(),
                session.id.clone(),
                model.clone(),
            )
            .await?;
            session.selected_model = Some(model);
        }
    }
    if let Some(effort) = trimmed_opt(&agent.effort) {
        if session
            .selected_effort_level
            .as_ref()
            .map(EffortLevel::as_str)
            != Some(effort)
        {
            let parsed: EffortLevel = serde_json::from_value(json!(effort))
                .unwrap_or_else(|_| EffortLevel::Other(effort.to_string()));
            crate::chat::set_session_effort_level(
                app.clone(),
                worktree_id.to_string(),
                path.to_string(),
                session.id.clone(),
                parsed.clone(),
            )
            .await?;
            session.selected_effort_level = Some(parsed);
        }
    } else if session.selected_effort_level.is_some() {
        crate::chat::clear_session_effort_level(
            app.clone(),
            worktree_id.to_string(),
            path.to_string(),
            session.id.clone(),
        )
        .await?;
        session.selected_effort_level = None;
    }
    if let Some(thinking) = trimmed_opt(&agent.thinking_level) {
        if session
            .selected_thinking_level
            .as_ref()
            .map(ThinkingLevel::thinking_value)
            != Some(thinking)
        {
            let parsed: ThinkingLevel = serde_json::from_value(json!(thinking))
                .unwrap_or_else(|_| ThinkingLevel::Other(thinking.to_string()));
            crate::chat::set_session_thinking_level(
                app.clone(),
                worktree_id.to_string(),
                path.to_string(),
                session.id.clone(),
                parsed.clone(),
            )
            .await?;
            session.selected_thinking_level = Some(parsed);
        }
    } else if session.selected_thinking_level.is_some() {
        crate::chat::clear_session_thinking_level(
            app.clone(),
            worktree_id.to_string(),
            path.to_string(),
            session.id.clone(),
        )
        .await?;
        session.selected_thinking_level = None;
    }
    Ok(())
}

pub(crate) fn compose_update(events: &[db::AgentEvent]) -> String {
    let mut message =
        String::from("[Jean agent update] Automatic message from Jean, not from the user.\n");
    for (i, event) in events.iter().enumerate() {
        message.push_str(&format!(
            "\n### {}. {}\n{}\n",
            i + 1,
            event.kind,
            event.body.trim()
        ));
    }
    message.push_str(
        "\nDecide the next step. Then reply with a short status: one to three sentences, plus links to the PRs, issues, or sessions involved. Do not add headings, tables, diffs, a recap, or test steps.",
    );
    message
}

/// Where a session lives: (worktree ID, folder) of an agent's chat or task.
fn agent_session_location(
    app: &AppHandle,
    agent: &db::Agent,
    task: Option<&db::Task>,
) -> Result<(String, String), String> {
    let path = super::agent_workdir(app, &agent.id)?;
    Ok(match task {
        Some(_) => (db::agent_tasks_worktree_id(&agent.id), path),
        None => (agent.worktree_id.clone(), path),
    })
}

/// Send `message` to a session as a new turn.
/// The agent's backend, model, effort, thinking, and skills override the
/// session for this turn. Unset fields stay on the session and user defaults.
/// `permission_mode` is the subagent type's plan/build/yolo choice. Without
/// one, the wake still leaves Plan mode so the Jean MCP tools stay available.
pub(crate) fn send_to_session(
    app: &AppHandle,
    agent: &db::Agent,
    session: &crate::chat::types::Session,
    worktree_id: &str,
    path: &str,
    message: String,
    permission_mode: Option<&str>,
) {
    let app_clone = app.clone();
    let agent_name = agent.id.clone();
    let session_id = session.id.clone();
    let backend = trimmed_opt(&agent.backend)
        .map(str::to_string)
        .unwrap_or_else(|| backend_id(&session.backend).to_string());
    let mode = wake_permission_mode(
        session.selected_execution_mode.as_deref(),
        Some(backend.as_str()),
        permission_mode,
    );
    let mut overrides = agent_wake_overrides(agent);
    let needs_default_model = wake_needs_default_model(agent);
    let backend_for_model = agent.backend.clone();
    let message = message_with_agent_skills(&message, &agent.skills);
    let worktree_id = worktree_id.to_string();
    let path = path.to_string();
    tauri::async_runtime::spawn(async move {
        if needs_default_model {
            match crate::load_preferences(app_clone.clone()).await {
                Ok(prefs) => {
                    let parsed = serde_json::from_value::<Backend>(json!(
                        backend_for_model.unwrap_or_default()
                    ))
                    .unwrap_or_default();
                    let model = crate::chat::default_model_for_backend(&parsed, &prefs);
                    fill_wake_model(&mut overrides, model.as_deref());
                }
                Err(e) => {
                    log::warn!("[Agents] default model for {agent_name} was not loaded: {e}")
                }
            }
        }
        let mut payload = json!({
            "sessionId": session_id,
            "worktreeId": worktree_id,
            "worktreePath": path,
            "message": message,
        });
        if let Some(mode) = mode {
            payload["executionMode"] = json!(mode);
        }
        if let Some(map) = overrides.as_object() {
            for (key, value) in map {
                payload[key] = value.clone();
            }
        }
        if let Err(e) =
            crate::http_server::dispatch::dispatch_command(&app_clone, "send_chat_message", payload)
                .await
        {
            log::warn!("[Agents] wake of {agent_name} failed: {e}");
        }
    });
}

/// Mark events delivered and count a wake. Agent requests among them make
/// `session_id` work for the sender, so its answer returns there.
fn record_delivery(
    conn: &rusqlite::Connection,
    agent_id: &str,
    events: &[&db::AgentEvent],
    session_id: &str,
    worktree_id: &str,
) -> Result<(), String> {
    let ids: Vec<i64> = events.iter().map(|e| e.id).collect();
    db::mark_events_delivered(conn, &ids)?;
    db::record_wake(conn, agent_id, session_id)?;
    for event in events {
        if let Some(sender) = event.reply_to_agent.as_deref() {
            db::upsert_delegation(
                conn,
                sender,
                session_id,
                worktree_id,
                event.hop,
                event.reply_to_session.as_deref(),
            )?;
        }
    }
    Ok(())
}

/// Deliver queued updates of one agent. Returns true when something was sent.
async fn deliver(app: &AppHandle, agent_id: &str) -> Result<bool, String> {
    let Some(agent) = super::with_db(app, |conn| db::get_agent(conn, agent_id))? else {
        return Ok(false);
    };
    let events = super::with_db(app, |conn| db::pending_events(conn, &agent.id))?;
    if events.is_empty() {
        return Ok(false);
    }
    let (home, _) = home_session(app, &agent).await?;
    let mut budget = super::with_db(app, |conn| {
        db::wake_budget_remaining(conn, &agent.id, agent.max_wakes_per_hour, db::now())
    })?;
    let mut sent = false;

    // 1. Updates for an existing session (follow-ups, approval results).
    //    An old (rotated) chat forwards to the current chat.
    let mut targeted: Vec<(String, Vec<&db::AgentEvent>)> = Vec::new();
    for event in events.iter().filter(|e| e.target_session_id.is_some()) {
        let target = event.target_session_id.clone().unwrap_or_default();
        let is_task = super::with_db(app, |conn| db::task_by_session(conn, &target))?
            .is_some_and(|t| t.archived_at.is_none());
        let target = if is_task { target } else { home.id.clone() };
        match targeted.iter_mut().find(|(id, _)| *id == target) {
            Some((_, group)) => group.push(event),
            None => targeted.push((target, vec![event])),
        }
    }
    for (session_id, group) in targeted {
        if budget <= 0 {
            break;
        }
        let task = super::with_db(app, |conn| db::task_by_session(conn, &session_id))?;
        let (worktree_id, path) = agent_session_location(app, &agent, task.as_ref())?;
        let Ok(session) = crate::chat::get_session(
            app.clone(),
            worktree_id.clone(),
            path.clone(),
            session_id.clone(),
            Some(1),
        )
        .await
        else {
            continue;
        };
        if crate::chat::registry::is_session_actively_managed(&session.id)
            || session.waiting_for_input
        {
            continue;
        }
        super::with_db(app, |conn| {
            record_delivery(conn, &agent.id, &group, &session.id, &worktree_id)?;
            if task.is_some() {
                db::set_task_running(conn, &session.id)?;
            }
            Ok(())
        })?;
        let owned: Vec<db::AgentEvent> = group.into_iter().cloned().collect();
        let wake_agent = db::agent_for_task_wake(&agent, task.as_ref());
        let permission = task
            .as_ref()
            .and_then(|item| item.subagent_permission_mode.as_deref());
        send_to_session(
            app,
            &wake_agent,
            &session,
            &worktree_id,
            &path,
            compose_update(&owned),
            permission,
        );
        budget -= 1;
        sent = true;
    }

    // 2. Updates without a target start a new task session each.
    for event in events.iter().filter(|e| e.target_session_id.is_none()) {
        let running = super::with_db(app, |conn| db::running_task_count(conn, &agent.id))?;
        if budget <= 0 || running >= db::MAX_RUNNING_TASKS {
            break;
        }
        let worktree_id = db::agent_tasks_worktree_id(&agent.id);
        let path = super::agent_workdir(app, &agent.id)?;
        let title = event
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| task_title_for(&event.kind).to_string());
        let session =
            open_agent_session(app, &agent, &worktree_id, &path, Some(truncate(&title, 60)))
                .await?;
        super::with_db(app, |conn| {
            db::create_task(conn, &agent.id, &session.id, &title, &event.kind)?;
            record_delivery(conn, &agent.id, &[event], &session.id, &worktree_id)
        })?;
        let created = super::with_db(app, |conn| db::task_by_session(conn, &session.id))?;
        let wake_agent = db::agent_for_task_wake(&agent, created.as_ref());
        let permission = created
            .as_ref()
            .and_then(|item| item.subagent_permission_mode.as_deref());
        send_to_session(
            app,
            &wake_agent,
            &session,
            &worktree_id,
            &path,
            compose_update(std::slice::from_ref(event)),
            permission,
        );
        budget -= 1;
        sent = true;
    }
    Ok(sent)
}

fn task_title_for(kind: &str) -> &'static str {
    match kind {
        "schedule" => "Scheduled task",
        "message" => "Request from an agent",
        "approval" => "Approval result",
        _ => "Follow-up",
    }
}

/// Rotate long idle chats and archive or delete old task sessions.
async fn maintenance(app: &AppHandle) -> Result<bool, String> {
    let mut changed = false;
    for agent in super::with_db(app, |conn| db::list_agents(conn))? {
        changed |= rotate_chat_if_long(app, &agent).await.unwrap_or_else(|e| {
            log::warn!("[Agents] chat rotation of {} failed: {e}", agent.id);
            false
        });
    }
    let archive_before =
        db::now() - env_limit("JEAN_AGENT_TASK_ARCHIVE_SECS", TASK_ARCHIVE_AFTER_SECS);
    for task in super::with_db(app, |conn| db::finished_tasks_before(conn, archive_before))? {
        let worktree_id = db::agent_tasks_worktree_id(&task.agent_id);
        let path = super::agent_workdir(app, &task.agent_id)?;
        if let Err(e) =
            crate::chat::archive_session(app.clone(), worktree_id, path, task.session_id.clone())
                .await
        {
            log::warn!("[Agents] archive of task {} failed: {e}", task.id);
        }
        super::with_db(app, |conn| db::mark_task_archived(conn, task.id))?;
        changed = true;
    }
    let delete_before = db::now() - TASK_DELETE_AFTER_SECS;
    for task in super::with_db(app, |conn| db::archived_tasks_before(conn, delete_before))? {
        let worktree_id = db::agent_tasks_worktree_id(&task.agent_id);
        let path = super::agent_workdir(app, &task.agent_id)?;
        let _ = crate::chat::delete_archived_session(
            app.clone(),
            worktree_id,
            path,
            task.session_id.clone(),
        )
        .await;
        super::with_db(app, |conn| db::delete_task(conn, task.id))?;
        changed = true;
    }
    let keys_before = db::now() - EVENT_KEY_RETENTION_SECS;
    super::with_db(app, |conn| db::prune_event_keys(conn, keys_before))?;
    Ok(changed)
}

/// Characters kept in the journal entry written when a chat rotates.
pub(crate) const JOURNAL_CHARS: usize = 2000;

/// Compact history written when a chat rotates. Keeps the end of the handoff
/// text so the newest turns survive. No model call.
pub(crate) fn journal_text_from_rotation(carry_over: &str, message_count: usize) -> String {
    let prefix = format!("Archived chat ({message_count} messages).\n");
    let budget = JOURNAL_CHARS.saturating_sub(prefix.chars().count());
    let body = tail_chars(carry_over.trim(), budget);
    format!("{prefix}{body}")
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    text.chars().skip(count - max_chars).collect()
}

/// A long chat continues in a new one when idle: the end of the old chat goes
/// into the new chat's prompt, a shorter copy is stored as a journal entry,
/// and the old chat is archived.
async fn rotate_chat_if_long(app: &AppHandle, agent: &db::Agent) -> Result<bool, String> {
    let path = super::agent_workdir(app, &agent.id)?;
    let sessions = crate::chat::get_sessions(
        app.clone(),
        agent.worktree_id.clone(),
        path.clone(),
        None,
        Some(true),
    )
    .await?;
    let Some(home) = sessions
        .active_session_id
        .as_deref()
        .and_then(|id| sessions.sessions.iter().find(|s| s.id == id))
        .or_else(|| sessions.sessions.first())
    else {
        return Ok(false);
    };
    let last_activity = home.last_message_at.unwrap_or(home.updated_at);
    let limits = (
        env_limit("JEAN_AGENT_CHAT_ROTATE_MESSAGES", CHAT_ROTATE_MESSAGES),
        env_limit("JEAN_AGENT_CHAT_ROTATE_IDLE_SECS", CHAT_ROTATE_IDLE_SECS),
    );
    if !should_rotate_chat(
        home.message_count.unwrap_or(0),
        last_activity,
        db::now() as u64,
        limits,
    ) || home.waiting_for_input
        || crate::chat::registry::is_session_actively_managed(&home.id)
    {
        return Ok(false);
    }
    let old = crate::chat::get_session(
        app.clone(),
        agent.worktree_id.clone(),
        path.clone(),
        home.id.clone(),
        Some(limits.0.max(CHAT_ROTATE_MESSAGES) as usize),
    )
    .await?;
    let carry_over = crate::chat::handoff::format_handoff_history(&old.messages, CARRY_OVER_CHARS);
    let journal = journal_text_from_rotation(&carry_over, old.messages.len());
    let number = sessions.sessions.len() + 1;
    let new = open_agent_session(
        app,
        agent,
        &agent.worktree_id,
        &path,
        Some(format!("Chat {number}")),
    )
    .await?;
    crate::chat::set_active_session(
        app.clone(),
        agent.worktree_id.clone(),
        path.clone(),
        new.id.clone(),
    )
    .await?;
    super::with_db(app, |conn| db::set_carry_over(conn, &agent.id, &carry_over))?;
    // The journal copy is recall only. A failure must not stop the rotation.
    let journal_id = super::with_db(app, |conn| {
        db::add_journal(
            conn,
            &db::NewJournal {
                agent_id: &agent.id,
                project_id: None,
                content: &journal,
                occurred_at: None,
                source: "rotation",
                source_session_id: Some(&home.id),
            },
        )
    })
    .map(|entry| Some(entry.id))
    .unwrap_or_else(|e| {
        log::warn!("[Agents] {} rotation journal not saved: {e}", agent.id);
        None
    });
    crate::chat::archive_session(
        app.clone(),
        agent.worktree_id.clone(),
        path.clone(),
        home.id.clone(),
    )
    .await?;
    log::info!(
        "[Agents] {} continues in a new chat ({} messages archived, journal #{journal_id:?}, {} chars)",
        agent.id,
        old.messages.len(),
        journal.chars().count()
    );
    // The new chat starts with the agent's recap, so the user does not see
    // an empty chat.
    send_to_session(
        app,
        agent,
        &new,
        &agent.worktree_id,
        &path,
        chat_continued_message(old.messages.len(), journal_id),
        None,
    );
    Ok(true)
}

/// First message of a rotated chat. The UI shows it as a "saved to journal"
/// notice (see `isChatContinuedMessage`) and the agent replies with a recap.
pub(crate) fn chat_continued_message(message_count: usize, journal_id: Option<i64>) -> String {
    let saved = match journal_id {
        Some(id) => format!("Jean saved its end as journal entry #{id}"),
        None => "Jean could not save it to the journal".to_string(),
    };
    format!(
        "[Jean chat continued] Automatic message from Jean, not from the user.
Your previous chat ({message_count} messages) was long, so Jean archived it. {saved}. The end of that chat is in your system prompt.

Reply to the user now. Start with one sentence that tells them the previous chat is saved to the journal and continues here. Then write a short recap of the previous chat: three to six bullets with what was done, what was decided, and what is still open. Use `journal_search` only when the system prompt does not have enough. Do not call other tools. Do not add headings, tables, or test steps. End with one short question about the most useful next step."
    )
}

/// Rotate only long chats that nobody used for a while.
/// `limits` = (messages, idle seconds).
pub(crate) fn should_rotate_chat(
    message_count: u32,
    last_activity: u64,
    now: u64,
    (max_messages, idle_secs): (u32, u64),
) -> bool {
    message_count >= max_messages && now >= last_activity && now - last_activity >= idle_secs
}

/// Execute or reject a pending approval, then queue the result for the agent.
pub async fn decide_approval(
    app: &AppHandle,
    approval_id: i64,
    approve: bool,
) -> Result<db::Approval, String> {
    let status = if approve { "approved" } else { "denied" };
    let decided = super::with_db(app, |conn| db::decide_approval(conn, approval_id, status))?;
    if !decided {
        return Err(format!("Approval #{approval_id} is already decided"));
    }
    let approval = super::with_db(app, |conn| db::get_approval(conn, approval_id))?
        .ok_or_else(|| format!("Approval #{approval_id} not found"))?;
    let (final_status, result, body) = if approve {
        match crate::jean_mcp_core::run_approved_tool(
            app.clone(),
            approval.tool.clone(),
            approval.args.clone(),
        )
        .await
        {
            Ok(value) => {
                let text = truncate(&value.to_string(), 1000);
                (
                    "approved",
                    text.clone(),
                    format!(
                        "The user approved #{approval_id} ({}). It ran. Result: {text}",
                        approval.tool
                    ),
                )
            }
            Err(e) => (
                "failed",
                e.clone(),
                format!(
                    "The user approved #{approval_id} ({}), but it failed: {e}",
                    approval.tool
                ),
            ),
        }
    } else {
        (
            "denied",
            String::new(),
            format!(
                "The user denied #{approval_id} ({}). Do not retry it without asking.",
                approval.tool
            ),
        )
    };
    let title = format!("Approval #{approval_id}: {}", approval.tool);
    super::with_db(app, |conn| {
        db::set_approval_result(conn, approval_id, final_status, &result)?;
        db::add_event(
            conn,
            &db::NewEvent {
                agent_id: &approval.agent_id,
                kind: "approval",
                title: &title,
                body: &body,
                target_session_id: approval.session_id.as_deref(),
                ..Default::default()
            },
        )?;
        Ok(())
    })?;
    let key = format!("approval:{approval_id}");
    let context = format!(
        "Approval #{approval_id} ({}) was {final_status}.",
        approval.tool
    );
    emit_schedule_trigger(app, "approval_resolved", &key, &context);
    super::notify_changed(app);
    super::with_db(app, |conn| db::get_approval(conn, approval_id))?
        .ok_or_else(|| format!("Approval #{approval_id} not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_status_mapping() {
        assert_eq!(outcome_status(true, Some("done"), None), "waiting");
        assert_eq!(outcome_status(false, Some("error"), None), "failed");
        assert_eq!(
            outcome_status(false, None, Some(&RunStatus::Crashed)),
            "failed"
        );
        assert_eq!(outcome_status(false, Some("cancelled"), None), "cancelled");
        assert_eq!(
            outcome_status(false, Some("done"), Some(&RunStatus::Cancelled)),
            "cancelled"
        );
        assert_eq!(
            outcome_status(false, Some("done"), Some(&RunStatus::Completed)),
            "done"
        );
    }

    #[test]
    fn subagent_permission_mode_is_kept_and_cursor_build_becomes_yolo() {
        assert_eq!(
            wake_permission_mode(Some("build"), Some("claude"), Some("plan")),
            Some("plan")
        );
        assert_eq!(
            wake_permission_mode(Some("plan"), Some("claude"), Some("yolo")),
            Some("yolo")
        );
        assert_eq!(
            wake_permission_mode(Some("plan"), Some("cursor"), Some("build")),
            Some("yolo")
        );
        assert_eq!(
            wake_permission_mode(Some("yolo"), Some("claude"), None),
            None
        );
        assert_eq!(
            wake_permission_mode(Some("plan"), Some("claude"), None),
            Some("build")
        );
    }

    #[test]
    fn session_triggers_skip_agent_sessions_and_cancellations() {
        assert_eq!(
            session_trigger_name("done", false),
            Some("session_finished")
        );
        assert_eq!(session_trigger_name("error", false), Some("session_failed"));
        assert_eq!(session_trigger_name("done", true), None);
        assert_eq!(session_trigger_name("cancelled", false), None);
    }

    #[test]
    fn session_event_key_uses_the_run_not_the_clock() {
        let first = session_event_key("s", "done", Some("run-1"), 10);
        assert_eq!(first, session_event_key("s", "done", Some("run-1"), 99));
        assert_ne!(first, session_event_key("s", "done", Some("run-2"), 10));
        assert_eq!(
            session_event_key("s", "done", None, 10),
            "session:s:done:10"
        );
        assert_eq!(
            session_event_key("s", "done", Some(""), 10),
            "session:s:done:10"
        );
    }

    #[test]
    fn archived_and_merged_payloads_become_trigger_keys() {
        let archived = serde_json::json!({"id": "wt-1", "project_id": "proj"});
        let (key, context) = worktree_archived_trigger(&archived, 50).unwrap();
        assert_eq!(key, "archive:wt-1:50");
        assert!(context.contains("wt-1"));
        assert!(worktree_archived_trigger(&serde_json::json!({"id": ""}), 1).is_none());

        let merged = serde_json::json!({"state": "merged", "worktree_id": "wt-1", "pr_number": 12});
        let (key, context) = pr_merged_trigger(&merged).unwrap();
        assert_eq!(key, "pr:wt-1:12");
        assert!(context.contains("#12"));
        assert!(pr_merged_trigger(
            &serde_json::json!({"state": "open", "worktree_id": "wt-1", "pr_number": 12})
        )
        .is_none());
    }

    #[test]
    fn chat_rotates_only_when_long_and_idle() {
        let now = 100_000;
        let limits = (CHAT_ROTATE_MESSAGES, CHAT_ROTATE_IDLE_SECS);
        assert!(should_rotate_chat(40, now - 600, now, limits));
        assert!(!should_rotate_chat(39, now - 10_000, now, limits));
        assert!(!should_rotate_chat(80, now - 60, now, limits));
        // Clock skew (activity "in the future") never rotates
        assert!(!should_rotate_chat(80, now + 60, now, limits));
    }

    #[test]
    fn chat_continued_message_names_the_journal_entry() {
        let text = chat_continued_message(42, Some(7));
        assert!(text.starts_with("[Jean chat continued]"));
        assert!(text.contains("(42 messages)"));
        assert!(text.contains("journal entry #7"));
        let failed = chat_continued_message(42, None);
        assert!(!failed.contains('#'));
    }

    #[test]
    fn rotation_journal_keeps_the_end_of_the_chat() {
        let long = format!("User: start\n\n{}", "x".repeat(4000));
        let text = journal_text_from_rotation(&long, 42);
        assert!(text.starts_with("Archived chat (42 messages)."));
        assert!(text.chars().count() <= JOURNAL_CHARS);
        assert!(text.ends_with('x'));
        assert!(!text.contains("User: start"));
        let short = journal_text_from_rotation("User: ship orbit", 3);
        assert!(short.contains("User: ship orbit"));
        assert!(short.contains("Archived chat (3 messages)."));
    }

    #[test]
    fn wake_mode_avoids_plan_mode() {
        assert_eq!(wake_execution_mode(Some("plan")), Some("build"));
        assert_eq!(wake_execution_mode(None), Some("build"));
        assert_eq!(wake_execution_mode(Some("build")), None);
        assert_eq!(wake_execution_mode(Some("yolo")), None);
        assert_eq!(wake_execution_mode(Some("supervised")), None);
        assert_eq!(wake_execution_mode(Some("auto")), None);
        assert_eq!(
            wake_execution_mode_for(Some("plan"), Some("cursor")),
            Some("yolo")
        );
        assert_eq!(
            wake_execution_mode_for(Some("build"), Some("cursor")),
            Some("yolo")
        );
        assert_eq!(wake_execution_mode_for(Some("yolo"), Some("cursor")), None);
        assert_eq!(
            wake_execution_mode_for(Some("plan"), Some("codex")),
            Some("build")
        );
    }

    fn sample_agent() -> db::Agent {
        db::Agent {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            description: String::new(),
            icon: "blue".into(),
            role_prompt: String::new(),
            worktree_id: "__agent_reviewer__".into(),
            max_wakes_per_hour: 12,
            builtin: false,
            backend: None,
            model: None,
            effort: None,
            thinking_level: None,
            skills: Vec::new(),
            mcp_servers: None,
            jean_tools: None,
        }
    }

    #[test]
    fn unset_agent_run_config_adds_no_wake_overrides() {
        let overrides = agent_wake_overrides(&sample_agent());
        assert_eq!(overrides, json!({}));
        assert!(!wake_needs_default_model(&sample_agent()));
        assert!(should_stamp_agent_run(0, 0));
        assert!(!should_stamp_agent_run(1, 0));
        assert!(!should_stamp_agent_run(0, 2));
    }

    #[test]
    fn set_agent_run_config_overrides_backend_model_and_effort() {
        let mut agent = sample_agent();
        agent.backend = Some("codex".into());
        agent.model = Some("gpt-5.5".into());
        agent.effort = Some("high".into());
        agent.thinking_level = Some("off".into());
        let overrides = agent_wake_overrides(&agent);
        assert_eq!(overrides["backend"], "codex");
        assert_eq!(overrides["model"], "gpt-5.5");
        assert_eq!(overrides["effortLevel"], "high");
        assert_eq!(overrides["thinkingLevel"], "off");
        assert!(!wake_needs_default_model(&agent));

        agent.model = None;
        let mut overrides = agent_wake_overrides(&agent);
        assert!(overrides.get("model").is_none());
        assert!(wake_needs_default_model(&agent));
        fill_wake_model(&mut overrides, Some("gpt-5.4"));
        assert_eq!(overrides["model"], "gpt-5.4");
        fill_wake_model(&mut overrides, Some("other"));
        assert_eq!(overrides["model"], "gpt-5.4");
    }

    #[test]
    fn skill_refs_use_the_chat_marker_and_skip_duplicates() {
        let skills = vec![
            db::AgentSkill {
                name: "review".into(),
                path: "/skills/review/SKILL.md".into(),
                backend: Some("codex".into()),
            },
            db::AgentSkill {
                name: String::new(),
                path: "  ".into(),
                backend: None,
            },
        ];
        let marker = crate::agents::skill_instruction("/skills/review/SKILL.md");
        let message = message_with_agent_skills("Check the release", &skills);
        assert!(message.starts_with("Check the release\n\n"));
        assert!(message.contains(&marker));
        let again = message_with_agent_skills(&message, &skills);
        assert_eq!(again.matches(&marker).count(), 1);
        assert_eq!(message_with_agent_skills("only text", &[]), "only text");
    }

    #[test]
    fn truncate_counts_chars_not_bytes() {
        assert_eq!(truncate("  short ", 10), "short");
        assert_eq!(truncate("ééééé", 3), "ééé…");
    }

    #[test]
    fn update_message_lists_events_and_marks_source() {
        let events = vec![
            db::AgentEvent {
                id: 1,
                agent_id: "jean".into(),
                kind: "delegation".into(),
                body: "Session A finished.".into(),
                hop: 0,
                reply_to_agent: None,
                created_at: 0,
                title: None,
                target_session_id: None,
                reply_to_session: None,
            },
            db::AgentEvent {
                id: 2,
                agent_id: "jean".into(),
                kind: "schedule".into(),
                body: "Schedule #3 is due.".into(),
                hop: 0,
                reply_to_agent: None,
                created_at: 0,
                title: None,
                target_session_id: None,
                reply_to_session: None,
            },
        ];
        let message = compose_update(&events);
        assert!(message.starts_with("[Jean agent update]"));
        assert!(message.contains("### 1. delegation\nSession A finished."));
        assert!(message.contains("### 2. schedule\nSchedule #3 is due."));
    }
}
