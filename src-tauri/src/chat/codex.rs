//! Codex CLI execution engine
//!
//! Uses `codex app-server` (a persistent JSON-RPC 2.0 server over stdio) for
//! all chat interactions. Threads and turns are managed via JSON-RPC requests;
//! streamed responses arrive as notifications and are mapped to Tauri events.
//!
//! One-shot operations (commit messages, PR content, etc.) still use `codex exec`
//! directly since they don't need streaming.

use super::claude::CancelledEvent;
use super::types::{ContentBlock, PermissionDenial, PermissionDeniedEvent, ToolCall, UsageData};
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

// =============================================================================
// App-server param builders
// =============================================================================

/// Split "gpt-5.4-fast" → ("gpt-5.4", true). Only gpt-5.4-fast is recognised;
/// older models that happened to end in `-fast` are left unchanged.
fn split_fast_model(model: &str) -> (&str, bool) {
    match model {
        "gpt-5.4-fast" => ("gpt-5.4", true),
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
    instructions_file: Option<&std::path::Path>,
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
        log::debug!(
            "Codex thread params: model={actual_model}, fast={is_fast}, mode={:?}",
            execution_mode
        );
        params["model"] = serde_json::json!(actual_model);
        if is_fast {
            params["serviceTier"] = serde_json::json!("fast");
        }
    }

    // Permission mode mapping
    match execution_mode.unwrap_or("plan") {
        "build" => {
            params["approvalPolicy"] = serde_json::json!("untrusted");
            params["sandbox"] = serde_json::json!("workspace-write");
        }
        "yolo" => {
            params["approvalPolicy"] = serde_json::json!("never");
            params["sandbox"] = serde_json::json!("danger-full-access");
        }
        // "plan" or default: read-only sandbox
        _ => {
            params["sandbox"] = serde_json::json!("read-only");
        }
    }

    // Config overrides
    let mut config = serde_json::Map::new();

    // Web search
    config.insert(
        "web_search".to_string(),
        serde_json::json!(if search_enabled { "live" } else { "disabled" }),
    );

    // Custom instructions file
    if let Some(path) = instructions_file {
        config.insert(
            "experimental_instructions_file".to_string(),
            serde_json::json!(path.to_string_lossy()),
        );
    }

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

    // Sandbox policy with writable roots (for build/yolo modes with add_dirs)
    let mode = execution_mode.unwrap_or("plan");
    if mode == "build" && !add_dirs.is_empty() {
        let mut writable_roots: Vec<serde_json::Value> =
            vec![serde_json::json!(working_dir.to_string_lossy())];
        for dir in add_dirs {
            writable_roots.push(serde_json::json!(dir));
        }
        params["sandboxPolicy"] = serde_json::json!({
            "type": "workspaceWrite",
            "writableRoots": writable_roots,
            "readOnlyAccess": { "type": "fullAccess" },
            "networkAccess": false,
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
    output_file: &std::path::Path,
    working_dir: &std::path::Path,
    existing_thread_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    reasoning_effort: Option<&str>,
    search_enabled: bool,
    add_dirs: &[String],
    prompt: &str,
    instructions_file: Option<&std::path::Path>,
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
                instructions_file,
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
                        instructions_file,
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
                instructions_file,
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

    // Build turn params
    let turn_params = build_turn_start_params(
        &thread_id,
        prompt,
        working_dir,
        execution_mode,
        reasoning_effort,
        add_dirs,
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

    // Set the thread_id on the response
    let mut resp = response;
    if resp.thread_id.is_empty() {
        resp.thread_id = thread_id;
    }

    Ok(resp)
}

/// Start a new Codex thread via app-server.
fn start_new_thread(
    working_dir: &std::path::Path,
    model: Option<&str>,
    execution_mode: Option<&str>,
    search_enabled: bool,
    instructions_file: Option<&std::path::Path>,
    multi_agent_enabled: bool,
    max_agent_threads: Option<u32>,
) -> Result<String, String> {
    use super::codex_server;

    let params = build_thread_start_params(
        working_dir,
        model,
        execution_mode,
        search_enabled,
        instructions_file,
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
    thread_id: &str,
    output_file: &std::path::Path,
    is_plan_mode: bool,
    is_build_mode: bool,
    event_rx: &std::sync::mpsc::Receiver<super::codex_server::ServerEvent>,
) -> CodexResponse {
    use super::codex_server::ServerEvent;
    use std::io::Write;
    use std::time::Duration;

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

    loop {
        let event = match event_rx.recv_timeout(Duration::from_secs(300)) {
            Ok(e) => e,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                log::warn!("Turn event timeout for session {session_id}");
                let _ = app.emit_all(
                    "chat:error",
                    &ErrorEvent {
                        session_id: session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        error: "Codex response timed out".to_string(),
                    },
                );
                error_emitted = true;
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                log::warn!("Event channel disconnected for session {session_id}");
                cancelled = true;
                break;
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
                );

                // Update turn_id for cancellation
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
                break;
            }
        }

        if completed {
            break;
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

    // Emit chat:done unless error was emitted
    if !cancelled && !error_emitted {
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
                waiting_for_plan: is_plan_mode && !full_content.is_empty(),
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
        "item/started" => {
            let item = params.get("item").unwrap_or(&serde_json::Value::Null);
            // Map camelCase item types to our event processing
            // App-server uses camelCase: commandExecution, fileChange, mcpToolCall, etc.
            let event_item = normalize_item_types(item);
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
            if event_item.get("type").and_then(|v| v.as_str()) == Some("agent_message") {
                *received_completed_agent_message = true;
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
            log::trace!("Unhandled app-server notification: {method}");
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
    is_build_mode: bool,
) {
    match method {
        "item/fileChange/requestApproval" => {
            // Auto-accept file changes in build mode
            if is_build_mode {
                log::trace!("Auto-accepting file change (rpc_id={rpc_id})");
                if let Err(e) = super::codex_server::send_response(
                    rpc_id,
                    serde_json::json!({"decision": "accept"}),
                ) {
                    log::error!("Failed to auto-accept file change: {e}");
                }
            } else {
                // In non-build modes, also auto-accept (read-only sandbox prevents actual changes)
                let _ = super::codex_server::send_response(
                    rpc_id,
                    serde_json::json!({"decision": "accept"}),
                );
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
                log::trace!(
                    "Auto-accepting CLI command (rpc_id={rpc_id}): {command}"
                );
                let _ = super::codex_server::send_response(
                    rpc_id,
                    serde_json::json!({"decision": "accept"}),
                );
                return;
            }

            log::trace!("Command approval requested (rpc_id={rpc_id}): {command}");

            let denial = PermissionDenial {
                tool_name: "Bash".to_string(),
                tool_use_id: item_id,
                tool_input: serde_json::json!({ "command": command }),
                rpc_id: Some(rpc_id),
            };
            let _ = app.emit_all(
                "chat:permission_denied",
                &PermissionDeniedEvent {
                    session_id: session_id.to_string(),
                    worktree_id: worktree_id.to_string(),
                    denials: vec![denial],
                },
            );
            // Response will come from approve_codex_command Tauri command
        }
        _ => {
            log::debug!("Unknown approval request method: {method}");
            // Auto-accept unknown approvals to avoid blocking
            let _ = super::codex_server::send_response(
                rpc_id,
                serde_json::json!({"decision": "accept"}),
            );
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
                    let tool_name = match collab_tool {
                        "spawn_agent" => "SpawnAgent",
                        "send_input" => "SendInput",
                        "wait" => "WaitForAgents",
                        "close_agent" => "CloseAgent",
                        _ => collab_tool,
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
                // These types are handled on completion only (via deltas / dedicated events)
                "agent_message" | "reasoning" | "user_message" => {}
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
                    let changes = item
                        .get("changes")
                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                        .unwrap_or_default();
                    let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                    if !tool_id.is_empty() {
                        if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                            tc.output = Some(changes.clone());
                        }
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_id,
                                output: changes,
                            },
                        );
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
                // User's own input echoed back — no UI needed
                "user_message" => {}
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

    let mut content = String::new();
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
            "item.started" => {
                let item = msg.get("item").unwrap_or(&serde_json::Value::Null);
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");

                match item_type {
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
                        let tool_name = match collab_tool {
                            "spawn_agent" => "SpawnAgent",
                            "send_input" => "SendInput",
                            "wait" => "WaitForAgents",
                            "close_agent" => "CloseAgent",
                            _ => collab_tool,
                        };
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
                    "agent_message" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            if run.cancelled && content == text {
                                continue;
                            }
                            content.push_str(text);
                            content_blocks.push(ContentBlock::Text {
                                text: text.to_string(),
                            });
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
                        let changes = item
                            .get("changes")
                            .map(|v| serde_json::to_string(v).unwrap_or_default())
                            .unwrap_or_default();
                        let tool_id = pending_tool_ids.remove(item_id).unwrap_or_default();
                        if !tool_id.is_empty() {
                            if let Some(tc) = tool_calls.iter_mut().find(|t| t.id == tool_id) {
                                tc.output = Some(changes);
                            }
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
    fn split_fast_model_passes_through_normal_models() {
        assert_eq!(split_fast_model("gpt-5.4"), ("gpt-5.4", false));
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
        };

        let message = parse_codex_run_to_message(&lines, &run).expect("message");

        assert_eq!(message.content, "Same text");
        assert_eq!(
            message.content_blocks,
            vec![ContentBlock::Text {
                text: "Same text".to_string(),
            }]
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
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            last_agent_message = Some(text.to_string());
                        }
                        // Also check content array
                        if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                            for block in content {
                                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        last_agent_message = Some(text.to_string());
                                    }
                                }
                                // Check for output_text type (structured output)
                                if block.get("type").and_then(|t| t.as_str()) == Some("output_text")
                                {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        // Try to parse as JSON — if it works, it's our structured output
                                        if serde_json::from_str::<serde_json::Value>(text).is_ok() {
                                            return Ok(text.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "turn.completed" => {
                // Check for output field directly
                if let Some(output_val) = parsed.get("output") {
                    if !output_val.is_null() {
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
