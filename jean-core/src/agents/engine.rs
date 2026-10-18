//! Backend loop of the agents infrastructure. It runs without any client:
//! 1. `chat:done` / `chat:error` / `chat:cancelled` mark delegations and
//!    tasks to check.
//! 2. Delegation checks read the finished session and queue an update for
//!    the session that started the work (its origin).
//! 3. Due schedules queue updates.
//! 4. Updates with a target session go there; updates without one start a
//!    new task session (background work, apart from the user's chat).
//! 5. Long chats are archived and continue in a new chat; old task
//!    sessions are archived, then deleted.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::Notify;

use super::db;
use crate::chat::types::{MessageRole, RunStatus};

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
    let marked = super::with_db(app, |conn| {
        let at = db::now() + CHECK_DELAY_SECS;
        Ok(
            db::mark_delegation_run_ended(conn, session_id, kind, error, at)?
                + db::mark_task_run_ended(conn, session_id, kind, at)?,
        )
    })
    .unwrap_or(0);
    // An agent's own run ended: its queued updates can be delivered now.
    if marked > 0 || super::agent_for_session(app, session_id).is_some() {
        super::notify_changed(app);
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
    let agents = super::with_db(app, db::agents_with_pending_events)?;
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
/// session's Build/Yolo mode, use Build otherwise.
pub(crate) fn wake_execution_mode(selected: Option<&str>) -> Option<&'static str> {
    match selected {
        Some("build") | Some("yolo") => None,
        _ => Some("build"),
    }
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
    message.push_str("\nDecide the next step. If nothing is needed, reply briefly.");
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

/// Send `message` to a session as a new turn (never in Plan mode).
fn send_to_session(
    app: &AppHandle,
    agent_id: &str,
    session: &crate::chat::types::Session,
    worktree_id: &str,
    path: &str,
    message: String,
) {
    let mut payload = json!({
        "sessionId": session.id,
        "worktreeId": worktree_id,
        "worktreePath": path,
        "message": message,
    });
    if let Some(mode) = wake_execution_mode(session.selected_execution_mode.as_deref()) {
        payload["executionMode"] = json!(mode);
    }
    let app_clone = app.clone();
    let agent_name = agent_id.to_string();
    tauri::async_runtime::spawn(async move {
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
    if agent.paused {
        return Ok(false);
    }
    let events = super::with_db(app, |conn| db::pending_events(conn, &agent.id))?;
    if events.is_empty() {
        return Ok(false);
    }
    let (home, _) = home_session(app, &agent).await?;
    let mut budget = super::with_db(app, |conn| {
        Ok(agent.max_wakes_per_hour - db::wakes_since(conn, &agent.id, db::now() - 3600)?)
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
        send_to_session(
            app,
            &agent.id,
            &session,
            &worktree_id,
            &path,
            compose_update(&owned),
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
        let mut session = crate::chat::create_session(
            app.clone(),
            worktree_id.clone(),
            path.clone(),
            Some(truncate(&title, 60)),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await?;
        ensure_session_mode(app, &worktree_id, &path, &mut session).await?;
        super::with_db(app, |conn| {
            db::create_task(conn, &agent.id, &session.id, &title, &event.kind)?;
            record_delivery(conn, &agent.id, &[event], &session.id, &worktree_id)
        })?;
        send_to_session(
            app,
            &agent.id,
            &session,
            &worktree_id,
            &path,
            compose_update(std::slice::from_ref(event)),
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
    for agent in super::with_db(app, db::list_agents)? {
        if !agent.paused {
            changed |= rotate_chat_if_long(app, &agent).await.unwrap_or_else(|e| {
                log::warn!("[Agents] chat rotation of {} failed: {e}", agent.id);
                false
            });
        }
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
    Ok(changed)
}

/// A long chat continues in a new one when idle: the end of the old chat goes
/// into the new chat's prompt, and the old chat is archived.
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
    let number = sessions.sessions.len() + 1;
    let new = crate::chat::create_session(
        app.clone(),
        agent.worktree_id.clone(),
        path.clone(),
        Some(format!("Chat {number}")),
        None,
        None,
        None,
        None,
        None,
        None,
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
    crate::chat::archive_session(
        app.clone(),
        agent.worktree_id.clone(),
        path,
        home.id.clone(),
    )
    .await?;
    log::info!(
        "[Agents] {} continues in a new chat ({} messages archived)",
        agent.id,
        old.messages.len()
    );
    Ok(true)
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
    fn wake_mode_avoids_plan_mode() {
        assert_eq!(wake_execution_mode(Some("plan")), Some("build"));
        assert_eq!(wake_execution_mode(None), Some("build"));
        assert_eq!(wake_execution_mode(Some("build")), None);
        assert_eq!(wake_execution_mode(Some("yolo")), None);
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
