//! Commands for the Agents UI (registered in `http_server/dispatch.rs`, which
//! serves both native IPC and web access).

use serde::Serialize;
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

pub fn create_agent(
    app: &AppHandle,
    name: &str,
    description: &str,
    icon: &str,
    role_prompt: &str,
) -> Result<db::Agent, String> {
    let agent = super::with_db(app, |conn| {
        db::create_agent(conn, name, description, icon, role_prompt)
    })?;
    super::notify_changed(app);
    Ok(agent)
}

pub async fn update_agent(
    app: &AppHandle,
    agent_id: &str,
    patch: db::AgentPatch,
) -> Result<db::Agent, String> {
    let pausing = patch.paused == Some(true);
    let agent = super::with_db(app, |conn| db::update_agent(conn, agent_id, &patch))?;
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
    shared: bool,
    pinned: bool,
) -> Result<db::Memory, String> {
    let memory = super::with_db(app, |conn| {
        db::save_memory(
            conn,
            &db::NewMemory {
                agent_id: (!shared).then_some(agent_id),
                project_id: None,
                kind,
                content,
                pinned,
                source_session_id: None,
                expires_at: None,
            },
        )
    })?;
    super::notify_changed(app);
    Ok(memory)
}

pub fn update_memory(
    app: &AppHandle,
    agent_id: &str,
    memory_id: i64,
    patch: db::MemoryPatch,
) -> Result<db::Memory, String> {
    let memory = super::with_db(app, |conn| {
        db::update_memory(conn, agent_id, memory_id, &patch)
    })?;
    super::notify_changed(app);
    Ok(memory)
}

pub fn delete_memory(app: &AppHandle, agent_id: &str, memory_id: i64) -> Result<(), String> {
    if !super::with_db(app, |conn| db::forget_memory(conn, agent_id, memory_id))? {
        return Err(format!("Memory not found: {memory_id}"));
    }
    super::notify_changed(app);
    Ok(())
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
            if m.agent_id.is_none() {
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
