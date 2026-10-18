//! Spawn a task session from an agent-defined subagent type.
//!
//! The session is a normal agent task. Its result returns through the same
//! delegation update as other delegated work (`[Jean agent update]`).

use tauri::AppHandle;

use super::db;
use super::engine::{self, MAX_AGENT_HOPS};

/// First message of a subagent task. The role text is stored on the task and
/// repeated here so the session transcript carries the type's instructions.
pub fn subagent_task_message(resolved: &db::ResolvedSubagentRun, task: &str) -> String {
    let mut message = format!("[Subagent: {}]\n", resolved.type_name);
    if !resolved.instructions.trim().is_empty() {
        message.push_str("Role instructions:\n");
        message.push_str(resolved.instructions.trim());
        message.push_str("\n\n");
    }
    message.push_str("Task:\n");
    message.push_str(task.trim());
    message.push_str(
        "\n\nFinish with a one-line result. Jean sends that result back to the session that spawned you. Do not spawn subagents or define subagent types.",
    );
    message
}

fn overlay_agent(agent: &db::Agent, resolved: &db::ResolvedSubagentRun) -> db::Agent {
    let mut overlay = agent.clone();
    overlay.backend = resolved.backend.clone();
    overlay.model = resolved.model.clone();
    overlay.effort = resolved.effort.clone();
    overlay.thinking_level = resolved.thinking_level.clone();
    overlay.skills = resolved.skills.clone();
    if !resolved.instructions.trim().is_empty() {
        overlay.role_prompt = resolved.instructions.clone();
    }
    overlay
}

/// Create a subagent task for `agent_id` and wake it. `origin_session_id`
/// receives the result. When it is missing, the result goes to the agent's chat.
pub async fn spawn_subagent(
    app: &AppHandle,
    agent_id: &str,
    type_name: &str,
    task: &str,
    origin_session_id: Option<&str>,
) -> Result<db::Task, String> {
    let task = task.trim();
    if task.is_empty() {
        return Err("Task cannot be empty".to_string());
    }
    if task.chars().count() > 8000 {
        return Err("Task is longer than 8000 characters".to_string());
    }
    let agent = super::with_db(app, |conn| {
        db::get_agent(conn, agent_id)?.ok_or_else(|| format!("Agent not found: {agent_id}"))
    })?;
    if agent.paused {
        return Err("This agent is stopped. Resume it before spawning a subagent.".to_string());
    }
    let kind = super::with_db(app, |conn| {
        db::find_subagent_type(conn, agent_id, type_name)?
            .ok_or_else(|| format!("Unknown subagent type: {type_name}"))
    })?;
    let resolved = db::resolve_subagent_run(&agent, &kind);

    let origin = match origin_session_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => id.to_string(),
        None => engine::home_session(app, &agent).await?.0.id,
    };
    let (caller_depth, caller_hop, running, wakes_remaining) = super::with_db(app, |conn| {
        Ok((
            db::spawn_depth_for_session(conn, &origin)?,
            db::active_hop_for_session(conn, &origin)?,
            db::running_task_count(conn, agent_id)?,
            db::wake_budget_remaining(conn, agent_id, agent.max_wakes_per_hour, db::now())?,
        ))
    })?;
    if let Some(reason) = db::subagent_spawn_block_reason(db::SubagentSpawnLimits {
        caller_depth,
        caller_hop,
        running_tasks: running,
        wakes_remaining,
        max_hops: MAX_AGENT_HOPS,
    }) {
        return Err(reason);
    }

    let overlay = overlay_agent(&agent, &resolved);
    let worktree_id = db::agent_tasks_worktree_id(&agent.id);
    let path = super::agent_workdir(app, &agent.id)?;
    let title = format!("{}: {}", resolved.type_name, engine::truncate(task, 80));
    let mut session = engine::open_agent_session(
        app,
        &overlay,
        &worktree_id,
        &path,
        Some(engine::truncate(&title, 60)),
    )
    .await?;
    let spawn_depth = caller_depth + 1;
    let prepared = async {
        if let Some(mode) = resolved.permission_mode.as_deref() {
            let mode = if mode == "build" && resolved.backend.as_deref() == Some("cursor") {
                "yolo"
            } else {
                mode
            };
            if session.selected_execution_mode.as_deref() != Some(mode) {
                crate::chat::set_session_execution_mode(
                    app.clone(),
                    worktree_id.clone(),
                    path.clone(),
                    session.id.clone(),
                    mode.to_string(),
                )
                .await?;
                session.selected_execution_mode = Some(mode.to_string());
            }
        }
        super::with_db(app, |conn| {
            let running_now = db::running_task_count(conn, agent_id)?;
            let wakes_now =
                db::wake_budget_remaining(conn, agent_id, agent.max_wakes_per_hour, db::now())?;
            if let Some(reason) = db::subagent_spawn_block_reason(db::SubagentSpawnLimits {
                caller_depth,
                caller_hop,
                running_tasks: running_now,
                wakes_remaining: wakes_now,
                max_hops: MAX_AGENT_HOPS,
            }) {
                return Err(reason);
            }
            let created = db::create_subagent_task(
                conn,
                &agent.id,
                &session.id,
                &title,
                &resolved,
                spawn_depth,
            )?;
            db::upsert_delegation(
                conn,
                &agent.id,
                &session.id,
                &worktree_id,
                caller_hop + 1,
                Some(&origin),
            )?;
            db::record_wake(conn, &agent.id, &session.id)?;
            Ok(created)
        })
    }
    .await;
    // The session exists before the final checks. Remove it when the spawn is
    // refused, or it stays in the tasks worktree with no task row.
    let stored = match prepared {
        Ok(stored) => stored,
        Err(error) => {
            if let Err(close) = crate::chat::close_session(
                app.clone(),
                worktree_id.clone(),
                path.clone(),
                session.id.clone(),
            )
            .await
            {
                log::warn!(
                    "[Agents] unused subagent session {} was not removed: {close}",
                    session.id
                );
            }
            return Err(error);
        }
    };

    log::info!(
        "[Agents] subagent session {} type={} backend={} model={} effort={} thinking={} permission={} tool_mode={} depth={} instructions={}",
        session.id,
        resolved.type_name,
        resolved.backend.as_deref().unwrap_or(""),
        resolved.model.as_deref().unwrap_or(""),
        resolved.effort.as_deref().unwrap_or(""),
        resolved.thinking_level.as_deref().unwrap_or(""),
        resolved.permission_mode.as_deref().unwrap_or(""),
        resolved.tool_mode.as_deref().unwrap_or(""),
        spawn_depth,
        resolved.instructions
    );
    engine::send_to_session(
        app,
        &overlay,
        &session,
        &worktree_id,
        &path,
        subagent_task_message(&resolved, task),
        resolved.permission_mode.as_deref(),
    );
    super::notify_changed(app);
    super::notify_sessions(app);
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::db::{Agent, AgentSkill, ResolvedSubagentRun};

    fn resolved() -> ResolvedSubagentRun {
        ResolvedSubagentRun {
            type_id: 3,
            type_name: "Investigator".into(),
            description: "reads".into(),
            instructions: "Report facts only.".into(),
            backend: Some("codex".into()),
            model: Some("gpt-5.5".into()),
            effort: Some("high".into()),
            thinking_level: None,
            skills: vec![AgentSkill {
                name: "diff".into(),
                path: "/skills/diff/SKILL.md".into(),
                backend: Some("codex".into()),
            }],
            permission_mode: Some("plan".into()),
            tool_mode: Some("read_only".into()),
        }
    }

    #[test]
    fn task_message_carries_the_type_instructions() {
        let message = subagent_task_message(&resolved(), "  Check the auth diff.  ");
        assert!(message.starts_with("[Subagent: Investigator]"));
        assert!(message.contains("Role instructions:\nReport facts only."));
        assert!(message.contains("Task:\nCheck the auth diff."));
        assert!(message.contains("Do not spawn subagents"));
    }

    #[test]
    fn overlay_uses_resolved_backend_model_and_instructions() {
        let parent = Agent {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            description: String::new(),
            icon: "blue".into(),
            role_prompt: "Be thorough".into(),
            worktree_id: "__agent_reviewer__".into(),
            paused: false,
            max_wakes_per_hour: 12,
            builtin: false,
            backend: Some("claude".into()),
            model: Some("claude-sonnet".into()),
            effort: Some("low".into()),
            thinking_level: Some("think".into()),
            skills: Vec::new(),
            mcp_servers: None,
            jean_tools: None,
        };
        let overlay = overlay_agent(&parent, &resolved());
        assert_eq!(overlay.backend.as_deref(), Some("codex"));
        assert_eq!(overlay.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(overlay.effort.as_deref(), Some("high"));
        assert_eq!(overlay.role_prompt, "Report facts only.");
        assert_eq!(overlay.skills.len(), 1);
        assert_eq!(overlay.id, "reviewer");
    }
}
