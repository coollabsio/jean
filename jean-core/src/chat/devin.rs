//! Devin CLI execution engine.
//!
//! Uses Devin's ACP server (`devin acp`) so Jean can render streamed text and
//! tool lifecycle events in the shared chat UI. This implementation is the
//! attached ACP path. Every update is persisted before it is emitted. Local
//! execution stops when Jean exits; cloud work belongs to the remote service.

use super::devin_protocol;
use super::types::{
    ChatMessage, ContentBlock, DevinLocation, MessageRole, RunEntry, ToolCall, UsageData,
};
use crate::http_server::EmitExt;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum DevinStreamItem {
    Text(String),
    Thinking(String),
    ToolStart {
        id: String,
        name: String,
        input: Value,
        output: Option<String>,
        status: Option<String>,
    },
    ToolUpdate {
        id: String,
        name: Option<String>,
        input: Option<Value>,
        output: Option<String>,
        status: Option<String>,
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
    pub location: super::types::DevinLocation,
    pub mcp_config: Option<&'a str>,
    pub output_file: &'a Path,
    pub config_overrides: &'a std::collections::HashMap<String, String>,
    pub existing_devin_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub execution_mode: Option<&'a str>,
    pub message: &'a str,
    pub system_prompt: Option<&'a str>,
    pub pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
}

pub(crate) fn devin_permission_mode(mode: Option<&str>) -> &'static str {
    match mode.unwrap_or("plan") {
        "yolo" => "bypass",
        "build" => "accept-edits",
        _ => "plan",
    }
}

fn devin_model(model: Option<&str>) -> Option<&str> {
    model
        .and_then(|value| value.strip_prefix("devin/").or(Some(value)))
        .filter(|value| !value.is_empty() && *value != "default")
}

fn update_from_message(value: &Value) -> Option<&Value> {
    if value.get("method").and_then(Value::as_str) != Some("session/update") {
        return None;
    }
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

fn tool_output(update: &Value) -> Option<String> {
    update
        .get("content")
        .and_then(text_content)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            update
                .get("rawOutput")
                .or_else(|| update.get("output"))
                .filter(|value| !value.is_null())
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| value.to_string())
                })
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
            output: tool_output(update),
            status: update
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        "tool_call_update" | "tool_call_result" => {
            let status = update
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string);
            let output = tool_output(update);
            let name = update
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string);
            let input = update.get("rawInput").cloned();
            if output.is_none()
                && name.is_none()
                && input.is_none()
                && !matches!(status.as_deref(), Some("completed" | "failed"))
            {
                return None;
            }
            Some(DevinStreamItem::ToolUpdate {
                id: update
                    .get("toolCallId")
                    .or_else(|| update.get("id"))?
                    .as_str()?
                    .to_string(),
                name,
                input,
                output,
                status,
            })
        }
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

/// The pipe reader runs separately so silent agents cannot block cancellation.
struct AcpReader {
    lines: mpsc::Receiver<Result<String, String>>,
    cancelled: Arc<AtomicBool>,
    auto_approve: AtomicBool,
    session_id: Option<String>,
}

impl AcpReader {
    fn new(stdout: ChildStdout, cancelled: Arc<AtomicBool>) -> Self {
        let (sender, lines) = mpsc::sync_channel(128);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender
                    .send(line.map_err(|e| format!("Cannot read Devin ACP: {e}")))
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            lines,
            cancelled,
            auto_approve: AtomicBool::new(false),
            session_id: None,
        }
    }

    fn next(&self, deadline: Instant, observe_cancel: bool) -> Result<Option<Value>, String> {
        if observe_cancel && self.cancelled.load(Ordering::Acquire) {
            return Err("Devin request cancelled".into());
        }
        if Instant::now() >= deadline {
            return Err("Devin ACP response timed out".into());
        }
        match self.lines.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => Ok(serde_json::from_str(line.trim()).ok()),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Devin ACP exited before responding".into())
            }
        }
    }
}

fn handle_reverse_request(
    stdin: &mut ChildStdin,
    value: &Value,
    options: &DevinExecutionOptions<'_>,
    reader: &AcpReader,
) -> Result<bool, String> {
    let (Some(id), Some(method)) = (value.get("id"), value.get("method").and_then(Value::as_str))
    else {
        return Ok(false);
    };
    if method == "session/request_permission" {
        let result = if reader.session_id.as_deref().is_some_and(|expected| {
            value.pointer("/params/sessionId").and_then(Value::as_str) != Some(expected)
        }) {
            serde_json::json!({"outcome":{"outcome":"cancelled"}})
        } else {
            super::devin_permissions::request_permission(
                options.app,
                options.jean_session_id,
                options.worktree_id,
                value,
                options.execution_mode,
                &reader.cancelled,
                &reader.auto_approve,
            )?
        };
        send_response(stdin, id, result)?;
    } else {
        // We advertise no client filesystem or terminal capabilities.
        writeln!(
            stdin,
            "{}",
            serde_json::json!({"jsonrpc":"2.0","id":id,
            "error":{"code":-32601,"message":"Client method not supported"}})
        )
        .map_err(|e| format!("Cannot reject Devin request: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("Cannot flush Devin response: {e}"))?;
    }
    Ok(true)
}

fn read_response(
    reader: &AcpReader,
    stdin: &mut ChildStdin,
    id: i64,
    options: &DevinExecutionOptions<'_>,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let Some(value) = reader.next(deadline, true)? else {
            continue;
        };
        if handle_reverse_request(stdin, &value, options, reader)? {
            continue;
        }
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Devin ACP request failed: {error}"));
            }
            return Ok(value);
        }
        // session/load replays old messages. They are already in Jean history.
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

// CLI model variants encode thinking in the final segment. ACP advertises a
// family representative instead, and exposes thinking as a separate selector.
// Only use a unique advertised family match; all values are validated again
// against the server after the model has changed.
fn local_model_selections(
    config: &Value,
    requested: &str,
) -> Result<Vec<(String, String)>, String> {
    let variant = requested.rsplit_once('-').filter(|(_, level)| {
        matches!(
            *level,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
        )
    });
    let direct = devin_protocol::config_selection(config, "model", requested)
        .ok()
        .flatten();
    if let Some(selection) = direct {
        return Ok(vec![selection]);
    }
    let model = {
        let family = variant.map(|(family, _)| family);
        let matches = config
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["category"] == "model" || item["id"] == "model")
            .filter_map(|item| item["options"].as_array())
            .flatten()
            .filter_map(|item| item["value"].as_str())
            .filter(|value| {
                family.is_some() && value.rsplit_once('-').map(|(prefix, _)| prefix) == family
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(format!("Devin ACP does not offer model '{requested}'."));
        }
        matches[0].to_string()
    };
    let mut selections = vec![("model".to_string(), model)];
    if let Some((_, level)) = variant {
        selections.push(("thought_level".to_string(), level.to_string()));
    }
    Ok(selections)
}

// ACP mode controls are optional. Cloud can manage permissions without exposing
// a client-selectable mode. Local execution still requires an enforced mode.
fn mode_request(
    response: &Value,
    location: DevinLocation,
    execution_mode: Option<&str>,
) -> Result<Option<(&'static str, Value)>, String> {
    let requested = devin_permission_mode(execution_mode);
    if let Some((id, value)) = devin_protocol::config_selection(
        response
            .pointer("/result/configOptions")
            .unwrap_or(&Value::Null),
        "mode",
        requested,
    )? {
        return Ok(Some((
            "session/set_config_option",
            serde_json::json!({"configId":id,"value":value}),
        )));
    }
    if let Some(modes) = response
        .pointer("/result/modes/availableModes")
        .and_then(Value::as_array)
        .filter(|modes| !modes.is_empty())
    {
        if modes.iter().any(|mode| mode["id"] == requested) {
            return Ok(Some((
                "session/set_mode",
                serde_json::json!({"modeId":requested}),
            )));
        }
        return Err(format!(
            "Devin does not offer the requested '{requested}' mode."
        ));
    }
    if location == DevinLocation::Cloud {
        return Ok(None);
    }
    Err("Devin does not expose the requested 'mode' setting.".into())
}

fn configure_session(
    reader: &AcpReader,
    stdin: &mut ChildStdin,
    next_id: &mut i64,
    session_id: &str,
    session_response: &Value,
    options: &DevinExecutionOptions<'_>,
) -> Result<Value, String> {
    let mut config = session_response
        .pointer("/result/configOptions")
        .cloned()
        .unwrap_or(Value::Null);
    if let Some((method, mut params)) =
        mode_request(session_response, options.location, options.execution_mode)?
    {
        params["sessionId"] = serde_json::json!(session_id);
        let id = *next_id;
        *next_id += 1;
        send_request(stdin, id, method, params)?;
        let reply = read_response(reader, stdin, id, options)?;
        if let Some(updated) = reply.pointer("/result/configOptions") {
            config = updated.clone();
        }
    }
    let mut selections = Vec::new();
    if options.location == DevinLocation::Local {
        if let Some(model) = devin_model(options.model) {
            selections.extend(local_model_selections(&config, model)?);
        }
    }
    for (key, value) in options.config_overrides {
        if config.as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["id"].as_str() == Some(key.as_str()) && item["category"] == "mode")
        }) {
            return Err("Devin mode must be selected with Jean's execution mode control".into());
        }
        // Cloud models come from this session, not the local CLI model list.
        if key != "mode" && (key != "model" || options.location == DevinLocation::Cloud) {
            selections.retain(|(id, _)| id != key);
            selections.push((key.clone(), value.clone()));
        }
    }
    selections.sort_by_key(|(id, _)| {
        if id == "mode" {
            0
        } else if id == "model"
            || config.as_array().is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item["id"].as_str() == Some(id) && item["category"] == "model")
            })
        {
            1
        } else {
            2
        }
    });
    for (category, requested) in selections {
        let selection = devin_protocol::config_selection(&config, &category, &requested)?;
        let Some((id, value)) = selection else {
            // Do not claim to enforce a mode or model that the server cannot set.
            return Err(format!(
                "Devin does not expose the requested '{category}' setting."
            ));
        };
        let request_id = *next_id;
        *next_id += 1;
        send_request(
            stdin,
            request_id,
            "session/set_config_option",
            serde_json::json!({"sessionId":session_id,"configId":id,"value":value}),
        )?;
        let reply = read_response(reader, stdin, request_id, options)?;
        if let Some(updated) = reply.pointer("/result/configOptions") {
            config = updated.clone();
        }
    }
    Ok(config)
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
        DevinStreamItem::ToolStart {
            id,
            name,
            input,
            output,
            status,
        } => {
            if !response.tool_calls.iter().any(|tool| tool.id == id) {
                response.content_blocks.push(ContentBlock::ToolUse {
                    tool_call_id: id.clone(),
                });
                response.tool_calls.push(ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                    output: None,
                    parent_tool_use_id: None,
                    is_error: None,
                    subagent_usage: None,
                });
            }
            apply_stream_item(
                response,
                DevinStreamItem::ToolUpdate {
                    id,
                    name: Some(name),
                    input: Some(input),
                    output,
                    status,
                },
            );
        }
        DevinStreamItem::ToolUpdate {
            id,
            name,
            input,
            output,
            status,
        } => {
            if let Some(tool) = response.tool_calls.iter_mut().find(|tool| tool.id == id) {
                if let Some(name) = name {
                    tool.name = name;
                }
                if let Some(input) = input {
                    tool.input = input;
                }
                if let Some(output) = output {
                    tool.output = Some(output);
                }
                if status.as_deref() == Some("failed") {
                    tool.is_error = Some(true);
                }
                if matches!(status.as_deref(), Some("completed" | "failed"))
                    && tool.output.is_none()
                {
                    tool.output = Some(
                        if tool.is_error == Some(true) {
                            "Tool failed"
                        } else {
                            ""
                        }
                        .to_string(),
                    );
                }
            }
        }
    }
}

fn empty_response(session_id: Option<&str>) -> DevinResponse {
    DevinResponse {
        content: String::new(),
        session_id: session_id.unwrap_or_default().to_string(),
        tool_calls: vec![],
        content_blocks: vec![],
        cancelled: false,
        usage: None,
    }
}

fn write_log(log: &mut std::fs::File, value: &Value) -> Result<(), String> {
    writeln!(log, "{value}")
        .and_then(|_| log.flush())
        .map_err(|e| format!("Cannot persist Devin stream: {e}"))
}

fn emit_item(
    options: &DevinExecutionOptions<'_>,
    response: &DevinResponse,
    item: &DevinStreamItem,
    new_tool: bool,
) {
    let base =
        serde_json::json!({"session_id":options.jean_session_id,"worktree_id":options.worktree_id});
    match item {
        DevinStreamItem::Text(text) | DevinStreamItem::Thinking(text) => {
            let event = if matches!(item, DevinStreamItem::Text(_)) {
                "chat:chunk"
            } else {
                "chat:thinking"
            };
            let mut payload = base;
            payload["content"] = text.clone().into();
            emit(options.app, event, payload);
        }
        DevinStreamItem::ToolStart { id, status, .. }
        | DevinStreamItem::ToolUpdate { id, status, .. } => {
            let Some(tool) = response.tool_calls.iter().find(|tool| tool.id == *id) else {
                return;
            };
            let mut payload = base.clone();
            payload["id"] = id.clone().into();
            payload["name"] = tool.name.clone().into();
            payload["input"] = tool.input.clone();
            emit(options.app, "chat:tool_use", payload);
            if new_tool {
                let mut payload = base.clone();
                payload["tool_call_id"] = id.clone().into();
                emit(options.app, "chat:tool_block", payload);
            }
            if matches!(status.as_deref(), Some("completed" | "failed")) {
                let mut payload = base;
                payload["tool_use_id"] = id.clone().into();
                payload["output"] = tool.output.clone().unwrap_or_default().into();
                payload["is_error"] = tool.is_error.unwrap_or(false).into();
                emit(options.app, "chat:tool_result", payload);
            }
        }
    }
}

fn execute_devin_child(
    child: &mut Child,
    options: &DevinExecutionOptions<'_>,
    cancelled: Arc<AtomicBool>,
    response: &mut DevinResponse,
) -> Result<(), String> {
    let stdout = child.stdout.take().ok_or("Cannot capture Devin stdout")?;
    let mut stdin = child.stdin.take().ok_or("Cannot open Devin stdin")?;
    if let Some(mut stderr) = child.stderr.take() {
        // Drain without retaining an unbounded buffer or logging credentials.
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
    }
    let mut reader = AcpReader::new(stdout, cancelled.clone());
    reader
        .auto_approve
        .store(options.execution_mode == Some("yolo"), Ordering::Release);
    let mut next_id = 1;
    send_request(
        &mut stdin,
        next_id,
        "initialize",
        serde_json::json!({
        "protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"Jean","version":env!("CARGO_PKG_VERSION")}}),
    )?;
    let init = read_response(&reader, &mut stdin, next_id, options)?;
    next_id += 1;
    let mut message = prepared_message(options.message, options.system_prompt);
    if options.location == DevinLocation::Cloud {
        // A task instruction, not a remote sandbox or permission guarantee.
        let instruction = match options.execution_mode.unwrap_or("plan") {
            "plan" => "Plan only. Inspect the task and propose a plan. Do not edit files or implement changes. Wait for approval before implementation.",
            "yolo" => "Implement the task and verify the result without routine confirmation. Follow the cloud environment's permission rules.",
            _ => "Implement the requested task and verify the result. Ask before destructive actions. Follow the cloud environment's permission rules.",
        };
        message =
            format!("<jean_execution_mode>\n{instruction}\n</jean_execution_mode>\n\n{message}");
    }
    let image_paths = super::commands::extract_image_paths(options.message);
    let mut text_paths = super::commands::extract_text_file_paths(options.message);
    if options.location == DevinLocation::Cloud {
        text_paths.extend(devin_protocol::cloud_reference_paths(
            options.message,
            options.working_dir,
        )?);
    }
    let mut prompt = devin_protocol::prompt_blocks(&message, &image_paths, &init)?;
    devin_protocol::embed_text_files(&mut prompt, &text_paths, &init)?;
    if let Some(auth_method) = init
        .pointer("/result/authMethods")
        .and_then(Value::as_array)
        .and_then(|methods| methods.first())
        .and_then(|method| method["id"].as_str())
    {
        send_request(
            &mut stdin,
            next_id,
            "authenticate",
            serde_json::json!({"methodId":auth_method,"_meta":{"headless":true}}),
        )?;
        read_response(&reader, &mut stdin, next_id, options).map_err(|error| {
            format!("Devin authentication failed. Run `devin auth login`. {error}")
        })?;
        next_id += 1;
    }
    // Do not pass a host filesystem path to the cloud VM.
    let cwd = if options.location == DevinLocation::Cloud {
        Path::new("/")
    } else {
        options.working_dir
    };
    let (method, mut params) =
        devin_protocol::session_request(&init, options.existing_devin_session_id, cwd)?;
    if options.location == DevinLocation::Local {
        let mut config: Value = options
            .mcp_config
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| format!("Invalid Devin MCP configuration: {e}"))?
            .unwrap_or_else(|| serde_json::json!({"mcpServers":{}}));
        let browser = crate::agent_browser::runtime_mcp_entry(options.app)?;
        config
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .ok_or("Devin MCP configuration must contain an mcpServers object")?
            .insert("agent-browser".to_string(), browser);
        params["mcpServers"] = devin_protocol::acp_mcp_servers(Some(&config.to_string()), &init)?;
    }
    send_request(&mut stdin, next_id, method, params)?;
    let session = read_response(&reader, &mut stdin, next_id, options)?;
    next_id += 1;
    response.session_id = session_id_from_response(&session)
        .or_else(|| options.existing_devin_session_id.map(str::to_string))
        .ok_or("Devin did not return a session ID")?;
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(options.output_file)
        .map_err(|e| format!("Cannot open Devin run log: {e}"))?;
    write_log(
        &mut log,
        &serde_json::json!({"type":"system","subtype":"init","session_id":response.session_id}),
    )?;
    reader.session_id = Some(response.session_id.clone());
    let run_id = options
        .output_file
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Invalid Devin run log path")?;
    // A cancelled worker must not overwrite a replacement turn's session state.
    super::storage::with_existing_metadata_mut(options.app, options.jean_session_id, |metadata| {
        if let Some(run) = metadata.runs.iter_mut().find(|run| run.run_id == run_id) {
            run.devin_session_id = Some(response.session_id.clone());
        }
        if !cancelled.load(Ordering::Acquire) {
            metadata.devin_session_id = Some(response.session_id.clone());
        }
    })?;
    let config = configure_session(
        &reader,
        &mut stdin,
        &mut next_id,
        &response.session_id,
        &session,
        options,
    )?;
    super::storage::with_existing_metadata_mut(options.app, options.jean_session_id, |metadata| {
        if !cancelled.load(Ordering::Acquire) {
            if let Some(model) = config
                .as_array()
                .and_then(|items| items.iter().find(|item| item["category"] == "model"))
                .and_then(|item| item["currentValue"].as_str())
            {
                if let Some(run) = metadata.runs.iter_mut().find(|run| run.run_id == run_id) {
                    run.model = Some(format!("devin/{model}"));
                }
            }
            metadata.devin_config_options = Some(config);
        }
    })?;
    emit(
        options.app,
        "cache:invalidate",
        serde_json::json!({"keys":["session","sessions"]}),
    );
    if cancelled.load(Ordering::Acquire) {
        return Err("Devin request cancelled".into());
    }
    send_request(
        &mut stdin,
        next_id,
        "session/prompt",
        serde_json::json!({"sessionId":response.session_id,"prompt":prompt}),
    )?;
    let prompt_id = next_id;
    let mut deadline = Instant::now() + Duration::from_secs(1800);
    let mut cancel_sent = false;
    loop {
        if cancelled.load(Ordering::Acquire) && !cancel_sent {
            writeln!(stdin, "{}", serde_json::json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":response.session_id}}))
                .and_then(|_| stdin.flush()).map_err(|e| format!("Cannot cancel Devin turn: {e}"))?;
            cancel_sent = true;
            deadline = Instant::now() + Duration::from_secs(5);
        }
        let Some(value) = reader.next(deadline, false)? else {
            continue;
        };
        if !cancel_sent {
            deadline = Instant::now() + Duration::from_secs(1800);
        }
        if handle_reverse_request(&mut stdin, &value, options, &reader)? {
            continue;
        }
        if value.get("method").and_then(Value::as_str) == Some("session/update") {
            if value
                .pointer("/params/sessionId")
                .and_then(Value::as_str)
                .is_some_and(|id| id != response.session_id)
            {
                continue;
            }
            write_log(&mut log, &value)?;
            if let Some(item) = parse_devin_stream_item(&value) {
                let new_tool = matches!(&item, DevinStreamItem::ToolStart { id, .. }
                    if !response.tool_calls.iter().any(|tool| &tool.id == id));
                apply_stream_item(response, item.clone());
                if !cancelled.load(Ordering::Acquire) {
                    emit_item(options, response, &item, new_tool);
                }
            }
        }
        if value.get("id").and_then(Value::as_i64) == Some(prompt_id)
            && value.get("method").is_none()
        {
            if let Some(error) = value.get("error") {
                return Err(format!("Devin prompt failed: {error}"));
            }
            response.usage = usage_from_result(&value);
            response.cancelled = cancelled.load(Ordering::Acquire)
                || value.pointer("/result/stopReason").and_then(Value::as_str) == Some("cancelled");
            write_log(
                &mut log,
                &serde_json::json!({"type":"result","session_id":response.session_id,
                "cancelled":response.cancelled,"usage":response.usage}),
            )?;
            break;
        }
    }
    response.content = response.content.trim().to_string();
    Ok(())
}

pub fn execute_devin(mut options: DevinExecutionOptions<'_>) -> Result<DevinResponse, String> {
    let cli_path = crate::devin_cli::config::resolve_cli_binary(options.app);
    if !crate::devin_cli::config::binary_exists(&cli_path) {
        return Err("Devin CLI not installed".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut response = empty_response(options.existing_devin_session_id);
    if !super::registry::register_cancel_flag(
        options.jean_session_id.to_string(),
        cancelled.clone(),
    ) {
        response.cancelled = true;
        return Ok(response);
    }
    let result = (|| {
        let mut command =
            crate::platform::cli_command(&cli_path.to_string_lossy(), Some(options.working_dir));
        command
            .arg("acp")
            .current_dir(options.working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if options.location == DevinLocation::Cloud {
            command.arg("--cloud");
        } else {
            if let Some(model) = devin_model(options.model) {
                command.arg("--model").arg(model);
            }
            command
                .env("JEAN_SESSION_ID", options.jean_session_id)
                .env("JEAN_WORKTREE_ID", options.worktree_id);
            let (key, value) = super::jean_mcp::child_depth_env();
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start Devin ACP: {e}"))?;
        if let Some(callback) = options.pid_callback.take() {
            callback(child.id());
        }
        let result = execute_devin_child(&mut child, &options, cancelled.clone(), &mut response);
        if (result.is_err() || cancelled.load(Ordering::Acquire))
            && options.location == DevinLocation::Local
        {
            let _ = crate::platform::kill_process_tree(child.id());
        }
        let _ = child.kill();
        let _ = child.wait();
        result
    })();
    super::registry::cleanup_owned_session_registrations(
        options.jean_session_id,
        Some(0),
        Some(&cancelled),
    );
    if cancelled.load(Ordering::Acquire) {
        response.cancelled = true;
        return Ok(response);
    }
    result?;
    Ok(response)
}

pub(crate) fn parse_devin_run_to_message(
    lines: &[String],
    run: &RunEntry,
) -> Result<ChatMessage, String> {
    // Older Devin runs used Jean's synthetic assistant records.
    if !lines.iter().any(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .is_some_and(|v| v["method"] == "session/update")
    }) {
        return super::run_log::parse_run_to_message(lines, run);
    }
    let mut response = empty_response(None);
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(item) = parse_devin_stream_item(&value) {
            apply_stream_item(&mut response, item);
        }
        if value["type"] == "result" {
            response.cancelled = value["cancelled"].as_bool().unwrap_or(false);
            response.usage = value
                .get("usage")
                .filter(|usage| !usage.is_null())
                .map(usage_from_value);
        }
    }
    Ok(ChatMessage {
        id: run
            .assistant_message_id
            .clone()
            .unwrap_or_else(|| format!("assistant-{}", run.run_id)),
        role: MessageRole::Assistant,
        content: response.content.trim().to_string(),
        timestamp: run.ended_at.unwrap_or(run.started_at),
        tool_calls: response.tool_calls,
        content_blocks: response.content_blocks,
        cancelled: run.cancelled || response.cancelled,
        model: run.model.clone(),
        backend: Some(super::types::Backend::Devin),
        execution_mode: run.execution_mode.clone(),
        thinking_level: run.thinking_level.clone(),
        effort_level: run.effort_level.clone(),
        recovered: run.recovered,
        usage: response.usage.or_else(|| run.usage.clone()),
        ..ChatMessage::default()
    })
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
    fn ignores_nonterminal_tool_updates_and_unrelated_messages() {
        let update = serde_json::json!({"method":"session/update","params":{"update":{
            "sessionUpdate":"tool_call_update","toolCallId":"t1","status":"in_progress"
        }}});
        assert_eq!(parse_devin_stream_item(&update), None);
        let unrelated = serde_json::json!({"method":"other","params":{"update":{
            "sessionUpdate":"agent_message_chunk","content":{"text":"ignore"}
        }}});
        assert_eq!(parse_devin_stream_item(&unrelated), None);
    }

    #[test]
    fn maps_jean_execution_modes_to_devin_permission_modes() {
        assert_eq!(devin_permission_mode(Some("plan")), "plan");
        assert_eq!(devin_permission_mode(Some("build")), "accept-edits");
        assert_eq!(devin_permission_mode(Some("yolo")), "bypass");
    }
}

#[cfg(test)]
#[path = "devin_tests.rs"]
mod behavioral_tests;
