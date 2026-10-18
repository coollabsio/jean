//! Commands for the Agents UI (registered in `http_server/dispatch.rs`, which
//! serves both native IPC and web access).

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::db;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    #[serde(flatten)]
    pub agent: db::Agent,
    /// idle | working | waiting (needs the user) | paused
    pub status: String,
    pub home_session_id: Option<String>,
    pub pending_updates: i64,
    pub pending_approvals: i64,
    pub active_delegations: i64,
    pub next_schedule_at: Option<i64>,
    pub budget_reached: bool,
    /// Worktree ID of the agent's background task sessions.
    pub tasks_worktree_id: String,
    pub running_tasks: i64,
    pub unread_notifications: i64,
    /// One line about the latest activity: chat reply, notification, or task result
    pub activity: Option<String>,
}

/// One short line from a message: the first non-empty line without Markdown
/// marks, at most 120 characters.
pub(crate) fn activity_preview(text: &str) -> Option<String> {
    let line = text
        .lines()
        .map(|line| line.trim().trim_start_matches(['#', '-', '*', '>', ' ']))
        .find(|line| !line.trim().is_empty())?;
    let clean: String = line
        .chars()
        .filter(|c| !matches!(c, '*' | '`' | '_'))
        .collect();
    Some(super::engine::truncate(clean.trim(), 120))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetails {
    pub delegations: Vec<db::Delegation>,
    pub schedules: Vec<db::Schedule>,
    pub approvals: Vec<db::Approval>,
    pub memories: Vec<db::Memory>,
    pub journal: Vec<db::JournalEntry>,
    pub memory_changes: Vec<db::MemoryChange>,
    pub tasks: Vec<db::Task>,
    pub notifications: Vec<db::Notification>,
}

pub async fn list_agents(app: &AppHandle) -> Result<Vec<AgentSummary>, String> {
    let agents = super::with_db(app, db::list_agents)?;
    let mut out = Vec::with_capacity(agents.len());
    for agent in agents {
        let home_with_path = super::engine::home_session(app, &agent).await.ok();
        // Last reply in the chat (with its time) for the activity line
        let chat_reply = match &home_with_path {
            Some((session, path)) => crate::chat::get_session(
                app.clone(),
                agent.worktree_id.clone(),
                path.clone(),
                session.id.clone(),
                Some(2),
            )
            .await
            .ok()
            .and_then(|s| {
                s.messages
                    .iter()
                    .rev()
                    .find(|m| {
                        m.role == crate::chat::types::MessageRole::Assistant
                            && !m.content.trim().is_empty()
                    })
                    .map(|m| (m.timestamp as i64, m.content.clone()))
            }),
            None => None,
        };
        let home = home_with_path.map(|(s, _)| s);
        let since = db::now() - 3600;
        let (
            pending_updates,
            pending_approvals,
            active_delegations,
            next_schedule_at,
            wakes,
            running_tasks,
            unread_notifications,
        ) = super::with_db(app, |conn| {
            let active = db::list_delegations(conn, &agent.id, 200)?
                .iter()
                .filter(|d| d.status == "active")
                .count() as i64;
            Ok((
                db::pending_event_count(conn, &agent.id)?,
                db::pending_approval_count(conn, &agent.id)?,
                active,
                db::next_schedule_at(conn, &agent.id)?,
                db::wakes_since(conn, &agent.id, since)?,
                db::running_task_count(conn, &agent.id)?,
                db::unread_notification_count(conn, &agent.id)?,
            ))
        })?;
        let busy = running_tasks > 0
            || home
                .as_ref()
                .is_some_and(|s| crate::chat::registry::is_session_actively_managed(&s.id));
        let waiting = home.as_ref().is_some_and(|s| s.waiting_for_input) || pending_approvals > 0;
        let activity = super::with_db(app, |conn| db::latest_activity(conn, &agent.id))?
            .into_iter()
            .chain(chat_reply)
            .max_by_key(|(at, _)| *at)
            .and_then(|(_, text)| activity_preview(&text));
        let status = if agent.paused {
            "paused"
        } else if busy {
            "working"
        } else if waiting {
            "waiting"
        } else {
            "idle"
        };
        out.push(AgentSummary {
            status: status.to_string(),
            home_session_id: home.map(|s| s.id),
            pending_updates,
            pending_approvals,
            active_delegations,
            next_schedule_at,
            budget_reached: wakes >= agent.max_wakes_per_hour,
            tasks_worktree_id: db::agent_tasks_worktree_id(&agent.id),
            running_tasks,
            unread_notifications,
            activity,
            agent,
        });
    }
    Ok(out)
}

pub fn get_agent_details(app: &AppHandle, agent_id: &str) -> Result<AgentDetails, String> {
    super::with_db(app, |conn| {
        db::get_agent(conn, agent_id)?.ok_or_else(|| format!("Agent not found: {agent_id}"))?;
        Ok(AgentDetails {
            delegations: db::list_delegations(conn, agent_id, 30)?,
            schedules: db::list_schedules(conn, agent_id)?,
            approvals: db::list_approvals(conn, agent_id, 30)?,
            memories: db::list_memories(conn, agent_id)?,
            journal: db::search_journal(
                conn,
                &db::JournalSearch {
                    agent_id,
                    query: None,
                    from: None,
                    to: None,
                    limit: 40,
                },
            )?,
            memory_changes: db::list_memory_changes(conn, agent_id, 30)?,
            tasks: db::list_tasks(conn, agent_id, 50)?,
            notifications: db::list_notifications(conn, agent_id, 30)?,
        })
    })
}

pub fn mark_notifications_read(app: &AppHandle, agent_id: &str) -> Result<(), String> {
    super::with_db(app, |conn| db::mark_notifications_read(conn, agent_id))?;
    super::notify_changed(app);
    Ok(())
}

pub async fn create_agent(
    app: &AppHandle,
    name: &str,
    description: &str,
    icon: &str,
    role_prompt: &str,
    config: db::AgentRunConfig,
) -> Result<db::Agent, String> {
    let agent = super::with_db(app, |conn| {
        db::create_agent(conn, name, description, icon, role_prompt, &config)
    })?;
    // The home chat is created on first list. Stamp it now so the toolbar
    // shows this agent's backend and model before the user sends a message.
    if let Err(e) = super::engine::apply_run_config_to_home(app, &agent).await {
        log::warn!(
            "[Agents] could not prepare home session for {}: {e}",
            agent.id
        );
    }
    super::notify_changed(app);
    super::notify_sessions(app);
    Ok(agent)
}

pub async fn update_agent(
    app: &AppHandle,
    agent_id: &str,
    patch: db::AgentPatch,
) -> Result<db::Agent, String> {
    let pausing = patch.paused == Some(true);
    let agent = super::with_db(app, |conn| db::update_agent(conn, agent_id, &patch))?;
    if patch.changes_run_config() {
        if let Err(e) = super::engine::apply_run_config_to_home(app, &agent).await {
            log::warn!(
                "[Agents] could not update home session for {}: {e}",
                agent.id
            );
        }
        super::notify_sessions(app);
    }
    // Stop: cancel the agent's running turn. Its queue and schedules wait.
    if pausing {
        let path = super::agent_workdir(app, agent_id)?;
        if let Ok(sessions) =
            crate::chat::get_sessions(app.clone(), agent.worktree_id.clone(), path, None, None)
                .await
        {
            for session in sessions.sessions {
                if crate::chat::registry::is_session_actively_managed(&session.id) {
                    let _ = crate::chat::cancel_chat_message(
                        app.clone(),
                        session.id.clone(),
                        agent.worktree_id.clone(),
                    )
                    .await;
                }
            }
        }
    }
    super::notify_changed(app);
    Ok(agent)
}

pub fn delete_agent(app: &AppHandle, agent_id: &str) -> Result<(), String> {
    super::with_db(app, |conn| db::delete_agent(conn, agent_id))?;
    super::notify_changed(app);
    Ok(())
}

pub async fn decide_approval(
    app: &AppHandle,
    approval_id: i64,
    approve: bool,
) -> Result<db::Approval, String> {
    super::engine::decide_approval(app, approval_id, approve).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleCommandInput {
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub every_secs: Option<i64>,
    #[serde(default)]
    pub delay_secs: Option<i64>,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleCommandPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub paused: Option<bool>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub every_secs: Option<i64>,
    #[serde(default)]
    pub delay_secs: Option<i64>,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
}

fn timing_from_kind(
    kind: &str,
    every_secs: Option<i64>,
    delay_secs: Option<i64>,
    cron: Option<&str>,
    timezone: Option<&str>,
    event: Option<&str>,
    now_unix: i64,
) -> Result<db::ScheduleTiming, String> {
    let max = super::cron::max_interval_secs();
    match kind {
        "once" => {
            let delay = delay_secs.unwrap_or(60);
            if !(60..=max).contains(&delay) {
                return Err(format!("Delay must be between 60 and {max} seconds"));
            }
            db::validate_schedule_timing(None, None, None, None, Some(now_unix + delay), now_unix)
        }
        "interval" => {
            let every = every_secs
                .filter(|secs| *secs > 0)
                .ok_or_else(|| "Interval requires a positive everySecs".to_string())?;
            db::validate_schedule_timing(
                Some(every),
                None,
                None,
                None,
                Some(now_unix + every),
                now_unix,
            )
        }
        "cron" => {
            let expression = cron.ok_or_else(|| "Cron requires a cron expression".to_string())?;
            db::validate_schedule_timing(None, Some(expression), timezone, None, None, now_unix)
        }
        "event" => {
            let event = event.ok_or_else(|| "Event requires an event type".to_string())?;
            db::validate_schedule_timing(None, None, None, Some(event), None, now_unix)
        }
        _ => Err("kind must be once, interval, cron, or event".to_string()),
    }
}

pub fn create_schedule_for_agent(
    app: &AppHandle,
    agent_id: &str,
    input: ScheduleCommandInput,
) -> Result<db::Schedule, String> {
    let timing = timing_from_kind(
        &input.kind,
        input.every_secs,
        input.delay_secs,
        input.cron.as_deref(),
        input.timezone.as_deref(),
        input.event.as_deref(),
        db::now(),
    )?;
    let schedule = super::with_db(app, |conn| {
        db::insert_schedule(
            conn,
            agent_id,
            &input.name,
            &input.prompt,
            &timing,
            input.paused,
        )
    })?;
    super::notify_changed(app);
    Ok(schedule)
}

pub fn update_schedule_for_agent(
    app: &AppHandle,
    agent_id: &str,
    schedule_id: i64,
    patch: ScheduleCommandPatch,
) -> Result<db::Schedule, String> {
    let timing = match patch.kind.as_deref() {
        Some(kind) => Some(timing_from_kind(
            kind,
            patch.every_secs,
            patch.delay_secs,
            patch.cron.as_deref(),
            patch.timezone.as_deref(),
            patch.event.as_deref(),
            db::now(),
        )?),
        None => None,
    };
    let schedule = super::with_db(app, |conn| {
        db::update_schedule(
            conn,
            agent_id,
            schedule_id,
            patch.name.as_deref(),
            patch.prompt.as_deref(),
            patch.paused,
            timing.as_ref(),
        )
    })?;
    super::notify_changed(app);
    Ok(schedule)
}

pub fn cancel_schedule(app: &AppHandle, agent_id: &str, schedule_id: i64) -> Result<(), String> {
    if !super::with_db(app, |conn| db::cancel_schedule(conn, agent_id, schedule_id))? {
        return Err(format!("No active schedule #{schedule_id}"));
    }
    super::notify_changed(app);
    Ok(())
}

pub fn save_memory(
    app: &AppHandle,
    agent_id: &str,
    content: &str,
    kind: &str,
    scope: Option<&str>,
    shared: bool,
    pinned: bool,
    project_id: Option<&str>,
) -> Result<db::Memory, String> {
    let resolved = scope.unwrap_or(if shared { "shared" } else { "agent" });
    let memory = super::with_db(app, |conn| {
        db::save_memory(
            conn,
            &db::NewMemory {
                agent_id: Some(agent_id),
                scope: Some(resolved),
                project_id,
                kind,
                content,
                pinned,
                source_session_id: None,
                expires_at: None,
            },
            None,
        )
    })?;
    super::notify_changed(app);
    Ok(memory)
}

#[derive(Debug, Clone)]
pub struct MemorySearchRequest {
    pub query: Option<String>,
    pub kind: Option<String>,
    pub scope: Option<String>,
    pub project_id: Option<String>,
    pub pinned: Option<bool>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<i64>,
}

pub fn search_memory(
    app: &AppHandle,
    agent_id: &str,
    request: MemorySearchRequest,
) -> Result<Vec<db::Memory>, String> {
    super::with_db(app, |conn| {
        db::search_memories(
            conn,
            &db::MemorySearch {
                agent_id,
                query: request.query.as_deref().filter(|query| !query.is_empty()),
                kind: request.kind.as_deref().filter(|kind| !kind.is_empty()),
                scope: request.scope.as_deref().filter(|scope| !scope.is_empty()),
                project_id: request
                    .project_id
                    .as_deref()
                    .filter(|project| !project.is_empty()),
                pinned: request.pinned,
                from: request.from,
                to: request.to,
                include_expired: true,
                limit: request.limit.unwrap_or(200).clamp(1, 200),
            },
        )
    })
}

pub fn update_memory(
    app: &AppHandle,
    agent_id: &str,
    memory_id: i64,
    patch: db::MemoryPatch,
) -> Result<db::Memory, String> {
    let memory = super::with_db(app, |conn| {
        db::update_memory(conn, agent_id, memory_id, &patch, None)
    })?;
    super::notify_changed(app);
    Ok(memory)
}

pub fn delete_memory(app: &AppHandle, agent_id: &str, memory_id: i64) -> Result<(), String> {
    if !super::with_db(app, |conn| {
        db::forget_memory(conn, agent_id, memory_id, None)
    })? {
        return Err(format!("Memory not found: {memory_id}"));
    }
    super::notify_changed(app);
    Ok(())
}

pub fn supersede_memory(
    app: &AppHandle,
    agent_id: &str,
    memory_id: i64,
    content: &str,
) -> Result<db::Memory, String> {
    let memory = super::with_db(app, |conn| {
        db::supersede_memory(conn, agent_id, None, memory_id, content, None)
    })?;
    super::notify_changed(app);
    Ok(memory)
}

pub fn save_journal(
    app: &AppHandle,
    agent_id: &str,
    content: &str,
    occurred_at: Option<i64>,
    project_id: Option<&str>,
) -> Result<db::JournalEntry, String> {
    let entry = super::with_db(app, |conn| {
        db::add_journal(
            conn,
            &db::NewJournal {
                agent_id,
                project_id,
                content,
                occurred_at,
                source: "user",
                source_session_id: None,
            },
        )
    })?;
    super::notify_changed(app);
    Ok(entry)
}

pub fn search_journal(
    app: &AppHandle,
    agent_id: &str,
    query: Option<&str>,
    from: Option<i64>,
    to: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<db::JournalEntry>, String> {
    super::with_db(app, |conn| {
        db::search_journal(
            conn,
            &db::JournalSearch {
                agent_id,
                query: query.filter(|query| !query.is_empty()),
                from,
                to,
                limit: limit.unwrap_or(50),
            },
        )
    })
}

/// Memory as Markdown, for review or backup.
pub fn export_memory(app: &AppHandle, agent_id: &str) -> Result<String, String> {
    let memories = super::with_db(app, |conn| db::list_memories(conn, agent_id))?;
    Ok(render_memory_markdown(agent_id, &memories))
}

pub(crate) fn render_memory_markdown(agent_id: &str, memories: &[db::Memory]) -> String {
    let mut out = format!("# Memory of agent `{agent_id}`\n");
    for (title, kind) in [
        ("Rules", "rule"),
        ("Facts", "fact"),
        ("Open work", "open_work"),
    ] {
        let items: Vec<_> = memories.iter().filter(|m| m.kind == kind).collect();
        if items.is_empty() {
            continue;
        }
        out.push_str(&format!("\n## {title}\n"));
        for m in items {
            let mut tags = Vec::new();
            if m.scope == "user" {
                tags.push("user".to_string());
            } else if m.agent_id.is_none() || m.scope == "shared" {
                tags.push("shared".to_string());
            }
            if m.pinned {
                tags.push("pinned".to_string());
            }
            if let Some(p) = &m.project_id {
                tags.push(format!("project {p}"));
            }
            let tags = if tags.is_empty() {
                String::new()
            } else {
                format!(" ({})", tags.join(", "))
            };
            out.push_str(&format!("- {}{tags}\n", m.content));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_kind_rejects_non_positive_seconds() {
        for every in [None, Some(0), Some(-300)] {
            let err =
                timing_from_kind("interval", every, None, None, None, None, 1_000).unwrap_err();
            assert!(err.contains("everySecs"), "{err}");
        }
        let ok = timing_from_kind("interval", Some(600), None, None, None, None, 1_000).unwrap();
        assert_eq!((ok.every_secs, ok.next_run_at), (Some(600), 1_600));
    }

    #[test]
    fn activity_preview_takes_first_clean_line() {
        assert_eq!(
            activity_preview("\n## Recap\nmore").as_deref(),
            Some("Recap")
        );
        assert_eq!(
            activity_preview("**Done**: pushed `main`").as_deref(),
            Some("Done: pushed main")
        );
        assert_eq!(activity_preview("   \n  "), None);
        assert_eq!(
            activity_preview(&"x".repeat(200)).unwrap().chars().count(),
            121
        );
    }

    #[test]
    fn memory_markdown_groups_by_kind() {
        let m = |id, kind: &str, content: &str, agent: Option<&str>, pinned| db::Memory {
            id,
            agent_id: agent.map(Into::into),
            project_id: None,
            kind: kind.into(),
            content: content.into(),
            pinned,
            created_at: 0,
            updated_at: 0,
            expires_at: None,
            scope: if agent.is_none() {
                "shared".into()
            } else {
                "agent".into()
            },
            superseded_by: None,
            superseded_at: None,
        };
        let md = render_memory_markdown(
            "jean",
            &[
                m(1, "rule", "Ask before merge", Some("jean"), true),
                m(2, "fact", "vattaf is prod", None, false),
            ],
        );
        assert!(md.contains("## Rules\n- Ask before merge (pinned)"));
        assert!(md.contains("## Facts\n- vattaf is prod (shared)"));
        assert!(!md.contains("Open work"));
    }
}
