//! Devin CLI execution engine.
//!
//! Uses Devin's ACP server (`devin acp`) so Jean can render streamed text and
//! tool lifecycle events in the shared chat UI. This implementation is the
//! minimal attached ACP path; detached survival can be added once the basic
//! backend is stable.

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum DevinStreamItem {
    Text(String),
    Thinking(String),
    ToolStart {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        output: String,
    },
}

pub struct DevinResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

pub struct DevinExecutionOptions<'a> {
    pub app: &'a AppHandle,
    pub jean_session_id: &'a str,
    pub worktree_id: &'a str,
    pub working_dir: &'a Path,
    pub existing_devin_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub execution_mode: Option<&'a str>,
    pub message: &'a str,
    pub system_prompt: Option<&'a str>,
    pub pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
}

pub(crate) fn devin_permission_mode(mode: Option<&str>) -> &'static str {
    match mode.unwrap_or("plan") {
        "yolo" => "dangerous",
        _ => "normal",
    }
}

fn devin_model(model: Option<&str>) -> Option<&str> {
    model
        .and_then(|value| value.strip_prefix("devin/").or(Some(value)))
        .filter(|value| !value.is_empty() && *value != "default")
}

fn update_from_message(value: &Value) -> Option<&Value> {
    value.get("params").and_then(|params| params.get("update"))
}

fn text_content(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    value.as_array().map(|items| {
        items
            .iter()
            .filter_map(|item| {
                item.get("content")
                    .and_then(|content| content.get("text"))
                    .and_then(Value::as_str)
                    .or_else(|| item.get("text").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

pub(crate) fn parse_devin_stream_item(value: &Value) -> Option<DevinStreamItem> {
    let update = update_from_message(value)?;
    match update.get("sessionUpdate").and_then(Value::as_str)? {
        "agent_message_chunk" => Some(DevinStreamItem::Text(text_content(update.get("content")?)?)),
        "agent_thought_chunk" => Some(DevinStreamItem::Thinking(text_content(
            update.get("content")?,
        )?)),
        "tool_call" => Some(DevinStreamItem::ToolStart {
            id: update
                .get("toolCallId")
                .or_else(|| update.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            name: update
                .get("title")
                .or_else(|| update.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            input: update
                .get("rawInput")
                .or_else(|| update.get("input"))
                .cloned()
                .unwrap_or(Value::Null),
        }),
        "tool_call_update" | "tool_call_result" => Some(DevinStreamItem::ToolResult {
            id: update
                .get("toolCallId")
                .or_else(|| update.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            output: text_content(update.get("content").unwrap_or(&Value::Null))
                .or_else(|| {
                    update
                        .get("output")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_default(),
        }),
        _ => None,
    }
}

fn send_request(
    stdin: &mut ChildStdin,
    id: i64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
    )
    .map_err(|error| format!("Failed to write Devin ACP request: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Failed to flush Devin ACP request: {error}"))
}

fn send_response(stdin: &mut ChildStdin, id: &Value, result: Value) -> Result<(), String> {
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
    )
    .map_err(|error| format!("Failed to write Devin ACP response: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Failed to flush Devin ACP response: {error}"))
}

fn handle_reverse_request(
    stdin: &mut ChildStdin,
    value: &Value,
    execution_mode: Option<&str>,
) -> Result<bool, String> {
    let Some(id) = value.get("id") else {
        return Ok(false);
    };
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return Ok(false);
    };
    if method != "session/request_permission" {
        return Ok(false);
    }
    let allow = !matches!(execution_mode, None | Some("plan"));
    let options = value
        .get("params")
        .and_then(|params| params.get("options"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let preferred = if allow {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };
    let selected = preferred.iter().find_map(|kind| {
        options.iter().find_map(|option| {
            (option.get("kind").and_then(Value::as_str) == Some(*kind))
                .then(|| option.get("optionId").and_then(Value::as_str))
                .flatten()
        })
    });
    let result = match selected {
        Some(option_id) => {
            serde_json::json!({"outcome": {"outcome": "selected", "optionId": option_id}})
        }
        None => serde_json::json!({"outcome": {"outcome": "cancelled"}}),
    };
    send_response(stdin, id, result)?;
    Ok(true)
}

fn read_response(
    reader: &mut BufReader<ChildStdout>,
    stdin: &mut ChildStdin,
    id: i64,
    execution_mode: Option<&str>,
) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|error| format!("Failed to read Devin ACP response: {error}"))?
            == 0
        {
            return Err("Devin ACP exited before responding".to_string());
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if handle_reverse_request(stdin, &value, execution_mode)? {
            continue;
        }
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Devin ACP request failed: {error}"));
            }
            return Ok(value);
        }
    }
}

fn session_id_from_response(value: &Value) -> Option<String> {
    value
        .get("result")
        .and_then(|result| result.get("sessionId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn push_text_block(blocks: &mut Vec<ContentBlock>, text: &str) {
    if let Some(ContentBlock::Text { text: existing }) = blocks.last_mut() {
        existing.push_str(text);
    } else {
        blocks.push(ContentBlock::Text {
            text: text.to_string(),
        });
    }
}

fn usage_from_value(usage: &Value) -> UsageData {
    UsageData {
        input_tokens: usage
            .get("input_tokens")
            .or_else(|| usage.get("inputTokens"))
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        output_tokens: usage
            .get("output_tokens")
            .or_else(|| usage.get("outputTokens"))
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        cache_read_input_tokens: usage
            .get("cache_read_input_tokens")
            .or_else(|| usage.get("cacheReadInputTokens"))
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        cache_creation_input_tokens: usage
            .get("cache_creation_input_tokens")
            .or_else(|| usage.get("cacheCreationInputTokens"))
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    }
}

fn usage_from_result(value: &Value) -> Option<UsageData> {
    value
        .pointer("/result/_meta/usage")
        .or_else(|| value.pointer("/result/usage"))
        .map(usage_from_value)
}

fn prompt_blocks(message: &str) -> Value {
    Value::Array(vec![serde_json::json!({"type": "text", "text": message})])
}

fn prepared_message(message: &str, system_prompt: Option<&str>) -> String {
    match system_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(prompt) => {
            format!("<system_instructions>\n{prompt}\n</system_instructions>\n\n{message}")
        }
        None => message.to_string(),
    }
}

fn emit(app: &AppHandle, event: &str, value: Value) {
    let _ = app.emit_all(event, &value);
}

fn configure_session(
    reader: &mut BufReader<ChildStdout>,
    stdin: &mut ChildStdin,
    next_id: &mut i64,
    session_id: &str,
    model: Option<&str>,
    execution_mode: Option<&str>,
) -> Result<(), String> {
    let mut configure = |config_id: &str, value: &str| -> Result<(), String> {
        let id = *next_id;
        *next_id += 1;
        send_request(
            stdin,
            id,
            "session/set_config_option",
            serde_json::json!({"sessionId": session_id, "configId": config_id, "value": value}),
        )?;
        read_response(reader, stdin, id, execution_mode)?;
        Ok(())
    };

    if let Err(error) = configure("permission-mode", devin_permission_mode(execution_mode)) {
        log::debug!("Devin ACP did not accept permission-mode config: {error}");
    }
    if let Some(model) = devin_model(model) {
        if let Err(error) = configure("model", model) {
            log::debug!("Devin ACP did not accept model config: {error}");
        }
    }
    Ok(())
}

fn apply_stream_item(response: &mut DevinResponse, item: DevinStreamItem) {
    match item {
        DevinStreamItem::Text(text) => {
            response.content.push_str(&text);
            push_text_block(&mut response.content_blocks, &text);
        }
        DevinStreamItem::Thinking(thinking) => response
            .content_blocks
            .push(ContentBlock::Thinking { thinking }),
        DevinStreamItem::ToolStart { id, name, input } => {
            if !response.tool_calls.iter().any(|tool| tool.id == id) {
                response.content_blocks.push(ContentBlock::ToolUse {
                    tool_call_id: id.clone(),
                });
                response.tool_calls.push(ToolCall {
                    id,
                    name,
                    input,
                    output: None,
                    parent_tool_use_id: None,
                });
            }
        }
        DevinStreamItem::ToolResult { id, output } => {
            if let Some(tool) = response.tool_calls.iter_mut().find(|tool| tool.id == id) {
                tool.output = Some(output);
            }
        }
    }
}

fn execute_devin_child(
    child: &mut Child,
    options: DevinExecutionOptions<'_>,
) -> Result<DevinResponse, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture Devin ACP stdout")?;
    let mut stdin = child.stdin.take().ok_or("Failed to open Devin ACP stdin")?;
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = String::new();
            let _ = stderr.read_to_string(&mut sink);
            if !sink.trim().is_empty() {
                log::debug!("[Devin ACP stderr] {}", sink.trim());
            }
        });
    }
    let mut reader = BufReader::new(stdout);
    let mut next_id = 1;

    send_request(
        &mut stdin,
        next_id,
        "initialize",
        serde_json::json!({"protocolVersion": 1, "clientCapabilities": {}}),
    )?;
    let init = read_response(&mut reader, &mut stdin, next_id, options.execution_mode)?;
    next_id += 1;

    let auth_method = init
        .pointer("/result/authMethods")
        .and_then(Value::as_array)
        .and_then(|methods| methods.first())
        .and_then(|method| method.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("login");
    send_request(
        &mut stdin,
        next_id,
        "authenticate",
        serde_json::json!({"methodId": auth_method, "_meta": {"headless": true}}),
    )?;
    read_response(&mut reader, &mut stdin, next_id, options.execution_mode)
        .map_err(|_| "Devin CLI is not authenticated. Run `devin auth login`.".to_string())?;
    next_id += 1;

    let (method, params) = match options
        .existing_devin_session_id
        .filter(|id| !id.is_empty())
    {
        Some(session_id) => (
            "session/resume",
            serde_json::json!({"sessionId": session_id, "cwd": options.working_dir.to_string_lossy(), "mcpServers": []}),
        ),
        None => (
            "session/new",
            serde_json::json!({"cwd": options.working_dir.to_string_lossy(), "mcpServers": []}),
        ),
    };
    send_request(&mut stdin, next_id, method, params)?;
    let session_response = read_response(&mut reader, &mut stdin, next_id, options.execution_mode)?;
    next_id += 1;
    let session_id = session_id_from_response(&session_response)
        .or_else(|| options.existing_devin_session_id.map(ToOwned::to_owned))
        .ok_or("Devin ACP did not return a session id")?;

    configure_session(
        &mut reader,
        &mut stdin,
        &mut next_id,
        &session_id,
        options.model,
        options.execution_mode,
    )?;

    let message = prepared_message(options.message, options.system_prompt);
    send_request(
        &mut stdin,
        next_id,
        "session/prompt",
        serde_json::json!({"sessionId": session_id, "prompt": prompt_blocks(&message)}),
    )?;
    let prompt_id = next_id;

    let mut response = DevinResponse {
        content: String::new(),
        session_id,
        tool_calls: Vec::new(),
        content_blocks: Vec::new(),
        cancelled: false,
        usage: None,
    };

    let mut line = String::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|error| format!("Failed to read Devin ACP stream: {error}"))?
            == 0
        {
            return Err("Devin ACP exited before the turn completed".to_string());
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if handle_reverse_request(&mut stdin, &value, options.execution_mode)? {
            continue;
        }
        if let Some(item) = parse_devin_stream_item(&value) {
            match &item {
                DevinStreamItem::Text(text) => emit(
                    options.app,
                    "chat:chunk",
                    serde_json::json!({"session_id": options.jean_session_id, "worktree_id": options.worktree_id, "content": text}),
                ),
                DevinStreamItem::Thinking(thinking) => emit(
                    options.app,
                    "chat:thinking",
                    serde_json::json!({"session_id": options.jean_session_id, "worktree_id": options.worktree_id, "content": thinking}),
                ),
                DevinStreamItem::ToolStart { id, name, input } => {
                    emit(
                        options.app,
                        "chat:tool_use",
                        serde_json::json!({"session_id": options.jean_session_id, "worktree_id": options.worktree_id, "id": id, "name": name, "input": input}),
                    );
                    emit(
                        options.app,
                        "chat:tool_block",
                        serde_json::json!({"session_id": options.jean_session_id, "worktree_id": options.worktree_id, "tool_call_id": id}),
                    );
                }
                DevinStreamItem::ToolResult { id, output } => emit(
                    options.app,
                    "chat:tool_result",
                    serde_json::json!({"session_id": options.jean_session_id, "worktree_id": options.worktree_id, "tool_use_id": id, "output": output}),
                ),
            }
            apply_stream_item(&mut response, item);
        }
        if value.get("id").and_then(Value::as_i64) == Some(prompt_id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Devin ACP prompt failed: {error}"));
            }
            response.usage = usage_from_result(&value);
            response.cancelled =
                value.pointer("/result/stopReason").and_then(Value::as_str) == Some("cancelled");
            break;
        }
    }
    response.content = response.content.trim().to_string();
    Ok(response)
}

pub fn execute_devin(mut options: DevinExecutionOptions<'_>) -> Result<DevinResponse, String> {
    let cli_path = crate::devin_cli::config::resolve_cli_binary(options.app);
    if !crate::devin_cli::config::binary_exists(&cli_path) {
        return Err("Devin CLI not installed".to_string());
    }

    let mut command =
        crate::platform::cli_command(&cli_path.to_string_lossy(), Some(options.working_dir));
    command
        .arg("acp")
        .current_dir(options.working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("JEAN_SESSION_ID", options.jean_session_id)
        .env("JEAN_WORKTREE_ID", options.worktree_id);
    let (depth_key, depth_value) = super::jean_mcp::child_depth_env();
    command.env(depth_key, depth_value);
    let jean_session_id = options.jean_session_id.to_string();
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Devin ACP: {error}"))?;
    let pid = child.id();
    if let Some(callback) = options.pid_callback.take() {
        callback(pid);
    }
    if !super::registry::register_process(options.jean_session_id.to_string(), pid) {
        let _ = child.kill();
        return Ok(DevinResponse {
            content: String::new(),
            session_id: options
                .existing_devin_session_id
                .unwrap_or_default()
                .to_string(),
            tool_calls: Vec::new(),
            content_blocks: Vec::new(),
            cancelled: true,
            usage: None,
        });
    }
    let result = execute_devin_child(&mut child, options);
    let cancelled = !super::registry::is_process_running(&jean_session_id);
    super::registry::unregister_process(&jean_session_id);
    let _ = child.kill();
    let _ = child.wait();
    match result {
        Ok(mut response) => {
            response.cancelled |= cancelled;
            Ok(response)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_agent_message_chunk_from_acp_session_update() {
        let value = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": [{"type": "text", "text": "hello"}]
                }
            }
        });

        assert_eq!(
            parse_devin_stream_item(&value),
            Some(DevinStreamItem::Text("hello".to_string()))
        );
    }

    #[test]
    fn maps_jean_execution_modes_to_devin_permission_modes() {
        assert_eq!(devin_permission_mode(Some("plan")), "normal");
        assert_eq!(devin_permission_mode(Some("build")), "normal");
        assert_eq!(devin_permission_mode(Some("yolo")), "dangerous");
    }
}
