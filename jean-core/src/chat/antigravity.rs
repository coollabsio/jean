//! Antigravity CLI (`agy`) chat execution engine.
//!
//! Uses Antigravity's headless streaming mode:
//!   `agy -p <prompt> --output-format stream-json [--model M] [--effort E]
//!        [--conversation ID] [--dangerously-skip-permissions]`
//!
//! stream-json emits newline-delimited JSON events: `init`, `step_update`
//! (incremental `text_delta` for `agent_response` steps + `tool` steps), and a
//! final `result` (carrying `conversation_id`, `status`, `usage`). Jean streams
//! assistant text as `chat:chunk` events, captures the conversation id for
//! resume, and returns tool calls / content blocks in the response.
//!
//! Limitations vs Claude/Codex (headless mode constraints):
//! - No interactive per-tool approval; execution mode maps to permission flags.
//! - No separate thinking/reasoning stream (only `thinking_tokens` counted).
//! - Usage is per-run token counts, not subscription quota.
//! - System prompt is embedded into the prompt (no per-invocation flag).
//!
//! Docs: <https://antigravity.google/docs/cli/headless>

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use tauri::AppHandle;

#[derive(serde::Serialize, Clone)]
struct ChunkEvent {
    session_id: String,
    worktree_id: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct DoneEvent {
    session_id: String,
    worktree_id: String,
    waiting_for_plan: bool,
}

pub struct AntigravityResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

/// Strip the `antigravity/` model-id prefix used internally by Jean; `default`
/// omits the `--model` flag entirely (let the CLI pick).
fn normalize_model_for_cli(model: Option<&str>) -> Option<String> {
    let model = model.map(str::trim).filter(|value| !value.is_empty())?;
    let stripped = model.strip_prefix("antigravity/").unwrap_or(model);
    if stripped.is_empty() || stripped == "default" {
        return None;
    }
    Some(stripped.to_string())
}

/// `agy --effort` accepts only low|medium|high. Map Jean's richer effort levels
/// down (minimal→low, xhigh/max/ultracode→high); anything else omits the flag.
fn clamp_effort(effort: Option<&str>) -> Option<&'static str> {
    match effort.map(str::trim)? {
        "low" | "minimal" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" | "max" | "ultracode" => Some("high"),
        _ => None,
    }
}

fn build_prompt(system_context: Option<&str>, message: &str) -> String {
    let mut prompt = String::new();
    if let Some(ctx) = system_context.map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str("<jean_context>\n");
        prompt.push_str(ctx);
        prompt.push_str("\n</jean_context>\n\n");
    }
    prompt.push_str(message);
    prompt
}

fn usage_from_event(value: &serde_json::Value) -> Option<UsageData> {
    let usage = value.get("usage")?;
    let get = |key: &str| usage.get(key).and_then(serde_json::Value::as_u64);
    Some(UsageData {
        input_tokens: get("input_tokens").unwrap_or(0),
        output_tokens: get("output_tokens").unwrap_or(0),
        cache_read_input_tokens: get("cache_read_tokens").unwrap_or(0),
        cache_creation_input_tokens: 0,
    })
}

/// Accumulated state while parsing the stream-json event stream.
#[derive(Default)]
struct StreamState {
    content: String,
    conversation_id: String,
    tool_calls: Vec<ToolCall>,
    content_blocks: Vec<ContentBlock>,
    usage: Option<UsageData>,
    /// True when text has been appended since the last tool block, so we can
    /// coalesce consecutive text deltas into one Text content block.
    open_text_block: bool,
    error: Option<String>,
}

impl StreamState {
    fn push_text(&mut self, delta: &str) {
        self.content.push_str(delta);
        if self.open_text_block {
            if let Some(ContentBlock::Text { text }) = self.content_blocks.last_mut() {
                text.push_str(delta);
                return;
            }
        }
        self.content_blocks.push(ContentBlock::Text {
            text: delta.to_string(),
        });
        self.open_text_block = true;
    }

    fn capture_conversation_id(&mut self, value: &serde_json::Value) {
        if self.conversation_id.is_empty() {
            if let Some(id) = value.get("conversation_id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    self.conversation_id = id.to_string();
                }
            }
        }
    }
}

/// Parse a single stream-json line, mutating accumulated state and returning any
/// text delta that should be streamed to the frontend as a `chat:chunk`.
///
/// Real `agy` stream-json shape (verified against agy 1.1.9): each line is
/// `{"event":"<name>", "<name>":{...payload...}}` — the discriminator is `event`
/// and the fields are nested under the event-named key (NOT top-level). Events:
/// `init` (`conversation_id` at top level), `step_update` (payload has
/// `step_index`, `state`, `step_type`, `text_delta?`, `tool_name?`, `tool_info?`,
/// `usage?`), and `result` (`status`, `response`, `usage`). Tool steps carry
/// `tool_info = {name, parameters, output}` — the tool input is `parameters` and
/// there is no id, so calls are correlated by `step_index`.
fn handle_line(state: &mut StreamState, line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let event = value.get("event").and_then(|v| v.as_str()).unwrap_or("");
    // conversation_id lives at top level (init/result) or inside the payload.
    state.capture_conversation_id(&value);
    let payload = value.get(event);
    if let Some(p) = payload {
        state.capture_conversation_id(p);
    }

    match event {
        "step_update" => {
            let p = payload?;
            let step_type = p.get("step_type").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(delta) = p.get("text_delta").and_then(|v| v.as_str()) {
                if !delta.is_empty() {
                    state.push_text(delta);
                    return Some(delta.to_string());
                }
            }
            if step_type == "tool" {
                let state_field = p.get("state").and_then(|v| v.as_str()).unwrap_or("");
                let step_index = p.get("step_index").and_then(|v| v.as_u64()).unwrap_or(0);
                let tool_info = p.get("tool_info");
                let tool_name = p
                    .get("tool_name")
                    .or_else(|| tool_info.and_then(|t| t.get("name")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                // `agy` tool steps carry no id; the step_index is stable across the
                // ACTIVE→DONE pair, so use it to correlate call + output.
                let id = format!("agy_tool_{step_index}");
                if state_field == "DONE" {
                    let output =
                        tool_info
                            .and_then(|t| t.get("output"))
                            .map(|v| match v.as_str() {
                                Some(s) => s.to_string(),
                                None => v.to_string(),
                            });
                    if let Some(existing) = state.tool_calls.iter_mut().find(|tc| tc.id == id) {
                        if existing.output.is_none() {
                            existing.output = output;
                        }
                        return None;
                    }
                }
                if !state.tool_calls.iter().any(|tc| tc.id == id) {
                    let input = tool_info
                        .and_then(|t| t.get("parameters").cloned())
                        .unwrap_or(serde_json::Value::Null);
                    state.tool_calls.push(ToolCall {
                        id: id.clone(),
                        name: tool_name,
                        input,
                        output: None,
                        parent_tool_use_id: None,
                    });
                    state
                        .content_blocks
                        .push(ContentBlock::ToolUse { tool_call_id: id });
                    state.open_text_block = false;
                }
            }
        }
        "result" => {
            let p = payload.unwrap_or(&value);
            if let Some(usage) = usage_from_event(p) {
                state.usage = Some(usage);
            }
            let status = p.get("status").and_then(|v| v.as_str()).unwrap_or("");
            // CANCELED/INTERRUPTED are handled via the process exit code (130).
            if status == "ERROR" || status == "INVALID" {
                state.error = p
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or_else(|| Some(format!("Antigravity run ended with status {status}")));
            }
            // If no streamed text arrived, fall back to the final `response` field.
            if state.content.is_empty() {
                if let Some(response) = p.get("response").and_then(|v| v.as_str()) {
                    if !response.is_empty() {
                        state.push_text(response);
                        return Some(response.to_string());
                    }
                }
            }
        }
        _ => {}
    }
    None
}

#[allow(clippy::too_many_arguments)]
pub fn execute_antigravity_headless(
    app: &AppHandle,
    jean_session_id: &str,
    worktree_id: &str,
    run_id: &str,
    working_dir: &Path,
    execution_mode: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    message: &str,
    system_context: Option<&str>,
    resume_conversation_id: Option<&str>,
    mcp_config: Option<&str>,
    pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
) -> Result<(u32, AntigravityResponse), String> {
    let binary_path = crate::antigravity_cli::resolve_cli_binary(app);
    if !crate::antigravity_cli::binary_exists(&binary_path) {
        log::warn!(
            "Antigravity CLI not found for session={} worktree={} resolved_path={}",
            jean_session_id,
            worktree_id,
            binary_path.display()
        );
        return Err(
            "Antigravity CLI (`agy`) not found. Install it and sign in with your Google account."
                .to_string(),
        );
    }

    let mode = execution_mode.unwrap_or("build");
    let prompt = build_prompt(system_context, message);

    // Trust the workspace up front so a headless run never blocks on the
    // interactive trust prompt.
    crate::antigravity_cli::auto_trust_workspace(working_dir);
    // Sync Jean's managed MCP server into ~/.gemini/config/mcp_config.json so
    // `agy` can load it for this turn (or removes it when session-disabled).
    crate::antigravity_cli::mcp::sync_jean_mcp_config(mcp_config);

    let mut command =
        crate::platform::cli_command(&binary_path.to_string_lossy(), Some(working_dir));
    // Clear parent-agent workspace env so `agy` resolves cwd/conversation itself
    // (Jean may itself be launched from within an Antigravity session).
    command
        .env_remove("ANTIGRAVITY_PROJECT_ID")
        .env_remove("ANTIGRAVITY_CONVERSATION_ID")
        .env_remove("ANTIGRAVITY_LS_ADDRESS")
        .env_remove("ANTIGRAVITY_TRAJECTORY_ID")
        .env_remove("ANTIGRAVITY_AGENT")
        .env_remove("ANTIGRAVITY_SOURCE_METADATA");
    command
        .arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("stream-json");
    if let Some(cli_model) = normalize_model_for_cli(model) {
        command.arg("--model").arg(cli_model);
    }
    // `agy --effort` only accepts low|medium|high — clamp Jean's richer levels.
    if let Some(effort) = clamp_effort(effort) {
        command.arg("--effort").arg(effort);
    }
    if let Some(resume_id) = resume_conversation_id.filter(|id| !id.is_empty()) {
        command.arg("--conversation").arg(resume_id);
    } else {
        // No prior conversation for this Jean session → start a fresh project so
        // `agy` doesn't silently continue the most-recent unrelated conversation.
        command.arg("--new-project");
    }
    // Headless mode cannot request interactive approval; map Jean execution mode
    // to `agy`'s native controls (verified flags: `--mode accept-edits|plan`,
    // `--dangerously-skip-permissions`):
    // - plan → `--mode plan` (read-only planning; native)
    // - build → `--mode accept-edits` (auto-apply edits; commands still gated)
    // - yolo → `--dangerously-skip-permissions` (auto-approve everything)
    match mode {
        "yolo" => {
            command.arg("--dangerously-skip-permissions");
        }
        "build" => {
            command.args(["--mode", "accept-edits"]);
        }
        _ => {
            command.args(["--mode", "plan"]);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    log::info!(
        "Starting Antigravity headless run session={} worktree={} mode={} binary={} cwd={} resume={:?}",
        jean_session_id,
        worktree_id,
        mode,
        binary_path.display(),
        working_dir.display(),
        resume_conversation_id
    );

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Antigravity CLI: {e}"))?;
    let pid = child.id();
    if let Some(cb) = pid_callback {
        cb(pid);
    }

    let mut state = StreamState::default();
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if let Some(delta) = handle_line(&mut state, &line) {
                let _ = app.emit_all(
                    "chat:chunk",
                    &ChunkEvent {
                        session_id: jean_session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        content: delta,
                        run_id: Some(run_id.to_string()),
                    },
                );
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for Antigravity CLI: {e}"))?;

    let conversation_id = if state.conversation_id.is_empty() {
        resume_conversation_id.unwrap_or_default().to_string()
    } else {
        state.conversation_id.clone()
    };

    // Exit 130 = SIGINT (user cancellation).
    if !status.success() && status.code() == Some(130) {
        let _ = app.emit_all(
            "chat:done",
            &DoneEvent {
                session_id: jean_session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                waiting_for_plan: false,
            },
        );
        return Ok((
            pid,
            AntigravityResponse {
                content: state.content,
                session_id: conversation_id,
                tool_calls: state.tool_calls,
                content_blocks: state.content_blocks,
                cancelled: true,
                usage: state.usage,
            },
        ));
    }

    if let Some(error) = state.error {
        return Err(format!("Antigravity: {error}"));
    }
    if !status.success() && state.content.is_empty() {
        return Err(format!(
            "Antigravity run failed (exit {:?}).",
            status.code()
        ));
    }

    let _ = app.emit_all(
        "chat:done",
        &DoneEvent {
            session_id: jean_session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            waiting_for_plan: false,
        },
    );

    log::info!(
        "Antigravity run completed session={} conversation_id={:?} content_bytes={} tool_calls={}",
        jean_session_id,
        conversation_id,
        state.content.len(),
        state.tool_calls.len()
    );

    Ok((
        pid,
        AntigravityResponse {
            content: state.content,
            session_id: conversation_id,
            tool_calls: state.tool_calls,
            content_blocks: state.content_blocks,
            cancelled: false,
            usage: state.usage,
        },
    ))
}

/// One-shot headless execution for magic prompts (session naming, PR content,
/// commit messages, …). Returns the final assistant text. When `json_schema` is
/// provided, requests structured output and returns the `structured_output` JSON
/// (or the raw response text if the CLI does not surface structured output).
pub fn execute_one_shot_antigravity(
    app: &AppHandle,
    prompt: &str,
    working_dir: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let binary_path = crate::antigravity_cli::resolve_cli_binary(app);
    if !crate::antigravity_cli::binary_exists(&binary_path) {
        return Err("Antigravity CLI (`agy`) not found.".to_string());
    }
    let cwd = working_dir.map(Path::new);
    let mut command = crate::platform::cli_command(&binary_path.to_string_lossy(), cwd);
    command
        .arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("json")
        .arg("--dangerously-skip-permissions");
    if let Some(cli_model) = normalize_model_for_cli(model) {
        command.arg("--model").arg(cli_model);
    }
    command.stdin(Stdio::null());
    let output = command
        .output()
        .map_err(|e| format!("Failed to run Antigravity one-shot: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Antigravity one-shot failed".to_string()
        } else {
            stderr
        });
    }
    Ok(parse_one_shot_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Extract the useful payload from a `--output-format json` envelope.
///
/// Verified against agy 1.1.9: the envelope is a single top-level object with
/// keys `{conversation_id, status, response, structured_output, json_schema,
/// usage, ...}` — `structured_output` and `response` are TOP-LEVEL (unlike the
/// stream-json `result` event, which nests them). Prefer structured output,
/// then the response text, else the raw stdout.
fn parse_one_shot_output(stdout: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if let Some(structured) = value.get("structured_output") {
            if !structured.is_null() {
                return structured.to_string();
            }
        }
        if let Some(response) = value.get("response").and_then(|v| v.as_str()) {
            return response.trim().to_string();
        }
    }
    stdout.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_shot_extracts_structured_output_then_response() {
        // Real agy `--output-format json` envelope: fields are TOP-LEVEL.
        let with_schema = r#"{"conversation_id":"c","status":"SUCCESS","response":"v2.14.3","structured_output":{"major":2,"minor":14,"patch":3},"json_schema":{},"usage":{}}"#;
        assert_eq!(
            parse_one_shot_output(with_schema),
            r#"{"major":2,"minor":14,"patch":3}"#
        );
        let text_only =
            r#"{"conversation_id":"c","status":"SUCCESS","response":"a title","usage":{}}"#;
        assert_eq!(parse_one_shot_output(text_only), "a title");
        // Non-JSON / plain text falls through to raw stdout.
        assert_eq!(parse_one_shot_output("  hello  "), "hello");
    }

    #[test]
    fn normalize_model_strips_prefix_and_default() {
        assert_eq!(
            normalize_model_for_cli(Some("antigravity/gemini-3-pro")),
            Some("gemini-3-pro".to_string())
        );
        assert_eq!(normalize_model_for_cli(Some("antigravity/default")), None);
        assert_eq!(normalize_model_for_cli(Some("  ")), None);
    }

    #[test]
    fn clamp_effort_maps_to_agy_levels() {
        assert_eq!(clamp_effort(Some("minimal")), Some("low"));
        assert_eq!(clamp_effort(Some("low")), Some("low"));
        assert_eq!(clamp_effort(Some("medium")), Some("medium"));
        assert_eq!(clamp_effort(Some("high")), Some("high"));
        assert_eq!(clamp_effort(Some("xhigh")), Some("high"));
        assert_eq!(clamp_effort(Some("max")), Some("high"));
        assert_eq!(clamp_effort(Some("adaptive")), None);
        assert_eq!(clamp_effort(None), None);
    }

    #[test]
    fn stream_parses_text_deltas_and_conversation_id() {
        // Verified against agy 1.1.9: `event` discriminator + nested payload.
        let mut state = StreamState::default();
        let lines = [
            r#"{"event":"init","conversation_id":"conv-1","init":{"model":"gemini-3.5-flash-low","cwd":"/tmp","permission_mode":"always-proceed"}}"#,
            r#"{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello"}}"#,
            r#"{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":" world"}}"#,
            r#"{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","usage":{"input_tokens":10,"output_tokens":5,"thinking_tokens":2,"cache_read_tokens":1,"total_tokens":18}}}"#,
        ];
        let mut deltas = Vec::new();
        for line in lines {
            if let Some(delta) = handle_line(&mut state, line) {
                deltas.push(delta);
            }
        }
        assert_eq!(deltas, vec!["Hello".to_string(), " world".to_string()]);
        assert_eq!(state.content, "Hello world");
        assert_eq!(state.conversation_id, "conv-1");
        let usage = state.usage.expect("usage present");
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 5);
        assert_eq!(usage.cache_read_input_tokens, 1);
        assert_eq!(state.content_blocks.len(), 1);
    }

    #[test]
    fn stream_captures_tool_call_and_output() {
        // Verified tool shape: tool_info={name,parameters,output}, no id (keyed by step_index).
        let mut state = StreamState::default();
        let lines = [
            r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"list_dir","tool_info":{"name":"list_dir","parameters":{"DirectoryPath":"/tmp"}}}}"#,
            r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"tool","tool_name":"list_dir","tool_info":{"name":"list_dir","parameters":{"DirectoryPath":"/tmp"},"output":".git/\njean/"}}}"#,
        ];
        for line in lines {
            handle_line(&mut state, line);
        }
        assert_eq!(state.tool_calls.len(), 1);
        assert_eq!(state.tool_calls[0].id, "agy_tool_3");
        assert_eq!(state.tool_calls[0].name, "list_dir");
        assert_eq!(
            state.tool_calls[0].input,
            serde_json::json!({"DirectoryPath": "/tmp"})
        );
        assert_eq!(state.tool_calls[0].output.as_deref(), Some(".git/\njean/"));
        assert!(matches!(
            state.content_blocks.as_slice(),
            [ContentBlock::ToolUse { tool_call_id }] if tool_call_id == "agy_tool_3"
        ));
    }

    #[test]
    fn result_response_used_when_no_stream_text() {
        let mut state = StreamState::default();
        let delta = handle_line(
            &mut state,
            r#"{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"final answer","usage":{"input_tokens":1,"output_tokens":1}}}"#,
        );
        assert_eq!(delta.as_deref(), Some("final answer"));
        assert_eq!(state.content, "final answer");
    }
}
