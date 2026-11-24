//! Jean MCP tools for project coordinators (schedules, memory, journal), the
//! approval gate for destructive tools, and delegation tracking.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::db;
use crate::projects::types::{SessionType, Worktree};

/// Tools an agent may only run after the user approves.
pub const APPROVAL_TOOLS: &[&str] = &[
    "delete_worktree",
    "merge_pull_request",
    "remove_project",
    "set_connector",
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
    "notify_user",
    "set_status",
    "ask_user",
    "list_connectors",
];

/// Source used when the user already approved a tool and it is run again.
pub const APPROVED_REPLAY_SOURCE: &str = "agent-approval";

const MIN_EVERY_MINUTES: i64 = 5;
const MAX_QUESTION_OPTIONS: usize = 8;
const MAX_STATUS_CHARS: usize = 60;
const MAX_MINUTES: i64 = 60 * 24 * 30;

pub fn is_agent_tool(name: &str) -> bool {
    AGENT_TOOLS.contains(&name)
}

/// MCP definitions of the coordinator tools (appended to the Jean tool
/// registry, and listed only for coordinator sessions).
pub fn tool_definitions() -> Value {
    json!([
        {"name":"schedule_create","description":"Coordinator chat only. Wake yourself later with a prompt. Choose one: delayMinutes (once), runAt (once at an exact date-time: YYYY-MM-DDTHH:MM local time in timezone, or RFC 3339 with an offset), everyMinutes (repeating, min 5), cron (5 fields) plus timezone, or event (session_finished, session_failed, pr_merged, approval_resolved). The run arrives in your chat as an update.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"prompt":{"type":"string"},"delayMinutes":{"type":"number","minimum":1},"runAt":{"type":"string"},"everyMinutes":{"type":"number","minimum":5},"cron":{"type":"string"},"timezone":{"type":"string"},"event":{"type":"string","enum":["session_finished","session_failed","pr_merged","approval_resolved"]}},"required":["name","prompt"],"additionalProperties":false}},
        {"name":"schedule_update","description":"Coordinator chat only. Change one of your schedules: name, prompt, paused, or its timing (the same fields as schedule_create).","inputSchema":{"type":"object","properties":{"scheduleId":{"type":"integer"},"name":{"type":"string"},"prompt":{"type":"string"},"paused":{"type":"boolean"},"delayMinutes":{"type":"number","minimum":1},"runAt":{"type":"string"},"everyMinutes":{"type":"number","minimum":5},"cron":{"type":"string"},"timezone":{"type":"string"},"event":{"type":"string","enum":["session_finished","session_failed","pr_merged","approval_resolved"]}},"required":["scheduleId"],"additionalProperties":false}},
        {"name":"schedule_list","description":"Coordinator chat only. List your active schedules, including paused ones.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"schedule_cancel","description":"Coordinator chat only. Delete one of your schedules.","inputSchema":{"type":"object","properties":{"scheduleId":{"type":"integer"}},"required":["scheduleId"],"additionalProperties":false}},
        {"name":"memory_save","description":"Coordinator chat only. Save a lasting memory: a rule, a fact the code does not show, or open work. Never save secrets or live state. scope 'agent' is for this project only. scope 'shared' is for facts that hold in every project (the coordinators of all projects see it), not who the user is. scope 'user' is only facts about the user (name, timezone, preferences). Same text in the same scope updates the existing entry.","inputSchema":{"type":"object","properties":{"content":{"type":"string","maxLength":1000},"kind":{"type":"string","enum":["rule","fact","open_work"]},"scope":{"type":"string","enum":["agent","shared","user"]},"projectId":{"type":"string"},"pinned":{"type":"boolean"},"expiresInDays":{"type":"number","minimum":1}},"required":["content","kind"],"additionalProperties":false}},
        {"name":"memory_search","description":"Coordinator chat only. Full-text search of your memories, shared memories, and user facts. Ranked by pinned, then relevance, then recency. Without query: pinned and newest first. from/to are unix seconds on updated_at.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"kind":{"type":"string","enum":["rule","fact","open_work"]},"scope":{"type":"string","enum":["agent","shared","user"]},"projectId":{"type":"string"},"pinned":{"type":"boolean"},"from":{"type":"integer"},"to":{"type":"integer"},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}},
        {"name":"memory_update","description":"Coordinator chat only. Change the content, kind, or pinned flag of a memory you can see. The previous text is kept in the change record.","inputSchema":{"type":"object","properties":{"memoryId":{"type":"integer"},"content":{"type":"string","maxLength":1000},"kind":{"type":"string","enum":["rule","fact","open_work"]},"pinned":{"type":"boolean"}},"required":["memoryId"],"additionalProperties":false}},
        {"name":"memory_forget","description":"Coordinator chat only. Delete a memory that is wrong or no longer needed. The previous text is kept in the change record.","inputSchema":{"type":"object","properties":{"memoryId":{"type":"integer"}},"required":["memoryId"],"additionalProperties":false}},
        {"name":"memory_supersede","description":"Coordinator chat only. Correct a fact. The old text drops out of search and prompts and stays in the change record. Use memory_update for rules and open work.","inputSchema":{"type":"object","properties":{"memoryId":{"type":"integer"},"content":{"type":"string","maxLength":1000}},"required":["memoryId","content"],"additionalProperties":false}},
        {"name":"journal_add","description":"Coordinator chat only. Record what happened, a decision, or an outcome. This is dated history, not a lasting fact. Use memory_save for rules and facts.","inputSchema":{"type":"object","properties":{"content":{"type":"string","maxLength":2000},"occurredAt":{"type":"integer","description":"Unix seconds. Default: now."},"projectId":{"type":"string"}},"required":["content"],"additionalProperties":false}},
        {"name":"journal_search","description":"Coordinator chat only. Recall your journal by text and/or date, including chats that were archived. from/to are unix seconds on occurred_at. Journals of other projects are not included.","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"from":{"type":"integer"},"to":{"type":"integer"},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}},
        {"name":"notify_user","description":"Coordinator chat only. Tell the user something they must know: a result of a goal, a question, a failure, or a needed decision (level 'action'). Shows as a notification. Not for routine progress.","inputSchema":{"type":"object","properties":{"message":{"type":"string","maxLength":2000},"level":{"type":"string","enum":["info","action","error"]}},"required":["message"],"additionalProperties":false}},
        {"name":"set_status","description":"Coordinator chat only. Show the user a short status of what you do now, in 2 to 5 plain words (for example: 'Checking firewall logs'). Do not name tools, commands, or file paths. It shows only while your turn runs.","inputSchema":{"type":"object","properties":{"text":{"type":"string","maxLength":60}},"required":["text"],"additionalProperties":false}},
        {"name":"ask_user","description":"Coordinator chat only. Ask the user a question that needs a decision. The chat shows it with the options as buttons. multiple false: the user picks one option and it is sent at once. multiple true: the user picks one or more and sends them. The answer arrives as the next user message. End your turn after calling it.","inputSchema":{"type":"object","properties":{"question":{"type":"string","maxLength":500},"options":{"type":"array","items":{"type":"string","maxLength":200},"minItems":2,"maxItems":MAX_QUESTION_OPTIONS},"multiple":{"type":"boolean","description":"Default false."}},"required":["question","options"],"additionalProperties":false}},
        {"name":"list_connectors","description":"Coordinator chat only. Read-only. List the MCP connectors saved for this coordinator, whether a limit is saved, and whether this session's backend can apply that limit. Does not change the limit or sign in.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}
    ])
}

fn caller_agent(app: &AppHandle, source: &str) -> Result<db::Agent, String> {
    super::agent_for_session(app, source)
        .ok_or_else(|| "This tool is only for a project coordinator chat".to_string())
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

/// Check an `ask_user` call: a question and 2 to 8 distinct, non-empty options.
fn question_from_args(args: &Value) -> Result<(String, Vec<String>), String> {
    let question = required_str(args, "question")?;
    let options: Vec<String> = args
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
                .collect()
        })
        .unwrap_or_default();
    if options.len() < 2 || options.len() > MAX_QUESTION_OPTIONS {
        return Err(format!("Give 2 to {MAX_QUESTION_OPTIONS} options"));
    }
    if options.iter().any(String::is_empty) {
        return Err("Options cannot be empty".to_string());
    }
    let mut unique = options.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != options.len() {
        return Err("Options must be different".to_string());
    }
    Ok((question, options))
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
                db::insert_schedule(conn, &agent.id, &title, &prompt, &timing, false)
            })?;
            json!({ "schedule": schedule })
        }
        "schedule_update" => {
            let id = required_int(args, "scheduleId")?;
            let name = str_arg(args, "name");
            let prompt = str_arg(args, "prompt");
            let paused = args.get("paused").and_then(Value::as_bool);
            let schedule = super::with_db(app, |conn| {
                let before = db::get_schedule(conn, &agent.id, id)?
                    .ok_or_else(|| format!("No active schedule #{id}"))?;
                let timing = update_timing_args(args, &before)?
                    .map(|merged| timing_from_tool_args(&merged, db::now()))
                    .transpose()?;
                db::update_schedule(
                    conn,
                    &agent.id,
                    id,
                    name.as_deref(),
                    prompt.as_deref(),
                    paused,
                    timing.as_ref(),
                )
            })?;
            json!({ "schedule": schedule })
        }
        "schedule_list" => {
            let schedules = super::with_db(app, |conn| db::list_schedules(conn, &agent.id))?;
            json!({ "schedules": schedules })
        }
        "schedule_cancel" => {
            let id = required_int(args, "scheduleId")?;
            let cancelled = super::with_db(app, |conn| db::cancel_schedule(conn, &agent.id, id))?;
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
        "set_status" => {
            let text = required_str(args, "text")?;
            if text.chars().count() > MAX_STATUS_CHARS {
                return Err(format!(
                    "Status is too long. Use 2 to 5 words (at most {MAX_STATUS_CHARS} characters)."
                ));
            }
            json!({ "status": "shown" })
        }
        "ask_user" => {
            question_from_args(args)?;
            json!({ "status": "shown", "note": "The user sees the question with the options. End your turn now. The answer arrives as the next user message." })
        }
        "list_connectors" => {
            return Ok(super::connectors::report_for_session(app, &agent, source).await);
        }
        _ => return Err(format!("Unknown agent tool: {name}")),
    };
    super::notify_changed(app);
    Ok(result)
}

/// The worktree's PR is merged (cached status), so deleting it removes no
/// unmerged work. Merged is a terminal state; a stale cache only means the
/// delete falls back to the approval flow.
fn worktree_pr_merged(wt: &Worktree) -> bool {
    wt.session_type != SessionType::Base
        && wt.pr_number.is_some()
        && wt
            .cached_pr_status
            .as_deref()
            .is_some_and(|status| status.eq_ignore_ascii_case("merged"))
}

/// `delete_worktree` of a worktree whose PR is merged runs without approval.
fn deletes_merged_worktree(app: &AppHandle, name: &str, args: &Value) -> bool {
    if name != "delete_worktree" {
        return false;
    }
    let Some(worktree_id) = args.get("worktreeId").and_then(Value::as_str) else {
        return false;
    };
    crate::projects::storage::load_projects_data(app)
        .ok()
        .and_then(|data| data.find_worktree(worktree_id).map(worktree_pr_merged))
        .unwrap_or(false)
}

/// When an agent session calls a destructive tool, store an approval request
/// instead of running it. Returns the tool result to send back, or `None`
/// when the call may run now.
pub fn approval_gate(app: &AppHandle, name: &str, args: &Value, source: &str) -> Option<Value> {
    if !APPROVAL_TOOLS.contains(&name) || deletes_merged_worktree(app, name, args) {
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
            agent_id: "coord_p1".into(),
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
        assert_eq!(names, AGENT_TOOLS);
        for tool in APPROVAL_TOOLS {
            assert!(!is_agent_tool(tool));
        }
        // Push and PR creation are reversible: the coordinator runs them without approval.
        assert!(!APPROVAL_TOOLS.contains(&"push_worktree"));
        assert!(!APPROVAL_TOOLS.contains(&"create_pull_request"));
    }

    #[test]
    fn only_a_worktree_with_a_merged_pr_skips_delete_approval() {
        let wt = |extra: Value| -> Worktree {
            let mut base = json!({
                "id": "wt-1", "project_id": "p1", "name": "fix", "path": "/tmp/fix",
                "branch": "fix", "created_at": 1,
            });
            base.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value(base).unwrap()
        };
        assert!(worktree_pr_merged(&wt(
            json!({"pr_number": 7, "cached_pr_status": "merged"})
        )));
        assert!(worktree_pr_merged(&wt(
            json!({"pr_number": 7, "cached_pr_status": "MERGED"})
        )));
        for not_merged in [
            json!({}),
            json!({"pr_number": 7}),
            json!({"pr_number": 7, "cached_pr_status": "open"}),
            json!({"pr_number": 7, "cached_pr_status": "closed"}),
            json!({"cached_pr_status": "merged"}),
            json!({"pr_number": 7, "cached_pr_status": "merged", "session_type": "base"}),
        ] {
            assert!(!worktree_pr_merged(&wt(not_merged)));
        }
    }

    #[test]
    fn ask_user_needs_two_to_eight_distinct_options() {
        let ok = question_from_args(&json!({ "question": "Which?", "options": ["A", " B "] }));
        assert_eq!(
            ok.unwrap(),
            ("Which?".to_string(), vec!["A".to_string(), "B".to_string()])
        );
        for options in [
            json!(["A"]),
            json!(["A", "A"]),
            json!(["A", " "]),
            json!(["1", "2", "3", "4", "5", "6", "7", "8", "9"]),
        ] {
            assert!(
                question_from_args(&json!({ "question": "Which?", "options": options })).is_err()
            );
        }
        assert!(question_from_args(&json!({ "options": ["A", "B"] })).is_err());
    }
}
