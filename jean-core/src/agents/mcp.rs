//! Jean MCP tools for agents (schedules, memory, agent messages), the
//! approval gate for destructive tools, and delegation tracking.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::db;
use super::engine::MAX_AGENT_HOPS;

/// Tools an agent may only run after the user approves.
pub const APPROVAL_TOOLS: &[&str] = &[
    "delete_worktree",
    "permanently_delete_worktree",
    "push_worktree",
    "merge_pull_request",
    "create_pull_request",
    "remove_project",
];

const AGENT_TOOLS: &[&str] = &[
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
    "message_agent",
    "notify_user",
    "task_list",
    "list_connectors",
    "agent_list",
    "agent_create",
    "agent_update",
    "agent_delete",
    "agent_revert",
];

/// Subagent type tools. Kept separate so later rebases can move this block.
const SUBAGENT_TOOLS: &[&str] = &[
    "subagent_type_list",
    "subagent_type_save",
    "subagent_type_delete",
    "spawn_subagent",
];

/// Tools a `read_only` subagent may call. Everything else is refused.
const READ_ONLY_SUBAGENT_TOOLS: &[&str] = &[
    "list_projects",
    "list_worktrees",
    "get_worktree",
    "get_project_context",
    "list_github_issues",
    "list_github_prs",
    "list_security_issues",
    "list_security_advisories",
    "list_linear_issues",
    "list_archived_worktrees",
    "get_current_context",
    "task_list",
    "schedule_list",
    "memory_search",
    "subagent_type_list",
    "notify_user",
    "list_connectors",
];
/// Source used when the user already approved a tool and it is run again.
pub const APPROVED_REPLAY_SOURCE: &str = "agent-approval";

const MIN_EVERY_MINUTES: i64 = 5;
const MAX_MINUTES: i64 = 60 * 24 * 30;

pub fn is_agent_tool(name: &str) -> bool {
    AGENT_TOOLS.contains(&name) || SUBAGENT_TOOLS.contains(&name)
}

/// MCP definitions for subagent types. Appended after the other agent tools.
pub fn subagent_tool_definitions() -> Value {
    json!([
        {"name":"subagent_type_list","description":"Agent sessions only. List subagent types you can spawn: your own, then shared types. A subagent session cannot define types.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"subagent_type_save","description":"Agent sessions only. Create or update a subagent type: name, description, instructions, and optional backend, model, effort, thinkingLevel, skills, permissionMode (plan, build, yolo), and toolMode (read_only). Only the user can set yolo, or a Cursor backend without plan. Pass id to update. shared true makes it available to every agent. Subagent sessions cannot call this.","inputSchema":{"type":"object","properties":{"id":{"type":"integer"},"name":{"type":"string"},"description":{"type":"string"},"instructions":{"type":"string"},"shared":{"type":"boolean"},"backend":{"type":"string"},"model":{"type":"string"},"effort":{"type":"string"},"thinkingLevel":{"type":"string"},"skills":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"path":{"type":"string"},"backend":{"type":"string"}},"required":["path"]}},"permissionMode":{"type":"string","enum":["plan","build","yolo"]},"toolMode":{"type":"string","enum":["read_only"]}},"required":["name"],"additionalProperties":false}},
        {"name":"subagent_type_delete","description":"Agent sessions only. Delete one of your subagent types, or a shared type, by id. Subagent sessions cannot call this.","inputSchema":{"type":"object","properties":{"id":{"type":"integer"}},"required":["id"],"additionalProperties":false}},
        {"name":"spawn_subagent","description":"Agent sessions only. Spawn one subagent of a defined type to do a task. The result arrives as an update message; end your turn after spawning. Respects the running-task cap, hourly wake budget, hop limit, and spawn depth. A subagent cannot spawn another.","inputSchema":{"type":"object","properties":{"type":{"type":"string"},"task":{"type":"string"}},"required":["type","task"],"additionalProperties":false}}
    ])
}

/// Refuse a tool when the calling session is a read-only subagent.
/// `None` means the call may continue (the approval gate still applies).
pub fn subagent_tool_block(app: &AppHandle, name: &str, source: &str) -> Option<String> {
    if READ_ONLY_SUBAGENT_TOOLS.contains(&name) {
        return None;
    }
    let task = super::with_db(app, |conn| db::task_by_session(conn, source)).ok()??;
    read_only_subagent_block(
        task.subagent_tool_mode.as_deref(),
        task.subagent_type_name.as_deref().unwrap_or("subagent"),
        name,
    )
}

pub(crate) fn read_only_subagent_block(
    tool_mode: Option<&str>,
    type_name: &str,
    tool: &str,
) -> Option<String> {
    if tool_mode != Some("read_only") || READ_ONLY_SUBAGENT_TOOLS.contains(&tool) {
        return None;
    }
    Some(format!(
        "{tool} is not available to the read-only subagent \"{type_name}\"."
    ))
}

fn refuse_subagent_admin(app: &AppHandle, source: &str) -> Result<(), String> {
    let depth = super::with_db(app, |conn| db::spawn_depth_for_session(conn, source))?;
    if let Some(reason) = db::subagent_define_block_reason(depth) {
        return Err(reason);
    }
    Ok(())
}

/// Cursor has no Build mode, so anything but Plan runs as Yolo there.
fn runs_as_yolo(permission_mode: Option<&str>, backend: Option<&str>) -> bool {
    match permission_mode {
        Some("plan") => false,
        Some("yolo") => true,
        _ => backend == Some("cursor"),
    }
}

/// An agent cannot give a subagent more permission than the user gave it.
/// Yolo is allowed only when the agent already wakes as Yolo or the user set
/// it on this type.
pub(crate) fn yolo_grant_block(
    agent: &db::Agent,
    existing: Option<&db::SubagentType>,
    write: &db::SubagentTypeWrite,
) -> Option<String> {
    let permission = write
        .permission_mode
        .as_deref()
        .map(|mode| mode.trim().to_ascii_lowercase())
        .filter(|mode| !mode.is_empty());
    let backend = db::normalize_agent_backend(write.backend.as_deref())
        .ok()
        .flatten()
        .or_else(|| agent.backend.clone());
    if !runs_as_yolo(permission.as_deref(), backend.as_deref())
        || runs_as_yolo(None, agent.backend.as_deref())
    {
        return None;
    }
    let already = existing.is_some_and(|kind| {
        runs_as_yolo(
            kind.permission_mode.as_deref(),
            kind.backend.as_deref().or(agent.backend.as_deref()),
        )
    });
    if already {
        return None;
    }
    Some(
        "Only the user can let a subagent type run as Yolo (permissionMode yolo, or a Cursor backend without plan). Use plan or build, or ask the user to set it on the Subagents tab."
            .to_string(),
    )
}

fn subagent_type_write(args: &Value) -> Result<db::SubagentTypeWrite, String> {
    let skills = match args.get("skills") {
        None | Some(Value::Null) => Vec::new(),
        Some(value) => serde_json::from_value::<Vec<db::AgentSkill>>(value.clone())
            .map_err(|error| format!("Invalid skills: {error}"))?,
    };
    Ok(db::SubagentTypeWrite {
        id: int_arg(args, "id"),
        shared: args.get("shared").and_then(Value::as_bool).unwrap_or(false),
        name: required_str(args, "name")?,
        description: str_arg(args, "description").unwrap_or_default(),
        instructions: str_arg(args, "instructions").unwrap_or_default(),
        backend: str_arg(args, "backend"),
        model: str_arg(args, "model"),
        effort: str_arg(args, "effort"),
        thinking_level: str_arg(args, "thinkingLevel").or_else(|| str_arg(args, "thinking_level")),
        skills,
        permission_mode: str_arg(args, "permissionMode")
            .or_else(|| str_arg(args, "permission_mode")),
        tool_mode: str_arg(args, "toolMode").or_else(|| str_arg(args, "tool_mode")),
    })
}

/// MCP definitions of the agent tools (appended to the Jean tool registry).
pub fn tool_definitions() -> Value {
    let mut tools = base_tool_definitions()
        .as_array()
        .cloned()
        .unwrap_or_default();
    for extra in [
        self_management_tool_definitions(),
        subagent_tool_definitions(),
    ] {
        if let Some(extra) = extra.as_array() {
            tools.extend(extra.iter().cloned());
        }
    }
    Value::Array(tools)
}

fn base_tool_definitions() -> Value {
    json!([
        {"name":"schedule_create","description":"Agent sessions only. Wake yourself later with a prompt. Choose one: delayMinutes (once), runAt (once at an exact date-time: YYYY-MM-DDTHH:MM local time in timezone, or RFC 3339 with an offset), everyMinutes (repeating, min 5), cron (5 fields) plus timezone, or event (session_finished, session_failed, worktree_archived, pr_merged, approval_resolved). The run is a background task.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"prompt":{"type":"string"},"delayMinutes":{"type":"number","minimum":1},"runAt":{"type":"string"},"everyMinutes":{"type":"number","minimum":5},"cron":{"type":"string"},"timezone":{"type":"string"},"event":{"type":"string","enum":["session_finished","session_failed","worktree_archived","pr_merged","approval_resolved"]}},"required":["name","prompt"],"additionalProperties":false}},
        {"name":"schedule_update","description":"Agent sessions only. Change one of your schedules: name, prompt, paused, or its timing (the same fields as schedule_create).","inputSchema":{"type":"object","properties":{"scheduleId":{"type":"integer"},"name":{"type":"string"},"prompt":{"type":"string"},"paused":{"type":"boolean"},"delayMinutes":{"type":"number","minimum":1},"runAt":{"type":"string"},"everyMinutes":{"type":"number","minimum":5},"cron":{"type":"string"},"timezone":{"type":"string"},"event":{"type":"string","enum":["session_finished","session_failed","worktree_archived","pr_merged","approval_resolved"]}},"required":["scheduleId"],"additionalProperties":false}},
        {"name":"schedule_list","description":"Agent sessions only. List your active schedules, including paused ones.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"schedule_cancel","description":"Agent sessions only. Delete one of your schedules.","inputSchema":{"type":"object","properties":{"scheduleId":{"type":"integer"}},"required":["scheduleId"],"additionalProperties":false}},
        {"name":"memory_save","description":"Agent sessions only. Save a lasting memory: a rule, a fact the code does not show, or open work. Never save secrets or live state. scope 'agent' is private. scope 'shared' is working memory for every agent (rules, facts, open work), not who the user is. scope 'user' is only facts about the user (name, timezone, preferences) and every agent sees them. Same text in the same scope updates the existing entry.","inputSchema":{"type":"object","properties":{"content":{"type":"string","maxLength":1000},"kind":{"type":"string","enum":["rule","fact","open_work"]},"scope":{"type":"string","enum":["agent","shared","user"]},"projectId":{"type":"string"},"pinned":{"type":"boolean"},"expiresInDays":{"type":"number","minimum":1}},"required":["content","kind"],"additionalProperties":false}},
        {"name":"memory_search","description":"Agent sessions only. Full-text search of your memories, shared memories, and user facts. Ranked by pinned, then relevance, then recency. Without query: pinned and newest first. from/to are unix seconds on updated_at.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"kind":{"type":"string","enum":["rule","fact","open_work"]},"scope":{"type":"string","enum":["agent","shared","user"]},"projectId":{"type":"string"},"pinned":{"type":"boolean"},"from":{"type":"integer"},"to":{"type":"integer"},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}},
        {"name":"memory_update","description":"Agent sessions only. Change the content, kind, or pinned flag of a memory you can see. The previous text is kept in the change record.","inputSchema":{"type":"object","properties":{"memoryId":{"type":"integer"},"content":{"type":"string","maxLength":1000},"kind":{"type":"string","enum":["rule","fact","open_work"]},"pinned":{"type":"boolean"}},"required":["memoryId"],"additionalProperties":false}},
        {"name":"memory_forget","description":"Agent sessions only. Delete a memory that is wrong or no longer needed. The previous text is kept in the change record.","inputSchema":{"type":"object","properties":{"memoryId":{"type":"integer"}},"required":["memoryId"],"additionalProperties":false}},
        {"name":"memory_supersede","description":"Agent sessions only. Correct a fact. The old text drops out of search and prompts and stays in the change record. Use memory_update for rules and open work.","inputSchema":{"type":"object","properties":{"memoryId":{"type":"integer"},"content":{"type":"string","maxLength":1000}},"required":["memoryId","content"],"additionalProperties":false}},
        {"name":"journal_add","description":"Agent sessions only. Record what happened, a decision, or an outcome. This is dated history, not a lasting fact. Use memory_save for rules and facts.","inputSchema":{"type":"object","properties":{"content":{"type":"string","maxLength":2000},"occurredAt":{"type":"integer","description":"Unix seconds. Default: now."},"projectId":{"type":"string"}},"required":["content"],"additionalProperties":false}},
        {"name":"journal_search","description":"Agent sessions only. Recall your journal by text and/or date, including chats that were archived. from/to are unix seconds on occurred_at. Other agents' journals are not included.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"from":{"type":"integer"},"to":{"type":"integer"},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}},
        {"name":"message_agent","description":"Agent sessions only. Send a request to another agent. Its answer arrives automatically as an update message; end your turn after sending.","inputSchema":{"type":"object","properties":{"agentId":{"type":"string"},"message":{"type":"string"}},"required":["agentId","message"],"additionalProperties":false}},
        {"name":"notify_user","description":"Agent sessions only. Tell the user something they must know: a result of a goal, a question, a failure, or a needed decision (level 'action'). Shows on the agent page and as a notification. Not for routine progress.","inputSchema":{"type":"object","properties":{"message":{"type":"string","maxLength":2000},"level":{"type":"string","enum":["info","action","error"]}},"required":["message"],"additionalProperties":false}},
        {"name":"task_list","description":"Agent sessions only. List your recent background tasks (schedule runs, follow-ups, agent requests) with status and one-line result.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}},
        {"name":"list_connectors","description":"Agent sessions only. Read-only. List the MCP connectors saved for this agent, whether a limit is saved, and whether this session's backend can apply that limit. Does not change the limit or sign in.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}
    ])
}

fn self_management_tool_definitions() -> Value {
    json!([
        {"name":"agent_list","description":"Agent sessions only. List agents (id, name, description, color, backend, model). Your own entry also includes instructions and skills.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"agent_create","description":"Agent sessions only. Create an agent. It cannot be given a backend, model, effort, thinking level, skill, or wake budget beyond yours. Optional schedules use the same timing fields as schedule_create. Jean, the coordinator, may set any valid config.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"icon":{"type":"string","enum":["blue","green","pink","purple","orange","yellow"]},"color":{"type":"string","enum":["blue","green","pink","purple","orange","yellow"]},"instructions":{"type":"string"},"backend":{"type":["string","null"]},"model":{"type":["string","null"]},"effort":{"type":["string","null"]},"thinkingLevel":{"type":["string","null"]},"skills":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"path":{"type":"string"},"backend":{"type":"string"}},"required":["path"],"additionalProperties":false}},"schedules":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"prompt":{"type":"string"},"delayMinutes":{"type":"number"},"runAt":{"type":"string"},"everyMinutes":{"type":"number"},"cron":{"type":"string"},"timezone":{"type":"string"},"event":{"type":"string"}},"required":["name","prompt"],"additionalProperties":false}}},"required":["name"],"additionalProperties":false}},
        {"name":"agent_update","description":"Agent sessions only. Update yourself (omit agentId): name, description, instructions, color, backend, model, effort, thinkingLevel, or skills. Updating a different agent returns approvalRequired unless you are Jean. You cannot grant another agent more than you have.","inputSchema":{"type":"object","properties":{"agentId":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"},"icon":{"type":"string"},"color":{"type":"string"},"instructions":{"type":"string"},"backend":{"type":["string","null"]},"model":{"type":["string","null"]},"effort":{"type":["string","null"]},"thinkingLevel":{"type":["string","null"]},"skills":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"path":{"type":"string"},"backend":{"type":"string"}},"required":["path"],"additionalProperties":false}}},"additionalProperties":false}},
        {"name":"agent_delete","description":"Agent sessions only. Delete an agent. Returns approvalRequired unless you are Jean. Built-in agents cannot be deleted.","inputSchema":{"type":"object","properties":{"agentId":{"type":"string"}},"required":["agentId"],"additionalProperties":false}},
        {"name":"agent_revert","description":"Agent sessions only. Undo the latest change to an agent (omit agentId for yourself): a field change, a schedule change, a create, or a delete. Reverting your own creation, or another agent's change, returns approvalRequired unless you are Jean.","inputSchema":{"type":"object","properties":{"agentId":{"type":"string"}},"additionalProperties":false}}
    ])
}

fn caller_agent(app: &AppHandle, source: &str) -> Result<db::Agent, String> {
    super::agent_for_session(app, source)
        .ok_or_else(|| "This tool is only for Jean agent sessions".to_string())
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn required_str(args: &Value, key: &str) -> Result<String, String> {
    str_arg(args, key).ok_or_else(|| format!("Missing required argument: {key}"))
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

fn required_int(args: &Value, key: &str) -> Result<i64, String> {
    int_arg(args, key).ok_or_else(|| format!("Missing required argument: {key}"))
}

pub(crate) fn timing_from_tool_args(args: &Value, now: i64) -> Result<db::ScheduleTiming, String> {
    let cron = str_arg(args, "cron");
    let event = str_arg(args, "event");
    let timezone = str_arg(args, "timezone");
    let delay = int_arg(args, "delayMinutes");
    let every = int_arg(args, "everyMinutes");
    let mixed = "Choose only one of delayMinutes, everyMinutes, runAt, cron, or event";
    if let Some(run_at) = str_arg(args, "runAt") {
        if delay.is_some() || every.is_some() || cron.is_some() || event.is_some() {
            return Err(mixed.to_string());
        }
        let run_at = super::cron::accept_run_at(&run_at, timezone.as_deref(), now)?;
        return db::validate_schedule_timing(None, None, None, None, Some(run_at), now);
    }
    if cron.is_none() && event.is_none() {
        let (first, every_secs) = schedule_timing(delay, every, now)?;
        return db::validate_schedule_timing(every_secs, None, None, None, Some(first), now);
    }
    if delay.is_some() || every.is_some() || (cron.is_some() && event.is_some()) {
        return Err(mixed.to_string());
    }
    db::validate_schedule_timing(
        None,
        cron.as_deref(),
        timezone.as_deref(),
        event.as_deref(),
        None,
        now,
    )
}

fn tool_has_arg(args: &Value, key: &str) -> bool {
    args.get(key)
        .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
}

/// Timing arguments for `schedule_update`, merged with the stored schedule:
/// a new cron without `timezone` keeps the stored timezone, and a
/// `timezone`-only update reuses the stored cron. `None` = timing unchanged.
fn update_timing_args(args: &Value, current: &db::Schedule) -> Result<Option<Value>, String> {
    let has_cron = tool_has_arg(args, "cron");
    let has_timezone = tool_has_arg(args, "timezone");
    let has_other = ["event", "everyMinutes", "delayMinutes", "runAt"]
        .iter()
        .any(|key| tool_has_arg(args, key));
    if !has_cron && !has_timezone && !has_other {
        return Ok(None);
    }
    let mut merged = args.clone();
    if has_cron && !has_timezone {
        if let (Some(_), Some(timezone)) = (&current.cron, &current.timezone) {
            merged["timezone"] = json!(timezone);
        }
    }
    if has_timezone && !has_cron && !has_other {
        let cron = current
            .cron
            .as_ref()
            .ok_or_else(|| "timezone applies only to cron schedules".to_string())?;
        merged["cron"] = json!(cron);
    }
    Ok(Some(merged))
}

/// First run time and repeat interval from schedule arguments.
pub(crate) fn schedule_timing(
    delay_minutes: Option<i64>,
    every_minutes: Option<i64>,
    now: i64,
) -> Result<(i64, Option<i64>), String> {
    if let Some(every) = every_minutes {
        if !(MIN_EVERY_MINUTES..=MAX_MINUTES).contains(&every) {
            return Err(format!(
                "everyMinutes must be between {MIN_EVERY_MINUTES} and {MAX_MINUTES}"
            ));
        }
    }
    if let Some(delay) = delay_minutes {
        if !(1..=MAX_MINUTES).contains(&delay) {
            return Err(format!("delayMinutes must be between 1 and {MAX_MINUTES}"));
        }
    }
    match (delay_minutes, every_minutes) {
        (None, None) => Err("Give delayMinutes (once) or everyMinutes (repeating)".to_string()),
        (delay, every) => {
            let first = delay.or(every).unwrap_or(1) * 60;
            Ok((now + first, every.map(|m| m * 60)))
        }
    }
}

/// Run an agent tool for the calling agent session.
pub async fn run(app: &AppHandle, name: &str, args: &Value, source: &str) -> Result<Value, String> {
    let agent = caller_agent(app, source)?;
    let result = match name {
        "schedule_create" => {
            let title = required_str(args, "name")?;
            let prompt = required_str(args, "prompt")?;
            let timing = timing_from_tool_args(args, db::now())?;
            let schedule = super::with_db(app, |conn| {
                let tx = conn
                    .transaction()
                    .map_err(|e| format!("Agents db error: {e}"))?;
                let schedule =
                    db::insert_schedule(&tx, &agent.id, &title, &prompt, &timing, false)?;
                super::self_manage::record_schedule_change(
                    &tx,
                    &agent.id,
                    "schedule_create",
                    None,
                    Some(&schedule),
                    Some(source),
                )?;
                tx.commit().map_err(|e| format!("Agents db error: {e}"))?;
                Ok(schedule)
            })?;
            json!({ "schedule": schedule })
        }
        "schedule_update" => {
            let id = required_int(args, "scheduleId")?;
            let name = str_arg(args, "name");
            let prompt = str_arg(args, "prompt");
            let paused = args.get("paused").and_then(Value::as_bool);
            let schedule = super::with_db(app, |conn| {
                let tx = conn
                    .transaction()
                    .map_err(|e| format!("Agents db error: {e}"))?;
                let before = db::get_schedule(&tx, &agent.id, id)?
                    .ok_or_else(|| format!("No active schedule #{id}"))?;
                let timing = update_timing_args(args, &before)?
                    .map(|merged| timing_from_tool_args(&merged, db::now()))
                    .transpose()?;
                let schedule = db::update_schedule(
                    &tx,
                    &agent.id,
                    id,
                    name.as_deref(),
                    prompt.as_deref(),
                    paused,
                    timing.as_ref(),
                )?;
                super::self_manage::record_schedule_change(
                    &tx,
                    &agent.id,
                    "schedule_update",
                    Some(&before),
                    Some(&schedule),
                    Some(source),
                )?;
                tx.commit().map_err(|e| format!("Agents db error: {e}"))?;
                Ok(schedule)
            })?;
            json!({ "schedule": schedule })
        }
        "schedule_list" => {
            let schedules = super::with_db(app, |conn| db::list_schedules(conn, &agent.id))?;
            json!({ "schedules": schedules })
        }
        "schedule_cancel" => {
            let id = required_int(args, "scheduleId")?;
            let cancelled = super::with_db(app, |conn| {
                let tx = conn
                    .transaction()
                    .map_err(|e| format!("Agents db error: {e}"))?;
                let before = db::get_schedule(&tx, &agent.id, id)?;
                let cancelled = db::cancel_schedule(&tx, &agent.id, id)?;
                if cancelled {
                    super::self_manage::record_schedule_change(
                        &tx,
                        &agent.id,
                        "schedule_cancel",
                        before.as_ref(),
                        None,
                        Some(source),
                    )?;
                }
                tx.commit().map_err(|e| format!("Agents db error: {e}"))?;
                Ok(cancelled)
            })?;
            if !cancelled {
                return Err(format!("No active schedule #{id}"));
            }
            json!({ "scheduleId": id, "cancelled": true })
        }
        "memory_save" => {
            let content = required_str(args, "content")?;
            let kind = required_str(args, "kind")?;
            let scope = str_arg(args, "scope").unwrap_or_else(|| "agent".to_string());
            let project_id = str_arg(args, "projectId");
            let expires_at = int_arg(args, "expiresInDays").map(|d| db::now() + d.max(1) * 86_400);
            let pinned = args.get("pinned").and_then(Value::as_bool).unwrap_or(false);
            let memory = super::with_db(app, |conn| {
                db::save_memory(
                    conn,
                    &db::NewMemory {
                        agent_id: Some(agent.id.as_str()),
                        scope: Some(&scope),
                        project_id: project_id.as_deref(),
                        kind: &kind,
                        content: &content,
                        pinned,
                        source_session_id: Some(source),
                        expires_at,
                    },
                    Some(&agent.id),
                )
            })?;
            json!({ "memory": memory })
        }
        "memory_search" => {
            let query = str_arg(args, "query");
            let kind = str_arg(args, "kind");
            let scope = str_arg(args, "scope");
            let project_id = str_arg(args, "projectId");
            let pinned = args.get("pinned").and_then(Value::as_bool);
            let from = int_arg(args, "from");
            let to = int_arg(args, "to");
            let limit = int_arg(args, "limit").unwrap_or(20).clamp(1, 50);
            let memories = super::with_db(app, |conn| {
                db::search_memories(
                    conn,
                    &db::MemorySearch {
                        agent_id: &agent.id,
                        query: query.as_deref(),
                        kind: kind.as_deref(),
                        scope: scope.as_deref(),
                        project_id: project_id.as_deref(),
                        pinned,
                        from,
                        to,
                        include_expired: false,
                        limit,
                    },
                )
            })?;
            json!({ "memories": memories })
        }
        "memory_update" => {
            let id = required_int(args, "memoryId")?;
            let patch = db::MemoryPatch {
                content: str_arg(args, "content"),
                kind: str_arg(args, "kind"),
                pinned: args.get("pinned").and_then(Value::as_bool),
            };
            let memory = super::with_db(app, |conn| {
                db::update_memory(conn, &agent.id, id, &patch, Some(&agent.id))
            })?;
            json!({ "memory": memory })
        }
        "memory_forget" => {
            let id = required_int(args, "memoryId")?;
            if !super::with_db(app, |conn| {
                db::forget_memory(conn, &agent.id, id, Some(&agent.id))
            })? {
                return Err(format!("Memory not found: {id}"));
            }
            json!({ "memoryId": id, "forgotten": true })
        }
        "memory_supersede" => {
            let id = required_int(args, "memoryId")?;
            let content = required_str(args, "content")?;
            let memory = super::with_db(app, |conn| {
                db::supersede_memory(conn, &agent.id, Some(&agent.id), id, &content, Some(source))
            })?;
            json!({ "memory": memory })
        }
        "journal_add" => {
            let content = required_str(args, "content")?;
            let occurred_at = int_arg(args, "occurredAt");
            let project_id = str_arg(args, "projectId");
            let entry = super::with_db(app, |conn| {
                db::add_journal(
                    conn,
                    &db::NewJournal {
                        agent_id: &agent.id,
                        project_id: project_id.as_deref(),
                        content: &content,
                        occurred_at,
                        source: "agent",
                        source_session_id: Some(source),
                    },
                )
            })?;
            json!({ "entry": entry })
        }
        "journal_search" => {
            let query = str_arg(args, "query");
            let from = int_arg(args, "from");
            let to = int_arg(args, "to");
            let limit = int_arg(args, "limit").unwrap_or(20).clamp(1, 50);
            let entries = super::with_db(app, |conn| {
                db::search_journal(
                    conn,
                    &db::JournalSearch {
                        agent_id: &agent.id,
                        query: query.as_deref(),
                        from,
                        to,
                        limit,
                    },
                )
            })?;
            json!({ "entries": entries })
        }
        "message_agent" => {
            let target_id = required_str(args, "agentId")?;
            let message = required_str(args, "message")?;
            if target_id == agent.id {
                return Err("You cannot message yourself".to_string());
            }
            super::with_db(app, |conn| {
                let target = db::get_agent(conn, &target_id)?
                    .ok_or_else(|| format!("Unknown agent: {target_id}"))?;
                let hop = db::active_hop_for_session(conn, source)? + 1;
                if hop > MAX_AGENT_HOPS {
                    return Err(format!(
                        "Agent message chain is too long (max {MAX_AGENT_HOPS} hops). Answer with what you have."
                    ));
                }
                let body = format!(
                    "Request from agent {} (`{}`):\n\n{}\n\nYour final reply in this turn is sent back to {} automatically.",
                    agent.name, agent.id, message, agent.name
                );
                let title = format!("Request from {}", agent.name);
                db::add_event(
                    conn,
                    &db::NewEvent {
                        agent_id: &target.id,
                        kind: "message",
                        title: &title,
                        body: &body,
                        hop,
                        reply_to_agent: Some(&agent.id),
                        reply_to_session: Some(source),
                        ..Default::default()
                    },
                )?;
                Ok(())
            })?;
            json!({ "agentId": target_id, "status": "sent", "note": "The answer arrives as an update message. End your turn now." })
        }
        "notify_user" => {
            let message = required_str(args, "message")?;
            let level = str_arg(args, "level").unwrap_or_else(|| "info".to_string());
            let notification = super::with_db(app, |conn| {
                db::add_notification(conn, &agent.id, Some(source), &level, &message)
            })?;
            use crate::http_server::EmitExt;
            let _ = app.emit_all(
                "agents:notification",
                &json!({
                    "agentId": agent.id,
                    "agentName": agent.name,
                    "level": notification.level,
                    "message": notification.message,
                }),
            );
            json!({ "notificationId": notification.id, "status": "sent" })
        }
        "task_list" => {
            let limit = int_arg(args, "limit").unwrap_or(20).clamp(1, 50);
            let tasks = super::with_db(app, |conn| db::list_tasks(conn, &agent.id, limit))?;
            json!({ "tasks": tasks })
        }
        // Subagent types. Separate from the tools above so this block can move.
        "subagent_type_list" => {
            let types = super::with_db(app, |conn| db::list_subagent_types(conn, &agent.id))?;
            json!({ "types": types })
        }
        "subagent_type_save" => {
            refuse_subagent_admin(app, source)?;
            let write = subagent_type_write(args)?;
            let existing = match write.id {
                Some(id) => super::with_db(app, |conn| db::get_subagent_type(conn, id))?,
                None => None,
            };
            if let Some(reason) = yolo_grant_block(&agent, existing.as_ref(), &write) {
                return Err(reason);
            }
            let saved =
                super::with_db(app, |conn| db::save_subagent_type(conn, &agent.id, &write))?;
            json!({ "type": saved })
        }
        "subagent_type_delete" => {
            refuse_subagent_admin(app, source)?;
            let id = required_int(args, "id")?;
            let deleted =
                super::with_db(app, |conn| db::delete_subagent_type(conn, &agent.id, id))?;
            if !deleted {
                return Err(format!("Subagent type not found: {id}"));
            }
            json!({ "id": id, "deleted": true })
        }
        "spawn_subagent" => {
            let type_name = required_str(args, "type")?;
            let task = required_str(args, "task")?;
            let spawned =
                super::subagents::spawn_subagent(app, &agent.id, &type_name, &task, Some(source))
                    .await?;
            json!({
                "task": spawned,
                "status": "spawned",
                "note": "The result arrives as an update message. End your turn now."
            })
        }
        "agent_list" | "agent_create" | "agent_update" | "agent_delete" | "agent_revert" => {
            super::self_manage::run_tool(app, name, args, source, &agent, false).await?
        }
        "list_connectors" => {
            return Ok(super::connectors::report_for_session(app, &agent, source).await);
        }
        _ => return Err(format!("Unknown agent tool: {name}")),
    };
    super::notify_changed(app);
    Ok(result)
}

/// Run an agent tool the user approved. Only the approval handler calls this;
/// the actor comes from the stored approval, never from an MCP caller.
pub async fn run_approved(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    let result = super::self_manage::run_approved(app, name, args).await?;
    super::notify_changed(app);
    Ok(result)
}

/// When an agent session calls a destructive tool, store an approval request
/// instead of running it. Returns the tool result to send back, or `None`
/// when the call may run now.
pub fn approval_gate(app: &AppHandle, name: &str, args: &Value, source: &str) -> Option<Value> {
    if !APPROVAL_TOOLS.contains(&name) {
        return None;
    }
    let agent = super::agent_for_session(app, source)?;
    let result = super::with_db(app, |conn| {
        db::create_approval(conn, &agent.id, Some(source), name, args)
    });
    super::notify_changed(app);
    Some(match result {
        Ok(id) => json!({
            "approvalRequired": true,
            "approvalId": id,
            "status": "waiting_for_user",
            "message": format!("{name} needs the user's approval (request #{id}). Tell the user and end your turn. The result arrives as an update message."),
        }),
        Err(e) => json!({
            "approvalRequired": true,
            "status": "error",
            "message": format!("{name} needs the user's approval, but the request could not be saved: {e}"),
        }),
    })
}

/// An agent session sent work to `target_session_id`: track it so the agent
/// gets an update when that run ends.
pub fn record_delegation(
    app: &AppHandle,
    source: &str,
    target_session_id: &str,
    target_worktree_id: &str,
) {
    if source == target_session_id {
        return;
    }
    let Some(agent) = super::agent_for_session(app, source) else {
        return;
    };
    let result = super::with_db(app, |conn| {
        let hop = db::active_hop_for_session(conn, source)?;
        // The update returns to this calling session (chat or task).
        db::upsert_delegation(
            conn,
            &agent.id,
            target_session_id,
            target_worktree_id,
            hop,
            Some(source),
        )
    });
    match result {
        Ok(()) => super::notify_changed(app),
        Err(e) => log::warn!("[Agents] record delegation failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_timing_rules() {
        assert_eq!(schedule_timing(Some(10), None, 1000).unwrap(), (1600, None));
        assert_eq!(
            schedule_timing(None, Some(30), 1000).unwrap(),
            (2800, Some(1800))
        );
        assert_eq!(
            schedule_timing(Some(1), Some(60), 0).unwrap(),
            (60, Some(3600))
        );
        assert!(schedule_timing(None, None, 0).is_err());
        assert!(schedule_timing(Some(0), None, 0).is_err());
        assert!(schedule_timing(None, Some(4), 0).is_err());
        assert!(schedule_timing(Some(MAX_MINUTES + 1), None, 0).is_err());
    }

    #[test]
    fn tool_timing_accepts_cron_and_events_and_rejects_mixes() {
        let cron = timing_from_tool_args(
            &json!({"cron": "0 9 * * 1-5", "timezone": "UTC"}),
            1_767_225_600,
        )
        .unwrap();
        assert_eq!(cron.cron.as_deref(), Some("0 9 * * 1-5"));
        assert!(cron.next_run_at > 1_767_225_600);
        let event = timing_from_tool_args(&json!({"event": "session_finished"}), 0).unwrap();
        assert_eq!(event.event.as_deref(), Some("session_finished"));
        assert!(
            timing_from_tool_args(&json!({"cron": "0 * * * *", "everyMinutes": 30}), 0).is_err()
        );
        assert!(timing_from_tool_args(&json!({"event": "webhook"}), 0).is_err());
    }

    #[test]
    fn tool_timing_accepts_run_at_alone() {
        let now = 1_767_225_600; // 2026-01-01T00:00:00Z
        let once = timing_from_tool_args(
            &json!({"runAt": "2026-11-03T09:00", "timezone": "Europe/Budapest"}),
            now,
        )
        .unwrap();
        assert_eq!(
            (once.every_secs, once.cron, once.event, once.next_run_at),
            (None, None, None, 1_793_692_800)
        );
        assert_eq!(
            timing_from_tool_args(
                &json!({"runAt": "2026-11-03T09:00", "cron": "0 9 * * *"}),
                now
            )
            .unwrap_err(),
            "Choose only one of delayMinutes, everyMinutes, runAt, cron, or event"
        );
    }

    #[test]
    fn update_timing_keeps_the_stored_cron_and_timezone() {
        let stored = db::Schedule {
            id: 1,
            agent_id: "jean".into(),
            name: "brief".into(),
            prompt: "check".into(),
            every_secs: None,
            next_run_at: 0,
            last_run_at: None,
            cron: Some("0 9 * * 1-5".into()),
            timezone: Some("Europe/Berlin".into()),
            event: None,
            paused: false,
        };
        assert_eq!(
            update_timing_args(&json!({"paused": true}), &stored).unwrap(),
            None
        );

        let now = 1_767_225_600;
        let new_cron = update_timing_args(&json!({"cron": "0 10 * * *"}), &stored)
            .unwrap()
            .unwrap();
        let timing = timing_from_tool_args(&new_cron, now).unwrap();
        assert_eq!(timing.cron.as_deref(), Some("0 10 * * *"));
        assert_eq!(timing.timezone.as_deref(), Some("Europe/Berlin"));

        let new_zone = update_timing_args(&json!({"timezone": "Asia/Tokyo"}), &stored)
            .unwrap()
            .unwrap();
        let timing = timing_from_tool_args(&new_zone, now).unwrap();
        assert_eq!(timing.cron.as_deref(), Some("0 9 * * 1-5"));
        assert_eq!(timing.timezone.as_deref(), Some("Asia/Tokyo"));

        let interval = db::Schedule {
            cron: None,
            timezone: None,
            every_secs: Some(600),
            ..stored
        };
        assert!(update_timing_args(&json!({"timezone": "UTC"}), &interval)
            .unwrap_err()
            .contains("cron"));
    }

    #[test]
    fn tool_lists_are_consistent() {
        let defs = tool_definitions();
        let names: Vec<&str> = defs
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(&names[..AGENT_TOOLS.len()], AGENT_TOOLS);
        assert_eq!(&names[AGENT_TOOLS.len()..], SUBAGENT_TOOLS);
        for tool in APPROVAL_TOOLS {
            assert!(!is_agent_tool(tool));
        }
        assert!(is_agent_tool("spawn_subagent"));
    }

    #[test]
    fn read_only_subagent_blocks_writes_and_spawn() {
        assert!(read_only_subagent_block(Some("read_only"), "Diff", "list_projects").is_none());
        assert!(read_only_subagent_block(Some("read_only"), "Diff", "memory_search").is_none());
        let blocked =
            read_only_subagent_block(Some("read_only"), "Diff", "spawn_subagent").unwrap();
        assert!(blocked.contains("spawn_subagent"));
        assert!(blocked.contains("Diff"));
        assert!(read_only_subagent_block(Some("read_only"), "Diff", "delete_worktree").is_some());
        assert!(read_only_subagent_block(None, "Diff", "delete_worktree").is_none());
        assert!(read_only_subagent_block(None, "Diff", "spawn_subagent").is_none());
    }

    #[test]
    fn agent_cannot_grant_a_subagent_yolo() {
        let agent = |backend: &str| db::Agent {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            description: String::new(),
            icon: "blue".into(),
            role_prompt: String::new(),
            worktree_id: "__agent_reviewer__".into(),
            max_wakes_per_hour: 12,
            builtin: false,
            backend: Some(backend.into()),
            model: None,
            effort: None,
            thinking_level: None,
            skills: Vec::new(),
            mcp_servers: None,
            jean_tools: None,
        };
        let write = |args: Value| subagent_type_write(&args).unwrap();
        let claude = agent("claude");
        for args in [
            json!({"name": "Fixer", "permissionMode": "YOLO"}),
            json!({"name": "Fixer", "backend": "cursor"}),
            json!({"name": "Fixer", "backend": "cursor", "permissionMode": "build"}),
        ] {
            let reason = yolo_grant_block(&claude, None, &write(args)).unwrap();
            assert!(reason.contains("Only the user"));
        }
        for args in [
            json!({"name": "Fixer"}),
            json!({"name": "Fixer", "permissionMode": "build"}),
            json!({"name": "Fixer", "backend": "cursor", "permissionMode": "plan"}),
        ] {
            assert_eq!(yolo_grant_block(&claude, None, &write(args)), None);
        }
        let cursor = agent("cursor");
        assert_eq!(
            yolo_grant_block(&cursor, None, &write(json!({"name": "Fixer"}))),
            None
        );

        let user_yolo = db::SubagentType {
            id: 7,
            agent_id: Some("reviewer".into()),
            shared: false,
            name: "Fixer".into(),
            description: String::new(),
            instructions: String::new(),
            backend: None,
            model: None,
            effort: None,
            thinking_level: None,
            skills: Vec::new(),
            permission_mode: Some("yolo".into()),
            tool_mode: None,
            created_at: 0,
            updated_at: 0,
        };
        let edit = write(json!({"id": 7, "name": "Fixer", "permissionMode": "yolo"}));
        assert_eq!(yolo_grant_block(&claude, Some(&user_yolo), &edit), None);
    }

    #[test]
    fn subagent_type_write_reads_optional_overrides() {
        let write = subagent_type_write(&json!({
            "name": "Investigator",
            "instructions": "Report facts",
            "shared": true,
            "backend": "codex",
            "model": "gpt-5.5",
            "permissionMode": "plan",
            "toolMode": "read_only",
            "skills": [{"name": "diff", "path": "/skills/diff/SKILL.md"}]
        }))
        .unwrap();
        assert!(write.shared);
        assert_eq!(write.backend.as_deref(), Some("codex"));
        assert_eq!(write.permission_mode.as_deref(), Some("plan"));
        assert_eq!(write.tool_mode.as_deref(), Some("read_only"));
        assert_eq!(write.skills.len(), 1);
        assert!(subagent_type_write(&json!({"description": "x"})).is_err());
    }
}
