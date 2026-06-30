use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::naming::{spawn_naming_task, NamingRequest};
use super::registry::{cancel_process, cancel_process_if_running};
use super::run_log;
use super::storage::{
    cleanup_combined_context_files, delete_session_data, get_base_index_path, get_data_dir,
    get_index_path, get_session_dir, load_metadata, load_sessions, save_metadata,
    with_existing_metadata_mut, with_sessions_mut,
};
use super::types::{
    AllSessionsEntry, AllSessionsResponse, Backend, ChatMessage, ClaudeContext, EffortLevel,
    LabelData, MessageRole, RunStatus, Session, ThinkingLevel, WorktreeIndex, WorktreeSessions,
};
use crate::claude_cli::resolve_cli_binary;
use crate::http_server::EmitExt;
use crate::projects::github_issues::{
    add_issue_reference, add_pr_reference, get_session_issue_refs, get_session_pr_refs,
};
use crate::projects::storage::load_projects_data;
use crate::projects::types::SessionType;

const QUEUE_DEFAULT_ALLOWED_TOOLS: [&str; 4] = ["Bash(git:*)", "Read", "Glob", "Grep"];
const IMAGE_ONLY_DEFAULT_PROMPT: &str = "Please check this image and tell me what is wrong.";
const TEXT_ONLY_DEFAULT_PROMPT: &str = "Please check the attached text as reference.";
const CODEX_DEFAULT_NOT_PLAN_MODE_PROMPT: &str = "\
## Not Plan Mode

- **VERY IMPORTANT: Keep Code Simple**: Do not over-engineer. Always implement the simplest maintainable solution. Avoid extra abstractions, frameworks, configuration, or future-proofing unless clearly required.
- **Clickable References**: When output mentions issues, PRs, security advisories/alerts, Linear issues, or other external resources, include clickable links when available so users can open them directly.
- After each finished task, please write a few bullet points on how to test the changes.
- When multiple independent operations are needed, batch them into parallel tool calls. Launch independent Task subagents simultaneously rather than sequentially.
- When specifying subagent_type for Task tool calls, always use the fully qualified name exactly as listed in the system prompt (e.g., \"code-simplifier:code-simplifier\", not just \"code-simplifier\"). If the agent type contains a colon, include the full namespace:name string.

## Jean Worktree Policy

- Do NOT create git worktrees manually (`git worktree add`, Superpowers `using-git-worktrees`, or similar) unless the user explicitly asks for a new worktree.
- If a new worktree is explicitly required, use Jean's worktree features through Jean MCP/tools, not raw git worktree commands.
- If already in a Jean worktree or base/main workspace, continue in the current workspace.";
const CODEX_DEFAULT_PLAN_MODE_PROMPT: &str = "\
## Plan Mode

- You are in PLAN MODE. Do not implement yet.
- Inspect the project as needed, then present the plan with the native Codex plan tool (`update_plan` / `CodexPlan`) so Jean can show the approval UI.
- Every plan-mode response that contains or revises a plan must use `update_plan` / `CodexPlan`; do not provide a plain-text-only plan.
- If questions block the plan, prefer Codex `request_user_input`; after the user answers, call `update_plan` / `CodexPlan` again with the revised plan.
- Do not call implementation tools or make file changes until the user approves the plan.";
const DEFAULT_PARALLEL_EXECUTION_PROMPT: &str = r#"In plan mode, structure plans so subagents can work simultaneously. In build/execute mode, use subagents in parallel for faster implementation.

When launching multiple Task subagents, prefer sending them in a single message rather than sequentially. Group independent work items (e.g., editing separate files, researching unrelated questions) into parallel Task calls. Only sequence Tasks when one depends on another's output.

Instruct each sub-agent to briefly outline its approach before implementing, so it can course-correct early without formal plan mode overhead.

When specifying subagent_type for Task tool calls, always use the fully qualified name exactly as listed in the system prompt (e.g., "code-simplifier:code-simplifier", not just "code-simplifier"). If the agent type contains a colon, include the full namespace:name string."#;

/// Sessions currently being drained by the backend queue processor.
///
/// The persisted queue is still the source of truth; this in-memory guard only
/// prevents this process from spawning two backend drain loops for one session.
static BACKEND_QUEUE_DRAINING: Lazy<Mutex<HashSet<String>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

/// Sessions with a `send_chat_message` call currently in flight.
///
/// The registry-based "actively managed" guard only catches duplicates after a
/// process/turn is registered, leaving a window where two concurrent sends
/// (frontend queue processor vs backend queue drain vs another client) both
/// pass the check and spawn duplicate runs. This claim is taken atomically at
/// `send_chat_message` entry and held for the whole call.
static ACTIVE_SENDS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// RAII claim on a session's send slot — released on drop (any return path).
struct SendClaim(String);

impl SendClaim {
    fn try_acquire(session_id: &str) -> Option<Self> {
        let mut active = ACTIVE_SENDS.lock().unwrap();
        if active.insert(session_id.to_string()) {
            Some(Self(session_id.to_string()))
        } else {
            None
        }
    }
}

impl Drop for SendClaim {
    fn drop(&mut self) {
        ACTIVE_SENDS.lock().unwrap().remove(&self.0);
    }
}

fn should_forward_cancel_request(session_id: &str) -> bool {
    ACTIVE_SENDS.lock().unwrap().contains(session_id)
        || super::registry::is_session_actively_managed(session_id)
}

fn clear_stale_pending_cancel_before_send(session_id: &str) {
    let has_active_send = ACTIVE_SENDS.lock().unwrap().contains(session_id);
    if !has_active_send
        && !super::registry::is_session_actively_managed(session_id)
        && super::registry::clear_pending_cancel(session_id)
    {
        log::warn!("Cleared stale pending cancel before fresh send: {session_id}");
    }
}

fn codex_execution_mode_instruction(execution_mode: Option<&str>) -> Option<&'static str> {
    match execution_mode.unwrap_or("plan") {
        "build" => Some(
            "You are in BUILD MODE. Start implementing immediately. \
             This current BUILD MODE instruction supersedes any earlier plan-mode \
             instructions remembered from conversation history; treat the approved plan \
             as authorization to implement now. \
             Do NOT call update_plan/emit CodexPlan unless the user explicitly asks \
             for a new plan. If a required decision is missing, use request_user_input \
             instead of switching back to plan mode.",
        ),
        "yolo" => Some(
            "You are in YOLO EXECUTION MODE. Start implementing immediately. \
             This current YOLO EXECUTION MODE instruction supersedes any earlier plan-mode \
             instructions remembered from conversation history; treat the approved plan \
             as authorization to implement now. \
             Do NOT call update_plan/emit CodexPlan unless the user explicitly asks \
             for a new plan. Do not ask for confirmation before routine implementation steps. \
             If a required decision is missing, use request_user_input instead of \
             switching back to plan mode.",
        ),
        _ => None,
    }
}

fn codex_default_global_system_prompt(execution_mode: Option<&str>) -> String {
    match execution_mode.unwrap_or("plan") {
        "build" | "yolo" => CODEX_DEFAULT_NOT_PLAN_MODE_PROMPT.to_string(),
        _ => CODEX_DEFAULT_PLAN_MODE_PROMPT.to_string(),
    }
}

fn is_codex_default_global_system_prompt(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return true;
    }

    trimmed == crate::default_global_system_prompt().trim()
        || trimmed == CODEX_DEFAULT_PLAN_MODE_PROMPT.trim()
        || trimmed == CODEX_DEFAULT_NOT_PLAN_MODE_PROMPT.trim()
        || (trimmed.contains("### 1. Plan Mode Default")
            && trimmed.contains("Every Codex plan-mode response")
            && trimmed.contains("Jean Worktree Policy"))
}

fn resolve_codex_global_system_prompt(
    preferences_prompt: Option<&str>,
    execution_mode: Option<&str>,
) -> String {
    preferences_prompt
        .map(str::trim)
        .filter(|prompt| !is_codex_default_global_system_prompt(prompt))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| codex_default_global_system_prompt(execution_mode))
}

fn append_codex_execution_mode_instruction(parts: &mut Vec<String>, execution_mode: Option<&str>) {
    if let Some(mode_instruction) = codex_execution_mode_instruction(execution_mode) {
        parts.push(mode_instruction.to_string());
    }
}

/// Resolve the default backend from preferences + project settings (sync).
/// Falls back to Claude if preferences can't be loaded.
pub(crate) fn resolve_default_backend(app: &AppHandle, worktree_id: Option<&str>) -> Backend {
    // Read preferences file synchronously (avoid async in sync contexts)
    let prefs_backend = crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<crate::AppPreferences>(&contents).ok())
        .map(|p| p.default_backend)
        .unwrap_or_else(|| "claude".to_string());

    let mut resolved = match prefs_backend.as_str() {
        "codex" => Backend::Codex,
        "opencode" => Backend::Opencode,
        "cursor" => Backend::Cursor,
        "pi" => Backend::Pi,
        "commandcode" => Backend::Commandcode,
        "grok" => Backend::Grok,
        _ => Backend::Claude,
    };

    // Check project-level override if worktree_id is provided
    if let Some(wt_id) = worktree_id {
        if let Ok(data) = load_projects_data(app) {
            if let Some(project) = data.projects.iter().find(|p| {
                !p.is_folder
                    && data
                        .worktrees
                        .iter()
                        .any(|w| w.id == wt_id && w.project_id == p.id)
            }) {
                if let Some(ref pb) = project.default_backend {
                    resolved = match pb.as_str() {
                        "codex" => Backend::Codex,
                        "opencode" => Backend::Opencode,
                        "cursor" => Backend::Cursor,
                        "pi" => Backend::Pi,
                        "commandcode" => Backend::Commandcode,
                        "grok" => Backend::Grok,
                        "claude" => Backend::Claude,
                        _ => resolved,
                    };
                }
            }
        }
    }

    resolved
}

/// Resolve backend for a magic prompt operation.
/// Priority: per-operation backend > project default > global default > Claude.
pub(crate) fn resolve_magic_prompt_backend(
    app: &AppHandle,
    magic_backend: Option<&str>,
    worktree_id: Option<&str>,
) -> Backend {
    if let Some(b) = magic_backend.filter(|s| !s.is_empty()) {
        match b {
            "opencode" => return Backend::Opencode,
            "cursor" => return Backend::Cursor,
            "pi" => return Backend::Pi,
            "commandcode" => return Backend::Commandcode,
            "grok" => return Backend::Grok,
            "codex" => return Backend::Codex,
            "claude" => return Backend::Claude,
            _ => {}
        }
    }
    resolve_default_backend(app, worktree_id)
}

fn infer_backend_from_model(model: &str, fallback: Backend) -> Backend {
    if crate::is_cursor_model(model) {
        Backend::Cursor
    } else if crate::is_pi_model(model) {
        Backend::Pi
    } else if crate::is_opencode_model(model) {
        Backend::Opencode
    } else if model.starts_with("commandcode/") {
        Backend::Commandcode
    } else if crate::is_grok_model(model) {
        Backend::Grok
    } else if crate::is_codex_model(model) {
        Backend::Codex
    } else {
        fallback
    }
}

fn resume_id_for_persisted_claude_run<'a>(
    backend: &Backend,
    resume_id: &'a str,
    has_assistant_payload: bool,
) -> Option<&'a str> {
    if *backend == Backend::Claude && !resume_id.is_empty() && has_assistant_payload {
        Some(resume_id)
    } else {
        None
    }
}

fn should_clear_stale_resumed_claude_session(
    was_resuming: bool,
    has_content: bool,
    has_tool_calls: bool,
    has_content_blocks: bool,
    has_usage: bool,
    _was_cancelled: bool,
) -> bool {
    was_resuming && !has_content && !has_tool_calls && !has_content_blocks && !has_usage
}

fn default_model_for_backend(
    backend: &Backend,
    preferences: &crate::AppPreferences,
) -> Option<String> {
    let model = match backend {
        Backend::Codex => &preferences.selected_codex_model,
        Backend::Opencode => &preferences.selected_opencode_model,
        Backend::Cursor => &preferences.selected_cursor_model,
        Backend::Pi => &preferences.selected_pi_model,
        Backend::Commandcode => &preferences.selected_commandcode_model,
        Backend::Grok => &preferences.selected_grok_model,
        Backend::Claude => &preferences.selected_model,
    };

    if model.trim().is_empty() {
        None
    } else {
        Some(model.clone())
    }
}

/// Get current Unix timestamp in seconds
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Find the nearest non-archived session after removing an item at `removed_index`.
/// Preference order: left neighbor(s) first, then right neighbor(s).
fn find_neighbor_non_archived_session_id(
    sessions: &[Session],
    removed_index: usize,
) -> Option<String> {
    // Search left side first (closest to farthest)
    for i in (0..removed_index).rev() {
        if sessions.get(i).is_some_and(|s| s.archived_at.is_none()) {
            return sessions.get(i).map(|s| s.id.clone());
        }
    }

    // Then search right side (closest to farthest)
    for i in removed_index..sessions.len() {
        if sessions.get(i).is_some_and(|s| s.archived_at.is_none()) {
            return sessions.get(i).map(|s| s.id.clone());
        }
    }

    None
}

fn emit_sessions_cache_invalidation(app: &AppHandle) {
    if let Err(e) = app.emit_all(
        "cache:invalidate",
        &serde_json::json!({ "keys": ["sessions"] }),
    ) {
        log::error!("Failed to emit cache:invalidate for sessions: {e}");
    }
}

// ============================================================================
// Session Management Commands
// ============================================================================

/// Get all sessions for a worktree (for tab bar display)
/// By default, archived sessions are filtered out
#[tauri::command]
pub async fn get_sessions(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    include_archived: Option<bool>,
    include_message_counts: Option<bool>,
) -> Result<WorktreeSessions, String> {
    log::trace!("Getting sessions for worktree: {worktree_id}");
    let mut sessions = load_sessions(&app, &worktree_path, &worktree_id)?;

    // Filter out archived sessions unless explicitly requested
    if !include_archived.unwrap_or(false) {
        sessions.sessions.retain(|s| s.archived_at.is_none());
    }

    // Optionally populate message counts from metadata (efficient alternative to loading full messages)
    if include_message_counts.unwrap_or(false) {
        for session in &mut sessions.sessions {
            if let Ok(Some(metadata)) = load_metadata(&app, &session.id) {
                // Count messages: each run has 1 user message, plus 1 assistant message if not undo_send
                let count: u32 = metadata
                    .runs
                    .iter()
                    .map(super::types::RunEntry::rendered_message_count)
                    .sum();
                session.message_count = Some(count);
            }
        }
    }

    // Debug logging for session recovery
    for session in &sessions.sessions {
        log::trace!(
            "get_sessions: session={}, last_run_status={:?}, last_run_mode={:?}",
            session.id,
            session.last_run_status,
            session.last_run_execution_mode
        );
        if session.enabled_mcp_servers.is_some() {
            log::debug!(
                "get_sessions: session={}, enabled_mcp_servers={:?}",
                session.id,
                session.enabled_mcp_servers
            );
        }
    }

    // Propagate issue/PR references from worktree_id to session IDs
    // (create_worktree stores refs under worktree_id, but toolbar queries by session_id)
    let worktree_issue_keys = get_session_issue_refs(&app, &worktree_id).unwrap_or_default();
    let worktree_pr_keys = get_session_pr_refs(&app, &worktree_id).unwrap_or_default();

    if !worktree_issue_keys.is_empty() || !worktree_pr_keys.is_empty() {
        for session in &sessions.sessions {
            let session_issues = get_session_issue_refs(&app, &session.id).unwrap_or_default();
            let session_prs = get_session_pr_refs(&app, &session.id).unwrap_or_default();

            if session_issues.is_empty() && !worktree_issue_keys.is_empty() {
                for key in &worktree_issue_keys {
                    if let Some(number_str) = key.rsplit('-').next() {
                        if let Ok(number) = number_str.parse::<u32>() {
                            let repo_key = &key[..key.len() - number_str.len() - 1];
                            let _ = add_issue_reference(&app, repo_key, number, &session.id);
                        }
                    }
                }
            }
            if session_prs.is_empty() && !worktree_pr_keys.is_empty() {
                for key in &worktree_pr_keys {
                    if let Some(number_str) = key.rsplit('-').next() {
                        if let Ok(number) = number_str.parse::<u32>() {
                            let repo_key = &key[..key.len() - number_str.len() - 1];
                            let _ = add_pr_reference(&app, repo_key, number, &session.id);
                        }
                    }
                }
            }
        }
    }

    Ok(sessions)
}

/// List lightweight session summaries for a worktree without loading message history.
#[tauri::command]
pub async fn list_sessions_summary(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    include_archived: Option<bool>,
) -> Result<serde_json::Value, String> {
    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    let include_archived = include_archived.unwrap_or(false);
    let session_summaries: Vec<serde_json::Value> = sessions
        .sessions
        .into_iter()
        .filter(|session| include_archived || session.archived_at.is_none())
        .map(|session| {
            serde_json::json!({
                "id": session.id,
                "name": session.name,
                "order": session.order,
                "backend": session.backend,
                "selectedModel": session.selected_model,
                "selectedProvider": session.selected_provider,
                "selectedExecutionMode": session.selected_execution_mode,
                "createdAt": session.created_at,
                "updatedAt": session.updated_at,
                "lastMessageAt": session.last_message_at,
                "messageCount": session.message_count,
                "archivedAt": session.archived_at,
                "lastRunStatus": session.last_run_status,
                "lastRunStartedAt": session.last_run_started_at,
                "waitingForInput": session.waiting_for_input,
                "waitingForInputType": session.waiting_for_input_type,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "worktreeId": worktree_id,
        "activeSessionId": sessions.active_session_id,
        "sessions": session_summaries,
    }))
}

/// Get the latest run/session status for polling background work.
#[tauri::command]
pub async fn get_session_status(
    app: AppHandle,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let metadata = load_metadata(&app, &session_id)?
        .ok_or_else(|| format!("Unknown sessionId: {session_id}"))?;
    let latest_run = metadata.runs.last();
    let actively_managed = crate::chat::registry::is_session_actively_managed(&session_id);
    let status = if actively_managed {
        "running"
    } else {
        match latest_run.map(|run| &run.status) {
            Some(RunStatus::Running) | Some(RunStatus::Resumable) => "resumable",
            Some(RunStatus::Cancelled) => "cancelled",
            Some(RunStatus::Crashed) => "error",
            Some(RunStatus::Completed) | None => "idle",
        }
    };

    Ok(serde_json::json!({
        "sessionId": session_id,
        "worktreeId": metadata.worktree_id,
        "status": status,
        "activelyManaged": actively_managed,
        "backend": metadata.backend,
        "selectedModel": metadata.selected_model,
        "selectedProvider": metadata.selected_provider,
        "selectedExecutionMode": metadata.selected_execution_mode,
        "waitingForInput": metadata.waiting_for_input,
        "waitingForInputType": metadata.waiting_for_input_type,
        "latestRun": latest_run.map(|run| serde_json::json!({
            "runId": run.run_id,
            "status": run.status,
            "startedAt": run.started_at,
            "endedAt": run.ended_at,
            "model": run.model,
            "executionMode": run.execution_mode,
            "cancelled": run.cancelled,
            "recovered": run.recovered,
        })),
    }))
}

/// List all sessions across all worktrees and projects
///
/// Returns sessions grouped by project/worktree for the Load Context modal.
/// This allows users to generate context from any session in any project.
#[tauri::command]
pub async fn list_all_sessions(app: AppHandle) -> Result<AllSessionsResponse, String> {
    log::trace!("Listing all sessions across all worktrees");

    // Load all projects
    let projects_data = load_projects_data(&app)?;

    let mut entries = Vec::new();

    // For each project, get all worktrees
    for project in &projects_data.projects {
        let worktrees = projects_data.worktrees_for_project(&project.id);

        // For each worktree, load sessions
        for worktree in worktrees {
            match load_sessions(&app, &worktree.path, &worktree.id) {
                Ok(sessions_data) => {
                    entries.push(AllSessionsEntry {
                        project_id: project.id.clone(),
                        project_name: project.name.clone(),
                        worktree_id: worktree.id.clone(),
                        worktree_name: worktree.name.clone(),
                        worktree_path: worktree.path.clone(),
                        sessions: sessions_data.sessions,
                    });
                }
                Err(e) => {
                    // Log but don't fail - some worktrees might not have sessions yet
                    log::warn!(
                        "Failed to load sessions for worktree {}: {}",
                        worktree.id,
                        e
                    );
                }
            }
        }
    }

    log::trace!("Found {} worktree entries with sessions", entries.len());
    Ok(AllSessionsResponse { entries })
}

/// Get a single session with message history.
///
/// `limit`: optional max number of recent runs to load. When `None`, loads all runs
/// (legacy behavior). Frontends should pass a small limit for fast initial render
/// and use `load_older_session_messages` for scroll-up pagination.
#[tauri::command]
pub async fn get_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    limit: Option<usize>,
) -> Result<Session, String> {
    log::debug!("[GetSession] session={session_id} worktree={worktree_id} limit={limit:?}");
    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    let mut session = sessions
        .find_session(&session_id)
        .cloned()
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    // Load messages from NDJSON (single source of truth)
    let loaded = run_log::load_session_messages_window(&app, &session_id, limit, None)?;
    let mut messages = loaded.messages;
    log::debug!(
        "[GetSession] session={session_id} loaded {} messages of {} runs (backend={:?}, start={})",
        messages.len(),
        loaded.total_runs,
        session.backend,
        loaded.loaded_run_start_index,
    );

    // Apply approved plan status from session metadata
    for msg in &mut messages {
        if session.approved_plan_message_ids.contains(&msg.id) {
            msg.plan_approved = true;
        }
    }

    session.last_message_at = messages.iter().map(|message| message.timestamp).max();
    session.messages = messages;
    session.total_runs = loaded.total_runs;
    session.loaded_run_start_index = loaded.loaded_run_start_index;
    Ok(session)
}

/// Load an older window of messages for an already-loaded session.
///
/// `before_run_index`: load runs strictly before this index in metadata.runs.
/// `limit`: max number of runs to load (most recent within the window).
/// Returns the parsed messages plus updated `loaded_run_start_index` so the
/// frontend can chain further pagination.
#[tauri::command]
pub async fn load_older_session_messages(
    app: AppHandle,
    session_id: String,
    before_run_index: usize,
    limit: usize,
) -> Result<crate::chat::types::LoadedMessages, String> {
    log::debug!("[LoadOlder] session={session_id} before={before_run_index} limit={limit}");
    let mut loaded = run_log::load_session_messages_window(
        &app,
        &session_id,
        Some(limit),
        Some(before_run_index),
    )?;

    // Apply approved plan status (read from metadata via load_sessions to find the worktree)
    // We don't have worktree_path here, so look up via session storage directly.
    if let Ok(Some(metadata)) = crate::chat::storage::load_metadata(&app, &session_id) {
        let approved: std::collections::HashSet<&String> =
            metadata.approved_plan_message_ids.iter().collect();
        for msg in &mut loaded.messages {
            if approved.contains(&msg.id) {
                msg.plan_approved = true;
            }
        }
    }

    Ok(loaded)
}

/// Create a new session tab
#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    name: Option<String>,
    backend: Option<String>,
    primary_surface: Option<String>,
    terminal_command: Option<String>,
    terminal_command_args: Option<Vec<String>>,
    terminal_label: Option<String>,
    native_session_id: Option<String>,
) -> Result<Session, String> {
    log::trace!("Creating new session for worktree: {worktree_id}");
    if native_session_id.is_some() && primary_surface.as_deref() != Some("terminal") {
        return Err("Native session IDs are only valid for terminal sessions".to_string());
    }

    let preferences = crate::load_preferences(app.clone()).await.ok();

    // Resolve backend: explicit param → project default → global preference → Claude
    let backend_enum = match backend.as_deref() {
        Some("codex") => Backend::Codex,
        Some("opencode") => Backend::Opencode,
        Some("cursor") => Backend::Cursor,
        Some("pi") => Backend::Pi,
        Some("commandcode") => Backend::Commandcode,
        Some("grok") => Backend::Grok,
        Some("claude") => Backend::Claude,
        _ => {
            // No explicit backend — check project default, then global preference
            let mut resolved = Backend::Claude;
            if let Some(prefs) = preferences.as_ref() {
                if prefs.default_backend == "codex" {
                    resolved = Backend::Codex;
                } else if prefs.default_backend == "opencode" {
                    resolved = Backend::Opencode;
                } else if prefs.default_backend == "cursor" {
                    resolved = Backend::Cursor;
                } else if prefs.default_backend == "pi" {
                    resolved = Backend::Pi;
                } else if prefs.default_backend == "commandcode" {
                    resolved = Backend::Commandcode;
                } else if prefs.default_backend == "grok" {
                    resolved = Backend::Grok;
                }
            }
            // Check project-level override
            if let Ok(data) = crate::projects::storage::load_projects_data(&app) {
                // Find project that owns this worktree path
                if let Some(project) = data.projects.iter().find(|p| {
                    // Match by worktree's project (worktree_id → project)
                    !p.is_folder
                        && data
                            .worktrees
                            .iter()
                            .any(|w| w.id == worktree_id && w.project_id == p.id)
                }) {
                    if let Some(ref pb) = project.default_backend {
                        resolved = match pb.as_str() {
                            "codex" => Backend::Codex,
                            "opencode" => Backend::Opencode,
                            "cursor" => Backend::Cursor,
                            "pi" => Backend::Pi,
                            "commandcode" => Backend::Commandcode,
                            "grok" => Backend::Grok,
                            "claude" => Backend::Claude,
                            _ => resolved,
                        };
                    }
                }
            }
            resolved
        }
    };

    let session = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        // Generate name if not provided
        let session_number = sessions.next_session_number();
        let session_name = name.unwrap_or_else(|| format!("Session {session_number}"));

        let mut session = Session::new(
            session_name,
            sessions.sessions.len() as u32,
            backend_enum.clone(),
        );
        session.primary_surface = primary_surface.clone();
        session.terminal_command = terminal_command.clone();
        session.terminal_command_args = terminal_command_args.clone().unwrap_or_default();
        session.terminal_label = terminal_label.clone();
        if let Some(native_session_id) = native_session_id.as_deref() {
            persist_salvaged_resume_id(&mut session, &backend_enum, native_session_id);
        }
        if primary_surface.as_deref() != Some("terminal") {
            session.selected_model = preferences
                .as_ref()
                .and_then(|prefs| default_model_for_backend(&backend_enum, prefs));
        }
        let session_id = session.id.clone();

        sessions.sessions.push(session.clone());
        sessions.active_session_id = Some(session_id);

        log::trace!("Created session: {}", session.id);
        Ok(session)
    })?;

    // Copy issue/PR context references from worktree_id to new session_id
    // (worktree creation stores refs under worktree_id, but toolbar queries by session_id)
    if let Ok(issue_keys) = get_session_issue_refs(&app, &worktree_id) {
        for key in &issue_keys {
            if let Some(number_str) = key.rsplit('-').next() {
                if let Ok(number) = number_str.parse::<u32>() {
                    let repo_key = &key[..key.len() - number_str.len() - 1];
                    let _ = add_issue_reference(&app, repo_key, number, &session.id);
                }
            }
        }
    }
    if let Ok(pr_keys) = get_session_pr_refs(&app, &worktree_id) {
        for key in &pr_keys {
            if let Some(number_str) = key.rsplit('-').next() {
                if let Ok(number) = number_str.parse::<u32>() {
                    let repo_key = &key[..key.len() - number_str.len() - 1];
                    let _ = add_pr_reference(&app, repo_key, number, &session.id);
                }
            }
        }
    }

    emit_sessions_cache_invalidation(&app);
    Ok(session)
}

fn trigger_backend_queue_drain(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) {
    {
        let mut draining = BACKEND_QUEUE_DRAINING.lock().unwrap();
        if !draining.insert(session_id.clone()) {
            log::trace!("[QueueDrain] already draining session={session_id}");
            return;
        }
    }

    tauri::async_runtime::spawn(async move {
        drain_backend_queue(app, worktree_id, worktree_path, session_id.clone()).await;
        BACKEND_QUEUE_DRAINING.lock().unwrap().remove(&session_id);
    });
}

async fn drain_backend_queue(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) {
    loop {
        if super::registry::is_session_actively_managed(&session_id) {
            // A Codex turn may be running — steer queued messages into it
            // instead of waiting for the run to finish (preference-gated).
            drain_queue_into_codex_turn(&app, &worktree_id, &session_id).await;
            drain_queue_into_opencode_turn(&app, &worktree_id, &worktree_path, &session_id).await;
            drain_queue_into_pi_turn(&app, &worktree_id, &session_id).await;
            log::trace!("[QueueDrain] session active, stop session={session_id}");
            return;
        }

        let dequeue_result = with_existing_metadata_mut(&app, &session_id, |metadata| {
            if metadata.waiting_for_input {
                return (None, metadata.queued_messages.clone(), true);
            }

            let dequeued = if metadata.queued_messages.is_empty() {
                None
            } else {
                Some(metadata.queued_messages.remove(0))
            };
            (dequeued, metadata.queued_messages.clone(), false)
        });

        let (queued, remaining_queue, waiting_for_input) = match dequeue_result {
            Ok(result) => result,
            Err(e) => {
                log::warn!("[QueueDrain] failed to read queue session={session_id}: {e}");
                return;
            }
        };

        if waiting_for_input {
            log::trace!("[QueueDrain] session waiting for input, stop session={session_id}");
            return;
        }

        let Some(queued) = queued else {
            log::trace!("[QueueDrain] queue empty session={session_id}");
            return;
        };

        app.emit_all(
            "queue:updated",
            &serde_json::json!({ "sessionId": session_id, "queue": remaining_queue }),
        )
        .ok();

        let queued_id = queued
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("<unknown>")
            .to_string();

        let request = match queued_message_to_send_request(&app, &queued).await {
            Ok(request) => request,
            Err(e) => {
                log::error!(
                    "[QueueDrain] dropping malformed queued message session={session_id} message_id={queued_id}: {e}"
                );
                continue;
            }
        };

        log::info!(
            "[QueueDrain] processing queued message session={session_id} message_id={queued_id}"
        );

        if let Err(e) = send_chat_message(
            app.clone(),
            session_id.clone(),
            worktree_id.clone(),
            worktree_path.clone(),
            request.message,
            request.model,
            request.execution_mode,
            request.thinking_level,
            request.effort_level,
            request.parallel_execution_prompt,
            request.ai_language,
            request.allowed_tools,
            request.mcp_config,
            request.chrome_enabled,
            request.custom_profile_name,
            request.backend,
        )
        .await
        {
            // Lost a send race against another consumer (frontend queue
            // processor or another client). Re-insert at the queue front so
            // the message is NOT lost — the active run's completion re-triggers
            // the drain and retries it.
            if e.contains("already has an active request") {
                log::warn!(
                    "[QueueDrain] send race lost, requeueing at front session={session_id} message_id={queued_id}"
                );
                let requeued = with_existing_metadata_mut(&app, &session_id, |metadata| {
                    metadata.queued_messages.insert(0, queued.clone());
                    metadata.queued_messages.clone()
                });
                if let Ok(queue) = requeued {
                    app.emit_all(
                        "queue:updated",
                        &serde_json::json!({ "sessionId": session_id, "queue": queue }),
                    )
                    .ok();
                }
                return;
            }
            log::error!(
                "[QueueDrain] queued message failed session={session_id} message_id={queued_id}: {e}"
            );
        }
    }
}

struct QueuedSendRequest {
    message: String,
    model: Option<String>,
    execution_mode: Option<String>,
    thinking_level: Option<ThinkingLevel>,
    effort_level: Option<EffortLevel>,
    parallel_execution_prompt: Option<String>,
    ai_language: Option<String>,
    allowed_tools: Option<Vec<String>>,
    mcp_config: Option<String>,
    chrome_enabled: Option<bool>,
    custom_profile_name: Option<String>,
    backend: Option<String>,
}

async fn queued_message_to_send_request(
    app: &AppHandle,
    queued: &Value,
) -> Result<QueuedSendRequest, String> {
    let message = build_queued_message_with_refs(queued)?;
    if message.trim().is_empty() {
        return Err("queued message is empty".to_string());
    }

    let model = json_string(queued, "model");
    let provider = json_string(queued, "provider");

    let thinking_level = match queued.get("thinkingLevel") {
        Some(value) if !value.is_null() => Some(
            serde_json::from_value::<ThinkingLevel>(value.clone())
                .map_err(|e| format!("invalid thinkingLevel: {e}"))?,
        ),
        _ => None,
    };
    let effort_level = match queued.get("effortLevel") {
        Some(value) if !value.is_null() => Some(
            serde_json::from_value::<EffortLevel>(value.clone())
                .map_err(|e| format!("invalid effortLevel: {e}"))?,
        ),
        _ => None,
    };

    let prefs = crate::load_preferences(app.clone()).await.ok();
    let custom_profile_name = provider.filter(|provider| {
        provider != "__anthropic__"
            && prefs.as_ref().is_some_and(|p| {
                p.custom_cli_profiles
                    .iter()
                    .any(|profile| profile.name == *provider)
            })
    });
    let parallel_execution_prompt = prefs.as_ref().and_then(|p| {
        if p.parallel_execution_prompt_enabled {
            Some(
                p.magic_prompts
                    .parallel_execution
                    .clone()
                    .unwrap_or_else(|| DEFAULT_PARALLEL_EXECUTION_PROMPT.to_string()),
            )
        } else {
            None
        }
    });
    let ai_language = prefs
        .as_ref()
        .map(|p| p.ai_language.trim().to_string())
        .filter(|s| !s.is_empty());
    let chrome_enabled = prefs.as_ref().map(|p| p.chrome_enabled);

    let mut allowed_tools: Vec<String> = QUEUE_DEFAULT_ALLOWED_TOOLS
        .iter()
        .map(|tool| (*tool).to_string())
        .collect();
    if let Some(command_tools) = queued.get("commandAllowedTools").and_then(Value::as_array) {
        for tool in command_tools.iter().filter_map(Value::as_str) {
            if !allowed_tools.iter().any(|existing| existing == tool) {
                allowed_tools.push(tool.to_string());
            }
        }
    }

    Ok(QueuedSendRequest {
        message,
        model,
        execution_mode: json_string(queued, "executionMode"),
        thinking_level,
        effort_level,
        parallel_execution_prompt,
        ai_language,
        allowed_tools: Some(allowed_tools),
        mcp_config: json_string(queued, "mcpConfig"),
        chrome_enabled,
        custom_profile_name,
        backend: json_string(queued, "backend"),
    })
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn build_queued_message_with_refs(queued: &Value) -> Result<String, String> {
    let mut message = queued
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let pending_files = queued
        .get("pendingFiles")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if !pending_files.is_empty() {
        let refs = pending_files
            .iter()
            .map(|file| {
                let path = queued_file_path(file)?;
                let is_directory = file
                    .get("isDirectory")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Ok(if is_directory {
                    format!(
                        "[Directory: {path} - Use Glob and Read tools to explore this directory]"
                    )
                } else {
                    format!("[File: {path} - Use the Read tool to view this file]")
                })
            })
            .collect::<Result<Vec<_>, String>>()?
            .join("\n");
        message = append_refs(message, refs);
    }

    let pending_skills = queued
        .get("pendingSkills")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if !pending_skills.is_empty() {
        let refs = pending_skills
            .iter()
            .map(|skill| {
                let path = skill
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "pendingSkills item missing path".to_string())?;
                Ok(format!(
                    "[Skill: {path} - Read and use this skill to guide your response]"
                ))
            })
            .collect::<Result<Vec<_>, String>>()?
            .join("\n");
        message = append_refs(message, refs);
    }

    let pending_images = queued
        .get("pendingImages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if !pending_images.is_empty() {
        if message.is_empty() {
            message = IMAGE_ONLY_DEFAULT_PROMPT.to_string();
        }
        let refs = pending_images
            .iter()
            .map(|image| {
                let path = image
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "pendingImages item missing path".to_string())?;
                Ok(format!(
                    "[Image attached: {path} - Use the Read tool to view this image]"
                ))
            })
            .collect::<Result<Vec<_>, String>>()?
            .join("\n");
        message = append_refs(message, refs);
    }

    let pending_text_files = queued
        .get("pendingTextFiles")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if !pending_text_files.is_empty() {
        if message.is_empty() {
            message = TEXT_ONLY_DEFAULT_PROMPT.to_string();
        }
        let refs = pending_text_files
            .iter()
            .map(|text_file| {
                let path = text_file
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "pendingTextFiles item missing path".to_string())?;
                Ok(format!(
                    "[Text file attached: {path} - Use the Read tool to view this file]"
                ))
            })
            .collect::<Result<Vec<_>, String>>()?
            .join("\n");
        message = append_refs(message, refs);
    }

    Ok(message)
}

fn queued_file_path(file: &Value) -> Result<String, String> {
    let relative_path = file
        .get("relativePath")
        .and_then(Value::as_str)
        .or_else(|| file.get("path").and_then(Value::as_str))
        .ok_or_else(|| "pendingFiles item missing relativePath/path".to_string())?;
    if let Some(root) = file.get("sourceRootPath").and_then(Value::as_str) {
        Ok(format!(
            "{}/{}",
            root.trim_end_matches('/'),
            relative_path.trim_start_matches('/')
        ))
    } else {
        Ok(relative_path.to_string())
    }
}

fn queued_message_base_prompt(queued: &Value) -> String {
    let mut message = queued
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if message.is_empty()
        && queued
            .get("pendingImages")
            .and_then(Value::as_array)
            .is_some_and(|images| !images.is_empty())
    {
        message = IMAGE_ONLY_DEFAULT_PROMPT.to_string();
    }
    if message.is_empty()
        && queued
            .get("pendingTextFiles")
            .and_then(Value::as_array)
            .is_some_and(|files| !files.is_empty())
    {
        message = TEXT_ONLY_DEFAULT_PROMPT.to_string();
    }
    message
}

fn codex_steer_input_from_queued_message(queued: &Value) -> Result<Vec<Value>, String> {
    let mut input = Vec::new();
    let message = queued_message_base_prompt(queued);
    if !message.trim().is_empty() {
        input.push(serde_json::json!({
            "type": "text",
            "text": message,
            "text_elements": [],
        }));
    }

    for file in queued
        .get("pendingFiles")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let path = queued_file_path(file)?;
        let name = file
            .get("relativePath")
            .and_then(Value::as_str)
            .or_else(|| file.get("path").and_then(Value::as_str))
            .and_then(|path| path.rsplit('/').next())
            .filter(|name| !name.is_empty())
            .unwrap_or(&path);
        input.push(serde_json::json!({
            "type": "mention",
            "name": name,
            "path": path,
        }));
    }

    for skill in queued
        .get("pendingSkills")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let path = skill
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "pendingSkills item missing path".to_string())?;
        let name = skill
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .or_else(|| path.rsplit('/').next())
            .unwrap_or("skill");
        input.push(serde_json::json!({
            "type": "skill",
            "name": name,
            "path": path,
        }));
    }

    for image in queued
        .get("pendingImages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let path = image
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "pendingImages item missing path".to_string())?;
        input.push(serde_json::json!({
            "type": "localImage",
            "path": path,
        }));
    }

    for text_file in queued
        .get("pendingTextFiles")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let path = text_file
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "pendingTextFiles item missing path".to_string())?;
        let name = text_file
            .get("filename")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .or_else(|| path.rsplit('/').next())
            .unwrap_or("attachment.txt");
        input.push(serde_json::json!({
            "type": "mention",
            "name": name,
            "path": path,
        }));
    }

    if input.is_empty() {
        return Err("queued message is empty".to_string());
    }
    Ok(input)
}

fn append_refs(message: String, refs: String) -> String {
    if message.is_empty() {
        refs
    } else {
        format!("{message}\n\n{refs}")
    }
}

/// Rename a session tab
#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    new_name: String,
) -> Result<(), String> {
    log::trace!("Renaming session {session_id} to: {new_name}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.name = new_name;
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Regenerate session name using AI based on the first user message
#[tauri::command]
pub async fn regenerate_session_name(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    custom_prompt: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    log::trace!("Regenerating session name for {session_id}");

    // Load messages from NDJSON (load_sessions returns empty messages)
    let messages = run_log::load_session_messages(&app, &session_id)?;

    // Find the first user message to use for naming
    let first_message = messages
        .iter()
        .find(|m| m.role == MessageRole::User)
        .map(|m| m.content.clone())
        .ok_or_else(|| "No user messages in session to generate name from".to_string())?;

    let naming_model = model.unwrap_or_else(|| "sonnet".to_string());

    // Read per-operation backend from prefs
    let backend_override = crate::get_preferences_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str::<crate::AppPreferences>(&c).ok())
        .and_then(|p| p.magic_prompt_backends.session_naming_backend);

    let request = NamingRequest {
        session_id,
        worktree_id,
        worktree_path: std::path::PathBuf::from(&worktree_path),
        first_message,
        model: naming_model,
        existing_branch_names: Vec::new(),
        generate_session_name: true,
        generate_branch_name: false,
        custom_session_prompt: custom_prompt,
        custom_profile_name,
        backend_override,
        reasoning_effort,
    };

    spawn_naming_task(app, request);
    Ok(())
}

/// Update session-specific UI state (answered questions, fixed findings, etc.)
/// All fields are optional - only provided fields are updated
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_session_state(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    answered_questions: Option<Vec<String>>,
    submitted_answers: Option<std::collections::HashMap<String, serde_json::Value>>,
    fixed_findings: Option<Vec<String>>,
    pending_permission_denials: Option<Vec<super::types::PermissionDenial>>,
    pending_codex_permission_requests: Option<Vec<super::types::CodexPermissionRequest>>,
    pending_codex_command_approval_requests: Option<Vec<super::types::CodexCommandApprovalRequest>>,
    pending_codex_user_input_requests: Option<Vec<super::types::CodexUserInputRequest>>,
    pending_codex_mcp_elicitation_requests: Option<Vec<super::types::CodexMcpElicitationRequest>>,
    pending_codex_dynamic_tool_call_requests: Option<
        Vec<super::types::CodexDynamicToolCallRequest>,
    >,
    denied_message_context: Option<Option<super::types::DeniedMessageContext>>,
    is_reviewing: Option<bool>,
    waiting_for_input: Option<bool>,
    waiting_for_input_type: Option<Option<String>>,
    plan_file_path: Option<Option<String>>,
    pending_plan_message_id: Option<Option<String>>,
    label: Option<Option<LabelData>>,
    clear_label: Option<bool>,
    review_results: Option<Option<serde_json::Value>>,
    enabled_mcp_servers: Option<Option<Vec<String>>>,
    selected_execution_mode: Option<Option<String>>,
    table_checked_rows: Option<std::collections::HashMap<String, Vec<u32>>>,
) -> Result<(), String> {
    log::trace!("Updating session state for: {session_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            if let Some(v) = answered_questions {
                session.answered_questions = v;
            }
            if let Some(v) = submitted_answers {
                session.submitted_answers = v;
            }
            if let Some(v) = fixed_findings {
                session.fixed_findings = v;
            }
            if let Some(v) = pending_permission_denials {
                session.pending_permission_denials = v;
            }
            if let Some(v) = pending_codex_permission_requests {
                session.pending_codex_permission_requests = v;
            }
            if let Some(v) = pending_codex_command_approval_requests {
                session.pending_codex_command_approval_requests = v;
            }
            if let Some(v) = pending_codex_user_input_requests {
                session.pending_codex_user_input_requests = v;
            }
            if let Some(v) = pending_codex_mcp_elicitation_requests {
                session.pending_codex_mcp_elicitation_requests = v;
            }
            if let Some(v) = pending_codex_dynamic_tool_call_requests {
                session.pending_codex_dynamic_tool_call_requests = v;
            }
            if let Some(v) = denied_message_context {
                session.denied_message_context = v;
            }
            if let Some(v) = is_reviewing {
                session.is_reviewing = v;
            }
            if let Some(v) = waiting_for_input {
                session.waiting_for_input = v;
            }
            if let Some(v) = waiting_for_input_type {
                session.waiting_for_input_type = v;
            }
            if let Some(v) = plan_file_path {
                session.plan_file_path = v;
            }
            if let Some(v) = pending_plan_message_id {
                session.pending_plan_message_id = v;
            }
            if let Some(v) = label {
                session.label = v;
            }
            if let Some(clear) = clear_label {
                if clear {
                    session.label = None;
                }
            }
            if let Some(v) = review_results {
                session.review_results = v;
            }
            if let Some(v) = enabled_mcp_servers {
                log::debug!("Saving session MCP servers: {v:?} for session {session_id}");
                session.enabled_mcp_servers = v;
            }
            if let Some(v) = selected_execution_mode {
                session.selected_execution_mode = v;
            }
            if let Some(v) = table_checked_rows {
                session.table_checked_rows = v;
            }
            Ok(())
        } else {
            log::trace!("Session already removed, skipping update: {session_id}");
            Ok(())
        }
    })?;

    // Notify all clients (native + web access) to refetch session data.
    // This is the single cache invalidation point for session state mutations —
    // other commands (e.g. mark_plan_approved) rely on callers also invoking
    // update_session_state rather than emitting their own invalidation.
    emit_sessions_cache_invalidation(&app);
    Ok(())
}

/// Extract pasted image paths from message content
/// Matches: [Image attached: /path/to/image.png - Use the Read tool to view this image]
pub(crate) fn extract_image_paths(content: &str) -> Vec<String> {
    use regex::Regex;
    // Lazy static would be better, but for simplicity we'll compile here
    let re = Regex::new(r"\[Image attached: (.+?) - Use the Read tool to view this image\]")
        .expect("Invalid regex");
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// Extract pasted text file paths from message content
/// Matches: [Text file attached: /path/to/file.txt - Use the Read tool to view this file]
pub(crate) fn extract_text_file_paths(content: &str) -> Vec<String> {
    use regex::Regex;
    let re = Regex::new(r"\[Text file attached: (.+?) - Use the Read tool to view this file\]")
        .expect("Invalid regex");
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// Delete a pasted file (image or text) by path - internal helper
/// Does not validate path (validation done at command level)
fn delete_pasted_file(path: &str) {
    let file_path = std::path::PathBuf::from(path);
    if file_path.exists() {
        if let Err(e) = std::fs::remove_file(&file_path) {
            log::warn!("Failed to delete pasted file {path}: {e}");
        } else {
            log::trace!("Deleted pasted file: {path}");
        }
    }
}

fn plan_mode_content_waits_for_approval(
    backend: &Backend,
    execution_mode: Option<&str>,
    has_content: bool,
    has_plan_tool: bool,
) -> bool {
    matches!(backend, Backend::Codex | Backend::Opencode | Backend::Grok)
        && execution_mode == Some("plan")
        && has_content
        && !has_plan_tool
}

fn queued_prompt_skips_plan_wait(
    has_queued_messages: bool,
    has_question_tool: bool,
    has_plan_wait: bool,
) -> bool {
    has_queued_messages && has_plan_wait && !has_question_tool
}

fn is_unavailable_tool_error(output: Option<&str>) -> bool {
    output.is_some_and(|text| {
        text.contains("No such tool available") || text.contains("not enabled in this context")
    })
}

fn is_pending_blocking_tool_call(tc: &crate::chat::types::ToolCall) -> bool {
    matches!(
        tc.name.as_str(),
        "AskUserQuestion" | "ExitPlanMode" | "CodexPlan" | "question"
    ) && !is_unavailable_tool_error(tc.output.as_deref())
}

fn is_pending_question_tool_call(tc: &crate::chat::types::ToolCall) -> bool {
    matches!(tc.name.as_str(), "AskUserQuestion" | "question")
        && !is_unavailable_tool_error(tc.output.as_deref())
}

fn is_pending_plan_tool_call(tc: &crate::chat::types::ToolCall) -> bool {
    matches!(tc.name.as_str(), "ExitPlanMode" | "CodexPlan")
        && !is_unavailable_tool_error(tc.output.as_deref())
}

/// Close/delete a session tab
/// Returns the new active session ID (if any)
/// Also cleans up any pasted images and text files associated with the session
#[tauri::command]
pub async fn close_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<Option<String>, String> {
    log::trace!("Closing session: {session_id}");

    // Cancel only if a process is actively running — avoids spurious chat:cancelled events
    // for idle sessions (e.g. those waiting for plan approval during clear-context flows).
    let _ = cancel_process_if_running(&app, &session_id, &worktree_id);

    // Collect pasted file paths for cleanup (outside lock - read-only NDJSON access)
    let mut files_to_delete: Vec<String> = Vec::new();
    let messages = run_log::load_session_messages(&app, &session_id).unwrap_or_default();
    for message in &messages {
        files_to_delete.extend(extract_image_paths(&message.content));
        files_to_delete.extend(extract_text_file_paths(&message.content));
    }

    // Delete pasted files (outside lock - doesn't touch sessions file)
    if !files_to_delete.is_empty() {
        log::trace!(
            "Cleaning up {} pasted files for session {session_id}",
            files_to_delete.len()
        );
        for path in files_to_delete {
            delete_pasted_file(&path);
        }
    }

    // Delete session data (outside lock - separate directory)
    if let Err(e) = delete_session_data(&app, &session_id) {
        log::warn!("Failed to delete session data: {e}");
    }

    // Clean up context references for this session
    if let Err(e) =
        crate::projects::github_issues::cleanup_issue_contexts_for_session(&app, &session_id)
    {
        log::warn!("Failed to cleanup issue/PR contexts for session: {e}");
    }
    if let Err(e) =
        crate::projects::saved_contexts::cleanup_saved_contexts_for_session(&app, &session_id)
    {
        log::warn!("Failed to cleanup saved contexts for session: {e}");
    }

    // Clean up combined-context files for this session
    cleanup_combined_context_files(&app, &session_id);

    // Resolve default backend for fallback session creation
    let fallback_backend = resolve_default_backend(&app, Some(&worktree_id));

    // Now atomically modify the sessions file
    let new_active = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        // Find index before removal to support deterministic neighbor selection.
        let session_index = sessions.sessions.iter().position(|s| s.id == session_id);

        // Remove the session
        sessions.sessions.retain(|s| s.id != session_id);

        // If we closed the active session, select nearest visible tab: left then right.
        if sessions.active_session_id.as_deref() == Some(&session_id) {
            sessions.active_session_id = match session_index {
                Some(idx) => find_neighbor_non_archived_session_id(&sessions.sessions, idx),
                None => sessions
                    .sessions
                    .iter()
                    .find(|s| s.archived_at.is_none())
                    .map(|s| s.id.clone()),
            };
        }

        // Ensure at least one non-archived session exists
        let non_archived_count = sessions
            .sessions
            .iter()
            .filter(|s| s.archived_at.is_none())
            .count();
        if non_archived_count == 0 {
            let default_session = Session::default_session_with_backend(fallback_backend.clone());
            sessions.active_session_id = Some(default_session.id.clone());
            sessions.sessions.push(default_session);
        }

        log::trace!(
            "Session closed, new active: {:?}",
            sessions.active_session_id
        );
        Ok(sessions.active_session_id.clone())
    })?;

    emit_sessions_cache_invalidation(&app);
    Ok(new_active)
}

/// Archive a session tab (hide from UI but keep messages)
/// Sessions with 0 messages are deleted instead of archived.
/// Returns the new active session ID (if any)
#[tauri::command]
pub async fn archive_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<Option<String>, String> {
    log::trace!("Archiving session: {session_id}");

    // Cancel only if a process is actively running — avoids spurious chat:cancelled events
    // for idle sessions (e.g. those waiting for plan approval during clear-context flows).
    let _ = cancel_process_if_running(&app, &session_id, &worktree_id);

    // Load messages from NDJSON to check if session has content (outside lock - read-only)
    let messages = run_log::load_session_messages(&app, &session_id).unwrap_or_default();
    let should_delete = messages.is_empty();

    // Resolve default backend for fallback session creation
    let fallback_backend = resolve_default_backend(&app, Some(&worktree_id));

    let new_active = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        // Find the index before archiving/deleting
        let session_index = sessions.sessions.iter().position(|s| s.id == session_id);

        // Find the session
        let session = sessions
            .find_session(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        // Check if already archived
        if session.archived_at.is_some() {
            return Err("Session is already archived".to_string());
        }

        if should_delete {
            log::trace!("Session has 0 messages, deleting instead of archiving: {session_id}");
            if let Some(idx) = session_index {
                sessions.sessions.remove(idx);
            }
        } else {
            // Set archived timestamp
            let session = sessions
                .find_session_mut(&session_id)
                .ok_or_else(|| format!("Session not found: {session_id}"))?;
            session.archived_at = Some(now());
        }

        // Determine new active session if the archived/deleted one was active
        let new_active = if sessions.active_session_id.as_deref() == Some(&session_id) {
            if let Some(idx) = session_index {
                let mut candidate = None;
                let search_idx = if should_delete {
                    idx.saturating_sub(1)
                } else {
                    idx
                };
                for i in (0..=search_idx).rev() {
                    if sessions
                        .sessions
                        .get(i)
                        .is_some_and(|s| s.archived_at.is_none())
                    {
                        candidate = sessions.sessions.get(i).map(|s| s.id.clone());
                        break;
                    }
                }
                if candidate.is_none() {
                    let start_idx = if should_delete { idx } else { idx + 1 };
                    for i in start_idx..sessions.sessions.len() {
                        if sessions
                            .sessions
                            .get(i)
                            .is_some_and(|s| s.archived_at.is_none())
                        {
                            candidate = sessions.sessions.get(i).map(|s| s.id.clone());
                            break;
                        }
                    }
                }
                candidate
            } else {
                sessions
                    .sessions
                    .iter()
                    .find(|s| s.archived_at.is_none())
                    .map(|s| s.id.clone())
            }
        } else {
            sessions.active_session_id.clone()
        };
        sessions.active_session_id = new_active;

        // Ensure at least one session exists if all are archived or deleted
        let non_archived_count = sessions
            .sessions
            .iter()
            .filter(|s| s.archived_at.is_none())
            .count();
        if non_archived_count == 0 {
            let default_session = Session::default_session_with_backend(fallback_backend.clone());
            sessions.active_session_id = Some(default_session.id.clone());
            sessions.sessions.push(default_session);
        }

        if should_delete {
            log::trace!(
                "Session deleted (0 messages), new active: {:?}",
                sessions.active_session_id
            );
        } else {
            log::trace!(
                "Session archived, new active: {:?}",
                sessions.active_session_id
            );
        }
        Ok(sessions.active_session_id.clone())
    })?;

    emit_sessions_cache_invalidation(&app);
    Ok(new_active)
}

/// Unarchive a session (restore it to the session list)
#[tauri::command]
pub async fn unarchive_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<Session, String> {
    log::trace!("Unarchiving session: {session_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        let session = sessions
            .find_session_mut(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        if session.archived_at.is_none() {
            return Err("Session is not archived".to_string());
        }

        session.archived_at = None;
        let restored_session = session.clone();

        log::trace!("Session unarchived: {session_id}");
        Ok(restored_session)
    })
}

/// Response from restoring a session with base session recreation
#[derive(Debug, Clone, serde::Serialize)]
pub struct RestoreSessionWithBaseResponse {
    /// The restored session
    pub session: Session,
    /// The worktree (either existing or newly created base session)
    pub worktree: crate::projects::types::Worktree,
}

/// Restore an archived session, recreating the base session if needed
///
/// This command handles the case where:
/// 1. The session belongs to a base session that was closed (worktree record removed)
/// 2. We need to recreate the base session and migrate the sessions to it
#[tauri::command]
pub async fn restore_session_with_base(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    project_id: String,
) -> Result<RestoreSessionWithBaseResponse, String> {
    log::trace!("Restoring session with base session check: {session_id}");

    // Load projects data to check if worktree exists
    let mut projects_data = load_projects_data(&app)?;

    // Check if the worktree exists
    if let Some(existing) = projects_data.find_worktree(&worktree_id) {
        // Worktree exists - just unarchive the session
        log::trace!("Worktree exists, unarchiving session normally");
        let existing_worktree = existing.clone();

        let restored_session = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            let session = sessions
                .find_session_mut(&session_id)
                .ok_or_else(|| format!("Session not found: {session_id}"))?;

            if session.archived_at.is_none() {
                return Err("Session is not archived".to_string());
            }

            session.archived_at = None;
            Ok(session.clone())
        })?;

        return Ok(RestoreSessionWithBaseResponse {
            session: restored_session,
            worktree: existing_worktree,
        });
    }

    // Worktree doesn't exist - check if this is a base session path
    let project = projects_data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();

    if worktree_path != project.path {
        return Err(
            "Worktree not found and path doesn't match project (not a base session)".to_string(),
        );
    }

    log::trace!("Recreating base session for project: {}", project.name);

    // Create new base session
    let new_worktree = crate::projects::types::Worktree {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: project_id.clone(),
        name: project.default_branch.clone(),
        path: project.path.clone(),
        branch: project.default_branch.clone(),
        base_branch: None,
        created_at: now(),
        setup_output: None,
        setup_script: None,
        setup_success: None,
        session_type: SessionType::Base,
        pr_number: None,
        pr_url: None,
        issue_number: None,
        linear_issue_identifier: None,
        security_alert_number: None,
        security_alert_url: None,
        advisory_ghsa_id: None,
        advisory_url: None,
        cached_pr_status: None,
        cached_check_status: None,
        cached_behind_count: None,
        cached_ahead_count: None,
        cached_status_at: None,
        cached_uncommitted_added: None,
        cached_uncommitted_removed: None,
        cached_branch_diff_added: None,
        cached_branch_diff_removed: None,
        cached_base_branch_ahead_count: None,
        cached_base_branch_behind_count: None,
        cached_worktree_ahead_count: None,
        cached_unpushed_count: None,
        pr_push_remote: None,
        pr_push_branch: None,
        order: 0,
        origin: None,
        labels: Vec::new(),
        label: None,
        archived_at: None,
        last_opened_at: None,
    };

    projects_data.add_worktree(new_worktree.clone());
    crate::projects::storage::save_projects_data(&app, &projects_data)?;

    // Restore preserved base sessions file (base-{project_id}.json -> {new_worktree_id}.json)
    // This is needed because close_base_session_archive renamed the index file
    let _restored_index =
        crate::chat::storage::restore_base_sessions(&app, &project_id, &new_worktree.id)?;

    // Atomically unarchive the target session within the restored sessions
    let restored_session = with_sessions_mut(&app, &worktree_path, &new_worktree.id, |sessions| {
        let session = sessions
            .find_session_mut(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        if session.archived_at.is_none() {
            return Err("Session is not archived".to_string());
        }

        session.archived_at = None;
        Ok(session.clone())
    })?;

    log::trace!("Base session recreated and sessions migrated");

    Ok(RestoreSessionWithBaseResponse {
        session: restored_session,
        worktree: new_worktree,
    })
}

/// Permanently delete an archived session
#[tauri::command]
pub async fn delete_archived_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<(), String> {
    log::trace!("Permanently deleting archived session: {session_id}");

    // Delete session data directory (outside lock - separate directory)
    if let Err(e) = delete_session_data(&app, &session_id) {
        log::warn!("Failed to delete session data: {e}");
    }

    // Clean up context references
    if let Err(e) =
        crate::projects::github_issues::cleanup_issue_contexts_for_session(&app, &session_id)
    {
        log::warn!("Failed to cleanup issue/PR contexts for session: {e}");
    }
    if let Err(e) =
        crate::projects::saved_contexts::cleanup_saved_contexts_for_session(&app, &session_id)
    {
        log::warn!("Failed to cleanup saved contexts for session: {e}");
    }

    // Clean up combined-context files for this session
    cleanup_combined_context_files(&app, &session_id);

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        let session_idx = sessions
            .sessions
            .iter()
            .position(|s| s.id == session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        if sessions.sessions[session_idx].archived_at.is_none() {
            return Err("Cannot delete non-archived session. Archive it first.".to_string());
        }

        sessions.sessions.remove(session_idx);
        log::trace!("Archived session permanently deleted: {session_id}");
        Ok(())
    })
}

/// List archived sessions for a worktree
#[tauri::command]
pub async fn list_archived_sessions(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
) -> Result<Vec<Session>, String> {
    log::trace!("Listing archived sessions for worktree: {worktree_id}");

    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;

    let archived: Vec<Session> = sessions
        .sessions
        .into_iter()
        .filter(|s| s.archived_at.is_some())
        .collect();

    log::trace!("Found {} archived sessions", archived.len());
    Ok(archived)
}

/// An archived session with its worktree context
#[derive(Debug, Clone, serde::Serialize)]
pub struct ArchivedSessionEntry {
    pub session: Session,
    pub worktree_id: String,
    pub worktree_name: String,
    pub worktree_path: String,
    pub project_id: String,
    pub project_name: String,
}

/// List all archived sessions across all worktrees (including archived worktrees)
#[tauri::command]
pub async fn list_all_archived_sessions(
    app: AppHandle,
) -> Result<Vec<ArchivedSessionEntry>, String> {
    log::trace!("Listing all archived sessions across all worktrees");

    let projects_data = load_projects_data(&app)?;
    let mut entries = Vec::new();

    for project in &projects_data.projects {
        // Get ALL worktrees (including archived) to find their archived sessions
        let worktrees: Vec<_> = projects_data
            .worktrees_for_project(&project.id)
            .into_iter()
            .collect();

        for worktree in worktrees {
            match load_sessions(&app, &worktree.path, &worktree.id) {
                Ok(sessions_data) => {
                    // Filter to archived sessions only
                    for session in sessions_data.sessions {
                        if session.archived_at.is_some() {
                            entries.push(ArchivedSessionEntry {
                                session,
                                worktree_id: worktree.id.clone(),
                                worktree_name: worktree.name.clone(),
                                worktree_path: worktree.path.clone(),
                                project_id: project.id.clone(),
                                project_name: project.name.clone(),
                            });
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "Failed to load sessions for worktree {}: {}",
                        worktree.id,
                        e
                    );
                }
            }
        }

        // Also check preserved base session files (base-{project_id}.json)
        // These are created when a base session is closed with archiving
        if let Ok(base_path) = get_base_index_path(&app, &project.id) {
            if base_path.exists() {
                if let Ok(contents) = std::fs::read_to_string(&base_path) {
                    if let Ok(index) = serde_json::from_str::<WorktreeIndex>(&contents) {
                        for entry in &index.sessions {
                            if entry.archived_at.is_some() {
                                // Load full session metadata
                                let session =
                                    if let Ok(Some(metadata)) = load_metadata(&app, &entry.id) {
                                        let mut s = metadata.to_session();
                                        // Ensure archived_at from index is preserved
                                        if s.archived_at.is_none() {
                                            s.archived_at = entry.archived_at;
                                        }
                                        s
                                    } else {
                                        // No metadata — build a minimal Session from index entry
                                        let mut s = Session::new(
                                            entry.name.clone(),
                                            entry.order,
                                            Backend::default(),
                                        );
                                        s.id = entry.id.clone();
                                        s.message_count = Some(entry.message_count);
                                        s.archived_at = entry.archived_at;
                                        s
                                    };

                                entries.push(ArchivedSessionEntry {
                                    session,
                                    worktree_id: index.worktree_id.clone(),
                                    worktree_name: format!("{} (base)", project.name),
                                    worktree_path: project.path.clone(),
                                    project_id: project.id.clone(),
                                    project_name: project.name.clone(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    log::trace!("Found {} archived sessions total", entries.len());
    Ok(entries)
}

/// Reorder session tabs
#[tauri::command]
pub async fn reorder_sessions(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_ids: Vec<String>,
) -> Result<(), String> {
    log::trace!("Reordering sessions");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        for (index, session_id) in session_ids.iter().enumerate() {
            if let Some(session) = sessions.find_session_mut(session_id) {
                session.order = index as u32;
            }
        }
        sessions.sessions.sort_by_key(|s| s.order);
        log::trace!("Sessions reordered");
        Ok(())
    })
}

/// Set the active session tab
#[tauri::command]
pub async fn set_active_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<(), String> {
    log::trace!("Setting active session: {session_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        sessions.active_session_id = Some(session_id.clone());
        Ok(())
    })?;

    // Update last_opened_at timestamp on the session metadata
    if let Ok(Some(mut metadata)) = load_metadata(&app, &session_id) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        metadata.last_opened_at = Some(now);
        let _ = save_metadata(&app, &metadata);
    }

    emit_sessions_cache_invalidation(&app);
    Ok(())
}

/// Update the last_opened_at timestamp on a session's metadata.
/// View-only: never mutates waiting/review state — explicit user actions
/// (approve/reject/answer) are the only path out of waiting.
#[tauri::command]
pub async fn set_session_last_opened(app: AppHandle, session_id: String) -> Result<(), String> {
    log::trace!("Setting last_opened_at for session: {session_id}");

    if let Ok(Some(mut metadata)) = load_metadata(&app, &session_id) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        metadata.last_opened_at = Some(now);
        save_metadata(&app, &metadata)?;
    }

    Ok(())
}

/// Bulk-update last_opened_at for multiple sessions in a single call.
#[tauri::command]
pub async fn set_sessions_last_opened_bulk(
    app: AppHandle,
    session_ids: Vec<String>,
) -> Result<(), String> {
    log::trace!(
        "Bulk setting last_opened_at for {} sessions",
        session_ids.len()
    );

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    for session_id in &session_ids {
        if let Ok(Some(mut metadata)) = load_metadata(&app, session_id) {
            metadata.last_opened_at = Some(now);
            save_metadata(&app, &metadata)?;
        }
    }

    Ok(())
}

// ============================================================================
// Chat Commands (now session-based)
// ============================================================================

// Persist a salvaged resume/session ID onto the correct backend field.
// Used by the thread-error/thread-panic recovery paths so the next send can
// resume the conversation instead of starting fresh.
fn persist_salvaged_resume_id(session: &mut Session, backend: &Backend, sid: &str) {
    match backend {
        Backend::Claude => session.claude_session_id = Some(sid.to_string()),
        Backend::Codex => session.codex_thread_id = Some(sid.to_string()),
        Backend::Opencode => session.opencode_session_id = Some(sid.to_string()),
        Backend::Cursor => session.cursor_chat_id = Some(sid.to_string()),
        Backend::Pi => session.pi_session_id = Some(sid.to_string()),
        // Command Code has no native resume id; persist a sentinel so the next
        // run continues the worktree conversation via `-c`.
        Backend::Commandcode => session.commandcode_session_id = Some(sid.to_string()),
        Backend::Grok => session.grok_session_id = Some(sid.to_string()),
    }
}

/// Send a message to Claude and get a response
///
/// This command:
/// 1. Loads existing session (includes Claude session ID if present)
/// 2. Adds the user message
/// 3. Executes Claude CLI (resumes Claude session if we have one)
/// 4. Stores the Claude session ID for future messages
/// 5. Adds the assistant response
/// 6. Saves the updated session
/// 7. Returns the assistant message

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_chat_message(
    app: tauri::AppHandle,
    session_id: String,
    worktree_id: String,
    worktree_path: String,
    message: String,
    model: Option<String>,
    execution_mode: Option<String>,
    thinking_level: Option<ThinkingLevel>,
    effort_level: Option<EffortLevel>,
    parallel_execution_prompt: Option<String>,
    ai_language: Option<String>,
    allowed_tools: Option<Vec<String>>,
    mcp_config: Option<String>,
    chrome_enabled: Option<bool>,
    custom_profile_name: Option<String>,
    backend: Option<String>,
) -> Result<ChatMessage, String> {
    log::info!("[SendChat] ENTRY session={session_id} worktree={worktree_id} model={model:?} execution_mode={execution_mode:?}");
    log::trace!("Sending chat message for session: {session_id}, worktree: {worktree_id}, model: {model:?}, execution_mode: {execution_mode:?}, thinking: {thinking_level:?}, effort: {effort_level:?}, allowed_tools: {allowed_tools:?}");

    // Validate inputs
    if message.trim().is_empty() {
        return Err("Message cannot be empty".to_string());
    }

    if worktree_path.is_empty() {
        return Err("Worktree path cannot be empty".to_string());
    }

    clear_stale_pending_cancel_before_send(&session_id);

    // Guard: atomically claim the session's send slot for the duration of this
    // call. Closes the race window where two concurrent sends (queue processor
    // vs backend drain vs another client) both pass the registry check below
    // before either registers a process.
    let Some(_send_claim) = SendClaim::try_acquire(&session_id) else {
        log::warn!(
            "[SendChat] REJECTED session={session_id} — concurrent send in flight (duplicate send)"
        );
        return Err("Session already has an active request".to_string());
    };

    // Guard: reject if this session already has an active process being tailed.
    // Without this, a double-send (frontend race, page reload, etc.) creates
    // duplicate run entries and orphans the first process in the registry.
    if super::registry::is_session_actively_managed(&session_id) {
        log::warn!(
            "[SendChat] REJECTED session={session_id} — already actively managed (duplicate send)"
        );
        return Err("Session already has an active request".to_string());
    }

    // Load sessions
    let mut sessions = load_sessions(&app, &worktree_path, &worktree_id)?;

    log::trace!(
        "Loaded {} sessions, looking for session_id: {session_id}",
        sessions.sessions.len()
    );
    log::trace!(
        "Available session IDs: {:?}",
        sessions.sessions.iter().map(|s| &s.id).collect::<Vec<_>>()
    );

    // Check if we should trigger automatic naming (session and/or branch)
    // Branch naming: first user message ever AND not already attempted
    // Session naming: first user message in THIS session AND not already attempted
    let is_first_worktree_message = !sessions.branch_naming_completed
        && sessions
            .sessions
            .iter()
            .flat_map(|s| &s.messages)
            .filter(|m| m.role == MessageRole::User)
            .count()
            == 0;

    let session_for_naming = sessions.find_session(&session_id).cloned();
    let is_first_session_message = session_for_naming
        .as_ref()
        .map(|sess| {
            !sess.session_naming_completed
                && sess
                    .messages
                    .iter()
                    .filter(|m| m.role == MessageRole::User)
                    .count()
                    == 0
        })
        .unwrap_or(false);

    // Spawn unified naming task if either condition is met
    if is_first_worktree_message || is_first_session_message {
        if let Ok(prefs) = crate::load_preferences(app.clone()).await {
            // Check if this is a base session or PR worktree - don't rename the branch
            let worktree_record = load_projects_data(&app)
                .ok()
                .and_then(|data| data.find_worktree(&worktree_id).cloned());
            let is_base_session = worktree_record
                .as_ref()
                .map(|w| w.session_type == SessionType::Base)
                .unwrap_or(false);
            let is_pr_worktree = worktree_record
                .as_ref()
                .map(|w| w.pr_number.is_some())
                .unwrap_or(false);

            let generate_branch = is_first_worktree_message
                && prefs.auto_branch_naming
                && !is_base_session
                && !is_pr_worktree;
            let generate_session = is_first_session_message && prefs.auto_session_naming;

            if generate_branch || generate_session {
                log::trace!(
                    "Spawning naming task (session: {generate_session}, branch: {generate_branch})"
                );

                // Get existing worktree names to avoid duplicates (only needed for branch naming)
                let existing_names = if generate_branch {
                    load_projects_data(&app)
                        .map(|data| data.worktrees.iter().map(|w| w.name.clone()).collect())
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };

                let custom_session_prompt = if generate_session {
                    prefs.magic_prompts.session_naming.clone()
                } else {
                    None
                };

                let request = NamingRequest {
                    session_id: session_id.clone(),
                    worktree_id: worktree_id.clone(),
                    worktree_path: PathBuf::from(&worktree_path),
                    first_message: message.clone(),
                    model: prefs.magic_prompt_models.session_naming_model.clone(),
                    existing_branch_names: existing_names,
                    generate_session_name: generate_session,
                    generate_branch_name: generate_branch,
                    custom_session_prompt,
                    // Keep provider semantics consistent with manual regeneration:
                    // session_naming_provider = None means Anthropic (no custom profile),
                    // not fallback to global default_provider.
                    custom_profile_name: prefs
                        .magic_prompt_providers
                        .session_naming_provider
                        .clone(),
                    backend_override: prefs.magic_prompt_backends.session_naming_backend.clone(),
                    reasoning_effort: prefs.magic_prompt_efforts.session_naming_effort.clone(),
                };

                // Spawn in background - does not block chat
                spawn_naming_task(app.clone(), request);
            }
        }

        // Mark as completed to prevent re-triggering (atomic update)
        with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            if is_first_worktree_message {
                sessions.branch_naming_completed = true;
            }
            if is_first_session_message {
                if let Some(session) = sessions.find_session_mut(&session_id) {
                    session.session_naming_completed = true;
                }
            }
            Ok(())
        })?;

        // Reload sessions to get fresh state after save
        sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    }

    // Notify all clients that a message is being sent (for real-time sync).
    // Include user_message so cross-client viewers can show it immediately
    // without refetching (avoids race with optimistic updates).
    if let Err(e) = app.emit_all(
        "chat:sending",
        &serde_json::json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "user_message": message,
        }),
    ) {
        log::error!("Failed to emit chat:sending event: {e}");
    }

    // Find the session
    let session = match sessions.find_session_mut(&session_id) {
        Some(s) => s,
        None => {
            let error_msg = format!(
                "Session not found: {session_id}. Available sessions: {:?}",
                sessions.sessions.iter().map(|s| &s.id).collect::<Vec<_>>()
            );
            log::error!("[SendChat] EXIT session={session_id} reason=session_not_found");
            log::error!("{}", error_msg);

            // Emit error event so frontend knows what happened

            let error_event = super::claude::ErrorEvent {
                session_id: session_id.clone(),
                worktree_id: worktree_id.clone(),
                error: "Session not found. Please refresh the page or create a new session."
                    .to_string(),
            };
            if let Err(e) = app.emit_all("chat:error", &error_event) {
                log::error!("Failed to emit chat:error event: {e}");
            }

            return Err(error_msg);
        }
    };

    // Generate user message ID early (needed for run log)
    let user_message_id = Uuid::new_v4().to_string();

    // Capture session info for run log before borrowing session mutably
    let session_name = session.name.clone();
    let session_order = session.order;

    // Note: User message is stored in NDJSON run entry (run.user_message),
    // not in sessions JSON. Messages are loaded from NDJSON on demand.

    // Determine backend from session (or explicit param, or default to claude)
    let session_backend = sessions
        .find_session(&session_id)
        .map(|s| s.backend.clone())
        .unwrap_or_default();
    let effective_backend = match backend.as_deref() {
        Some("codex") => Backend::Codex,
        Some("opencode") => Backend::Opencode,
        Some("cursor") => Backend::Cursor,
        Some("pi") => Backend::Pi,
        Some("commandcode") => Backend::Commandcode,
        Some("grok") => Backend::Grok,
        Some("claude") => Backend::Claude,
        _ => session_backend.clone(),
    };
    // Override backend based on model string (safety net: model always wins)
    let effective_backend = if let Some(ref m) = model {
        infer_backend_from_model(m, effective_backend)
    } else {
        effective_backend
    };

    // Sync session.backend when model-based resolution overrides it
    // (e.g. user switched from Claude model to Codex model mid-session).
    // Without this, run_log reload uses the stale backend to pick the parser.
    if effective_backend != session_backend {
        with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            if let Some(session) = sessions.find_session_mut(&session_id) {
                session.backend = effective_backend.clone();
            }
            Ok(())
        })?;
    }

    // Clear stale completion flags from previous turn — prevents approve
    // buttons from appearing on WS reconnect during this turn.
    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.waiting_for_input = false;
            session.is_reviewing = false;
            session.waiting_for_input_type = None;
        }
        Ok(())
    })?;

    // Build context for Claude
    let context = ClaudeContext::new(worktree_path.clone());

    // Get the session IDs for resumption
    let claude_session_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.claude_session_id.clone());
    let codex_thread_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.codex_thread_id.clone());
    let opencode_session_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.opencode_session_id.clone());
    let cursor_chat_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.cursor_chat_id.clone());
    let raw_pi_session_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.pi_session_id.clone());
    let grok_session_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.grok_session_id.clone());
    // Command Code has no native resume id; a non-empty sentinel marks that a
    // prior Command Code turn completed in this worktree, so the next run can
    // pass `-c` (cwd-scoped continue) to resume the conversation.
    let commandcode_session_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.commandcode_session_id.clone());
    let pi_session_id = raw_pi_session_id
        .as_deref()
        .filter(|sid| *sid != session_id)
        .map(ToOwned::to_owned);
    if raw_pi_session_id.as_deref() == Some(session_id.as_str()) {
        let _ = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            if let Some(session) = sessions.find_session_mut(&session_id) {
                session.pi_session_id = None;
            }
            Ok(())
        });
    }

    let previous_metadata = load_metadata(&app, &session_id).ok().flatten();
    let previous_backend = previous_metadata
        .as_ref()
        .and_then(super::handoff::latest_completed_backend);
    let previous_custom_profile = previous_metadata
        .as_ref()
        .and_then(super::handoff::latest_completed_custom_profile);
    let backend_handoff =
        super::handoff::should_inject_handoff(previous_backend.as_ref(), &effective_backend);
    // Resume Command Code by its native session id, but only when this session
    // already ran a Command Code turn and we're not handing off from a different
    // backend (handoff injects history into the prompt instead, so resuming the
    // old conversation would double up).
    let commandcode_resume_id: Option<String> = commandcode_session_id
        .clone()
        .filter(|_| effective_backend == Backend::Commandcode && !backend_handoff);
    let claude_profile_changed = effective_backend == Backend::Claude
        && claude_session_id.is_some()
        && previous_custom_profile.as_deref() != custom_profile_name.as_deref();
    let profile_handoff = super::handoff::should_inject_claude_profile_handoff(
        &effective_backend,
        previous_backend.as_ref(),
        previous_custom_profile.as_deref(),
        custom_profile_name.as_deref(),
    );
    let message_for_backend = if backend_handoff || profile_handoff {
        let history = run_log::load_session_messages_window(&app, &session_id, Some(20), None)
            .map(|loaded| super::handoff::format_handoff_history(&loaded.messages, 30_000))
            .unwrap_or_default();

        if let Some(previous_backend) = previous_backend.as_ref().filter(|_| !history.is_empty()) {
            let template = crate::load_preferences(app.clone())
                .await
                .ok()
                .and_then(|prefs| prefs.magic_prompts.provider_switch_handoff)
                .filter(|prompt| !prompt.trim().is_empty())
                .unwrap_or_else(crate::default_provider_switch_handoff_prompt);
            let handoff_prompt = if profile_handoff {
                super::handoff::build_claude_profile_handoff_prompt(
                    &template,
                    previous_custom_profile.as_deref(),
                    custom_profile_name.as_deref(),
                    &history,
                )
            } else {
                super::handoff::build_handoff_prompt(
                    &template,
                    previous_backend,
                    &effective_backend,
                    &history,
                )
            };
            log::info!(
                "[SendChat] injecting hidden provider-switch handoff session={session_id} previous={previous_backend:?} current={effective_backend:?}"
            );
            super::handoff::prepend_hidden_handoff(&message, &handoff_prompt)
        } else {
            message.clone()
        }
    } else {
        message.clone()
    };
    let claude_session_id = if claude_profile_changed {
        None
    } else {
        claude_session_id
    };

    // Cursor CLI doesn't support thinking/effort levels
    let run_thinking_level = if matches!(
        effective_backend,
        Backend::Cursor | Backend::Pi | Backend::Commandcode
    ) {
        None
    } else {
        thinking_level
            .as_ref()
            .map(|t| format!("{t:?}").to_lowercase())
    };
    let run_effort_level = match effective_backend {
        Backend::Cursor | Backend::Commandcode => None,
        Backend::Pi => effort_level.as_ref().map(|e| match e {
            EffortLevel::Off => "off",
            EffortLevel::Minimal => "minimal",
            EffortLevel::Low => "low",
            EffortLevel::Medium => "medium",
            EffortLevel::High => "high",
            EffortLevel::Xhigh | EffortLevel::Max | EffortLevel::Ultracode => "xhigh",
        }),
        _ => effort_level.as_ref().and_then(|e| e.effort_value()),
    };

    // Start NDJSON run log for crash recovery
    let mut run_log_writer = run_log::start_run(
        &app,
        &session_id,
        &worktree_id,
        &session_name,
        session_order,
        &user_message_id,
        &message,
        model.as_deref(),
        execution_mode.as_deref(),
        run_thinking_level.as_deref(),
        run_effort_level,
        Some(effective_backend.clone()),
        custom_profile_name.as_deref(),
    )?;

    // Get file paths for detached execution
    let input_file = run_log_writer.input_file_path()?;
    let output_file = run_log_writer.output_file_path()?;
    let run_id = run_log_writer.run_id().to_string();

    // Write input file with the effective backend prompt. Hidden handoff context
    // is intentionally not stored as the visible user message in metadata.
    run_log::write_input_file(&app, &session_id, &run_id, &message_for_backend)?;

    // Use passed parameter for parallel execution prompt (None = disabled)
    let parallel_execution_prompt = parallel_execution_prompt.filter(|p| !p.trim().is_empty());

    // Use passed parameter for Chrome browser integration (default false - beta)
    let chrome = chrome_enabled.unwrap_or(false);

    // Inject web tools in plan mode if preference is enabled
    // Claude: add WebFetch/WebSearch to allowed tools
    // Codex: set search_enabled flag for --search
    let mut final_allowed_tools = allowed_tools.unwrap_or_default();
    let mut codex_search_enabled = false;
    let mut codex_multi_agent_enabled = false;
    let mut codex_max_agent_threads: Option<u32> = None;
    if execution_mode.as_deref() == Some("plan") {
        if let Ok(prefs) = crate::load_preferences(app.clone()).await {
            if prefs.allow_web_tools_in_plan_mode {
                match effective_backend {
                    Backend::Claude => {
                        final_allowed_tools.push("WebFetch".to_string());
                        final_allowed_tools.push("WebSearch".to_string());
                    }
                    Backend::Codex => {
                        codex_search_enabled = true;
                    }
                    Backend::Opencode => {}
                    Backend::Cursor => {}
                    Backend::Pi => {}
                    Backend::Commandcode => {}
                    Backend::Grok => {}
                }
            }
        }
    }
    // Read Codex multi-agent preferences
    if effective_backend == Backend::Codex {
        if let Ok(prefs) = crate::load_preferences(app.clone()).await {
            codex_multi_agent_enabled = prefs.codex_multi_agent_enabled;
            if codex_multi_agent_enabled {
                codex_max_agent_threads = Some(prefs.codex_max_agent_threads.clamp(1, 8));
            }
        }
    }
    let allowed_tools_for_cli = if final_allowed_tools.is_empty() {
        None
    } else {
        Some(final_allowed_tools)
    };

    // Unified response type for both backends
    struct UnifiedResponse {
        content: String,
        /// Claude session ID or Codex thread ID (for resumption)
        resume_id: String,
        tool_calls: Vec<super::types::ToolCall>,
        content_blocks: Vec<super::types::ContentBlock>,
        cancelled: bool,
        /// True when the backend produced an approval-ready plan.
        waiting_for_plan: bool,
        /// Whether a chat:error event was emitted during execution
        error_emitted: bool,
        usage: Option<super::types::UsageData>,
        backend: Backend,
    }

    // Execute CLI in detached mode on a dedicated OS thread.
    // This prevents tokio thread pool starvation when many sessions run concurrently.
    let thread_app = app.clone();
    let thread_session_id = session_id.clone();
    let thread_worktree_id = worktree_id.clone();
    let thread_worktree_path = worktree_path.clone();
    let thread_input_file = input_file.clone();
    let thread_output_file = output_file.clone();
    let thread_working_dir = context.worktree_path.clone();
    let thread_claude_session_id = claude_session_id.clone();
    let thread_codex_thread_id = codex_thread_id.clone();
    let thread_run_id = run_id.clone();
    let thread_opencode_session_id = opencode_session_id.clone();
    let thread_cursor_chat_id = cursor_chat_id.clone();
    let thread_pi_session_id = pi_session_id.clone();
    let thread_grok_session_id = grok_session_id.clone();
    let thread_commandcode_resume_id = commandcode_resume_id.clone();
    let thread_model = model.clone();
    let thread_execution_mode = execution_mode.clone();
    let thread_thinking_level = thinking_level.clone();
    let thread_effort_level = effort_level.clone();
    let thread_allowed_tools = allowed_tools_for_cli.clone();
    let thread_parallel_prompt = parallel_execution_prompt.clone();
    let thread_ai_language = ai_language.clone();
    let thread_mcp_config = if effective_backend == Backend::Claude {
        super::jean_mcp::merge_into_mcp_config(&app, &session_id, mcp_config.as_deref())
            .await
            .or_else(|| mcp_config.clone())
    } else {
        mcp_config.clone()
    };
    let thread_custom_profile = custom_profile_name.clone();
    let thread_message = message_for_backend.clone();
    let thread_backend = effective_backend.clone();
    let thread_codex_search = codex_search_enabled;
    let thread_codex_multi_agent = codex_multi_agent_enabled;
    let thread_codex_max_threads = codex_max_agent_threads;

    // For OpenCode sessions: create a cancel flag so we can signal the blocking HTTP thread.
    // Register it before spawning so cancel_process can find it immediately.
    let opencode_cancel_flag = if effective_backend == Backend::Opencode {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        if !super::registry::register_cancel_flag(session_id.clone(), flag.clone()) {
            // Already cancelled before we even started — bail out cleanly
            log::info!("[SendChat] EXIT session={session_id} reason=pre_cancelled_opencode");
            if let Err(e) = run_log_writer.cancel(None, None) {
                log::warn!("Failed to cancel run log for pre-cancelled OpenCode session: {e}");
            }
            // Remove the input file so the hidden handoff/history payload isn't retained on disk.
            if let Err(e) = run_log::delete_input_file(&app, &session_id, &run_id) {
                log::warn!("Failed to delete input file for pre-cancelled OpenCode session: {e}");
            }
            return Err("Request cancelled".to_string());
        }
        Some(flag)
    } else {
        None
    };
    let thread_opencode_cancel_flag = opencode_cancel_flag.clone();

    // Build a callback factory that persists the PID to metadata immediately after spawn
    // (before tailing starts). This is critical for crash recovery — without it,
    // metadata has pid: None and recover_incomplete_runs marks the run as Crashed.
    // Uses Arc so it can be cloned for retry loops (Claude session-not-found retry).
    let pid_cb_app = app.clone();
    let pid_cb_session_id = session_id.clone();
    let pid_cb_worktree_id = worktree_id.clone();
    let pid_cb_session_name = session_name.clone();
    let pid_cb_run_id = run_id.clone();
    let make_pid_callback = move || -> Box<dyn FnOnce(u32) + Send> {
        let app = pid_cb_app.clone();
        let sid = pid_cb_session_id.clone();
        let wid = pid_cb_worktree_id.clone();
        let sname = pid_cb_session_name.clone();
        let rid = pid_cb_run_id.clone();
        Box::new(move |pid: u32| {
            use super::storage::with_metadata_mut;
            let _ = with_metadata_mut(&app, &sid, &wid, &sname, session_order, |metadata| {
                if let Some(run) = metadata.find_run_mut(&rid) {
                    run.pid = Some(pid);
                }
                Ok(())
            });
            log::trace!("Persisted PID {pid} to metadata for run: {rid}");
        })
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let result: Result<(u32, UnifiedResponse), String> = match thread_backend {
            Backend::Claude => {
                // === Claude execution path (unchanged) ===
                let mut claude_session_id_for_call = thread_claude_session_id;
                let result = loop {
                    log::trace!("About to call execute_claude_detached...");

                    match super::claude::execute_claude_detached(
                        &thread_app,
                        &thread_session_id,
                        &thread_worktree_id,
                        &thread_input_file,
                        &thread_output_file,
                        std::path::Path::new(&thread_working_dir),
                        claude_session_id_for_call.as_deref(),
                        thread_model.as_deref(),
                        thread_execution_mode.as_deref(),
                        thread_thinking_level.as_ref(),
                        thread_effort_level.as_ref(),
                        thread_allowed_tools.as_deref(),
                        thread_parallel_prompt.as_deref(),
                        thread_ai_language.as_deref(),
                        thread_mcp_config.as_deref(),
                        chrome,
                        thread_custom_profile.as_deref(),
                        Some(make_pid_callback()),
                    ) {
                        Ok((pid, response)) => {
                            log::trace!("execute_claude_detached succeeded (PID: {pid})");

                            if should_clear_stale_resumed_claude_session(
                                claude_session_id_for_call.is_some(),
                                !response.content.is_empty(),
                                !response.tool_calls.is_empty(),
                                !response.content_blocks.is_empty(),
                                response.usage.is_some(),
                                response.cancelled,
                            ) {
                                log::warn!(
                                    "Empty response while resuming session {}, clearing stale session ID",
                                    claude_session_id_for_call.as_deref().unwrap_or("")
                                );
                                let _ = with_sessions_mut(
                                    &thread_app,
                                    &thread_worktree_path,
                                    &thread_worktree_id,
                                    |sessions| {
                                        if let Some(session) =
                                            sessions.find_session_mut(&thread_session_id)
                                        {
                                            session.claude_session_id = None;
                                        }
                                        Ok(())
                                    },
                                );
                            }

                            break Ok((
                                pid,
                                UnifiedResponse {
                                    content: response.content,
                                    resume_id: response.session_id,
                                    tool_calls: response.tool_calls,
                                    content_blocks: response.content_blocks,
                                    cancelled: response.cancelled,
                                    waiting_for_plan: false,
                                    error_emitted: false,
                                    usage: response.usage,
                                    backend: Backend::Claude,
                                },
                            ));
                        }
                        Err(e) => {
                            let is_session_not_found = e.to_lowercase().contains("session")
                                && (e.to_lowercase().contains("not found")
                                    || e.to_lowercase().contains("invalid")
                                    || e.to_lowercase().contains("expired"));

                            if is_session_not_found && claude_session_id_for_call.is_some() {
                                log::warn!(
                                    "Session not found, clearing stored session ID and retrying: {}",
                                    claude_session_id_for_call.as_deref().unwrap_or("")
                                );
                                match with_sessions_mut(
                                    &thread_app,
                                    &thread_worktree_path,
                                    &thread_worktree_id,
                                    |sessions| {
                                        if let Some(session) =
                                            sessions.find_session_mut(&thread_session_id)
                                        {
                                            session.claude_session_id = None;
                                        }
                                        Ok(())
                                    },
                                ) {
                                    Ok(_) => {
                                        claude_session_id_for_call = None;
                                        continue;
                                    }
                                    Err(e) => {
                                        break Err(format!(
                                            "Session expired and failed to clear stale session state: {e}"
                                        ));
                                    }
                                }
                            }

                            log::error!("execute_claude_detached FAILED: {e}");
                            break Err(e);
                        }
                    }
                };
                result
            }
            Backend::Codex => {
                // === Codex execution path ===
                log::trace!("About to call execute_codex_via_server...");

                // Map EffortLevel to Codex reasoning effort values
                // Codex has no "max" or "ultracode"; cap at xhigh.
                let codex_reasoning_effort: Option<String> =
                    thread_effort_level.as_ref().and_then(|e| match e {
                        super::types::EffortLevel::Minimal => Some("low".to_string()),
                        super::types::EffortLevel::Low => Some("low".to_string()),
                        super::types::EffortLevel::Medium => Some("medium".to_string()),
                        super::types::EffortLevel::High => Some("high".to_string()),
                        super::types::EffortLevel::Xhigh => Some("xhigh".to_string()),
                        super::types::EffortLevel::Max => Some("xhigh".to_string()),
                        super::types::EffortLevel::Ultracode => Some("xhigh".to_string()),
                        super::types::EffortLevel::Off => None,
                    });

                // Build add_dirs for Codex
                let mut codex_add_dirs = Vec::new();
                if let Ok(app_data_dir) = thread_app.path().app_data_dir() {
                    if cfg!(debug_assertions) {
                        codex_add_dirs.push(app_data_dir.to_string_lossy().to_string());
                    } else {
                        for subdir in [
                            "pasted-images",
                            "pasted-texts",
                            "session-context",
                            "git-context",
                            "combined-contexts",
                        ] {
                            codex_add_dirs
                                .push(app_data_dir.join(subdir).to_string_lossy().to_string());
                        }
                        codex_add_dirs.push(
                            app_data_dir
                                .join("runs")
                                .join(&thread_session_id)
                                .to_string_lossy()
                                .to_string(),
                        );
                    }
                }
                if let Some(home) = dirs::home_dir() {
                    let codex_skills_dir = home.join(".codex").join("skills");
                    if codex_skills_dir.exists() {
                        codex_add_dirs.push(codex_skills_dir.to_string_lossy().to_string());
                    }
                }

                // Collect linked project paths once for both add_dirs and system prompt
                let linked_project_paths: Vec<String> =
                    crate::projects::storage::load_projects_data(&thread_app)
                        .ok()
                        .and_then(|data| {
                            let worktree = data.find_worktree(&thread_worktree_id)?;
                            let project = data.find_project(&worktree.project_id)?;
                            Some(
                                project
                                    .linked_project_ids
                                    .iter()
                                    .filter_map(|id| data.find_project(id))
                                    .filter(|p| !p.path.trim().is_empty())
                                    .map(|p| p.path.clone())
                                    .collect(),
                            )
                        })
                        .unwrap_or_default();
                for dir in &linked_project_paths {
                    codex_add_dirs.push(dir.clone());
                }

                // Build combined instructions file (system prompt equivalent for Codex)
                let codex_instructions_file = {
                    use crate::projects::github_issues::{
                        get_github_contexts_dir, get_session_advisory_refs, get_session_issue_refs,
                        get_session_pr_refs, get_session_security_refs,
                    };
                    use crate::projects::linear_issues::get_session_linear_refs;
                    use crate::projects::storage::load_projects_data;

                    let mut system_prompt_parts: Vec<String> = Vec::new();

                    // AI language preference
                    if let Some(lang) = &thread_ai_language {
                        let lang = lang.trim();
                        if !lang.is_empty() {
                            system_prompt_parts.push(format!("Respond to the user in {lang}."));
                        }
                    }

                    // Global system prompt from preferences (with default fallback)
                    let preferences_global_prompt = crate::get_preferences_path(&thread_app)
                        .ok()
                        .and_then(|prefs_path| std::fs::read_to_string(&prefs_path).ok())
                        .and_then(|contents| {
                            serde_json::from_str::<crate::AppPreferences>(&contents).ok()
                        })
                        .and_then(|prefs| prefs.magic_prompts.global_system_prompt);
                    system_prompt_parts.push(resolve_codex_global_system_prompt(
                        preferences_global_prompt.as_deref(),
                        thread_execution_mode.as_deref(),
                    ));

                    // Parallel execution prompt
                    if let Some(prompt) = &thread_parallel_prompt {
                        let prompt = prompt.trim();
                        if !prompt.is_empty() {
                            system_prompt_parts.push(prompt.to_string());
                        }
                    }

                    // Per-project custom system prompt + linked project instructions
                    if let Ok(data) = load_projects_data(&thread_app) {
                        if let Some(worktree) = data.find_worktree(&thread_worktree_id) {
                            if let Some(project) = data.find_project(&worktree.project_id) {
                                if let Some(prompt) = &project.custom_system_prompt {
                                    let prompt = prompt.trim();
                                    if !prompt.is_empty() {
                                        system_prompt_parts.push(prompt.to_string());
                                    }
                                }

                                // Linked projects: inject instruction to check their directories
                                if !linked_project_paths.is_empty() {
                                    let dirs_list = linked_project_paths
                                        .iter()
                                        .map(|p| format!("- {p}"))
                                        .collect::<Vec<_>>()
                                        .join("\n");
                                    system_prompt_parts.push(format!(
                                        "This project is linked to other projects for cross-project context. \
                                         Check the following directories for additional instructions and documentation \
                                         (e.g., CLAUDE.md, AGENTS.md, docs/):\n{dirs_list}"
                                    ));
                                }
                            }
                        }
                    }

                    // Embedded binary path hints
                    let gh_binary = crate::gh_cli::config::resolve_gh_binary(&thread_app);
                    if gh_binary != std::path::PathBuf::from("gh") {
                        system_prompt_parts.push(format!(
                            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
                             Do NOT use bare `gh` — always use the full path above.",
                            gh_binary.display()
                        ));
                    }
                    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(&thread_app) {
                        if claude_binary.exists() {
                            system_prompt_parts.push(format!(
                                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `claude` — always use the full path above.",
                                claude_binary.display()
                            ));
                        }
                    }
                    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(&thread_app) {
                        if codex_binary.exists() {
                            system_prompt_parts.push(format!(
                                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `codex` — always use the full path above.",
                                codex_binary.display()
                            ));
                        }
                    }

                    // End-of-turn recap instruction (compact view surfaces this block)
                    if super::should_add_recap_instruction(&thread_app) {
                        system_prompt_parts.push(super::RECAP_INSTRUCTION.to_string());
                    }

                    // Keep the current Codex execution mode as the final authoritative
                    // instruction so persisted/global plan-mode defaults cannot pull an
                    // approved build/yolo continuation back into planning behavior.
                    append_codex_execution_mode_instruction(
                        &mut system_prompt_parts,
                        thread_execution_mode.as_deref(),
                    );

                    // Collect context file paths (issues, PRs, saved contexts)
                    let mut all_context_paths: Vec<std::path::PathBuf> = Vec::new();

                    let mut issue_keys =
                        get_session_issue_refs(&thread_app, &thread_session_id).unwrap_or_default();
                    if let Ok(wt_keys) = get_session_issue_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !issue_keys.contains(&key) {
                                issue_keys.push(key);
                            }
                        }
                    }
                    if !issue_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &issue_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path =
                                        contexts_dir.join(format!("{repo_key}-issue-{number}.md"));
                                    if file_path.exists() {
                                        all_context_paths.push(file_path);
                                    }
                                }
                            }
                        }
                    }

                    let mut pr_keys =
                        get_session_pr_refs(&thread_app, &thread_session_id).unwrap_or_default();
                    if let Ok(wt_keys) = get_session_pr_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !pr_keys.contains(&key) {
                                pr_keys.push(key);
                            }
                        }
                    }
                    if !pr_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &pr_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path =
                                        contexts_dir.join(format!("{repo_key}-pr-{number}.md"));
                                    if file_path.exists() {
                                        all_context_paths.push(file_path);
                                    }
                                }
                            }
                        }
                    }

                    let mut security_keys =
                        get_session_security_refs(&thread_app, &thread_session_id)
                            .unwrap_or_default();
                    if let Ok(wt_keys) = get_session_security_refs(&thread_app, &thread_worktree_id)
                    {
                        for key in wt_keys {
                            if !security_keys.contains(&key) {
                                security_keys.push(key);
                            }
                        }
                    }
                    if !security_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &security_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path = contexts_dir
                                        .join(format!("{repo_key}-security-{number}.md"));
                                    if file_path.exists() {
                                        all_context_paths.push(file_path);
                                    }
                                }
                            }
                        }
                    }

                    let mut advisory_keys =
                        get_session_advisory_refs(&thread_app, &thread_session_id)
                            .unwrap_or_default();
                    if let Ok(wt_keys) = get_session_advisory_refs(&thread_app, &thread_worktree_id)
                    {
                        for key in wt_keys {
                            if !advisory_keys.contains(&key) {
                                advisory_keys.push(key);
                            }
                        }
                    }
                    if !advisory_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &advisory_keys {
                                if let Some((repo_key, ghsa_id)) = key.split_once("::") {
                                    let file_path = contexts_dir
                                        .join(format!("{repo_key}-advisory-{ghsa_id}.md"));
                                    if file_path.exists() {
                                        all_context_paths.push(file_path);
                                    }
                                }
                            }
                        }
                    }

                    let mut linear_keys = get_session_linear_refs(&thread_app, &thread_session_id)
                        .unwrap_or_default();
                    if let Ok(wt_keys) = get_session_linear_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !linear_keys.contains(&key) {
                                linear_keys.push(key);
                            }
                        }
                    }
                    if !linear_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &linear_keys {
                                let parts: Vec<&str> = key.rsplitn(3, '-').collect();
                                if parts.len() == 3 {
                                    let project_name_part = parts[2];
                                    let identifier_lower =
                                        format!("{}-{}", parts[1].to_lowercase(), parts[0]);
                                    let file_path = contexts_dir.join(format!(
                                        "{project_name_part}-linear-{identifier_lower}.md"
                                    ));
                                    if file_path.exists() {
                                        all_context_paths.push(file_path);
                                    }
                                }
                            }
                        }
                    }

                    // Saved context files
                    if let Ok(app_data_dir) = thread_app.path().app_data_dir() {
                        let saved_contexts_dir = app_data_dir.join("session-context");
                        if saved_contexts_dir.exists() {
                            let prefix = format!("{}-context-", thread_session_id);
                            if let Ok(entries) = std::fs::read_dir(&saved_contexts_dir) {
                                let mut context_files: Vec<_> = entries
                                    .flatten()
                                    .filter(|entry| {
                                        let name = entry.file_name().to_string_lossy().to_string();
                                        name.starts_with(&prefix) && name.ends_with(".md")
                                    })
                                    .collect();
                                context_files.sort_by_key(|e| e.file_name());
                                for entry in context_files {
                                    all_context_paths.push(entry.path());
                                }
                            }
                        }
                    }

                    // Write combined instructions file if we have anything
                    if !system_prompt_parts.is_empty() || !all_context_paths.is_empty() {
                        if let Ok(app_data_dir) = thread_app.path().app_data_dir() {
                            let combined_dir = app_data_dir.join("combined-contexts");
                            let _ = std::fs::create_dir_all(&combined_dir);
                            let combined_file = combined_dir
                                .join(format!("{}-codex-combined.md", thread_session_id));

                            let mut content = String::new();

                            if !system_prompt_parts.is_empty() {
                                content.push_str("# Instructions\n\n");
                                for part in &system_prompt_parts {
                                    content.push_str(part);
                                    content.push('\n');
                                }
                                content.push_str("\n---\n\n");
                            }

                            if !all_context_paths.is_empty() {
                                content.push_str("# Loaded Context\n\n");
                                content.push_str(
                                    "The following context has been loaded. \
                                     You should be aware of this when working on this task.\n\n---\n\n",
                                );
                                for path in &all_context_paths {
                                    if let Ok(file_content) = std::fs::read_to_string(path) {
                                        content.push_str(&file_content);
                                        content.push_str("\n\n---\n\n");
                                    }
                                }
                            }

                            match std::fs::write(&combined_file, &content) {
                                Ok(_) => {
                                    log::debug!(
                                        "Created Codex instructions file: {:?}",
                                        combined_file
                                    );
                                    Some(combined_file)
                                }
                                Err(e) => {
                                    log::error!("Failed to write Codex instructions file: {e}");
                                    None
                                }
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                // Read the instructions file content to pass inline via baseInstructions
                let codex_base_instructions_content: Option<String> = codex_instructions_file
                    .and_then(|path| {
                        std::fs::read_to_string(&path)
                            .map_err(|e| {
                                log::error!("Failed to read Codex instructions file: {e}");
                                e
                            })
                            .ok()
                    });

                match super::codex::execute_codex_via_server(
                    &thread_app,
                    &thread_session_id,
                    &thread_worktree_id,
                    &thread_run_id,
                    &thread_output_file,
                    std::path::Path::new(&thread_working_dir),
                    thread_codex_thread_id.as_deref(),
                    thread_model.as_deref(),
                    thread_execution_mode.as_deref(),
                    codex_reasoning_effort.as_deref(),
                    thread_codex_search,
                    &codex_add_dirs,
                    &thread_message,
                    codex_base_instructions_content.as_deref(),
                    thread_codex_multi_agent,
                    thread_codex_max_threads,
                ) {
                    Ok(response) => Ok((
                        0, // No PID for app-server sessions
                        UnifiedResponse {
                            content: response.content,
                            resume_id: response.thread_id,
                            tool_calls: response.tool_calls,
                            content_blocks: response.content_blocks,
                            cancelled: response.cancelled,
                            waiting_for_plan: false,
                            error_emitted: response.error_emitted,
                            usage: response.usage,
                            backend: Backend::Codex,
                        },
                    )),
                    Err(e) => {
                        log::error!("execute_codex_via_server FAILED: {e}");
                        Err(e)
                    }
                }
            }
            Backend::Opencode => {
                log::trace!("About to call execute_opencode...");

                // Collect linked project paths for system prompt injection
                let opencode_linked_project_paths: Vec<String> =
                    crate::projects::storage::load_projects_data(&thread_app)
                        .ok()
                        .and_then(|data| {
                            let worktree = data.find_worktree(&thread_worktree_id)?;
                            let project = data.find_project(&worktree.project_id)?;
                            Some(
                                project
                                    .linked_project_ids
                                    .iter()
                                    .filter_map(|id| data.find_project(id))
                                    .filter(|p| !p.path.trim().is_empty())
                                    .map(|p| p.path.clone())
                                    .collect(),
                            )
                        })
                        .unwrap_or_default();

                let opencode_reasoning_effort: Option<String> =
                    thread_effort_level.as_ref().and_then(|e| match e {
                        super::types::EffortLevel::Minimal => Some("low".to_string()),
                        super::types::EffortLevel::Low => Some("low".to_string()),
                        super::types::EffortLevel::Medium => Some("medium".to_string()),
                        super::types::EffortLevel::High => Some("high".to_string()),
                        super::types::EffortLevel::Xhigh => Some("xhigh".to_string()),
                        super::types::EffortLevel::Max => Some("xhigh".to_string()),
                        super::types::EffortLevel::Ultracode => Some("xhigh".to_string()),
                        super::types::EffortLevel::Off => None,
                    });

                let system_prompt = {
                    use crate::projects::github_issues::{
                        get_github_contexts_dir, get_session_advisory_refs, get_session_issue_refs,
                        get_session_pr_refs, get_session_security_refs,
                    };
                    use crate::projects::linear_issues::get_session_linear_refs;
                    use crate::projects::storage::load_projects_data;

                    let mut system_prompt_parts: Vec<String> = Vec::new();

                    // AI language preference
                    if let Some(lang) = &thread_ai_language {
                        let lang = lang.trim();
                        if !lang.is_empty() {
                            system_prompt_parts.push(format!("Respond to the user in {lang}."));
                        }
                    }

                    // Global system prompt from preferences
                    if let Ok(prefs_path) = crate::get_preferences_path(&thread_app) {
                        if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                            if let Ok(prefs) =
                                serde_json::from_str::<crate::AppPreferences>(&contents)
                            {
                                if let Some(prompt) = prefs
                                    .magic_prompts
                                    .global_system_prompt
                                    .as_deref()
                                    .map(|s| s.trim())
                                    .filter(|s| !s.is_empty())
                                {
                                    system_prompt_parts.push(prompt.to_string());
                                }
                            }
                        }
                    }

                    // Parallel execution prompt
                    if let Some(prompt) = &thread_parallel_prompt {
                        let prompt = prompt.trim();
                        if !prompt.is_empty() {
                            system_prompt_parts.push(prompt.to_string());
                        }
                    }

                    // Per-project custom system prompt + linked project instructions
                    if let Ok(data) = load_projects_data(&thread_app) {
                        if let Some(worktree) = data.find_worktree(&thread_worktree_id) {
                            if let Some(project) = data.find_project(&worktree.project_id) {
                                if let Some(prompt) = &project.custom_system_prompt {
                                    let prompt = prompt.trim();
                                    if !prompt.is_empty() {
                                        system_prompt_parts.push(prompt.to_string());
                                    }
                                }

                                // Linked projects: inject instruction to check their directories
                                if !opencode_linked_project_paths.is_empty() {
                                    let dirs_list = opencode_linked_project_paths
                                        .iter()
                                        .map(|p| format!("- {p}"))
                                        .collect::<Vec<_>>()
                                        .join("\n");
                                    system_prompt_parts.push(format!(
                                        "This project is linked to other projects for cross-project context. \
                                         Check the following directories for additional instructions and documentation \
                                         (e.g., CLAUDE.md, AGENTS.md, docs/):\n{dirs_list}"
                                    ));
                                }
                            }
                        }
                    }

                    // Embedded binary path hints
                    let gh_binary = crate::gh_cli::config::resolve_gh_binary(&thread_app);
                    if gh_binary != std::path::PathBuf::from("gh") {
                        system_prompt_parts.push(format!(
                            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
                             Do NOT use bare `gh` — always use the full path above.",
                            gh_binary.display()
                        ));
                    }
                    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(&thread_app) {
                        if claude_binary.exists() {
                            system_prompt_parts.push(format!(
                                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `claude` — always use the full path above.",
                                claude_binary.display()
                            ));
                        }
                    }
                    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(&thread_app) {
                        if codex_binary.exists() {
                            system_prompt_parts.push(format!(
                                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `codex` — always use the full path above.",
                                codex_binary.display()
                            ));
                        }
                    }

                    // End-of-turn recap instruction (compact view surfaces this block)
                    if super::should_add_recap_instruction(&thread_app) {
                        system_prompt_parts.push(super::RECAP_INSTRUCTION.to_string());
                    }

                    // Collect and inline context files (issues, PRs, saved contexts)
                    let mut context_content = String::new();

                    let mut issue_keys =
                        get_session_issue_refs(&thread_app, &thread_session_id).unwrap_or_default();
                    if let Ok(wt_keys) = get_session_issue_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !issue_keys.contains(&key) {
                                issue_keys.push(key);
                            }
                        }
                    }
                    if !issue_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &issue_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path =
                                        contexts_dir.join(format!("{repo_key}-issue-{number}.md"));
                                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    let mut pr_keys =
                        get_session_pr_refs(&thread_app, &thread_session_id).unwrap_or_default();
                    if let Ok(wt_keys) = get_session_pr_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !pr_keys.contains(&key) {
                                pr_keys.push(key);
                            }
                        }
                    }
                    if !pr_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &pr_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path =
                                        contexts_dir.join(format!("{repo_key}-pr-{number}.md"));
                                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    let mut security_keys =
                        get_session_security_refs(&thread_app, &thread_session_id)
                            .unwrap_or_default();
                    if let Ok(wt_keys) = get_session_security_refs(&thread_app, &thread_worktree_id)
                    {
                        for key in wt_keys {
                            if !security_keys.contains(&key) {
                                security_keys.push(key);
                            }
                        }
                    }
                    if !security_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &security_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path = contexts_dir
                                        .join(format!("{repo_key}-security-{number}.md"));
                                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    let mut advisory_keys =
                        get_session_advisory_refs(&thread_app, &thread_session_id)
                            .unwrap_or_default();
                    if let Ok(wt_keys) = get_session_advisory_refs(&thread_app, &thread_worktree_id)
                    {
                        for key in wt_keys {
                            if !advisory_keys.contains(&key) {
                                advisory_keys.push(key);
                            }
                        }
                    }
                    if !advisory_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &advisory_keys {
                                if let Some((repo_key, ghsa_id)) = key.split_once("::") {
                                    let file_path = contexts_dir
                                        .join(format!("{repo_key}-advisory-{ghsa_id}.md"));
                                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    let mut linear_keys = get_session_linear_refs(&thread_app, &thread_session_id)
                        .unwrap_or_default();
                    if let Ok(wt_keys) = get_session_linear_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !linear_keys.contains(&key) {
                                linear_keys.push(key);
                            }
                        }
                    }
                    if !linear_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &linear_keys {
                                let parts: Vec<&str> = key.rsplitn(3, '-').collect();
                                if parts.len() == 3 {
                                    let project_name_part = parts[2];
                                    let identifier_lower =
                                        format!("{}-{}", parts[1].to_lowercase(), parts[0]);
                                    let file_path = contexts_dir.join(format!(
                                        "{project_name_part}-linear-{identifier_lower}.md"
                                    ));
                                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    // Saved context files
                    if let Ok(app_data_dir) = thread_app.path().app_data_dir() {
                        let saved_contexts_dir = app_data_dir.join("session-context");
                        if saved_contexts_dir.exists() {
                            let prefix = format!("{}-context-", thread_session_id);
                            if let Ok(entries) = std::fs::read_dir(&saved_contexts_dir) {
                                let mut context_files: Vec<_> = entries
                                    .flatten()
                                    .filter(|entry| {
                                        let name = entry.file_name().to_string_lossy().to_string();
                                        name.starts_with(&prefix) && name.ends_with(".md")
                                    })
                                    .collect();
                                context_files.sort_by_key(|e| e.file_name());
                                for entry in context_files {
                                    if let Ok(content) = std::fs::read_to_string(entry.path()) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    // Build final system prompt
                    let mut final_prompt = String::new();
                    if !system_prompt_parts.is_empty() {
                        final_prompt.push_str(&system_prompt_parts.join("\n\n"));
                    }
                    if !context_content.is_empty() {
                        if !final_prompt.is_empty() {
                            final_prompt.push_str("\n\n---\n\n");
                        }
                        final_prompt.push_str("# Loaded Context\n\n");
                        final_prompt.push_str(
                            "The following context has been loaded. \
                             You should be aware of this when working on this task.\n\n---\n\n",
                        );
                        final_prompt.push_str(&context_content);
                    }

                    if final_prompt.is_empty() {
                        None
                    } else {
                        Some(final_prompt)
                    }
                };

                // Use a default no-op flag if somehow None (shouldn't happen for Opencode backend)
                let default_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let cancel_flag = thread_opencode_cancel_flag
                    .as_ref()
                    .unwrap_or(&default_flag);

                match super::opencode::execute_opencode_http(
                    &thread_app,
                    &thread_session_id,
                    &thread_worktree_id,
                    &thread_run_id,
                    std::path::Path::new(&thread_working_dir),
                    thread_opencode_session_id.as_deref(),
                    thread_model.as_deref(),
                    thread_execution_mode.as_deref(),
                    opencode_reasoning_effort.as_deref(),
                    &thread_message,
                    system_prompt.as_deref(),
                    cancel_flag,
                ) {
                    Ok(response) => {
                        let waiting_for_plan = thread_execution_mode.as_deref() == Some("plan")
                            && !response.content.is_empty();
                        Ok((
                            // OpenCode has no child process PID; use 0 as a sentinel.
                            // Crash recovery checks run.pid via is_process_alive — None means
                            // the pid_callback was never called, which is correct for OpenCode.
                            0,
                            UnifiedResponse {
                                content: response.content,
                                resume_id: response.session_id,
                                tool_calls: response.tool_calls,
                                content_blocks: response.content_blocks,
                                cancelled: response.cancelled,
                                waiting_for_plan,
                                error_emitted: false,
                                usage: response.usage,
                                backend: Backend::Opencode,
                            },
                        ))
                    }
                    Err(e) => {
                        log::error!("execute_opencode FAILED: {e}");
                        Err(e)
                    }
                }
            }
            Backend::Cursor => {
                let cursor_linked_project_paths: Vec<String> =
                    crate::projects::storage::load_projects_data(&thread_app)
                        .ok()
                        .and_then(|data| {
                            let worktree = data.find_worktree(&thread_worktree_id)?;
                            let project = data.find_project(&worktree.project_id)?;
                            Some(
                                project
                                    .linked_project_ids
                                    .iter()
                                    .filter_map(|id| data.find_project(id))
                                    .filter(|p| !p.path.trim().is_empty())
                                    .map(|p| p.path.clone())
                                    .collect(),
                            )
                        })
                        .unwrap_or_default();

                let cursor_system_prompt: Option<String> = {
                    use crate::projects::storage::load_projects_data;

                    let mut parts: Vec<String> = Vec::new();

                    if let Some(lang) = &thread_ai_language {
                        let lang = lang.trim();
                        if !lang.is_empty() {
                            parts.push(format!("Respond to the user in {lang}."));
                        }
                    }

                    if let Ok(prefs_path) = crate::get_preferences_path(&thread_app) {
                        if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                            if let Ok(prefs) =
                                serde_json::from_str::<crate::AppPreferences>(&contents)
                            {
                                if let Some(prompt) = prefs
                                    .magic_prompts
                                    .global_system_prompt
                                    .as_deref()
                                    .map(|s| s.trim())
                                    .filter(|s| !s.is_empty())
                                {
                                    parts.push(prompt.to_string());
                                }
                            }
                        }
                    }

                    if let Some(prompt) = &thread_parallel_prompt {
                        let prompt = prompt.trim();
                        if !prompt.is_empty() {
                            parts.push(prompt.to_string());
                        }
                    }

                    if let Ok(data) = load_projects_data(&thread_app) {
                        if let Some(worktree) = data.find_worktree(&thread_worktree_id) {
                            if let Some(project) = data.find_project(&worktree.project_id) {
                                if let Some(prompt) = &project.custom_system_prompt {
                                    let prompt = prompt.trim();
                                    if !prompt.is_empty() {
                                        parts.push(prompt.to_string());
                                    }
                                }

                                if !cursor_linked_project_paths.is_empty() {
                                    let dirs_list = cursor_linked_project_paths
                                        .iter()
                                        .map(|p| format!("- {p}"))
                                        .collect::<Vec<_>>()
                                        .join("\n");
                                    parts.push(format!(
                                        "This project is linked to other projects for cross-project context. \
                                         Check the following directories for additional instructions and documentation \
                                         (e.g., CLAUDE.md, AGENTS.md, docs/):\n{dirs_list}"
                                    ));
                                }
                            }
                        }
                    }

                    let gh_binary = crate::gh_cli::config::resolve_gh_binary(&thread_app);
                    if gh_binary != std::path::PathBuf::from("gh") {
                        parts.push(format!(
                            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
                             Do NOT use bare `gh` — always use the full path above.",
                            gh_binary.display()
                        ));
                    }
                    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(&thread_app) {
                        if claude_binary.exists() {
                            parts.push(format!(
                                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `claude` — always use the full path above.",
                                claude_binary.display()
                            ));
                        }
                    }
                    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(&thread_app) {
                        if codex_binary.exists() {
                            parts.push(format!(
                                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `codex` — always use the full path above.",
                                codex_binary.display()
                            ));
                        }
                    }

                    // End-of-turn recap instruction (compact view surfaces this block)
                    if super::should_add_recap_instruction(&thread_app) {
                        parts.push(super::RECAP_INSTRUCTION.to_string());
                    }

                    if parts.is_empty() {
                        None
                    } else {
                        Some(parts.join("\n\n"))
                    }
                };

                match super::cursor::execute_cursor(
                    &thread_app,
                    &thread_session_id,
                    &thread_worktree_id,
                    &thread_run_id,
                    std::path::Path::new(&thread_working_dir),
                    thread_cursor_chat_id.as_deref(),
                    thread_model.as_deref(),
                    thread_execution_mode.as_deref(),
                    &thread_message,
                    thread_mcp_config.as_deref(),
                    cursor_system_prompt.as_deref(),
                    Some(make_pid_callback()),
                ) {
                    Ok(response) => Ok((
                        0,
                        UnifiedResponse {
                            content: response.content,
                            resume_id: response.chat_id,
                            tool_calls: response.tool_calls,
                            content_blocks: response.content_blocks,
                            cancelled: response.cancelled,
                            waiting_for_plan: false,
                            error_emitted: false,
                            usage: response.usage,
                            backend: Backend::Cursor,
                        },
                    )),
                    Err(e) => {
                        log::error!("execute_cursor FAILED: {e}");
                        Err(e)
                    }
                }
            }
            Backend::Commandcode => {
                let system_context =
                    super::context_instructions::build_combined_terminal_context_content(
                        &thread_app,
                        &thread_session_id,
                        &thread_worktree_id,
                    );
                match super::commandcode::execute_commandcode_headless(
                    &thread_app,
                    &thread_session_id,
                    &thread_worktree_id,
                    &thread_run_id,
                    std::path::Path::new(&thread_working_dir),
                    thread_execution_mode.as_deref(),
                    thread_model.as_deref(),
                    &thread_message,
                    Some(&system_context),
                    thread_commandcode_resume_id.as_deref(),
                    Some(make_pid_callback()),
                ) {
                    Ok((_pid, response)) => Ok((
                        0,
                        UnifiedResponse {
                            content: response.content,
                            resume_id: response.session_id,
                            tool_calls: response.tool_calls,
                            content_blocks: response.content_blocks,
                            cancelled: response.cancelled,
                            waiting_for_plan: response.waiting_for_plan,
                            error_emitted: false,
                            usage: response.usage,
                            backend: Backend::Commandcode,
                        },
                    )),
                    Err(e) => {
                        log::error!("execute_commandcode_headless FAILED: {e}");
                        Err(e)
                    }
                }
            }
            Backend::Pi => {
                let pi_system_prompt: Option<String> = {
                    use crate::projects::storage::load_projects_data;

                    let mut parts: Vec<String> = Vec::new();

                    if let Some(lang) = &thread_ai_language {
                        let lang = lang.trim();
                        if !lang.is_empty() {
                            parts.push(format!("Respond to the user in {lang}."));
                        }
                    }

                    if let Ok(prefs_path) = crate::get_preferences_path(&thread_app) {
                        if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                            if let Ok(prefs) =
                                serde_json::from_str::<crate::AppPreferences>(&contents)
                            {
                                if let Some(prompt) = prefs
                                    .magic_prompts
                                    .global_system_prompt
                                    .as_deref()
                                    .map(|s| s.trim())
                                    .filter(|s| !s.is_empty())
                                {
                                    parts.push(prompt.to_string());
                                }
                            }
                        }
                    }

                    if let Some(prompt) = &thread_parallel_prompt {
                        let prompt = prompt.trim();
                        if !prompt.is_empty() {
                            parts.push(prompt.to_string());
                        }
                    }

                    if let Ok(data) = load_projects_data(&thread_app) {
                        if let Some(worktree) = data.find_worktree(&thread_worktree_id) {
                            if let Some(project) = data.find_project(&worktree.project_id) {
                                if let Some(prompt) = &project.custom_system_prompt {
                                    let prompt = prompt.trim();
                                    if !prompt.is_empty() {
                                        parts.push(prompt.to_string());
                                    }
                                }

                                let linked_paths = project
                                    .linked_project_ids
                                    .iter()
                                    .filter_map(|id| data.find_project(id))
                                    .filter(|p| !p.path.trim().is_empty())
                                    .map(|p| p.path.clone())
                                    .collect::<Vec<_>>();
                                if !linked_paths.is_empty() {
                                    let dirs_list = linked_paths
                                        .iter()
                                        .map(|p| format!("- {p}"))
                                        .collect::<Vec<_>>()
                                        .join("\n");
                                    parts.push(format!(
                                        "This project is linked to other projects for cross-project context. \
                                         Check the following directories for additional instructions and documentation \
                                         (e.g., CLAUDE.md, AGENTS.md, docs/):\n{dirs_list}"
                                    ));
                                }
                            }
                        }
                    }

                    let gh_binary = crate::gh_cli::config::resolve_gh_binary(&thread_app);
                    if gh_binary != std::path::PathBuf::from("gh") {
                        parts.push(format!(
                            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
                             Do NOT use bare `gh` — always use the full path above.",
                            gh_binary.display()
                        ));
                    }
                    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(&thread_app) {
                        if claude_binary.exists() {
                            parts.push(format!(
                                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `claude` — always use the full path above.",
                                claude_binary.display()
                            ));
                        }
                    }
                    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(&thread_app) {
                        if codex_binary.exists() {
                            parts.push(format!(
                                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `codex` — always use the full path above.",
                                codex_binary.display()
                            ));
                        }
                    }

                    if super::should_add_recap_instruction(&thread_app) {
                        parts.push(super::RECAP_INSTRUCTION.to_string());
                    }

                    if parts.is_empty() {
                        None
                    } else {
                        Some(parts.join("\n\n"))
                    }
                };

                match super::pi::execute_pi(
                    &thread_app,
                    &thread_session_id,
                    &thread_worktree_id,
                    &thread_output_file,
                    std::path::Path::new(&thread_working_dir),
                    thread_pi_session_id.as_deref(),
                    thread_model.as_deref(),
                    thread_execution_mode.as_deref(),
                    thread_effort_level.as_ref(),
                    &thread_message,
                    pi_system_prompt.as_deref(),
                    Some(make_pid_callback()),
                ) {
                    Ok(response) => Ok((
                        0,
                        UnifiedResponse {
                            content: response.content,
                            resume_id: response.session_id,
                            tool_calls: response.tool_calls,
                            content_blocks: response.content_blocks,
                            cancelled: response.cancelled,
                            waiting_for_plan: false,
                            error_emitted: false,
                            usage: response.usage,
                            backend: Backend::Pi,
                        },
                    )),
                    Err(e) => {
                        log::error!("execute_pi FAILED: {e}");
                        Err(e)
                    }
                }
            }
            Backend::Grok => {
                let grok_system_prompt: Option<String> = {
                    use crate::projects::storage::load_projects_data;

                    let mut parts: Vec<String> = Vec::new();

                    if let Some(lang) = &thread_ai_language {
                        let lang = lang.trim();
                        if !lang.is_empty() {
                            parts.push(format!("Respond to the user in {lang}."));
                        }
                    }

                    if let Ok(prefs_path) = crate::get_preferences_path(&thread_app) {
                        if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                            if let Ok(prefs) =
                                serde_json::from_str::<crate::AppPreferences>(&contents)
                            {
                                if let Some(prompt) = prefs
                                    .magic_prompts
                                    .global_system_prompt
                                    .as_deref()
                                    .map(|s| s.trim())
                                    .filter(|s| !s.is_empty())
                                {
                                    parts.push(prompt.to_string());
                                }
                            }
                        }
                    }

                    if let Some(prompt) = &thread_parallel_prompt {
                        let prompt = prompt.trim();
                        if !prompt.is_empty() {
                            parts.push(prompt.to_string());
                        }
                    }

                    if let Ok(data) = load_projects_data(&thread_app) {
                        if let Some(worktree) = data.find_worktree(&thread_worktree_id) {
                            if let Some(project) = data.find_project(&worktree.project_id) {
                                if let Some(prompt) = &project.custom_system_prompt {
                                    let prompt = prompt.trim();
                                    if !prompt.is_empty() {
                                        parts.push(prompt.to_string());
                                    }
                                }

                                let linked_paths = project
                                    .linked_project_ids
                                    .iter()
                                    .filter_map(|id| data.find_project(id))
                                    .filter(|p| !p.path.trim().is_empty())
                                    .map(|p| p.path.clone())
                                    .collect::<Vec<_>>();
                                if !linked_paths.is_empty() {
                                    let dirs_list = linked_paths
                                        .iter()
                                        .map(|p| format!("- {p}"))
                                        .collect::<Vec<_>>()
                                        .join("\n");
                                    parts.push(format!(
                                        "This project is linked to other projects for cross-project context. \
                                         Check the following directories for additional instructions and documentation \
                                         (e.g., CLAUDE.md, AGENTS.md, docs/):\n{dirs_list}"
                                    ));
                                }
                            }
                        }
                    }

                    let gh_binary = crate::gh_cli::config::resolve_gh_binary(&thread_app);
                    if gh_binary != std::path::PathBuf::from("gh") {
                        parts.push(format!(
                            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
                             Do NOT use bare `gh` — always use the full path above.",
                            gh_binary.display()
                        ));
                    }
                    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(&thread_app) {
                        if claude_binary.exists() {
                            parts.push(format!(
                                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `claude` — always use the full path above.",
                                claude_binary.display()
                            ));
                        }
                    }
                    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(&thread_app) {
                        if codex_binary.exists() {
                            parts.push(format!(
                                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `codex` — always use the full path above.",
                                codex_binary.display()
                            ));
                        }
                    }

                    if super::should_add_recap_instruction(&thread_app) {
                        parts.push(super::RECAP_INSTRUCTION.to_string());
                    }

                    if parts.is_empty() {
                        None
                    } else {
                        Some(parts.join("\n\n"))
                    }
                };

                let grok_effort: Option<String> =
                    thread_effort_level.as_ref().and_then(|e| match e {
                        super::types::EffortLevel::Minimal => Some("low".to_string()),
                        super::types::EffortLevel::Low => Some("low".to_string()),
                        super::types::EffortLevel::Medium => Some("medium".to_string()),
                        super::types::EffortLevel::High => Some("high".to_string()),
                        super::types::EffortLevel::Xhigh => Some("xhigh".to_string()),
                        super::types::EffortLevel::Max => Some("max".to_string()),
                        super::types::EffortLevel::Ultracode => Some("max".to_string()),
                        super::types::EffortLevel::Off => None,
                    });

                match super::grok::execute_grok(super::grok::GrokExecutionOptions {
                    app: &thread_app,
                    jean_session_id: &thread_session_id,
                    worktree_id: &thread_worktree_id,
                    working_dir: std::path::Path::new(&thread_working_dir),
                    existing_grok_session_id: thread_grok_session_id.as_deref(),
                    model: thread_model.as_deref(),
                    execution_mode: thread_execution_mode.as_deref(),
                    effort_level: grok_effort.as_deref(),
                    message: &thread_message,
                    system_prompt: grok_system_prompt.as_deref(),
                    pid_callback: Some(make_pid_callback()),
                }) {
                    Ok(response) => Ok((
                        0,
                        UnifiedResponse {
                            content: response.content,
                            resume_id: response.session_id,
                            tool_calls: response.tool_calls,
                            content_blocks: response.content_blocks,
                            cancelled: response.cancelled,
                            waiting_for_plan: false,
                            error_emitted: false,
                            usage: response.usage,
                            backend: Backend::Grok,
                        },
                    )),
                    Err(e) => {
                        log::error!("execute_grok FAILED: {e}");
                        Err(e)
                    }
                }
            }
        };

        let _ = tx.send(result);
    });

    let (_pid, unified_response) = match rx.await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => {
            // Thread completed with an error — clean up all registrations.
            log::info!("[SendChat] EXIT session={session_id} reason=thread_error error={e}");
            super::registry::cleanup_session_registrations(&session_id);
            if let Some(ref flag) = opencode_cancel_flag {
                if !flag.load(std::sync::atomic::Ordering::SeqCst) {
                    // Mark run as crashed so it doesn't stay in Running forever
                    if let Err(mark_err) = run_log_writer.mark_crashed() {
                        log::warn!("Failed to mark OpenCode run as crashed: {mark_err}");
                    }
                }
                // If the flag was set, the cancel_process path already marked the run as Cancelled
            } else {
                // Non-OpenCode error: check if CLI actually completed despite the
                // thread error (e.g. tailing timed out but CLI finished). If so,
                // salvage the run as Completed with the resume ID (#209).
                // Always try to extract partial session_id from JSONL for --resume continuity
                let partial_sid =
                    run_log::extract_session_id_from_jsonl(&app, &session_id, &run_id);
                if run_log::jsonl_has_result_line(&app, &session_id, &run_id) {
                    log::info!(
                        "[SendChat] CLI completed despite thread error for session={session_id}, salvaging run"
                    );
                    let salvage_msg_id = Uuid::new_v4().to_string();
                    if let Err(complete_err) =
                        run_log_writer.complete(&salvage_msg_id, partial_sid.as_deref(), None)
                    {
                        log::warn!("Failed to complete salvaged run: {complete_err}");
                    }
                    // Also persist resume ID to session index so --resume works
                    if let Some(ref sid) = partial_sid {
                        if let Err(save_err) =
                            with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
                                if let Some(session) = sessions.find_session_mut(&session_id) {
                                    persist_salvaged_resume_id(session, &effective_backend, sid);
                                    session.is_reviewing = true;
                                    session.waiting_for_input = false;
                                }
                                Ok(())
                            })
                        {
                            log::warn!(
                                "Failed to save salvaged resume ID (will recover on restart): {save_err}"
                            );
                        }
                    }
                    emit_sessions_cache_invalidation(&app);
                } else {
                    if let Err(mark_err) = run_log_writer.mark_crashed() {
                        log::warn!("Failed to mark run as crashed after thread error: {mark_err}");
                    }
                    // Persist partial session_id even for crashed/cancelled runs so next send can --resume
                    if let Some(ref sid) = partial_sid {
                        let _ = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
                            if let Some(session) = sessions.find_session_mut(&session_id) {
                                persist_salvaged_resume_id(session, &effective_backend, sid);
                            }
                            Ok(())
                        });
                    }
                }
            }
            // Remove the input file so the hidden handoff/history payload isn't retained on disk.
            if let Err(del_err) = run_log::delete_input_file(&app, &session_id, &run_id) {
                log::warn!("Failed to delete input file after thread error: {del_err}");
            }
            trigger_backend_queue_drain(
                app.clone(),
                worktree_id.clone(),
                worktree_path.clone(),
                session_id.clone(),
            );
            return Err(e);
        }
        Err(_) => {
            log::info!("[SendChat] EXIT session={session_id} reason=thread_panic");
            super::registry::cleanup_session_registrations(&session_id);
            // Check if CLI completed despite thread panic (#209)
            let partial_sid = run_log::extract_session_id_from_jsonl(&app, &session_id, &run_id);
            if run_log::jsonl_has_result_line(&app, &session_id, &run_id) {
                log::info!(
                    "[SendChat] CLI completed despite thread panic for session={session_id}, salvaging run"
                );
                let salvage_msg_id = Uuid::new_v4().to_string();
                if let Err(complete_err) =
                    run_log_writer.complete(&salvage_msg_id, partial_sid.as_deref(), None)
                {
                    log::warn!("Failed to complete salvaged run after panic: {complete_err}");
                }
                emit_sessions_cache_invalidation(&app);
            } else {
                if let Err(mark_err) = run_log_writer.mark_crashed() {
                    log::warn!("Failed to mark run as crashed after thread panic: {mark_err}");
                }
                // Persist partial session_id so next send can --resume despite crash/cancel
                if let Some(ref sid) = partial_sid {
                    let _ = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
                        if let Some(session) = sessions.find_session_mut(&session_id) {
                            persist_salvaged_resume_id(session, &effective_backend, sid);
                        }
                        Ok(())
                    });
                }
            }
            // Remove the input file so the hidden handoff/history payload isn't retained on disk.
            if let Err(del_err) = run_log::delete_input_file(&app, &session_id, &run_id) {
                log::warn!("Failed to delete input file after thread panic: {del_err}");
            }
            trigger_backend_queue_drain(
                app.clone(),
                worktree_id.clone(),
                worktree_path.clone(),
                session_id.clone(),
            );
            return Err(
                "CLI execution thread closed unexpectedly (possible crash or panic)".to_string(),
            );
        }
    };

    // Clear any stale pending cancel entry and unregister OpenCode cancel flag now that we have a result.
    super::registry::cleanup_session_registrations(&session_id);

    // PID is now persisted via pid_callback immediately after spawn (before tailing).
    // No need to set_pid here — it was already saved for crash recovery.

    // OpenCode/Cursor runs are reconstructed in-process rather than tailed from a
    // detached JSONL stream. Write a synthetic assistant line so history reload can
    // reconstruct content after the live stream completes.
    // Skip when cancelled: cancelled turns stay in run metadata/logs for diagnostics
    // but are intentionally excluded from visible chat history on reload.
    if matches!(
        unified_response.backend,
        Backend::Opencode | Backend::Cursor | Backend::Pi | Backend::Commandcode | Backend::Grok
    ) && !unified_response.cancelled
    {
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&output_file) {
            if !unified_response.content_blocks.is_empty() {
                // Filter out echoed user prompt: OpenCode includes the user
                // message as the first text block in its response.
                // Compare against the *effective* prompt (message_for_backend),
                // not the raw message — when a hidden provider-switch handoff is
                // prepended, the backend echoes the submitted prompt including the
                // handoff. Matching the raw message would let that injected history
                // leak into the visible assistant transcript/NDJSON.
                let trimmed_prompt = message_for_backend.trim();
                let blocks_to_write: Vec<&super::types::ContentBlock> = {
                    let mut iter = unified_response.content_blocks.iter().peekable();
                    let first = iter.peek();
                    let skip_first = matches!(first,
                        Some(super::types::ContentBlock::Text { text }) if text.trim() == trimmed_prompt
                    );
                    if skip_first {
                        iter.next();
                    }
                    iter.collect()
                };
                let blocks: Vec<serde_json::Value> = blocks_to_write
                    .iter()
                    .map(|cb| match cb {
                        super::types::ContentBlock::Text { text } => {
                            serde_json::json!({"type": "text", "text": text})
                        }
                        super::types::ContentBlock::ToolUse { tool_call_id } => {
                            if let Some(tc) = unified_response
                                .tool_calls
                                .iter()
                                .find(|t| t.id == *tool_call_id)
                            {
                                serde_json::json!({
                                    "type": "tool_use",
                                    "id": tc.id,
                                    "name": tc.name,
                                    "input": tc.input
                                })
                            } else {
                                serde_json::json!({
                                    "type": "tool_use",
                                    "id": tool_call_id,
                                    "name": "",
                                    "input": null
                                })
                            }
                        }
                        super::types::ContentBlock::Thinking { thinking } => {
                            serde_json::json!({"type": "thinking", "thinking": thinking})
                        }
                        super::types::ContentBlock::UserInput { text } => {
                            serde_json::json!({"type": "user_input", "text": text})
                        }
                    })
                    .collect();
                let synthetic =
                    serde_json::json!({"type": "assistant", "message": {"content": blocks}});
                let _ = writeln!(file, "{synthetic}");

                for tc in &unified_response.tool_calls {
                    if let Some(output) = &tc.output {
                        let tool_result = serde_json::json!({
                            "type": "user",
                            "message": {
                                "content": [{
                                    "type": "tool_result",
                                    "tool_use_id": tc.id,
                                    "content": output
                                }]
                            }
                        });
                        let _ = writeln!(file, "{tool_result}");
                    }
                }
            } else {
                let synthetic = serde_json::json!({
                    "type": "assistant",
                    "message": {
                        "content": [{"type": "text", "text": unified_response.content}]
                    }
                });
                let _ = writeln!(file, "{synthetic}");
            }
            let _ = file.flush();
        }
    }

    // Clean up input file (no longer needed)
    if let Err(e) = run_log::delete_input_file(&app, &session_id, &run_id) {
        log::warn!("Failed to delete input file: {e}");
    }

    // Handle cancellation: only save if there's meaningful content (>10 chars) or tool calls
    // This avoids cluttering history with empty cancelled messages from instant cancellations
    let has_meaningful_content = unified_response.content.len() >= 10;
    let has_tool_calls = !unified_response.tool_calls.is_empty();
    let has_content_blocks = !unified_response.content_blocks.is_empty();
    let has_assistant_payload =
        !unified_response.content.is_empty() || has_tool_calls || has_content_blocks;
    let resume_id_for_log = unified_response.resume_id.clone();
    let response_backend = unified_response.backend.clone();
    let has_persisted_visible_codex_artifacts = unified_response.cancelled
        && response_backend == Backend::Codex
        && !has_assistant_payload
        && run_log::read_run_log(&app, &session_id, &run_id)
            .map(|lines| {
                super::codex::codex_run_log_has_visible_assistant_artifacts(
                    &lines,
                    execution_mode.as_deref() == Some("plan"),
                )
            })
            .unwrap_or(false);
    let has_resume_worthy_payload = has_assistant_payload || has_persisted_visible_codex_artifacts;

    // Handle error_emitted: backend emitted chat:error during execution (e.g., Codex usage limit).
    // Treat like undo_send so the user message doesn't persist in history.
    if unified_response.error_emitted {
        if let Err(e) = run_log_writer.cancel(None, None) {
            log::warn!("Failed to cancel run log after error: {e}");
        }
        log::info!("[SendChat] EXIT session={session_id} reason=error_emitted");
        trigger_backend_queue_drain(
            app.clone(),
            worktree_id.clone(),
            worktree_path.clone(),
            session_id.clone(),
        );
        return Ok(ChatMessage {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            role: MessageRole::Assistant,
            content: String::new(),
            timestamp: now(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            plan_approved: false,
            model: None,
            execution_mode: None,
            thinking_level: None,
            effort_level: None,
            recovered: false,
            usage: None,
        });
    }

    if unified_response.cancelled
        && !has_meaningful_content
        && !has_tool_calls
        && !has_content_blocks
        && !has_persisted_visible_codex_artifacts
    {
        // Instant cancellation with no content
        let resume_sid = resume_id_for_persisted_claude_run(
            &response_backend,
            &resume_id_for_log,
            has_resume_worthy_payload,
        );
        // Cancel the run log, persisting session ID if available so next run can --resume
        if let Err(e) = run_log_writer.cancel(None, resume_sid) {
            log::warn!("Failed to cancel run log: {e}");
        }

        // Atomically update session: persist resume ID and remove user message for undo send
        with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            if let Some(session) = sessions.find_session_mut(&session_id) {
                // Persist resume ID so next run can resume context even after cancellation
                if !resume_id_for_log.is_empty()
                    && (response_backend != Backend::Claude || has_assistant_payload)
                {
                    match response_backend {
                        Backend::Claude => {
                            session.claude_session_id = Some(resume_id_for_log.clone());
                        }
                        Backend::Codex => {
                            session.codex_thread_id = Some(resume_id_for_log.clone());
                        }
                        Backend::Opencode => {
                            session.opencode_session_id = Some(resume_id_for_log.clone());
                        }
                        Backend::Cursor => {
                            session.cursor_chat_id = Some(resume_id_for_log.clone());
                        }
                        Backend::Pi => {
                            session.pi_session_id = Some(resume_id_for_log.clone());
                        }
                        Backend::Commandcode => {
                            session.commandcode_session_id = Some(resume_id_for_log.clone());
                        }
                        Backend::Grok => {
                            session.grok_session_id = Some(resume_id_for_log.clone());
                        }
                    }
                }
                // Remove user message (undo send) - allows frontend to restore to input field
                if session
                    .messages
                    .last()
                    .is_some_and(|m| m.role == MessageRole::User)
                {
                    session.messages.pop();
                    log::trace!("Removed user message for undo send in session: {session_id}");
                }
            }
            Ok(())
        })?;

        log::info!("[SendChat] EXIT session={session_id} reason=cancelled_no_content");
        trigger_backend_queue_drain(
            app.clone(),
            worktree_id.clone(),
            worktree_path.clone(),
            session_id.clone(),
        );
        // Return a minimal cancelled message (not persisted, just for UI)
        return Ok(ChatMessage {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            role: MessageRole::Assistant,
            content: String::new(),
            timestamp: now(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            plan_approved: false,
            model: None,
            execution_mode: None,
            thinking_level: None,
            effort_level: None,
            recovered: false,
            usage: None,
        });
    }

    // Pre-compute completion state flags before moving unified_response fields
    let has_content = !unified_response.content.is_empty();
    let was_cancelled = unified_response.cancelled;
    let has_blocking_tool = unified_response
        .tool_calls
        .iter()
        .any(is_pending_blocking_tool_call);
    let has_question_tool = unified_response
        .tool_calls
        .iter()
        .any(is_pending_question_tool_call);
    let has_plan_tool = unified_response
        .tool_calls
        .iter()
        .any(is_pending_plan_tool_call);
    let is_plan_mode_with_content = if response_backend == Backend::Commandcode {
        unified_response.waiting_for_plan
    } else {
        plan_mode_content_waits_for_approval(
            &response_backend,
            execution_mode.as_deref(),
            has_content,
            has_plan_tool,
        )
    };

    // Create assistant message with tool calls and content blocks
    let assistant_msg_id = Uuid::new_v4().to_string();
    let assistant_msg = ChatMessage {
        id: assistant_msg_id.clone(),
        session_id: session_id.clone(),
        role: MessageRole::Assistant,
        content: unified_response.content,
        timestamp: now(),
        tool_calls: unified_response.tool_calls,
        content_blocks: unified_response.content_blocks,
        cancelled: unified_response.cancelled,
        plan_approved: false,
        model: None,
        execution_mode: None,
        thinking_level: None,
        effort_level: None,
        recovered: false,
        usage: unified_response.usage.clone(),
    };
    // Note: Assistant message is stored in NDJSON, not sessions JSON.
    // Messages are loaded from NDJSON on demand via load_session_messages().

    // Finalize run log (complete or cancel based on response status)
    if was_cancelled {
        let cancel_resume_sid = resume_id_for_persisted_claude_run(
            &response_backend,
            &resume_id_for_log,
            has_resume_worthy_payload,
        );
        if let Err(e) = run_log_writer.cancel(Some(&assistant_msg_id), cancel_resume_sid) {
            log::warn!("Failed to cancel run log: {e}");
        }
    } else {
        let resume_sid = resume_id_for_persisted_claude_run(
            &response_backend,
            &resume_id_for_log,
            has_resume_worthy_payload,
        );
        if let Err(e) =
            run_log_writer.complete(&assistant_msg_id, resume_sid, unified_response.usage)
        {
            log::warn!("Failed to complete run log: {e}");
        }
    }

    // Atomically save session metadata (resume ID for session continuity)
    // Note: Messages are NOT saved here - they're in NDJSON only
    // Only persist if the run produced meaningful content.
    // IMPORTANT: This is non-fatal — the critical data (run completion, JSONL content)
    // is already persisted by run_log_writer.complete() above. If this fails, the
    // resume ID and completion state will be recovered on next app startup via
    // recover_incomplete_runs(). Making this fatal would cause the frontend to roll
    // back the conversation cache even though the CLI ran successfully (#209).
    if let Err(e) = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            if !resume_id_for_log.is_empty() && has_resume_worthy_payload {
                match response_backend {
                    Backend::Claude => {
                        session.claude_session_id = Some(resume_id_for_log.clone());
                    }
                    Backend::Codex => {
                        session.codex_thread_id = Some(resume_id_for_log.clone());
                    }
                    Backend::Opencode => {
                        session.opencode_session_id = Some(resume_id_for_log.clone());
                    }
                    Backend::Cursor => {
                        session.cursor_chat_id = Some(resume_id_for_log.clone());
                    }
                    Backend::Pi => {
                        session.pi_session_id = Some(resume_id_for_log.clone());
                    }
                    Backend::Commandcode => {
                        session.commandcode_session_id = Some(resume_id_for_log.clone());
                    }
                    Backend::Grok => {
                        session.grok_session_id = Some(resume_id_for_log.clone());
                    }
                }
            }

            // Persist completion state (single authoritative write).
            // This eliminates the dual-client race where both native and web frontends
            // independently call update_session_state with conflicting decisions.
            // Flags are pre-computed above before unified_response fields are moved.
            let queued_prompt_should_continue = queued_prompt_skips_plan_wait(
                !session.queued_messages.is_empty(),
                has_question_tool,
                has_blocking_tool || is_plan_mode_with_content,
            );
            if was_cancelled {
                // Cancelled: don't change waiting/reviewing state
            } else if queued_prompt_should_continue {
                // A queued prompt is an explicit "continue now"; don't park on
                // plan approval because the backend queue drain runs right after
                // this write and should be allowed to dequeue it.
                session.waiting_for_input = false;
                session.is_reviewing = true;
                session.waiting_for_input_type = None;
            } else if has_blocking_tool {
                session.waiting_for_input = true;
                session.is_reviewing = false;
                session.waiting_for_input_type = Some(
                    if has_question_tool {
                        "question"
                    } else {
                        "plan"
                    }
                    .to_string(),
                );
            } else if is_plan_mode_with_content {
                // Codex/OpenCode plan-mode with content → waiting for plan approval
                session.waiting_for_input = true;
                session.is_reviewing = false;
                session.waiting_for_input_type = Some("plan".to_string());
            } else {
                // Normal completion
                session.waiting_for_input = false;
                session.is_reviewing = true;
                session.waiting_for_input_type = None;
            }
        }
        Ok(())
    }) {
        log::error!(
            "[SendChat] Failed to save session state for session={session_id} (non-fatal, will recover on restart): {e}"
        );
    }

    // Emit cache invalidation so all clients (native + web) refetch authoritative state
    emit_sessions_cache_invalidation(&app);

    if was_cancelled {
        log::info!("[SendChat] EXIT session={session_id} reason=cancelled_with_content");
    } else {
        log::info!("[SendChat] EXIT session={session_id} reason=success");
    }
    trigger_backend_queue_drain(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        session_id.clone(),
    );
    Ok(assistant_msg)
}

/// Clear chat history for a session
/// This also clears the Claude session ID, starting a fresh conversation
/// Preserves the selected model and thinking level preferences
#[tauri::command]
pub async fn clear_session_history(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<(), String> {
    log::trace!("Clearing chat history for session: {session_id}");

    // Delete NDJSON run data first (outside lock - separate file)
    if let Err(e) = delete_session_data(&app, &session_id) {
        log::warn!("Failed to delete session data: {e}");
    }

    // Clean up combined-context files for this session
    cleanup_combined_context_files(&app, &session_id);

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            let selected_model = session.selected_model.clone();
            let selected_thinking_level = session.selected_thinking_level.clone();
            let selected_effort_level = session.selected_effort_level.clone();
            let selected_provider = session.selected_provider.clone();

            session.messages.clear();
            session.claude_session_id = None;
            session.codex_thread_id = None;
            session.opencode_session_id = None;
            session.cursor_chat_id = None;
            session.pi_session_id = None;
            session.commandcode_session_id = None;
            session.grok_session_id = None;
            session.selected_model = selected_model;
            session.selected_thinking_level = selected_thinking_level;
            session.selected_effort_level = selected_effort_level;
            session.selected_provider = selected_provider;

            log::trace!("Session history cleared");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Set the selected model for a session
#[tauri::command]
pub async fn set_session_model(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    model: String,
) -> Result<(), String> {
    log::trace!("Setting model for session {session_id}: {model}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            // Keep claude_session_id intact — CLI's --resume respects --model,
            // so switching models mid-session preserves conversation context.
            session.selected_model = Some(model);
            log::trace!("Model selection saved");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Set the selected thinking level for a session
#[tauri::command]
pub async fn set_session_thinking_level(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    thinking_level: ThinkingLevel,
) -> Result<(), String> {
    log::trace!("Setting thinking level for session {session_id}: {thinking_level:?}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.selected_thinking_level = Some(thinking_level);
            log::trace!("Thinking level selection saved");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Set the selected effort level for a session
#[tauri::command]
pub async fn set_session_effort_level(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    effort_level: EffortLevel,
) -> Result<(), String> {
    log::trace!("Setting effort level for session {session_id}: {effort_level:?}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.selected_effort_level = Some(effort_level);
            log::trace!("Effort level selection saved");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Set the selected provider (custom CLI profile) for a session
#[tauri::command]
pub async fn set_session_provider(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    provider: Option<String>,
) -> Result<(), String> {
    log::trace!("Setting provider for session {session_id}: {provider:?}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.selected_provider = provider;
            log::trace!("Provider selection saved");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Set the backend for a session
#[tauri::command]
pub async fn set_session_backend(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    backend: String,
) -> Result<(), String> {
    log::trace!("Setting backend for session {session_id}: {backend}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.backend = match backend.as_str() {
                "codex" => super::types::Backend::Codex,
                "opencode" => super::types::Backend::Opencode,
                "cursor" => super::types::Backend::Cursor,
                "pi" => super::types::Backend::Pi,
                "commandcode" => super::types::Backend::Commandcode,
                "grok" => super::types::Backend::Grok,
                _ => super::types::Backend::Claude,
            };
            log::trace!("Backend selection saved");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

// =============================================================================
// Codex `/goal` long-horizon mode (codex backend only)
// =============================================================================
//
// Wraps the codex app-server experimental `thread/goal/{set,get,clear}` RPCs.
// The goal is also persisted on `Session.codex_goal` so the UI banner survives
// restarts; the server-side `thread/goal/updated` notification handler keeps
// the persisted copy in sync if the model itself toggles the goal.

/// Set or replace the persisted goal for a codex session.
///
/// If no codex thread exists yet (no first message sent), the goal is buffered
/// on `Session.codex_goal` and pushed to the app-server via `thread/goal/set`
/// after `thread/start` succeeds (see `flush_pending_codex_goal`).
#[tauri::command]
pub fn codex_goal_set(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    objective: String,
) -> Result<(), String> {
    let trimmed = objective.trim();
    if trimmed.is_empty() {
        return Err("Goal objective cannot be empty".to_string());
    }

    let thread_id = codex_thread_id_for_session(&app, &worktree_id, &worktree_path, &session_id)?;

    if let Some(tid) = thread_id {
        super::codex_server::ensure_running(&app)?;
        let params = codex_goal_set_params(&tid, trimmed);
        super::codex_server::send_request("thread/goal/set", params)?;
    }

    persist_codex_goal(
        &app,
        &worktree_id,
        &worktree_path,
        &session_id,
        Some(trimmed.to_string()),
    )?;
    Ok(())
}

/// Read the current persisted goal for a codex session.
#[tauri::command]
pub fn codex_goal_get(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<Option<String>, String> {
    let thread_id = codex_thread_id_for_session(&app, &worktree_id, &worktree_path, &session_id)?;

    let goal = if let Some(tid) = thread_id {
        super::codex_server::ensure_running(&app)?;
        let response = super::codex_server::send_request(
            "thread/goal/get",
            serde_json::json!({ "threadId": tid }),
        )?;
        extract_codex_goal_objective(&response)
    } else {
        super::storage::with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            Ok(sessions
                .find_session(&session_id)
                .and_then(|s| s.codex_goal.clone()))
        })?
    };

    persist_codex_goal(
        &app,
        &worktree_id,
        &worktree_path,
        &session_id,
        goal.clone(),
    )?;
    Ok(goal)
}

/// Clear the persisted goal for a codex session.
#[tauri::command]
pub fn codex_goal_clear(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<(), String> {
    let thread_id = codex_thread_id_for_session(&app, &worktree_id, &worktree_path, &session_id)?;

    if let Some(tid) = thread_id {
        super::codex_server::ensure_running(&app)?;
        super::codex_server::send_request(
            "thread/goal/clear",
            serde_json::json!({ "threadId": tid }),
        )?;
    }

    persist_codex_goal(&app, &worktree_id, &worktree_path, &session_id, None)?;
    Ok(())
}

/// Resolve the codex thread ID for a session, returning `None` if no thread
/// has been started yet. Errors only when the session is missing or the
/// backend is not codex.
fn codex_thread_id_for_session(
    app: &AppHandle,
    worktree_id: &str,
    worktree_path: &str,
    session_id: &str,
) -> Result<Option<String>, String> {
    super::storage::with_sessions_mut(app, worktree_path, worktree_id, |sessions| {
        let session = sessions
            .find_session(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        if !matches!(session.backend, super::types::Backend::Codex) {
            return Err("/goal is only available on codex sessions".to_string());
        }
        Ok(session.codex_thread_id.clone())
    })
}

/// Push a buffered `Session.codex_goal` into the app-server via
/// `thread/goal/set` after a fresh thread starts. Called once we have a
/// thread ID for a session that already has a buffered objective.
pub fn flush_pending_codex_goal(app: &AppHandle, session_id: &str, thread_id: &str) {
    let goal =
        super::storage::with_existing_metadata_mut(app, session_id, |meta| meta.codex_goal.clone())
            .ok()
            .flatten();
    let Some(objective) = goal else { return };
    let params = codex_goal_set_params(thread_id, &objective);
    if let Err(e) = super::codex_server::send_request("thread/goal/set", params) {
        log::warn!("Failed to flush buffered codex goal: {e}");
    }
}

fn codex_goal_set_params(thread_id: &str, objective: &str) -> serde_json::Value {
    serde_json::json!({
        "threadId": thread_id,
        "objective": objective,
        "status": "active",
    })
}

pub(crate) fn extract_codex_goal_objective(response: &serde_json::Value) -> Option<String> {
    response
        .get("goal")
        .and_then(|goal| goal.get("objective"))
        .and_then(|objective| objective.as_str())
        .map(|objective| objective.to_string())
}

/// Persist the goal on the session metadata and broadcast cache invalidation.
pub(crate) fn persist_codex_goal(
    app: &AppHandle,
    worktree_id: &str,
    worktree_path: &str,
    session_id: &str,
    goal: Option<String>,
) -> Result<(), String> {
    super::storage::with_sessions_mut(app, worktree_path, worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(session_id) {
            session.codex_goal = goal.clone();
        }
        Ok(())
    })?;
    let _ = app.emit_all(
        "chat:codex_goal",
        &CodexGoalEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            goal,
        },
    );
    Ok(())
}

#[derive(serde::Serialize, Clone)]
struct CodexGoalEvent {
    session_id: String,
    worktree_id: String,
    goal: Option<String>,
}

/// Cancel a running Claude chat request for a session
/// Returns true if a process was found and cancelled, false if no process was running
#[tauri::command]
pub async fn cancel_chat_message(
    app: AppHandle,
    session_id: String,
    worktree_id: String,
) -> Result<bool, String> {
    log::trace!("Cancel chat message requested for session: {session_id}");
    if !should_forward_cancel_request(&session_id) {
        log::warn!(
            "Ignoring cancel request for idle session: {session_id} (no active send/process)"
        );
        super::registry::cleanup_session_registrations(&session_id);
        return Ok(false);
    }
    cancel_process(&app, &session_id, &worktree_id)
}

/// Check if any sessions have running Claude processes
/// Used for quit confirmation dialog to prevent accidental closure during active sessions
#[tauri::command]
pub fn has_running_sessions() -> bool {
    !super::registry::get_running_sessions().is_empty()
}

/// Check if any running sessions would NOT survive Jean quitting.
/// Detached Claude processes and (on Unix) detached Codex app-server turns
/// keep running after exit and are recovered on next launch; OpenCode and
/// piped CLI sessions are not.
pub fn has_nonsurvivable_running_sessions() -> bool {
    super::registry::has_nonsurvivable_running_sessions()
}

/// Save a cancelled message to chat history
/// Called by frontend when a response is cancelled mid-stream to persist
/// partial content to the JSONL file. This ensures the content survives
/// app reload even if the backend command handler hasn't finished writing yet.
#[tauri::command]
pub async fn save_cancelled_message(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    content: String,
    tool_calls: Vec<super::types::ToolCall>,
    content_blocks: Vec<super::types::ContentBlock>,
) -> Result<(), String> {
    let _ = (worktree_id, worktree_path);

    if content.is_empty() && tool_calls.is_empty() && content_blocks.is_empty() {
        return Ok(());
    }

    super::run_log::persist_partial_cancelled_content(
        &app,
        &session_id,
        &content,
        &tool_calls,
        &content_blocks,
    )
}

/// Mark a message's plan as approved
///
/// With NDJSON-only storage, this adds the message ID to the session's
/// approved_plan_message_ids list. When loading messages from NDJSON,
/// we set plan_approved=true for messages in this list.
#[tauri::command]
pub async fn mark_plan_approved(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    log::trace!("Marking plan approved for message: {message_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            if !session.approved_plan_message_ids.contains(&message_id) {
                session.approved_plan_message_ids.push(message_id.clone());
                log::trace!("Plan marked as approved (added to approved_plan_message_ids)");
            }
            // Clear waiting state after approval
            session.waiting_for_input = false;
            session.pending_plan_message_id = None;
            session.waiting_for_input_type = None;
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

// ============================================================================
// Image Commands (for pasted images in chat)
// ============================================================================

use super::storage::get_images_dir;
use super::types::SaveImageResponse;
use base64::{engine::general_purpose::STANDARD, Engine};

/// Allowed MIME types for pasted images
const ALLOWED_MIME_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Maximum image size in bytes (10MB)
const MAX_IMAGE_SIZE: usize = 10 * 1024 * 1024;

/// Max dimension per Claude's vision docs: images >1568px get downscaled internally
/// by Claude anyway, so pre-scaling saves bandwidth with zero quality loss.
/// See: https://platform.claude.com/docs/en/build-with-claude/vision
const MAX_IMAGE_DIMENSION: u32 = 1568;

/// JPEG quality for compression (85 = good quality/size balance)
const JPEG_QUALITY: u8 = 85;

/// Minimum file size to bother processing (skip tiny images)
const MIN_PROCESS_SIZE: usize = 50 * 1024; // 50KB

/// Inner processing: resize and/or re-encode an already-decoded image.
/// Called by both `process_image` (file/paste path) and `read_clipboard_image` (avoids
/// PNG encode→decode round-trip for clipboard images).
fn process_dynamic_image(
    img: image::DynamicImage,
    extension: &str,
    needs_resize: bool,
    convert_to_jpeg: bool,
) -> Result<(Vec<u8>, String), String> {
    let (width, height) = (img.width(), img.height());
    let target_ext = if convert_to_jpeg { "jpg" } else { extension };

    // Resize if needed (preserve aspect ratio)
    let processed = if needs_resize {
        let max_dim = width.max(height);
        let scale = MAX_IMAGE_DIMENSION as f32 / max_dim as f32;
        let new_w = (width as f32 * scale) as u32;
        let new_h = (height as f32 * scale) as u32;
        img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    let (out_w, out_h) = (processed.width(), processed.height());

    // Encode to target format
    let mut buf = std::io::Cursor::new(Vec::new());
    if convert_to_jpeg || target_ext == "jpg" {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
        processed
            .write_with_encoder(encoder)
            .map_err(|e| format!("Failed to encode JPEG: {e}"))?;
    } else {
        processed
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode PNG: {e}"))?;
    }

    let result = buf.into_inner();
    log::debug!(
        "Image processed: {width}x{height} -> {out_w}x{out_h}, {extension}->{target_ext} ({} bytes)",
        result.len()
    );

    Ok((result, target_ext.to_string()))
}

/// Process image: resize to Claude's optimal limit (1568px) and convert opaque PNG→JPEG.
/// Returns (processed_bytes, final_extension) — extension may change (e.g. png→jpg).
fn process_image(image_data: &[u8], extension: &str) -> Result<(Vec<u8>, String), String> {
    // Skip GIFs (may be animated) and small images
    if extension == "gif" || image_data.len() < MIN_PROCESS_SIZE {
        return Ok((image_data.to_vec(), extension.to_string()));
    }

    let img =
        image::load_from_memory(image_data).map_err(|e| format!("Failed to decode image: {e}"))?;

    let max_dim = img.width().max(img.height());
    let needs_resize = max_dim > MAX_IMAGE_DIMENSION;
    // Determine target format: convert opaque PNGs to JPEG
    let convert_to_jpeg = extension == "png" && !img.color().has_alpha();

    // Nothing to do — return original bytes (avoid re-encode)
    if !needs_resize && !convert_to_jpeg {
        return Ok((image_data.to_vec(), extension.to_string()));
    }

    process_dynamic_image(img, extension, needs_resize, convert_to_jpeg)
}

/// Save a pasted image to the app data directory
///
/// The image data should be base64-encoded (without the data URL prefix).
/// Returns the saved image path for referencing in messages.
#[tauri::command]
pub async fn save_pasted_image(
    app: AppHandle,
    data: String,
    mime_type: String,
) -> Result<SaveImageResponse, String> {
    log::trace!("Saving pasted image, mime_type: {mime_type}");

    // Validate MIME type
    if !ALLOWED_MIME_TYPES.contains(&mime_type.as_str()) {
        return Err(format!(
            "Invalid image type: {mime_type}. Allowed types: {}",
            ALLOWED_MIME_TYPES.join(", ")
        ));
    }

    // Decode base64 data
    let image_data = STANDARD
        .decode(&data)
        .map_err(|e| format!("Failed to decode base64 image data: {e}"))?;

    // Check size limit
    if image_data.len() > MAX_IMAGE_SIZE {
        return Err(format!(
            "Image too large: {} bytes. Maximum size: {} bytes (10MB)",
            image_data.len(),
            MAX_IMAGE_SIZE
        ));
    }

    // Get the images directory (now in app data dir)
    let images_dir = get_images_dir(&app)?;

    // Determine original extension from MIME type
    let original_ext = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png", // fallback
    }
    .to_string();

    // Offload CPU-heavy image processing to a blocking thread
    let result = tokio::task::spawn_blocking(move || -> Result<SaveImageResponse, String> {
        let (processed_data, final_ext) = process_image(&image_data, &original_ext)?;
        save_image_to_disk(&images_dir, &processed_data, &final_ext)
    })
    .await
    .map_err(|e| format!("Image processing task failed: {e}"))??;

    Ok(result)
}

/// Save processed image data to disk with atomic write (temp file + rename).
/// Shared by save_pasted_image, read_clipboard_image, and save_dropped_image.
fn save_image_to_disk(
    images_dir: &std::path::Path,
    data: &[u8],
    ext: &str,
) -> Result<SaveImageResponse, String> {
    let timestamp = now();
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let filename = format!("image-{timestamp}-{short_uuid}.{ext}");
    let file_path = images_dir.join(&filename);

    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, data).map_err(|e| format!("Failed to write image file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize image file: {e}"))?;

    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    log::trace!("Image saved to: {path_str}");

    Ok(SaveImageResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
    })
}

/// Read an image from the native system clipboard (fallback for Linux/WebKitGTK).
///
/// WebKitGTK doesn't expose image/* clipboard items via the Web API,
/// so this command reads the clipboard natively using arboard.
/// Returns None if no image is available in the clipboard.
#[tauri::command]
pub async fn read_clipboard_image(app: AppHandle) -> Result<Option<SaveImageResponse>, String> {
    log::trace!("Attempting to read image from native clipboard");

    let images_dir = get_images_dir(&app)?;

    let result =
        tokio::task::spawn_blocking(move || -> Result<Option<SaveImageResponse>, String> {
            let mut clipboard = arboard::Clipboard::new()
                .map_err(|e| format!("Failed to access clipboard: {e}"))?;

            let image_data = match clipboard.get_image() {
                Ok(data) => data,
                Err(arboard::Error::ContentNotAvailable) => return Ok(None),
                Err(e) => return Err(format!("Failed to read clipboard image: {e}")),
            };

            // Guard against absurdly large clipboard images (>50 megapixels ≈ 200MB RGBA)
            const MAX_CLIPBOARD_PIXELS: usize = 50_000_000;
            if image_data.width * image_data.height > MAX_CLIPBOARD_PIXELS {
                return Err(format!(
                    "Clipboard image too large: {}x{}",
                    image_data.width, image_data.height
                ));
            }

            // Build DynamicImage directly from RGBA pixels — avoids PNG encode→decode round-trip
            let rgba = image::RgbaImage::from_raw(
                image_data.width as u32,
                image_data.height as u32,
                image_data.bytes.into_owned(),
            )
            .ok_or_else(|| "Failed to create image from clipboard data".to_string())?;

            let img = image::DynamicImage::ImageRgba8(rgba);

            // RGBA from clipboard always has an alpha channel, so never convert to JPEG
            let needs_resize = img.width().max(img.height()) > MAX_IMAGE_DIMENSION;
            let (processed_data, final_ext) =
                process_dynamic_image(img, "png", needs_resize, false)?;
            Ok(Some(save_image_to_disk(
                &images_dir,
                &processed_data,
                &final_ext,
            )?))
        })
        .await
        .map_err(|e| format!("Clipboard image task failed: {e}"))??;

    Ok(result)
}

/// Write text to the native system clipboard.
///
/// Browser web access can lose Clipboard API user activation when a command
/// fetches data asynchronously before copying. This backend command is the
/// same-machine fallback used by the frontend clipboard helper.
#[tauri::command]
pub async fn write_clipboard_text(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("Failed to access clipboard: {e}"))?;
        clipboard
            .set_text(text)
            .map_err(|e| format!("Failed to write clipboard text: {e}"))
    })
    .await
    .map_err(|e| format!("Clipboard text task failed: {e}"))?
}

/// Save a dropped image file to the app data directory
///
/// Takes a source file path (from Tauri's drag-drop event) and copies it
/// to the images directory. More efficient than base64 encoding for dropped files.
#[tauri::command]
pub async fn save_dropped_image(
    app: AppHandle,
    source_path: String,
) -> Result<SaveImageResponse, String> {
    log::trace!("Saving dropped image from: {source_path}");

    let source = std::path::PathBuf::from(&source_path);

    // Validate source file exists
    if !source.exists() {
        return Err(format!("Source file not found: {source_path}"));
    }

    // Get extension and validate it's an allowed image type
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .ok_or_else(|| "File has no extension".to_string())?;

    let allowed_extensions = ["png", "jpg", "jpeg", "gif", "webp"];
    if !allowed_extensions.contains(&extension.as_str()) {
        return Err(format!(
            "Invalid image type: .{extension}. Allowed types: {}",
            allowed_extensions.join(", ")
        ));
    }

    // Check file size
    let metadata =
        std::fs::metadata(&source).map_err(|e| format!("Failed to read file metadata: {e}"))?;

    if metadata.len() as usize > MAX_IMAGE_SIZE {
        return Err(format!(
            "Image too large: {} bytes. Maximum size: {} bytes (10MB)",
            metadata.len(),
            MAX_IMAGE_SIZE
        ));
    }

    // Get the images directory
    let images_dir = get_images_dir(&app)?;

    // Normalize jpeg to jpg
    let normalized_ext = if extension == "jpeg" {
        "jpg".to_string()
    } else {
        extension
    };

    // Offload CPU-heavy image processing to a blocking thread
    let result = tokio::task::spawn_blocking(move || -> Result<SaveImageResponse, String> {
        let source_data =
            std::fs::read(&source).map_err(|e| format!("Failed to read source file: {e}"))?;
        let (processed_data, final_ext) = process_image(&source_data, &normalized_ext)?;
        save_image_to_disk(&images_dir, &processed_data, &final_ext)
    })
    .await
    .map_err(|e| format!("Image processing task failed: {e}"))??;

    Ok(result)
}

/// Delete a pasted image
///
/// Validates that the path is within allowed directories before deleting.
/// Supports both old (.jean/images/) and new (app data pasted-images/) locations.
#[tauri::command]
pub async fn delete_pasted_image(app: AppHandle, path: String) -> Result<(), String> {
    log::trace!("Deleting pasted image: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Validate that the path exists
    if !file_path.exists() {
        log::warn!("Image file not found: {path}");
        return Ok(()); // Not an error if file doesn't exist
    }

    // Validate that the path is within allowed directories
    let path_str = file_path.to_string_lossy();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let app_data_str = app_data_dir.to_string_lossy();

    // Check if path is in old .jean/images/ or new app data pasted-images/
    let is_old_location =
        path_str.contains(".jean/images/") || path_str.contains(".jean\\images\\");
    let is_new_location = path_str.contains(&format!("{app_data_str}/pasted-images/"))
        || path_str.contains(&format!("{app_data_str}\\pasted-images\\"));

    if !is_old_location && !is_new_location {
        return Err("Invalid path: must be within allowed directories".to_string());
    }

    // Delete the file
    std::fs::remove_file(&file_path).map_err(|e| format!("Failed to delete image: {e}"))?;

    log::trace!("Image deleted: {path}");
    Ok(())
}

// ============================================================================
// Text Paste Commands (for large text pastes in chat)
// ============================================================================

use super::storage::get_pastes_dir;
use super::types::{ReadTextResponse, SaveTextResponse};

/// Maximum text file size in bytes (10MB)
const MAX_TEXT_SIZE: usize = 10 * 1024 * 1024;

/// Save pasted text to the app data directory
///
/// Large text pastes (500+ chars) are saved as files instead of being inlined.
/// Returns the saved file path for referencing in messages.
#[tauri::command]
pub async fn save_pasted_text(app: AppHandle, content: String) -> Result<SaveTextResponse, String> {
    let size = content.len();
    log::trace!("Saving pasted text, size: {size} bytes");

    // Check size limit
    if size > MAX_TEXT_SIZE {
        return Err(format!(
            "Text too large: {size} bytes. Maximum size: {MAX_TEXT_SIZE} bytes (10MB)"
        ));
    }

    // Get the pastes directory (now in app data dir)
    let pastes_dir = get_pastes_dir(&app)?;

    // Generate unique filename
    let timestamp = now();
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let filename = format!("paste-{timestamp}-{short_uuid}.txt");
    let file_path = pastes_dir.join(&filename);

    // Write file atomically (temp file + rename)
    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, &content).map_err(|e| format!("Failed to write text file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize text file: {e}"))?;

    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    log::trace!("Text file saved to: {path_str}");

    Ok(SaveTextResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
        size,
    })
}

/// Update the content of a pasted text file
///
/// Overwrites the file content atomically (temp file + rename).
/// Returns the new file size in bytes.
#[tauri::command]
pub async fn update_pasted_text(
    app: AppHandle,
    path: String,
    content: String,
) -> Result<usize, String> {
    let size = content.len();
    log::trace!("Updating pasted text file: {path}, new size: {size} bytes");

    // Check size limit
    if size > MAX_TEXT_SIZE {
        return Err(format!(
            "Text too large: {size} bytes. Maximum size: {MAX_TEXT_SIZE} bytes (10MB)"
        ));
    }

    let file_path = std::path::PathBuf::from(&path);

    // Validate that the path exists
    if !file_path.exists() {
        return Err(format!("Text file not found: {path}"));
    }

    // Validate that the path is within allowed directories
    let path_str = file_path.to_string_lossy();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let app_data_str = app_data_dir.to_string_lossy();

    let is_old_location =
        path_str.contains(".jean/pastes/") || path_str.contains(".jean\\pastes\\");
    let is_new_location = path_str.contains(&format!("{app_data_str}/pasted-texts/"))
        || path_str.contains(&format!("{app_data_str}\\pasted-texts\\"));

    if !is_old_location && !is_new_location {
        return Err("Invalid path: must be within allowed directories".to_string());
    }

    // Write file atomically (temp file + rename)
    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, &content).map_err(|e| format!("Failed to write text file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize text file: {e}"))?;

    log::trace!("Text file updated: {path}");
    Ok(size)
}

/// Delete a pasted text file
///
/// Validates that the path is within allowed directories before deleting.
/// Supports both old (.jean/pastes/) and new (app data pasted-texts/) locations.
#[tauri::command]
pub async fn delete_pasted_text(app: AppHandle, path: String) -> Result<(), String> {
    log::trace!("Deleting pasted text file: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Validate that the path exists
    if !file_path.exists() {
        log::warn!("Text file not found: {path}");
        return Ok(()); // Not an error if file doesn't exist
    }

    // Validate that the path is within allowed directories
    let path_str = file_path.to_string_lossy();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let app_data_str = app_data_dir.to_string_lossy();

    // Check if path is in old .jean/pastes/ or new app data pasted-texts/
    let is_old_location =
        path_str.contains(".jean/pastes/") || path_str.contains(".jean\\pastes\\");
    let is_new_location = path_str.contains(&format!("{app_data_str}/pasted-texts/"))
        || path_str.contains(&format!("{app_data_str}\\pasted-texts\\"));

    if !is_old_location && !is_new_location {
        return Err("Invalid path: must be within allowed directories".to_string());
    }

    // Delete the file
    std::fs::remove_file(&file_path).map_err(|e| format!("Failed to delete text file: {e}"))?;

    log::trace!("Text file deleted: {path}");
    Ok(())
}

/// Read a pasted text file from disk
///
/// Used by the frontend to display pasted text content in sent messages.
/// Returns the file content along with its size in bytes.
#[tauri::command]
pub async fn read_pasted_text(app: AppHandle, path: String) -> Result<ReadTextResponse, String> {
    log::trace!("Reading pasted text file: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Validate that the path exists
    if !file_path.exists() {
        return Err(format!("Text file not found: {path}"));
    }

    // Validate that the path is within allowed directories
    let path_str = file_path.to_string_lossy();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let app_data_str = app_data_dir.to_string_lossy();

    // Check if path is in old .jean/pastes/ or new app data pasted-texts/
    let is_old_location =
        path_str.contains(".jean/pastes/") || path_str.contains(".jean\\pastes\\");
    let is_new_location = path_str.contains(&format!("{app_data_str}/pasted-texts/"))
        || path_str.contains(&format!("{app_data_str}\\pasted-texts\\"));

    if !is_old_location && !is_new_location {
        return Err("Invalid path: must be within allowed directories".to_string());
    }

    // Check file size
    let metadata =
        std::fs::metadata(&file_path).map_err(|e| format!("Failed to read file metadata: {e}"))?;
    let size = metadata.len() as usize;

    // Check size limit
    if size > MAX_TEXT_SIZE {
        return Err(format!(
            "Text file too large: {size} bytes. Maximum size: {MAX_TEXT_SIZE} bytes (10MB)"
        ));
    }

    // Read file content
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read text file: {e}"))?;

    log::trace!("Successfully read pasted text file: {path} ({size} bytes)");
    Ok(ReadTextResponse { content, size })
}

/// Read a plan file from disk
///
/// Used by the frontend to display plan file content in the approval UI.
/// Only allows reading .md files from ~/.claude/plans/ directory.
#[tauri::command]
pub async fn read_plan_file(path: String) -> Result<String, String> {
    log::trace!("Reading plan file: {path}");

    // Validate that the path is within ~/.claude/plans/
    if !path.contains("/.claude/plans/") && !path.contains("\\.claude\\plans\\") {
        return Err("Invalid path: must be within ~/.claude/plans/ directory".to_string());
    }

    // Validate it's a .md file
    if !path.ends_with(".md") {
        return Err("Invalid path: must be a .md file".to_string());
    }

    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read plan file: {e}"))
}

/// Read file content from disk for previewing in the UI
///
/// Used to display file content when clicking on a filename in Read tool calls.
/// Has a 10MB size limit to prevent memory issues with large files.
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    log::trace!("Reading file content: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Check if file exists
    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }

    // Check file size (10MB limit)
    let metadata =
        std::fs::metadata(&file_path).map_err(|e| format!("Failed to read file metadata: {e}"))?;

    const MAX_SIZE: u64 = 10 * 1024 * 1024; // 10MB
    if metadata.len() > MAX_SIZE {
        return Err(format!(
            "File too large: {} bytes (max {} bytes)",
            metadata.len(),
            MAX_SIZE
        ));
    }

    // Read the file content
    std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {e}"))
}

/// Write file content to disk
///
/// Used to save file content when editing in the inline editor.
/// Has a 10MB size limit to prevent memory issues with large files.
#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    log::trace!("Writing file content: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Check content size (10MB limit)
    const MAX_SIZE: usize = 10 * 1024 * 1024; // 10MB
    if content.len() > MAX_SIZE {
        return Err(format!(
            "Content too large: {} bytes (max {} bytes)",
            content.len(),
            MAX_SIZE
        ));
    }

    // Write the file content
    std::fs::write(&file_path, &content).map_err(|e| format!("Failed to write file: {e}"))
}

fn editor_location(path: &str, line: Option<u32>, column: Option<u32>) -> String {
    match (line, column) {
        (Some(line), Some(column)) => format!("{path}:{line}:{column}"),
        (Some(line), None) => format!("{path}:{line}"),
        _ => path.to_string(),
    }
}

fn editor_file_args(
    editor: &str,
    path: &str,
    line: Option<u32>,
    column: Option<u32>,
) -> Vec<String> {
    match editor {
        "vscode" | "cursor" => {
            if line.is_some() {
                vec!["-g".to_string(), editor_location(path, line, column)]
            } else {
                vec![path.to_string()]
            }
        }
        "xcode" => {
            if let Some(line) = line {
                vec!["-l".to_string(), line.to_string(), path.to_string()]
            } else {
                vec![path.to_string()]
            }
        }
        "intellij" => {
            if let Some(line) = line {
                vec!["--line".to_string(), line.to_string(), path.to_string()]
            } else {
                vec![path.to_string()]
            }
        }
        "zed" => vec![editor_location(path, line, column)],
        _ => {
            if line.is_some() {
                vec!["-g".to_string(), editor_location(path, line, column)]
            } else {
                vec![path.to_string()]
            }
        }
    }
}

fn macos_open_app_args(
    app_name: &str,
    editor: &str,
    path: &str,
    line: Option<u32>,
    column: Option<u32>,
) -> Vec<String> {
    let mut args = vec!["-a".to_string(), app_name.to_string()];
    if line.is_some() {
        args.push("--args".to_string());
        args.extend(editor_file_args(editor, path, line, column));
    } else {
        args.push(path.to_string());
    }
    args
}

/// Open a file in the user's preferred editor
///
/// Uses the editor preference (zed, vscode, cursor, xcode, intellij) to open files.
#[tauri::command]
pub async fn open_file_in_default_app(
    path: String,
    editor: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let editor_app = editor.unwrap_or_else(|| "zed".to_string());
    log::trace!("Opening file in {editor_app}: {path}");

    let friendly_name = match editor_app.as_str() {
        "vscode" => "VS Code ('code')",
        "cursor" => "Cursor ('cursor')",
        "zed" => "Zed ('zed')",
        "xcode" => "Xcode ('xed')",
        "intellij" => "IntelliJ IDEA ('idea')",
        _ => editor_app.as_str(),
    };

    #[cfg(target_os = "macos")]
    {
        let result = match editor_app.as_str() {
            "zed" => match std::process::Command::new("zed")
                .args(editor_file_args("zed", &path, line, column))
                .spawn()
            {
                Ok(child) => Ok(child),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    std::process::Command::new("open")
                        .args(macos_open_app_args("Zed", "zed", &path, line, column))
                        .spawn()
                }
                Err(e) => Err(e),
            },
            "cursor" => match std::process::Command::new("cursor")
                .args(editor_file_args("cursor", &path, line, column))
                .spawn()
            {
                Ok(child) => Ok(child),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    std::process::Command::new("open")
                        .args(macos_open_app_args("Cursor", "cursor", &path, line, column))
                        .spawn()
                }
                Err(e) => Err(e),
            },
            "xcode" => std::process::Command::new("xed")
                .args(editor_file_args("xcode", &path, line, column))
                .spawn(),
            "intellij" => match std::process::Command::new("idea")
                .args(editor_file_args("intellij", &path, line, column))
                .spawn()
            {
                Ok(child) => Ok(child),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    std::process::Command::new("open")
                        .args(macos_open_app_args(
                            "IntelliJ IDEA",
                            "intellij",
                            &path,
                            line,
                            column,
                        ))
                        .spawn()
                }
                Err(e) => Err(e),
            },
            _ => match std::process::Command::new("code")
                .args(editor_file_args("vscode", &path, line, column))
                .spawn()
            {
                Ok(child) => Ok(child),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    std::process::Command::new("open")
                        .args(macos_open_app_args(
                            "Visual Studio Code",
                            "vscode",
                            &path,
                            line,
                            column,
                        ))
                        .spawn()
                }
                Err(e) => Err(e),
            },
        };

        result.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{friendly_name} not found. Make sure it is installed and available in your PATH.")
            } else {
                format!("Failed to open {friendly_name}: {e}")
            }
        })?;
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, VS Code and Cursor install as .cmd batch wrappers (code.cmd, cursor.cmd).
        // Command::new("code") uses CreateProcessW which can't execute .cmd files directly,
        // so we wrap them with cmd /c. CREATE_NO_WINDOW prevents cmd.exe console flash.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let result = match editor_app.as_str() {
            "zed" => std::process::Command::new("zed")
                .args(editor_file_args("zed", &path, line, column))
                .spawn(),
            "cursor" => std::process::Command::new("cmd")
                .args(["/c", "cursor"])
                .args(editor_file_args("cursor", &path, line, column))
                .creation_flags(CREATE_NO_WINDOW)
                .spawn(),
            "intellij" => std::process::Command::new("cmd")
                .args(["/c", "idea"])
                .args(editor_file_args("intellij", &path, line, column))
                .creation_flags(CREATE_NO_WINDOW)
                .spawn(),
            "xcode" => return Err("Xcode is only available on macOS".to_string()),
            _ => std::process::Command::new("cmd")
                .args(["/c", "code"])
                .args(editor_file_args("vscode", &path, line, column))
                .creation_flags(CREATE_NO_WINDOW)
                .spawn(),
        };

        result.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{friendly_name} not found. Make sure it is installed and available in your PATH.")
            } else {
                format!("Failed to open {friendly_name}: {e}")
            }
        })?;
    }

    #[cfg(target_os = "linux")]
    {
        let result = match editor_app.as_str() {
            "zed" => std::process::Command::new("zed")
                .args(editor_file_args("zed", &path, line, column))
                .spawn(),
            "cursor" => std::process::Command::new("cursor")
                .args(editor_file_args("cursor", &path, line, column))
                .spawn(),
            "intellij" => std::process::Command::new("idea")
                .args(editor_file_args("intellij", &path, line, column))
                .spawn(),
            "xcode" => return Err("Xcode is only available on macOS".to_string()),
            _ => std::process::Command::new("code")
                .args(editor_file_args("vscode", &path, line, column))
                .spawn(),
        };

        result.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{friendly_name} not found. Make sure it is installed and available in your PATH.")
            } else {
                format!("Failed to open {friendly_name}: {e}")
            }
        })?;
    }

    Ok(())
}

// ============================================================================
// Saved Context Commands (for Save/Load Context magic commands)
// ============================================================================

use super::storage::{
    get_saved_contexts_dir, load_saved_contexts_metadata, save_saved_contexts_metadata,
};
use super::types::{SaveContextResponse, SavedContext, SavedContextsResponse};

/// Sanitize a string for use as a filename component
/// Keeps only alphanumeric characters and hyphens, converts to lowercase
fn sanitize_for_filename(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        // Collapse multiple consecutive hyphens into one
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Parse a saved context filename into metadata
/// Filename format: {project}-{timestamp}-{slug}.md
/// Also handles non-standard formats by using file metadata
fn parse_context_filename(path: &std::path::Path) -> Option<SavedContext> {
    let filename = path.file_name()?.to_str()?;

    // Must end with .md
    if !filename.ends_with(".md") {
        return None;
    }

    // Skip session-attached context files ({uuid}-context-{slug}.md)
    if filename.contains("-context-") {
        // Check if prefix before "-context-" looks like a UUID (36 chars with hyphens)
        if let Some(prefix) = filename.split("-context-").next() {
            if prefix.len() == 36 && prefix.chars().filter(|c| *c == '-').count() == 4 {
                return None;
            }
        }
    }

    // Get file metadata
    let metadata = std::fs::metadata(path).ok()?;
    let size = metadata.len();

    // Try to get created_at from file metadata, fallback to modified time
    let file_created_at = metadata
        .created()
        .or_else(|_| metadata.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Remove .md extension
    let name_without_ext = &filename[..filename.len() - 3];

    // Split by hyphens and find the timestamp (10 digits)
    let parts: Vec<&str> = name_without_ext.split('-').collect();

    // Find the timestamp index (10-digit number)
    if let Some(timestamp_idx) = parts
        .iter()
        .position(|p| p.len() == 10 && p.parse::<u64>().is_ok())
    {
        // Standard format: {project}-{timestamp}-{slug}.md
        let project_name = parts[..timestamp_idx].join("-");
        let slug = parts[timestamp_idx + 1..].join("-");
        let parsed_timestamp = parts[timestamp_idx]
            .parse::<u64>()
            .unwrap_or(file_created_at);

        Some(SavedContext {
            id: Uuid::new_v4().to_string(),
            filename: filename.to_string(),
            path: path.to_string_lossy().to_string(),
            project_name,
            slug,
            size,
            created_at: parsed_timestamp,
            name: None,
            source_session_id: None, // Populated from metadata in list_saved_contexts
        })
    } else {
        // Non-standard format: use filename as slug, unknown project
        log::trace!("Non-standard context filename: {filename}");
        Some(SavedContext {
            id: Uuid::new_v4().to_string(),
            filename: filename.to_string(),
            path: path.to_string_lossy().to_string(),
            project_name: "Unknown".to_string(),
            slug: name_without_ext.to_string(),
            size,
            created_at: file_created_at,
            name: None,
            source_session_id: None,
        })
    }
}

/// List all saved contexts from the app data directory
///
/// Returns contexts sorted by creation time (newest first).
/// Includes custom names from the metadata file.
#[tauri::command]
pub async fn list_saved_contexts(app: AppHandle) -> Result<SavedContextsResponse, String> {
    log::trace!("Listing saved contexts");

    let contexts_dir = get_saved_contexts_dir(&app)?;

    // Load metadata for custom names and session mappings
    let metadata = load_saved_contexts_metadata(&app);

    // Build reverse map: filename -> session_id
    let filename_to_session: std::collections::HashMap<&str, &str> = metadata
        .sessions
        .iter()
        .map(|(session_id, filename)| (filename.as_str(), session_id.as_str()))
        .collect();

    let mut contexts = Vec::new();

    // Read all .md files from the directory
    let entries = std::fs::read_dir(&contexts_dir)
        .map_err(|e| format!("Failed to read contexts directory: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let path = entry.path();

        if path.extension().is_some_and(|ext| ext == "md") {
            if let Some(mut context) = parse_context_filename(&path) {
                // Merge custom name from metadata if present
                context.name = metadata.names.get(&context.filename).cloned();
                context.source_session_id = filename_to_session
                    .get(context.filename.as_str())
                    .map(|s| s.to_string());
                contexts.push(context);
            }
        }
    }

    // Sort by created_at descending (newest first)
    contexts.sort_by_key(|context| std::cmp::Reverse(context.created_at));

    log::trace!("Found {} saved contexts", contexts.len());
    Ok(SavedContextsResponse { contexts })
}

/// Save context content to a file
///
/// Filename format: {project}-{timestamp}-{slug}.md
#[tauri::command]
pub async fn save_context_file(
    app: AppHandle,
    project_name: String,
    slug: String,
    content: String,
) -> Result<SaveContextResponse, String> {
    log::trace!("Saving context for project: {project_name}, slug: {slug}");

    let contexts_dir = get_saved_contexts_dir(&app)?;

    // Generate filename
    let timestamp = now();
    let safe_project = sanitize_for_filename(&project_name);
    let safe_slug = sanitize_for_filename(&slug);
    let filename = format!("{safe_project}-{timestamp}-{safe_slug}.md");

    let file_path = contexts_dir.join(&filename);

    // Write content atomically (temp file + rename)
    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, &content)
        .map_err(|e| format!("Failed to write context file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize context file: {e}"))?;

    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    let size = content.len() as u64;

    log::trace!("Context saved to: {path_str}");

    Ok(SaveContextResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
        size,
        updated: false,
    })
}

/// Read a saved context file content
///
/// Validates that the path is within the session-context directory.
#[tauri::command]
pub async fn read_context_file(app: AppHandle, path: String) -> Result<String, String> {
    log::trace!("Reading context file: {path}");

    // Validate path is within session-context directory
    let contexts_dir = get_saved_contexts_dir(&app)?;
    let file_path = std::path::PathBuf::from(&path);

    // Canonicalize both paths to resolve symlinks and normalize
    let contexts_dir_canonical = contexts_dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize contexts dir: {e}"))?;
    let file_path_canonical = file_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize file path: {e}"))?;

    if !file_path_canonical.starts_with(&contexts_dir_canonical) {
        return Err("Invalid context file path".to_string());
    }

    std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read context file: {e}"))
}

/// Delete a saved context file
///
/// Validates that the path is within the session-context directory.
/// Also removes any custom name from the metadata file.
#[tauri::command]
pub async fn delete_context_file(app: AppHandle, path: String) -> Result<(), String> {
    log::trace!("Deleting context file: {path}");

    // Validate path is within session-context directory
    let contexts_dir = get_saved_contexts_dir(&app)?;
    let file_path = std::path::PathBuf::from(&path);

    // Extract filename before deletion for metadata cleanup
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());

    // Check if file exists first
    if !file_path.exists() {
        log::warn!("Context file not found: {path}");
        return Ok(()); // Not an error if file doesn't exist
    }

    // Canonicalize both paths to resolve symlinks and normalize
    let contexts_dir_canonical = contexts_dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize contexts dir: {e}"))?;
    let file_path_canonical = file_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize file path: {e}"))?;

    if !file_path_canonical.starts_with(&contexts_dir_canonical) {
        return Err("Invalid context file path".to_string());
    }

    std::fs::remove_file(&file_path).map_err(|e| format!("Failed to delete context file: {e}"))?;

    // Remove from metadata if present
    if let Some(filename) = filename {
        let mut metadata = load_saved_contexts_metadata(&app);
        let mut changed = metadata.names.remove(&filename).is_some();

        // Remove any session mapping pointing to this filename
        metadata.sessions.retain(|_session_id, mapped_filename| {
            if mapped_filename == &filename {
                changed = true;
                false
            } else {
                true
            }
        });

        if changed {
            if let Err(e) = save_saved_contexts_metadata(&app, &metadata) {
                log::warn!("Failed to update metadata after delete: {e}");
            }
        }
    }

    log::trace!("Context file deleted: {path}");
    Ok(())
}

/// Rename a saved context (sets custom display name in metadata)
///
/// The filename is unchanged - only the display name stored in metadata is updated.
/// An empty name removes the custom name (reverts to showing the slug).
#[tauri::command]
pub async fn rename_saved_context(
    app: AppHandle,
    filename: String,
    new_name: String,
) -> Result<(), String> {
    log::trace!("Renaming saved context: {filename} -> {new_name}");

    // Validate the context file exists
    let contexts_dir = get_saved_contexts_dir(&app)?;
    let context_path = contexts_dir.join(&filename);

    if !context_path.exists() {
        return Err(format!("Context file not found: {filename}"));
    }

    // Load existing metadata
    let mut metadata = load_saved_contexts_metadata(&app);

    // Update or remove the name
    let trimmed_name = new_name.trim();
    if trimmed_name.is_empty() {
        // Empty name removes the custom name (reverts to slug)
        metadata.names.remove(&filename);
    } else {
        metadata
            .names
            .insert(filename.clone(), trimmed_name.to_string());
    }

    // Save metadata
    save_saved_contexts_metadata(&app, &metadata)?;

    log::trace!("Saved context renamed successfully");
    Ok(())
}

// ============================================================================
// Background Context Generation
// ============================================================================

/// Prompt template for context summarization (JSON schema output)
const CONTEXT_SUMMARY_PROMPT: &str = r#"<task>Summarize the following conversation for future context loading</task>

<output_format>
Your summary should include:
1. Main Goal - What was the primary objective?
2. Key Decisions & Rationale - Important decisions and WHY they were chosen
3. Trade-offs Considered - What approaches were weighed and rejected?
4. Problems Solved - Errors, blockers, or gotchas and how resolved
5. Current State - What has been implemented so far?
6. Unresolved Questions - Open questions or blockers
7. Key Files & Patterns - Critical file paths and code patterns
8. Next Steps - What remains to be done?

Format as clean markdown. Be concise but capture reasoning.
</output_format>

<context>
<project>{project_name}</project>
<date>{date}</date>
</context>

<conversation>
{conversation}
</conversation>"#;

/// JSON schema for structured context summarization output
const CONTEXT_SUMMARY_SCHEMA: &str = r#"{"type":"object","properties":{"summary":{"type":"string","description":"The markdown context summary including main goal, key decisions with rationale, trade-offs considered, problems solved, current state, unresolved questions, key files/patterns, and next steps"},"slug":{"type":"string","description":"A 2-4 word lowercase hyphenated slug describing the main topic (e.g. implement-magic-commands, fix-auth-bug)"}},"required":["summary","slug"],"additionalProperties":false}"#;

/// Format chat messages into a conversation history string for summarization
fn format_messages_for_summary(messages: &[ChatMessage]) -> String {
    if messages.is_empty() {
        return "No messages in this conversation.".to_string();
    }

    messages
        .iter()
        .map(|msg| {
            let role = match msg.role {
                MessageRole::User => "User",
                MessageRole::Assistant => "Assistant",
            };
            // Truncate very long messages to avoid context overflow (char-safe for multi-byte UTF-8)
            let content = if msg.content.len() > 5000 {
                let end = msg
                    .content
                    .char_indices()
                    .nth(5000)
                    .map(|(i, _)| i)
                    .unwrap_or(msg.content.len());
                format!(
                    "{}...\n[Message truncated - {} chars total]",
                    &msg.content[..end],
                    msg.content.len()
                )
            } else {
                msg.content.clone()
            };
            format!("### {role}\n{content}")
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

/// Extract text or JSON content from stream-json output
/// Handles both regular text responses and JSON schema structured responses
/// For --json-schema, Claude returns structured output via a tool call named "StructuredOutput"
fn extract_text_from_stream_json(output: &str) -> Result<String, String> {
    let mut text_content = String::new();
    let mut structured_output: Option<serde_json::Value> = None;

    log::trace!("Parsing stream-json output ({} bytes)", output.len());

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                log::trace!("Failed to parse line as JSON: {e}, line: {line}");
                continue;
            }
        };

        let msg_type = parsed.get("type").and_then(|t| t.as_str());
        log::trace!("Parsed message type: {msg_type:?}");

        if parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
            if let Some(message) = parsed.get("message") {
                if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
                    for block in content {
                        let block_type = block.get("type").and_then(|t| t.as_str());

                        // Handle regular text blocks
                        if block_type == Some("text") {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                text_content.push_str(text);
                            }
                        }

                        // Handle StructuredOutput tool call (from --json-schema)
                        if block_type == Some("tool_use") {
                            let tool_name = block.get("name").and_then(|n| n.as_str());
                            log::trace!(
                                "Found tool_use block: name={:?}, block={block}",
                                tool_name
                            );
                            if tool_name == Some("StructuredOutput") {
                                if let Some(input) = block.get("input") {
                                    log::trace!("Found StructuredOutput input: {input}");
                                    structured_output = Some(input.clone());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Handle result - can be either a string or a JSON object
        if parsed.get("type").and_then(|t| t.as_str()) == Some("result") {
            if let Some(result) = parsed.get("result") {
                if let Some(result_str) = result.as_str() {
                    if text_content.is_empty() {
                        text_content = result_str.to_string();
                    }
                }
                if result.is_object() && structured_output.is_none() {
                    structured_output = Some(result.clone());
                }
            }
        }
    }

    // Prefer structured output from StructuredOutput tool call
    if let Some(json_val) = structured_output {
        let result = json_val.to_string();
        log::trace!("Returning structured output: {result}");
        return Ok(result);
    }

    log::trace!(
        "No structured output found, text_content length: {}",
        text_content.len()
    );

    // If no StructuredOutput found, try stripping markdown code fences
    if !text_content.is_empty() {
        let trimmed = text_content.trim();
        let stripped = trimmed
            .strip_prefix("```json")
            .or_else(|| trimmed.strip_prefix("```"))
            .unwrap_or(trimmed)
            .trim()
            .strip_suffix("```")
            .unwrap_or(trimmed)
            .trim();

        if stripped.starts_with('{') {
            log::trace!("Extracted JSON from text content (code fence stripped)");
            return Ok(stripped.to_string());
        }
    }

    if text_content.is_empty() {
        log::error!("No content found in stream-json output. Raw output: {output}");
        return Err("No text content found in Claude response".to_string());
    }

    Ok(text_content.trim().to_string())
}

/// Structured response from context summarization
#[derive(Debug, serde::Deserialize)]
struct ContextSummaryResponse {
    summary: String,
    slug: String,
}

/// Generate a fallback slug from project and session name
/// Sanitizes and combines both, truncates to reasonable length
fn generate_fallback_slug(project_name: &str, session_name: &str) -> String {
    let combined = format!("{project_name} {session_name}");
    let sanitized = sanitize_for_filename(&combined);
    // Limit to first 4 "words" (hyphen-separated parts)
    let parts: Vec<&str> = sanitized.split('-').take(4).collect();
    if parts.is_empty() {
        "context".to_string()
    } else {
        parts.join("-")
    }
}

/// Execute one-shot Claude CLI call for summarization with JSON schema (non-streaming)
fn execute_summarization_claude(
    app: &AppHandle,
    prompt: &str,
    model: Option<&str>,
    custom_profile_name: Option<&str>,
    working_dir: Option<&std::path::Path>,
    worktree_id: Option<&str>,
    magic_backend: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<ContextSummaryResponse, String> {
    let model_str = model.unwrap_or("claude-opus-4-8[1m]");

    // Per-operation backend > project/global default_backend
    let backend = resolve_magic_prompt_backend(app, magic_backend, worktree_id);

    if backend == super::types::Backend::Opencode {
        log::trace!("Executing one-shot OpenCode summarization");
        let json_str = super::opencode::execute_one_shot_opencode(
            app,
            prompt,
            model_str,
            Some(CONTEXT_SUMMARY_SCHEMA),
            working_dir,
            reasoning_effort,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse OpenCode summarization JSON: {e}, content: {json_str}");
            format!("Failed to parse summarization response: {e}")
        });
    }

    if backend == super::types::Backend::Codex {
        log::trace!("Executing one-shot Codex summarization with output-schema");
        let json_str = super::codex::execute_one_shot_codex(
            app,
            prompt,
            model_str,
            CONTEXT_SUMMARY_SCHEMA,
            working_dir,
            reasoning_effort,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Codex summarization JSON: {e}, content: {json_str}");
            format!("Failed to parse summarization response: {e}")
        });
    }

    if backend == super::types::Backend::Cursor {
        log::trace!("Executing one-shot Cursor summarization");
        let json_str = super::cursor::execute_one_shot_cursor(app, prompt, model_str, working_dir)?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Cursor summarization JSON: {e}, content: {json_str}");
            format!("Failed to parse summarization response: {e}")
        });
    }

    if backend == super::types::Backend::Grok {
        log::trace!("Executing one-shot Grok summarization");
        let json_str = super::grok::execute_one_shot_grok(
            app,
            prompt,
            model_str,
            working_dir,
            reasoning_effort,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Grok summarization JSON: {e}, content: {json_str}");
            format!("Failed to parse summarization response: {e}")
        });
    }

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::trace!("Executing one-shot Claude summarization with JSON schema");

    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
    crate::chat::claude::apply_custom_profile_settings(&mut cmd, custom_profile_name);
    crate::chat::claude::apply_custom_profile_env(&mut cmd, custom_profile_name);
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "default",
        "--model",
        model_str,
        "--no-session-persistence",
        "--max-turns",
        "2", // Need 2 turns: one for thinking, one for structured output
        "--json-schema",
        CONTEXT_SUMMARY_SCHEMA,
        "--permission-mode",
        "plan", // Prevent tool use that could waste turns
    ]);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

    // Write prompt to stdin as stream-json format
    {
        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let input_message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });
        writeln!(stdin, "{input_message}").map_err(|e| format!("Failed to write to stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Claude CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Claude CLI failed (exit code {:?}): stderr={}, stdout={}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    log::trace!("Claude CLI stdout: {stdout}");
    log::trace!("Claude CLI stderr: {stderr}");

    let text_content = extract_text_from_stream_json(&stdout)?;

    log::trace!("Extracted text content for JSON parsing: {text_content}");

    // Check for empty content before trying to parse
    if text_content.trim().is_empty() {
        log::error!(
            "Empty content extracted from Claude response. stdout: {}, stderr: {}",
            stdout,
            stderr
        );
        return Err("Empty response from Claude CLI".to_string());
    }

    // Parse the JSON response
    serde_json::from_str(&text_content).map_err(|e| {
        let preview = if text_content.len() > 200 {
            format!("{}...", &text_content[..200])
        } else {
            text_content.to_string()
        };
        log::error!(
            "Failed to parse JSON response: {e}, content preview: {preview}, full stdout: {stdout}"
        );
        format!("Failed to parse structured response: {e}")
    })
}

/// Generate a context summary from a session's messages in the background
///
/// This command loads a session's messages, sends them to Claude for summarization,
/// and saves the result as a context file. It does NOT show anything in the current chat.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_context_from_session(
    app: AppHandle,
    worktree_path: String,
    worktree_id: String,
    source_session_id: String,
    project_name: String,
    custom_prompt: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<SaveContextResponse, String> {
    log::trace!(
        "Generating context from session {} for project {}",
        source_session_id,
        project_name
    );

    // 1. Verify session exists
    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    let session = sessions
        .find_session(&source_session_id)
        .ok_or_else(|| format!("Session not found: {source_session_id}"))?;

    // 2. Load actual messages from NDJSON
    let messages = run_log::load_session_messages(&app, &source_session_id)?;

    if messages.is_empty() {
        return Err("Session has no messages to summarize".to_string());
    }

    // 3. Format messages into conversation history
    let conversation_history = format_messages_for_summary(&messages);

    // 4. Build summarization prompt - use custom if provided and non-empty, otherwise use default
    let today = format!("timestamp:{}", now()); // Use timestamp instead of formatted date
    let prompt_template = custom_prompt
        .as_ref()
        .filter(|p| !p.trim().is_empty())
        .map(|s| s.as_str())
        .unwrap_or(CONTEXT_SUMMARY_PROMPT);

    let prompt = prompt_template
        .replace("{project_name}", &project_name)
        .replace("{date}", &today)
        .replace("{conversation}", &conversation_history);

    // 4. Call Claude CLI with JSON schema (non-streaming)
    // If JSON parsing fails, use fallback slug from project + session name
    let magic_backend = crate::get_preferences_path(&app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str::<crate::AppPreferences>(&c).ok())
        .and_then(|p| p.magic_prompt_backends.context_summary_backend);
    let (summary, slug) = match execute_summarization_claude(
        &app,
        &prompt,
        model.as_deref(),
        custom_profile_name.as_deref(),
        Some(std::path::Path::new(&worktree_path)),
        Some(&worktree_id),
        magic_backend.as_deref(),
        reasoning_effort.as_deref(),
    ) {
        Ok(response) => {
            // Validate slug is not empty
            let slug = if response.slug.trim().is_empty() {
                log::warn!("Empty slug in response, using fallback");
                generate_fallback_slug(&project_name, &session.name)
            } else {
                response.slug
            };
            (response.summary, slug)
        }
        Err(e) => {
            log::error!("Structured summarization failed: {e}, cannot generate context");
            return Err(e);
        }
    };

    // 5. Determine target file (update existing or create new)
    let contexts_dir = get_saved_contexts_dir(&app)?;
    let mut metadata = load_saved_contexts_metadata(&app);

    let (filename, file_path, is_update) =
        if let Some(existing_filename) = metadata.sessions.get(&source_session_id) {
            let existing_path = contexts_dir.join(existing_filename);
            if existing_path.exists() {
                // Update existing file
                log::trace!("Updating existing context file: {existing_filename}");
                (existing_filename.clone(), existing_path, true)
            } else {
                // Mapped file was deleted, create new
                log::trace!("Mapped file gone, creating new context file");
                let timestamp = now();
                let safe_project = sanitize_for_filename(&project_name);
                let safe_slug = sanitize_for_filename(&slug);
                let new_filename = format!("{safe_project}-{timestamp}-{safe_slug}.md");
                let new_path = contexts_dir.join(&new_filename);
                (new_filename, new_path, false)
            }
        } else {
            // No existing mapping, create new
            let timestamp = now();
            let safe_project = sanitize_for_filename(&project_name);
            let safe_slug = sanitize_for_filename(&slug);
            let new_filename = format!("{safe_project}-{timestamp}-{safe_slug}.md");
            let new_path = contexts_dir.join(&new_filename);
            (new_filename, new_path, false)
        };

    // Write content atomically
    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, &summary)
        .map_err(|e| format!("Failed to write context file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize context file: {e}"))?;

    // Update session mapping in metadata
    metadata
        .sessions
        .insert(source_session_id.clone(), filename.clone());
    if let Err(e) = save_saved_contexts_metadata(&app, &metadata) {
        log::warn!("Failed to save context metadata: {e}");
    }

    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    let size = summary.len() as u64;

    log::trace!("Context generated and saved to: {path_str}");

    Ok(SaveContextResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
        size,
        updated: is_update,
    })
}

// ============================================================================
// Session Debug Info Commands
// ============================================================================

use super::types::{RunLogFileInfo, SessionDebugInfo, UsageData};

/// Get debug information about a session's storage paths and JSONL files
///
/// Returns paths to all storage files for debugging and the "reveal in Finder" feature.
#[tauri::command]
pub async fn get_session_debug_info(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<SessionDebugInfo, String> {
    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let app_data_str = app_data_dir.to_str().unwrap_or("unknown").to_string();

    // Get index file path (was sessions file)
    let sessions_file = get_index_path(&app, &worktree_id)?
        .to_str()
        .unwrap_or("unknown")
        .to_string();

    // Get data directory (was runs directory)
    let runs_dir = get_data_dir(&app)?
        .to_str()
        .unwrap_or("unknown")
        .to_string();

    // Load session to get claude_session_id
    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    let session = sessions.find_session(&session_id);
    let claude_session_id = session.and_then(|s| s.claude_session_id.clone());
    let cursor_chat_id = session.and_then(|s| s.cursor_chat_id.clone());
    let pi_session_id = session.and_then(|s| s.pi_session_id.clone());
    let grok_session_id = session.and_then(|s| s.grok_session_id.clone());

    // Try to find Claude CLI's JSONL file
    let claude_jsonl_file = claude_session_id.as_ref().and_then(|sid| {
        // Claude CLI stores sessions in ~/.claude/projects/<project-hash>/<session-id>.jsonl
        let home = dirs::home_dir()?;
        let claude_projects = home.join(".claude").join("projects");

        // We need to search for the session file in the projects directory
        // The project hash is based on the worktree path
        if claude_projects.exists() {
            for entry in std::fs::read_dir(&claude_projects).ok()? {
                let entry = entry.ok()?;
                let project_dir = entry.path();
                if project_dir.is_dir() {
                    let session_file = project_dir.join(format!("{sid}.jsonl"));
                    if session_file.exists() {
                        return session_file.to_str().map(|s| s.to_string());
                    }
                }
            }
        }
        None
    });

    // Get session directory and metadata file path (was manifest)
    let session_dir = get_session_dir(&app, &session_id)?;
    let metadata_path = session_dir.join("metadata.json");
    let manifest_file = if metadata_path.exists() {
        metadata_path.to_str().map(|s| s.to_string())
    } else {
        None
    };

    // Load metadata to get run info
    let metadata = load_metadata(&app, &session_id)?;

    // Build JSONL file info list
    let mut run_log_files = Vec::new();
    if let Some(metadata) = metadata {
        for run in &metadata.runs {
            let jsonl_path = session_dir.join(format!("{}.jsonl", run.run_id));
            if jsonl_path.exists() {
                // Truncate user message preview to 50 chars (char-safe for multi-byte UTF-8)
                let preview = if run.user_message.chars().count() > 50 {
                    format!(
                        "{}...",
                        run.user_message.chars().take(47).collect::<String>()
                    )
                } else {
                    run.user_message.clone()
                };

                run_log_files.push(RunLogFileInfo {
                    run_id: run.run_id.clone(),
                    path: jsonl_path.to_str().unwrap_or("unknown").to_string(),
                    status: run.status.clone(),
                    user_message_preview: preview,
                    usage: run.usage.clone(),
                });
            }
        }
    }

    // Calculate total usage across all runs
    let total_usage = run_log_files.iter().filter_map(|f| f.usage.as_ref()).fold(
        UsageData::default(),
        |mut acc, u| {
            acc.input_tokens += u.input_tokens;
            acc.output_tokens += u.output_tokens;
            acc.cache_read_input_tokens += u.cache_read_input_tokens;
            acc.cache_creation_input_tokens += u.cache_creation_input_tokens;
            acc
        },
    );

    Ok(SessionDebugInfo {
        app_data_dir: app_data_str,
        sessions_file,
        runs_dir,
        manifest_file,
        claude_session_id,
        cursor_chat_id,
        pi_session_id,
        commandcode_session_id: None,
        grok_session_id,
        claude_jsonl_file,
        run_log_files,
        total_usage,
    })
}

// ============================================================================
// Session Resume Commands
// ============================================================================

/// Response for resume_session command
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResumeSessionResponse {
    /// Whether any runs were resumed
    pub resumed: bool,
    /// Number of runs resumed
    pub run_count: usize,
}

/// Resume a session that has resumable runs (detached processes still running).
///
/// This is called when the frontend detects that a session has a "Resumable" run
/// (process still running after app restart). It starts tailing the output file
/// to continue receiving events.
#[tauri::command]
pub async fn resume_session(
    app: AppHandle,
    session_id: String,
    worktree_id: String,
) -> Result<ResumeSessionResponse, String> {
    use super::run_log::RunLogWriter;
    use super::storage::save_metadata;

    log::trace!("Attempting to resume session: {session_id}");

    // If this session is already being actively managed (tailed by send_chat_message),
    // skip resuming to avoid starting a duplicate tail that re-emits all events
    // from the beginning of the output file.
    if super::registry::is_session_actively_managed(&session_id) {
        log::trace!("Session {session_id} is already actively managed, skipping resume");
        return Ok(ResumeSessionResponse {
            resumed: false,
            run_count: 0,
        });
    }

    // Load the metadata to find resumable runs
    let mut metadata = match load_metadata(&app, &session_id)? {
        Some(m) => m,
        None => {
            log::trace!("No metadata found for session: {session_id}");
            return Ok(ResumeSessionResponse {
                resumed: false,
                run_count: 0,
            });
        }
    };

    // Find resumable runs — include both PID-based (Claude) and Codex (thread_id-based)
    let resumable_runs: Vec<_> = metadata
        .runs
        .iter()
        .filter(|r| {
            r.status == RunStatus::Resumable && (r.pid.is_some() || r.codex_thread_id.is_some())
        })
        .cloned()
        .collect();

    if resumable_runs.is_empty() {
        log::trace!("No resumable runs found for session: {session_id}");
        return Ok(ResumeSessionResponse {
            resumed: false,
            run_count: 0,
        });
    }

    let run_count = resumable_runs.len();
    log::trace!(
        "Found {} resumable run(s) for session: {session_id}",
        run_count
    );

    // Get session directory for output files
    let session_dir = get_session_dir(&app, &session_id)?;

    // Process each resumable run
    for run in resumable_runs {
        let run_id = run.run_id.clone();

        // === Codex crash recovery path ===
        if let Some(ref codex_tid) = run.codex_thread_id {
            let codex_turn_id = run.codex_turn_id.clone();
            let had_active_turn = codex_turn_id.is_some();
            log::trace!(
                "Resuming Codex run: {run_id}, thread={codex_tid}, had_active_turn={had_active_turn}"
            );

            // Mark the run as Running again
            if let Some(metadata_run) = metadata.find_run_mut(&run_id) {
                metadata_run.status = RunStatus::Running;
            }
            save_metadata(&app, &metadata)?;

            let app_clone = app.clone();
            let session_id_clone = session_id.clone();
            let worktree_id_clone = worktree_id.clone();
            let run_id_clone = run_id.clone();
            let thread_id_clone = codex_tid.clone();

            // Use std::thread::spawn (NOT tauri::async_runtime::spawn) because
            // resume_codex_after_crash blocks on sync mpsc — blocking a tokio
            // worker would starve the async runtime.
            std::thread::spawn(move || {
                let emit_done = |app: &tauri::AppHandle, sid: &str, wid: &str| {
                    let _ = app.emit_all(
                        "chat:done",
                        &serde_json::json!({ "session_id": sid, "worktree_id": wid, "waiting_for_plan": false }),
                    );
                };

                match super::codex::resume_codex_after_crash(
                    &app_clone,
                    &session_id_clone,
                    &worktree_id_clone,
                    &run_id_clone,
                    &thread_id_clone,
                    codex_turn_id.as_deref(),
                ) {
                    Ok(true) => {
                        log::info!(
                            "Codex crash recovery succeeded for session {session_id_clone}, run {run_id_clone}"
                        );
                        // process_turn_events (active turn) or
                        // resume_codex_after_crash (idle/interrupted turn)
                        // emits chat:done itself.
                    }
                    Ok(false) => {
                        // Thread expired — mark as crashed
                        log::warn!(
                            "Codex crash recovery: thread expired for session {session_id_clone}, marking crashed"
                        );
                        if let Ok(mut writer) =
                            RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                        {
                            if let Err(e) = writer.crash() {
                                log::error!("Failed to mark run as crashed: {e}");
                            }
                        }
                        emit_done(&app_clone, &session_id_clone, &worktree_id_clone);
                    }
                    Err(e) => {
                        log::error!(
                            "Codex crash recovery failed for session {session_id_clone}: {e}"
                        );
                        if let Ok(mut writer) =
                            RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                        {
                            if let Err(e) = writer.crash() {
                                log::error!("Failed to mark run as crashed: {e}");
                            }
                        }
                        emit_done(&app_clone, &session_id_clone, &worktree_id_clone);
                    }
                }
            });
            continue;
        }

        // === Pi detached RPC-host resume path ===
        if run.backend == Some(Backend::Pi) {
            let pid = match run.pid {
                Some(p) => p,
                None => continue,
            };
            let output_file = session_dir.join(format!("{run_id}.jsonl"));

            log::trace!(
                "Resuming Pi RPC host run: {run_id}, PID: {pid}, output: {:?}",
                output_file
            );

            if let Some(metadata_run) = metadata.find_run_mut(&run_id) {
                metadata_run.status = RunStatus::Running;
            }
            save_metadata(&app, &metadata)?;

            if !super::registry::register_detached_process(session_id.clone(), pid) {
                log::warn!("Resume Pi session {session_id} was cancelled before tailing started");
                return Ok(ResumeSessionResponse {
                    resumed: false,
                    run_count: 0,
                });
            }

            let app_clone = app.clone();
            let session_id_clone = session_id.clone();
            let worktree_id_clone = worktree_id.clone();
            let run_id_clone = run_id.clone();

            tauri::async_runtime::spawn(async move {
                let emit_done = |app: &tauri::AppHandle, sid: &str, wid: &str| {
                    let _ = app.emit_all(
                        "chat:done",
                        &serde_json::json!({ "session_id": sid, "worktree_id": wid, "waiting_for_plan": false }),
                    );
                };

                let (pi_session_id, usage, cancelled) = match super::pi::tail_pi_output(
                    &app_clone,
                    &session_id_clone,
                    &worktree_id_clone,
                    &output_file,
                    pid,
                ) {
                    Ok(response) => (response.session_id, response.usage, response.cancelled),
                    Err(e) => {
                        log::error!("Resume Pi tail failed for run: {run_id_clone}, error: {e}");
                        super::registry::unregister_process(&session_id_clone);
                        if let Ok(mut writer) =
                            RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                        {
                            if let Err(e) = writer.crash() {
                                log::error!("Failed to mark Pi run as crashed: {e}");
                            }
                        }
                        emit_done(&app_clone, &session_id_clone, &worktree_id_clone);
                        return;
                    }
                };

                super::registry::unregister_process(&session_id_clone);
                if cancelled {
                    emit_done(&app_clone, &session_id_clone, &worktree_id_clone);
                }

                if let Ok(mut writer) =
                    RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                {
                    let assistant_message_id = uuid::Uuid::new_v4().to_string();
                    if let Err(e) = writer.complete(&assistant_message_id, None, usage.clone()) {
                        log::error!("Failed to mark resumed Pi run completed: {e}");
                    }
                }

                if !pi_session_id.is_empty() {
                    if let Err(e) =
                        with_existing_metadata_mut(&app_clone, &session_id_clone, |metadata| {
                            metadata.pi_session_id = Some(pi_session_id.clone());
                            if let Some(run) = metadata.find_run_mut(&run_id_clone) {
                                // Pi run entries do not have a dedicated per-run
                                // field yet; session-level pi_session_id is the
                                // authoritative resume id.
                                run.usage = usage.clone();
                            }
                        })
                    {
                        log::warn!("Failed to persist recovered Pi session id: {e}");
                    }
                }
            });
            continue;
        }

        // === Claude PID-based resume path ===
        let pid = match run.pid {
            Some(p) => p,
            None => continue,
        };
        let output_file = session_dir.join(format!("{run_id}.jsonl"));

        log::trace!(
            "Resuming run: {run_id}, PID: {pid}, output: {:?}",
            output_file
        );

        // Mark the run as Running again (from Resumable)
        if let Some(metadata_run) = metadata.find_run_mut(&run_id) {
            metadata_run.status = RunStatus::Running;
        }
        save_metadata(&app, &metadata)?;

        // Register the PID in the in-memory process registry so cancel works
        // Returns false if a pending cancel was queued (process killed immediately)
        if !super::registry::register_detached_process(session_id.clone(), pid) {
            log::warn!("Resume session {session_id} was cancelled before tailing started");
            return Ok(ResumeSessionResponse {
                resumed: false,
                run_count: 0,
            });
        }

        // Clone values for the async task
        let app_clone = app.clone();
        let session_id_clone = session_id.clone();
        let worktree_id_clone = worktree_id.clone();
        let run_id_clone = run_id.clone();

        // Spawn a task to tail the output file
        tauri::async_runtime::spawn(async move {
            log::trace!("Starting tail task for run: {run_id_clone}, session: {session_id_clone}");

            // Helper: emit chat:done so frontend clears sending state
            let emit_done = |app: &tauri::AppHandle, sid: &str, wid: &str| {
                let _ = app.emit_all(
                    "chat:done",
                    &serde_json::json!({ "session_id": sid, "worktree_id": wid, "waiting_for_plan": false }),
                );
            };

            // Tail the output file — Claude backend only (Codex handled above)
            let (resume_id, usage, cancelled) = {
                match super::claude::tail_claude_output(
                    &app_clone,
                    &session_id_clone,
                    &worktree_id_clone,
                    &output_file,
                    pid,
                ) {
                    Ok(response) => (response.session_id, response.usage, response.cancelled),
                    Err(e) => {
                        log::error!(
                            "Resume Claude tail failed for run: {run_id_clone}, error: {e}"
                        );
                        super::registry::unregister_process(&session_id_clone);
                        if let Ok(mut writer) =
                            RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                        {
                            if let Err(e) = writer.crash() {
                                log::error!("Failed to mark run as crashed: {e}");
                            }
                        }
                        emit_done(&app_clone, &session_id_clone, &worktree_id_clone);
                        return;
                    }
                }
            };

            // Unregister from process registry now that tailing is complete
            super::registry::unregister_process(&session_id_clone);

            log::trace!(
                "Resume completed for run: {run_id_clone}, resume_id: {:?}, cancelled: {cancelled}",
                resume_id
            );

            // If tail detected dead process (cancelled=true), it skipped emitting chat:done.
            // Emit it here so the frontend clears sending state.
            if cancelled {
                emit_done(&app_clone, &session_id_clone, &worktree_id_clone);
            }

            // Create a RunLogWriter to update the manifest
            {
                if let Ok(mut writer) =
                    RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                {
                    let assistant_message_id = uuid::Uuid::new_v4().to_string();
                    let resume_sid = if resume_id.is_empty() {
                        None
                    } else {
                        Some(resume_id.as_str())
                    };
                    if let Err(e) =
                        writer.complete(&assistant_message_id, resume_sid, usage.clone())
                    {
                        log::error!("Failed to mark run as completed: {e}");
                    }

                    // Clean up input file if it exists
                    if let Err(e) = super::run_log::delete_input_file(
                        &app_clone,
                        &session_id_clone,
                        &run_id_clone,
                    ) {
                        log::trace!("Could not delete input file (may not exist): {e}");
                    }
                }
            }
        });
    }

    Ok(ResumeSessionResponse {
        resumed: true,
        run_count,
    })
}

/// Check for resumable sessions on startup and return their info.
///
/// Called by frontend on app startup to check if there are any sessions
/// with detached Claude processes still running.
#[tauri::command]
pub async fn check_resumable_sessions(
    app: AppHandle,
) -> Result<Vec<super::run_log::RecoveredRun>, String> {
    log::trace!("Checking for resumable sessions");

    // This calls recover_incomplete_runs which updates statuses and returns info.
    // Note: recover_incomplete_runs skips sessions that are actively managed
    // (in PROCESS_REGISTRY or CANCEL_FLAGS) to avoid corrupting their metadata.
    let recovered = super::run_log::recover_incomplete_runs(&app)?;

    let mut resumable: Vec<_> = recovered.into_iter().filter(|r| r.resumable).collect();

    // Also report sessions that are actively managed (being tailed right now).
    // The web client needs these to mark sessions as "sending" and show streaming UI.
    // resume_session will no-op for these since they're already being tailed.
    let actively_managed = super::registry::get_actively_managed_sessions();
    for session_id in &actively_managed {
        // Skip if already reported by recover_incomplete_runs
        if resumable.iter().any(|r| r.session_id == *session_id) {
            continue;
        }
        if let Some(metadata) = load_metadata(&app, session_id)? {
            if let Some(run) = metadata
                .runs
                .iter()
                .rev()
                .find(|r| r.status == RunStatus::Running)
            {
                resumable.push(super::run_log::RecoveredRun {
                    session_id: session_id.clone(),
                    worktree_id: metadata.worktree_id.clone(),
                    run_id: run.run_id.clone(),
                    user_message: run.user_message.clone(),
                    resumable: true,
                    execution_mode: run.execution_mode.clone(),
                    started_at: run.started_at,
                });
            }
        }
    }

    log::trace!("Found {} resumable session(s)", resumable.len());

    Ok(resumable)
}

/// Broadcast a session setting change to all connected clients.
/// Used for real-time sync of model, thinking level, and execution mode.
#[tauri::command]
pub async fn broadcast_session_setting(
    app: AppHandle,
    session_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    log::info!("broadcast_session_setting: session={session_id} key={key} value={value}");
    app.emit_all(
        "session:setting-changed",
        &serde_json::json!({
            "session_id": session_id,
            "key": key,
            "value": value,
        }),
    )
}

// ============================================================================
// MCP Server Discovery Commands
// ============================================================================

/// Information about a configured MCP server
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub config: serde_json::Value,
    pub scope: String, // "user", "local", "project"
    /// Whether the server is disabled in its config (has "disabled": true)
    pub disabled: bool,
    /// Which backend this server belongs to: "claude", "codex", or "opencode"
    pub backend: String,
}

/// Health status of an MCP server as reported by `claude mcp list`
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum McpHealthStatus {
    Connected,
    NeedsAuthentication,
    CouldNotConnect,
    Disabled,
    Unknown,
}

/// Result of a health check across all MCP servers
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpHealthResult {
    pub statuses: std::collections::HashMap<String, McpHealthStatus>,
}

/// Discover MCP servers from all configuration sources for the active backend.
///
/// - Claude:   ~/.claude.json (user + local scope) + <worktree>/.mcp.json (project scope)
/// - Codex:    ~/.codex/config.toml (global) + <worktree>/.codex/config.toml (project)
/// - OpenCode: ~/.config/opencode/opencode.json (global) + <worktree>/opencode.json (project)
/// - Cursor:   ~/.cursor/mcp.json (user) + <worktree>/.cursor/mcp.json (project)
#[tauri::command]
pub async fn get_mcp_servers(
    backend: Option<String>,
    worktree_path: Option<String>,
) -> Result<Vec<McpServerInfo>, String> {
    let wt = worktree_path.as_deref();
    let servers = match backend.as_deref() {
        Some("codex") => crate::codex_cli::mcp::get_mcp_servers(wt),
        Some("opencode") => crate::opencode_cli::mcp::get_mcp_servers(wt),
        Some("cursor") => crate::cursor_cli::mcp::get_mcp_servers(wt),
        Some("grok") => Vec::new(),
        _ => crate::claude_cli::mcp::get_mcp_servers(wt),
    };
    Ok(servers)
}

/// Parse `claude mcp list` text output into server health statuses.
///
/// Expected format per line: `name: url/path (Type) - Status`
/// Examples:
///   `notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication`
///   `filesystem: /usr/bin/fs (STDIO) - connected`
fn parse_mcp_list_output(output: &str) -> std::collections::HashMap<String, McpHealthStatus> {
    let mut statuses = std::collections::HashMap::new();

    for line in output.lines() {
        let line = line.trim();

        // Skip header/empty lines
        if line.is_empty() || line.starts_with("Checking MCP") {
            continue;
        }

        // Extract server name (everything before first ':')
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_string();

        // Extract status (everything after last " - ")
        let status_str = rest.rsplit_once(" - ").map(|(_, s)| s.trim()).unwrap_or("");

        let status = if status_str.contains("connected") {
            McpHealthStatus::Connected
        } else if status_str.contains("Needs authentication") {
            McpHealthStatus::NeedsAuthentication
        } else if status_str.contains("Could not connect") {
            McpHealthStatus::CouldNotConnect
        } else if status_str.contains("disabled") {
            McpHealthStatus::Disabled
        } else {
            McpHealthStatus::Unknown
        };

        statuses.insert(name, status);
    }

    statuses
}

/// Check health status of all MCP servers using the appropriate backend CLI.
///
/// - Claude:   `claude mcp list` (text output)
/// - Codex:    `codex mcp list --json` (JSON output)
/// - OpenCode: `opencode mcp list` (text output)
/// - Cursor:   `cursor-agent mcp list` (text output)
#[tauri::command]
pub async fn check_mcp_health(
    app: AppHandle,
    backend: Option<String>,
    worktree_path: Option<String>,
) -> Result<McpHealthResult, String> {
    match backend.as_deref() {
        Some("codex") => check_mcp_health_codex(&app),
        Some("opencode") => check_mcp_health_opencode(&app),
        Some("cursor") => check_mcp_health_cursor(&app, worktree_path.as_deref()),
        Some("grok") => Ok(McpHealthResult {
            statuses: std::collections::HashMap::new(),
        }),
        _ => check_mcp_health_claude(&app),
    }
}

fn check_mcp_health_claude(app: &AppHandle) -> Result<McpHealthResult, String> {
    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::debug!("Running: claude mcp list");

    let output = crate::platform::cli_command(&cli_path.to_string_lossy(), None)
        .args(["mcp", "list"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run claude mcp list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("claude mcp list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let statuses = parse_mcp_list_output(&stdout);
    log::debug!("MCP health check (Claude): {} servers", statuses.len());
    Ok(McpHealthResult { statuses })
}

fn check_mcp_health_codex(app: &AppHandle) -> Result<McpHealthResult, String> {
    let cli_path = crate::codex_cli::resolve_cli_binary(app)?;
    if !cli_path.exists() {
        return Err("Codex CLI not installed".to_string());
    }

    log::debug!("Running: codex mcp list --json");

    let output = crate::platform::cli_command(&cli_path.to_string_lossy(), None)
        .args(["mcp", "list", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run codex mcp list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("codex mcp list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let statuses = parse_codex_mcp_list_json(&stdout);
    log::debug!("MCP health check (Codex): {} servers", statuses.len());
    Ok(McpHealthResult { statuses })
}

fn check_mcp_health_opencode(app: &AppHandle) -> Result<McpHealthResult, String> {
    let cli_path = crate::opencode_cli::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("OpenCode CLI not installed".to_string());
    }

    log::debug!("Running: opencode mcp list");

    let output = crate::platform::cli_command(&cli_path.to_string_lossy(), None)
        .args(["mcp", "list"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run opencode mcp list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("opencode mcp list failed: {stderr}"));
    }

    // Reuse the same text parser — OpenCode uses a similar line format
    let stdout = String::from_utf8_lossy(&output.stdout);
    let statuses = parse_mcp_list_output(&stdout);
    log::debug!("MCP health check (OpenCode): {} servers", statuses.len());
    Ok(McpHealthResult { statuses })
}

fn check_mcp_health_cursor(
    app: &AppHandle,
    worktree_path: Option<&str>,
) -> Result<McpHealthResult, String> {
    let statuses =
        crate::cursor_cli::mcp::check_mcp_health(app, worktree_path.map(std::path::Path::new))?;
    log::debug!("MCP health check (Cursor): {} servers", statuses.len());
    Ok(McpHealthResult { statuses })
}

/// Parse `codex mcp list --json` output into health statuses.
fn parse_codex_mcp_list_json(output: &str) -> std::collections::HashMap<String, McpHealthStatus> {
    // Try to parse as array of objects with name + status fields
    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(output) {
        return arr
            .iter()
            .filter_map(|item| {
                let name = item.get("name")?.as_str()?.to_string();
                let status_str = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let status = match status_str {
                    "connected" | "ok" | "ready" => McpHealthStatus::Connected,
                    "disabled" => McpHealthStatus::Disabled,
                    "error" | "failed" => McpHealthStatus::CouldNotConnect,
                    s if s.contains("auth") => McpHealthStatus::NeedsAuthentication,
                    _ => McpHealthStatus::Unknown,
                };
                Some((name, status))
            })
            .collect();
    }
    log::warn!("Could not parse codex mcp list --json output");
    std::collections::HashMap::new()
}

fn send_codex_response(rpc_id: u64, payload: serde_json::Value) -> Result<(), String> {
    super::codex_server::send_response(rpc_id, payload)
}

/// Backward-compatible wrapper for legacy frontend callers.
#[tauri::command]
pub fn approve_codex_command(
    _session_id: String,
    rpc_id: u64,
    decision: String,
) -> Result<(), String> {
    send_codex_response(rpc_id, serde_json::json!({ "decision": decision }))
}

#[tauri::command]
pub fn respond_codex_command_approval(
    _session_id: String,
    rpc_id: u64,
    response: serde_json::Value,
) -> Result<(), String> {
    send_codex_response(rpc_id, response)
}

#[tauri::command]
pub fn respond_codex_file_change_approval(
    _session_id: String,
    rpc_id: u64,
    decision: String,
) -> Result<(), String> {
    send_codex_response(rpc_id, serde_json::json!({ "decision": decision }))
}

#[tauri::command]
pub fn respond_codex_permissions_request(
    _session_id: String,
    rpc_id: u64,
    permissions: serde_json::Value,
    scope: Option<String>,
) -> Result<(), String> {
    let mut payload = serde_json::json!({ "permissions": permissions });
    if let Some(scope) = scope {
        payload["scope"] = serde_json::json!(scope);
    }
    send_codex_response(rpc_id, payload)
}

#[tauri::command]
pub fn respond_codex_user_input_request(
    _session_id: String,
    rpc_id: u64,
    answers: std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    send_codex_response(rpc_id, serde_json::json!({ "answers": answers }))
}

#[tauri::command]
pub fn respond_codex_mcp_elicitation(
    _session_id: String,
    rpc_id: u64,
    action: String,
    content: Option<serde_json::Value>,
    meta: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut payload = serde_json::json!({ "action": action });
    if let Some(content) = content {
        payload["content"] = content;
    }
    if let Some(meta) = meta {
        payload["_meta"] = meta;
    }
    send_codex_response(rpc_id, payload)
}

#[tauri::command]
pub fn respond_codex_dynamic_tool_call(
    _session_id: String,
    rpc_id: u64,
    success: bool,
    content_items: Vec<serde_json::Value>,
) -> Result<(), String> {
    send_codex_response(
        rpc_id,
        serde_json::json!({
            "success": success,
            "contentItems": content_items,
        }),
    )
}

// =============================================================================
// Queue management commands (atomic operations for cross-client sync)
// =============================================================================

/// Push a message onto a session's queue. Returns the updated queue.
/// Uses per-session metadata locking to avoid racing with send_chat_message.
#[tauri::command]
pub async fn enqueue_message(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    message: serde_json::Value,
) -> Result<Vec<serde_json::Value>, String> {
    let queue = with_existing_metadata_mut(&app, &session_id, |metadata| {
        metadata.queued_messages.push(message);
        metadata.queued_messages.clone()
    })?;

    app.emit_all(
        "queue:updated",
        &serde_json::json!({ "sessionId": session_id, "queue": queue }),
    )
    .ok();

    trigger_backend_queue_drain(app.clone(), worktree_id, worktree_path, session_id);

    Ok(queue)
}

/// Remove and return the first message from a session's queue.
/// Returns null if the queue is empty (prevents double-processing by racing clients).
/// Holds the metadata lock across the entire read-modify-write to prevent TOCTOU races.
#[tauri::command]
pub async fn dequeue_message(
    app: AppHandle,
    _worktree_id: String,
    _worktree_path: String,
    session_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let (dequeued, queue) = with_existing_metadata_mut(&app, &session_id, |metadata| {
        let dequeued = if metadata.queued_messages.is_empty() {
            None
        } else {
            Some(metadata.queued_messages.remove(0))
        };
        let remaining = metadata.queued_messages.clone();
        (dequeued, remaining)
    })?;

    app.emit_all(
        "queue:updated",
        &serde_json::json!({ "sessionId": session_id, "queue": queue }),
    )
    .ok();

    Ok(dequeued)
}

/// Remove a specific message from the queue by its `id` field.
/// Holds the metadata lock across the entire read-modify-write to prevent TOCTOU races.
#[tauri::command]
pub async fn remove_queued_message(
    app: AppHandle,
    _worktree_id: String,
    _worktree_path: String,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    let queue = with_existing_metadata_mut(&app, &session_id, |metadata| {
        metadata
            .queued_messages
            .retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(&message_id));
        metadata.queued_messages.clone()
    })?;

    app.emit_all(
        "queue:updated",
        &serde_json::json!({ "sessionId": session_id, "queue": queue }),
    )
    .ok();

    Ok(())
}

/// Update a specific queued message's text by its `id` field.
/// Returns `false` when the message is no longer queued.
/// Holds the metadata lock across the entire read-modify-write to prevent TOCTOU races.
#[tauri::command]
pub async fn update_queued_message(
    app: AppHandle,
    _worktree_id: String,
    _worktree_path: String,
    session_id: String,
    message_id: String,
    message: String,
) -> Result<bool, String> {
    let (updated, queue) = with_existing_metadata_mut(&app, &session_id, |metadata| {
        let Some(idx) = metadata
            .queued_messages
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(message_id.as_str()))
        else {
            return (false, metadata.queued_messages.clone());
        };

        if queued_message_supports_any_steering(&metadata.queued_messages[idx]) {
            return (false, metadata.queued_messages.clone());
        }

        let queued = &mut metadata.queued_messages[idx];
        if let Some(obj) = queued.as_object_mut() {
            obj.insert("message".to_string(), serde_json::Value::String(message));
            return (true, metadata.queued_messages.clone());
        }

        (false, metadata.queued_messages.clone())
    })?;

    if updated {
        app.emit_all(
            "queue:updated",
            &serde_json::json!({ "sessionId": session_id, "queue": queue }),
        )
        .ok();
    }

    Ok(updated)
}

/// Clear all queued messages for a session.
/// Holds the metadata lock across the entire read-modify-write to prevent TOCTOU races.
#[tauri::command]
pub async fn clear_message_queue(
    app: AppHandle,
    _worktree_id: String,
    _worktree_path: String,
    session_id: String,
) -> Result<(), String> {
    with_existing_metadata_mut(&app, &session_id, |metadata| {
        metadata.queued_messages.clear();
    })?;

    app.emit_all(
        "queue:updated",
        &serde_json::json!({ "sessionId": session_id, "queue": Vec::<serde_json::Value>::new() }),
    )
    .ok();

    Ok(())
}

/// Move a specific queued message to the front of the queue by its `id` field.
/// Returns `false` when the message is no longer queued (another client dequeued
/// or removed it) — callers must abort their send-now flow in that case.
/// Holds the metadata lock across the entire read-modify-write to prevent TOCTOU races.
#[tauri::command]
pub async fn move_queued_message_front(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    message_id: String,
) -> Result<bool, String> {
    let (moved, queue) = with_existing_metadata_mut(&app, &session_id, |metadata| {
        let idx = metadata
            .queued_messages
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(message_id.as_str()));
        let moved = match idx {
            Some(idx) => {
                let msg = metadata.queued_messages.remove(idx);
                metadata.queued_messages.insert(0, msg);
                true
            }
            None => false,
        };
        (moved, metadata.queued_messages.clone())
    })?;

    if moved {
        app.emit_all(
            "queue:updated",
            &serde_json::json!({ "sessionId": session_id, "queue": queue }),
        )
        .ok();

        // A session that went idle mid-click should still pick up the promoted message.
        trigger_backend_queue_drain(app.clone(), worktree_id, worktree_path, session_id);
    }

    Ok(moved)
}

/// Inject a user message into a running Codex turn via app-server `turn/steer`.
/// The injected text becomes part of the current turn (the model sees it after
/// the next tool call). Fails when the session has no active turn or the turn
/// already ended — callers fall back to cancel+send.
#[tauri::command]
pub async fn steer_codex_turn(
    app: AppHandle,
    worktree_id: String,
    session_id: String,
    message: String,
    queued_message: Option<Value>,
) -> Result<(), String> {
    if let Some(queued_message) = queued_message {
        let input = codex_steer_input_from_queued_message(&queued_message)?;
        let display_text = build_queued_message_with_refs(&queued_message)?;
        steer_input_into_codex_turn(&app, &worktree_id, &session_id, input, &display_text).await
    } else {
        steer_text_into_codex_turn(&app, &worktree_id, &session_id, &message).await
    }
}

/// Inject a text-only user message into a running OpenCode session via
/// OpenCode's `prompt_async` endpoint. Unlike Codex `turn/steer`, OpenCode
/// appends an async prompt to the active session; callers still fall back to
/// queue/cancel+send when this request fails.
#[tauri::command]
pub async fn steer_opencode_turn(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    message: String,
) -> Result<(), String> {
    steer_text_into_opencode_turn(&app, &worktree_id, &worktree_path, &session_id, &message).await
}

fn opencode_text_prompt_payload(message: &str) -> serde_json::Value {
    serde_json::json!({
        "parts": [
            {
                "type": "text",
                "text": message,
            }
        ]
    })
}

async fn steer_text_into_opencode_turn(
    app: &AppHandle,
    worktree_id: &str,
    worktree_path: &str,
    session_id: &str,
    message: &str,
) -> Result<(), String> {
    let metadata = load_metadata(app, session_id)?
        .ok_or_else(|| format!("No metadata found for session: {session_id}"))?;
    // Prefer the live run's OpenCode session id from the registry: on the FIRST
    // turn of a new session, `metadata.opencode_session_id` is still None (only
    // persisted after the run completes), so metadata-only resolution silently
    // dropped first-turn steers. The registry holds the currently-running id.
    let opencode_session_id = super::registry::get_opencode_session_id(session_id)
        .or_else(|| metadata.opencode_session_id.clone())
        .ok_or_else(|| format!("No OpenCode session id for session: {session_id}"))?;
    let run_id = metadata
        .runs
        .iter()
        .rev()
        .find(|r| r.status == RunStatus::Running && r.backend == Some(Backend::Opencode))
        .map(|r| r.run_id.clone())
        .ok_or_else(|| format!("No running OpenCode run for session: {session_id}"))?;

    // Wait until the main `/message` turn is actively streaming before injecting.
    // A `prompt_async` sent before the turn is live starts a SECOND concurrent
    // turn on the same OpenCode session, which resets the in-flight `/message`
    // connection (the "error sending request for url" failure). If the turn never
    // starts within the window, bail so the caller requeues instead of colliding.
    if !crate::chat::opencode::wait_opencode_turn_started(
        &opencode_session_id,
        std::time::Duration::from_secs(15),
    ) {
        return Err(format!(
            "OpenCode turn not yet active for session {session_id}; cannot steer"
        ));
    }

    let base_url = crate::opencode_server::acquire(app)?;

    struct ServerReleaseGuard;
    impl Drop for ServerReleaseGuard {
        fn drop(&mut self) {
            crate::opencode_server::release();
        }
    }
    let _server_guard = ServerReleaseGuard;

    let prompt_url = format!("{base_url}/session/{opencode_session_id}/prompt_async");
    let directory = worktree_path.to_string();
    let payload = opencode_text_prompt_payload(message);

    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to build OpenCode steer client: {e}"))?;

        let response = client
            .post(&prompt_url)
            .query(&[("directory", directory)])
            .json(&payload)
            .send()
            .map_err(|e| format!("Failed to steer OpenCode session: {e}"))?;

        if response.status().is_success() {
            Ok(())
        } else {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            Err(format!(
                "OpenCode steer failed: status={status}, body={body}"
            ))
        }
    })
    .await
    .map_err(|e| format!("OpenCode steer task failed: {e}"))??;

    // Tell the running OpenCode turn to wait for `session.idle` before finalizing,
    // so this injected prompt's streamed output is captured into the run.
    crate::chat::opencode::mark_opencode_steered(&opencode_session_id);

    match run_log::RunLogWriter::resume(app, session_id, &run_id) {
        Ok(mut writer) => {
            let line = serde_json::json!({
                "type": "steered_user_message",
                "text": message,
            });
            if let Err(e) = writer.write_line(&line.to_string()) {
                log::warn!(
                    "Failed to persist OpenCode steered message for session {session_id}: {e}"
                );
            }
        }
        Err(e) => log::warn!("Failed to open OpenCode run log for steered message: {e}"),
    }

    app.emit_all(
        "chat:steered",
        &serde_json::json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "text": message,
        }),
    )
    .ok();

    Ok(())
}

/// Core steer implementation shared by the `steer_codex_turn` command and the
/// queue auto-steer drain: sends `turn/steer`, persists the injected text into
/// the run log, and broadcasts `chat:steered` for live display.
async fn steer_text_into_codex_turn(
    app: &AppHandle,
    worktree_id: &str,
    session_id: &str,
    message: &str,
) -> Result<(), String> {
    let input = vec![serde_json::json!({
        "type": "text",
        "text": message,
        "text_elements": [],
    })];
    steer_input_into_codex_turn(app, worktree_id, session_id, input, message).await
}

async fn steer_input_into_codex_turn(
    app: &AppHandle,
    worktree_id: &str,
    session_id: &str,
    input: Vec<Value>,
    display_text: &str,
) -> Result<(), String> {
    let (thread_id, turn_id) = super::registry::get_codex_turn(session_id)
        .ok_or_else(|| format!("No active Codex turn for session: {session_id}"))?;
    // Turn registered with empty id before turn/started arrives — too early to steer.
    if turn_id.is_empty() {
        return Err("Codex turn not started yet".to_string());
    }

    let metadata = load_metadata(app, session_id)?
        .ok_or_else(|| format!("No metadata found for session: {session_id}"))?;
    let run_id = metadata
        .runs
        .iter()
        .rev()
        .find(|r| r.status == RunStatus::Running)
        .map(|r| r.run_id.clone())
        .ok_or_else(|| format!("No running run for session: {session_id}"))?;

    // send_request blocks on a oneshot channel — must not run on the async runtime.
    let params = super::codex::build_turn_steer_params_with_input(&thread_id, &turn_id, input);
    tauri::async_runtime::spawn_blocking(move || {
        super::codex_server::send_request("turn/steer", params)
    })
    .await
    .map_err(|e| format!("Steer task failed: {e}"))??;

    // Persist into the run log so transcript reconstruction keeps the injected
    // text ordered between the surrounding tool calls. Appends are atomic per
    // write, so this is safe alongside the live event writer.
    match run_log::RunLogWriter::resume(app, session_id, &run_id) {
        Ok(mut writer) => {
            let line = serde_json::json!({
                "type": "steered_user_message",
                "text": display_text,
            });
            if let Err(e) = writer.write_line(&line.to_string()) {
                log::warn!("Failed to persist steered message for session {session_id}: {e}");
            }
        }
        Err(e) => log::warn!("Failed to open run log for steered message: {e}"),
    }

    // Live display on all clients (native + web).
    app.emit_all(
        "chat:steered",
        &serde_json::json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "text": display_text,
        }),
    )
    .ok();

    Ok(())
}

/// A queued message can be steered into a running Codex turn when its captured
/// backend is Codex. Codex `turn/steer` accepts structured user input, so queued
/// images/files/skills are forwarded as structured attachments. A message queued
/// with a different backend
///   selected (the user switched mid-run) must NOT be injected into the Codex
///   turn — it runs as its own backend once the current run finishes.
///
/// The `backend` field is omitted for the Claude default (see the frontend
/// `QueuedMessage` capture), so a missing/null backend is treated as non-Codex.
fn queued_message_is_steerable(msg: &serde_json::Value) -> bool {
    queued_message_is_steerable_for_backend(msg, "codex")
}

fn queued_message_is_steerable_for_backend(msg: &serde_json::Value, backend: &str) -> bool {
    let backend_matches = msg.get("backend").and_then(Value::as_str) == Some(backend);
    if !backend_matches {
        return false;
    }

    if backend == "codex" {
        return true;
    }

    const ATTACHMENT_KEYS: [&str; 4] = [
        "pendingImages",
        "pendingFiles",
        "pendingSkills",
        "pendingTextFiles",
    ];
    ATTACHMENT_KEYS.iter().all(|key| {
        msg.get(key)
            .and_then(Value::as_array)
            .map(|a| a.is_empty())
            .unwrap_or(true)
    })
}

fn queued_message_supports_any_steering(msg: &serde_json::Value) -> bool {
    queued_message_is_steerable_for_backend(msg, "codex")
        || queued_message_is_steerable_for_backend(msg, "opencode")
        || queued_message_is_steerable_for_backend(msg, "pi")
}

/// Inject a user message into a running Pi RPC turn via the detached PI host.
#[tauri::command]
pub async fn steer_pi_turn(
    app: AppHandle,
    worktree_id: String,
    session_id: String,
    message: String,
) -> Result<(), String> {
    steer_text_into_pi_turn(&app, &worktree_id, &session_id, &message).await
}

async fn steer_text_into_pi_turn(
    app: &AppHandle,
    worktree_id: &str,
    session_id: &str,
    message: &str,
) -> Result<(), String> {
    #[cfg(not(unix))]
    {
        let _ = (app, worktree_id, session_id, message);
        Err("Pi steering is only available for detached Unix RPC hosts".to_string())
    }

    #[cfg(unix)]
    {
        let metadata = load_metadata(app, session_id)?
            .ok_or_else(|| format!("No metadata found for session: {session_id}"))?;
        let run_id = metadata
            .runs
            .iter()
            .rev()
            .find(|r| r.status == RunStatus::Running && r.backend == Some(Backend::Pi))
            .map(|r| r.run_id.clone())
            .ok_or_else(|| format!("No running Pi run for session: {session_id}"))?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
        let socket_path = super::pi::pi_rpc_socket_path(&app_data, session_id, &run_id);
        let line = super::pi::serialize_pi_rpc_command(
            "steer",
            Some(message),
            Some(&format!("steer-{run_id}")),
        );
        super::pi::send_pi_rpc_host_command(&socket_path, &line)?;

        match run_log::RunLogWriter::resume(app, session_id, &run_id) {
            Ok(mut writer) => {
                let line = serde_json::json!({
                    "type": "steered_user_message",
                    "text": message,
                });
                if let Err(e) = writer.write_line(&line.to_string()) {
                    log::warn!(
                        "Failed to persist Pi steered message for session {session_id}: {e}"
                    );
                }
            }
            Err(e) => log::warn!("Failed to open run log for Pi steered message: {e}"),
        }

        app.emit_all(
            "chat:steered",
            &serde_json::json!({
                "session_id": session_id,
                "worktree_id": worktree_id,
                "text": message,
            }),
        )
        .ok();

        Ok(())
    }
}

/// Drain steerable queued messages straight into the running Codex turn
/// (when the `codex_auto_steer_enabled` preference is on, default true).
/// Pops from the queue front in FIFO order and stops at the first message
/// that can't be steered (attachments) so queue order is preserved.
async fn drain_queue_into_codex_turn(app: &AppHandle, worktree_id: &str, session_id: &str) {
    let auto_steer = crate::load_preferences_sync(app)
        .map(|p| p.codex_auto_steer_enabled)
        .unwrap_or(true);
    if !auto_steer {
        return;
    }

    loop {
        // Only steer while a started codex turn is registered.
        let Some((_, turn_id)) = super::registry::get_codex_turn(session_id) else {
            return;
        };
        if turn_id.is_empty() {
            return;
        }

        let popped = match with_existing_metadata_mut(app, session_id, |metadata| {
            match metadata.queued_messages.first() {
                Some(front) if queued_message_is_steerable(front) => {
                    let msg = metadata.queued_messages.remove(0);
                    (Some(msg), metadata.queued_messages.clone())
                }
                _ => (None, metadata.queued_messages.clone()),
            }
        }) {
            Ok((popped, queue)) => {
                if popped.is_some() {
                    app.emit_all(
                        "queue:updated",
                        &serde_json::json!({ "sessionId": session_id, "queue": queue }),
                    )
                    .ok();
                }
                popped
            }
            Err(e) => {
                log::warn!("[CodexSteer] failed to read queue session={session_id}: {e}");
                return;
            }
        };

        let Some(msg) = popped else { return };
        let input = match codex_steer_input_from_queued_message(&msg) {
            Ok(input) => input,
            Err(e) => {
                log::warn!(
                    "[CodexSteer] invalid queued message, skipping session={session_id}: {e}"
                );
                continue;
            }
        };
        let display_text = match build_queued_message_with_refs(&msg) {
            Ok(text) => text,
            Err(e) => {
                log::warn!("[CodexSteer] invalid queued message display text, skipping session={session_id}: {e}");
                continue;
            }
        };

        log::info!("[CodexSteer] steering queued message into running turn session={session_id}");
        if let Err(e) =
            steer_input_into_codex_turn(app, worktree_id, session_id, input, &display_text).await
        {
            // Turn ended mid-drain — put the message back so the normal
            // queue path sends it when the run completes.
            log::warn!("[CodexSteer] steer failed, requeueing at front session={session_id}: {e}");
            let requeued = with_existing_metadata_mut(app, session_id, |metadata| {
                metadata.queued_messages.insert(0, msg.clone());
                metadata.queued_messages.clone()
            });
            if let Ok(queue) = requeued {
                app.emit_all(
                    "queue:updated",
                    &serde_json::json!({ "sessionId": session_id, "queue": queue }),
                )
                .ok();
            }
            return;
        }
    }
}

/// Fire-and-forget steer drain — called from the Codex `turn/started` handler
/// so prompts queued before the turn became steerable get injected.
pub(crate) fn trigger_codex_queue_steer(app: AppHandle, worktree_id: String, session_id: String) {
    tauri::async_runtime::spawn(async move {
        drain_queue_into_codex_turn(&app, &worktree_id, &session_id).await;
    });
}

/// Drain steerable queued messages into a running OpenCode session via
/// `prompt_async` (when `opencode_auto_steer_enabled` is on, default true).
async fn drain_queue_into_opencode_turn(
    app: &AppHandle,
    worktree_id: &str,
    worktree_path: &str,
    session_id: &str,
) {
    let auto_steer = crate::load_preferences_sync(app)
        .map(|p| p.opencode_auto_steer_enabled)
        .unwrap_or(true);
    if !auto_steer {
        return;
    }

    loop {
        let has_running_opencode = load_metadata(app, session_id)
            .ok()
            .flatten()
            .and_then(|metadata| {
                metadata
                    .runs
                    .iter()
                    .rev()
                    .find(|r| {
                        r.status == RunStatus::Running && r.backend == Some(Backend::Opencode)
                    })
                    .map(|r| r.run_id.clone())
            })
            .is_some();
        if !has_running_opencode {
            return;
        }

        let popped = match with_existing_metadata_mut(app, session_id, |metadata| {
            match metadata.queued_messages.first() {
                Some(front) if queued_message_is_steerable_for_backend(front, "opencode") => {
                    let msg = metadata.queued_messages.remove(0);
                    (Some(msg), metadata.queued_messages.clone())
                }
                _ => (None, metadata.queued_messages.clone()),
            }
        }) {
            Ok((popped, queue)) => {
                if popped.is_some() {
                    app.emit_all(
                        "queue:updated",
                        &serde_json::json!({ "sessionId": session_id, "queue": queue }),
                    )
                    .ok();
                }
                popped
            }
            Err(e) => {
                log::warn!("[OpenCodeSteer] failed to read queue session={session_id}: {e}");
                return;
            }
        };

        let Some(msg) = popped else { return };
        let text = msg
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }

        log::info!("[OpenCodeSteer] steering queued message into running session={session_id}");
        if let Err(e) =
            steer_text_into_opencode_turn(app, worktree_id, worktree_path, session_id, &text).await
        {
            log::warn!(
                "[OpenCodeSteer] steer failed, requeueing at front session={session_id}: {e}"
            );
            let requeued = with_existing_metadata_mut(app, session_id, |metadata| {
                metadata.queued_messages.insert(0, msg.clone());
                metadata.queued_messages.clone()
            });
            if let Ok(queue) = requeued {
                app.emit_all(
                    "queue:updated",
                    &serde_json::json!({ "sessionId": session_id, "queue": queue }),
                )
                .ok();
            }
            return;
        }
    }
}

/// Fire-and-forget OpenCode steer drain — called after OpenCode session id is
/// known, so prompts queued while startup was still registering can be injected.
pub(crate) fn trigger_opencode_queue_steer(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) {
    tauri::async_runtime::spawn(async move {
        drain_queue_into_opencode_turn(&app, &worktree_id, &worktree_path, &session_id).await;
    });
}

/// Drain steerable queued messages into a running Pi RPC host. Pi's own
/// steering queue delivers these at the next safe tool/turn boundary.
async fn drain_queue_into_pi_turn(app: &AppHandle, worktree_id: &str, session_id: &str) {
    let auto_steer = crate::load_preferences_sync(app)
        .map(|p| p.pi_auto_steer_enabled)
        .unwrap_or(true);
    if !auto_steer {
        return;
    }

    #[cfg(not(unix))]
    {
        let _ = (app, worktree_id, session_id);
    }

    #[cfg(unix)]
    loop {
        let has_running_pi = load_metadata(app, session_id)
            .ok()
            .flatten()
            .and_then(|metadata| {
                metadata
                    .runs
                    .iter()
                    .rev()
                    .find(|r| r.status == RunStatus::Running && r.backend == Some(Backend::Pi))
                    .map(|r| r.run_id.clone())
            })
            .is_some();
        if !has_running_pi {
            return;
        }

        let popped = match with_existing_metadata_mut(app, session_id, |metadata| {
            match metadata.queued_messages.first() {
                Some(front) if queued_message_is_steerable_for_backend(front, "pi") => {
                    let msg = metadata.queued_messages.remove(0);
                    (Some(msg), metadata.queued_messages.clone())
                }
                _ => (None, metadata.queued_messages.clone()),
            }
        }) {
            Ok((popped, queue)) => {
                if popped.is_some() {
                    app.emit_all(
                        "queue:updated",
                        &serde_json::json!({ "sessionId": session_id, "queue": queue }),
                    )
                    .ok();
                }
                popped
            }
            Err(e) => {
                log::warn!("[PiSteer] failed to read queue session={session_id}: {e}");
                return;
            }
        };

        let Some(msg) = popped else { return };
        let text = msg
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }

        log::info!("[PiSteer] steering queued message into running Pi session={session_id}");
        if let Err(e) = steer_text_into_pi_turn(app, worktree_id, session_id, &text).await {
            log::warn!("[PiSteer] steer failed, requeueing at front session={session_id}: {e}");
            let requeued = with_existing_metadata_mut(app, session_id, |metadata| {
                metadata.queued_messages.insert(0, msg.clone());
                metadata.queued_messages.clone()
            });
            if let Ok(queue) = requeued {
                app.emit_all(
                    "queue:updated",
                    &serde_json::json!({ "sessionId": session_id, "queue": queue }),
                )
                .ok();
            }
            return;
        }
    }
}

/// Cancel the pending ScheduleWakeup for a session (user-initiated).
#[tauri::command]
pub async fn cancel_session_wakeup(app: AppHandle, session_id: String) -> Result<bool, String> {
    let cleared = super::wakeup::cancel(&app, &session_id)?;
    Ok(cleared.is_some())
}

/// Fetch the pending ScheduleWakeup for a session (UI hydration).
#[tauri::command]
pub async fn get_scheduled_wakeup(
    app: AppHandle,
    session_id: String,
) -> Result<Option<super::types::ScheduledWakeup>, String> {
    super::wakeup::get_for_session(&app, &session_id)
}

/// List all currently-pending ScheduleWakeup entries across sessions.
/// Used by the frontend at mount to hydrate the indicator store.
#[tauri::command]
pub async fn list_pending_wakeups() -> Result<Vec<super::wakeup::PendingWakeupEntry>, String> {
    Ok(super::wakeup::list_pending())
}

/// Answer a pending OpenCode question by calling the OpenCode Question.reply API.
/// This unblocks the in-flight HTTP POST that is waiting for the question to be answered.
#[tauri::command]
pub async fn answer_opencode_question(
    app: AppHandle,
    worktree_path: String,
    tool_call_id: String,
    answers: Vec<Vec<String>>,
) -> Result<(), String> {
    let working_dir = worktree_path.clone();
    let app_clone = app.clone();

    tokio::task::spawn_blocking(move || {
        super::opencode::answer_opencode_question(&app_clone, &working_dir, &tool_call_id, answers)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::ToolCall;

    #[test]
    fn unavailable_ask_user_question_error_is_not_pending_input() {
        let tool = ToolCall {
            id: "toolu_unavailable_question".to_string(),
            name: "AskUserQuestion".to_string(),
            input: serde_json::json!({
                "questions": "[{\"question\":\"Pick one\"}]"
            }),
            output: Some("<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion exists but is not enabled in this context. Use one of the available tools instead.</tool_use_error>".to_string()),
            parent_tool_use_id: None,
        };

        assert!(!is_pending_blocking_tool_call(&tool));
    }

    #[test]
    fn editor_file_args_uses_goto_location_for_vscode_and_cursor() {
        assert_eq!(
            editor_file_args("vscode", "/tmp/main.ts", Some(42), Some(3)),
            vec!["-g".to_string(), "/tmp/main.ts:42:3".to_string()]
        );
        assert_eq!(
            editor_file_args("cursor", "/tmp/main.ts", Some(42), None),
            vec!["-g".to_string(), "/tmp/main.ts:42".to_string()]
        );
    }

    #[test]
    fn editor_file_args_uses_editor_specific_line_flags() {
        assert_eq!(
            editor_file_args("xcode", "/tmp/main.swift", Some(7), Some(2)),
            vec![
                "-l".to_string(),
                "7".to_string(),
                "/tmp/main.swift".to_string()
            ]
        );
        assert_eq!(
            editor_file_args("intellij", "/tmp/Main.kt", Some(7), Some(2)),
            vec![
                "--line".to_string(),
                "7".to_string(),
                "/tmp/Main.kt".to_string()
            ]
        );
    }

    #[test]
    fn queued_message_steerable_allows_codex_attachments() {
        // Codex backend, no attachments → steerable
        let codex_plain = serde_json::json!({
            "id": "m1", "message": "hello", "backend": "codex",
        });
        assert!(queued_message_is_steerable(&codex_plain));

        let codex_empty_attachments = serde_json::json!({
            "id": "m2",
            "message": "hello",
            "backend": "codex",
            "pendingImages": [],
            "pendingFiles": [],
            "pendingSkills": [],
            "pendingTextFiles": [],
        });
        assert!(queued_message_is_steerable(&codex_empty_attachments));

        // Codex backend with attachments → steerable as structured Codex input
        let codex_with_image = serde_json::json!({
            "id": "m3",
            "message": "hello",
            "backend": "codex",
            "pendingImages": [{ "id": "img-1", "path": "/tmp/a.png" }],
        });
        assert!(queued_message_is_steerable(&codex_with_image));

        // Different backend selected mid-run → never steer into the codex turn
        let claude_default = serde_json::json!({ "id": "m4", "message": "hello" });
        assert!(!queued_message_is_steerable(&claude_default));

        let opencode = serde_json::json!({
            "id": "m5", "message": "hello", "backend": "opencode",
        });
        assert!(!queued_message_is_steerable(&opencode));
    }

    #[test]
    fn queued_message_steerable_for_backend_accepts_opencode_text_only() {
        let opencode_plain = serde_json::json!({
            "id": "m1",
            "message": "hello",
            "backend": "opencode",
            "pendingImages": [],
            "pendingFiles": [],
            "pendingSkills": [],
            "pendingTextFiles": [],
        });
        assert!(queued_message_is_steerable_for_backend(
            &opencode_plain,
            "opencode"
        ));

        let opencode_with_file = serde_json::json!({
            "id": "m2",
            "message": "hello",
            "backend": "opencode",
            "pendingFiles": [{ "id": "file-1", "path": "/tmp/a.txt" }],
        });
        assert!(!queued_message_is_steerable_for_backend(
            &opencode_with_file,
            "opencode"
        ));
    }

    #[test]
    fn opencode_text_prompt_payload_uses_text_part_only() {
        assert_eq!(
            opencode_text_prompt_payload("steer now"),
            serde_json::json!({
                "parts": [
                    {
                        "type": "text",
                        "text": "steer now",
                    }
                ]
            })
        );
    }

    #[test]
    fn test_queue_default_allowed_tools_match_frontend_git_scope() {
        assert!(QUEUE_DEFAULT_ALLOWED_TOOLS.contains(&"Bash(git:*)"));
        assert!(!QUEUE_DEFAULT_ALLOWED_TOOLS.contains(&"Bash"));
        assert!(QUEUE_DEFAULT_ALLOWED_TOOLS.contains(&"Read"));
        assert!(QUEUE_DEFAULT_ALLOWED_TOOLS.contains(&"Glob"));
        assert!(QUEUE_DEFAULT_ALLOWED_TOOLS.contains(&"Grep"));
    }

    #[test]
    fn commandcode_model_implies_commandcode_backend() {
        assert_eq!(
            infer_backend_from_model("commandcode/deepseek/deepseek-v4-flash", Backend::Claude),
            Backend::Commandcode
        );
    }

    #[test]
    fn claude_resume_id_requires_assistant_payload() {
        assert_eq!(
            resume_id_for_persisted_claude_run(&Backend::Claude, "claude-session-1", false),
            None
        );
        assert_eq!(
            resume_id_for_persisted_claude_run(&Backend::Claude, "claude-session-1", true),
            Some("claude-session-1")
        );
    }

    #[test]
    fn stale_resumed_claude_session_is_cleared_for_empty_cancelled_response() {
        assert!(should_clear_stale_resumed_claude_session(
            true, false, false, false, false, false
        ));
    }

    #[test]
    fn stale_resumed_claude_session_is_not_cleared_when_payload_exists() {
        assert!(!should_clear_stale_resumed_claude_session(
            true, true, false, false, false, true
        ));
        assert!(!should_clear_stale_resumed_claude_session(
            true, false, true, false, false, true
        ));
        assert!(!should_clear_stale_resumed_claude_session(
            true, false, false, true, false, true
        ));
    }

    #[test]
    fn stale_resumed_claude_session_is_kept_for_cancelled_content_block_only_response() {
        // Regression for the send-path branch at the execute_claude_detached call
        // site: a cancelled response that carries content_blocks but no plain
        // content must NOT clear the resumed session id. Clearing it here is what
        // produced "Response content was not captured for this completed run."
        // after cancelling and resending (issue #395).
        let was_resuming = true;
        let has_content = false;
        let has_tool_calls = false;
        let has_content_blocks = true;
        let has_usage = false;
        let was_cancelled = true;

        assert!(!should_clear_stale_resumed_claude_session(
            was_resuming,
            has_content,
            has_tool_calls,
            has_content_blocks,
            has_usage,
            was_cancelled,
        ));
    }

    #[test]
    fn idle_sessions_should_not_forward_cancel_requests() {
        assert!(!should_forward_cancel_request("idle-session"));
    }

    #[test]
    fn active_send_should_forward_cancel_requests_before_process_registration() {
        let _claim =
            SendClaim::try_acquire("pre-register-session").expect("send claim should acquire");

        assert!(should_forward_cancel_request("pre-register-session"));
    }

    #[test]
    fn default_model_for_commandcode_backend_uses_commandcode_preference() {
        let prefs = crate::AppPreferences {
            selected_model: "claude-sonnet-4-6[1m]".to_string(),
            selected_commandcode_model: "commandcode/deepseek/deepseek-v4-flash".to_string(),
            ..Default::default()
        };

        assert_eq!(
            default_model_for_backend(&Backend::Commandcode, &prefs),
            Some("commandcode/deepseek/deepseek-v4-flash".to_string())
        );
    }

    #[test]
    fn test_codex_default_prompt_injects_plan_rules_only_in_plan_mode() {
        let plan_prompt = codex_default_global_system_prompt(Some("plan"));
        assert!(plan_prompt.contains("## Plan Mode"));
        assert!(plan_prompt.contains("PLAN MODE"));
        assert!(plan_prompt.contains("update_plan"));
        assert!(plan_prompt.contains("CodexPlan"));
        assert!(plan_prompt.contains("approval UI"));
        assert!(!plan_prompt.contains("## Not Plan Mode"));

        let build_prompt = codex_default_global_system_prompt(Some("build"));
        assert!(!build_prompt.contains("## Plan Mode"));
        assert!(!build_prompt.contains("update_plan"));
        assert!(!build_prompt.contains("CodexPlan"));
        assert!(build_prompt.contains("## Not Plan Mode"));
        assert!(build_prompt.contains("Jean Worktree Policy"));
        assert!(build_prompt.contains("Do NOT create git worktrees manually"));
        assert!(build_prompt.contains("Jean MCP/tools"));
        assert!(build_prompt.contains("VERY IMPORTANT: Keep Code Simple"));
        assert!(build_prompt.contains("Always implement the simplest maintainable solution"));
        assert!(build_prompt.contains("Clickable References"));
        assert!(build_prompt.contains("include clickable links when available"));

        let yolo_prompt = codex_default_global_system_prompt(Some("yolo"));
        assert!(!yolo_prompt.contains("## Plan Mode"));
        assert!(!yolo_prompt.contains("update_plan"));
        assert!(!yolo_prompt.contains("CodexPlan"));
        assert!(yolo_prompt.contains("## Not Plan Mode"));
        assert!(yolo_prompt.contains("VERY IMPORTANT: Keep Code Simple"));
        assert!(yolo_prompt.contains("Clickable References"));
    }

    #[test]
    fn test_codex_legacy_global_default_resolves_to_mode_specific_prompt() {
        let legacy_default = "### 1. Plan Mode Default
- Every Codex plan-mode response that contains or revises a plan must use `update_plan`/`CodexPlan`; do not provide plain-text-only plans.

## Jean Worktree Policy";

        let yolo_prompt = resolve_codex_global_system_prompt(Some(legacy_default), Some("yolo"));
        assert!(!yolo_prompt.contains("Plan Mode Default"));
        assert!(!yolo_prompt.contains("update_plan"));
        assert!(!yolo_prompt.contains("CodexPlan"));
        assert!(yolo_prompt.contains("## Not Plan Mode"));

        let plan_prompt = resolve_codex_global_system_prompt(Some(legacy_default), Some("plan"));
        assert!(plan_prompt.contains("## Plan Mode"));
        assert!(plan_prompt.contains("CodexPlan"));
    }

    #[test]
    fn test_codex_custom_global_prompt_is_preserved() {
        let custom_prompt = "Custom project rule: always mention the release train.";

        let resolved = resolve_codex_global_system_prompt(Some(custom_prompt), Some("yolo"));

        assert_eq!(resolved, custom_prompt);
    }

    #[test]
    fn test_codex_execution_mode_instruction_is_last_authoritative_part() {
        let mut parts = vec![
            "Custom prompt still says Every Codex plan-mode response must use update_plan/CodexPlan.".to_string(),
            crate::chat::RECAP_INSTRUCTION.to_string(),
        ];

        append_codex_execution_mode_instruction(&mut parts, Some("yolo"));
        let combined = parts.join("\n");

        let stale_plan_rule = combined
            .rfind("update_plan/CodexPlan")
            .expect("stale plan rule is present in custom prompt");
        let mode_override = combined
            .rfind("YOLO EXECUTION MODE")
            .expect("yolo override is present");

        assert!(
            mode_override > stale_plan_rule,
            "the current execution-mode override must come after stale plan instructions"
        );
        assert!(combined
            .trim_end()
            .ends_with("switching back to plan mode."));
    }

    #[test]
    fn test_codex_execution_mode_instruction_overrides_build_and_yolo() {
        assert!(codex_execution_mode_instruction(Some("plan")).is_none());

        let build = codex_execution_mode_instruction(Some("build")).unwrap();
        assert!(build.contains("BUILD MODE"));
        assert!(build.contains("Start implementing immediately"));
        assert!(build.contains("Do NOT call update_plan/emit CodexPlan"));
        assert!(build.contains("supersedes any earlier plan-mode"));
        assert!(build.contains("approved plan"));

        let yolo = codex_execution_mode_instruction(Some("yolo")).unwrap();
        assert!(yolo.contains("YOLO EXECUTION MODE"));
        assert!(yolo.contains("Start implementing immediately"));
        assert!(yolo.contains("Do NOT call update_plan/emit CodexPlan"));
        assert!(yolo.contains("Do not ask for confirmation"));
        assert!(yolo.contains("supersedes any earlier plan-mode"));
        assert!(yolo.contains("approved plan"));
    }

    #[test]
    fn test_codex_plan_mode_content_waits_for_approval_without_plan_tool() {
        assert!(plan_mode_content_waits_for_approval(
            &Backend::Codex,
            Some("plan"),
            true,
            false
        ));
    }

    #[test]
    fn test_plan_mode_content_waiting_does_not_override_existing_plan_tools_or_non_plan_modes() {
        assert!(!plan_mode_content_waits_for_approval(
            &Backend::Codex,
            Some("plan"),
            true,
            true
        ));
        assert!(!plan_mode_content_waits_for_approval(
            &Backend::Codex,
            Some("build"),
            true,
            false
        ));
        assert!(!plan_mode_content_waits_for_approval(
            &Backend::Claude,
            Some("plan"),
            true,
            false
        ));
        assert!(!plan_mode_content_waits_for_approval(
            &Backend::Cursor,
            Some("plan"),
            true,
            false
        ));
        assert!(!plan_mode_content_waits_for_approval(
            &Backend::Commandcode,
            Some("plan"),
            true,
            false
        ));
    }

    #[test]
    fn queued_prompt_skips_plan_wait_but_not_questions() {
        assert!(queued_prompt_skips_plan_wait(true, false, true));
        assert!(!queued_prompt_skips_plan_wait(false, false, true));
        assert!(!queued_prompt_skips_plan_wait(true, true, true));
        assert!(!queued_prompt_skips_plan_wait(true, false, false));
    }

    #[test]
    fn codex_steer_input_from_queued_message_preserves_attachments() {
        let queued = serde_json::json!({
            "message": "Please inspect",
            "pendingFiles": [{
                "relativePath": "src/main.rs",
                "sourceRootPath": "/repo",
                "isDirectory": false
            }],
            "pendingSkills": [{
                "name": "rust-async-patterns",
                "path": "/skills/rust-async-patterns/SKILL.md"
            }],
            "pendingImages": [{ "path": "/tmp/screenshot.png" }],
            "pendingTextFiles": [{
                "filename": "notes.txt",
                "path": "/tmp/notes.txt"
            }]
        });

        let input = codex_steer_input_from_queued_message(&queued).unwrap();

        assert_eq!(input[0]["type"], "text");
        assert_eq!(input[0]["text"], "Please inspect");
        assert_eq!(
            input[1],
            serde_json::json!({
                "type": "mention",
                "name": "main.rs",
                "path": "/repo/src/main.rs",
            })
        );
        assert_eq!(
            input[2],
            serde_json::json!({
                "type": "skill",
                "name": "rust-async-patterns",
                "path": "/skills/rust-async-patterns/SKILL.md",
            })
        );
        assert_eq!(
            input[3],
            serde_json::json!({
                "type": "localImage",
                "path": "/tmp/screenshot.png",
            })
        );
        assert_eq!(
            input[4],
            serde_json::json!({
                "type": "mention",
                "name": "notes.txt",
                "path": "/tmp/notes.txt",
            })
        );
    }

    #[test]
    fn test_build_queued_message_with_refs_matches_frontend_format() {
        let queued = serde_json::json!({
            "message": "Please inspect these",
            "pendingFiles": [{
                "relativePath": "src/main.rs",
                "sourceRootPath": "/repo",
                "isDirectory": false
            }, {
                "relativePath": "src-tauri",
                "sourceRootPath": "/repo",
                "isDirectory": true
            }],
            "pendingSkills": [{
                "path": "/skills/rust-async-patterns/SKILL.md"
            }],
            "pendingImages": [{
                "path": "/tmp/screenshot.png"
            }],
            "pendingTextFiles": [{
                "path": "/tmp/notes.txt"
            }]
        });

        let message = build_queued_message_with_refs(&queued).unwrap();

        assert!(message.contains("Please inspect these"));
        assert!(message.contains("[File: /repo/src/main.rs - Use the Read tool to view this file]"));
        assert!(message.contains(
            "[Directory: /repo/src-tauri - Use Glob and Read tools to explore this directory]"
        ));
        assert!(message.contains(
            "[Skill: /skills/rust-async-patterns/SKILL.md - Read and use this skill to guide your response]"
        ));
        assert!(message.contains(
            "[Image attached: /tmp/screenshot.png - Use the Read tool to view this image]"
        ));
        assert!(message.contains(
            "[Text file attached: /tmp/notes.txt - Use the Read tool to view this file]"
        ));
    }

    #[test]
    fn test_build_queued_message_with_image_only_default_prompt() {
        let queued = serde_json::json!({
            "message": "",
            "pendingImages": [{ "path": "/tmp/image.png" }]
        });

        assert_eq!(
            build_queued_message_with_refs(&queued).unwrap(),
            "Please check this image and tell me what is wrong.\n\n[Image attached: /tmp/image.png - Use the Read tool to view this image]"
        );
    }

    #[test]
    fn test_codex_goal_set_params_uses_app_server_schema() {
        let params = codex_goal_set_params("thread-123", "Ship the goal UI");

        assert_eq!(
            params,
            serde_json::json!({
                "threadId": "thread-123",
                "objective": "Ship the goal UI",
                "status": "active",
            })
        );
        assert!(params.get("goal").is_none());
    }

    #[test]
    fn test_extract_codex_goal_objective_reads_thread_goal_object() {
        let response = serde_json::json!({
            "goal": {
                "threadId": "thread-123",
                "objective": "Ship the goal UI",
                "status": "active",
                "createdAt": 1,
                "updatedAt": 2,
                "timeUsedSeconds": 3,
                "tokensUsed": 4
            }
        });

        assert_eq!(
            extract_codex_goal_objective(&response).as_deref(),
            Some("Ship the goal UI")
        );
    }

    #[test]
    fn test_extract_codex_goal_objective_handles_absent_goal() {
        assert_eq!(
            extract_codex_goal_objective(&serde_json::json!({ "goal": null })),
            None
        );
    }

    #[test]
    fn test_extract_text_from_stream_json_text_only() {
        let output =
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Hello world");
    }

    #[test]
    fn test_extract_text_from_stream_json_structured_output() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Processing..."},{"type":"tool_use","id":"toolu_123","name":"StructuredOutput","input":{"summary":"Test summary","slug":"test-slug"}}]}}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        let json = result.unwrap();
        // Structured output takes priority
        assert!(json.contains("summary"));
        assert!(json.contains("Test summary"));
    }

    #[test]
    fn test_extract_text_from_stream_json_multiline() {
        let output = r#"{"type":"system","data":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Line 1"}]}}
{"type":"result","result":"Final"}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        // Text from assistant message
        assert_eq!(result.unwrap(), "Line 1");
    }

    #[test]
    fn test_extract_text_from_stream_json_result_fallback() {
        let output = r#"{"type":"result","result":"Result text"}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Result text");
    }

    #[test]
    fn test_extract_text_from_stream_json_empty() {
        let result = extract_text_from_stream_json("");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No text content"));
    }

    #[test]
    fn test_extract_text_from_stream_json_no_content() {
        let output = r#"{"type":"system","data":"processing"}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_text_from_stream_json_skips_malformed() {
        let output = r#"not json
{"type":"assistant","message":{"content":[{"type":"text","text":"Valid"}]}}
also not json"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Valid");
    }

    #[test]
    fn test_extract_text_from_stream_json_concatenates_text() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "},{"type":"text","text":"World"}]}}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Hello World");
    }

    #[test]
    fn test_extract_text_from_stream_json_ignores_other_tools() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file":"/test.txt"}},{"type":"text","text":"After tool"}]}}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "After tool");
    }

    #[test]
    fn test_parse_mcp_list_output() {
        let output = "\
Checking MCP server health...

notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication
filesystem: /usr/bin/fs-server (STDIO) - connected
broken: http://localhost:9999 (HTTP) - ! Could not connect
my-disabled: /usr/bin/disabled (STDIO) - disabled";

        let statuses = parse_mcp_list_output(output);
        assert_eq!(statuses.len(), 4);
        assert_eq!(
            statuses.get("notion"),
            Some(&McpHealthStatus::NeedsAuthentication)
        );
        assert_eq!(
            statuses.get("filesystem"),
            Some(&McpHealthStatus::Connected)
        );
        assert_eq!(
            statuses.get("broken"),
            Some(&McpHealthStatus::CouldNotConnect)
        );
        assert_eq!(
            statuses.get("my-disabled"),
            Some(&McpHealthStatus::Disabled)
        );
    }

    #[test]
    fn test_parse_mcp_list_output_empty() {
        let output = "Checking MCP server health...\n\n";
        let statuses = parse_mcp_list_output(output);
        assert!(statuses.is_empty());
    }

    #[test]
    fn test_find_neighbor_non_archived_session_id_prefers_left() {
        let mut s1 = Session::new("Session 1".to_string(), 0, Backend::Claude);
        s1.id = "s1".to_string();
        let mut s2 = Session::new("Session 2".to_string(), 1, Backend::Claude);
        s2.id = "s2".to_string();
        let mut s3 = Session::new("Session 3".to_string(), 2, Backend::Claude);
        s3.id = "s3".to_string();
        let mut s4 = Session::new("Session 4".to_string(), 3, Backend::Claude);
        s4.id = "s4".to_string();

        // Simulate deleting s3 (index 2): remaining list is [s1, s2, s4], removed_index=2.
        let remaining = vec![s1, s2, s4];
        let selected = find_neighbor_non_archived_session_id(&remaining, 2);
        assert_eq!(selected.as_deref(), Some("s2"));
    }

    #[test]
    fn test_find_neighbor_non_archived_session_id_falls_back_right() {
        let mut s1 = Session::new("Session 1".to_string(), 0, Backend::Claude);
        s1.id = "s1".to_string();
        s1.archived_at = Some(1);
        let mut s2 = Session::new("Session 2".to_string(), 1, Backend::Claude);
        s2.id = "s2".to_string();
        s2.archived_at = Some(1);
        let mut s3 = Session::new("Session 3".to_string(), 2, Backend::Claude);
        s3.id = "s3".to_string();

        // Simulate deleting first session: remaining list is [s2(archived), s3], removed_index=0.
        let remaining = vec![s2, s3];
        let selected = find_neighbor_non_archived_session_id(&remaining, 0);
        assert_eq!(selected.as_deref(), Some("s3"));
    }

    #[test]
    fn native_terminal_resume_ids_are_saved_on_the_backend_specific_field() {
        let mut claude = Session::new("Claude".to_string(), 0, Backend::Claude);
        persist_salvaged_resume_id(&mut claude, &Backend::Claude, "claude-session");
        assert_eq!(claude.claude_session_id.as_deref(), Some("claude-session"));

        let mut codex = Session::new("Codex".to_string(), 0, Backend::Codex);
        persist_salvaged_resume_id(&mut codex, &Backend::Codex, "codex-thread");
        assert_eq!(codex.codex_thread_id.as_deref(), Some("codex-thread"));

        let mut opencode = Session::new("OpenCode".to_string(), 0, Backend::Opencode);
        persist_salvaged_resume_id(&mut opencode, &Backend::Opencode, "opencode-session");
        assert_eq!(
            opencode.opencode_session_id.as_deref(),
            Some("opencode-session")
        );
    }
}
