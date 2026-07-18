//! Codex CLI execution engine
//!
//! Uses `codex app-server` (a persistent JSON-RPC 2.0 server over stdio) for
//! all chat interactions. Threads and turns are managed via JSON-RPC requests;
//! streamed responses arrive as notifications and are mapped to Tauri events.
//!
//! One-shot operations (commit messages, PR content, etc.) still use `codex exec`
//! directly since they don't need streaming.

use super::claude::CancelledEvent;
use super::coalesce::ChunkCoalescer;
use super::types::{
    CodexCommandAction, CodexCommandApprovalRequest, CodexCommandApprovalRequestEvent,
    CodexDynamicToolCallRequest, CodexDynamicToolCallRequestEvent, CodexNetworkApprovalContext,
    CodexNetworkPolicyAmendment, CodexPermissionRequest, CodexPermissionRequestEvent,
    CodexUserInputRequest, CodexUserInputRequestEvent, ContentBlock, ToolCall, UsageData,
};
use crate::http_server::EmitExt;

use std::collections::HashMap;
use std::io::Write;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
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
pub(crate) const DEFAULT_MODEL_VERBOSITY: &str = "low";

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
    // Keep structured steps separate from authoritative plan text. The frontend
    // can render them in both PlanDisplay and the TodoWidget sidebar.

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

/// Split "gpt-5.5-fast" → ("gpt-5.5", true). Fast tier supported on
/// the current Codex model families listed here; older models that happened
/// to end in `-fast` are left unchanged.
pub(crate) fn split_fast_model(model: &str) -> (&str, bool) {
    match model {
        "gpt-5.6" | "gpt-5-6-sol" => ("gpt-5.6-sol", false),
        "gpt-5-6-terra" => ("gpt-5.6-terra", false),
        "gpt-5-6-luna" => ("gpt-5.6-luna", false),
        "gpt-5.6-fast" | "gpt-5-6-sol-fast" => ("gpt-5.6-sol", true),
        "gpt-5.6-sol-fast" => ("gpt-5.6-sol", true),
        "gpt-5-6-terra-fast" | "gpt-5.6-terra-fast" => ("gpt-5.6-terra", true),
        "gpt-5-6-luna-fast" | "gpt-5.6-luna-fast" => ("gpt-5.6-luna", true),
        "gpt-5.5-fast" => ("gpt-5.5", true),
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

    // Permission mode mapping.
    //
    // Plan mode must never ask the user for permissions. It is read-only, so
    // any attempted writes or denied commands should fail/decline rather than
    // surfacing an approval prompt.
    //
    // Build mode uses granular approval policy with mcp_elicitations=false to
    // auto-approve MCP elicitation requests (matching Claude Code's behavior).
    // Codex reads MCP config from TOML files directly, so we can't detect
    // whether MCP servers are configured — but setting mcp_elicitations=false
    // is a no-op when no MCP servers exist, so it's safe to use in build mode.
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
            params["approvalPolicy"] = serde_json::json!("never");
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

    config.insert(
        "model_verbosity".to_string(),
        serde_json::json!(DEFAULT_MODEL_VERBOSITY),
    );

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
    // in ALL modes, and writable roots only in build mode.
    // Also include git metadata dirs so worktree commits work (issue #280).
    // In yolo mode, keep true danger-full-access. A per-turn sandboxPolicy
    // overrides the thread-level `sandbox`, so using workspaceWrite here would
    // accidentally re-sandbox yolo turns and break tools such as Playwright on
    // macOS.
    let mode = execution_mode.unwrap_or("plan");
    if mode == "yolo" {
        params["sandboxPolicy"] = serde_json::json!({
            "type": "dangerFullAccess",
        });
    } else {
        let is_writable = mode == "build";
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

/// Build JSON-RPC params for `turn/steer` — injects user input into a running turn.
/// The request fails server-side when `expectedTurnId` no longer matches the
/// active turn (turn ended), which callers treat as a fallback signal.
pub fn build_turn_steer_params(thread_id: &str, turn_id: &str, text: &str) -> serde_json::Value {
    build_turn_steer_params_with_input(
        thread_id,
        turn_id,
        vec![serde_json::json!({
            "type": "text",
            "text": text,
            "text_elements": [],
        })],
    )
}

pub fn build_turn_steer_params_with_input(
    thread_id: &str,
    turn_id: &str,
    input: Vec<serde_json::Value>,
) -> serde_json::Value {
    serde_json::json!({
        "threadId": thread_id,
        "expectedTurnId": turn_id,
        "input": input,
    })
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

    // If user set a `/goal` before the first turn, flush it to the server now
    // that we have a real thread id. No-op when the session has no buffered
    // goal or when this is a resume (the server already knows the goal).
    super::commands::flush_pending_codex_goal(app, session_id, &thread_id);

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
        None,
        None,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexResumeDisposition {
    Active,
    Idle,
    Failed,
    Interrupted,
}

fn codex_thread_status_type(response: &serde_json::Value) -> Option<&str> {
    response
        .get("thread")
        .and_then(|thread| thread.get("status"))
        .and_then(|status| status.get("type"))
        .and_then(|value| value.as_str())
}

fn codex_thread_turns(response: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    response
        .get("thread")
        .and_then(|thread| thread.get("turns"))
        .and_then(|turns| turns.as_array())
}

fn select_codex_recovery_turn<'a>(
    response: &'a serde_json::Value,
    preferred_turn_id: Option<&str>,
) -> Option<&'a serde_json::Value> {
    let turns = codex_thread_turns(response)?;
    if let Some(preferred) = preferred_turn_id.filter(|id| !id.is_empty()) {
        if let Some(turn) = turns
            .iter()
            .find(|turn| turn.get("id").and_then(|value| value.as_str()) == Some(preferred))
        {
            return Some(turn);
        }
    }
    turns.last()
}

fn codex_turn_status(turn: &serde_json::Value) -> Option<&str> {
    turn.get("status").and_then(|value| value.as_str())
}

fn classify_codex_resume(
    response: &serde_json::Value,
    preferred_turn_id: Option<&str>,
    had_active_turn: bool,
) -> CodexResumeDisposition {
    let thread_status = codex_thread_status_type(response);
    let turn_status =
        select_codex_recovery_turn(response, preferred_turn_id).and_then(codex_turn_status);

    match turn_status {
        Some("failed") => CodexResumeDisposition::Failed,
        Some("interrupted") => CodexResumeDisposition::Interrupted,
        Some("inProgress") => CodexResumeDisposition::Active,
        Some("completed") => CodexResumeDisposition::Idle,
        _ if had_active_turn && thread_status == Some("active") => CodexResumeDisposition::Active,
        _ => CodexResumeDisposition::Idle,
    }
}

fn codex_turn_error_message(turn: &serde_json::Value) -> Option<String> {
    let error = turn.get("error")?;
    error
        .get("message")
        .and_then(|value| value.as_str())
        .or_else(|| error.as_str())
        .map(ToOwned::to_owned)
}

fn codex_thread_snapshot_history_lines(
    response: &serde_json::Value,
    preferred_turn_id: Option<&str>,
    include_result_marker: bool,
) -> Vec<String> {
    let Some(turn) = select_codex_recovery_turn(response, preferred_turn_id) else {
        return Vec::new();
    };

    let mut lines = Vec::new();
    if let Some(items) = turn.get("items").and_then(|value| value.as_array()) {
        for item in items {
            let normalized = normalize_item_types(item);
            let item_type = normalized
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("");

            // User messages are represented by RunEntry.user_message in Jean.
            if item_type == "user_message" || item_type == "hook_prompt" {
                continue;
            }

            let started = serde_json::json!({
                "type": "item.started",
                "item": normalized,
            });
            if let Ok(line) = serde_json::to_string(&started) {
                lines.push(line);
            }

            let completed = serde_json::json!({
                "type": "item.completed",
                "item": normalized,
            });
            if let Ok(line) = serde_json::to_string(&completed) {
                lines.push(line);
            }
        }
    }

    match codex_turn_status(turn) {
        Some("failed") => {
            let failed = serde_json::json!({
                "type": "turn.failed",
                "error": turn.get("error").cloned().unwrap_or(serde_json::Value::Null),
            });
            if let Ok(line) = serde_json::to_string(&failed) {
                lines.push(line);
            }
        }
        Some("completed") if include_result_marker => {
            lines.push(r#"{"type":"result"}"#.to_string());
        }
        _ => {}
    }

    lines
}

fn append_codex_thread_snapshot_to_history_file(
    output_file: &std::path::Path,
    response: &serde_json::Value,
    preferred_turn_id: Option<&str>,
    include_result_marker: bool,
) -> Result<(), String> {
    let lines =
        codex_thread_snapshot_history_lines(response, preferred_turn_id, include_result_marker);
    if lines.is_empty() {
        return Ok(());
    }

    let existing = std::fs::read_to_string(output_file).unwrap_or_default();
    let existing_lines: std::collections::HashSet<&str> = existing.lines().map(str::trim).collect();

    // Snapshot items use synthetic `item-N` ids while live-written lines use
    // real ids (msg_…, rs_…). Collect (type, text, id) of existing text items
    // so re-snapshotted duplicates of already-written items are skipped.
    let mut existing_text_items: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    for line in existing.lines() {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(item) = msg.get("item") else {
            continue;
        };
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if item_type != "agent_message" && item_type != "reasoning" {
            continue;
        }
        let Some(text) = item.get("text").and_then(|v| v.as_str()) else {
            continue;
        };
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        existing_text_items
            .entry((item_type.to_string(), text.to_string()))
            .or_insert_with(|| id.to_string());
    }
    let is_known_text_item = |line: &str| -> bool {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        let Some(item) = msg.get("item") else {
            return false;
        };
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if item_type != "agent_message" && item_type != "reasoning" {
            return false;
        }
        let Some(text) = item.get("text").and_then(|v| v.as_str()) else {
            return false;
        };
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        match existing_text_items.get(&(item_type.to_string(), text.to_string())) {
            Some(first_id) => {
                first_id != id && (first_id.starts_with("item-") || id.starts_with("item-"))
            }
            None => false,
        }
    };

    let mut writer = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output_file)
        .map_err(|e| format!("Failed to open Codex recovery history: {e}"))?;

    for line in lines {
        if existing_lines.contains(line.as_str()) || is_known_text_item(&line) {
            continue;
        }
        writeln!(writer, "{line}")
            .map_err(|e| format!("Failed to append Codex recovery history: {e}"))?;
    }
    writer
        .flush()
        .map_err(|e| format!("Failed to flush Codex recovery history: {e}"))?;

    Ok(())
}

fn emit_codex_done(app: &tauri::AppHandle, session_id: &str, worktree_id: &str) {
    let _ = app.emit_all(
        "chat:done",
        &DoneEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            waiting_for_plan: false,
        },
    );
}

fn run_was_explicitly_cancelled(app: &tauri::AppHandle, session_id: &str, run_id: &str) -> bool {
    super::storage::load_metadata(app, session_id)
        .ok()
        .flatten()
        .and_then(|metadata| {
            metadata
                .runs
                .iter()
                .find(|run| run.run_id == run_id)
                .map(|run| run.status == super::types::RunStatus::Cancelled || run.cancelled)
        })
        .unwrap_or(false)
}

fn persist_codex_recovered_completion_state(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let Some(mut metadata) = super::storage::load_metadata(app, session_id)? else {
        return Ok(());
    };

    let is_plan_mode = metadata
        .runs
        .iter()
        .find(|run| run.run_id == run_id)
        .and_then(|run| run.execution_mode.as_deref())
        == Some("plan");

    if is_plan_mode {
        metadata.waiting_for_input = true;
        metadata.waiting_for_input_type = Some("plan".to_string());
        metadata.is_reviewing = false;
    } else {
        metadata.waiting_for_input = false;
        metadata.waiting_for_input_type = None;
        metadata.is_reviewing = false;
    }

    super::storage::save_metadata(app, &metadata)
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
    codex_turn_id: Option<&str>,
) -> Result<bool, String> {
    use super::codex_server;
    use super::run_log::RunLogWriter;
    use super::storage::get_session_dir;

    let had_active_turn = codex_turn_id.is_some();

    log::info!(
        "Codex crash recovery: session={session_id}, thread={thread_id}, had_active_turn={had_active_turn}"
    );

    // 1. Ensure the app-server is running.
    codex_server::ensure_running(app)?;

    // Register a SessionContext BEFORE calling thread/resume. The server may
    // start emitting notifications for the resumed thread immediately after
    // accepting `thread/resume` — if no session is registered yet, those
    // events get dropped by route_notification. The channel acts as a buffer:
    // process_turn_events will drain it when we enter the event loop. If the
    // disposition turns out to be non-Active, we unregister below.
    let (event_tx, event_rx) = std::sync::mpsc::channel();
    let ctx = codex_server::SessionContext {
        session_id: session_id.to_string(),
        worktree_id: worktree_id.to_string(),
        event_tx,
    };
    codex_server::register_session(thread_id, ctx);

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
            codex_server::unregister_session(thread_id);
            Ok(false)
        }
        Ok(response) => {
            log::trace!("Codex crash recovery: thread/resume succeeded for {thread_id}");

            let disposition = classify_codex_resume(&response, codex_turn_id, had_active_turn);

            if disposition == CodexResumeDisposition::Active {
                // Turn was in-flight when Jean crashed and thread is still active.
                // Session is already registered above; just register the turn for
                // cancellation tracking and enter the event loop.
                let session_dir = get_session_dir(app, session_id)?;
                let output_file = session_dir.join(format!("{run_id}.jsonl"));

                super::registry::register_codex_turn(
                    session_id.to_string(),
                    thread_id.to_string(),
                    codex_turn_id.unwrap_or_default().to_string(),
                );

                // Backfill items that completed while Jean was closed. Live
                // notifications only cover events from reconnect onward; the
                // resume snapshot holds the earlier ones. Existing lines are
                // skipped (exact-line dedupe) and the parser upserts by item id.
                if let Err(e) = append_codex_thread_snapshot_to_history_file(
                    &output_file,
                    &response,
                    codex_turn_id,
                    false,
                ) {
                    log::warn!("Failed to backfill Codex resume snapshot: {e}");
                }

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
                    Some(std::time::Duration::from_secs(15)),
                    codex_turn_id,
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
                    if response.error_emitted {
                        if let Err(e) = writer.crash() {
                            log::error!(
                                "Failed to mark Codex run crashed after recovery error: {e}"
                            );
                        }
                    } else if response.cancelled {
                        if run_was_explicitly_cancelled(app, session_id, run_id) {
                            if let Err(e) = writer.cancel(Some(&assistant_message_id), None) {
                                log::error!("Failed to cancel run after Codex crash recovery: {e}");
                            }
                        } else if let Err(e) = writer.crash() {
                            log::error!(
                                "Recovered Codex turn was interrupted without user cancel; \
                                 failed to mark run crashed: {e}"
                            );
                        }
                    } else if let Err(e) =
                        writer.complete(&assistant_message_id, None, response.usage)
                    {
                        log::error!("Failed to complete run after crash recovery: {e}");
                    } else if let Err(e) =
                        persist_codex_recovered_completion_state(app, session_id, run_id)
                    {
                        log::error!("Failed to persist Codex recovered completion state: {e}");
                    }
                }

                return Ok(true);
            }

            // Thread is idle — turn completed while Jean was down, or no turn was active.
            // The JSONL file may already have the result from before the crash.
            // Mark the run as completed (the JSONL output is the source of truth).
            // Unregister the placeholder session we set up before thread/resume.
            codex_server::unregister_session(thread_id);
            let session_dir = get_session_dir(app, session_id)?;
            let output_file = session_dir.join(format!("{run_id}.jsonl"));

            // Check if the JSONL file has a result line (turn completed before crash)
            let has_result = super::run_log::jsonl_has_result_line(app, session_id, run_id);

            if !has_result {
                if let Err(e) = append_codex_thread_snapshot_to_history_file(
                    &output_file,
                    &response,
                    codex_turn_id,
                    disposition == CodexResumeDisposition::Idle,
                ) {
                    log::warn!("Failed to append Codex recovery snapshot: {e}");
                }
            }

            if disposition == CodexResumeDisposition::Failed {
                if let Some(turn) = select_codex_recovery_turn(&response, codex_turn_id) {
                    let raw_error = codex_turn_error_message(turn)
                        .unwrap_or_else(|| "Unknown Codex error".to_string());
                    let _ = app.emit_all(
                        "chat:error",
                        &ErrorEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            error: format_codex_user_error(&raw_error),
                        },
                    );
                }
                if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                    if let Err(e) = writer.crash() {
                        log::error!("Failed to mark failed Codex run crashed during recovery: {e}");
                    }
                }
                return Ok(true);
            }

            if disposition == CodexResumeDisposition::Interrupted {
                if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                    let assistant_message_id = uuid::Uuid::new_v4().to_string();
                    if run_was_explicitly_cancelled(app, session_id, run_id) {
                        if let Err(e) = writer.cancel(Some(&assistant_message_id), None) {
                            log::error!(
                                "Failed to cancel interrupted Codex run during recovery: {e}"
                            );
                        }
                    } else if let Err(e) = writer.crash() {
                        log::error!(
                            "Recovered Codex turn was interrupted without user cancel; \
                             failed to mark run crashed: {e}"
                        );
                    }
                }
                emit_codex_done(app, session_id, worktree_id);
                return Ok(true);
            }

            if has_result {
                log::trace!("Codex crash recovery: run {run_id} already has result in JSONL");
                // Run completed before the crash — mark as completed
                if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                    let assistant_message_id = uuid::Uuid::new_v4().to_string();
                    if let Err(e) = writer.complete(&assistant_message_id, None, None) {
                        log::error!("Failed to complete run during crash recovery: {e}");
                    } else if let Err(e) =
                        persist_codex_recovered_completion_state(app, session_id, run_id)
                    {
                        log::error!("Failed to persist Codex recovered completion state: {e}");
                    }
                }
                emit_codex_done(app, session_id, worktree_id);
                return Ok(true);
            }

            // No result in JSONL — thread/turn data from app-server was written above.
            // If the snapshot produced no assistant items AND a turn was in-flight
            // when Jean died, completing would lie to the user (status=done with an
            // empty response). Mark the run as crashed instead so the UI can prompt
            // a resend.
            let snapshot_has_assistant_content =
                select_codex_recovery_turn(&response, codex_turn_id)
                    .and_then(|turn| turn.get("items").and_then(|v| v.as_array()))
                    .map(|items| {
                        items.iter().any(|item| {
                            let normalized = normalize_item_types(item);
                            let item_type = normalized
                                .get("type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            item_type != "user_message" && item_type != "hook_prompt"
                        })
                    })
                    .unwrap_or(false);

            if had_active_turn && !snapshot_has_assistant_content {
                log::warn!(
                    "Codex crash recovery: thread idle with no assistant items for run {run_id}; marking crashed"
                );
                if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                    if let Err(e) = writer.crash() {
                        log::error!(
                            "Failed to mark Codex run crashed during recovery (empty snapshot): {e}"
                        );
                    }
                }
                emit_codex_done(app, session_id, worktree_id);
                return Ok(true);
            }

            log::trace!("Codex crash recovery: thread idle, marking run {run_id} as completed");
            if let Ok(mut writer) = RunLogWriter::resume(app, session_id, run_id) {
                let assistant_message_id = uuid::Uuid::new_v4().to_string();
                if let Err(e) = writer.complete(&assistant_message_id, None, None) {
                    log::error!("Failed to complete run during crash recovery: {e}");
                } else if let Err(e) =
                    persist_codex_recovered_completion_state(app, session_id, run_id)
                {
                    log::error!("Failed to persist Codex recovered completion state: {e}");
                }
            }
            emit_codex_done(app, session_id, worktree_id);
            Ok(true)
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

/// Emit a (possibly coalesced) `chat:chunk` batch.
fn emit_chunk_batch(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    content: String,
) {
    let _ = app.emit_all(
        "chat:chunk",
        &ChunkEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            content,
            run_id: Some(run_id.to_string()),
        },
    );
}

/// Emit a (possibly coalesced) `chat:thinking` batch.
fn emit_thinking_batch(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    content: String,
) {
    let _ = app.emit_all(
        "chat:thinking",
        &ThinkingEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            content,
        },
    );
}

/// Flush buffered text/thinking deltas. Must run before any other event is
/// emitted for this session and before terminal events (done/cancel/error)
/// so event ordering and content integrity are preserved.
fn flush_stream_coalescers(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    chunk_coalescer: &mut ChunkCoalescer,
    thinking_coalescer: &mut ChunkCoalescer,
) {
    if let Some(content) = chunk_coalescer.flush() {
        emit_chunk_batch(app, session_id, worktree_id, run_id, content);
    }
    if let Some(content) = thinking_coalescer.flush() {
        emit_thinking_batch(app, session_id, worktree_id, content);
    }
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
    status_poll_interval: Option<std::time::Duration>,
    recovery_turn_id: Option<&str>,
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

    // Coalesce token-rate text/thinking deltas into fewer, larger
    // chat:chunk / chat:thinking events. Flushed before any other event is
    // emitted and whenever the event stream idles past the window.
    let mut chunk_coalescer = ChunkCoalescer::new();
    let mut thinking_coalescer = ChunkCoalescer::new();

    // Open output file for history
    let mut output_writer = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output_file)
        .ok();

    'outer: loop {
        // While deltas are buffered, only wait until the coalescing window
        // deadline so text is not held back while the stream idles. At most
        // one coalescer is non-empty at a time (they flush each other), but
        // take the earliest deadline defensively.
        let coalesce_deadline = match (chunk_coalescer.deadline(), thinking_coalescer.deadline()) {
            (Some(chunk), Some(thinking)) => Some(chunk.min(thinking)),
            (chunk, thinking) => chunk.or(thinking),
        };
        let event = if let Some(deadline) = coalesce_deadline {
            let timeout = deadline.saturating_duration_since(std::time::Instant::now());
            match event_rx.recv_timeout(timeout) {
                Ok(e) => e,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    flush_stream_coalescers(
                        app,
                        session_id,
                        worktree_id,
                        run_id,
                        &mut chunk_coalescer,
                        &mut thinking_coalescer,
                    );
                    continue;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    log::warn!("Event channel disconnected for session {session_id}");
                    cancelled = true;
                    break 'outer;
                }
            }
        } else {
            match status_poll_interval {
                Some(interval) => match event_rx.recv_timeout(interval) {
                    Ok(e) => e,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        let snapshot = super::codex_server::send_request(
                            "thread/read",
                            serde_json::json!({
                                "threadId": thread_id,
                                "includeTurns": true,
                            }),
                        );
                        match snapshot {
                            Ok(snapshot) => {
                                let disposition =
                                    classify_codex_resume(&snapshot, recovery_turn_id, true);
                                if disposition == CodexResumeDisposition::Active {
                                    continue;
                                }

                                if let Some(ref mut writer) = output_writer {
                                    let _ = writer.flush();
                                }
                                if let Err(e) = append_codex_thread_snapshot_to_history_file(
                                    output_file,
                                    &snapshot,
                                    recovery_turn_id,
                                    false,
                                ) {
                                    log::warn!(
                                        "Failed to append Codex snapshot after idle poll: {e}"
                                    );
                                }

                                match disposition {
                                    CodexResumeDisposition::Failed => {
                                        if let Some(turn) =
                                            select_codex_recovery_turn(&snapshot, recovery_turn_id)
                                        {
                                            let raw_error = codex_turn_error_message(turn)
                                                .unwrap_or_else(|| {
                                                    "Unknown Codex error".to_string()
                                                });
                                            let _ = app.emit_all(
                                                "chat:error",
                                                &ErrorEvent {
                                                    session_id: session_id.to_string(),
                                                    worktree_id: worktree_id.to_string(),
                                                    error: format_codex_user_error(&raw_error),
                                                },
                                            );
                                        }
                                        error_emitted = true;
                                        break 'outer;
                                    }
                                    CodexResumeDisposition::Interrupted => {
                                        cancelled = true;
                                        server_interrupted = true;
                                        break 'outer;
                                    }
                                    CodexResumeDisposition::Idle => {
                                        break 'outer;
                                    }
                                    CodexResumeDisposition::Active => unreachable!(),
                                }
                            }
                            Err(e) => {
                                log::warn!("Codex recovery status poll failed: {e}");
                                continue;
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        log::warn!("Event channel disconnected for session {session_id}");
                        cancelled = true;
                        break 'outer;
                    }
                },
                None => match event_rx.recv() {
                    Ok(e) => e,
                    Err(_) => {
                        log::warn!("Event channel disconnected for session {session_id}");
                        cancelled = true;
                        break 'outer;
                    }
                },
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
                    run_id,
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
                    &mut chunk_coalescer,
                    &mut thinking_coalescer,
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
                        // Steer any prompts that were queued before the turn
                        // became steerable (auto-steer preference, default on).
                        super::commands::trigger_codex_queue_steer(
                            app.clone(),
                            worktree_id.to_string(),
                            session_id.to_string(),
                        );
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

                // Approval requests emit their own events — flush buffered
                // deltas first to preserve event ordering.
                flush_stream_coalescers(
                    app,
                    session_id,
                    worktree_id,
                    run_id,
                    &mut chunk_coalescer,
                    &mut thinking_coalescer,
                );
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
                flush_stream_coalescers(
                    app,
                    session_id,
                    worktree_id,
                    run_id,
                    &mut chunk_coalescer,
                    &mut thinking_coalescer,
                );
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

    // Flush any deltas still buffered when the loop exited (completion,
    // cancellation, disconnect) before the terminal events below.
    flush_stream_coalescers(
        app,
        session_id,
        worktree_id,
        run_id,
        &mut chunk_coalescer,
        &mut thinking_coalescer,
    );

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
                run_id: Some(run_id.to_string()),
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
        "item/fileChange/patchUpdated" => {
            let line = serde_json::json!({
                "type": "item.file_change.patch_updated",
                "item_id": params.get("itemId").cloned().unwrap_or(serde_json::Value::Null),
                "changes": params.get("changes").cloned().unwrap_or(serde_json::json!([])),
            });
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
    run_id: &str,
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
    chunk_coalescer: &mut ChunkCoalescer,
    thinking_coalescer: &mut ChunkCoalescer,
) {
    log::trace!("[codex-server] Notification: {method} for session {session_id}");

    // Ordering invariant: buffered deltas must be flushed before any other
    // event for this session is emitted. Text deltas only flush the thinking
    // buffer (and vice versa) so consecutive same-type deltas keep
    // coalescing; every other notification flushes both.
    match method {
        "item/agentMessage/delta" => {
            if let Some(content) = thinking_coalescer.flush() {
                emit_thinking_batch(app, session_id, worktree_id, content);
            }
        }
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            if let Some(content) = chunk_coalescer.flush() {
                emit_chunk_batch(app, session_id, worktree_id, run_id, content);
            }
        }
        _ => {
            flush_stream_coalescers(
                app,
                session_id,
                worktree_id,
                run_id,
                chunk_coalescer,
                thinking_coalescer,
            );
        }
    }

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
            // Streaming text delta — coalesced into batched chat:chunk events
            if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                if !delta.is_empty() {
                    full_content.push_str(delta);
                    if let Some(content) = chunk_coalescer.push(delta) {
                        emit_chunk_batch(app, session_id, worktree_id, run_id, content);
                    }
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
            // Keep structured steps separate from authoritative plan text.
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
                run_id,
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
                run_id,
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
        "item/fileChange/patchUpdated" => {
            let item_id = params.get("itemId").and_then(|v| v.as_str()).unwrap_or("");
            let changes = params
                .get("changes")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            let tool_id = upsert_file_change_tool_call(
                tool_calls,
                content_blocks,
                pending_tool_ids,
                item_id,
                changes.clone(),
            );
            let _ = app.emit_all(
                "chat:tool_use",
                &ToolUseEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    id: tool_id,
                    name: "FileChange".to_string(),
                    input: changes,
                    parent_tool_use_id: None,
                },
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
        "thread/goal/updated" => {
            let goal = super::commands::extract_codex_goal_objective(params);
            if let Err(e) =
                super::commands::persist_codex_goal(app, worktree_id, "", session_id, goal)
            {
                log::warn!("Failed to persist codex goal update: {e}");
            }
        }
        "thread/goal/cleared" => {
            if let Err(e) =
                super::commands::persist_codex_goal(app, worktree_id, "", session_id, None)
            {
                log::warn!("Failed to persist codex goal clear: {e}");
            }
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
        "account/rateLimits/updated" => {
            if let Err(e) =
                crate::codex_cli::update_codex_usage_from_app_server_rate_limits(app, params)
            {
                log::warn!("Failed to update Codex usage from rate limits notification: {e}");
            }
        }
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            // Streaming reasoning/thinking text — coalesced like text deltas
            if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                if !delta.is_empty() {
                    if let Some(content) = thinking_coalescer.push(delta) {
                        emit_thinking_batch(app, session_id, worktree_id, content);
                    }
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
                "subAgentActivity" => "sub_agent_activity",
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
        if let Some(thread_id) = obj.remove("agentThreadId") {
            obj.insert("agent_thread_id".to_string(), thread_id);
        }
        if let Some(agent_path) = obj.remove("agentPath") {
            obj.insert("agent_path".to_string(), agent_path);
        }
    }
    item
}

fn sub_agent_activity_tool(item: &serde_json::Value) -> Option<(&'static str, serde_json::Value)> {
    let kind = item.get("kind").and_then(|value| value.as_str())?;
    let thread_id = item
        .get("agent_thread_id")
        .or_else(|| item.get("agentThreadId"))
        .and_then(|value| value.as_str())?;
    let agent_path = item
        .get("agent_path")
        .or_else(|| item.get("agentPath"))
        .and_then(|value| value.as_str())
        .unwrap_or(thread_id);
    let (tool_name, agent_status) = match kind {
        "started" => ("SpawnAgent", "running"),
        "interacted" => ("SendInput", "running"),
        "interrupted" => ("CloseAgent", "interrupted"),
        _ => return None,
    };

    let mut agents_states = serde_json::Map::new();
    agents_states.insert(
        thread_id.to_string(),
        serde_json::json!({ "status": agent_status, "message": null }),
    );
    let input = serde_json::json!({
        "id": item.get("id").cloned().unwrap_or(serde_json::Value::Null),
        "type": "sub_agent_activity",
        "kind": kind,
        "prompt": agent_path,
        "receiver_thread_ids": [thread_id],
        "agents_states": agents_states,
        "status": "completed",
    });

    Some((tool_name, input))
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

            if is_plan_mode {
                log::trace!("Denying command approval in plan mode (rpc_id={rpc_id}): {command}");
                if let Err(e) = super::codex_server::send_response(
                    rpc_id,
                    serde_json::json!({"decision": "decline"}),
                ) {
                    log::error!(
                        "Failed to deny command approval in plan mode (rpc_id={rpc_id}): {e}"
                    );
                    emit_connection_error();
                }
                return;
            }

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
                additional_permissions: params.get("additionalPermissions").cloned(),
                available_decisions: params.get("availableDecisions").and_then(|value| {
                    serde_json::from_value::<Vec<serde_json::Value>>(value.clone()).ok()
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
            if is_plan_mode {
                log::trace!("Denying permissions request in plan mode (rpc_id={rpc_id})");
                if let Err(e) = super::codex_server::send_response(
                    rpc_id,
                    serde_json::json!({"permissions": {}, "scope": "turn"}),
                ) {
                    log::error!(
                        "Failed to deny permissions request in plan mode (rpc_id={rpc_id}): {e}"
                    );
                    emit_connection_error();
                }
                return;
            }

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
                cwd: params
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
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
                namespace: params
                    .get("namespace")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
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
        "account/chatgptAuthTokens/refresh" => {
            let previous_account_id = params
                .get("previousAccountId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let app = app.clone();
            let session_id = session_id.to_string();
            let worktree_id = worktree_id.to_string();
            tauri::async_runtime::spawn(async move {
                match crate::codex_cli::refresh_codex_app_server_auth_tokens(
                    app.clone(),
                    previous_account_id,
                )
                .await
                {
                    Ok(tokens) => {
                        let payload = match serde_json::to_value(tokens) {
                            Ok(payload) => payload,
                            Err(e) => {
                                let error =
                                    format!("Failed to serialize Codex auth refresh response: {e}");
                                log::error!("{error}");
                                if let Err(send_err) =
                                    super::codex_server::send_error_response(rpc_id, -32000, &error)
                                {
                                    log::error!(
                                        "Failed to send Codex auth refresh serialization error \
                                         (rpc_id={rpc_id}): {send_err}"
                                    );
                                }
                                return;
                            }
                        };
                        if let Err(e) = super::codex_server::send_response(rpc_id, payload) {
                            log::error!(
                                "Failed to send Codex auth refresh response (rpc_id={rpc_id}): {e}"
                            );
                        }
                    }
                    Err(error) => {
                        log::error!("Codex auth refresh request failed (rpc_id={rpc_id}): {error}");
                        let _ = app.emit_all(
                            "chat:error",
                            &ErrorEvent {
                                session_id,
                                worktree_id,
                                error: error.clone(),
                            },
                        );
                        if let Err(e) =
                            super::codex_server::send_error_response(rpc_id, -32000, &error)
                        {
                            log::error!(
                                "Failed to send Codex auth refresh error (rpc_id={rpc_id}): {e}"
                            );
                        }
                    }
                }
            });
        }
        "applyPatchApproval" | "execCommandApproval" => {
            let error = format!(
                "Deprecated Codex server request {method} is unsupported by Jean's current \
                 app-server flow."
            );
            log::warn!("{error}");
            if let Err(e) = super::codex_server::send_error_response(rpc_id, -32601, &error) {
                log::error!("Failed to reject deprecated Codex request (rpc_id={rpc_id}): {e}");
                emit_connection_error();
            }
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

fn upsert_file_change_tool_call(
    tool_calls: &mut Vec<ToolCall>,
    content_blocks: &mut Vec<ContentBlock>,
    pending_tool_ids: &mut HashMap<String, String>,
    item_id: &str,
    changes: serde_json::Value,
) -> String {
    let tool_id = if item_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        item_id.to_string()
    };

    if let Some(tool) = tool_calls.iter_mut().find(|tool| tool.id == tool_id) {
        tool.input = changes;
    } else {
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
    }

    if !item_id.is_empty() {
        pending_tool_ids.insert(item_id.to_string(), tool_id.clone());
    }

    tool_id
}

/// Process a single Codex JSONL event. Shared between attached and detached tailers.
#[allow(clippy::too_many_arguments)]
fn process_codex_event(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
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
                    let changes = item
                        .get("changes")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!([]));
                    let tool_id = upsert_file_change_tool_call(
                        tool_calls,
                        content_blocks,
                        pending_tool_ids,
                        item_id,
                        changes.clone(),
                    );
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
                                        run_id: Some(run_id.to_string()),
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
                "sub_agent_activity" => {
                    if let Some((tool_name, input)) = sub_agent_activity_tool(item) {
                        let tool_id = if item_id.is_empty() {
                            uuid::Uuid::new_v4().to_string()
                        } else {
                            item_id.to_string()
                        };
                        if let Some(tool) = tool_calls.iter_mut().find(|tool| tool.id == tool_id) {
                            tool.input = input.clone();
                        } else {
                            tool_calls.push(ToolCall {
                                id: tool_id.clone(),
                                name: tool_name.to_string(),
                                input: input.clone(),
                                output: Some("completed".to_string()),
                                parent_tool_use_id: None,
                            });
                            content_blocks.push(ContentBlock::ToolUse {
                                tool_call_id: tool_id.clone(),
                            });
                        }
                        let _ = app.emit_all(
                            "chat:tool_use",
                            &ToolUseEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                id: tool_id,
                                name: tool_name.to_string(),
                                input,
                                parent_tool_use_id: None,
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

/// Return true when a persisted Codex run log contains anything that should
/// render as assistant-side output, even if the run was cancelled before
/// metadata received a final assistant_message_id.
pub(crate) fn codex_run_log_has_visible_assistant_artifacts(
    lines: &[String],
    is_plan_mode: bool,
) -> bool {
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        if msg
            .get("_run_meta")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            continue;
        }

        match msg
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("")
        {
            "turn.plan_updated" | "item.plan.delta" if is_plan_mode => return true,
            "turn.completed" => {
                if msg
                    .get("output")
                    .and_then(extract_text_from_turn_output)
                    .is_some_and(|text| !text.trim().is_empty())
                {
                    return true;
                }
            }
            "item.started" | "item.completed" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                match item_type {
                    "agent_message" => {
                        if extract_agent_message_text(item)
                            .is_some_and(|text| !text.trim().is_empty())
                        {
                            return true;
                        }
                    }
                    "plan" if is_plan_mode => return true,
                    "command_execution" | "file_change" | "mcp_tool_call" | "collab_tool_call"
                    | "todo_list" | "web_search" | "image_generation" | "image_view"
                    | "context_compaction" | "dynamic_tool_call" => return true,
                    _ => {}
                }
            }
            _ => {}
        }
    }

    false
}

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
    // Crash-recovery snapshots renumber agent_message/reasoning items to
    // synthetic `item-N` ids while live notifications use real ids (msg_…,
    // rs_…). Track (type, text) → first id so the same item appended under
    // both id schemes renders once. Two REAL ids with identical text are
    // kept (legitimate repeated model output).
    let mut seen_text_items: std::collections::HashMap<(&'static str, String), String> =
        std::collections::HashMap::new();
    let mut is_duplicate_text_item = |kind: &'static str, text: &str, item_id: &str| -> bool {
        match seen_text_items.entry((kind, text.to_string())) {
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(item_id.to_string());
                false
            }
            std::collections::hash_map::Entry::Occupied(e) => {
                let first_id = e.get();
                first_id == item_id || first_id.starts_with("item-") || item_id.starts_with("item-")
            }
        }
    };

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
            // User text injected mid-turn via `turn/steer` (written by steer_codex_turn).
            // Codex's own userMessage items are filtered (unordered duplicates) —
            // this explicit line is the single source of truth for transcript order.
            "steered_user_message" => {
                if let Some(text) = msg.get("text").and_then(|v| v.as_str()) {
                    content_blocks.push(ContentBlock::UserInput {
                        text: text.to_string(),
                    });
                }
            }
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
                // Keep structured steps separate from authoritative plan text.
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
                let normalized_item =
                    normalize_item_types(msg.get("item").unwrap_or(&serde_json::Value::Null));
                let item = &normalized_item;
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
                            .unwrap_or_else(|| serde_json::json!([]));
                        upsert_file_change_tool_call(
                            &mut tool_calls,
                            &mut content_blocks,
                            &mut pending_tool_ids,
                            item_id,
                            changes,
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
            "item.file_change.patch_updated" => {
                let item_id = msg.get("item_id").and_then(|v| v.as_str()).unwrap_or("");
                let changes = msg
                    .get("changes")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([]));
                upsert_file_change_tool_call(
                    &mut tool_calls,
                    &mut content_blocks,
                    &mut pending_tool_ids,
                    item_id,
                    changes,
                );
            }
            "item.completed" => {
                let normalized_item =
                    normalize_item_types(msg.get("item").unwrap_or(&serde_json::Value::Null));
                let item = &normalized_item;
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
                            if is_duplicate_text_item("agent_message", &text, item_id) {
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
                            if is_duplicate_text_item("reasoning", text, item_id) {
                                continue;
                            }
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
                    "sub_agent_activity" => {
                        if let Some((tool_name, input)) = sub_agent_activity_tool(item) {
                            let tool_id = if item_id.is_empty() {
                                uuid::Uuid::new_v4().to_string()
                            } else {
                                item_id.to_string()
                            };
                            tool_calls.push(ToolCall {
                                id: tool_id.clone(),
                                name: tool_name.to_string(),
                                input,
                                output: Some("completed".to_string()),
                                parent_tool_use_id: None,
                            });
                            content_blocks.push(ContentBlock::ToolUse {
                                tool_call_id: tool_id,
                            });
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
///   `codex exec --json --model <model> --sandbox workspace-write --output-schema <schema> -`
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
    let cli_path = crate::codex_cli::resolve_cli_binary(app)?;

    if !crate::platform::resolved_cli_exists(&cli_path) {
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

    let wsl = crate::platform::get_wsl_config();
    let schema_arg = if cfg!(windows) && wsl.enabled {
        std::path::PathBuf::from(crate::platform::win_to_wsl_path(
            &schema_file.to_string_lossy(),
        ))
    } else {
        schema_file.clone()
    };
    let working_dir_arg = working_dir.map(|dir| {
        if cfg!(windows) && wsl.enabled {
            std::path::PathBuf::from(crate::platform::win_to_wsl_path(&dir.to_string_lossy()))
        } else {
            dir.to_path_buf()
        }
    });

    let mut cmd = crate::platform::resolved_cli_command(&cli_path, working_dir);
    cmd.args(build_one_shot_codex_args(
        actual_model,
        is_fast,
        &schema_arg,
        working_dir_arg.as_deref(),
    ));
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Run in a new process group so a timeout kill can take down the whole tree.
    // Codex spawns MCP server children (e.g. chrome-devtools-mcp) that survive a
    // plain child.kill() and linger as orphans.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    if !wsl.enabled {
        if let Some(dir) = working_dir {
            cmd.current_dir(dir);
        }
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

    log::debug!("Codex CLI one-shot spawned, waiting for output (timeout: 300s)...");

    // Drain stdout/stderr while waiting. Codex emits JSONL lifecycle events
    // before its final structured result; waiting for exit before reading can
    // fill the OS pipe buffer and deadlock the child.
    let timeout = std::time::Duration::from_secs(300);
    let start = std::time::Instant::now();
    let output = wait_for_child_output(&mut child, timeout).map_err(|error| {
        let _ = std::fs::remove_file(&schema_file);
        if error == "Process timed out" {
            "Codex CLI timed out after 300s. This often happens when an MCP server is stuck \
             connecting. Check your Codex MCP server configuration."
                .to_string()
        } else {
            error
        }
    })?;

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

fn wait_for_child_output(
    child: &mut std::process::Child,
    timeout: std::time::Duration,
) -> Result<std::process::Output, String> {
    use std::io::Read;

    let stdout = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut output = Vec::new();
            pipe.read_to_end(&mut output)
                .map(|_| output)
                .map_err(|error| format!("Failed to read process stdout: {error}"))
        })
    });
    let stderr = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut output = Vec::new();
            pipe.read_to_end(&mut output)
                .map(|_| output)
                .map_err(|error| format!("Failed to read process stderr: {error}"))
        })
    });

    let started_at = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started_at.elapsed() <= timeout => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = crate::platform::kill_process_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                join_output_reader(stdout)?;
                join_output_reader(stderr)?;
                return Err("Process timed out".to_string());
            }
            Err(error) => {
                let _ = crate::platform::kill_process_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed to check process status: {error}"));
            }
        }
    };

    Ok(std::process::Output {
        status,
        stdout: join_output_reader(stdout)?,
        stderr: join_output_reader(stderr)?,
    })
}

fn join_output_reader(
    reader: Option<std::thread::JoinHandle<Result<Vec<u8>, String>>>,
) -> Result<Vec<u8>, String> {
    reader
        .map(|handle| {
            handle
                .join()
                .map_err(|_| "Process output reader panicked".to_string())?
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

fn build_one_shot_codex_args(
    actual_model: &str,
    is_fast: bool,
    schema_file: &std::path::Path,
    working_dir: Option<&std::path::Path>,
) -> Vec<std::ffi::OsString> {
    let mut args = vec![
        "exec".into(),
        "--json".into(),
        "--model".into(),
        actual_model.into(),
        "--sandbox".into(),
        "workspace-write".into(),
        "--output-schema".into(),
        schema_file.as_os_str().to_os_string(),
        "-c".into(),
        format!("model_verbosity=\"{DEFAULT_MODEL_VERBOSITY}\"").into(),
    ];
    if is_fast {
        args.push("-c".into());
        args.push("service_tier=\"fast\"".into());
    }
    if let Some(dir) = working_dir {
        args.push("--cd".into());
        args.push(dir.as_os_str().to_os_string());
    } else {
        // One-shot calls that don't know a repository path should still run.
        args.push("--skip-git-repo-check".into());
    }
    args.push("-".into());
    args
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn one_shot_output_reader_does_not_deadlock_on_a_full_pipe() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "head -c 262144 /dev/zero"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();

        let output = wait_for_child_output(&mut child, std::time::Duration::from_secs(2)).unwrap();

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 262_144);
    }
    use crate::chat::types::{RunEntry, RunStatus};

    #[test]
    fn classify_codex_resume_reads_thread_status_object() {
        let response = serde_json::json!({
            "thread": {
                "status": { "type": "active" },
                "turns": [
                    { "id": "turn-1", "status": "inProgress" }
                ]
            }
        });

        assert_eq!(
            classify_codex_resume(&response, Some("turn-1"), true),
            CodexResumeDisposition::Active
        );
    }

    #[test]
    fn classify_codex_resume_completed_turn_is_idle() {
        let response = serde_json::json!({
            "thread": {
                "status": { "type": "idle" },
                "turns": [
                    { "id": "turn-1", "status": "completed" }
                ]
            }
        });

        assert_eq!(
            classify_codex_resume(&response, Some("turn-1"), true),
            CodexResumeDisposition::Idle
        );
    }

    #[test]
    fn classify_codex_resume_prefers_persisted_turn_status() {
        let response = serde_json::json!({
            "thread": {
                "status": { "type": "active" },
                "turns": [
                    { "id": "old-turn", "status": "completed" },
                    { "id": "new-turn", "status": "inProgress" }
                ]
            }
        });

        assert_eq!(
            classify_codex_resume(&response, Some("old-turn"), true),
            CodexResumeDisposition::Idle
        );
    }

    #[test]
    fn classify_codex_resume_detects_failed_and_interrupted_turns() {
        let failed = serde_json::json!({
            "thread": {
                "status": { "type": "idle" },
                "turns": [
                    { "id": "turn-1", "status": "failed" }
                ]
            }
        });
        let interrupted = serde_json::json!({
            "thread": {
                "status": { "type": "idle" },
                "turns": [
                    { "id": "turn-1", "status": "interrupted" }
                ]
            }
        });

        assert_eq!(
            classify_codex_resume(&failed, Some("turn-1"), true),
            CodexResumeDisposition::Failed
        );
        assert_eq!(
            classify_codex_resume(&interrupted, Some("turn-1"), true),
            CodexResumeDisposition::Interrupted
        );
    }

    #[test]
    fn parse_codex_run_updates_file_change_from_patch_updated() {
        let run = test_run_entry();
        let lines = vec![
            r#"{"type":"item.started","item":{"id":"fc-1","type":"file_change","changes":[]}}"#.to_string(),
            r#"{"type":"item.file_change.patch_updated","item_id":"fc-1","changes":[{"path":"src/lib.rs","kind":{"type":"update"},"diff":"@@ -1 +1 @@\n-old\n+new\n"}]}"#.to_string(),
        ];

        let msg = parse_codex_run_to_message(&lines, &run).expect("parse");
        let file_change = msg
            .tool_calls
            .iter()
            .find(|tool| tool.name == "FileChange")
            .expect("file change tool");

        assert_eq!(file_change.input[0]["path"], "src/lib.rs");
        assert!(file_change.input[0]["diff"]
            .as_str()
            .expect("diff")
            .contains("+new"));
    }

    #[test]
    fn codex_thread_snapshot_history_lines_normalizes_and_skips_user_items() {
        let response = serde_json::json!({
            "thread": {
                "status": { "type": "idle" },
                "turns": [
                    {
                        "id": "turn-1",
                        "status": "completed",
                        "items": [
                            {
                                "id": "user-1",
                                "type": "userMessage",
                                "text": "prompt"
                            },
                            {
                                "id": "cmd-1",
                                "type": "commandExecution",
                                "command": "rtk git status",
                                "aggregatedOutput": "clean"
                            },
                            {
                                "id": "msg-1",
                                "type": "agentMessage",
                                "text": "done"
                            }
                        ]
                    }
                ]
            }
        });

        let lines = codex_thread_snapshot_history_lines(&response, Some("turn-1"), true);
        assert_eq!(lines.len(), 5);
        assert!(lines.iter().all(|line| !line.contains("userMessage")));
        assert_eq!(
            lines.last().map(String::as_str),
            Some(r#"{"type":"result"}"#)
        );

        let first: serde_json::Value = serde_json::from_str(&lines[0]).expect("json line");
        assert_eq!(first["type"], "item.started");
        assert_eq!(first["item"]["type"], "command_execution");
        assert_eq!(first["item"]["aggregated_output"], "clean");

        let agent: serde_json::Value = serde_json::from_str(&lines[3]).expect("json line");
        assert_eq!(agent["type"], "item.completed");
        assert_eq!(agent["item"]["type"], "agent_message");
        assert_eq!(agent["item"]["text"], "done");
    }

    fn test_run_entry() -> RunEntry {
        serde_json::from_value(serde_json::json!({
            "run_id": "run-1",
            "user_message_id": "u1",
            "user_message": "hi",
            "started_at": 0,
            "status": "completed"
        }))
        .expect("test RunEntry")
    }

    #[test]
    fn parse_codex_run_dedupes_snapshot_and_live_ids_for_same_text() {
        // Live notifications use real ids (msg_…); crash-recovery snapshots
        // renumber the same items to synthetic item-N ids. The parser must
        // render the item once.
        let run = test_run_entry();
        let lines = vec![
            r#"{"type":"item.completed","item":{"id":"msg_abc","type":"agent_message","text":"Hello"}}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"item-2","type":"agent_message","text":"Hello"}}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"rs_abc","type":"reasoning","text":"thinking…"}}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"item-1","type":"reasoning","text":"thinking…"}}"#.to_string(),
        ];

        let msg = parse_codex_run_to_message(&lines, &run).expect("parse");
        assert_eq!(msg.content, "Hello");
        let text_blocks = msg
            .content_blocks
            .iter()
            .filter(|b| matches!(b, ContentBlock::Text { .. }))
            .count();
        let thinking_blocks = msg
            .content_blocks
            .iter()
            .filter(|b| matches!(b, ContentBlock::Thinking { .. }))
            .count();
        assert_eq!(text_blocks, 1);
        assert_eq!(thinking_blocks, 1);
    }

    #[test]
    fn parse_codex_run_keeps_repeated_text_from_distinct_real_ids() {
        let run = test_run_entry();
        let lines = vec![
            r#"{"type":"item.completed","item":{"id":"msg_a","type":"agent_message","text":"Done."}}"#.to_string(),
            r#"{"type":"item.completed","item":{"id":"msg_b","type":"agent_message","text":"Done."}}"#.to_string(),
        ];

        let msg = parse_codex_run_to_message(&lines, &run).expect("parse");
        assert_eq!(msg.content, "Done.Done.");
    }

    #[test]
    fn snapshot_append_skips_text_items_already_written_under_live_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let output_file = tmp.path().join("run.jsonl");
        std::fs::write(
            &output_file,
            concat!(
                r#"{"type":"item.completed","item":{"id":"msg_abc","type":"agent_message","text":"Hello"}}"#,
                "\n"
            ),
        )
        .unwrap();

        let response = serde_json::json!({
            "thread": {
                "status": { "type": "active" },
                "turns": [
                    {
                        "id": "turn-1",
                        "status": "inProgress",
                        "items": [
                            { "id": "item-2", "type": "agentMessage", "text": "Hello" },
                            { "id": "item-3", "type": "agentMessage", "text": "New content" }
                        ]
                    }
                ]
            }
        });

        append_codex_thread_snapshot_to_history_file(
            &output_file,
            &response,
            Some("turn-1"),
            false,
        )
        .expect("append");

        let contents = std::fs::read_to_string(&output_file).unwrap();
        assert_eq!(
            contents.matches("\"text\":\"Hello\"").count(),
            1,
            "duplicate snapshot of live-written item must be skipped: {contents}"
        );
        assert!(contents.contains("New content"));
    }

    #[test]
    fn snapshot_history_lines_match_live_notification_lines_byte_for_byte() {
        // The resume backfill relies on exact-line dedupe between snapshot
        // lines (thread/resume) and live lines (item/completed notifications).
        // Both must serialize identically for the same item.
        let item = serde_json::json!({
            "id": "msg-1",
            "type": "agentMessage",
            "text": "done"
        });

        let live_params = serde_json::json!({ "item": item });
        let live_line = notification_to_history_line("item/completed", &live_params)
            .expect("live history line");

        let response = serde_json::json!({
            "thread": {
                "status": { "type": "active" },
                "turns": [
                    {
                        "id": "turn-1",
                        "status": "inProgress",
                        "items": [item]
                    }
                ]
            }
        });
        let snapshot_lines = codex_thread_snapshot_history_lines(&response, Some("turn-1"), false);

        assert!(
            snapshot_lines.contains(&live_line),
            "snapshot lines {snapshot_lines:?} must contain live line {live_line}"
        );
    }

    #[test]
    fn normalize_item_types_supports_v2_sub_agent_activity() {
        let item = serde_json::json!({
            "id": "call-1",
            "type": "subAgentActivity",
            "kind": "started",
            "agentThreadId": "agent-1",
            "agentPath": "/root/reviewer"
        });

        let normalized = normalize_item_types(&item);

        assert_eq!(normalized["type"], "sub_agent_activity");
        assert_eq!(normalized["agent_thread_id"], "agent-1");
        assert_eq!(normalized["agent_path"], "/root/reviewer");
    }

    #[test]
    fn parse_codex_run_surfaces_v2_sub_agent_activity() {
        let run = test_run_entry();
        let lines = vec![
            r#"{"type":"item.completed","item":{"id":"call-1","type":"subAgentActivity","kind":"started","agentThreadId":"agent-1","agentPath":"/root/reviewer"}}"#.to_string(),
        ];

        let message = parse_codex_run_to_message(&lines, &run).expect("message");
        let agent = message
            .tool_calls
            .iter()
            .find(|tool| tool.name == "SpawnAgent")
            .expect("spawned agent tool");

        assert_eq!(agent.input["receiver_thread_ids"][0], "agent-1");
        assert_eq!(agent.input["prompt"], "/root/reviewer");
        assert_eq!(agent.input["agents_states"]["agent-1"]["status"], "running");
    }

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
    fn gpt_5_5_fast_enables_fast_service_tier() {
        let params = build_thread_start_params(
            std::path::Path::new("/tmp"),
            Some("gpt-5.5-fast"),
            Some("plan"),
            false,
            None,
            false,
            None,
        );
        assert_eq!(params["model"], "gpt-5.5");
        assert_eq!(params["serviceTier"], "fast");
    }

    #[test]
    fn split_fast_model_recognises_gpt_5_6_preview_fast_models() {
        assert_eq!(split_fast_model("gpt-5.6-sol-fast"), ("gpt-5.6-sol", true));
        assert_eq!(
            split_fast_model("gpt-5.6-terra-fast"),
            ("gpt-5.6-terra", true)
        );
        assert_eq!(
            split_fast_model("gpt-5.6-luna-fast"),
            ("gpt-5.6-luna", true)
        );
        assert_eq!(split_fast_model("gpt-5.6-fast"), ("gpt-5.6-sol", true));
        assert_eq!(split_fast_model("gpt-5.6"), ("gpt-5.6-sol", false));
        assert_eq!(split_fast_model("gpt-5-6-sol"), ("gpt-5.6-sol", false));
        assert_eq!(split_fast_model("gpt-5-6-sol-fast"), ("gpt-5.6-sol", true));
    }

    #[test]
    fn split_fast_model_recognises_gpt_5_5_fast() {
        assert_eq!(split_fast_model("gpt-5.5-fast"), ("gpt-5.5", true));
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
    fn one_shot_codex_args_use_workspace_write_sandbox() {
        let schema_file = std::path::Path::new("/tmp/jean-codex-schema.json");
        let working_dir = std::path::Path::new("/tmp/project");

        let args = build_one_shot_codex_args("gpt-5.4", false, schema_file, Some(working_dir));

        assert!(args.windows(2).any(|window| {
            window
                == [
                    std::ffi::OsString::from("--sandbox"),
                    std::ffi::OsString::from("workspace-write"),
                ]
        }));
        assert!(!args
            .iter()
            .any(|arg| arg == &std::ffi::OsString::from("--full-auto")));
        let output_schema_position = args
            .iter()
            .position(|arg| arg == "--output-schema")
            .expect("--output-schema arg is present");
        assert_eq!(
            args.get(output_schema_position + 1),
            Some(&schema_file.as_os_str().to_os_string()),
            "schema path must immediately follow --output-schema"
        );
    }

    #[test]
    fn codex_thread_params_default_to_low_model_verbosity() {
        let params = build_thread_start_params(
            std::path::Path::new("/tmp"),
            Some("gpt-5.6-sol"),
            Some("build"),
            false,
            None,
            false,
            None,
        );

        assert_eq!(params["config"]["model_verbosity"], "low");
    }

    #[test]
    fn one_shot_codex_args_default_to_low_model_verbosity() {
        let args = build_one_shot_codex_args(
            "gpt-5.6-sol",
            false,
            std::path::Path::new("/tmp/jean-codex-schema.json"),
            Some(std::path::Path::new("/tmp/project")),
        );

        assert!(args.windows(2).any(|window| {
            window
                == [
                    std::ffi::OsString::from("-c"),
                    std::ffi::OsString::from("model_verbosity=\"low\""),
                ]
        }));
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
    fn plan_mode_uses_never_approval_policy_and_read_only_sandbox() {
        let params = build_thread_start_params(
            std::path::Path::new("/tmp"),
            Some("gpt-5.4"),
            Some("plan"),
            false,
            None,
            false,
            None,
        );
        assert_eq!(params["approvalPolicy"], "never");
        assert_eq!(params["sandbox"], "read-only");
    }

    #[test]
    fn plan_turn_always_uses_read_only_sandbox_policy() {
        let params = build_turn_start_params(
            "thread-1",
            "hello",
            std::path::Path::new("/tmp/worktree"),
            Some("plan"),
            None,
            &[],
            &[],
        );
        let policy = &params["sandboxPolicy"];
        assert_eq!(policy["type"], "readOnly");
        assert_eq!(policy["writableRoots"].as_array().unwrap().len(), 0);
        assert_eq!(policy["readOnlyAccess"]["type"], "fullAccess");
        assert_eq!(policy["networkAccess"], true);
    }

    #[test]
    fn build_turn_uses_workspace_write_sandbox_policy() {
        let params = build_turn_start_params(
            "thread-1",
            "hello",
            std::path::Path::new("/tmp/worktree"),
            Some("build"),
            None,
            &["/tmp/context".to_string()],
            &["/tmp/git".to_string()],
        );
        let policy = &params["sandboxPolicy"];
        assert_eq!(policy["type"], "workspaceWrite");
        assert_eq!(
            policy["writableRoots"],
            serde_json::json!(["/tmp/worktree", "/tmp/context", "/tmp/git"])
        );
        assert_eq!(policy["readOnlyAccess"]["type"], "fullAccess");
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
    fn yolo_turn_uses_danger_full_access_even_with_writable_roots() {
        let params = build_turn_start_params(
            "thread-1",
            "prompt",
            std::path::Path::new("/repo/worktree"),
            Some("yolo"),
            None,
            &[],
            &["/repo/.git/worktrees/worktree".to_string()],
        );

        assert_eq!(params["sandboxPolicy"]["type"], "dangerFullAccess");
    }

    #[test]
    fn yolo_turn_uses_danger_full_access_without_writable_roots() {
        let params = build_turn_start_params(
            "thread-1",
            "prompt",
            std::path::Path::new("/repo/worktree"),
            Some("yolo"),
            None,
            &[],
            &[],
        );

        assert_eq!(params["sandboxPolicy"]["type"], "dangerFullAccess");
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
            backend: None,
            custom_profile_name: None,
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
            grok_session_id: None,
            kimi_session_id: None,
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
    fn build_turn_steer_params_shape() {
        let params = build_turn_steer_params("thread-1", "turn-1", "do this next");

        assert_eq!(params["threadId"], "thread-1");
        assert_eq!(params["expectedTurnId"], "turn-1");
        let input = params["input"].as_array().expect("input array");
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "text");
        assert_eq!(input[0]["text"], "do this next");
    }

    #[test]
    fn parse_run_orders_steered_user_message_between_items() {
        let lines = vec![
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"Before steer"}}"#
                .to_string(),
            r#"{"type":"steered_user_message","text":"also check tests"}"#.to_string(),
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"After steer"}}"#
                .to_string(),
        ];
        let run = RunEntry {
            run_id: "run-3".to_string(),
            user_message_id: "user-3".to_string(),
            user_message: "prompt".to_string(),
            model: None,
            execution_mode: Some("build".to_string()),
            thinking_level: None,
            effort_level: None,
            backend: None,
            custom_profile_name: None,
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
            grok_session_id: None,
            kimi_session_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.content_blocks.len(), 3);
        assert!(matches!(
            &message.content_blocks[0],
            ContentBlock::Text { text } if text == "Before steer"
        ));
        assert!(matches!(
            &message.content_blocks[1],
            ContentBlock::UserInput { text } if text == "also check tests"
        ));
        assert!(matches!(
            &message.content_blocks[2],
            ContentBlock::Text { text } if text == "After steer"
        ));
        // Steered text must not leak into the assistant content blob.
        assert!(!message.content.contains("also check tests"));
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
            backend: None,
            custom_profile_name: None,
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
            grok_session_id: None,
            kimi_session_id: None,
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
            backend: None,
            custom_profile_name: None,
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
            grok_session_id: None,
            kimi_session_id: None,
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
    fn codex_run_log_visible_artifacts_detects_cancelled_tool_output_without_agent_id() {
        let lines = vec![
            r#"{"_run_meta":true}"#.to_string(),
            r#"{"type":"turn.started"}"#.to_string(),
            r#"{"item":{"aggregated_output":null,"command":"rtk test","id":"call-1","status":"inProgress","type":"command_execution"},"type":"item.started"}"#.to_string(),
        ];

        assert!(codex_run_log_has_visible_assistant_artifacts(&lines, false));
    }

    #[test]
    fn codex_run_log_visible_artifacts_ignores_user_only_cancelled_run() {
        let lines = vec![
            r#"{"_run_meta":true}"#.to_string(),
            r#"{"type":"turn.started"}"#.to_string(),
            r#"{"item":{"content":[{"text":"continue","type":"text"}],"id":"user-1","type":"user_message"},"type":"item.completed"}"#.to_string(),
        ];

        assert!(!codex_run_log_has_visible_assistant_artifacts(
            &lines, false
        ));
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
            backend: None,
            custom_profile_name: None,
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
            grok_session_id: None,
            kimi_session_id: None,
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
            backend: None,
            custom_profile_name: None,
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
            grok_session_id: None,
            kimi_session_id: None,
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
            backend: None,
            custom_profile_name: None,
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
            grok_session_id: None,
            kimi_session_id: None,
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
            backend: None,
            custom_profile_name: None,
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
            grok_session_id: None,
            kimi_session_id: None,
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.content, "Recovered from turn output");
        assert!(message.content_blocks.iter().any(|block| matches!(
            block,
            ContentBlock::Text { text } if text == "Recovered from turn output"
        )));
    }

    #[test]
    fn structured_output_uses_final_schema_valid_agent_message() {
        let output = concat!(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"{\"title\":\"Preparing release notes\",\"body\":\"I’ll inspect the commits first.\"}"}}"#,
            "\n",
            r#"{"type":"item.completed","item":{"type":"command_execution","command":"git log","aggregated_output":"commits"}}"#,
            "\n",
            r####"{"type":"item.completed","item":{"type":"agent_message","text":"{\"title\":\"Release notes\",\"body\":\"### Fixes\\n- Fixed session recovery.\"}"}}"####,
            "\n",
            r#"{"type":"turn.completed"}"#,
        );

        assert_eq!(
            extract_codex_structured_output(output).unwrap(),
            r####"{"title":"Release notes","body":"### Fixes\n- Fixed session recovery."}"####
        );
    }
}

/// Parse Codex NDJSON output to extract structured JSON from --output-schema response.
///
/// Codex emits newline-delimited JSON events. We look for the structured output
/// in several possible locations:
/// - `item.completed` with type `agent_message` containing JSON text
/// - `turn.completed` with an `output` field
fn extract_codex_structured_output(output: &str) -> Result<String, String> {
    let mut structured_output = None;

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
                                structured_output = Some(text);
                            }
                        }
                    }
                }
            }
            "turn.completed" => {
                // Check for output field directly
                if let Some(output_val) = parsed.get("output") {
                    if let Some(text) = extract_text_from_turn_output(output_val) {
                        if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
                            structured_output = Some(text);
                        }
                    } else if !output_val.is_null() {
                        structured_output = Some(output_val.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    structured_output.ok_or_else(|| "No structured output found in Codex response".to_string())
}
