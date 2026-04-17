//! Codex CLI execution engine
//!
//! Uses `codex app-server` (a persistent JSON-RPC 2.0 server over stdio) for
//! all chat interactions. Threads and turns are managed via JSON-RPC requests;
//! streamed responses arrive as notifications and are mapped to Tauri events.
//!
//! One-shot operations (commit messages, PR content, etc.) still use `codex exec`
//! directly since they don't need streaming.

use super::claude::CancelledEvent;
use super::types::{
    CodexCommandAction, CodexCommandApprovalRequest, CodexCommandApprovalRequestEvent,
    CodexDynamicToolCallRequest, CodexDynamicToolCallRequestEvent, CodexNetworkApprovalContext,
    CodexNetworkPolicyAmendment, CodexPermissionRequest, CodexPermissionRequestEvent,
    CodexUserInputRequest, CodexUserInputRequestEvent, ContentBlock, ToolCall, UsageData,
};
use crate::http_server::EmitExt;

use std::collections::HashMap;

// =============================================================================
// Response type (same shape as ClaudeResponse)
// =============================================================================

/// Response from Codex CLI execution
pub struct CodexResponse {
    /// The text response content
    pub content: String,
    /// The thread ID (for resuming conversations)
    pub thread_id: String,
    /// Tool calls made during this response
    pub tool_calls: Vec<ToolCall>,
    /// Ordered content blocks preserving tool position in response
    pub content_blocks: Vec<ContentBlock>,
    /// Whether the response was cancelled by the user
    pub cancelled: bool,
    /// Whether a chat:error event was emitted during execution
    pub error_emitted: bool,
    /// Token usage for this response
    pub usage: Option<UsageData>,
}

// =============================================================================
// Event structs (reuse same Tauri event names as Claude for frontend compat)
// =============================================================================

#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String,
    content: String,
}

#[derive(serde::Serialize, Clone)]
struct ToolUseEvent {
    session_id: String,
    worktree_id: String,
    id: String,
    name: String,
    input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct ToolResultEvent {
    session_id: String,
    worktree_id: String,
    tool_use_id: String,
    output: String,
}

#[derive(serde::Serialize, Clone)]
struct ToolBlockEvent {
    session_id: String,
    worktree_id: String,
    tool_call_id: String,
}

#[derive(serde::Serialize, Clone)]
struct ThinkingEvent {
    session_id: String,
    worktree_id: String,
    content: String,
}

#[derive(serde::Serialize, Clone)]
struct DoneEvent {
    session_id: String,
    worktree_id: String,
    /// True when a plan-mode run completed with content (Codex/Opencode only)
    waiting_for_plan: bool,
}

#[derive(serde::Serialize, Clone)]
struct ErrorEvent {
    session_id: String,
    worktree_id: String,
    error: String,
}

const CODEX_PLAN_TOOL_NAME: &str = "CodexPlan";

fn normalize_plan_status(status: &str) -> &str {
    match status {
        "inProgress" => "in_progress",
        other => other,
    }
}

fn codex_plan_tool_id(turn_id: Option<&str>, item_id: Option<&str>) -> String {
    if let Some(turn_id) = turn_id.filter(|id| !id.is_empty()) {
        return format!("codex-plan-{turn_id}");
    }
    if let Some(item_id) = item_id.filter(|id| !id.is_empty()) {
        return format!("codex-plan-{item_id}");
    }
    "codex-plan".to_string()
}

fn push_unique_text(target: &mut String, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    if target.is_empty() {
        target.push_str(trimmed);
    } else if !target.contains(trimmed) {
        target.push_str(trimmed);
    }
}

fn extract_text_from_content_block(block: &serde_json::Value) -> Option<String> {
    let block_type = block.get("type").and_then(|v| v.as_str())?;
    match block_type {
        "text" | "output_text" => block
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned),
        _ => None,
    }
}

fn extract_agent_message_text(item: &serde_json::Value) -> Option<String> {
    let mut extracted = String::new();

    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
        push_unique_text(&mut extracted, text);
    }

    if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
        for block in content {
            if let Some(text) = extract_text_from_content_block(block) {
                push_unique_text(&mut extracted, &text);
            }
        }
    }

    if extracted.is_empty() {
        None
    } else {
        Some(extracted)
    }
}

fn extract_text_from_turn_output(value: &serde_json::Value) -> Option<String> {
    let mut extracted = String::new();

    match value {
        serde_json::Value::String(text) => push_unique_text(&mut extracted, text),
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(text) = extract_text_from_content_block(item) {
                    push_unique_text(&mut extracted, &text);
                }
            }
        }
        serde_json::Value::Object(_) => {
            if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
                push_unique_text(&mut extracted, text);
            }
            if let Some(content) = value.get("content").and_then(|v| v.as_array()) {
                for block in content {
                    if let Some(text) = extract_text_from_content_block(block) {
                        push_unique_text(&mut extracted, &text);
                    }
                }
            }
        }
        _ => {}
    }

    if extracted.is_empty() {
        None
    } else {
        Some(extracted)
    }
}

fn extract_plain_text_plan_sections(text: &str) -> Option<(Option<String>, String)> {
    let normalized = text.trim().replace("\r\n", "\n");
    if normalized.is_empty() {
        return None;
    }

    let plan_heading_match = normalized
        .match_indices("\nPlan:\n")
        .last()
        .map(|(idx, _)| idx);
    let plan_start = if normalized.starts_with("Plan:\n") {
        Some(0)
    } else {
        plan_heading_match.map(|idx| idx + 1)
    }?;

    let before_plan = normalized[..plan_start].trim();
    let plan = normalized[plan_start..].trim();
    let plan_body = plan.strip_prefix("Plan:").map(str::trim).unwrap_or("");

    let has_plan_body = !plan_body.is_empty();
    let looks_structured = plan_body.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("- ")
            || trimmed.starts_with("* ")
            || trimmed.chars().next().is_some_and(|c| c.is_ascii_digit())
    });

    if !has_plan_body || !looks_structured {
        return None;
    }

    Some((
        (!before_plan.is_empty()).then(|| before_plan.to_string()),
        plan.to_string(),
    ))
}

fn has_codex_plan_tool(tool_calls: &[ToolCall]) -> bool {
    tool_calls.iter().any(|tc| tc.name == CODEX_PLAN_TOOL_NAME)
}

fn ensure_plain_text_codex_plan_tool(
    tool_calls: &mut Vec<ToolCall>,
    content_blocks: &mut Vec<ContentBlock>,
    text: &str,
) -> bool {
    if has_codex_plan_tool(tool_calls) {
        return false;
    }

    let Some((before_plan, plan)) = extract_plain_text_plan_sections(text) else {
        return false;
    };

    let had_text_blocks = content_blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::Text { text } if !text.trim().is_empty()));

    if !had_text_blocks {
        if let Some(before_plan) = before_plan {
            content_blocks.push(ContentBlock::Text { text: before_plan });
        }
        content_blocks.push(ContentBlock::Text { text: plan.clone() });
    }

    let tool_id = codex_plan_tool_id(None, Some("plain-text-final-answer"));
    let input = merge_codex_plan_input(None, Some(plan), None, None, None);
    upsert_codex_plan_tool_call(tool_calls, content_blocks, &tool_id, input);
    true
}

fn normalize_collab_tool_name(collab_tool: &str) -> &str {
    match collab_tool {
        "spawnAgent" | "spawn_agent" => "SpawnAgent",
        "sendInput" | "send_input" => "SendInput",
        "resumeAgent" | "resume_agent" => "ResumeAgent",
        "wait" => "WaitForAgents",
        "closeAgent" | "close_agent" => "CloseAgent",
        _ => collab_tool,
    }
}

fn merge_codex_plan_input(
    existing: Option<&serde_json::Value>,
    plan_text: Option<String>,
    plan_preview: Option<String>,
    explanation: Option<String>,
    steps: Option<Vec<serde_json::Value>>,
) -> serde_json::Value {
    let mut input = existing.cloned().unwrap_or_else(|| serde_json::json!({}));
    let Some(obj) = input.as_object_mut() else {
        return serde_json::json!({});
    };

    obj.insert("source".to_string(), serde_json::json!("codex"));

    if let Some(explanation) = explanation {
        obj.insert("explanation".to_string(), serde_json::json!(explanation));
    }

    if let Some(steps) = steps {
        let normalized_steps: Vec<serde_json::Value> = steps
            .into_iter()
            .map(|step| {
                let step_text = step.get("step").and_then(|v| v.as_str()).unwrap_or("");
                let status = step
                    .get("status")
                    .and_then(|v| v.as_str())
                    .map(normalize_plan_status)
                    .unwrap_or("pending");
                serde_json::json!({
                    "step": step_text,
                    "status": status,
                })
            })
            .collect();
        obj.insert("steps".to_string(), serde_json::json!(normalized_steps));
    }

    if let Some(plan_text) = plan_text.filter(|s| !s.is_empty()) {
        obj.insert("plan".to_string(), serde_json::json!(plan_text));
        obj.remove("plan_preview");
    } else if let Some(plan_preview) = plan_preview.filter(|s| !s.is_empty()) {
        obj.insert("plan_preview".to_string(), serde_json::json!(plan_preview));
    }
    // Steps and explanation are stored separately — frontend reads them directly.
    // Don't format steps into the plan field; they belong in the TodoWidget sidebar.

    serde_json::Value::Object(obj.clone())
}

fn upsert_codex_plan_tool_call(
    tool_calls: &mut Vec<ToolCall>,
    content_blocks: &mut Vec<ContentBlock>,
    tool_id: &str,
    input: serde_json::Value,
) -> bool {
    if let Some(existing) = tool_calls.iter_mut().find(|tc| tc.id == tool_id) {
        existing.input = input;
        move_tool_block_to_end(content_blocks, tool_id);
        return false;
    }

    tool_calls.push(ToolCall {
        id: tool_id.to_string(),
        name: CODEX_PLAN_TOOL_NAME.to_string(),
        input,
        output: None,
        parent_tool_use_id: None,
    });
    content_blocks.push(ContentBlock::ToolUse {
        tool_call_id: tool_id.to_string(),
    });
    true
}

fn move_tool_block_to_end(content_blocks: &mut Vec<ContentBlock>, tool_id: &str) {
    content_blocks.retain(|block| {
        !matches!(
            block,
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == tool_id
        )
    });
    content_blocks.push(ContentBlock::ToolUse {
        tool_call_id: tool_id.to_string(),
    });
}

fn emit_codex_plan_tool_call(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    tool_id: &str,
    input: &serde_json::Value,
) {
    let _ = app.emit_all(
        "chat:tool_use",
        &ToolUseEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            id: tool_id.to_string(),
            name: CODEX_PLAN_TOOL_NAME.to_string(),
            input: input.clone(),
            parent_tool_use_id: None,
        },
    );

    let _ = app.emit_all(
        "chat:tool_block",
        &ToolBlockEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            tool_call_id: tool_id.to_string(),
        },
    );
}

// =============================================================================
// App-server param builders
// =============================================================================

/// Split "gpt-5.4-fast" → ("gpt-5.4", true). Only gpt-5.4-fast is recognised;
/// older models that happened to end in `-fast` are left unchanged.
fn split_fast_model(model: &str) -> (&str, bool) {
    match model {
        "gpt-5.4-fast" => ("gpt-5.4", true),
        "gpt-5.4-mini-fast" => ("gpt-5.4-mini", true),
        other => (other.strip_suffix("-fast").unwrap_or(other), false),
    }
}

/// Build JSON-RPC params for `thread/start`.
#[allow(clippy::too_many_arguments)]
pub fn build_thread_start_params(
    working_dir: &std::path::Path,
    model: Option<&str>,
    execution_mode: Option<&str>,
    search_enabled: bool,
    base_instructions_content: Option<&str>,
    multi_agent_enabled: bool,
    max_agent_threads: Option<u32>,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "cwd": working_dir.to_string_lossy(),
        "experimentalRawEvents": false,
        "persistExtendedHistory": true,
    });

    // Model (gpt-5.4-fast → model=gpt-5.4 + serviceTier=fast)
    if let Some(m) = model {
        let (actual_model, is_fast) = split_fast_model(m);
        log::info!(
            "Codex thread params: model={actual_model}, fast={is_fast}, mode={:?}",
            execution_mode
        );
        params["model"] = serde_json::json!(actual_model);
        if is_fast {
            params["serviceTier"] = serde_json::json!("fast");
        }
    }

    // Permission mode mapping
    //
    // Always use granular approval policy with mcp_elicitations=false to
    // auto-approve MCP elicitation requests (matching Claude Code's behavior).
    // Codex reads MCP config from TOML files directly, so we can't detect
    // whether MCP servers are configured — but setting mcp_elicitations=false
    // is a no-op when no MCP servers exist, so it's safe to always use it.
    match execution_mode.unwrap_or("plan") {
        "build" => {
            params["approvalPolicy"] = serde_json::json!({
                "granular": {
                    "mcp_elicitations": false,
                    "sandbox_approval": true,
                    "rules": true,
                    "request_permissions": true,
                }
            });
            params["sandbox"] = serde_json::json!("workspace-write");
        }
        "yolo" => {
            params["approvalPolicy"] = serde_json::json!("never");
            params["sandbox"] = serde_json::json!("danger-full-access");
        }
        // "plan" or default: read-only sandbox
        _ => {
            params["approvalPolicy"] = serde_json::json!({
                "granular": {
                    "mcp_elicitations": false,
                    "sandbox_approval": true,
                    "rules": true,
                    "request_permissions": true,
                }
            });
            params["sandbox"] = serde_json::json!("read-only");
        }
    }

    // Base instructions (system-level context: issues, PRs, custom prompts)
    if let Some(content) = base_instructions_content {
        if !content.is_empty() {
            params["baseInstructions"] = serde_json::json!(content);
        }
    }

    // Config overrides
    let mut config = serde_json::Map::new();

    // Web search
    config.insert(
        "web_search".to_string(),
        serde_json::json!(if search_enabled { "live" } else { "disabled" }),
    );

    // Multi-agent
    if multi_agent_enabled {
        let mut features = serde_json::Map::new();
        features.insert("multi_agent".to_string(), serde_json::json!(true));
        config.insert("features".to_string(), serde_json::Value::Object(features));
        if let Some(threads) = max_agent_threads {
            let mut agents = serde_json::Map::new();
            agents.insert("max_threads".to_string(), serde_json::json!(threads));
            config.insert("agents".to_string(), serde_json::Value::Object(agents));
        }
    }

    if !config.is_empty() {
        params["config"] = serde_json::Value::Object(config);
    }

    params
}

/// Build JSON-RPC params for `turn/start`.
pub fn build_turn_start_params(
    thread_id: &str,
    prompt: &str,
    working_dir: &std::path::Path,
    execution_mode: Option<&str>,
    reasoning_effort: Option<&str>,
    add_dirs: &[String],
    git_writable_roots: &[String],
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "threadId": thread_id,
        "input": [{
            "type": "text",
            "text": prompt,
            "text_elements": [],
        }],
    });

    // Reasoning effort (per-turn override)
    if let Some(effort) = reasoning_effort {
        params["effort"] = serde_json::json!(effort);
    }

    // Sandbox policy — grant read access to add_dirs (pasted files, contexts, etc.)
    // in ALL modes, and writable roots only in build/yolo modes.
    // Also include git metadata dirs so worktree commits work (issue #280).
    let mode = execution_mode.unwrap_or("plan");
    if !add_dirs.is_empty() || !git_writable_roots.is_empty() {
        let is_writable = mode == "build" || mode == "yolo";
        let writable_roots: Vec<serde_json::Value> = if is_writable {
            let mut roots = vec![serde_json::json!(working_dir.to_string_lossy())];
            for dir in add_dirs {
                roots.push(serde_json::json!(dir));
            }
            for dir in git_writable_roots {
                roots.push(serde_json::json!(dir));
            }
            roots
        } else {
            vec![]
        };
        params["sandboxPolicy"] = serde_json::json!({
            "type": if is_writable { "workspaceWrite" } else { "readOnly" },
            "writableRoots": writable_roots,
            "readOnlyAccess": { "type": "fullAccess" },
            "networkAccess": true,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false,
        });
    }

    // Override cwd per turn
    params["cwd"] = serde_json::json!(working_dir.to_string_lossy());

    log::debug!(
        "Codex turn params: thread={thread_id}, effort={reasoning_effort:?}, mode={execution_mode:?}"
    );

    params
}

// =============================================================================
// Execution via app-server
// =============================================================================

/// Execute a Codex chat message via the persistent app-server.
///
/// Handles thread creation/resume, turn execution, event mapping, and approvals.
/// Returns the same CodexResponse as the old exec path for compatibility.
#[allow(clippy::too_many_arguments)]
pub fn execute_codex_via_server(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    output_file: &std::path::Path,
    working_dir: &std::path::Path,
    existing_thread_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    reasoning_effort: Option<&str>,
    search_enabled: bool,
    add_dirs: &[String],
    prompt: &str,
    base_instructions_content: Option<&str>,
    multi_agent_enabled: bool,
    max_agent_threads: Option<u32>,
) -> Result<CodexResponse, String> {
    use super::codex_server;

    let is_plan_mode = execution_mode.unwrap_or("plan") == "plan";
    let is_build_mode = execution_mode.unwrap_or("plan") == "build";

    log::debug!(
        "Codex server turn: session={session_id}, model={model:?}, mode={execution_mode:?}, effort={reasoning_effort:?}, resume={}",
        existing_thread_id.is_some()
    );

    // Ensure the app-server is running
    codex_server::ensure_running(app)?;

    // Start or resume thread
    // Wrapped in a closure so we can decrement USAGE_COUNT on failure
    // (ensure_running incremented it, but no session is registered yet)
    let thread_id = match (|| -> Result<String, String> {
        if let Some(tid) = existing_thread_id {
            // Resume existing thread
            let resume_params = build_thread_start_params(
                working_dir,
                model,
                execution_mode,
                search_enabled,
                base_instructions_content,
                multi_agent_enabled,
                max_agent_threads,
            );
            let mut full_params =
                serde_json::json!({ "threadId": tid, "persistExtendedHistory": true });
            // Copy overridable fields
            for key in &[
                "model",
                "cwd",
                "approvalPolicy",
                "sandbox",
                "config",
                "serviceTier",
                "baseInstructions",
            ] {
                if let Some(v) = resume_params.get(key) {
                    full_params[key] = v.clone();
                }
            }
            match codex_server::send_request("thread/resume", full_params) {
                Ok(_) => Ok(tid.to_string()),
                Err(e) => {
                    log::warn!("Failed to resume thread {tid}: {e}, starting new thread");
                    start_new_thread(
                        working_dir,
                        model,
                        execution_mode,
                        search_enabled,
                        base_instructions_content,
                        multi_agent_enabled,
                        max_agent_threads,
                    )
                }
            }
        } else {
            start_new_thread(
                working_dir,
                model,
                execution_mode,
                search_enabled,
                base_instructions_content,
                multi_agent_enabled,
                max_agent_threads,
            )
        }
    })() {
        Ok(tid) => tid,
        Err(e) => {
            // ensure_running incremented USAGE_COUNT but no session was registered
            codex_server::decrement_usage_count();
            return Err(e);
        }
    };

    // Resolve git metadata dirs for worktree sandbox access (issue #280).
    // For worktrees, git needs write access to dirs outside the checkout path.
    let git_writable_roots: Vec<String> = crate::projects::git::resolve_git_dirs(working_dir)
        .map(|(git_dir, common_dir)| {
            let mut dirs = vec![git_dir.clone()];
            if common_dir != git_dir {
                dirs.push(common_dir);
            }
            dirs
        })
        .unwrap_or_default();

    // Persist codex_thread_id on the RunEntry so crash recovery can find it
    if let Ok(mut writer) = super::run_log::RunLogWriter::resume(app, session_id, run_id) {
        if let Err(e) = writer.set_codex_ids(&thread_id, None) {
            log::warn!("Failed to persist codex_thread_id on run: {e}");
        }
    }

    // Build turn params
    let turn_params = build_turn_start_params(
        &thread_id,
        prompt,
        working_dir,
        execution_mode,
        reasoning_effort,
        add_dirs,
        &git_writable_roots,
    );

    // Set up event channel for this session
    let (event_tx, event_rx) = std::sync::mpsc::channel();
    let ctx = codex_server::SessionContext {
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        event_tx,
    };
    codex_server::register_session(&thread_id, ctx);

    // Register turn for cancellation
    // We don't have the turn_id yet — register with empty, update after turn/started
    super::registry::register_codex_turn(session_id.to_string(), thread_id.clone(), String::new());

    // Start the turn
    let turn_response = codex_server::send_request("turn/start", turn_params);
    if let Err(e) = &turn_response {
        codex_server::unregister_session(&thread_id);
        super::registry::unregister_codex_turn(session_id);
        return Err(format!("Failed to start turn: {e}"));
    }

    // Process events until turn completes
    super::increment_tailer_count();
    let response = process_turn_events(
        app,
        session_id,
        worktree_id,
        run_id,
        &thread_id,
        output_file,
        is_plan_mode,
        is_build_mode,
        &event_rx,
    );
    super::decrement_tailer_count();

    // Cleanup
    codex_server::unregister_session(&thread_id);
    super::registry::unregister_codex_turn(session_id);

    // Clear turn_id from RunEntry (turn completed)
    if let Ok(mut writer) = super::run_log::RunLogWriter::resume(app, session_id, run_id) {
        if let Err(e) = writer.clear_codex_turn_id() {
            log::warn!("Failed to clear codex_turn_id after turn complete: {e}");
        }
    }

    // Set the thread_id on the response
    let mut resp = response;
    if resp.thread_id.is_empty() {
        resp.thread_id = thread_id;
    }

    Ok(resp)
}

/// Resume a Codex session after Jean crashed.
///
/// Spawns a new app-server (if needed), calls `thread/resume` to reconnect
/// to the persisted thread, then checks whether a turn was in-flight.
///
/// Returns `Ok(true)` if the run was successfully recovered (either by
/// re-entering the event loop for an active turn or by marking a completed
/// turn). Returns `Ok(false)` if the thread is gone/expired and the run
/// should be marked as Crashed.
pub fn resume_codex_after_crash(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    thread_id: &str,
    had_active_turn: bool,
) -> Result<bool, String> {
    use super::codex_server;
    use super::run_log::RunLogWriter;
    use super::storage::get_session_dir;

    log::info!(
        "Codex crash recovery: session={session_id}, thread={thread_id}, had_active_turn={had_active_turn}"
    );

    // 1. Ensure the app-server is running
    codex_server::ensure_running(app)?;

    // 2. Call thread/resume to reconnect to the persisted thread
    let resume_params = serde_json::json!({
        "threadId": thread_id,
        "persistExtendedHistory": true,
    });

    let resume_result = codex_server::send_request("thread/resume", resume_params);

    match resume_result {
        Err(e) => {
            // Thread gone/expired — cannot recover
            log::warn!("Codex crash recovery: thread/resume failed for {thread_id}: {e}");
            codex_server::decrement_usage_count();
            return Ok(false);
        }
        Ok(response) => {
            log::trace!("Codex crash recovery: thread/resume succeeded for {thread_id}");

            // Check thread status from response
            let thread_status = response
                .get("thread")
                .and_then(|t| t.get("status"))
                .and_then(|s| s.as_str())
                .unwrap_or("unknown");

            if had_active_turn && thread_status != "completed" {
                // Turn was in-flight when Jean crashed and thread is still active.
                // Register for events and enter the event loop to stream remaining output.
                let session_dir = get_session_dir(app, session_id)?;
                let output_file = session_dir.join(format!("{run_id}.jsonl"));

                let (event_tx, event_rx) = std::sync::mpsc::channel();
                let ctx = codex_server::SessionContext {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    event_tx,
                };
                codex_server::register_session(thread_id, ctx);
                super::registry::register_codex_turn(
                    session_id.to_string(),
                    thread_id.to_string(),
                    String::new(),
                );

                // Determine execution mode from run metadata (single load)
                let exec_mode = super::storage::load_metadata(app, session_id)?.and_then(|m| {
                    m.runs
                        .iter()
                        .find(|r| r.run_id == run_id)
                        .and_then(|r| r.execution_mode.clone())
                });
                let is_plan_mode = exec_mode.as_deref() == Some("plan");
                let is_build_mode = exec_mode.as_deref() == Some("build");

                super::increment_tailer_count();
                let response = process_turn_events(
                    app,
                    session_id,
                    worktree_id,
                    run_id,
                    thread_id,
                    &output_file,
                    is_plan_mode,
                    is_build_mode,
                    &event_rx,
                );
                super::decrement_tailer_count();

                codex_server::unregister_session(thread_id);
                super::registry::unregister_codex_turn(session_id);

                // Clear turn_id from RunEntry
                if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                    if let Err(e) = writer.clear_codex_turn_id() {
                        log::warn!("Failed to clear codex_turn_id after crash recovery: {e}");
                    }
                }

                // Complete the run
                if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                    let assistant_message_id = uuid::Uuid::new_v4().to_string();
                    if let Err(e) = writer.complete(&assistant_message_id, None, response.usage) {
                        log::error!("Failed to complete run after crash recovery: {e}");
                    }
                }

                return Ok(true);
            }

            // Thread is idle — turn completed while Jean was down, or no turn was active.
            // The JSONL file may already have the result from before the crash.
            // Mark the run as completed (the JSONL output is the source of truth).
            codex_server::decrement_usage_count();

            // Check if the JSONL file has a result line (turn completed before crash)
            let has_result = super::run_log::jsonl_has_result_line(app, session_id, run_id);

            if has_result {
                log::trace!("Codex crash recovery: run {run_id} already has result in JSONL");
                // Run completed before the crash — mark as completed
                if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                    let assistant_message_id = uuid::Uuid::new_v4().to_string();
                    if let Err(e) = writer.complete(&assistant_message_id, None, None) {
                        log::error!("Failed to complete run during crash recovery: {e}");
                    }
                }
                return Ok(true);
            }

            // No result in JSONL — turn may have completed on the server side
            // but events weren't written. Mark as completed with empty content.
            log::trace!("Codex crash recovery: thread idle, marking run {run_id} as completed");
            if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                let assistant_message_id = uuid::Uuid::new_v4().to_string();
                if let Err(e) = writer.complete(&assistant_message_id, None, None) {
                    log::error!("Failed to complete run during crash recovery: {e}");
                }
            }
            return Ok(true);
        }
    }
}

/// Start a new Codex thread via app-server.
fn start_new_thread(
    working_dir: &std::path::Path,
    model: Option<&str>,
    execution_mode: Option<&str>,
    search_enabled: bool,
    base_instructions_content: Option<&str>,
    multi_agent_enabled: bool,
    max_agent_threads: Option<u32>,
) -> Result<String, String> {
    use super::codex_server;

    let params = build_thread_start_params(
        working_dir,
        model,
        execution_mode,
        search_enabled,
        base_instructions_content,
        multi_agent_enabled,
        max_agent_threads,
    );

    let result = codex_server::send_request("thread/start", params)?;
    let thread_id = result
        .get("thread")
        .and_then(|t| t.get("id"))
        .and_then(|v| v.as_str())
        .ok_or("thread/start response missing thread.id")?
        .to_string();

    log::info!("Started new Codex thread: {thread_id}");
    Ok(thread_id)
}

/// Process turn events from the app-server, emitting Tauri events.
#[allow(clippy::too_many_arguments)]
fn process_turn_events(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    thread_id: &str,
    output_file: &std::path::Path,
    is_plan_mode: bool,
    is_build_mode: bool,
    event_rx: &std::sync::mpsc::Receiver<super::codex_server::ServerEvent>,
) -> CodexResponse {
    use super::codex_server::ServerEvent;
    use std::io::Write;
    let mut full_content = String::new();
    let mut response_thread_id = thread_id.to_string();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    let mut pending_tool_ids: HashMap<String, String> = HashMap::new();
    let mut completed = false;
    let mut cancelled = false;
    let mut server_interrupted = false;
    let mut error_emitted = false;
    let mut usage: Option<UsageData> = None;
    let mut received_completed_agent_message = false;

    // Open output file for history
    let mut output_writer = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output_file)
        .ok();

    'outer: loop {
        let event = match event_rx.recv() {
            Ok(e) => e,
            Err(_) => {
                log::warn!("Event channel disconnected for session {session_id}");
                cancelled = true;
                break 'outer;
            }
        };

        match event {
            ServerEvent::Notification { method, params } => {
                // Write to output file for history replay
                if let Some(ref mut writer) = output_writer {
                    // Convert to old-format JSONL for backward-compatible history
                    if let Some(line) = notification_to_history_line(&method, &params) {
                        let _ = writeln!(writer, "{line}");
                    }
                }

                process_server_notification(
                    app,
                    session_id,
                    worktree_id,
                    &method,
                    &params,
                    &mut full_content,
                    &mut response_thread_id,
                    &mut tool_calls,
                    &mut content_blocks,
                    &mut pending_tool_ids,
                    &mut completed,
                    &mut cancelled,
                    &mut server_interrupted,
                    &mut usage,
                    &mut error_emitted,
                    &mut received_completed_agent_message,
                    is_plan_mode,
                );

                // Update turn_id for cancellation + crash recovery
                if method == "turn/started" {
                    if let Some(turn_id) = params
                        .get("turn")
                        .and_then(|t| t.get("id"))
                        .and_then(|v| v.as_str())
                    {
                        super::registry::register_codex_turn(
                            session_id.to_string(),
                            thread_id.to_string(),
                            turn_id.to_string(),
                        );
                        // Persist turn_id so crash recovery knows a turn was in-flight
                        if let Ok(mut writer) =
                            super::run_log::RunLogWriter::resume(app, session_id, run_id)
                        {
                            if let Err(e) = writer.set_codex_ids(thread_id, Some(turn_id)) {
                                log::warn!("Failed to persist codex_turn_id on run: {e}");
                            }
                        }
                    }
                }
            }
            ServerEvent::ServerRequest { id, method, params } => {
                // Write to output file
                if let Some(ref mut writer) = output_writer {
                    let line = serde_json::json!({
                        "method": method,
                        "id": id,
                        "params": params,
                    });
                    let _ = writeln!(
                        writer,
                        "{}",
                        serde_json::to_string(&line).unwrap_or_default()
                    );
                }

                handle_approval_request(
                    app,
                    session_id,
                    worktree_id,
                    id,
                    &method,
                    &params,
                    is_build_mode,
                    is_plan_mode,
                );
            }
            ServerEvent::ServerDied => {
                log::error!("Codex app-server died during turn for session {session_id}");
                if !error_emitted {
                    let _ = app.emit_all(
                        "chat:error",
                        &ErrorEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            error: "Codex server connection lost. Try sending your message again."
                                .to_string(),
                        },
                    );
                    error_emitted = true;
                }
                cancelled = true;
                break 'outer;
            }
        }

        if completed {
            break 'outer;
        }
    }

    // Write accumulated text to JSONL for cancelled/interrupted runs only when
    // Codex never emitted a completed agent_message item. If one was already
    // written to history, appending another synthetic completion duplicates the
    // final assistant text on reload and after query invalidation.
    if (cancelled || error_emitted) && !full_content.is_empty() && !received_completed_agent_message
    {
        if let Some(ref mut writer) = output_writer {
            let synthetic = serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": full_content,
                }
            });
            let _ = writeln!(
                writer,
                "{}",
                serde_json::to_string(&synthetic).unwrap_or_default()
            );
        }
    }

    let has_executed_tools = tool_calls.iter().any(|tc| tc.name != CODEX_PLAN_TOOL_NAME);
    let detected_plain_text_plan =
        if !cancelled && !error_emitted && is_plan_mode && !has_executed_tools {
            ensure_plain_text_codex_plan_tool(&mut tool_calls, &mut content_blocks, &full_content)
        } else {
            false
        };

    // Fallback: if we're in plan mode with a CodexPlan tool that has steps but
    // no plan text, inject full_content so the investigation summary renders
    // inside PlanDisplay instead of as unformatted text.
    // Also remove duplicate text blocks whose content matches the plan text.
    if !cancelled && !error_emitted && is_plan_mode && !full_content.is_empty() {
        if let Some(tc) = tool_calls.iter().find(|tc| tc.name == CODEX_PLAN_TOOL_NAME) {
            let has_plan = tc
                .input
                .get("plan")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty());
            if !has_plan {
                let tool_id = tc.id.clone();
                let input = merge_codex_plan_input(
                    Some(&tc.input),
                    Some(full_content.clone()),
                    None,
                    None,
                    None,
                );
                upsert_codex_plan_tool_call(&mut tool_calls, &mut content_blocks, &tool_id, input);
                // Remove text blocks that duplicate the plan content
                content_blocks.retain(|block| {
                    !matches!(block, ContentBlock::Text { text } if text.trim() == full_content.trim())
                });
            }
        }
    }

    // Emit chat:done unless error was emitted
    if !cancelled && !error_emitted {
        let has_plan_tool = has_codex_plan_tool(&tool_calls);

        // Write result marker for crash-recovery compatibility
        // (jsonl_has_result_line() in run_log.rs checks for this)
        if let Some(ref mut writer) = output_writer {
            let _ = writeln!(writer, r#"{{"type":"result"}}"#);
        }

        let _ = app.emit_all(
            "chat:done",
            &DoneEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                waiting_for_plan: is_plan_mode && (has_plan_tool || detected_plain_text_plan),
            },
        );
    } else if server_interrupted && !error_emitted {
        // Server-initiated interruption (e.g., Codex ended the turn while an
        // approval request was still pending). User-initiated cancellation is
        // handled by registry::cancel_process() which emits chat:cancelled
        // before the event loop sees turn/completed. Emitting a duplicate is
        // safe — cancelSession() in the store is idempotent.
        use std::time::{SystemTime, UNIX_EPOCH};
        let emitted_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let _ = app.emit_all(
            "chat:cancelled",
            &CancelledEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                undo_send: false,
                emitted_at_ms,
            },
        );
    }

    CodexResponse {
        content: full_content,
        thread_id: response_thread_id,
        tool_calls,
        content_blocks,
        cancelled,
        error_emitted,
        usage,
    }
}

/// Convert a server notification to old-format JSONL line for history compatibility.
fn notification_to_history_line(method: &str, params: &serde_json::Value) -> Option<String> {
    // Map app-server notification methods to old exec JSONL format
    let event_type = match method {
        "thread/started" => {
            let tid = params
                .get("thread")
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())?;
            let line = serde_json::json!({
                "type": "thread.started",
                "thread_id": tid,
            });
            return Some(serde_json::to_string(&line).ok()?);
        }
        "turn/started" => "turn.started",
        "turn/completed" => {
            // Map turn completion with usage data
            let turn = params.get("turn")?;
            let status = turn
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            if status == "failed" {
                let error = turn
                    .get("error")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let line = serde_json::json!({
                    "type": "turn.failed",
                    "error": error,
                });
                return Some(serde_json::to_string(&line).ok()?);
            }
            let line = serde_json::json!({ "type": "turn.completed" });
            return Some(serde_json::to_string(&line).ok()?);
        }
        "turn/plan/updated" => {
            let turn_id = params.get("turnId").and_then(|v| v.as_str());
            let explanation = params.get("explanation").cloned();
            let plan = params.get("plan").cloned().unwrap_or(serde_json::json!([]));
            let line = serde_json::json!({
                "type": "turn.plan_updated",
                "turn_id": turn_id,
                "explanation": explanation,
                "plan": plan,
            });
            return Some(serde_json::to_string(&line).ok()?);
        }
        "item/started" => {
            let item = params.get("item")?;
            let normalized = normalize_item_types(item);
            let line = serde_json::json!({ "type": "item.started", "item": normalized });
            return Some(serde_json::to_string(&line).ok()?);
        }
        "item/completed" => {
            let item = params.get("item")?;
            let normalized = normalize_item_types(item);
            let line = serde_json::json!({ "type": "item.completed", "item": normalized });
            return Some(serde_json::to_string(&line).ok()?);
        }
        "item/agentMessage/delta" => {
            // Delta events don't have a direct old-format equivalent; skip for history
            return None;
        }
        "item/plan/delta" => {
            let line = serde_json::json!({
                "type": "item.plan.delta",
                "item_id": params.get("itemId").cloned().unwrap_or(serde_json::Value::Null),
                "turn_id": params.get("turnId").cloned().unwrap_or(serde_json::Value::Null),
                "delta": params.get("delta").cloned().unwrap_or(serde_json::json!("")),
            });
            return Some(serde_json::to_string(&line).ok()?);
        }
        _ => return None,
    };

    let line = serde_json::json!({ "type": event_type });
    Some(serde_json::to_string(&line).ok()?)
}

/// Process a server notification, emitting Tauri events.
///
/// Maps app-server v2 notification methods to the same Tauri events
/// used by the old exec JSONL path.
#[allow(clippy::too_many_arguments)]
fn process_server_notification(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    method: &str,
    params: &serde_json::Value,
    full_content: &mut String,
    thread_id: &mut String,
    tool_calls: &mut Vec<ToolCall>,
    content_blocks: &mut Vec<ContentBlock>,
    pending_tool_ids: &mut HashMap<String, String>,
    completed: &mut bool,
    cancelled: &mut bool,
    server_interrupted: &mut bool,
    usage: &mut Option<UsageData>,
    error_emitted: &mut bool,
    received_completed_agent_message: &mut bool,
    is_plan_mode: bool,
) {
    log::trace!("[codex-server] Notification: {method} for session {session_id}");

    match method {
        "thread/started" => {
            if let Some(tid) = params
                .get("thread")
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())
            {
                *thread_id = tid.to_string();
                log::trace!("Codex thread started: {tid}");
            }
        }
        "item/agentMessage/delta" => {
            // Streaming text delta — emit immediately
            if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                if !delta.is_empty() {
                    log::debug!(
                        "[codex-text] delta {}B for session {session_id}",
                        delta.len()
                    );
                    full_content.push_str(delta);
                    let _ = app.emit_all(
                        "chat:chunk",
                        &ChunkEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            content: delta.to_string(),
                        },
                    );
                }
            }
        }
        "turn/plan/updated" => {
            if !is_plan_mode {
                return;
            }

            let turn_id = params.get("turnId").and_then(|v| v.as_str());
            let tool_id = codex_plan_tool_id(turn_id, None);
            let explanation = params
                .get("explanation")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let steps = params.get("plan").and_then(|v| v.as_array()).cloned();
            let existing = tool_calls
                .iter()
                .find(|tc| tc.id == tool_id)
                .map(|tc| &tc.input);
            // Don't format steps as plan_text — steps belong in TodoWidget, not PlanDisplay
            let input = merge_codex_plan_input(existing, None, None, explanation, steps);
            upsert_codex_plan_tool_call(tool_calls, content_blocks, &tool_id, input.clone());
            emit_codex_plan_tool_call(app, session_id, worktree_id, &tool_id, &input);
        }
        "item/plan/delta" => {
            if !is_plan_mode {
                return;
            }

            let turn_id = params.get("turnId").and_then(|v| v.as_str());
            let item_id = params.get("itemId").and_then(|v| v.as_str());
            let tool_id = codex_plan_tool_id(turn_id, item_id);
            let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            let existing = tool_calls
                .iter()
                .find(|tc| tc.id == tool_id)
                .map(|tc| &tc.input);
            // Read from plan_preview first (where deltas accumulate), then plan
            let existing_plan = existing
                .and_then(|input| input.get("plan_preview").or_else(|| input.get("plan")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let input = merge_codex_plan_input(
                existing,
                None,
                Some(format!("{existing_plan}{delta}")),
                None,
                None,
            );
            upsert_codex_plan_tool_call(tool_calls, content_blocks, &tool_id, input.clone());
            emit_codex_plan_tool_call(app, session_id, worktree_id, &tool_id, &input);
        }
        "item/started" => {
            let item = params.get("item").unwrap_or(&serde_json::Value::Null);
            // Map camelCase item types to our event processing
            // App-server uses camelCase: commandExecution, fileChange, mcpToolCall, etc.
            let event_item = normalize_item_types(item);
            if event_item.get("type").and_then(|v| v.as_str()) == Some("plan") {
                if !is_plan_mode {
                    return;
                }

                let turn_id = params.get("turnId").and_then(|v| v.as_str());
                let item_id = event_item.get("id").and_then(|v| v.as_str());
                let tool_id = codex_plan_tool_id(turn_id, item_id);
                let existing = tool_calls
                    .iter()
                    .find(|tc| tc.id == tool_id)
                    .map(|tc| &tc.input);
                let plan_text = event_item
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let input = merge_codex_plan_input(existing, plan_text, None, None, None);
                upsert_codex_plan_tool_call(tool_calls, content_blocks, &tool_id, input.clone());
                emit_codex_plan_tool_call(app, session_id, worktree_id, &tool_id, &input);
                return;
            }
            let event_type = "item.started";
            let event_msg = serde_json::json!({ "type": event_type, "item": event_item });
            process_codex_event(
                app,
                session_id,
                worktree_id,
                &event_msg,
                event_type,
                full_content,
                thread_id,
                tool_calls,
                content_blocks,
                pending_tool_ids,
                completed,
                usage,
                error_emitted,
            );
        }
        "item/completed" => {
            let item = params.get("item").unwrap_or(&serde_json::Value::Null);
            let event_item = normalize_item_types(item);
            if event_item.get("type").and_then(|v| v.as_str()) == Some("plan") {
                if !is_plan_mode {
                    return;
                }

                let turn_id = params.get("turnId").and_then(|v| v.as_str());
                let item_id = event_item.get("id").and_then(|v| v.as_str());
                let tool_id = codex_plan_tool_id(turn_id, item_id);
                let existing = tool_calls
                    .iter()
                    .find(|tc| tc.id == tool_id)
                    .map(|tc| &tc.input);
                // Use item text, or promote accumulated plan_preview to plan on completion
                let plan_text = event_item
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        existing
                            .and_then(|input| input.get("plan_preview"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });
                let input = merge_codex_plan_input(existing, plan_text, None, None, None);
                upsert_codex_plan_tool_call(tool_calls, content_blocks, &tool_id, input.clone());
                emit_codex_plan_tool_call(app, session_id, worktree_id, &tool_id, &input);
                return;
            }
            if event_item.get("type").and_then(|v| v.as_str()) == Some("agent_message") {
                *received_completed_agent_message = true;

                // In plan mode, merge final_answer text into the CodexPlan tool
                // so it renders inside PlanDisplay instead of as plain text.
                // Skip process_codex_event to avoid creating a duplicate ContentBlock::Text.
                let is_final_answer =
                    event_item.get("phase").and_then(|v| v.as_str()) == Some("final_answer");
                if is_plan_mode && is_final_answer {
                    let answer_text = extract_agent_message_text(&event_item);
                    if let Some(text) = answer_text.filter(|t| !t.is_empty()) {
                        if let Some(existing_plan_tc) =
                            tool_calls.iter().find(|tc| tc.name == CODEX_PLAN_TOOL_NAME)
                        {
                            let tool_id = existing_plan_tc.id.clone();
                            let existing_input = Some(&existing_plan_tc.input);
                            let input = merge_codex_plan_input(
                                existing_input,
                                Some(text.clone()),
                                None,
                                None,
                                None,
                            );
                            upsert_codex_plan_tool_call(
                                tool_calls,
                                content_blocks,
                                &tool_id,
                                input.clone(),
                            );
                            emit_codex_plan_tool_call(
                                app,
                                session_id,
                                worktree_id,
                                &tool_id,
                                &input,
                            );
                            // Still accumulate into full_content for the final response
                            if !full_content.contains(&text) {
                                full_content.push_str(&text);
                            }
                            return;
                        }
                    }
                }
            }
            let event_type = "item.completed";
            let event_msg = serde_json::json!({ "type": event_type, "item": event_item });
            process_codex_event(
                app,
                session_id,
                worktree_id,
                &event_msg,
                event_type,
                full_content,
                thread_id,
                tool_calls,
                content_blocks,
                pending_tool_ids,
                completed,
                usage,
                error_emitted,
            );
        }
        "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
            // Streaming tool output — we could stream this but for now
            // we let item/completed handle it with the final aggregated output
        }
        "turn/completed" => {
            // Extract usage from the turn object
            if let Some(turn) = params.get("turn") {
                let status = turn
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("completed");
                if status == "failed" {
                    let error_msg = turn
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown Codex error");
                    let user_error = format_codex_user_error(error_msg);
                    let _ = app.emit_all(
                        "chat:error",
                        &ErrorEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            error: user_error,
                        },
                    );
                    *error_emitted = true;
                } else if status == "interrupted" {
                    // Turn was interrupted — either by user cancel (registry already
                    // emitted chat:cancelled) or by server (e.g., pending approval
                    // timeout). We flag both so the post-loop code can emit a
                    // fallback chat:cancelled for the server-initiated case.
                    log::trace!("Turn interrupted for session {session_id}");
                    *cancelled = true;
                    *server_interrupted = true;
                }
            }
            *completed = true;
            log::trace!("Codex turn completed for session: {session_id}");
        }
        "thread/tokenUsage/updated" => {
            // Extract usage data
            if let Some(token_usage) = params.get("tokenUsage") {
                *usage = Some(UsageData {
                    input_tokens: token_usage
                        .get("inputTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    output_tokens: token_usage
                        .get("outputTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_read_input_tokens: token_usage
                        .get("cachedInputTokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_creation_input_tokens: 0,
                });
            }
        }
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            // Streaming reasoning/thinking text
            if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                if !delta.is_empty() {
                    let _ = app.emit_all(
                        "chat:thinking",
                        &ThinkingEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            content: delta.to_string(),
                        },
                    );
                }
            }
        }
        "error" => {
            let error_msg = params
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown Codex error");
            let user_error = format_codex_user_error(error_msg);
            let _ = app.emit_all(
                "chat:error",
                &ErrorEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    error: user_error,
                },
            );
            *error_emitted = true;
            let will_retry = params
                .get("willRetry")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !will_retry {
                *completed = true;
            }
        }
        _ => {
            log::debug!("[codex-notify] Unhandled notification: {method}");
        }
    }
}

/// Normalize app-server camelCase item types to snake_case for backward compatibility
/// with the existing process_codex_event function.
fn normalize_item_types(item: &serde_json::Value) -> serde_json::Value {
    let mut item = item.clone();
    if let Some(obj) = item.as_object_mut() {
        if let Some(item_type) = obj.get("type").and_then(|v| v.as_str()) {
            let normalized = match item_type {
                "commandExecution" => "command_execution",
                "fileChange" => "file_change",
                "mcpToolCall" => "mcp_tool_call",
                "agentMessage" => "agent_message",
                "collabAgentToolCall" => "collab_tool_call",
                "todoList" => "todo_list",
                "webSearch" => "web_search",
                "imageGeneration" => "image_generation",
                "imageView" => "image_view",
                "contextCompaction" => "context_compaction",
                "userMessage" => "user_message",
                "dynamicToolCall" => "dynamic_tool_call",
                "hookPrompt" => "hook_prompt",
                "enteredReviewMode" => "entered_review_mode",
                "exitedReviewMode" => "exited_review_mode",
                other => other,
            };
            obj.insert("type".to_string(), serde_json::json!(normalized));
        }
        // Also normalize nested field names for command_execution
        if let Some(output) = obj.remove("aggregatedOutput") {
            obj.insert("aggregated_output".to_string(), output);
        }
        if let Some(states) = obj.remove("agentsStates") {
            obj.insert("agents_states".to_string(), states);
        }
    }
    item
}

/// Handle an approval request from the app-server.
fn handle_approval_request(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    rpc_id: u64,
    method: &str,
    params: &serde_json::Value,
    _is_build_mode: bool,
    is_plan_mode: bool,
) {
    let emit_connection_error = || {
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: "Lost connection to Codex server".to_string(),
            },
        );
    };

    match method {
        "item/fileChange/requestApproval" => {
            if is_plan_mode {
                // Deny file changes in plan mode — sandbox alone is not reliable
                log::trace!("Denying file change in plan mode (rpc_id={rpc_id})");
                if let Err(e) = super::codex_server::send_response(
                    rpc_id,
                    serde_json::json!({"decision": "decline"}),
                ) {
                    log::error!("Failed to deny file change in plan mode (rpc_id={rpc_id}): {e}");
                    emit_connection_error();
                }
            } else {
                // Auto-accept in build/yolo modes
                log::trace!("Auto-accepting file change (rpc_id={rpc_id})");
                if let Err(e) = super::codex_server::send_response(
                    rpc_id,
                    serde_json::json!({"decision": "accept"}),
                ) {
                    log::error!("Failed to auto-accept file change (rpc_id={rpc_id}): {e}");
                    emit_connection_error();
                }
            }
        }
        "item/commandExecution/requestApproval" => {
            let command = params
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let item_id = params
                .get("itemId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Auto-approve embedded/resolved CLI binaries (matches Claude's --allowedTools)
            let gh_binary = crate::gh_cli::config::resolve_gh_binary(app);
            let gh_str = gh_binary.to_string_lossy();
            if command.contains(&*gh_str)
                || command.contains("gh-cli/gh")
                || command.contains("claude-cli/claude")
            {
                log::trace!("Auto-accepting CLI command (rpc_id={rpc_id}): {command}");
                if let Err(e) = super::codex_server::send_response(
                    rpc_id,
                    serde_json::json!({"decision": "accept"}),
                ) {
                    log::error!("Failed to auto-accept CLI command (rpc_id={rpc_id}): {e}");
                    emit_connection_error();
                }
                return;
            }

            log::trace!("Command approval requested (rpc_id={rpc_id}): {command}");

            let request = CodexCommandApprovalRequest {
                rpc_id,
                item_id,
                thread_id: params
                    .get("threadId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                turn_id: params
                    .get("turnId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                approval_id: params
                    .get("approvalId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                command: params
                    .get("command")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                command_actions: params.get("commandActions").and_then(|value| {
                    serde_json::from_value::<Vec<CodexCommandAction>>(value.clone()).ok()
                }),
                cwd: params
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                reason: params
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                network_approval_context: params.get("networkApprovalContext").and_then(|value| {
                    serde_json::from_value::<CodexNetworkApprovalContext>(value.clone()).ok()
                }),
                proposed_execpolicy_amendment: params
                    .get("proposedExecpolicyAmendment")
                    .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok()),
                proposed_network_policy_amendments: params
                    .get("proposedNetworkPolicyAmendments")
                    .and_then(|value| {
                        serde_json::from_value::<Vec<CodexNetworkPolicyAmendment>>(value.clone())
                            .ok()
                    }),
            };
            let _ = app.emit_all(
                "chat:codex_command_approval_request",
                &CodexCommandApprovalRequestEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    request,
                },
            );
        }
        "item/permissions/requestApproval" => {
            let request = CodexPermissionRequest {
                rpc_id,
                item_id: params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                permissions: params
                    .get("permissions")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                reason: params
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            };
            let _ = app.emit_all(
                "chat:codex_permission_request",
                &CodexPermissionRequestEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    request,
                },
            );
        }
        "item/tool/requestUserInput" => {
            let request = CodexUserInputRequest {
                rpc_id,
                item_id: params
                    .get("itemId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                questions: params
                    .get("questions")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([])),
                thread_id: params
                    .get("threadId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                turn_id: params
                    .get("turnId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            };
            let _ = app.emit_all(
                "chat:codex_user_input_request",
                &CodexUserInputRequestEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    request,
                },
            );
        }
        "mcpServer/elicitation/request" => {
            // Auto-accept MCP elicitations — we always set mcp_elicitations=false
            // in the approval policy, but the server may still send these.
            let server_name = params
                .get("serverName")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            log::trace!("Auto-accepting MCP elicitation from '{server_name}' (rpc_id={rpc_id})");
            if let Err(e) =
                super::codex_server::send_response(rpc_id, serde_json::json!({"action": "accept"}))
            {
                log::error!("Failed to auto-accept MCP elicitation (rpc_id={rpc_id}): {e}");
                emit_connection_error();
            }
        }
        "item/tool/call" => {
            let request = CodexDynamicToolCallRequest {
                rpc_id,
                call_id: params
                    .get("callId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                tool: params
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                arguments: params
                    .get("arguments")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            };
            let _ = app.emit_all(
                "chat:codex_dynamic_tool_call_request",
                &CodexDynamicToolCallRequestEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    request,
                },
            );
        }
        _ => {
            let error = format!("Unsupported Codex server request: {method}. Please update Jean.");
            log::error!("{error}");
            let _ = app.emit_all(
                "chat:error",
                &ErrorEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    error: error.clone(),
                },
            );
            if let Err(e) = super::codex_server::send_error_response(rpc_id, -32601, &error) {
                log::error!("Failed to reject unknown approval request (rpc_id={rpc_id}): {e}");
                emit_connection_error();
            }
        }
    }
}

/// Extract an error message from a Codex JSON value, handling both formats:
/// - String format: `{"error": "message"}`
/// - Object format: `{"error": {"message": "..."}}`
fn extract_codex_error_message(msg: &serde_json::Value) -> Option<String> {
    let error = msg.get("error")?;
    // Try string format first
    if let Some(s) = error.as_str() {
        return Some(s.to_string());
    }
    // Try object format: {"error": {"message": "..."}}
    if let Some(s) = error.get("message").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    // Error field exists but in unknown format — stringify it
    Some(error.to_string())
}

/// Format a raw Codex error message into a user-friendly string.
/// Handles auth/session errors with specific guidance.
fn format_codex_user_error(error_msg: &str) -> String {
    if error_msg.contains("refresh_token_invalidated")
        || error_msg.contains("refresh token has been invalidated")
    {
        "Your Codex login session has expired. Please sign in again in Settings > General."
            .to_string()
    } else if error_msg.contains("401 Unauthorized")
        || error_msg.contains("invalidated oauth token")
    {
        "Codex authentication failed. Please sign in again in Settings > General.".to_string()
    } else {
        format!("Codex error: {error_msg}")
    }
}

/// Process a single Codex JSONL event. Shared between attached and detached tailers.
#[allow(clippy::too_many_arguments)]
fn process_codex_event(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    msg: &serde_json::Value,
    event_type: &str,
    full_content: &mut String,
    thread_id: &mut String,
    tool_calls: &mut Vec<ToolCall>,
    content_blocks: &mut Vec<ContentBlock>,
    pending_tool_ids: &mut HashMap<String, String>,
    completed: &mut bool,
    usage: &mut Option<UsageData>,
    error_emitted: &mut bool,
) {
    match event_type {
        "thread.started" => {
            if let Some(tid) = msg.get("thread_id").and_then(|v| v.as_str()) {
                *thread_id = tid.to_string();
                log::trace!("Codex thread started: {tid}");
            }
        }
        "item.started" => {
            let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            log::debug!("[codex-event] item.started type={item_type} id={item_id}");

            match item_type {
                "command_execution" => {
                    let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: "Bash".to_string(),
                        input: serde_json::json!({ "command": command }),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: "Bash".to_string(),
                            input: serde_json::json!({ "command": command }),
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "file_change" => {
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let changes = item
                        .get("changes")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: "FileChange".to_string(),
                        input: changes.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: "FileChange".to_string(),
                            input: changes,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "mcp_tool_call" => {
                    let server = item
                        .get("server")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let tool = item
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let arguments = item
                        .get("arguments")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let name = format!("mcp:{server}:{tool}");
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: name.clone(),
                        input: arguments.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name,
                            input: arguments,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "collab_tool_call" => {
                    let collab_tool = item
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let tool_name = normalize_collab_tool_name(collab_tool);
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let input = item.clone();
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: tool_name.to_string(),
                        input: input.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: tool_name.to_string(),
                            input,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "todo_list" => {
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let input = item.clone();
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: "CodexTodoList".to_string(),
                        input: input.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: "CodexTodoList".to_string(),
                            input,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                "dynamic_tool_call" => {
                    let tool = item
                        .get("tool")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let arguments = item
                        .get("arguments")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let name = format!("DynamicToolCall:{tool}");
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: name.clone(),
                        input: arguments.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name,
                            input: arguments,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                // These types are handled on completion only (via deltas / dedicated events)
                "agent_message"
                | "reasoning"
                | "user_message"
                | "hook_prompt"
                | "entered_review_mode"
                | "exited_review_mode" => {}
                "plan" => {
                    let tool_id = codex_plan_tool_id(None, Some(item_id));
                    let existing = tool_calls
                        .iter()
                        .find(|tc| tc.id == tool_id)
                        .map(|tc| &tc.input);
                    let plan_text = item
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let input = merge_codex_plan_input(existing, plan_text, None, None, None);
                    upsert_codex_plan_tool_call(
                        tool_calls,
                        content_blocks,
                        &tool_id,
                        input.clone(),
                    );
                    emit_codex_plan_tool_call(app, session_id, worktree_id, &tool_id, &input);
                }
                // Informational tool-like events — surface as tool calls in the UI
                "web_search" | "image_generation" | "image_view" | "context_compaction" => {
                    let tool_name = match item_type {
                        "web_search" => "CodexWebSearch",
                        "image_generation" => "CodexImageGeneration",
                        "image_view" => "CodexImageView",
                        "context_compaction" => "CodexContextCompaction",
                        _ => unreachable!(),
                    };
                    let tool_id = if item_id.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        item_id.to_string()
                    };
                    let input = item.clone();
                    tool_calls.push(ToolCall {
                        id: tool_id.clone(),
                        name: tool_name.to_string(),
                        input: input.clone(),
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: tool_id.clone(),
                    });
                    if !item_id.is_empty() {
                        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: tool_name.to_string(),
                            input,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_id,
                        },
                    );
                }
                other => {
                    log::debug!("Unknown Codex item.started type: {other}");
                }
            }
        }
        "item.completed" => {
            let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            log::debug!("[codex-event] item.completed type={item_type} id={item_id}");

            match item_type {
                "agent_message" => {
                    // Streaming deltas (item/agentMessage/delta) already emitted
                    // chat:chunk events and accumulated text in full_content.
                    // Only push the content block here for the final CodexResponse.
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            content_blocks.push(ContentBlock::Text {
                                text: text.to_string(),
                            });
                            // If no deltas were received (edge case), full_content
                            // would be missing this text — emit chunk as fallback.
                            if !full_content.contains(text) {
                                full_content.push_str(text);
                                let _ = app.emit_all(
                                    "chat:chunk",
                                    &ChunkEvent {
                                        session_id: session_id.to_string(),
                                        worktree_id: worktree_id.to_string(),
                                        content: text.to_string(),
                                    },
                                );
                            }
                        }
                    }
                }
                "plan" => {
                    let tool_id = codex_plan_tool_id(None, Some(item_id));
                    let existing = tool_calls
                        .iter()
                        .find(|tc| tc.id == tool_id)
                        .map(|tc| &tc.input);
                    // Use item text, or promote accumulated plan_preview on completion
                    let plan_text = item
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| {
                            existing
                                .and_then(|input| input.get("plan_preview"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        });
                    let input = merge_codex_plan_input(existing, plan_text, None, None, None);
                    upsert_codex_plan_tool_call(
                        tool_calls,
                        content_blocks,
                        &tool_id,
                        input.clone(),
                    );
                    emit_codex_plan_tool_call(app, session_id, worktree_id, &tool_id, &input);
                }
                "command_execution" => {
                    let output = item
                        .get("aggregated_output")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(output.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output,
                            },
                        );
                    }
                }
                "file_change" => {
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        // FileChange diffs are already carried in the tool input.
                        // Do not duplicate them into output as escaped JSON.
                    }
                }
                "reasoning" => {
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        content_blocks.push(ContentBlock::Thinking {
                            thinking: text.to_string(),
                        });
                        let _ = app.emit_all(
                            "chat:thinking",
                            &ThinkingEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                content: text.to_string(),
                            },
                        );
                    }
                }
                "mcp_tool_call" => {
                    let output = item
                        .get("output")
                        .map(|v| {
                            if let Some(s) = v.as_str() {
                                s.to_string()
                            } else {
                                serde_json::to_string(v).unwrap_or_default()
                            }
                        })
                        .unwrap_or_default();
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(output.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output,
                            },
                        );
                    }
                }
                "collab_tool_call" => {
                    let output = if let Some(states) = item.get("agents_states") {
                        if let Some(obj) = states.as_object() {
                            let parts: Vec<String> = obj
                                .iter()
                                .map(|(tid, state)| {
                                    let status = state
                                        .get("status")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");
                                    let msg =
                                        state.get("message").and_then(|v| v.as_str()).unwrap_or("");
                                    if msg.is_empty() {
                                        format!("{tid}: {status}")
                                    } else {
                                        format!("{tid}: {status} — {msg}")
                                    }
                                })
                                .collect();
                            if parts.is_empty() {
                                item.get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("completed")
                                    .to_string()
                            } else {
                                parts.join("\n")
                            }
                        } else {
                            "completed".to_string()
                        }
                    } else {
                        item.get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("completed")
                            .to_string()
                    };
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(output.clone());
                            tc.input = item.clone();
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output,
                            },
                        );
                    }
                }
                // Informational tool-like events — populate output for UI
                "web_search" | "image_generation" | "image_view" | "context_compaction" => {
                    let output = if item_type == "context_compaction" {
                        item.get("summary")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Context compacted")
                            .to_string()
                    } else {
                        item.get("output")
                            .or_else(|| item.get("result"))
                            .map(|v| {
                                if let Some(s) = v.as_str() {
                                    s.to_string()
                                } else {
                                    serde_json::to_string(v).unwrap_or_default()
                                }
                            })
                            .unwrap_or_else(|| "completed".to_string())
                    };
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(output.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output,
                            },
                        );
                    }
                }
                "dynamic_tool_call" => {
                    let output = item
                        .get("output")
                        .or_else(|| item.get("contentItems"))
                        .map(|v| {
                            if let Some(s) = v.as_str() {
                                s.to_string()
                            } else {
                                serde_json::to_string(v).unwrap_or_default()
                            }
                        })
                        .unwrap_or_else(|| {
                            item.get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("completed")
                                .to_string()
                        });
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(output.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output,
                            },
                        );
                    }
                }
                // No UI action needed for these types
                "user_message" | "hook_prompt" | "entered_review_mode" | "exited_review_mode" => {}
                other => {
                    log::debug!("Unknown Codex item.completed type: {other}");
                }
            }
        }
        // item.updated — only emitted for todo_list per Codex source
        "item.updated" => {
            let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

            if item_type == "todo_list" {
                if let Some(tool_id) = pending_tool_ids.get(item_id) {
                    let updated_input = item.clone();
                    if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == *tool_id) {
                        tc.input = updated_input.clone();
                    }
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_id.clone(),
                            name: "CodexTodoList".to_string(),
                            input: updated_input,
                            parent_tool_use_id: None,
                        },
                    );
                }
            }
        }
        "turn.completed" => {
            if let Some(usage_obj) = msg.get("usage") {
                *usage = Some(UsageData {
                    input_tokens: usage_obj
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    output_tokens: usage_obj
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_read_input_tokens: usage_obj
                        .get("cached_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_creation_input_tokens: 0,
                });
            }
            *completed = true;
            log::trace!("Codex turn completed for session: {session_id}");
        }
        "turn.failed" => {
            let error_msg = extract_codex_error_message(msg)
                .unwrap_or_else(|| "Unknown Codex error".to_string());
            let user_error = format_codex_user_error(&error_msg);
            let _ = app.emit_all(
                "chat:error",
                &ErrorEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    error: user_error,
                },
            );
            *completed = true;
            *error_emitted = true;
            log::error!("Codex turn failed for session {session_id}: {error_msg}");
        }
        _ => {
            // Check for unrecognized JSON with error fields (e.g., API error responses)
            if let Some(error_msg) = extract_codex_error_message(msg) {
                let user_error = format_codex_user_error(&error_msg);
                log::error!(
                    "Codex error (unrecognized event) for session {session_id}: {error_msg}"
                );
                let _ = app.emit_all(
                    "chat:error",
                    &ErrorEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        error: user_error,
                    },
                );
                *completed = true;
                *error_emitted = true;
            } else {
                log::trace!("Unknown Codex event type: {event_type}");
            }
        }
    }
}

// =============================================================================
// JSONL history parser (for loading saved sessions)
// =============================================================================

/// Parse stored Codex JSONL into a ChatMessage (for loading history).
///
/// Maps Codex events to the same ChatMessage format used by Claude sessions.
pub fn parse_codex_run_to_message(
    lines: &[String],
    run: &super::types::RunEntry,
) -> Result<super::types::ChatMessage, String> {
    use super::types::{ChatMessage, MessageRole};
    use uuid::Uuid;

    let is_plan_mode = run.execution_mode.as_deref() == Some("plan");
    let mut content = String::new();
    let mut turn_completed_output: Option<String> = None;
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    let mut pending_tool_ids: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }

        let msg: serde_json::Value = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if msg
            .get("_run_meta")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }

        let event_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "turn.plan_updated" => {
                if !is_plan_mode {
                    continue;
                }
                let turn_id = msg.get("turn_id").and_then(|v| v.as_str());
                let tool_id = codex_plan_tool_id(turn_id, None);
                let explanation = msg
                    .get("explanation")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let steps = msg.get("plan").and_then(|v| v.as_array()).cloned();
                let existing = tool_calls
                    .iter()
                    .find(|tc| tc.id == tool_id)
                    .map(|tc| &tc.input);
                // Don't format steps as plan_text — steps belong in TodoWidget
                let input = merge_codex_plan_input(existing, None, None, explanation, steps);
                upsert_codex_plan_tool_call(&mut tool_calls, &mut content_blocks, &tool_id, input);
            }
            "item.plan.delta" => {
                if !is_plan_mode {
                    continue;
                }
                let turn_id = msg.get("turn_id").and_then(|v| v.as_str());
                let item_id = msg.get("item_id").and_then(|v| v.as_str());
                let tool_id = codex_plan_tool_id(turn_id, item_id);
                let existing = tool_calls
                    .iter()
                    .find(|tc| tc.id == tool_id)
                    .map(|tc| &tc.input);
                // Read from plan_preview first (where deltas accumulate), then plan
                let existing_plan = existing
                    .and_then(|input| input.get("plan_preview").or_else(|| input.get("plan")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let delta = msg.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                let input = merge_codex_plan_input(
                    existing,
                    None,
                    Some(format!("{existing_plan}{delta}")),
                    None,
                    None,
                );
                upsert_codex_plan_tool_call(&mut tool_calls, &mut content_blocks, &tool_id, input);
            }
            "item.started" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                match item_type {
                    "plan" => {
                        if !is_plan_mode {
                            continue;
                        }
                        let tool_id = codex_plan_tool_id(None, Some(item_id));
                        let existing = tool_calls
                            .iter()
                            .find(|tc| tc.id == tool_id)
                            .map(|tc| &tc.input);
                        let plan_text = item
                            .get("text")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let input = merge_codex_plan_input(existing, plan_text, None, None, None);
                        upsert_codex_plan_tool_call(
                            &mut tool_calls,
                            &mut content_blocks,
                            &tool_id,
                            input,
                        );
                    }
                    "command_execution" => {
                        let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };

                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "Bash".to_string(),
                            input: serde_json::json!({ "command": command }),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    "file_change" => {
                        let changes = item
                            .get("changes")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };

                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "FileChange".to_string(),
                            input: changes,
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    "mcp_tool_call" => {
                        let server = item
                            .get("server")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let tool = item
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let arguments = item
                            .get("arguments")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };

                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: format!("mcp:{server}:{tool}"),
                            input: arguments,
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    // Multi-agent collab tools (history)
                    "collab_tool_call" => {
                        let collab_tool = item
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        let tool_name = normalize_collab_tool_name(collab_tool);
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: tool_name.to_string(),
                            input: item.clone(),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    // Codex todo/plan list (history)
                    "todo_list" => {
                        let tool_id = if item_id.is_empty() {
                            Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        tool_calls.push(ToolCall {
                            id: tool_id.clone(),
                            name: "CodexTodoList".to_string(),
                            input: item.clone(),
                            output: None,
                            parent_tool_use_id: None,
                        });
                        content_blocks.push(ContentBlock::ToolUse {
                            tool_call_id: tool_id.clone(),
                        });
                        if !item_id.is_empty() {
                            pending_tool_ids.insert(item_id.to_string(), tool_id);
                        }
                    }
                    _ => {}
                }
            }
            "item.completed" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                match item_type {
                    "plan" => {
                        if !is_plan_mode {
                            continue;
                        }
                        let tool_id = codex_plan_tool_id(None, Some(item_id));
                        let existing = tool_calls
                            .iter()
                            .find(|tc| tc.id == tool_id)
                            .map(|tc| &tc.input);
                        // Use item text, or promote accumulated plan_preview on completion
                        let plan_text = item
                            .get("text")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| {
                                existing
                                    .and_then(|input| input.get("plan_preview"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            });
                        let input = merge_codex_plan_input(existing, plan_text, None, None, None);
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.input = input;
                        } else {
                            upsert_codex_plan_tool_call(
                                &mut tool_calls,
                                &mut content_blocks,
                                &tool_id,
                                input,
                            );
                        }
                    }
                    "agent_message" => {
                        if let Some(text) = extract_agent_message_text(item) {
                            if run.cancelled && content == text {
                                continue;
                            }
                            content.push_str(&text);

                            // In plan mode, merge final_answer into the CodexPlan tool
                            // and skip the ContentBlock::Text to avoid rendering twice.
                            let is_final_answer =
                                item.get("phase").and_then(|v| v.as_str()) == Some("final_answer");
                            let mut merged_into_plan = false;
                            if is_plan_mode && is_final_answer && !text.is_empty() {
                                if let Some(existing_tc) =
                                    tool_calls.iter().find(|tc| tc.name == CODEX_PLAN_TOOL_NAME)
                                {
                                    let tool_id = existing_tc.id.clone();
                                    let input = merge_codex_plan_input(
                                        Some(&existing_tc.input),
                                        Some(text.clone()),
                                        None,
                                        None,
                                        None,
                                    );
                                    if let Some(tc) =
                                        tool_calls.iter_mut().find(|t| t.id == tool_id)
                                    {
                                        tc.input = input;
                                        merged_into_plan = true;
                                    }
                                }
                            }
                            if !merged_into_plan {
                                content_blocks.push(ContentBlock::Text { text });
                            }
                        }
                    }
                    "command_execution" => {
                        let output = item
                            .get("aggregated_output")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output);
                            }
                        }
                    }
                    "file_change" => {
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            // FileChange diffs are already carried in the tool input.
                            // Do not duplicate them into output as escaped JSON.
                        }
                    }
                    "reasoning" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            content_blocks.push(ContentBlock::Thinking {
                                thinking: text.to_string(),
                            });
                        }
                    }
                    "mcp_tool_call" => {
                        let output = item
                            .get("output")
                            .map(|v| {
                                if let Some(s) = v.as_str() {
                                    s.to_string()
                                } else {
                                    serde_json::to_string(v).unwrap_or_default()
                                }
                            })
                            .unwrap_or_default();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output);
                            }
                        }
                    }
                    // Multi-agent collab tool completions (history)
                    "collab_tool_call" => {
                        let output = if let Some(states) = item.get("agents_states") {
                            if let Some(obj) = states.as_object() {
                                let parts: Vec<String> = obj
                                    .iter()
                                    .map(|(tid, state)| {
                                        let status = state
                                            .get("status")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("unknown");
                                        let msg = state
                                            .get("message")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        if msg.is_empty() {
                                            format!("{tid}: {status}")
                                        } else {
                                            format!("{tid}: {status} — {msg}")
                                        }
                                    })
                                    .collect();
                                if parts.is_empty() {
                                    "completed".to_string()
                                } else {
                                    parts.join("\n")
                                }
                            } else {
                                "completed".to_string()
                            }
                        } else {
                            "completed".to_string()
                        };
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(output);
                                tc.input = item.clone();
                            }
                        }
                    }
                    _ => {}
                }
            }
            "turn.completed" => {
                if let Some(output) = msg
                    .get("output")
                    .and_then(extract_text_from_turn_output)
                    .filter(|text| !text.is_empty())
                {
                    turn_completed_output = Some(output);
                }
            }
            // item.updated — only for todo_list (history)
            "item.updated" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                if item_type == "todo_list" {
                    if let Some(tool_id) = pending_tool_ids.get(item_id) {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == *tool_id) {
                            tc.input = item.clone();
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if content.is_empty() {
        if let Some(output) = turn_completed_output {
            content = output.clone();
            content_blocks.push(ContentBlock::Text { text: output });
        }
    }

    let has_executed_tools = tool_calls.iter().any(|tc| tc.name != CODEX_PLAN_TOOL_NAME);
    if is_plan_mode && !has_executed_tools {
        ensure_plain_text_codex_plan_tool(&mut tool_calls, &mut content_blocks, &content);

        // Fallback: if CodexPlan exists but has no plan text, inject full content
        if !content.is_empty() {
            if let Some(tc) = tool_calls.iter().find(|tc| tc.name == CODEX_PLAN_TOOL_NAME) {
                let has_plan = tc
                    .input
                    .get("plan")
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| !s.is_empty());
                if !has_plan {
                    let tool_id = tc.id.clone();
                    let input = merge_codex_plan_input(
                        Some(&tc.input),
                        Some(content.clone()),
                        None,
                        None,
                        None,
                    );
                    if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                        tc.input = input;
                    }
                    // Remove text blocks that duplicate the plan content
                    content_blocks.retain(|block| {
                        !matches!(block, ContentBlock::Text { text } if text.trim() == content.trim())
                    });
                }
            }
        }
    }

    Ok(ChatMessage {
        id: run
            .assistant_message_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        session_id: String::new(), // Set by caller
        role: MessageRole::Assistant,
        content,
        timestamp: run.ended_at.unwrap_or(run.started_at),
        tool_calls,
        content_blocks,
        cancelled: run.cancelled,
        plan_approved: false,
        model: None,
        execution_mode: None,
        thinking_level: None,
        effort_level: None,
        recovered: run.recovered,
        usage: run.usage.clone(),
    })
}

// =============================================================================
// One-shot Codex execution (for magic prompts with --output-schema)
// =============================================================================

/// Execute a one-shot Codex CLI call with `--output-schema` for structured JSON output.
///
/// Equivalent to Claude's `--json-schema` pattern but for Codex:
///   `codex exec --json --model <model> --full-auto --output-schema <schema> -`
///
/// Returns the raw JSON string of the structured output.
pub fn execute_one_shot_codex(
    app: &tauri::AppHandle,
    prompt: &str,
    model: &str,
    output_schema: &str,
    working_dir: Option<&std::path::Path>,
    reasoning_effort: Option<&str>,
) -> Result<String, String> {
    let cli_path = crate::codex_cli::resolve_cli_binary(app);

    if !cli_path.exists() {
        return Err("Codex CLI not installed".to_string());
    }

    // Split fast suffix: "gpt-5.4-fast" → model="gpt-5.4" + service_tier="fast"
    let (actual_model, is_fast) = split_fast_model(model);

    log::info!(
        "Executing one-shot Codex CLI: model={actual_model}, fast={is_fast}, working_dir={:?}, reasoning_effort={:?}",
        working_dir,
        reasoning_effort
    );

    // Write schema to a temp file since --output-schema expects a file path
    let schema_file =
        std::env::temp_dir().join(format!("jean-codex-schema-{}.json", std::process::id()));
    std::fs::write(&schema_file, output_schema)
        .map_err(|e| format!("Failed to write schema file: {e}"))?;

    let mut cmd = crate::platform::silent_command(&cli_path);
    cmd.args(["exec", "--json", "--model", actual_model, "--full-auto"]);
    if is_fast {
        cmd.args(["-c", "service_tier=\"fast\""]);
    }
    cmd.arg("--output-schema");
    cmd.arg(&schema_file);
    if let Some(dir) = working_dir {
        cmd.arg("--cd");
        cmd.arg(dir);
    } else {
        // One-shot calls that don't know a repository path should still run.
        cmd.arg("--skip-git-repo-check");
    }
    cmd.arg("-"); // Read prompt from stdin
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Codex CLI: {e}"))?;

    // Write prompt to stdin
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(prompt.as_bytes());
        // stdin is dropped here, closing the pipe
    }

    log::debug!("Codex CLI one-shot spawned, waiting for output (timeout: 120s)...");

    // Wait with timeout to avoid hanging indefinitely (e.g. MCP server connection issues)
    let timeout = std::time::Duration::from_secs(120);
    let start = std::time::Instant::now();
    let output = loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                // Process exited — collect output
                break child
                    .wait_with_output()
                    .map_err(|e| format!("Failed to collect Codex CLI output: {e}"))?;
            }
            Ok(None) => {
                // Still running
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(
                        "Codex CLI timed out after 120s. This often happens when an MCP server \
                         is stuck connecting. Check your Codex MCP server configuration."
                            .to_string(),
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                return Err(format!("Failed to check Codex CLI status: {e}"));
            }
        }
    };

    log::debug!(
        "Codex CLI one-shot completed in {:.1}s, exit: {}",
        start.elapsed().as_secs_f64(),
        output.status
    );

    // Clean up temp schema file
    let _ = std::fs::remove_file(&schema_file);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        // Full details for developer logs
        log::warn!(
            "Codex CLI one-shot failed (exit {}): stderr={}, stdout={}",
            output.status,
            stderr.trim(),
            stdout.trim()
        );

        // User-facing error: detect common patterns and provide actionable hints
        let user_msg = if stderr.contains("AuthRequired") || stderr.contains("invalid_token") {
            "Codex CLI failed: an MCP server requires authentication. \
                 Check your Codex MCP server configuration."
                .to_string()
        } else {
            let trimmed = stderr.trim();
            if trimmed.len() > 200 {
                let end = trimmed
                    .char_indices()
                    .nth(200)
                    .map(|(i, _)| i)
                    .unwrap_or(trimmed.len());
                format!(
                    "Codex CLI failed (exit {}): {}…",
                    output.status,
                    &trimmed[..end]
                )
            } else if trimmed.is_empty() {
                format!("Codex CLI failed (exit {})", output.status)
            } else {
                format!("Codex CLI failed (exit {}): {trimmed}", output.status)
            }
        };

        return Err(user_msg);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    log::trace!("Codex one-shot stdout length: {} bytes", stdout.len());

    extract_codex_structured_output(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::{RunEntry, RunStatus};

    #[test]
    fn gpt_5_4_fast_enables_fast_service_tier() {
        let params = build_thread_start_params(
            std::path::Path::new("/tmp"),
            Some("gpt-5.4-fast"),
            Some("plan"),
            false,
            None,
            false,
            None,
        );
        assert_eq!(params["model"], "gpt-5.4");
        assert_eq!(params["serviceTier"], "fast");
    }

    #[test]
    fn split_fast_model_recognises_gpt_5_4_fast() {
        assert_eq!(split_fast_model("gpt-5.4-fast"), ("gpt-5.4", true));
    }

    #[test]
    fn split_fast_model_ignores_deprecated_fast_suffix() {
        // Older models ending in -fast should NOT enable fast tier
        assert_eq!(split_fast_model("gpt-5.3-fast"), ("gpt-5.3", false));
    }

    #[test]
    fn split_fast_model_recognises_gpt_5_4_mini_fast() {
        assert_eq!(
            split_fast_model("gpt-5.4-mini-fast"),
            ("gpt-5.4-mini", true)
        );
    }

    #[test]
    fn split_fast_model_passes_through_normal_models() {
        assert_eq!(split_fast_model("gpt-5.4"), ("gpt-5.4", false));
        assert_eq!(split_fast_model("gpt-5.4-mini"), ("gpt-5.4-mini", false));
        assert_eq!(split_fast_model("o3"), ("o3", false));
    }

    #[test]
    fn deprecated_fast_models_do_not_enable_fast_service_tier() {
        let params = build_thread_start_params(
            std::path::Path::new("/tmp"),
            Some("gpt-5.3-fast"),
            Some("plan"),
            false,
            None,
            false,
            None,
        );
        assert_eq!(params["model"], "gpt-5.3");
        assert!(params.get("serviceTier").is_none());
    }

    #[test]
    fn build_mode_uses_granular_approval_policy() {
        let params = build_thread_start_params(
            std::path::Path::new("/tmp"),
            Some("gpt-5.4"),
            Some("build"),
            false,
            None,
            false,
            None,
        );
        let policy = &params["approvalPolicy"]["granular"];
        assert_eq!(policy["mcp_elicitations"], false);
        assert_eq!(policy["sandbox_approval"], true);
        assert_eq!(policy["rules"], true);
        assert_eq!(policy["request_permissions"], true);
    }

    #[test]
    fn plan_mode_uses_granular_approval_policy() {
        let params = build_thread_start_params(
            std::path::Path::new("/tmp"),
            Some("gpt-5.4"),
            Some("plan"),
            false,
            None,
            false,
            None,
        );
        let policy = &params["approvalPolicy"]["granular"];
        assert_eq!(policy["mcp_elicitations"], false);
        assert_eq!(policy["sandbox_approval"], true);
        assert_eq!(policy["rules"], true);
        assert_eq!(policy["request_permissions"], true);
    }

    #[test]
    fn yolo_mode_uses_never_approval_policy() {
        let params = build_thread_start_params(
            std::path::Path::new("/tmp"),
            Some("gpt-5.4"),
            Some("yolo"),
            false,
            None,
            false,
            None,
        );
        assert_eq!(params["approvalPolicy"], "never");
    }

    #[test]
    fn parse_cancelled_run_ignores_duplicate_completed_agent_message() {
        let lines = vec![
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Same text"}}"#
                .to_string(),
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Same text"}}"#
                .to_string(),
        ];
        let run = RunEntry {
            run_id: "run-1".to_string(),
            user_message_id: "user-1".to_string(),
            user_message: "prompt".to_string(),
            model: None,
            execution_mode: Some("plan".to_string()),
            thinking_level: None,
            effort_level: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Cancelled,
            assistant_message_id: Some("assistant-1".to_string()),
            cancelled: true,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.content, "Same text");
        assert_eq!(message.content_blocks.len(), 1);
        assert!(matches!(
            message.content_blocks.first(),
            Some(ContentBlock::Text { text }) if text == "Same text"
        ));
    }

    #[test]
    fn parse_plan_run_preserves_agent_message_text_blocks() {
        let lines = vec![
            r#"{"type":"item.plan.delta","item_id":"plan-1","delta":"Partial plan"}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"plan-1","type":"plan","text":"Final plan"}}"#
                .to_string(),
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Text between commands"}}"#
                .to_string(),
        ];
        let run = RunEntry {
            run_id: "run-2".to_string(),
            user_message_id: "user-2".to_string(),
            user_message: "prompt".to_string(),
            model: None,
            execution_mode: Some("plan".to_string()),
            thinking_level: None,
            effort_level: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: Some("assistant-2".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.content, "Text between commands");
        assert_eq!(message.content_blocks.len(), 2);
        assert!(message.content_blocks.iter().any(|block| matches!(
            block,
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "codex-plan-plan-1"
        )));
        assert!(message.content_blocks.iter().any(|block| matches!(
            block,
            ContentBlock::Text { text } if text == "Text between commands"
        )));

        let plan_tool = message
            .tool_calls
            .iter()
            .find(|tool| tool.name == CODEX_PLAN_TOOL_NAME)
            .expect("plan tool");
        assert_eq!(
            plan_tool.input.get("plan").and_then(|v| v.as_str()),
            Some("Final plan")
        );
    }

    #[test]
    fn parse_plan_run_moves_plan_block_to_latest_update_position() {
        let lines = vec![
            r#"{"type":"turn.plan_updated","turn_id":"turn-1","explanation":"First pass","plan":[{"step":"Inspect repo","status":"in_progress"}]}"#.to_string(),
            r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"rtk git status"}}"#.to_string(),
            r#"{"type":"turn.plan_updated","turn_id":"turn-1","explanation":"Refined","plan":[{"step":"Inspect repo","status":"completed"},{"step":"Patch order","status":"in_progress"}]}"#.to_string(),
        ];
        let run = RunEntry {
            run_id: "run-order".to_string(),
            user_message_id: "user-order".to_string(),
            user_message: "prompt".to_string(),
            model: None,
            execution_mode: Some("plan".to_string()),
            thinking_level: None,
            effort_level: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: Some("assistant-order".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.tool_calls.len(), 2);
        assert_eq!(message.content_blocks.len(), 2);
        assert!(matches!(
            message.content_blocks.first(),
            Some(ContentBlock::ToolUse { tool_call_id }) if tool_call_id == "cmd-1"
        ));
        assert!(matches!(
            message.content_blocks.last(),
            Some(ContentBlock::ToolUse { tool_call_id }) if tool_call_id == "codex-plan-turn-1"
        ));

        let plan_tool = message
            .tool_calls
            .iter()
            .find(|tool| tool.id == "codex-plan-turn-1")
            .expect("plan tool");
        assert_eq!(
            plan_tool
                .input
                .get("explanation")
                .and_then(|value| value.as_str()),
            Some("Refined")
        );
    }

    #[test]
    fn extract_plain_text_plan_sections_splits_intro_from_plan() {
        assert_eq!(
            extract_plain_text_plan_sections(
                "Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests"
            ),
            Some((
                Some("Repo inspected.".to_string()),
                "Plan:\n- Implement changes\n- Add tests".to_string(),
            ))
        );
    }

    #[test]
    fn parse_plan_run_synthesizes_codex_plan_from_plain_text_final_answer() {
        let lines = vec![
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests"}}"#
                .to_string(),
        ];
        let run = RunEntry {
            run_id: "run-plain-plan".to_string(),
            user_message_id: "user-plain-plan".to_string(),
            user_message: "prompt".to_string(),
            model: None,
            execution_mode: Some("plan".to_string()),
            thinking_level: None,
            effort_level: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: Some("assistant-plain-plan".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(
            message.content,
            "Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests"
        );
        let plan_tool = message
            .tool_calls
            .iter()
            .find(|tool| tool.name == CODEX_PLAN_TOOL_NAME)
            .expect("plain-text plan tool");
        assert_eq!(
            plan_tool.input.get("plan").and_then(|v| v.as_str()),
            Some("Plan:\n- Implement changes\n- Add tests")
        );
        assert!(message.content_blocks.iter().any(|block| matches!(
            block,
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "codex-plan-plain-text-final-answer"
        )));
    }

    #[test]
    fn parse_non_plan_run_ignores_plan_events() {
        let lines = vec![
            r#"{"type":"turn.plan_updated","turn_id":"turn-1","explanation":"Investigating","plan":[{"step":"Inspect repo","status":"in_progress"}]}"#.to_string(),
            r#"{"type":"item.plan.delta","item_id":"plan-1","turn_id":"turn-1","delta":"Partial plan"}"#.to_string(),
            r#"{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"rtk git status"}}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","aggregated_output":"clean"}}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"plan-1","type":"plan","text":"Final plan"}}"#.to_string(),
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Implemented fix."}}"#.to_string(),
        ];
        let run = RunEntry {
            run_id: "run-3".to_string(),
            user_message_id: "user-3".to_string(),
            user_message: "prompt".to_string(),
            model: None,
            execution_mode: Some("yolo".to_string()),
            thinking_level: None,
            effort_level: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: Some("assistant-3".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.content, "Implemented fix.");
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].name, "Bash");
        assert_eq!(
            message.tool_calls[0]
                .input
                .get("command")
                .and_then(|v| v.as_str()),
            Some("rtk git status")
        );
        assert_eq!(message.tool_calls[0].output.as_deref(), Some("clean"));
        assert!(!message
            .tool_calls
            .iter()
            .any(|tool| tool.name == CODEX_PLAN_TOOL_NAME));
        assert_eq!(message.content_blocks.len(), 2);
        assert!(message.content_blocks.iter().any(|block| matches!(
            block,
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "cmd-1"
        )));
        assert!(message.content_blocks.iter().any(|block| matches!(
            block,
            ContentBlock::Text { text } if text == "Implemented fix."
        )));
    }

    #[test]
    fn parse_completed_agent_message_uses_content_blocks_when_text_missing() {
        let lines = vec![
            r#"{"type":"item.started","item":{"id":"msg-1","type":"agent_message","text":""}}"#
                .to_string(),
            r#"{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","content":[{"type":"text","text":"Final answer"}]}}"#
                .to_string(),
        ];
        let run = RunEntry {
            run_id: "run-4".to_string(),
            user_message_id: "user-4".to_string(),
            user_message: "prompt".to_string(),
            model: None,
            execution_mode: Some("plan".to_string()),
            thinking_level: None,
            effort_level: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: Some("assistant-4".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.content, "Final answer");
        assert!(message.content_blocks.iter().any(|block| matches!(
            block,
            ContentBlock::Text { text } if text == "Final answer"
        )));
    }

    #[test]
    fn parse_completed_run_falls_back_to_turn_completed_output() {
        let lines = vec![
            r#"{"type":"item.started","item":{"id":"msg-1","type":"agent_message","text":""}}"#
                .to_string(),
            r#"{"type":"turn.completed","output":[{"type":"output_text","text":"Recovered from turn output"}]}"#
                .to_string(),
        ];
        let run = RunEntry {
            run_id: "run-5".to_string(),
            user_message_id: "user-5".to_string(),
            user_message: "prompt".to_string(),
            model: None,
            execution_mode: Some("plan".to_string()),
            thinking_level: None,
            effort_level: None,
            started_at: 1,
            ended_at: Some(2),
            status: RunStatus::Completed,
            assistant_message_id: Some("assistant-5".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.content, "Recovered from turn output");
        assert!(message.content_blocks.iter().any(|block| matches!(
            block,
            ContentBlock::Text { text } if text == "Recovered from turn output"
        )));
    }
}

/// Parse Codex NDJSON output to extract structured JSON from --output-schema response.
///
/// Codex emits newline-delimited JSON events. We look for the structured output
/// in several possible locations:
/// - `item.completed` with type `agent_message` containing JSON text
/// - `turn.completed` with an `output` field
fn extract_codex_structured_output(output: &str) -> Result<String, String> {
    let mut last_agent_message = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "item.completed" => {
                // Check for agent_message with text content
                if let Some(item) = parsed.get("item") {
                    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if item_type == "agent_message" {
                        if let Some(text) = extract_agent_message_text(item) {
                            if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
                                return Ok(text);
                            }
                            last_agent_message = Some(text);
                        }
                    }
                }
            }
            "turn.completed" => {
                // Check for output field directly
                if let Some(output_val) = parsed.get("output") {
                    if let Some(text) = extract_text_from_turn_output(output_val) {
                        if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
                            return Ok(text);
                        }
                    } else if !output_val.is_null() {
                        return Ok(output_val.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    // Fall back to last agent message if it parses as JSON
    if let Some(msg) = last_agent_message {
        if serde_json::from_str::<serde_json::Value>(&msg).is_ok() {
            return Ok(msg);
        }
    }

    Err("No structured output found in Codex response".to_string())
}
