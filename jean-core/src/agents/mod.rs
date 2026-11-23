//! Project coordinators: one persistent agent per project, created
//! automatically. The user chats with it; it starts work in normal worktrees
//! and sessions through the Jean MCP tools and reports back in its chat.
//! State lives in `{app_data}/agents.db` (SQLite):
//! - delegations: sessions that work for a coordinator; their results wake it
//! - events + wakes: queued updates for a coordinator, with an hourly budget
//! - schedules: one-shot, interval, cron, and event wake-ups
//! - approvals: destructive MCP tools wait for the user
//! - memories: rules, facts and open work, added to each run's prompt.
//!   Scope `user` is facts about the user. Scope `shared` is cross-project
//!   memory of all coordinators. Journal entries recall older chats.
//!
//! Coordinator sessions are normal Jean sessions under the reserved worktree
//! ID `__coord_<project_id>__` and run in the project folder.

pub mod commands;
pub mod connectors;
mod cron;
pub mod db;
mod engine;
pub mod mcp;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::AppHandle;

pub use db::{is_agent_worktree_id, Agent};
pub use engine::{nudge, start};

/// Managed state: the single agents database connection of this process.
pub struct AgentsDb(Mutex<Connection>);

/// Character budget for memory lines in a coordinator prompt. Selection is
/// pinned, then relevance to the current message, then recency.
const PROMPT_MEMORY_CHARS: usize = 8000;
/// Most worktrees and tracked sessions listed in a coordinator prompt.
const PROMPT_WORKTREES: usize = 30;
const PROMPT_DELEGATIONS: usize = 20;

/// Recap format for coordinator chats. Replaces the general
/// `RECAP_INSTRUCTION`, which is not sent to coordinator sessions.
const AGENT_RECAP_INSTRUCTION: &str = "
## Recap
- When a reply used tools or did more than one step, end it with a short recap. Do not add a `Recap` heading or any other heading; write only the recap text. Skip it for a one-line answer and for replies to updates.
- Keep the recap brief, but include every important result: what changed, what was found, what failed, what waits for approval, and links to the PRs, issues, or sessions.
- Put actions and findings in a Markdown table, one row each, for example: | # | Action | Status | Link |. The user can select rows and add notes to them, so keep one item per row and number the rows.
- Do not add test steps, diffs, or raw tool output.
- To show screenshots or images (for example from a session result), add a fenced code block with the language `screenshots`, one absolute image file path or image URL per line. Jean shows it as an image gallery.
- The last line of the recap is the next-action question.
";

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
/// The closure receives `&mut` so a caller can open a SQLite transaction.
/// The mutex already gives this process exclusive access to the connection.
pub fn with_db<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let state = app
        .try_state::<AgentsDb>()
        .ok_or_else(|| "Agents database is not available".to_string())?;
    let mut conn = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut conn)
}

/// The `agents_enabled` preference, read from disk on every call so a change
/// applies without a restart.
pub fn enabled(app: &AppHandle) -> bool {
    crate::load_preferences_sync(app).is_ok_and(|prefs| prefs.agents_enabled)
}

/// Git projects get a coordinator. Folders and managed servers do not.
fn has_coordinator(project: &crate::projects::types::Project) -> bool {
    !project.is_folder && project.server.is_none() && !project.path.is_empty()
}

/// Create the coordinator of a project, or return the existing one.
pub fn ensure_coordinator(app: &AppHandle, project_id: &str) -> Result<Agent, String> {
    let data = crate::projects::storage::load_projects_data(app)?;
    let project = data
        .find_project(project_id)
        .filter(|project| has_coordinator(project))
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    with_db(app, |conn| {
        db::ensure_coordinator(conn, &project.id, &project.name)
    })
}

/// Create the missing coordinators of all projects. Coordinators of projects
/// that are gone are left alone here: `remove_coordinator` deletes them, and
/// a project list that failed to load must not delete memory.
pub(crate) fn ensure_all_coordinators(app: &AppHandle) -> Result<(), String> {
    let data = crate::projects::storage::load_projects_data(app)?;
    with_db(app, |conn| {
        for project in data.projects.iter().filter(|p| has_coordinator(p)) {
            if let Err(e) = db::ensure_coordinator(conn, &project.id, &project.name) {
                log::warn!("[Agents] no coordinator for project {}: {e}", project.id);
            }
        }
        Ok(())
    })
}

/// A project was added: give it a coordinator when the feature is on. When it
/// is off, the coordinator is created once the feature is turned on.
pub fn on_project_added(app: &AppHandle, project_id: &str) {
    if !enabled(app) {
        return;
    }
    match ensure_coordinator(app, project_id) {
        Ok(_) => notify_changed(app),
        Err(e) => log::warn!("[Agents] no coordinator for project {project_id}: {e}"),
    }
}

/// A project was removed: stop and delete its coordinator chats, then delete
/// the coordinator with its schedules, memory and journal.
pub fn remove_coordinator(app: &AppHandle, project_id: &str) {
    use crate::chat::storage;
    let worktree_id = db::coordinator_worktree_id(project_id);
    // Loading a missing index would create one, so look at the file first.
    let index = storage::get_sessions_path(app, &worktree_id).ok();
    if let Some(index) = index.filter(|path| path.exists()) {
        crate::chat::registry::cancel_processes_for_worktree(app, &worktree_id);
        let sessions = storage::load_sessions_by_id(app, &worktree_id)
            .map(|sessions| sessions.sessions)
            .unwrap_or_default();
        for session in &sessions {
            if let Err(e) = storage::delete_session_data(app, &session.id) {
                log::warn!("[Agents] session data of {} not deleted: {e}", session.id);
            }
            storage::cleanup_combined_context_files(app, &session.id);
        }
        if let Err(e) = std::fs::remove_file(&index) {
            log::warn!("[Agents] session index of {worktree_id} not deleted: {e}");
        }
    }
    match with_db(app, |conn| db::delete_coordinator(conn, project_id)) {
        Ok(true) => notify_changed(app),
        Ok(false) => {}
        Err(e) => log::warn!("[Agents] coordinator of {project_id} not deleted: {e}"),
    }
}

/// The coordinator that owns this worktree ID.
pub fn agent_for_worktree(app: &AppHandle, worktree_id: &str) -> Option<Agent> {
    let project_id = db::project_id_from_coordinator_worktree(worktree_id)?;
    with_db(app, |conn| {
        db::get_agent(conn, &db::coordinator_id(project_id))
    })
    .ok()
    .flatten()
}

/// Message a coordinator sends to a workspace session. The UI parses the
/// first line (see `parseAgentSentMessage` in message-content-utils.ts).
pub fn agent_message_text(agent_name: &str, agent_id: &str, message: &str) -> String {
    format!("[Message from agent {agent_name} (`{agent_id}`)]\n\n{message}")
}

/// The coordinator that owns this session (the session is in its worktree).
pub fn agent_for_session(app: &AppHandle, session_id: &str) -> Option<Agent> {
    let metadata = crate::chat::storage::load_metadata(app, session_id).ok()??;
    agent_for_worktree(app, &metadata.worktree_id)
}

/// Folder of a project that has a coordinator.
fn project_path(app: &AppHandle, project_id: &str) -> Result<String, String> {
    crate::projects::storage::load_projects_data(app)?
        .find_project(project_id)
        .filter(|project| has_coordinator(project))
        .map(|project| project.path.clone())
        .ok_or_else(|| format!("Project not found: {project_id}"))
}

/// Working directory of a coordinator: its project folder.
pub fn agent_workdir(app: &AppHandle, agent: &Agent) -> Result<String, String> {
    project_path(app, &agent.project_id)
}

/// Working directory for a coordinator worktree ID (MCP path resolution).
/// `None` for every other worktree ID.
pub fn workdir_for_worktree(app: &AppHandle, worktree_id: &str) -> Option<String> {
    let project_id = db::project_id_from_coordinator_worktree(worktree_id)?;
    project_path(app, project_id).ok()
}

/// True when runs in this worktree must not change code. A coordinator
/// delegates code changes to workspace sessions, so each backend that can
/// restrict file writes does so for its chat (user messages and wake-ups).
pub fn code_is_read_only(worktree_id: &str) -> bool {
    db::project_id_from_coordinator_worktree(worktree_id).is_some()
}

/// Tell every client to refresh agent data, and run the engine now.
pub fn notify_changed(app: &AppHandle) {
    emit_cache_keys(app, &["agents"]);
    engine::nudge();
}

/// Tells every client to refresh agent data when dropped, for runs in agent
/// worktrees. Create it before the run's send claim: it then drops after the
/// claim, so the refreshed list no longer shows the agent as working.
pub struct RefreshOnDrop(Option<AppHandle>);

impl RefreshOnDrop {
    pub fn for_worktree(app: &AppHandle, worktree_id: &str) -> Self {
        Self(is_agent_worktree_id(worktree_id).then(|| app.clone()))
    }
}

impl Drop for RefreshOnDrop {
    fn drop(&mut self) {
        if let Some(app) = &self.0 {
            emit_cache_keys(app, &["agents"]);
        }
    }
}

/// The agent's chat session changed backend or model. Refresh open chats.
pub fn notify_sessions(app: &AppHandle) {
    emit_cache_keys(app, &["sessions"]);
}

fn emit_cache_keys(app: &AppHandle, keys: &[&str]) {
    use crate::http_server::EmitExt;
    if let Err(e) = app.emit_all("cache:invalidate", &serde_json::json!({ "keys": keys })) {
        log::warn!("Failed to emit cache invalidation {keys:?}: {e}");
    }
}

/// What a coordinator prompt is built from. Lists are already cut to size.
struct PromptContext<'a> {
    agent: &'a Agent,
    project_name: &'a str,
    project_path: &'a str,
    /// One line per worktree of the project.
    worktrees: &'a [String],
    /// One line per session the coordinator waits for.
    delegations: &'a [String],
    memories: &'a [db::Memory],
    memories_truncated: bool,
    /// Name of the Jean MCP server in this build.
    mcp: &'a str,
    /// End of the previous chat, after a rotation.
    carry_over: Option<&'a str>,
}

/// Lines for the first `max` items, plus a count of the rest.
fn bounded_lines(mut lines: Vec<String>, max: usize, more_hint: &str) -> Vec<String> {
    let total = lines.len();
    if total > max {
        lines.truncate(max);
        lines.push(format!("- ({} more: {more_hint})", total - max));
    }
    lines
}

fn worktree_lines(data: &crate::projects::types::ProjectsData, project_id: &str) -> Vec<String> {
    let lines = data
        .worktrees_for_project(project_id)
        .into_iter()
        .filter(|worktree| worktree.archived_at.is_none())
        .map(|worktree| {
            format!(
                "- {} (worktreeId {}, branch {})",
                worktree.name, worktree.id, worktree.branch
            )
        })
        .collect();
    bounded_lines(lines, PROMPT_WORKTREES, "use list_worktrees")
}

fn delegation_lines(
    data: &crate::projects::types::ProjectsData,
    delegations: &[db::Delegation],
) -> Vec<String> {
    let lines = delegations
        .iter()
        .filter(|delegation| matches!(delegation.status.as_str(), "active" | "waiting"))
        .map(|delegation| {
            let worktree = data
                .find_worktree(&delegation.worktree_id)
                .map_or(delegation.worktree_id.as_str(), |w| w.name.as_str());
            let state = if delegation.status == "waiting" {
                "waits for input"
            } else {
                "running"
            };
            format!(
                "- sessionId {} in {worktree}: {state}",
                delegation.session_id
            )
        })
        .collect();
    bounded_lines(lines, PROMPT_DELEGATIONS, "use list_sessions")
}

/// Extra system prompt for runs in a coordinator worktree: role, project,
/// its worktrees and running work, and memory. `None` for normal sessions.
pub fn system_prompt_for(app: &AppHandle, worktree_id: &str, hint: Option<&str>) -> Option<String> {
    let agent = agent_for_worktree(app, worktree_id)?;
    let data = crate::projects::storage::load_projects_data(app).ok()?;
    let project = data.find_project(&agent.project_id)?;
    let (memories, carry_over, delegations) = with_db(app, |conn| {
        Ok((
            db::select_prompt_memories(conn, &agent.id, hint, PROMPT_MEMORY_CHARS)?,
            db::get_carry_over(conn, &agent.id)?,
            db::list_delegations(conn, &agent.id, 200)?,
        ))
    })
    .unwrap_or_default();
    let memory_summary = if memories.entries.is_empty() {
        "(none)".to_string()
    } else {
        memories
            .entries
            .iter()
            .map(|memory| {
                format!(
                    "#{} {}{}",
                    memory.id,
                    memory.scope,
                    if memory.pinned { " pinned" } else { "" }
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    log::info!(
        "[Agents] prompt memory for {}: {memory_summary} (truncated={})",
        agent.id,
        memories.truncated
    );
    Some(render_system_prompt(&PromptContext {
        agent: &agent,
        project_name: &project.name,
        project_path: &project.path,
        worktrees: &worktree_lines(&data, &project.id),
        delegations: &delegation_lines(&data, &delegations),
        memories: &memories.entries,
        memories_truncated: memories.truncated,
        mcp: crate::jean_mcp_config::current_mode().server_name(),
        carry_over: carry_over.as_deref(),
    }))
}

fn render_system_prompt(ctx: &PromptContext) -> String {
    let PromptContext {
        agent,
        project_name,
        project_path,
        mcp,
        ..
    } = ctx;
    let project_id = &agent.project_id;
    let mut out = format!(
        "# Project Coordinator: {project_name}
You coordinate the work on the project \"{project_name}\" (projectId {project_id}) at {project_path}. The user talks with you in this chat all the time.

## How you work
- You do not change code yourself. Do not edit, create, or delete files in the project, and do not run commands that change it. You may read files to answer a question or to write a good task.
- You give the work to normal Jean sessions with the `{mcp}` MCP server tools. Never use another Jean MCP server.
- To start work: pick a worktree from the list below, or make one with `create_worktree` (projectId {project_id}). Then send the task with `send_chat_message`. Use `create_session` when the worktree needs one more session. One task per worktree, unless the tasks belong together.
- Write the task so the session can work alone: the goal, the files or issue it is about, and what done means.
- Do not pass `executionMode` on `send_chat_message`: the session then uses its selected mode or the user's default. Pass a mode only when the user asks for one.
- After each task you send, tell the user in one line what you sent and where (worktree and session).
- Jean tracks every session you send work to. When it finishes, fails, or waits for input, you get an automatic update in this chat. Do not poll or wait in a loop: end your turn and continue when the update arrives.
- Read what a session did with `read_session_messages`. Check the result before you report it or start the next step.
- Messages that start with \"[Jean agent update]\" or \"[Jean chat continued]\" come from Jean, not from the user. The user does not see them, only your reply. Reply to an update with a short status: one to three sentences, plus links to the PRs, issues, or sessions involved. Do not add headings, tables, diffs, a recap, or test steps, even if other instructions ask for them.
- Delete, push, merge, and pull request creation need the user's approval. The tool then returns `approvalRequired`. Tell the user what you asked for and end your turn. The result arrives as an update.
- Use `schedule_create` for later checks (`delayMinutes`), one run at an exact date-time (`runAt` plus `timezone`), repeating intervals (`everyMinutes`, at least 5), cron (`cron` plus `timezone`), or an event in this project (`event`: session_finished, session_failed, pr_merged, approval_resolved). Use `schedule_update`, `schedule_list`, and `schedule_cancel` to manage them. A run arrives in this chat as an update.
- Use `notify_user` only for what the user must know when they are not looking at this chat: results of goals, failures, needed decisions. Not for routine progress.
- Use `list_connectors` to see the MCP connectors saved for you and whether this backend applies that limit. It is read-only. Use `set_connector` to turn a discovered MCP server on or off; it needs the user's approval.
- Use `memory_save` for lasting rules, facts the code does not show, and open work. Do not save live state (worktree lists, PR status) or secrets. scope `user` is only for facts about the user (name, timezone, preferences). scope `shared` is for facts that hold in every project; the coordinators of the other projects see it too. Omit scope for a memory of this project.
- Use `memory_search` to pull more than the prompt shows. Filter with kind, scope, pinned, and from/to (unix seconds on updated_at). Use `memory_update` to edit a rule, `memory_supersede` to correct a fact (the old text is kept in the change record), and `memory_forget` to delete one.
- Use `journal_add` for what happened, a decision, or an outcome. Use `journal_search` to recall by text or date, including chats that were archived. Journal is history, not a lasting fact.
- Keep replies short. Before destructive actions, confirm with the user.

## This chat
- The user sees only your text, not your tool calls. When a step gives a result, write one short line about it.
- While you work, the user sees a status line. When a turn uses tools, call `set_status` in your first group of tool calls with 2 to 5 plain words about the goal (for example: \"Starting the login fix\"). Call it again only when the work moves to a new phase, not for each tool call. Do not name tools, commands, or file paths in it.
- When the user must decide between fixed choices, call `ask_user` instead of writing the question as text. Give the question and two to eight short options. Set `multiple` to true only when the user can pick more than one. Do not add a \"something else\" option: the user can always type an answer. Then end your turn. The answer arrives as the next user message.
- End each reply to the user, including replies to updates, with one short question that suggests the most useful next action (for example: \"Do you want me to open a PR for this?\"). When there is more than one good path, ask it with `ask_user` and one to three concrete options. Do not ask when the user only said thanks or ended the conversation.
"
    );
    out.push_str(AGENT_RECAP_INSTRUCTION);
    if !agent.role_prompt.trim().is_empty() {
        out.push_str("\n## Instructions from the user\n");
        out.push_str(agent.role_prompt.trim());
        out.push('\n');
    }
    out.push_str("\n## Worktrees of this project\n");
    if ctx.worktrees.is_empty() {
        out.push_str("(none)\n");
    }
    for line in ctx.worktrees {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("\n## Sessions you wait for\n");
    if ctx.delegations.is_empty() {
        out.push_str("(none)\n");
    }
    for line in ctx.delegations {
        out.push_str(line);
        out.push('\n');
    }
    if let Some(text) = ctx.carry_over.filter(|text| !text.trim().is_empty()) {
        out.push_str("\n## End of your previous chat\nThe previous chat was archived because it was long. Its end:\n");
        out.push_str(text.trim());
        out.push('\n');
    }
    if !agent.skills.is_empty() {
        out.push_str(
            "\n## Skills\nRead these skill files and follow them. The same marker is used when a skill is attached in chat.\n",
        );
        for skill in &agent.skills {
            out.push_str(&skill_instruction(&skill.path));
            out.push('\n');
        }
    }
    if let Some(section) = connectors::prompt_section(agent) {
        out.push('\n');
        out.push_str(&section);
    }
    let (user_facts, rest): (Vec<&db::Memory>, Vec<&db::Memory>) = ctx
        .memories
        .iter()
        .partition(|memory| memory.scope == "user");
    if !user_facts.is_empty() {
        out.push_str("\n## About the user\n");
        for memory in &user_facts {
            out.push_str(&db::memory_prompt_line(memory));
        }
    }
    out.push_str("\n## Memory\n");
    if rest.is_empty() {
        out.push_str("(empty)\n");
    }
    let mut used: usize = user_facts
        .iter()
        .map(|memory| db::memory_prompt_line(memory).len())
        .sum();
    let mut truncated = ctx.memories_truncated;
    for memory in rest {
        let line = db::memory_prompt_line(memory);
        if used + line.len() > PROMPT_MEMORY_CHARS {
            truncated = true;
            break;
        }
        used += line.len();
        out.push_str(&line);
    }
    if truncated {
        out.push_str("- (more memories exist: use memory_search)\n");
    }
    out
}

/// Marker Jean already uses when a skill is attached to a chat message.
/// OpenCode inlines the file from this marker; other backends are told to read it.
pub fn skill_instruction(path: &str) -> String {
    format!("[Skill: {path} - Read and use this skill to guide your response]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coordinator() -> Agent {
        Agent {
            id: "coord_p1".into(),
            project_id: "p1".into(),
            name: "Orbit".into(),
            description: String::new(),
            icon: "jean".into(),
            role_prompt: String::new(),
            worktree_id: "__coord_p1__".into(),
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
            scope: if agent_id.is_none() {
                "shared".into()
            } else {
                "agent".into()
            },
            superseded_by: None,
            superseded_at: None,
        }
    }

    fn render(agent: &Agent, memories: &[db::Memory], carry_over: Option<&str>) -> String {
        render_system_prompt(&PromptContext {
            agent,
            project_name: "Orbit",
            project_path: "/repos/orbit",
            worktrees: &["- fix-login (worktreeId wt-1, branch fix-login)".to_string()],
            delegations: &["- sessionId s-1 in fix-login: running".to_string()],
            memories,
            memories_truncated: false,
            mcp: "jean",
            carry_over,
        })
    }

    #[test]
    fn prompt_has_the_coordinator_role_project_and_running_work() {
        let mems = vec![
            memory(1, Some("coord_p1"), "Never push orbit", true),
            memory(2, None, "Short answers", false),
        ];
        let prompt = render(&coordinator(), &mems, Some("User: deploy orbit"));
        assert!(prompt.starts_with("# Project Coordinator: Orbit\n"));
        assert!(prompt.contains("the project \"Orbit\" (projectId p1) at /repos/orbit"));
        assert!(prompt.contains("You do not change code yourself."));
        assert!(prompt.contains("make one with `create_worktree` (projectId p1)"));
        assert!(prompt.contains("send the task with `send_chat_message`"));
        assert!(prompt.contains("`read_session_messages`"));
        assert!(prompt.contains("tell the user in one line what you sent and where"));
        assert!(prompt.contains("with the `jean` MCP server tools"));
        assert!(prompt.contains("Do not pass `executionMode`"));
        assert!(prompt.contains(
            "## Worktrees of this project\n- fix-login (worktreeId wt-1, branch fix-login)\n"
        ));
        assert!(
            prompt.contains("## Sessions you wait for\n- sessionId s-1 in fix-login: running\n")
        );
        assert!(prompt.contains("call `set_status`"));
        assert!(prompt.contains("| # | Action | Status | Link |"));
        assert!(prompt.contains("## End of your previous chat"));
        assert!(prompt.contains("User: deploy orbit"));
        assert!(prompt.contains("[#1 rule, pinned] Never push orbit"));
        assert!(prompt.contains("[#2 shared rule] Short answers"));
        for removed in [
            "task session",
            "background task",
            "task_list",
            "Mentioned agent",
            "scratch",
            "## Skills",
            "## Instructions from the user",
        ] {
            assert!(!prompt.contains(removed), "{removed}");
        }
    }

    #[test]
    fn prompt_lists_selected_skills_with_the_chat_marker() {
        let mut me = coordinator();
        me.role_prompt = "Always answer in Hungarian".into();
        me.skills.push(db::AgentSkill {
            name: "review".into(),
            path: "/skills/review/SKILL.md".into(),
            backend: Some("codex".into()),
        });
        let prompt = render(&me, &[], None);
        assert!(prompt.contains(
            "## Skills\nRead these skill files and follow them. The same marker is used when a skill is attached in chat.\n[Skill: /skills/review/SKILL.md - Read and use this skill to guide your response]\n"
        ));
        assert!(prompt.contains("## Instructions from the user\nAlways answer in Hungarian\n"));
        assert!(!prompt.contains("previous chat was archived"));
    }

    #[test]
    fn prompt_memory_respects_size_budget() {
        let me = coordinator();
        let big = "x".repeat(900);
        let mems: Vec<_> = (0..20)
            .map(|i| memory(i, Some("coord_p1"), &big, false))
            .collect();
        let prompt = render(&me, &mems, None);
        assert!(prompt.contains("more memories exist"));
        let without_memories = render(&me, &[], None);
        assert!(without_memories.contains("## Memory\n(empty)\n"));
        assert!(prompt.len() <= without_memories.len() + PROMPT_MEMORY_CHARS + 100);
        assert!(!prompt.contains("(empty)"));
    }

    const PROJECT: &str = "550e8400-e29b-41d4-a716-446655440000";
    const COORD: &str = "coord_550e8400-e29b-41d4-a716-446655440000";
    const COORD_WORKTREE: &str = "__coord_550e8400-e29b-41d4-a716-446655440000__";

    /// An app with one git project, one folder, one worktree, and an open
    /// agents database.
    fn app_with_project() -> (tempfile::TempDir, AppHandle, String) {
        let temp = tempfile::tempdir().unwrap();
        let app = AppHandle::new(temp.path().join("data"), temp.path().join("data")).unwrap();
        let repo = temp.path().join("orbit").to_string_lossy().into_owned();
        let data = serde_json::from_value(serde_json::json!({
            "projects": [
                { "id": PROJECT, "name": "Orbit", "path": repo, "default_branch": "main", "added_at": 1 },
                { "id": "folder-1", "name": "Work", "path": "", "default_branch": "", "added_at": 1, "is_folder": true },
            ],
            "worktrees": [
                { "id": "wt-1", "project_id": PROJECT, "name": "fix-login", "path": "/wt/fix-login", "branch": "fix-login", "created_at": 1 },
            ],
        }))
        .unwrap();
        crate::projects::storage::save_projects_data(&app, &data).unwrap();
        init(&app).unwrap();
        (temp, app, repo)
    }

    fn coordinator_ids(app: &AppHandle) -> Vec<String> {
        with_db(app, |conn| db::list_agents(conn))
            .unwrap()
            .into_iter()
            .map(|agent| agent.id)
            .collect()
    }

    #[test]
    fn every_git_project_gets_one_coordinator_in_its_folder() {
        let (_temp, app, repo) = app_with_project();
        assert_eq!(coordinator_ids(&app), Vec::<String>::new());
        ensure_all_coordinators(&app).unwrap();
        ensure_all_coordinators(&app).unwrap();
        let again = ensure_coordinator(&app, PROJECT).unwrap();
        assert_eq!(again.id, COORD);
        assert_eq!(again.worktree_id, COORD_WORKTREE);
        assert_eq!(again.name, "Orbit");
        assert_eq!(coordinator_ids(&app), vec![COORD]);
        assert_eq!(
            ensure_coordinator(&app, "folder-1").unwrap_err(),
            "Project not found: folder-1"
        );

        assert_eq!(agent_for_worktree(&app, COORD_WORKTREE).unwrap().id, COORD);
        assert_eq!(
            workdir_for_worktree(&app, COORD_WORKTREE),
            Some(repo.clone())
        );
        assert_eq!(agent_workdir(&app, &again).unwrap(), repo);
        // Normal worktrees and the old agent worktrees belong to no coordinator
        for other in [
            "wt-1",
            "__jean_agent__",
            "__agent_reviewer__",
            "__coord_gone__",
        ] {
            assert_eq!(agent_for_worktree(&app, other), None, "{other}");
            assert_eq!(workdir_for_worktree(&app, other), None, "{other}");
        }
    }

    #[tokio::test]
    async fn project_coordinator_command_creates_the_coordinator_and_one_chat() {
        let (_temp, app, repo) = app_with_project();
        let first = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap();
        let second = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(first.agent_id, COORD);
        assert_eq!(first.worktree_id, COORD_WORKTREE);
        assert_eq!(first.worktree_path, repo);
        assert_eq!(first.backend, None);
        let sessions = crate::chat::storage::load_sessions_by_id(&app, COORD_WORKTREE).unwrap();
        assert_eq!(sessions.sessions.len(), 1);
        assert_eq!(sessions.sessions[0].id, first.chat_session_id);
        assert_eq!(
            agent_for_session(&app, &first.chat_session_id).unwrap().id,
            COORD
        );
        assert_eq!(
            commands::get_project_coordinator(&app, "folder-1")
                .await
                .unwrap_err(),
            "Project not found: folder-1"
        );

        // The user closed the chat: the coordinator gets a new one
        crate::chat::close_session(
            app.clone(),
            COORD_WORKTREE.to_string(),
            repo.clone(),
            first.chat_session_id.clone(),
        )
        .await
        .unwrap();
        let third = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap();
        assert_ne!(third.chat_session_id, first.chat_session_id);
        let fourth = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap();
        assert_eq!(fourth, third);
    }

    #[tokio::test]
    async fn a_due_schedule_wakes_the_coordinator_chat_within_the_budget() {
        let (_temp, app, _repo) = app_with_project();
        let chat = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap()
            .chat_session_id;
        with_db(&app, |conn| {
            db::create_schedule(conn, COORD, "brief", "Check the open PRs", 100, None)?;
            db::fire_due_schedules(conn, 150)
        })
        .unwrap();

        let delivery = engine::next_delivery(&app, COORD).await.unwrap().unwrap();
        assert_eq!(delivery.chat.id, chat);
        assert_eq!(delivery.agent.worktree_id, COORD_WORKTREE);
        assert!(delivery.message.starts_with("[Jean agent update]"));
        assert!(delivery
            .message
            .contains("### 1. schedule\nSchedule #1 \"brief\" is due.\n\nCheck the open PRs\n"));
        let (pending, wakes) = with_db(&app, |conn| {
            Ok((
                db::pending_event_count(conn, COORD)?,
                db::wakes_since(conn, COORD, 0)?,
            ))
        })
        .unwrap();
        assert_eq!((pending, wakes), (0, 1));
        assert!(engine::next_delivery(&app, COORD).await.unwrap().is_none());
        // Only the chat exists: no session was made for the run
        let sessions = crate::chat::storage::load_sessions_by_id(&app, COORD_WORKTREE).unwrap();
        assert_eq!(sessions.sessions.len(), 1);

        // A spent budget keeps the next update queued
        with_db(&app, |conn| {
            for _ in 0..11 {
                db::record_wake(conn, COORD, &chat)?;
            }
            db::add_event(
                conn,
                &db::NewEvent {
                    agent_id: COORD,
                    kind: "delegation",
                    body: "Session s-1 finished.",
                    ..Default::default()
                },
            )
        })
        .unwrap();
        assert!(engine::next_delivery(&app, COORD).await.unwrap().is_none());
        assert_eq!(
            with_db(&app, |conn| db::pending_event_count(conn, COORD)).unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn an_update_is_queued_again_when_the_chat_took_another_message_first() {
        let _registry = crate::chat::registry::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (_temp, app, _repo) = app_with_project();
        let chat = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap()
            .chat_session_id;
        with_db(&app, |conn| {
            db::add_event(
                conn,
                &db::NewEvent {
                    agent_id: COORD,
                    kind: "delegation",
                    body: "Session s-1 finished.",
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let pending = |app: &AppHandle| {
            with_db(app, |conn| db::pending_events(conn, COORD))
                .unwrap()
                .into_iter()
                .map(|event| event.body)
                .collect::<Vec<_>>()
        };

        let delivery = engine::next_delivery(&app, COORD).await.unwrap().unwrap();
        let message = delivery.message.clone();
        assert_eq!(pending(&app), Vec::<String>::new());

        // The user's message takes the chat between the tick and the wake
        let user_send = crate::chat::registry::SendClaim::try_acquire(&chat).unwrap();
        assert!(!engine::send_delivery(&app, delivery).await);
        assert_eq!(pending(&app), ["Session s-1 finished."]);
        assert!(engine::next_delivery(&app, COORD).await.unwrap().is_none());

        // The user's turn ended: the same update is delivered
        drop(user_send);
        let again = engine::next_delivery(&app, COORD).await.unwrap().unwrap();
        assert_eq!(again.message, message);
        assert_eq!(again.event_ids, [1]);
    }

    #[tokio::test]
    async fn listing_coordinators_loads_and_creates_no_chat() {
        let (_temp, app, _repo) = app_with_project();
        ensure_coordinator(&app, PROJECT).unwrap();
        with_db(&app, |conn| {
            db::add_event(
                conn,
                &db::NewEvent {
                    agent_id: COORD,
                    kind: "delegation",
                    body: "Session s-1 finished.",
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let index = crate::chat::storage::get_index_path(&app, COORD_WORKTREE).unwrap();

        let listed = commands::list_agents(&app).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].agent.id, COORD);
        assert_eq!(listed[0].agent.project_id, PROJECT);
        assert_eq!(listed[0].agent.name, "Orbit");
        assert_eq!(listed[0].status, "idle");
        assert_eq!(listed[0].home_session_id, None);
        assert_eq!(
            (listed[0].pending_updates, listed[0].pending_approvals),
            (1, 0)
        );
        assert!(!index.exists());

        // The project view opened the chat: the list names it
        let chat = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap()
            .chat_session_id;
        let listed = commands::list_agents(&app).unwrap();
        assert_eq!(listed[0].home_session_id, Some(chat));
    }

    #[tokio::test]
    async fn project_settings_apply_to_the_coordinator_chat() {
        let (_temp, app, _repo) = app_with_project();
        let mut data = crate::projects::storage::load_projects_data(&app).unwrap();
        let project = data.find_project_mut(PROJECT).unwrap();
        project.custom_system_prompt = Some("Use British English.".to_string());
        project.default_backend = Some("codex".to_string());
        project.enabled_mcp_servers = Some(vec!["claude:sentry".to_string()]);
        crate::projects::storage::save_projects_data(&app, &data).unwrap();

        let data = crate::projects::storage::load_projects_data(&app).unwrap();
        let owner = |worktree_id: &str| {
            data.project_for_worktree(worktree_id)
                .map(|project| (project.id.as_str(), project.custom_system_prompt.as_deref()))
        };
        assert_eq!(
            owner(COORD_WORKTREE),
            Some((PROJECT, Some("Use British English.")))
        );
        assert_eq!(owner("__coord_gone__"), None);
        assert_eq!(owner("__jean_agent__"), None);
        // A real worktree still resolves through its record
        let with_worktree: crate::projects::types::ProjectsData =
            serde_json::from_value(serde_json::json!({
                "projects": [
                    { "id": "p-2", "name": "Other", "path": "/other", "default_branch": "main", "added_at": 1 },
                ],
                "worktrees": [
                    { "id": "wt-1", "project_id": "p-2", "name": "fix-login", "path": "/wt/fix-login", "branch": "fix-login", "created_at": 1 },
                ],
            }))
            .unwrap();
        assert_eq!(
            with_worktree
                .project_for_worktree("wt-1")
                .map(|project| project.id.as_str()),
            Some("p-2")
        );
        assert_eq!(
            crate::chat::resolve_default_backend(&app, Some(COORD_WORKTREE)),
            crate::chat::types::Backend::Codex
        );

        // A wake-up uses the project's MCP servers until the chat has its own choice
        let chat = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap()
            .chat_session_id;
        assert_eq!(
            connectors::project_enabled_servers(&app, &chat, PROJECT),
            ["claude:sentry"]
        );
        // The chat starts on the project's backend, not the global one
        let sessions = crate::chat::storage::load_sessions_by_id(&app, COORD_WORKTREE).unwrap();
        assert_eq!(
            sessions.sessions[0].backend,
            crate::chat::types::Backend::Codex
        );
    }

    #[tokio::test]
    async fn coordinator_tools_are_listed_only_for_the_coordinator_chat() {
        let (_temp, app, _repo) = app_with_project();
        let chat = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap()
            .chat_session_id;
        let normal = crate::chat::types::SessionMetadata::new(
            "normal-session".to_string(),
            "wt-1".to_string(),
            "Session".to_string(),
            0,
        );
        crate::chat::storage::save_metadata(&app, &normal).unwrap();
        let names = |source: &str| -> Vec<String> {
            crate::jean_mcp_core::tools_list_for_source(&app, source)["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["name"].as_str().unwrap().to_string())
                .collect()
        };
        let coordinator_only = [
            "schedule_create",
            "schedule_update",
            "schedule_list",
            "schedule_cancel",
            "memory_save",
            "memory_search",
            "memory_update",
            "memory_forget",
            "memory_supersede",
            "journal_add",
            "journal_search",
            "notify_user",
            "set_status",
            "ask_user",
            "list_connectors",
        ];
        let for_chat = names(&chat);
        let for_normal = names("normal-session");
        for tool in coordinator_only {
            assert!(for_chat.iter().any(|name| name == tool), "{tool}");
            assert!(!for_normal.iter().any(|name| name == tool), "{tool}");
        }
        for tool in ["set_connector", "create_worktree", "send_chat_message"] {
            assert!(for_chat.iter().any(|name| name == tool), "{tool}");
            assert!(for_normal.iter().any(|name| name == tool), "{tool}");
        }
        assert_eq!(for_chat.len(), for_normal.len() + coordinator_only.len());
        assert_eq!(names("anon"), for_normal);
        assert!(!for_chat.iter().any(|name| name == "task_list"));
    }

    #[tokio::test]
    async fn removing_a_project_removes_its_coordinator_and_chats() {
        let (_temp, app, _repo) = app_with_project();
        let chat = commands::get_project_coordinator(&app, PROJECT)
            .await
            .unwrap()
            .chat_session_id;
        with_db(&app, |conn| {
            db::create_schedule(conn, COORD, "brief", "Check the open PRs", 100, None)
        })
        .unwrap();
        let index = crate::chat::storage::get_sessions_path(&app, COORD_WORKTREE).unwrap();
        assert!(index.exists());

        remove_coordinator(&app, PROJECT);
        remove_coordinator(&app, PROJECT);
        assert_eq!(coordinator_ids(&app), Vec::<String>::new());
        assert!(!index.exists());
        assert_eq!(agent_for_session(&app, &chat), None);
        assert_eq!(
            with_db(&app, |conn| db::list_schedules(conn, COORD)).unwrap(),
            vec![]
        );
    }

    #[test]
    fn prompt_lists_are_cut_with_a_count_of_the_rest() {
        let lines: Vec<String> = (0..5).map(|i| format!("- wt-{i}")).collect();
        assert_eq!(
            bounded_lines(lines.clone(), 3, "use list_worktrees"),
            vec![
                "- wt-0",
                "- wt-1",
                "- wt-2",
                "- (2 more: use list_worktrees)"
            ]
        );
        assert_eq!(bounded_lines(lines.clone(), 5, "x"), lines);
    }
}
