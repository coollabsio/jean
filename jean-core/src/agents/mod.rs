//! Agents infrastructure: persistent agents (Jean and user-made agents) that
//! run on the backend. State lives in `{app_data}/agents.db` (SQLite):
//! - delegations: sessions that work for an agent; their results wake it
//! - events + wakes: queued updates for an agent, with an hourly budget
//! - schedules: one-shot and repeating wake-ups
//! - approvals: destructive MCP tools wait for the user
//! - memories: rules, facts and open work, added to each agent run's prompt
//!
//! Agent sessions live under reserved worktree IDs (`__jean_agent__`,
//! `__agent_<id>__`) and run in a scratch folder in app data.

pub mod commands;
pub mod db;
mod engine;
pub mod mcp;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::AppHandle;

pub use db::{is_agent_worktree_id, Agent};
pub use engine::start;

/// Managed state: the single agents database connection of this process.
pub struct AgentsDb(Mutex<Connection>);

/// Most memory entries added to an agent's prompt, and their size budget.
const PROMPT_MEMORY_LIMIT: i64 = 40;
const PROMPT_MEMORY_CHARS: usize = 8000;

/// Open `agents.db` and register it as managed state. Call once at startup.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;
    let conn = db::open(&dir.join("agents.db"))?;
    app.manage(AgentsDb(Mutex::new(conn)));
    Ok(())
}

/// Run `f` with the agents database. Fails when it is not open.
pub fn with_db<T>(
    app: &AppHandle,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let state = app
        .try_state::<AgentsDb>()
        .ok_or_else(|| "Agents database is not available".to_string())?;
    let conn = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&conn)
}

/// The agent that owns this worktree ID (its chat or its task worktree).
pub fn agent_for_worktree(app: &AppHandle, worktree_id: &str) -> Option<Agent> {
    if !is_agent_worktree_id(worktree_id) {
        return None;
    }
    with_db(app, |conn| {
        match db::agent_id_from_tasks_worktree(worktree_id) {
            Some(agent_id) => db::get_agent(conn, agent_id),
            None => db::agent_by_worktree(conn, worktree_id),
        }
    })
    .ok()
    .flatten()
}

/// The agent that owns this session (the session is in an agent worktree).
pub fn agent_for_session(app: &AppHandle, session_id: &str) -> Option<Agent> {
    let metadata = crate::chat::storage::load_metadata(app, session_id).ok()??;
    agent_for_worktree(app, &metadata.worktree_id)
}

/// Scratch working directory of an agent (created when missing). Jean keeps
/// its original `jean-agent` folder.
pub fn agent_workdir(app: &AppHandle, agent_id: &str) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let dir = if agent_id == db::JEAN_AGENT_ID {
        app_data_dir.join("jean-agent")
    } else {
        app_data_dir.join("agents").join(agent_id)
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create agent directory: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Working directory for an agent worktree ID (MCP path resolution).
pub fn workdir_for_worktree(app: &AppHandle, worktree_id: &str) -> Option<String> {
    let agent = agent_for_worktree(app, worktree_id)?;
    agent_workdir(app, &agent.id).ok()
}

/// Tell every client to refresh agent data, and run the engine now.
pub fn notify_changed(app: &AppHandle) {
    use crate::http_server::EmitExt;
    if let Err(e) = app.emit_all(
        "cache:invalidate",
        &serde_json::json!({ "keys": ["agents"] }),
    ) {
        log::warn!("Failed to emit agents cache invalidation: {e}");
    }
    engine::nudge();
}

/// What an agent session is for.
#[derive(Debug, Clone, PartialEq)]
enum SessionRole {
    /// Conversation with the user, with the end of the previous chat.
    Chat { carry_over: Option<String> },
    /// Background work (schedule, follow-up, agent request).
    Task,
}

/// Extra system prompt for runs in an agent worktree: role, how the agent
/// infrastructure works, other agents, and memory. `None` for normal sessions.
pub fn system_prompt_for(app: &AppHandle, worktree_id: &str) -> Option<String> {
    let agent = agent_for_worktree(app, worktree_id)?;
    let is_task = db::agent_id_from_tasks_worktree(worktree_id).is_some();
    let (peers, memories, carry_over) = with_db(app, |conn| {
        Ok((
            db::list_agents(conn)?,
            db::search_memories(conn, &agent.id, None, PROMPT_MEMORY_LIMIT)?,
            if is_task {
                None
            } else {
                db::get_carry_over(conn, &agent.id)?
            },
        ))
    })
    .unwrap_or_default();
    let role = if is_task {
        SessionRole::Task
    } else {
        SessionRole::Chat { carry_over }
    };
    let mcp = crate::jean_mcp_config::current_mode().server_name();
    Some(render_system_prompt(&agent, &peers, &memories, mcp, &role))
}

fn render_system_prompt(
    agent: &Agent,
    peers: &[Agent],
    memories: &[db::Memory],
    mcp: &str,
    role: &SessionRole,
) -> String {
    let mut out = format!("# Jean Agent: {}\n", agent.name);
    if !agent.role_prompt.trim().is_empty() {
        out.push_str(agent.role_prompt.trim());
        out.push('\n');
    }
    out.push_str(&format!(
        "\n## How you work
- You run inside Jean, not inside a project. Your working directory is only a scratch space.
- Use only the `{mcp}` MCP server tools for project work. Never use another Jean MCP server.
- When you give work to a session with `send_chat_message`, pass `executionMode` (`build` or `yolo`) unless the user wants a plan first: new sessions start in plan mode. Jean tracks the session. When that session finishes, fails, or waits for input, you get an automatic update message. Do not poll or wait in a loop: end your turn and continue when the update arrives.
- Messages that start with \"[Jean agent update]\" come from Jean, not from the user.
- Delete, permanent delete, push, merge, and pull request creation need the user's approval. The tool then returns `approvalRequired`. Tell the user what you asked for and end your turn. The result arrives as an update.
- Use `schedule_create` for later checks or repeating work, and `schedule_list` / `schedule_cancel` to manage them. Each schedule run is a separate background task.
- Use `notify_user` only for what the user must know: results of goals, questions, failures, needed decisions. Not for routine progress.
- Use `task_list` to see your background tasks and their results.
- Use `memory_save` for lasting rules, facts the code does not show, and open work. Do not save live state (project lists, PR status) or secrets. Use `memory_search` to find older memories, and `memory_update` / `memory_forget` to correct them.
- Before destructive actions, confirm with the user. Keep answers short.\n"
    ));
    match role {
        SessionRole::Chat { carry_over } => {
            out.push_str("\n## This session: chat with the user\n- The user talks with you here. Background work (schedules, follow-ups of tasks, requests from other agents) runs in separate task sessions. Use `task_list` when the user asks about it.\n");
            if let Some(text) = carry_over.as_deref().filter(|t| !t.trim().is_empty()) {
                out.push_str("\n## End of your previous chat\nThe previous chat was archived because it was long. Its end:\n");
                out.push_str(text.trim());
                out.push('\n');
            }
        }
        SessionRole::Task => out.push_str("\n## This session: background task\n- The user does not read this session. Use `notify_user` for what the user must know.\n- End each turn with a one-line summary of the result.\n"),
    }
    let others: Vec<&Agent> = peers.iter().filter(|p| p.id != agent.id).collect();
    if !others.is_empty() {
        out.push_str("\n## Other agents\nAsk them with `message_agent`; their answer arrives as an update.\n");
        for p in others {
            out.push_str(&format!("- `{}`: {} — {}\n", p.id, p.name, p.description));
        }
    }
    out.push_str("\n## Memory\n");
    if memories.is_empty() {
        out.push_str("(empty)\n");
    }
    let mut used = 0;
    for m in memories {
        let scope = if m.agent_id.is_none() { "shared " } else { "" };
        let pin = if m.pinned { ", pinned" } else { "" };
        let project = m
            .project_id
            .as_deref()
            .map(|p| format!(", project {p}"))
            .unwrap_or_default();
        let line = format!(
            "- [#{} {scope}{}{pin}{project}] {}\n",
            m.id, m.kind, m.content
        );
        if used + line.len() > PROMPT_MEMORY_CHARS {
            out.push_str("- (more memories exist: use memory_search)\n");
            break;
        }
        used += line.len();
        out.push_str(&line);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, name: &str) -> Agent {
        Agent {
            id: id.into(),
            name: name.into(),
            description: format!("{name} desc"),
            icon: "yellow".into(),
            role_prompt: format!("Role of {name}"),
            worktree_id: db::agent_worktree_id(id),
            paused: false,
            max_wakes_per_hour: 12,
            builtin: false,
        }
    }

    fn memory(id: i64, agent_id: Option<&str>, content: &str, pinned: bool) -> db::Memory {
        db::Memory {
            id,
            agent_id: agent_id.map(Into::into),
            project_id: None,
            kind: "rule".into(),
            content: content.into(),
            pinned,
            created_at: 0,
            updated_at: 0,
            expires_at: None,
        }
    }

    #[test]
    fn prompt_has_role_mcp_name_peers_and_memory() {
        let me = agent("jean", "Jean");
        let peers = vec![me.clone(), agent("reviewer", "Reviewer")];
        let mems = vec![
            memory(1, Some("jean"), "Never push orbit", true),
            memory(2, None, "Short answers", false),
        ];
        let prompt = render_system_prompt(
            &me,
            &peers,
            &mems,
            "jean",
            &SessionRole::Chat {
                carry_over: Some("User: deploy orbit".into()),
            },
        );
        assert!(prompt.contains("chat with the user"));
        assert!(prompt.contains("## End of your previous chat"));
        assert!(prompt.contains("User: deploy orbit"));
        assert!(prompt.contains("# Jean Agent: Jean"));
        assert!(prompt.contains("Role of Jean"));
        assert!(prompt.contains("Use only the `jean` MCP server"));
        assert!(prompt.contains("pass `executionMode`"));
        assert!(prompt.contains("`reviewer`: Reviewer"));
        assert!(!prompt.contains("`jean`: Jean"));
        assert!(prompt.contains("[#1 rule, pinned] Never push orbit"));
        assert!(prompt.contains("[#2 shared rule] Short answers"));
    }

    #[test]
    fn prompt_memory_respects_size_budget() {
        let me = agent("jean", "Jean");
        let big = "x".repeat(900);
        let mems: Vec<_> = (0..20)
            .map(|i| memory(i, Some("jean"), &big, false))
            .collect();
        let prompt = render_system_prompt(&me, &[], &mems, "jean-dev", &SessionRole::Task);
        assert!(prompt.contains("background task"));
        assert!(!prompt.contains("previous chat"));
        assert!(prompt.contains("more memories exist"));
        assert!(prompt.len() < PROMPT_MEMORY_CHARS + 4000);
        assert!(!prompt.contains("(empty)"));
    }
}
