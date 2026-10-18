//! Agent self-management: create, update, list, delete, and revert.
//!
//! Jean (the built-in coordinator) and the user may change any agent.
//! Another agent may change itself and create a lesser agent. Changing a
//! different agent, or deleting any agent, waits for the user.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::db::{self, Agent, AgentChange, AgentPatch, AgentRunConfig, AgentSkill, Schedule};

/// Audit actor for changes made from the Agents UI.
pub const USER_ACTOR: &str = "user";

/// Most user-created agents (Jean is not counted).
pub const MAX_USER_AGENTS: i64 = 20;
/// Most `create` audit rows in a rolling hour, including ones later deleted.
pub const MAX_AGENT_CREATES_PER_HOUR: i64 = 5;

const AGENT_COLORS: &[&str] = &["blue", "green", "pink", "purple", "orange", "yellow"];
const MAX_NAME_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 2000;
const MAX_ROLE_CHARS: usize = 20_000;
const MAX_INITIAL_SCHEDULES: usize = 10;

const EFFORT_RANK: &[&str] = &[
    "off",
    "none",
    "adaptive",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
];
const THINKING_RANK: &[&str] = &["off", "adaptive", "think", "megathink", "ultrathink"];

/// Fields compared when deciding whether a child was given more than its creator.
#[derive(Debug, Clone, Default)]
pub struct RunGrant<'a> {
    pub backend: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub thinking_level: Option<&'a str>,
    /// `None` leaves skills unchanged. `Some` is the full replacement list.
    pub skills: Option<&'a [AgentSkill]>,
}

/// True when this update must wait for the user.
/// Jean may update every agent. Everyone else may update only themselves.
pub fn update_requires_approval(actor: &Agent, target_id: &str) -> bool {
    !actor.builtin && actor.id != target_id
}

/// True when this delete must wait for the user.
/// Jean may delete other agents. Nobody may delete a built-in agent (that is
/// an error, not an approval). Deleting yourself also waits.
pub fn delete_requires_approval(actor: &Agent, target: &Agent) -> bool {
    !target.builtin && !actor.builtin
}

/// True when undoing this change must wait for the user.
/// Jean may revert anything. Another agent may revert its own last change,
/// except undoing its own creation (that deletes it).
pub fn revert_requires_approval(actor: &Agent, target_id: &str, change: &AgentChange) -> bool {
    if actor.builtin {
        return false;
    }
    if actor.id != target_id {
        return true;
    }
    revert_deletes_agent(change)
}

fn revert_deletes_agent(change: &AgentChange) -> bool {
    if is_schedule_change(change) {
        return false;
    }
    change.before.is_none()
}

/// Reject a grant that is more than `creator` currently has.
/// `current` is the target's present config (empty when creating). A value
/// kept equal to `current` is not a new grant. Jean is not checked.
pub fn check_run_grant(
    creator: &Agent,
    current: &RunGrant<'_>,
    requested: &RunGrant<'_>,
) -> Result<(), String> {
    if creator.builtin {
        return Ok(());
    }
    if let Some(backend) = requested.backend {
        choice_allowed(
            creator.backend.as_deref(),
            current.backend,
            backend,
            "backend",
        )?;
    }
    if let Some(model) = requested.model {
        choice_allowed(creator.model.as_deref(), current.model, model, "model")?;
    }
    if let Some(effort) = requested.effort {
        level_allowed(
            creator.effort.as_deref(),
            current.effort,
            effort,
            EFFORT_RANK,
            "effort",
        )?;
    }
    if let Some(thinking) = requested.thinking_level {
        level_allowed(
            creator.thinking_level.as_deref(),
            current.thinking_level,
            thinking,
            THINKING_RANK,
            "thinking level",
        )?;
    }
    if let Some(skills) = requested.skills {
        let current_skills = current.skills.unwrap_or(&[]);
        for skill in skills {
            let kept = current_skills.iter().any(|item| item.path == skill.path);
            let owned = creator.skills.iter().any(|item| item.path == skill.path);
            if !kept && !owned {
                return Err(format!(
                    "Cannot add skill {}: the creator does not have it",
                    skill.path
                ));
            }
        }
    }
    Ok(())
}

fn choice_allowed(
    creator: Option<&str>,
    current: Option<&str>,
    requested: &str,
    label: &str,
) -> Result<(), String> {
    if current == Some(requested) {
        return Ok(());
    }
    match creator {
        Some(value) if value == requested => Ok(()),
        Some(value) => Err(format!(
            "Cannot set {label} {requested}: the creator uses {value}"
        )),
        None => Err(format!(
            "Cannot set {label} {requested}: the creator uses the default {label}"
        )),
    }
}

fn level_allowed(
    creator: Option<&str>,
    current: Option<&str>,
    requested: &str,
    levels: &[&str],
    label: &str,
) -> Result<(), String> {
    if current == Some(requested) {
        return Ok(());
    }
    let Some(creator_level) = creator else {
        return Err(format!(
            "Cannot set {label} {requested}: the creator has no {label} set"
        ));
    };
    let requested_rank = rank_of(levels, requested).unwrap_or(usize::MAX);
    let creator_rank = rank_of(levels, creator_level).unwrap_or(0);
    if requested_rank > creator_rank {
        return Err(format!(
            "Cannot set {label} {requested}: the creator has {creator_level}"
        ));
    }
    Ok(())
}

fn rank_of(levels: &[&str], value: &str) -> Option<usize> {
    levels.iter().position(|item| *item == value)
}

pub fn normalize_icon(icon: &str, allow_jean: bool) -> Result<String, String> {
    let icon = icon.trim().to_ascii_lowercase();
    if icon.is_empty() {
        return Err("Agent color cannot be empty".to_string());
    }
    if icon == "jean" {
        return if allow_jean {
            Ok(icon)
        } else {
            Err("The jean color is reserved for the coordinator".to_string())
        };
    }
    if AGENT_COLORS.contains(&icon.as_str()) {
        Ok(icon)
    } else {
        Err(format!(
            "Unknown agent color: {icon}. Use blue, green, pink, purple, orange, or yellow."
        ))
    }
}

fn normalize_config(config: &AgentRunConfig) -> Result<AgentRunConfig, String> {
    Ok(AgentRunConfig {
        backend: db::normalize_agent_backend(config.backend.as_deref())?,
        model: db::normalize_agent_model(config.model.as_deref())?,
        effort: db::normalize_agent_effort(config.effort.as_deref())?,
        thinking_level: db::normalize_agent_thinking(config.thinking_level.as_deref())?,
        skills: db::normalize_agent_skills(&config.skills)?,
    })
}

fn normalize_patch(patch: &AgentPatch) -> Result<AgentPatch, String> {
    let mut patch = patch.clone();
    if let Some(value) = &patch.backend {
        patch.backend = Some(db::normalize_agent_backend(value.as_deref())?);
    }
    if let Some(value) = &patch.model {
        patch.model = Some(db::normalize_agent_model(value.as_deref())?);
    }
    if let Some(value) = &patch.effort {
        patch.effort = Some(db::normalize_agent_effort(value.as_deref())?);
    }
    if let Some(value) = &patch.thinking_level {
        patch.thinking_level = Some(db::normalize_agent_thinking(value.as_deref())?);
    }
    if let Some(skills) = &patch.skills {
        patch.skills = Some(db::normalize_agent_skills(skills)?);
    }
    Ok(patch)
}

fn limit_text(label: &str, value: &str, max: usize) -> Result<(), String> {
    if value.chars().count() > max {
        Err(format!("{label} is longer than {max} characters"))
    } else {
        Ok(())
    }
}

pub fn ensure_create_capacity(conn: &rusqlite::Connection, now_unix: i64) -> Result<(), String> {
    let total = db::count_user_agents(conn)?;
    if total >= MAX_USER_AGENTS {
        return Err(format!(
            "Agent limit reached ({MAX_USER_AGENTS} agents). Delete one first."
        ));
    }
    let recent = db::count_creates_since(conn, now_unix.saturating_sub(3600))?;
    if recent >= MAX_AGENT_CREATES_PER_HOUR {
        return Err(format!(
            "Hourly agent create limit reached ({MAX_AGENT_CREATES_PER_HOUR} per hour)."
        ));
    }
    Ok(())
}

pub struct InitialSchedule {
    pub name: String,
    pub prompt: String,
    pub timing: db::ScheduleTiming,
}

pub struct CreateInput {
    pub name: String,
    pub description: String,
    pub icon: String,
    pub role_prompt: String,
    pub config: AgentRunConfig,
    pub paused: bool,
    pub schedules: Vec<InitialSchedule>,
}

/// Create an agent, enforce the caps, and write one audit row.
/// `actor` `None` is the user. A non-coordinator actor cannot grant more than
/// it has, and the child's wake budget is clamped to the actor's.
pub fn create_for_actor(
    conn: &mut rusqlite::Connection,
    actor: Option<&Agent>,
    session_id: Option<&str>,
    input: &CreateInput,
) -> Result<Agent, String> {
    limit_text("Name", input.name.trim(), MAX_NAME_CHARS)?;
    limit_text(
        "Description",
        input.description.trim(),
        MAX_DESCRIPTION_CHARS,
    )?;
    limit_text("Instructions", input.role_prompt.trim(), MAX_ROLE_CHARS)?;
    if input.schedules.len() > MAX_INITIAL_SCHEDULES {
        return Err(format!("At most {MAX_INITIAL_SCHEDULES} initial schedules"));
    }
    let icon = normalize_icon(&input.icon, false)?;
    let config = normalize_config(&input.config)?;
    if let Some(actor) = actor.filter(|agent| !agent.builtin) {
        let requested = RunGrant {
            backend: config.backend.as_deref(),
            model: config.model.as_deref(),
            effort: config.effort.as_deref(),
            thinking_level: config.thinking_level.as_deref(),
            skills: Some(&config.skills),
        };
        check_run_grant(actor, &RunGrant::default(), &requested)?;
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("Agents db error: {e}"))?;
    ensure_create_capacity(&tx, db::now())?;
    let mut agent = db::create_agent(
        &tx,
        &input.name,
        &input.description,
        &icon,
        &input.role_prompt,
        &config,
    )?;
    if input.paused {
        agent = db::update_agent(
            &tx,
            &agent.id,
            &AgentPatch {
                paused: Some(true),
                ..AgentPatch::default()
            },
        )?;
    }
    if let Some(actor) = actor.filter(|agent| !agent.builtin) {
        // The child keeps the creator's connector and Jean tool limits, so a
        // limited agent cannot create an unlimited one.
        agent = db::update_agent(
            &tx,
            &agent.id,
            &AgentPatch {
                max_wakes_per_hour: Some(agent.max_wakes_per_hour.min(actor.max_wakes_per_hour)),
                mcp_servers: Some(actor.mcp_servers.clone()),
                jean_tools: Some(actor.jean_tools.clone()),
                ..AgentPatch::default()
            },
        )?;
    }
    for schedule in &input.schedules {
        db::insert_schedule(
            &tx,
            &agent.id,
            &schedule.name,
            &schedule.prompt,
            &schedule.timing,
            false,
        )?;
    }
    let after = serde_json::to_string(&agent).map_err(|e| format!("Failed to store agent: {e}"))?;
    let actor_id = actor.map(|agent| agent.id.as_str()).unwrap_or(USER_ACTOR);
    db::insert_agent_change(
        &tx,
        &db::NewAgentChange {
            actor_agent_id: actor_id,
            target_agent_id: &agent.id,
            action: "create",
            summary: &format!("Created {} ({})", agent.name, agent.id),
            before_json: None,
            after_json: Some(after),
            session_id,
            reverted_change_id: None,
            created_at: db::now(),
        },
    )?;
    tx.commit().map_err(|e| format!("Agents db error: {e}"))?;
    Ok(agent)
}

/// Update an agent and write its audit row in one transaction.
pub fn apply_actor_update(
    conn: &mut rusqlite::Connection,
    actor_id: &str,
    session_id: Option<&str>,
    target_id: &str,
    patch: &AgentPatch,
) -> Result<Agent, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Agents db error: {e}"))?;
    let before =
        db::get_agent(&tx, target_id)?.ok_or_else(|| format!("Agent not found: {target_id}"))?;
    let mut patch = patch.clone();
    if let Some(name) = patch.name.as_deref() {
        limit_text("Name", name.trim(), MAX_NAME_CHARS)?;
    }
    if let Some(description) = patch.description.as_deref() {
        limit_text("Description", description.trim(), MAX_DESCRIPTION_CHARS)?;
    }
    if let Some(role) = patch.role_prompt.as_deref() {
        limit_text("Instructions", role.trim(), MAX_ROLE_CHARS)?;
    }
    if let Some(icon) = patch.icon.clone() {
        patch.icon = Some(normalize_icon(&icon, before.builtin)?);
    }
    let after = db::update_agent(&tx, target_id, &patch)?;
    record_agent_diff(&tx, actor_id, session_id, &before, &after)?;
    tx.commit().map_err(|e| format!("Agents db error: {e}"))?;
    Ok(after)
}

/// Delete an agent and write its audit row in one transaction, so a
/// delete without a snapshot to revert to cannot be stored.
pub fn apply_actor_delete(
    conn: &mut rusqlite::Connection,
    actor_id: &str,
    session_id: Option<&str>,
    target_id: &str,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Agents db error: {e}"))?;
    let before =
        db::get_agent(&tx, target_id)?.ok_or_else(|| format!("Agent not found: {target_id}"))?;
    let before_json =
        serde_json::to_string(&before).map_err(|e| format!("Failed to store agent: {e}"))?;
    db::delete_agent(&tx, target_id)?;
    db::insert_agent_change(
        &tx,
        &db::NewAgentChange {
            actor_agent_id: actor_id,
            target_agent_id: target_id,
            action: "delete",
            summary: &format!("Deleted {} ({target_id})", before.name),
            before_json: Some(before_json),
            after_json: None,
            session_id,
            reverted_change_id: None,
            created_at: db::now(),
        },
    )?;
    tx.commit().map_err(|e| format!("Agents db error: {e}"))?;
    Ok(())
}

fn record_agent_diff(
    conn: &rusqlite::Connection,
    actor_id: &str,
    session_id: Option<&str>,
    before: &Agent,
    after: &Agent,
) -> Result<(), String> {
    let Some(summary) = agent_diff_summary(before, after) else {
        return Ok(());
    };
    db::insert_agent_change(
        conn,
        &db::NewAgentChange {
            actor_agent_id: actor_id,
            target_agent_id: &after.id,
            action: "update",
            summary: &summary,
            before_json: Some(snapshot(before)?),
            after_json: Some(snapshot(after)?),
            session_id,
            reverted_change_id: None,
            created_at: db::now(),
        },
    )?;
    Ok(())
}

pub fn record_schedule_change(
    conn: &rusqlite::Connection,
    actor_id: &str,
    action: &str,
    before: Option<&Schedule>,
    after: Option<&Schedule>,
    session_id: Option<&str>,
) -> Result<(), String> {
    let schedule = after
        .or(before)
        .ok_or_else(|| "Missing schedule".to_string())?;
    let summary = match action {
        "schedule_create" => format!("Created schedule {}", schedule.name),
        "schedule_cancel" => format!("Cancelled schedule {}", schedule.name),
        _ => format!("Updated schedule {}", schedule.name),
    };
    db::insert_agent_change(
        conn,
        &db::NewAgentChange {
            actor_agent_id: actor_id,
            target_agent_id: &schedule.agent_id,
            action,
            summary: &summary,
            before_json: before.map(snapshot).transpose()?,
            after_json: after.map(snapshot).transpose()?,
            session_id,
            reverted_change_id: None,
            created_at: db::now(),
        },
    )?;
    Ok(())
}

fn snapshot<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("Failed to store change: {e}"))
}

pub fn agent_diff_summary(before: &Agent, after: &Agent) -> Option<String> {
    let mut parts = Vec::new();
    if before.name != after.name {
        parts.push(format!("name: \"{}\" -> \"{}\"", before.name, after.name));
    }
    if before.description != after.description {
        parts.push("description changed".to_string());
    }
    if before.icon != after.icon {
        parts.push(format!("color: {} -> {}", before.icon, after.icon));
    }
    if before.role_prompt != after.role_prompt {
        parts.push("instructions changed".to_string());
    }
    if before.paused != after.paused {
        parts.push(if after.paused {
            "paused".to_string()
        } else {
            "resumed".to_string()
        });
    }
    if before.max_wakes_per_hour != after.max_wakes_per_hour {
        parts.push(format!(
            "wake budget: {} -> {}",
            before.max_wakes_per_hour, after.max_wakes_per_hour
        ));
    }
    if before.backend != after.backend {
        parts.push(format!(
            "backend: {} -> {}",
            show_opt(before.backend.as_deref()),
            show_opt(after.backend.as_deref())
        ));
    }
    if before.model != after.model {
        parts.push(format!(
            "model: {} -> {}",
            show_opt(before.model.as_deref()),
            show_opt(after.model.as_deref())
        ));
    }
    if before.effort != after.effort {
        parts.push(format!(
            "effort: {} -> {}",
            show_opt(before.effort.as_deref()),
            show_opt(after.effort.as_deref())
        ));
    }
    if before.thinking_level != after.thinking_level {
        parts.push(format!(
            "thinking: {} -> {}",
            show_opt(before.thinking_level.as_deref()),
            show_opt(after.thinking_level.as_deref())
        ));
    }
    if before.skills != after.skills {
        parts.push(format!(
            "skills: {} -> {}",
            before.skills.len(),
            after.skills.len()
        ));
    }
    if before.mcp_servers != after.mcp_servers {
        parts.push("connectors changed".to_string());
    }
    if before.jean_tools != after.jean_tools {
        parts.push("Jean tools changed".to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

fn show_opt(value: Option<&str>) -> &str {
    value.unwrap_or("default")
}

/// Check a patch that changes an agent other than the actor.
pub fn enforce_other_update(
    actor: &Agent,
    target: &Agent,
    patch: &AgentPatch,
) -> Result<(), String> {
    if actor.builtin || actor.id == target.id {
        return Ok(());
    }
    let current = RunGrant {
        backend: target.backend.as_deref(),
        model: target.model.as_deref(),
        effort: target.effort.as_deref(),
        thinking_level: target.thinking_level.as_deref(),
        skills: Some(&target.skills),
    };
    let requested = RunGrant {
        backend: patch.backend.as_ref().and_then(|value| value.as_deref()),
        model: patch.model.as_ref().and_then(|value| value.as_deref()),
        effort: patch.effort.as_ref().and_then(|value| value.as_deref()),
        thinking_level: patch
            .thinking_level
            .as_ref()
            .and_then(|value| value.as_deref()),
        skills: patch.skills.as_deref(),
    };
    check_run_grant(actor, &current, &requested)
}

pub fn revert_change(
    conn: &mut rusqlite::Connection,
    actor_id: &str,
    session_id: Option<&str>,
    change_id: i64,
) -> Result<AgentChange, String> {
    let change = db::get_agent_change(conn, change_id)?
        .ok_or_else(|| format!("Change #{change_id} not found"))?;
    revert_loaded(conn, actor_id, session_id, &change)
}

fn revert_loaded(
    conn: &mut rusqlite::Connection,
    actor_id: &str,
    session_id: Option<&str>,
    change: &AgentChange,
) -> Result<AgentChange, String> {
    let latest = db::latest_agent_change(conn, &change.target_agent_id)?
        .ok_or_else(|| "No changes to revert".to_string())?;
    if latest.id != change.id {
        return Err("Only the latest change for that agent can be reverted".to_string());
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("Agents db error: {e}"))?;
    let (before_json, after_json) = apply_inverse(&tx, change)?;
    let summary = format!("Reverted #{}: {}", change.id, change.summary);
    let stored = db::insert_agent_change(
        &tx,
        &db::NewAgentChange {
            actor_agent_id: actor_id,
            target_agent_id: &change.target_agent_id,
            action: "revert",
            summary: &summary,
            before_json,
            after_json,
            session_id,
            reverted_change_id: Some(change.id),
            created_at: db::now(),
        },
    )?;
    tx.commit().map_err(|e| format!("Agents db error: {e}"))?;
    Ok(stored)
}

fn apply_inverse(
    conn: &rusqlite::Connection,
    change: &AgentChange,
) -> Result<(Option<String>, Option<String>), String> {
    if is_schedule_change(change) {
        return apply_schedule_inverse(conn, change);
    }
    match (&change.before, &change.after) {
        (None, Some(after)) => {
            db::delete_agent(conn, &change.target_agent_id)?;
            Ok((Some(after.to_string()), None))
        }
        (Some(before), None) => {
            ensure_create_capacity(conn, db::now())?;
            let agent: Agent = serde_json::from_value(before.clone())
                .map_err(|e| format!("Stored agent could not be read: {e}"))?;
            let restored = db::insert_agent_snapshot(conn, &agent)?;
            Ok((None, Some(snapshot(&restored)?)))
        }
        (Some(before), Some(current)) => {
            let agent: Agent = serde_json::from_value(before.clone())
                .map_err(|e| format!("Stored agent could not be read: {e}"))?;
            if db::get_agent(conn, &agent.id)?.is_none() {
                return Err(format!("Agent {} no longer exists", agent.id));
            }
            let restored = db::update_agent(conn, &agent.id, &patch_from_agent(&agent))?;
            Ok((Some(current.to_string()), Some(snapshot(&restored)?)))
        }
        (None, None) => Err("That change has nothing to restore".to_string()),
    }
}

fn apply_schedule_inverse(
    conn: &rusqlite::Connection,
    change: &AgentChange,
) -> Result<(Option<String>, Option<String>), String> {
    match (&change.before, &change.after) {
        (None, Some(after)) => {
            let schedule: Schedule = serde_json::from_value(after.clone())
                .map_err(|e| format!("Stored schedule could not be read: {e}"))?;
            if !db::cancel_schedule(conn, &schedule.agent_id, schedule.id)? {
                return Err(format!("Schedule #{} is not active", schedule.id));
            }
            Ok((Some(after.to_string()), None))
        }
        (Some(before), None) => {
            let schedule: Schedule = serde_json::from_value(before.clone())
                .map_err(|e| format!("Stored schedule could not be read: {e}"))?;
            let restored = db::reactivate_schedule(conn, &schedule.agent_id, schedule.id)?;
            Ok((None, Some(snapshot(&restored)?)))
        }
        (Some(before), Some(current)) => {
            let schedule: Schedule = serde_json::from_value(before.clone())
                .map_err(|e| format!("Stored schedule could not be read: {e}"))?;
            let timing = db::ScheduleTiming {
                every_secs: schedule.every_secs,
                cron: schedule.cron.clone(),
                timezone: schedule.timezone.clone(),
                event: schedule.event.clone(),
                next_run_at: schedule.next_run_at,
            };
            let restored = db::update_schedule(
                conn,
                &schedule.agent_id,
                schedule.id,
                Some(&schedule.name),
                Some(&schedule.prompt),
                Some(schedule.paused),
                Some(&timing),
            )?;
            Ok((Some(current.to_string()), Some(snapshot(&restored)?)))
        }
        (None, None) => Err("That change has nothing to restore".to_string()),
    }
}

fn is_schedule_change(change: &AgentChange) -> bool {
    change.action.starts_with("schedule_")
        || change.before.as_ref().is_some_and(looks_like_schedule)
        || change.after.as_ref().is_some_and(looks_like_schedule)
}

fn looks_like_schedule(value: &Value) -> bool {
    value.get("nextRunAt").is_some() && value.get("rolePrompt").is_none()
}

fn patch_from_agent(agent: &Agent) -> AgentPatch {
    AgentPatch {
        name: Some(agent.name.clone()),
        description: Some(agent.description.clone()),
        icon: Some(agent.icon.clone()),
        role_prompt: Some(agent.role_prompt.clone()),
        paused: Some(agent.paused),
        max_wakes_per_hour: Some(agent.max_wakes_per_hour),
        backend: Some(agent.backend.clone()),
        model: Some(agent.model.clone()),
        effort: Some(agent.effort.clone()),
        thinking_level: Some(agent.thinking_level.clone()),
        skills: Some(agent.skills.clone()),
        mcp_servers: Some(agent.mcp_servers.clone()),
        jean_tools: Some(agent.jean_tools.clone()),
    }
}

// ============================================================================
// MCP tools
// ============================================================================

pub async fn run_tool(
    app: &AppHandle,
    name: &str,
    args: &Value,
    source: &str,
    actor: &Agent,
    approved: bool,
) -> Result<Value, String> {
    let result = match name {
        "agent_list" => list_tool(app, actor),
        "agent_create" => create_tool(app, args, source, actor).await,
        "agent_update" => update_tool(app, args, source, actor, approved).await,
        "agent_delete" => delete_tool(app, args, source, actor, approved).await,
        "agent_revert" => revert_tool(app, args, source, actor, approved).await,
        other => Err(format!("Unknown agent tool: {other}")),
    }?;
    let agent_id = result
        .get("agent")
        .and_then(|agent| agent.get("id"))
        .and_then(Value::as_str)
        .or_else(|| {
            result
                .get("change")
                .and_then(|change| change.get("targetAgentId"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    if let Some(agent_id) = agent_id {
        if let Some(agent) = super::with_db(app, |conn| db::get_agent(conn, &agent_id))? {
            let pausing = args.get("paused").and_then(Value::as_bool) == Some(true);
            let run_config =
                name == "agent_create" || name == "agent_revert" || tool_changes_run(args);
            super::commands::settle_agent_update(app, &agent, pausing, run_config).await;
        }
    }
    Ok(result)
}

pub async fn run_approved(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    let actor_id = required_str(args, "actorAgentId")?;
    let actor = super::with_db(app, |conn| {
        db::get_agent(conn, &actor_id)?.ok_or_else(|| format!("Unknown agent: {actor_id}"))
    })?;
    run_tool(
        app,
        name,
        args,
        super::mcp::APPROVED_REPLAY_SOURCE,
        &actor,
        true,
    )
    .await
}

fn tool_changes_run(args: &Value) -> bool {
    ["backend", "model", "effort", "thinkingLevel", "skills"]
        .iter()
        .any(|key| args.get(key).is_some())
}

fn list_tool(app: &AppHandle, actor: &Agent) -> Result<Value, String> {
    let agents = super::with_db(app, |conn| db::list_agents(conn))?;
    let items: Vec<Value> = agents
        .iter()
        .map(|agent| {
            let mut item = json!({
                "id": agent.id,
                "name": agent.name,
                "description": agent.description,
                "icon": agent.icon,
                "paused": agent.paused,
                "builtin": agent.builtin,
                "backend": agent.backend,
                "model": agent.model,
                "effort": agent.effort,
                "thinkingLevel": agent.thinking_level,
            });
            if agent.id == actor.id {
                item["instructions"] = json!(agent.role_prompt);
                item["skills"] = json!(agent.skills);
                item["self"] = json!(true);
            }
            item
        })
        .collect();
    Ok(json!({ "agents": items }))
}

async fn create_tool(
    app: &AppHandle,
    args: &Value,
    source: &str,
    actor: &Agent,
) -> Result<Value, String> {
    let name = required_str(args, "name")?;
    let description = str_arg(args, "description").unwrap_or_default();
    let icon = str_arg(args, "icon")
        .or_else(|| str_arg(args, "color"))
        .unwrap_or_else(|| "blue".to_string());
    if args.get("icon").is_some() && args.get("color").is_some() {
        let icon_value = str_arg(args, "icon");
        let color_value = str_arg(args, "color");
        if icon_value != color_value {
            return Err("Use either icon or color".to_string());
        }
    }
    let role_prompt = optional_text(args, "instructions")
        .or_else(|| optional_text(args, "rolePrompt"))
        .unwrap_or_default();
    let config = AgentRunConfig {
        backend: clearable_string(args, "backend")?.flatten(),
        model: clearable_string(args, "model")?.flatten(),
        effort: clearable_string(args, "effort")?.flatten(),
        thinking_level: clearable_string(args, "thinkingLevel")?.flatten(),
        skills: skills_arg(args)?.unwrap_or_default(),
    };
    let schedules = initial_schedules(args)?;
    let paused = bool_arg(args, "paused")?.unwrap_or(false);
    let input = CreateInput {
        name,
        description,
        icon,
        role_prompt,
        config,
        paused,
        schedules,
    };
    let agent = super::with_db(app, |conn| {
        create_for_actor(conn, Some(actor), Some(source), &input)
    })?;
    Ok(json!({ "agent": agent }))
}

async fn update_tool(
    app: &AppHandle,
    args: &Value,
    source: &str,
    actor: &Agent,
    approved: bool,
) -> Result<Value, String> {
    let target_id = str_arg(args, "agentId").unwrap_or_else(|| actor.id.clone());
    let patch = normalize_patch(&patch_from_args(args)?)?;
    if patch_is_empty(&patch) {
        return Err("Nothing to update".to_string());
    }
    let target = super::with_db(app, |conn| {
        db::get_agent(conn, &target_id)?.ok_or_else(|| format!("Unknown agent: {target_id}"))
    })?;
    if !approved && update_requires_approval(actor, &target.id) {
        return approval_pending(app, actor, source, "agent_update", args, &target.name);
    }
    enforce_other_update(actor, &target, &patch)?;
    let session = (!approved).then_some(source);
    let agent = super::with_db(app, |conn| {
        apply_actor_update(conn, &actor.id, session, &target.id, &patch)
    })?;
    Ok(json!({ "agent": agent }))
}

async fn delete_tool(
    app: &AppHandle,
    args: &Value,
    source: &str,
    actor: &Agent,
    approved: bool,
) -> Result<Value, String> {
    let target_id = required_str(args, "agentId")?;
    let target = super::with_db(app, |conn| {
        db::get_agent(conn, &target_id)?.ok_or_else(|| format!("Unknown agent: {target_id}"))
    })?;
    if target.builtin {
        return Err("Built-in agents cannot be deleted".to_string());
    }
    if !approved && delete_requires_approval(actor, &target) {
        return approval_pending(app, actor, source, "agent_delete", args, &target.name);
    }
    let session = (!approved).then_some(source);
    super::with_db(app, |conn| {
        apply_actor_delete(conn, &actor.id, session, &target.id)
    })?;
    Ok(json!({ "deleted": true, "agentId": target.id }))
}

async fn revert_tool(
    app: &AppHandle,
    args: &Value,
    source: &str,
    actor: &Agent,
    approved: bool,
) -> Result<Value, String> {
    let target_id = str_arg(args, "agentId").unwrap_or_else(|| actor.id.clone());
    let change = super::with_db(app, |conn| {
        db::latest_agent_change(conn, &target_id)?
            .ok_or_else(|| format!("No changes for {target_id}"))
    })?;
    if !approved && revert_requires_approval(actor, &target_id, &change) {
        let name = super::with_db(app, |conn| {
            Ok(db::get_agent(conn, &target_id)?
                .map(|agent| agent.name)
                .unwrap_or_else(|| target_id.clone()))
        })?;
        // Pin the change the user approves. A newer change makes the replay fail.
        let mut stored = args.clone();
        if let Some(obj) = stored.as_object_mut() {
            obj.insert("changeId".to_string(), json!(change.id));
        }
        return approval_pending(app, actor, source, "agent_revert", &stored, &name);
    }
    let change_id = if approved {
        args.get("changeId")
            .and_then(Value::as_i64)
            .unwrap_or(change.id)
    } else {
        change.id
    };
    let session = (!approved).then_some(source);
    let stored = super::with_db(app, |conn| {
        revert_change(conn, &actor.id, session, change_id)
    })?;
    Ok(json!({ "reverted": true, "change": stored }))
}

fn approval_pending(
    app: &AppHandle,
    actor: &Agent,
    source: &str,
    tool: &str,
    args: &Value,
    target_name: &str,
) -> Result<Value, String> {
    let mut stored = args.clone();
    if let Some(obj) = stored.as_object_mut() {
        obj.insert("actorAgentId".to_string(), json!(actor.id));
        obj.insert("targetName".to_string(), json!(target_name));
    }
    let id = super::with_db(app, |conn| {
        db::create_approval(conn, &actor.id, Some(source), tool, &stored)
    })?;
    Ok(json!({
        "approvalRequired": true,
        "approvalId": id,
        "status": "waiting_for_user",
        "message": format!(
            "{tool} needs the user's approval (request #{id}). Tell the user and end your turn. The result arrives as an update message."
        ),
    }))
}

fn patch_from_args(args: &Value) -> Result<AgentPatch, String> {
    let mut patch = AgentPatch::default();
    if let Some(name) = str_arg(args, "name") {
        patch.name = Some(name);
    }
    if args.get("description").is_some() {
        patch.description = Some(optional_text(args, "description").unwrap_or_default());
    }
    if args.get("instructions").is_some() || args.get("rolePrompt").is_some() {
        let text = optional_text(args, "instructions")
            .or_else(|| optional_text(args, "rolePrompt"))
            .unwrap_or_default();
        patch.role_prompt = Some(text);
    }
    if args.get("icon").is_some() || args.get("color").is_some() {
        let icon = str_arg(args, "icon").or_else(|| str_arg(args, "color"));
        let color = str_arg(args, "color");
        if args.get("icon").is_some() && args.get("color").is_some() && icon != color {
            return Err("Use either icon or color".to_string());
        }
        patch.icon = icon.or(color);
    }
    if let Some(paused) = bool_arg(args, "paused")? {
        patch.paused = Some(paused);
    }
    if let Some(value) = clearable_string(args, "backend")? {
        patch.backend = Some(value);
    }
    if let Some(value) = clearable_string(args, "model")? {
        patch.model = Some(value);
    }
    if let Some(value) = clearable_string(args, "effort")? {
        patch.effort = Some(value);
    }
    if let Some(value) = clearable_string(args, "thinkingLevel")? {
        patch.thinking_level = Some(value);
    }
    if let Some(skills) = skills_arg(args)? {
        patch.skills = Some(skills);
    }
    Ok(patch)
}

fn patch_is_empty(patch: &AgentPatch) -> bool {
    patch.name.is_none()
        && patch.description.is_none()
        && patch.icon.is_none()
        && patch.role_prompt.is_none()
        && patch.paused.is_none()
        && patch.max_wakes_per_hour.is_none()
        && patch.backend.is_none()
        && patch.model.is_none()
        && patch.effort.is_none()
        && patch.thinking_level.is_none()
        && patch.skills.is_none()
        && patch.mcp_servers.is_none()
        && patch.jean_tools.is_none()
}

fn initial_schedules(args: &Value) -> Result<Vec<InitialSchedule>, String> {
    let Some(value) = args.get("schedules") else {
        return Ok(Vec::new());
    };
    let list = value
        .as_array()
        .ok_or_else(|| "schedules must be an array".to_string())?;
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "Each schedule needs a name".to_string())?
            .to_string();
        let prompt = item
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "Each schedule needs a prompt".to_string())?
            .to_string();
        let timing = super::mcp::timing_from_tool_args(item, db::now())?;
        out.push(InitialSchedule {
            name,
            prompt,
            timing,
        });
    }
    Ok(out)
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_text(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn required_str(args: &Value, key: &str) -> Result<String, String> {
    str_arg(args, key).ok_or_else(|| format!("Missing required argument: {key}"))
}

fn bool_arg(args: &Value, key: &str) -> Result<Option<bool>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| format!("{key} must be a boolean")),
    }
}

/// `None` = key missing. `Some(None)` = JSON null (clear). `Some(Some)` = set.
fn clearable_string(args: &Value, key: &str) -> Result<Option<Option<String>>, String> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(Some(None))
            } else {
                Ok(Some(Some(trimmed.to_string())))
            }
        }
        Some(_) => Err(format!("{key} must be a string or null")),
    }
}

fn skills_arg(args: &Value) -> Result<Option<Vec<AgentSkill>>, String> {
    match args.get("skills") {
        None => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|e| format!("Invalid skills: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        conn
    }

    fn sample(id: &str, builtin: bool) -> Agent {
        Agent {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            icon: if builtin {
                "jean".into()
            } else {
                "blue".into()
            },
            role_prompt: String::new(),
            worktree_id: db::agent_worktree_id(id),
            paused: false,
            max_wakes_per_hour: 12,
            builtin,
            backend: None,
            model: None,
            effort: None,
            thinking_level: None,
            skills: Vec::new(),
            mcp_servers: None,
            jean_tools: None,
        }
    }

    fn skill(path: &str) -> AgentSkill {
        AgentSkill {
            name: "skill".into(),
            path: path.into(),
            backend: None,
        }
    }

    #[test]
    fn permission_rules_keep_other_agents_behind_approval() {
        let jean = sample(db::JEAN_AGENT_ID, true);
        let alpha = sample("alpha", false);
        let beta = sample("beta", false);
        assert!(!update_requires_approval(&jean, "alpha"));
        assert!(!update_requires_approval(&alpha, "alpha"));
        assert!(update_requires_approval(&alpha, "beta"));
        assert!(update_requires_approval(&alpha, db::JEAN_AGENT_ID));
        assert!(!delete_requires_approval(&jean, &alpha));
        assert!(delete_requires_approval(&alpha, &beta));
        assert!(delete_requires_approval(&alpha, &alpha));
        assert!(!delete_requires_approval(&alpha, &jean));
    }

    #[test]
    fn revert_of_another_agent_or_own_creation_needs_approval() {
        let jean = sample(db::JEAN_AGENT_ID, true);
        let alpha = sample("alpha", false);
        let create = AgentChange {
            id: 1,
            actor_agent_id: "alpha".into(),
            target_agent_id: "beta".into(),
            action: "create".into(),
            summary: "Created".into(),
            before: None,
            after: Some(json!({"id": "beta"})),
            session_id: None,
            created_at: 0,
            reverted_change_id: None,
        };
        let update = AgentChange {
            action: "update".into(),
            before: Some(json!({"name": "a"})),
            after: Some(json!({"name": "b"})),
            target_agent_id: "alpha".into(),
            ..create.clone()
        };
        let schedule = AgentChange {
            action: "schedule_create".into(),
            before: None,
            after: Some(json!({"id": 3, "nextRunAt": 10})),
            target_agent_id: "alpha".into(),
            ..create.clone()
        };
        assert!(!revert_requires_approval(&jean, "beta", &create));
        assert!(revert_requires_approval(&alpha, "beta", &create));
        assert!(!revert_requires_approval(&alpha, "alpha", &update));
        assert!(!revert_requires_approval(&alpha, "alpha", &schedule));
        let own_create = AgentChange {
            target_agent_id: "alpha".into(),
            ..create
        };
        assert!(revert_requires_approval(&alpha, "alpha", &own_create));
    }

    #[test]
    fn escalation_blocks_a_stronger_child_and_lets_jean_through() {
        let mut creator = sample("alpha", false);
        creator.backend = Some("claude".into());
        creator.model = Some("claude-sonnet".into());
        creator.effort = Some("medium".into());
        creator.thinking_level = Some("think".into());
        creator.skills = vec![skill("/skills/review/SKILL.md")];
        let empty = RunGrant::default();
        let ok = RunGrant {
            backend: Some("claude"),
            model: Some("claude-sonnet"),
            effort: Some("low"),
            thinking_level: Some("off"),
            skills: Some(&creator.skills),
        };
        assert!(check_run_grant(&creator, &empty, &ok).is_ok());
        let stronger = RunGrant {
            effort: Some("high"),
            ..RunGrant::default()
        };
        assert!(check_run_grant(&creator, &empty, &stronger)
            .unwrap_err()
            .contains("effort high"));
        let other_backend = RunGrant {
            backend: Some("codex"),
            ..RunGrant::default()
        };
        assert!(check_run_grant(&creator, &empty, &other_backend).is_err());
        let extra = vec![skill("/skills/secret/SKILL.md")];
        let extra_grant = RunGrant {
            skills: Some(&extra),
            ..RunGrant::default()
        };
        assert!(check_run_grant(&creator, &empty, &extra_grant)
            .unwrap_err()
            .contains("secret"));
        let jean = sample(db::JEAN_AGENT_ID, true);
        assert!(check_run_grant(&jean, &empty, &stronger).is_ok());
    }

    #[test]
    fn keeping_an_existing_value_is_not_escalation() {
        let mut creator = sample("alpha", false);
        creator.effort = Some("low".into());
        let mut target = sample("beta", false);
        target.effort = Some("high".into());
        target.skills = vec![skill("/skills/only-on-target/SKILL.md")];
        let err = enforce_other_update(
            &creator,
            &target,
            &AgentPatch {
                effort: Some(Some("high".into())),
                skills: Some(target.skills.clone()),
                ..AgentPatch::default()
            },
        );
        assert!(err.is_ok(), "{err:?}");
        let raised = enforce_other_update(
            &creator,
            &target,
            &AgentPatch {
                effort: Some(Some("max".into())),
                ..AgentPatch::default()
            },
        );
        assert!(raised.is_err());
    }

    #[test]
    fn limits_count_total_agents_and_creates_in_the_last_hour() {
        let mut conn = memory_db();
        for index in 0..MAX_USER_AGENTS {
            db::create_agent(
                &conn,
                &format!("Agent {index}"),
                "",
                "blue",
                "",
                &AgentRunConfig::default(),
            )
            .unwrap();
        }
        let input = CreateInput {
            name: "One more".into(),
            description: String::new(),
            icon: "blue".into(),
            role_prompt: String::new(),
            config: AgentRunConfig::default(),
            paused: false,
            schedules: Vec::new(),
        };
        assert!(create_for_actor(&mut conn, None, None, &input)
            .unwrap_err()
            .contains("Agent limit"));

        let mut conn = memory_db();
        let now = db::now();
        for index in 0..MAX_AGENT_CREATES_PER_HOUR {
            db::insert_agent_change(
                &conn,
                &db::NewAgentChange {
                    actor_agent_id: USER_ACTOR,
                    target_agent_id: &format!("gone-{index}"),
                    action: "create",
                    summary: "Created",
                    before_json: None,
                    after_json: None,
                    session_id: None,
                    reverted_change_id: None,
                    created_at: now,
                },
            )
            .unwrap();
        }
        assert!(create_for_actor(&mut conn, None, None, &input)
            .unwrap_err()
            .contains("Hourly"));
        assert_eq!(db::count_user_agents(&conn).unwrap(), 0);
    }

    #[test]
    fn audit_stores_before_and_after_and_revert_restores_the_last_change() {
        let mut conn = memory_db();
        let created = create_for_actor(
            &mut conn,
            None,
            None,
            &CreateInput {
                name: "Release".into(),
                description: "Ships".into(),
                icon: "green".into(),
                role_prompt: "Ship it".into(),
                config: AgentRunConfig {
                    effort: Some("low".into()),
                    ..AgentRunConfig::default()
                },
                paused: false,
                schedules: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(created.icon, "green");
        assert_eq!(created.effort.as_deref(), Some("low"));
        let updated = apply_actor_update(
            &mut conn,
            USER_ACTOR,
            None,
            &created.id,
            &AgentPatch {
                name: Some("Shipper".into()),
                role_prompt: Some("Ship carefully".into()),
                ..AgentPatch::default()
            },
        )
        .unwrap();
        assert_eq!(updated.name, "Shipper");
        let changes = db::list_agent_changes(&conn, &created.id, 10).unwrap();
        assert_eq!(changes.len(), 2);
        let update = &changes[0];
        assert_eq!(update.action, "update");
        assert_eq!(update.before.as_ref().unwrap()["name"], "Release");
        assert_eq!(update.after.as_ref().unwrap()["name"], "Shipper");
        assert_eq!(update.before.as_ref().unwrap()["rolePrompt"], "Ship it");
        assert!(update.summary.contains("name:"));
        assert!(update.summary.contains("instructions changed"));

        let reverted = revert_change(&mut conn, USER_ACTOR, None, update.id).unwrap();
        assert_eq!(reverted.action, "revert");
        assert_eq!(reverted.reverted_change_id, Some(update.id));
        let restored = db::get_agent(&conn, &created.id).unwrap().unwrap();
        assert_eq!(restored.name, "Release");
        assert_eq!(restored.role_prompt, "Ship it");
        assert!(revert_change(&mut conn, USER_ACTOR, None, update.id).is_err());
    }

    #[test]
    fn a_child_cannot_outrank_its_creator_and_self_update_can() {
        let mut conn = memory_db();
        let mut parent = db::get_agent(&conn, db::JEAN_AGENT_ID).unwrap().unwrap();
        parent.builtin = false;
        parent.effort = Some("medium".into());
        parent.skills = vec![skill("/skills/review/SKILL.md")];
        let err = create_for_actor(
            &mut conn,
            Some(&parent),
            None,
            &CreateInput {
                name: "Stronger".into(),
                description: String::new(),
                icon: "blue".into(),
                role_prompt: String::new(),
                config: AgentRunConfig {
                    effort: Some("high".into()),
                    ..AgentRunConfig::default()
                },
                paused: false,
                schedules: Vec::new(),
            },
        );
        assert!(err.unwrap_err().contains("effort high"));
        let child = create_for_actor(
            &mut conn,
            Some(&parent),
            None,
            &CreateInput {
                name: "Helper".into(),
                description: String::new(),
                icon: "blue".into(),
                role_prompt: "Help".into(),
                config: AgentRunConfig {
                    effort: Some("low".into()),
                    skills: vec![skill("/skills/review/SKILL.md")],
                    ..AgentRunConfig::default()
                },
                paused: false,
                schedules: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(child.effort.as_deref(), Some("low"));
        assert_eq!(child.max_wakes_per_hour, parent.max_wakes_per_hour);
        let raised = apply_actor_update(
            &mut conn,
            &child.id,
            None,
            &child.id,
            &AgentPatch {
                effort: Some(Some("max".into())),
                ..AgentPatch::default()
            },
        )
        .unwrap();
        assert_eq!(raised.effort.as_deref(), Some("max"));
    }

    #[test]
    fn a_child_keeps_the_creators_connector_and_tool_limits() {
        let mut conn = memory_db();
        let mut parent = db::get_agent(&conn, db::JEAN_AGENT_ID).unwrap().unwrap();
        parent.builtin = false;
        parent.mcp_servers = Some(vec![db::AgentConnector {
            backend: "claude".into(),
            name: "orbit".into(),
        }]);
        parent.jean_tools = Some(vec!["notify_user".into()]);
        let child = create_for_actor(
            &mut conn,
            Some(&parent),
            None,
            &CreateInput {
                name: "Helper".into(),
                description: String::new(),
                icon: "blue".into(),
                role_prompt: String::new(),
                config: AgentRunConfig::default(),
                paused: false,
                schedules: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(child.mcp_servers, parent.mcp_servers);
        assert_eq!(child.jean_tools, parent.jean_tools);
    }

    #[test]
    fn revert_of_a_schedule_create_cancels_it() {
        let mut conn = memory_db();
        let timing = db::validate_schedule_timing(
            Some(3600),
            None,
            None,
            None,
            Some(db::now() + 3600),
            db::now(),
        )
        .unwrap();
        let schedule =
            db::insert_schedule(&conn, db::JEAN_AGENT_ID, "Daily", "Check", &timing, false)
                .unwrap();
        record_schedule_change(
            &conn,
            db::JEAN_AGENT_ID,
            "schedule_create",
            None,
            Some(&schedule),
            None,
        )
        .unwrap();
        let change = db::latest_agent_change(&conn, db::JEAN_AGENT_ID)
            .unwrap()
            .unwrap();
        revert_change(&mut conn, USER_ACTOR, None, change.id).unwrap();
        assert!(db::list_schedules(&conn, db::JEAN_AGENT_ID)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_pinned_revert_fails_when_a_newer_change_landed() {
        let mut conn = memory_db();
        let agent =
            db::create_agent(&conn, "Pinned", "", "blue", "", &AgentRunConfig::default()).unwrap();
        let rename = |conn: &mut Connection, name: &str| {
            let patch = AgentPatch {
                name: Some(name.into()),
                ..AgentPatch::default()
            };
            apply_actor_update(conn, USER_ACTOR, None, &agent.id, &patch).unwrap();
        };
        rename(&mut conn, "First");
        let approved = db::latest_agent_change(&conn, &agent.id).unwrap().unwrap();
        rename(&mut conn, "Second");
        assert!(revert_change(&mut conn, USER_ACTOR, None, approved.id)
            .unwrap_err()
            .contains("Only the latest change"));
        let kept = db::get_agent(&conn, &agent.id).unwrap().unwrap();
        assert_eq!(kept.name, "Second");
    }

    #[test]
    fn a_failed_audit_write_rolls_back_the_update_and_the_delete() {
        let mut conn = memory_db();
        let agent =
            db::create_agent(&conn, "Keep", "", "blue", "", &AgentRunConfig::default()).unwrap();
        conn.execute_batch("DROP TABLE agent_changes").unwrap();
        let patch = AgentPatch {
            name: Some("Renamed".into()),
            ..AgentPatch::default()
        };
        assert!(apply_actor_update(&mut conn, USER_ACTOR, None, &agent.id, &patch).is_err());
        assert!(apply_actor_delete(&mut conn, USER_ACTOR, None, &agent.id).is_err());
        let kept = db::get_agent(&conn, &agent.id).unwrap().unwrap();
        assert_eq!(kept.name, "Keep");
    }

    #[test]
    fn unknown_colors_are_rejected() {
        assert!(normalize_icon("jean", false).is_err());
        assert_eq!(normalize_icon("jean", true).unwrap(), "jean");
        assert_eq!(normalize_icon(" Blue ", false).unwrap(), "blue");
        assert!(normalize_icon("red", false).is_err());
    }
}
