//! Muse Code MSP execution engine.
//!
//! Jean drives `muse serve` (Muse Session Protocol: JSON-RPC 2.0, one message
//! per line on stdio). On Unix each turn runs through a detached MSP host so
//! Muse keeps running while Jean is closed; Jean tails the host's run JSONL and
//! reattaches after restart. Other platforms use the attached fallback.

use super::coalesce::ChunkCoalescer;
use super::types::{ChatMessage, ContentBlock, MessageRole, RunEntry, ToolCall, UsageData};
use crate::http_server::EmitExt;
use crate::muse_cli::{muse_mode, muse_model, muse_reasoning_effort, MuseMode};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::AppHandle;

/// Jean self-relaunch flag for the detached Muse MSP host (Unix).
pub const MUSE_MSP_HOST_ARG: &str = "--jean-muse-msp-host";
/// Env (not argv) carries the system prompt and MCP config to the host so they
/// stay out of `ps`.
const DEVELOPER_PROMPT_ENV: &str = "JEAN_MUSE_DEVELOPER_PROMPT";
const MCP_SERVERS_ENV: &str = "JEAN_MUSE_MCP_SERVERS";
const CANCEL_GRACE: Duration = Duration::from_secs(10);
const CLIENT_NAME: &str = "jean";

pub struct MuseResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

impl MuseResponse {
    fn empty(session_id: &str) -> Self {
        Self {
            content: String::new(),
            session_id: session_id.to_string(),
            tool_calls: Vec::new(),
            content_blocks: Vec::new(),
            cancelled: false,
            usage: None,
        }
    }
}

pub struct MuseExecutionOptions<'a> {
    pub app: &'a AppHandle,
    pub jean_session_id: &'a str,
    pub worktree_id: &'a str,
    pub working_dir: &'a Path,
    pub output_file: &'a Path,
    pub existing_muse_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub execution_mode: Option<&'a str>,
    pub effort_level: Option<&'a str>,
    pub message: &'a str,
    pub system_prompt: Option<&'a str>,
    /// `{"<name>": {...}}` Jean MCP entry in Claude shape; converted per session.
    pub mcp_servers: Option<Value>,
    pub pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
}

// ---------------------------------------------------------------------------
// JSON-RPC client
// ---------------------------------------------------------------------------

/// Mint an MSP `commandId`: UUIDv7 (48-bit millisecond timestamp, then random).
pub(crate) fn command_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    let mut bytes = *uuid::Uuid::new_v4().as_bytes();
    bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    bytes[6] = 0x70 | (bytes[6] & 0x0f);
    bytes[8] = 0x80 | (bytes[8] & 0x3f);
    uuid::Uuid::from_bytes(bytes).to_string()
}

fn write_line(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Muse stdin lock poisoned".to_string())?;
    writeln!(stdin, "{value}").map_err(|error| format!("Failed to write to Muse: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Failed to flush Muse stdin: {error}"))
}

fn write_request(
    stdin: &Arc<Mutex<ChildStdin>>,
    id: i64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    write_line(
        stdin,
        &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
}

fn error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| error.to_string())
}

/// Minimal MSP client over a `muse serve` child's stdio.
pub(crate) struct MspClient {
    stdin: Arc<Mutex<ChildStdin>>,
    reader: BufReader<ChildStdout>,
    next_id: i64,
    mode: MuseMode,
}

pub(crate) type LineSink<'a> = dyn FnMut(&Value) -> Result<(), String> + 'a;

impl MspClient {
    pub(crate) fn new(stdin: ChildStdin, stdout: ChildStdout, mode: MuseMode) -> Self {
        Self {
            stdin: Arc::new(Mutex::new(stdin)),
            reader: BufReader::new(stdout),
            next_id: 1,
            mode,
        }
    }

    fn stdin_handle(&self) -> Arc<Mutex<ChildStdin>> {
        self.stdin.clone()
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        write_line(
            &self.stdin,
            &json!({"jsonrpc": "2.0", "method": method, "params": params}),
        )
    }

    /// Next parsed line, `None` at EOF. Unparsable lines are skipped.
    fn read_value(&mut self) -> Result<Option<Value>, String> {
        let mut line = String::new();
        loop {
            line.clear();
            if self
                .reader
                .read_line(&mut line)
                .map_err(|error| format!("Failed to read from Muse: {error}"))?
                == 0
            {
                return Ok(None);
            }
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                return Ok(Some(value));
            }
        }
    }

    /// Send a request and pump lines until its response. Every other line is
    /// answered (server requests) and handed to `sink`.
    pub(crate) fn request(
        &mut self,
        method: &str,
        params: Value,
        sink: &mut LineSink<'_>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        write_request(&self.stdin, id, method, params)?;
        loop {
            let Some(value) = self.read_value()? else {
                return Err(format!("Muse exited before responding to {method}"));
            };
            if value.get("method").is_none() && value.get("id").and_then(Value::as_i64) == Some(id)
            {
                if let Some(error) = value.get("error") {
                    return Err(format!("Muse {method} failed: {}", error_message(error)));
                }
                return Ok(value);
            }
            self.handle_line(&value, sink)?;
        }
    }

    /// Send an SS3 command (a request carrying a fresh `commandId`).
    pub(crate) fn command(
        &mut self,
        method: &str,
        mut params: Value,
        sink: &mut LineSink<'_>,
    ) -> Result<Value, String> {
        if let Some(object) = params.as_object_mut() {
            object.insert("commandId".to_string(), Value::String(command_id()));
        }
        self.request(method, params, sink)
    }

    /// Pump lines until `done` matches; `None` at EOF.
    pub(crate) fn read_until(
        &mut self,
        done: impl Fn(&Value) -> bool,
        sink: &mut LineSink<'_>,
    ) -> Result<Option<Value>, String> {
        loop {
            let Some(value) = self.read_value()? else {
                return Ok(None);
            };
            self.handle_line(&value, sink)?;
            if done(&value) {
                return Ok(Some(value));
            }
        }
    }

    fn handle_line(&mut self, value: &Value, sink: &mut LineSink<'_>) -> Result<(), String> {
        sink(value)?;
        self.answer_server_request(value)
    }

    /// `approval/request` gets the presentation receipt plus an `approval/decide`
    /// chosen by the execution mode; `userInput/request` is refused.
    fn answer_server_request(&mut self, value: &Value) -> Result<(), String> {
        let (Some(id), Some(method)) =
            (value.get("id"), value.get("method").and_then(Value::as_str))
        else {
            return Ok(());
        };
        let params = value.get("params").unwrap_or(&Value::Null);
        match method {
            "approval/request" => {
                write_line(
                    &self.stdin,
                    &json!({"jsonrpc": "2.0", "id": id, "result": {}}),
                )?;
                let Some(decision) = approval_decision(params, self.mode.auto_approve) else {
                    return Ok(());
                };
                let decide_id = self.next_id;
                self.next_id += 1;
                write_request(&self.stdin, decide_id, "approval/decide", decision)
            }
            "userInput/request" => write_line(
                &self.stdin,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32601, "message": "Jean does not present Muse user-input prompts"},
                }),
            ),
            _ => Ok(()),
        }
    }
}

/// Build `approval/decide` params for an `approval/request`, picking the first
/// choice whose decision matches the mode (`approved` or `denied`).
fn approval_decision(params: &Value, auto_approve: bool) -> Option<Value> {
    let wanted = if auto_approve { "approved" } else { "denied" };
    let choices = params.get("availableChoices")?.as_array()?;
    let choice = choices
        .iter()
        .find(|choice| choice.get("decision").and_then(Value::as_str) == Some(wanted))
        .or_else(|| {
            choices.iter().find(|choice| {
                choice
                    .get("decision")
                    .and_then(Value::as_str)
                    .is_some_and(|decision| decision.starts_with(wanted))
            })
        })?;
    Some(json!({
        "commandId": command_id(),
        "sessionId": params.get("sessionId")?,
        "approvalId": params.get("approvalId")?,
        "choiceId": choice.get("choiceId")?,
        "requirementId": params.get("currentRequirementId")?,
    }))
}

// ---------------------------------------------------------------------------
// Session setup shared by the host, the attached fallback, and model listing
// ---------------------------------------------------------------------------

pub(crate) struct ServeOptions<'a> {
    pub cwd: &'a Path,
    pub mode: MuseMode,
    pub model: Option<&'a str>,
    pub developer_prompt: Option<&'a str>,
    pub provider: Option<&'a str>,
}

/// Spawn `muse serve` with the flags the mode table prescribes.
pub(crate) fn spawn_serve(
    cli_path: &Path,
    options: &ServeOptions<'_>,
    env: &[(&str, &str)],
) -> Result<(Child, MspClient), String> {
    let mut command = crate::platform::cli_command(&cli_path.to_string_lossy(), Some(options.cwd));
    command
        .arg("serve")
        .args(["--trust-workspace", "--disable-request-user-input"])
        .current_dir(options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(provider) = options.provider {
        command.args(["--provider", provider]);
    }
    if let Some(model) = muse_model(options.model) {
        command.args(["--model", model]);
    }
    if options.mode.disable_sandbox {
        command.arg("--disable-sandbox");
    }
    if let Some(prompt) = options
        .developer_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg("-c");
        command.arg(format!(
            "run.developer_prompt={}",
            Value::String(prompt.to_string())
        ));
    }
    for (key, value) in env {
        command.env(key, value);
    }
    let (depth_key, depth_value) = super::jean_mcp::child_depth_env();
    command.env(depth_key, depth_value);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Muse Code serve: {error}"))?;
    let stdin = child.stdin.take().ok_or("Failed to open Muse stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture Muse stdout")?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[muse-serve] {line}");
            }
        });
    }
    Ok((child, MspClient::new(stdin, stdout, options.mode)))
}

/// `initialize` + `initialized`, requesting the session MCP capability.
pub(crate) fn initialize(client: &mut MspClient, sink: &mut LineSink<'_>) -> Result<Value, String> {
    let result = client.request(
        "initialize",
        json!({
            "clientInfo": {"name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION")},
            "capabilities": {"requestedCapabilities": ["sessionMcp"]},
        }),
        sink,
    )?;
    client.notify("initialized", json!({}))?;
    Ok(result)
}

/// Convert a Claude-shaped `{"name": {"command","args","env"}}` MCP entry into
/// MSP `config.mcpServers`. Optional posture so a dead server never blocks a turn.
pub(crate) fn msp_mcp_servers(entry: &Value) -> Option<Value> {
    let servers = entry.as_object()?;
    let converted = servers
        .iter()
        .filter_map(|(name, config)| {
            let command = config.get("command")?.as_str()?;
            Some((
                name.clone(),
                json!({
                    "transport": "stdio",
                    "command": command,
                    "args": config.get("args").cloned().unwrap_or_else(|| json!([])),
                    "env": config.get("env").cloned().unwrap_or_else(|| json!({})),
                    "mode": "optional",
                }),
            ))
        })
        .collect::<serde_json::Map<_, _>>();
    (!converted.is_empty()).then_some(Value::Object(converted))
}

/// `session/start` or `session/resume`; returns the Muse session id.
pub(crate) fn open_session(
    client: &mut MspClient,
    cwd: &Path,
    mode: MuseMode,
    existing_session: Option<&str>,
    mcp_servers: Option<&Value>,
    sink: &mut LineSink<'_>,
) -> Result<String, String> {
    let mut params = serde_json::Map::new();
    params.insert(
        "permissionProfile".to_string(),
        Value::String(mode.permission_profile.to_string()),
    );
    if let Some(servers) = mcp_servers {
        params.insert("config".to_string(), json!({"mcpServers": servers}));
    }
    let method = match existing_session.filter(|id| !id.is_empty()) {
        Some(session_id) => {
            params.insert(
                "sessionId".to_string(),
                Value::String(session_id.to_string()),
            );
            params.insert("excludeItems".to_string(), Value::Bool(true));
            "session/resume"
        }
        None => {
            params.insert(
                "workspaceRoot".to_string(),
                Value::String(cwd.to_string_lossy().to_string()),
            );
            if let Some(approval_mode) = mode.approval_mode {
                params.insert(
                    "approvalMode".to_string(),
                    Value::String(approval_mode.to_string()),
                );
            }
            "session/start"
        }
    };
    let response = client.command(method, Value::Object(params), sink)?;
    response
        .pointer("/result/session/sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| existing_session.map(ToOwned::to_owned))
        .ok_or_else(|| "Muse did not return a session id".to_string())
}

fn turn_input(message: &str) -> Result<Value, String> {
    let image_paths = super::commands::extract_image_paths(message);
    let mut cleaned = message.to_string();
    let mut parts = Vec::with_capacity(image_paths.len() + 1);
    for path in image_paths {
        cleaned = cleaned.replace(
            &format!("[Image attached: {path} - Use the Read tool to view this image]"),
            "",
        );
        let data = std::fs::read(&path)
            .map_err(|error| format!("Failed to read Muse image attachment {path}: {error}"))?;
        let media_type = match Path::new(&path)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/png",
        };
        parts.push(json!({
            "type": "image",
            "base64Data": STANDARD.encode(data),
            "mediaType": media_type,
        }));
    }
    parts.insert(0, json!({"type": "text", "text": cleaned.trim()}));
    Ok(Value::Array(parts))
}

/// `turn/start`; returns the turn id.
pub(crate) fn start_turn(
    client: &mut MspClient,
    session_id: &str,
    message: &str,
    effort: Option<&str>,
    sink: &mut LineSink<'_>,
) -> Result<String, String> {
    let mut params = json!({"sessionId": session_id, "input": turn_input(message)?});
    if let Some(effort) = muse_reasoning_effort(effort) {
        params["reasoningEffort"] = Value::String(effort.to_string());
    }
    let response = client.command("turn/start", params, sink)?;
    Ok(response
        .pointer("/result/turnId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TurnOutcome {
    Completed,
    Cancelled,
    Failed(String),
}

/// The `turn/completed` notification, if `value` is one.
pub(crate) fn turn_outcome(value: &Value) -> Option<TurnOutcome> {
    if value.get("method").and_then(Value::as_str) != Some("turn/completed") {
        return None;
    }
    let params = value.get("params")?;
    Some(match params.get("terminal").and_then(Value::as_str) {
        Some("cancelled") => TurnOutcome::Cancelled,
        Some("failed") => TurnOutcome::Failed(
            params
                .get("error")
                .map(error_message)
                .or_else(|| {
                    params
                        .get("reason")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| "Muse turn failed".to_string()),
        ),
        _ => TurnOutcome::Completed,
    })
}

// ---------------------------------------------------------------------------
// Stream parser: MSP item lifecycle -> Jean stream items
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MuseStreamItem {
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
        is_error: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemKind {
    AgentMessage,
    Reasoning,
    ToolCall,
    Other,
    Unknown,
}

impl ItemKind {
    fn parse(kind: Option<&str>) -> Self {
        match kind {
            Some("agentMessage") => Self::AgentMessage,
            Some("reasoning") => Self::Reasoning,
            Some("toolCall") => Self::ToolCall,
            Some(_) => Self::Other,
            None => Self::Unknown,
        }
    }
}

#[derive(Debug, Default)]
struct ItemState {
    kind: Option<ItemKind>,
    /// Text already emitted via deltas; `item/completed` emits only the remainder.
    streamed: String,
    streamed_summary_part: Option<usize>,
    output: String,
    started: bool,
    finished: bool,
}

/// Incremental per-line parser. Keeps per-item state so streamed deltas and the
/// authoritative `item/completed` text never double up.
#[derive(Debug, Default)]
pub(crate) struct MuseStreamParser {
    items: HashMap<String, ItemState>,
    pub(crate) session_id: Option<String>,
    pub(crate) usage: Option<UsageData>,
}

fn usage_from_msp(usage: &Value) -> UsageData {
    let read = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or_default();
    UsageData {
        input_tokens: read("inputTokens"),
        output_tokens: read("outputTokens"),
        cache_read_input_tokens: usage
            .get("cacheReadTokens")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| read("cachedTokens")),
        cache_creation_input_tokens: read("cacheWriteTokens"),
    }
}

fn parse_tool_args(args: Option<&Value>) -> Value {
    match args {
        Some(Value::String(raw)) => {
            serde_json::from_str(raw).unwrap_or_else(|_| json!({"raw": raw}))
        }
        Some(Value::Null) | None => json!({}),
        Some(value) => value.clone(),
    }
}

fn is_terminal_status(status: Option<&str>) -> bool {
    status.is_some_and(|status| status != "inProgress")
}

impl MuseStreamParser {
    pub(crate) fn parse(&mut self, value: &Value) -> Vec<MuseStreamItem> {
        let Some(method) = value.get("method").and_then(Value::as_str) else {
            return Vec::new();
        };
        let params = value.get("params").unwrap_or(&Value::Null);
        match method {
            "session/started" => {
                if let Some(id) = params.pointer("/session/sessionId").and_then(Value::as_str) {
                    self.session_id = Some(id.to_string());
                }
                Vec::new()
            }
            "session/tokenUsage" | "turn/completed" => {
                if let Some(usage) = params.get("usage").filter(|usage| usage.is_object()) {
                    self.usage = Some(usage_from_msp(usage));
                }
                Vec::new()
            }
            "item/started" | "item/updated" | "item/completed" => params
                .get("item")
                .map(|item| self.apply_item(item))
                .unwrap_or_default(),
            "item/delta" => self.apply_delta(params),
            _ => Vec::new(),
        }
    }

    fn apply_item(&mut self, item: &Value) -> Vec<MuseStreamItem> {
        let Some(id) = item.get("itemId").and_then(Value::as_str) else {
            return Vec::new();
        };
        let kind = ItemKind::parse(item.get("kind").and_then(Value::as_str));
        let status = item.get("status").and_then(Value::as_str);
        let state = self.items.entry(id.to_string()).or_default();
        state.kind.get_or_insert(kind);
        let mut out = Vec::new();
        match kind {
            ItemKind::ToolCall => {
                if !state.started {
                    state.started = true;
                    out.push(MuseStreamItem::ToolStart {
                        id: id.to_string(),
                        name: item
                            .get("tool")
                            .and_then(Value::as_str)
                            .unwrap_or("Tool")
                            .to_string(),
                        input: parse_tool_args(item.get("args")),
                    });
                }
                if is_terminal_status(status) && !state.finished {
                    state.finished = true;
                    let failure = item.get("failureReason").and_then(Value::as_str);
                    let mut output = item
                        .get("visibleOutput")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| state.output.clone());
                    if output.is_empty() {
                        output = failure.unwrap_or_default().to_string();
                    }
                    out.push(MuseStreamItem::ToolResult {
                        id: id.to_string(),
                        output,
                        is_error: failure.is_some()
                            || matches!(
                                status,
                                Some("failed" | "rejected" | "timedOut" | "cancelled")
                            ),
                    });
                }
            }
            ItemKind::AgentMessage | ItemKind::Reasoning => {
                if is_terminal_status(status) && !state.finished {
                    state.finished = true;
                    let full = match (kind, item.get("text").and_then(Value::as_str)) {
                        (_, Some(text)) if !text.is_empty() => text.to_string(),
                        (ItemKind::Reasoning, _) => item
                            .get("summary")
                            .and_then(Value::as_array)
                            .map(|parts| {
                                parts
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default(),
                        _ => String::new(),
                    };
                    let remainder = full
                        .strip_prefix(state.streamed.as_str())
                        .unwrap_or_default();
                    if !remainder.is_empty() {
                        out.push(if kind == ItemKind::AgentMessage {
                            MuseStreamItem::Text(remainder.to_string())
                        } else {
                            MuseStreamItem::Thinking(remainder.to_string())
                        });
                    }
                }
            }
            ItemKind::Other | ItemKind::Unknown => {}
        }
        out
    }

    fn apply_delta(&mut self, params: &Value) -> Vec<MuseStreamItem> {
        let (Some(id), Some(delta)) = (
            params.get("itemId").and_then(Value::as_str),
            params.get("delta").and_then(Value::as_str),
        ) else {
            return Vec::new();
        };
        let field = params
            .get("field")
            .and_then(Value::as_str)
            .unwrap_or("text");
        let state = self.items.entry(id.to_string()).or_default();
        match (state.kind, field) {
            (Some(ItemKind::AgentMessage), "text") => {
                state.streamed.push_str(delta);
                vec![MuseStreamItem::Text(delta.to_string())]
            }
            (Some(ItemKind::Reasoning), "text") => {
                state.streamed.push_str(delta);
                vec![MuseStreamItem::Thinking(delta.to_string())]
            }
            (Some(ItemKind::Reasoning), field) if field.starts_with("summary.") => {
                let part = field["summary.".len()..].parse::<usize>().ok();
                let mut emitted = String::new();
                if state.streamed_summary_part.is_some() && state.streamed_summary_part != part {
                    emitted.push('\n');
                }
                state.streamed_summary_part = part;
                emitted.push_str(delta);
                state.streamed.push_str(&emitted);
                vec![MuseStreamItem::Thinking(emitted)]
            }
            (Some(ItemKind::ToolCall), "output") => {
                state.output.push_str(delta);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Applying stream items to a response and emitting UI events
// ---------------------------------------------------------------------------

fn push_text_block(blocks: &mut Vec<ContentBlock>, text: &str) {
    if let Some(ContentBlock::Text { text: existing }) = blocks.last_mut() {
        existing.push_str(text);
    } else {
        blocks.push(ContentBlock::Text {
            text: text.to_string(),
        });
    }
}

fn apply_stream_item(response: &mut MuseResponse, item: &MuseStreamItem) {
    match item {
        MuseStreamItem::Text(text) => {
            response.content.push_str(text);
            push_text_block(&mut response.content_blocks, text);
        }
        MuseStreamItem::Thinking(thinking) => {
            response.content_blocks.push(ContentBlock::Thinking {
                thinking: thinking.clone(),
            });
        }
        MuseStreamItem::ToolStart { id, name, input } => {
            if !response.tool_calls.iter().any(|tool| tool.id == *id) {
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
        }
        MuseStreamItem::ToolResult {
            id,
            output,
            is_error,
        } => {
            if let Some(tool) = response.tool_calls.iter_mut().find(|tool| tool.id == *id) {
                tool.output = Some(output.clone());
                tool.is_error = is_error.then_some(true);
            }
        }
    }
}

fn emit(app: &AppHandle, event: &str, value: Value) {
    let _ = app.emit_all(event, &value);
}

/// Parser + coalescer + response for one live turn. Shared by the tailer and
/// the attached fallback so both emit identical events.
struct TurnSink {
    parser: MuseStreamParser,
    coalescer: ChunkCoalescer,
    response: MuseResponse,
}

impl TurnSink {
    fn new(session_id: &str) -> Self {
        Self {
            parser: MuseStreamParser::default(),
            coalescer: ChunkCoalescer::new(),
            response: MuseResponse::empty(session_id),
        }
    }

    fn emit_chunk(&self, app: &AppHandle, session_id: &str, worktree_id: &str, content: &str) {
        emit(
            app,
            "chat:chunk",
            json!({"session_id": session_id, "worktree_id": worktree_id, "content": content}),
        );
    }

    /// Emit buffered text. Runs before any other event so UI order holds.
    fn flush(&mut self, app: &AppHandle, session_id: &str, worktree_id: &str) {
        if let Some(batch) = self.coalescer.flush() {
            self.emit_chunk(app, session_id, worktree_id, &batch);
        }
    }

    fn handle(&mut self, app: &AppHandle, session_id: &str, worktree_id: &str, value: &Value) {
        for item in self.parser.parse(value) {
            apply_stream_item(&mut self.response, &item);
            let base = json!({"session_id": session_id, "worktree_id": worktree_id});
            let event = |name: &str, extra: Value| {
                let mut payload = base.clone();
                if let (Some(payload), Some(extra)) = (payload.as_object_mut(), extra.as_object()) {
                    payload.extend(extra.clone());
                }
                emit(app, name, payload);
            };
            match item {
                MuseStreamItem::Text(content) => {
                    if let Some(batch) = self.coalescer.push(&content) {
                        self.emit_chunk(app, session_id, worktree_id, &batch);
                    }
                    continue;
                }
                MuseStreamItem::Thinking(content) => {
                    self.flush(app, session_id, worktree_id);
                    event("chat:thinking", json!({"content": content}));
                }
                MuseStreamItem::ToolStart { id, name, input } => {
                    self.flush(app, session_id, worktree_id);
                    event(
                        "chat:tool_use",
                        json!({"id": id, "name": name, "input": input}),
                    );
                    event("chat:tool_block", json!({"tool_call_id": id}));
                }
                MuseStreamItem::ToolResult { id, output, .. } => {
                    self.flush(app, session_id, worktree_id);
                    event(
                        "chat:tool_result",
                        json!({"tool_use_id": id, "output": output}),
                    );
                }
            }
        }
        if let Some(usage) = &self.parser.usage {
            self.response.usage = Some(usage.clone());
        }
        if self.response.session_id.is_empty() {
            if let Some(id) = &self.parser.session_id {
                self.response.session_id = id.clone();
            }
        }
    }

    fn finish(mut self, app: &AppHandle, session_id: &str, worktree_id: &str) -> MuseResponse {
        self.flush(app, session_id, worktree_id);
        self.response.content = self.response.content.trim().to_string();
        self.response
    }
}

/// Host markers in the run JSONL (same shape as the Kimi host so the generic
/// run-log scanners recognise them). Returns `true` on the terminal marker.
fn merge_muse_host_line(response: &mut MuseResponse, value: &Value) -> Result<bool, String> {
    match value.get("type").and_then(Value::as_str) {
        Some("session") => {
            if let Some(session_id) = value.get("session_id").and_then(Value::as_str) {
                response.session_id = session_id.to_string();
            }
            Ok(false)
        }
        Some("result") => {
            if let Some(session_id) = value.get("session_id").and_then(Value::as_str) {
                response.session_id = session_id.to_string();
            }
            if let Some(usage) = value.get("usage").filter(|usage| usage.is_object()) {
                response.usage = Some(usage_from_msp(usage));
            }
            response.cancelled = value
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(true)
        }
        Some("error") => Err(value
            .get("error")
            .map(|error| {
                error
                    .as_str()
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| error.to_string())
            })
            .unwrap_or_else(|| "Muse MSP host failed".to_string())),
        _ => Ok(false),
    }
}

fn inject_synthetic_plan(response: &mut MuseResponse) -> Option<ToolCall> {
    if response.content.trim().is_empty()
        || response
            .tool_calls
            .iter()
            .any(|tool| matches!(tool.name.as_str(), "ExitPlanMode" | "CodexPlan"))
    {
        return None;
    }
    let tool = ToolCall {
        id: "muse-plan".to_string(),
        name: "ExitPlanMode".to_string(),
        input: json!({"source": "muse", "plan": response.content}),
        output: None,
        parent_tool_use_id: None,
        is_error: None,
        subagent_usage: None,
    };
    response.content_blocks.push(ContentBlock::ToolUse {
        tool_call_id: tool.id.clone(),
    });
    response.tool_calls.push(tool.clone());
    Some(tool)
}

pub(crate) fn finish_muse_response(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    execution_mode: Option<&str>,
    mut response: MuseResponse,
) -> MuseResponse {
    if response.cancelled {
        return response;
    }
    let waiting_for_plan = execution_mode == Some("plan");
    if waiting_for_plan {
        if let Some(tool) = inject_synthetic_plan(&mut response) {
            emit(
                app,
                "chat:tool_use",
                json!({
                    "session_id": session_id,
                    "worktree_id": worktree_id,
                    "id": tool.id,
                    "name": tool.name,
                    "input": tool.input,
                }),
            );
            emit(
                app,
                "chat:tool_block",
                json!({
                    "session_id": session_id,
                    "worktree_id": worktree_id,
                    "tool_call_id": tool.id,
                }),
            );
        }
    }
    emit(
        app,
        "chat:done",
        json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "waiting_for_plan": waiting_for_plan,
        }),
    );
    response
}

// ---------------------------------------------------------------------------
// Detached host (Unix)
// ---------------------------------------------------------------------------

#[cfg(unix)]
pub(crate) fn muse_msp_socket_path(app_data_dir: &Path, session_id: &str, run_id: &str) -> PathBuf {
    fn short_id(value: &str) -> String {
        let value = value
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .take(8)
            .collect::<String>();
        if value.is_empty() {
            "x".to_string()
        } else {
            value
        }
    }
    app_data_dir.join("m").join(format!(
        "s{}-r{}.sock",
        short_id(session_id),
        short_id(run_id)
    ))
}

pub(crate) fn serialize_muse_host_command(command_type: &str, message: Option<&str>) -> String {
    let mut value = serde_json::Map::new();
    value.insert("type".to_string(), Value::String(command_type.to_string()));
    if let Some(message) = message {
        value.insert("message".to_string(), Value::String(message.to_string()));
    }
    format!("{}\n", Value::Object(value))
}

#[cfg(unix)]
pub(crate) fn send_muse_msp_host_command(socket_path: &Path, line: &str) -> Result<(), String> {
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket_path)
        .map_err(|error| format!("Failed to connect to Muse MSP host: {error}"))?;
    stream
        .write_all(line.as_bytes())
        .map_err(|error| format!("Failed to write Muse MSP host command: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("Failed to flush Muse MSP host command: {error}"))
}

#[cfg(unix)]
fn wait_for_muse_msp_socket(socket_path: &Path, pid: u32) -> Result<(), String> {
    use crate::platform::is_process_alive;
    use std::os::unix::net::UnixStream;

    let started = Instant::now();
    loop {
        if UnixStream::connect(socket_path).is_ok() {
            return Ok(());
        }
        if !is_process_alive(pid) {
            return Err(format!(
                "Muse MSP host exited before socket appeared at {}",
                socket_path.display()
            ));
        }
        if started.elapsed() > Duration::from_secs(60) {
            return Err(format!(
                "Timed out waiting for Muse MSP host socket at {}",
                socket_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Everything the detached host needs; parsed from argv + env in production,
/// built directly by the integration test.
#[derive(Debug, Clone, Default)]
pub(crate) struct MuseHostConfig {
    pub socket_path: PathBuf,
    pub output_file: PathBuf,
    pub cwd: PathBuf,
    pub muse_cli: PathBuf,
    pub existing_session: Option<String>,
    pub jean_session_id: Option<String>,
    pub worktree_id: Option<String>,
    pub model: Option<String>,
    pub execution_mode: Option<String>,
    pub effort: Option<String>,
    pub developer_prompt: Option<String>,
    pub mcp_servers: Option<Value>,
    pub provider: Option<String>,
}

#[cfg(unix)]
fn spawn_muse_msp_host(
    options: &MuseExecutionOptions<'_>,
    cli_path: &Path,
) -> Result<(u32, PathBuf), String> {
    let app_data = options
        .app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    let run_id = super::pi::run_id_from_output_file(options.output_file);
    let socket_path = muse_msp_socket_path(&app_data, options.jean_session_id, &run_id);
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Muse MSP socket directory: {error}"))?;
    }
    let _ = std::fs::remove_file(&socket_path);

    let log_dir = app_data.join("muse-msp-hosts");
    std::fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Failed to create Muse MSP host log directory: {error}"))?;
    let log_file = log_dir.join(format!("{}-{run_id}.log", options.jean_session_id));
    let executable = super::detached::current_executable_for_detached_host()?;
    let mut args = vec![
        MUSE_MSP_HOST_ARG.to_string(),
        "--socket".to_string(),
        socket_path.to_string_lossy().to_string(),
        "--output".to_string(),
        options.output_file.to_string_lossy().to_string(),
        "--cwd".to_string(),
        options.working_dir.to_string_lossy().to_string(),
        "--muse-cli".to_string(),
        cli_path.to_string_lossy().to_string(),
        "--jean-session".to_string(),
        options.jean_session_id.to_string(),
        "--worktree".to_string(),
        options.worktree_id.to_string(),
    ];
    for (name, value) in [
        ("--existing-session", options.existing_muse_session_id),
        ("--model", options.model),
        ("--execution-mode", options.execution_mode),
        ("--effort", options.effort_level),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            args.push(name.to_string());
            args.push(value.to_string());
        }
    }
    let mcp_servers = options
        .mcp_servers
        .as_ref()
        .and_then(msp_mcp_servers)
        .map(|value| value.to_string());
    let mut env = Vec::new();
    if let Some(prompt) = options.system_prompt {
        env.push((DEVELOPER_PROMPT_ENV, prompt));
    }
    if let Some(servers) = mcp_servers.as_deref() {
        env.push((MCP_SERVERS_ENV, servers));
    }

    let pid = super::detached::spawn_detached_process_with_env(
        &executable,
        &args,
        &log_file,
        &app_data,
        &env,
    )?;
    wait_for_muse_msp_socket(&socket_path, pid)?;
    Ok((pid, socket_path))
}

#[cfg(unix)]
fn write_host_line(output: &Arc<Mutex<std::fs::File>>, value: &Value) -> Result<(), String> {
    let mut output = output
        .lock()
        .map_err(|_| "Muse MSP output file lock poisoned".to_string())?;
    writeln!(output, "{value}")
        .map_err(|error| format!("Failed to write Muse MSP output: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("Failed to flush Muse MSP output: {error}"))
}

#[cfg(unix)]
enum HostCommand {
    Prompt(String),
    Cancel,
}

/// Detached Muse MSP host entrypoint: parse argv + env, then run.
#[cfg(unix)]
pub fn run_muse_msp_host_from_args() -> Result<(), String> {
    let config = parse_muse_host_args(std::env::args().skip(1))?;
    run_muse_msp_host(config)
}

#[cfg(unix)]
fn parse_muse_host_args(args: impl Iterator<Item = String>) -> Result<MuseHostConfig, String> {
    let mut config = MuseHostConfig::default();
    let mut args = args;
    // Flags without a value (the host flag itself) are skipped, so values
    // are consumed only by the flag that owns them.
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => config.socket_path = args.next().map(PathBuf::from).unwrap_or_default(),
            "--output" => config.output_file = args.next().map(PathBuf::from).unwrap_or_default(),
            "--cwd" => config.cwd = args.next().map(PathBuf::from).unwrap_or_default(),
            "--muse-cli" => config.muse_cli = args.next().map(PathBuf::from).unwrap_or_default(),
            "--existing-session" => config.existing_session = args.next(),
            "--jean-session" => config.jean_session_id = args.next(),
            "--worktree" => config.worktree_id = args.next(),
            "--model" => config.model = args.next(),
            "--execution-mode" => config.execution_mode = args.next(),
            "--effort" => config.effort = args.next(),
            _ => {}
        }
    }
    for (name, value) in [
        ("--socket", &config.socket_path),
        ("--output", &config.output_file),
        ("--cwd", &config.cwd),
        ("--muse-cli", &config.muse_cli),
    ] {
        if value.as_os_str().is_empty() {
            return Err(format!("{name} is required"));
        }
    }
    config.developer_prompt = std::env::var(DEVELOPER_PROMPT_ENV).ok();
    config.mcp_servers = std::env::var(MCP_SERVERS_ENV)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    config.provider = crate::muse_cli::provider_override();
    Ok(config)
}

/// The detached host body. Owns the `muse serve` stdio, appends every server
/// line plus Jean's markers to the run JSONL, and takes `prompt`/`cancel`
/// commands on its socket.
#[cfg(unix)]
pub(crate) fn run_muse_msp_host(config: MuseHostConfig) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::os::unix::net::{UnixListener, UnixStream};

    if let Some(parent) = config.socket_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Muse MSP socket directory: {error}"))?;
    }
    let output = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&config.output_file)
            .map_err(|error| format!("Failed to open Muse MSP output: {error}"))?,
    ));
    let mode = muse_mode(config.execution_mode.as_deref());
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(session_id) = &config.jean_session_id {
        env.push((
            crate::agent_browser::SESSION_ENV.to_string(),
            crate::agent_browser::session_name(session_id),
        ));
        env.push(("JEAN_SESSION_ID".to_string(), session_id.clone()));
    }
    if let Some(worktree_id) = &config.worktree_id {
        env.push(("JEAN_WORKTREE_ID".to_string(), worktree_id.clone()));
    }
    let env_refs = env
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let (mut child, mut client) = spawn_serve(
        &config.muse_cli,
        &ServeOptions {
            cwd: &config.cwd,
            mode,
            model: config.model.as_deref(),
            developer_prompt: config.developer_prompt.as_deref(),
            provider: config.provider.as_deref(),
        },
        &env_refs,
    )?;
    let child_pid = child.id();
    let log = output.clone();
    let mut sink = move |value: &Value| write_host_line(&log, value);

    let session_id = (|| {
        initialize(&mut client, &mut sink)?;
        open_session(
            &mut client,
            &config.cwd,
            mode,
            config.existing_session.as_deref(),
            config.mcp_servers.as_ref(),
            &mut sink,
        )
    })();
    let session_id = match session_id {
        Ok(session_id) => session_id,
        Err(error) => {
            let _ = write_host_line(&output, &json!({"type": "error", "error": error}));
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    write_host_line(
        &output,
        &json!({"type": "session", "session_id": session_id}),
    )?;

    let _ = std::fs::remove_file(&config.socket_path);
    let listener = UnixListener::bind(&config.socket_path)
        .map_err(|error| format!("Failed to bind Muse MSP host socket: {error}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let (command_tx, command_rx) = mpsc::channel();
    {
        let stop = stop.clone();
        let done = done.clone();
        let cancelled = cancelled.clone();
        let stdin = client.stdin_handle();
        let session_id = session_id.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut stream) = stream else { continue };
                let mut command = String::new();
                if stream.read_to_string(&mut command).is_err() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(command.trim()) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("prompt") => {
                        if let Some(message) = value.get("message").and_then(Value::as_str) {
                            let _ = command_tx.send(HostCommand::Prompt(message.to_string()));
                        }
                    }
                    Some("cancel") => {
                        cancelled.store(true, Ordering::SeqCst);
                        let _ = command_tx.send(HostCommand::Cancel);
                        // Ask politely, then kill the server once the grace period lapses.
                        let _ = write_request(
                            &stdin,
                            i64::MAX / 2,
                            "turn/cancel",
                            json!({"commandId": command_id(), "sessionId": session_id}),
                        );
                        let done = done.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(CANCEL_GRACE);
                            if !done.load(Ordering::SeqCst) {
                                let _ = crate::platform::kill_process_tree(child_pid);
                                let _ = crate::platform::kill_process(child_pid);
                            }
                        });
                    }
                    _ => {}
                }
            }
        });
    }

    let turn = match command_rx.recv_timeout(Duration::from_secs(120)) {
        Ok(HostCommand::Prompt(message)) => start_turn(
            &mut client,
            &session_id,
            &message,
            config.effort.as_deref(),
            &mut sink,
        )
        .and_then(|_| client.read_until(|value| turn_outcome(value).is_some(), &mut sink)),
        Ok(HostCommand::Cancel) => Ok(None),
        Err(_) => Err("Timed out waiting for Muse MSP prompt".to_string()),
    };
    done.store(true, Ordering::SeqCst);

    let marker = match turn {
        Err(error) => json!({"type": "error", "session_id": session_id, "error": error}),
        Ok(None) if !cancelled.load(Ordering::SeqCst) => json!({
            "type": "error",
            "session_id": session_id,
            "error": "Muse exited before the turn completed",
        }),
        Ok(completed) => {
            let outcome = completed.as_ref().and_then(turn_outcome);
            let usage = completed
                .as_ref()
                .and_then(|value| value.pointer("/params/usage"))
                .filter(|usage| usage.is_object())
                .cloned();
            match outcome {
                Some(TurnOutcome::Failed(message)) => {
                    json!({"type": "error", "session_id": session_id, "error": message})
                }
                outcome => json!({
                    "type": "result",
                    "session_id": session_id,
                    "usage": usage,
                    "cancelled": cancelled.load(Ordering::SeqCst)
                        || outcome == Some(TurnOutcome::Cancelled),
                }),
            }
        }
    };
    write_host_line(&output, &marker)?;

    stop.store(true, Ordering::SeqCst);
    let _ = UnixStream::connect(&config.socket_path);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&config.socket_path);
    Ok(())
}

#[cfg(not(unix))]
pub fn run_muse_msp_host_from_args() -> Result<(), String> {
    Err("Muse MSP host is only supported on Unix-like systems".to_string())
}

// ---------------------------------------------------------------------------
// Tailing a host run (live and after restart)
// ---------------------------------------------------------------------------

pub fn tail_muse_output(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &Path,
    pid: u32,
) -> Result<MuseResponse, String> {
    use super::tail::{next_poll_interval, NdjsonTailer};
    use crate::platform::is_process_alive;

    let mut tailer = NdjsonTailer::new_from_start(output_file)?;
    let mut sink = TurnSink::new("");
    let started_at = Instant::now();
    let startup_timeout = Duration::from_secs(120);
    let dead_process_timeout = Duration::from_secs(2);
    let mut last_output_at = Instant::now();
    let mut received_output = false;
    let mut completed = false;

    loop {
        let lines = tailer.poll()?;
        let got_lines = !lines.is_empty();
        for line in lines {
            let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let merged = merge_muse_host_line(&mut sink.response, &value);
            if merged.is_err() {
                sink.flush(app, session_id, worktree_id);
            }
            completed |= merged?;
            sink.handle(app, session_id, worktree_id, &value);
            received_output = true;
            last_output_at = Instant::now();
        }

        if let Some(deadline) = sink.coalescer.deadline() {
            if Instant::now() >= deadline {
                sink.flush(app, session_id, worktree_id);
            }
        }
        if completed {
            break;
        }
        if !is_process_alive(pid) {
            if !received_output && started_at.elapsed() > startup_timeout {
                sink.response.cancelled = true;
                break;
            }
            if received_output && last_output_at.elapsed() > dead_process_timeout {
                sink.response.cancelled = true;
                break;
            }
        }
        let mut sleep_for = next_poll_interval(got_lines, last_output_at.elapsed());
        if let Some(deadline) = sink.coalescer.deadline() {
            sleep_for = sleep_for.min(deadline.saturating_duration_since(Instant::now()));
        }
        std::thread::sleep(sleep_for);
    }
    Ok(sink.finish(app, session_id, worktree_id))
}

pub(crate) fn parse_muse_run_to_message(
    lines: &[String],
    run: &RunEntry,
) -> Result<ChatMessage, String> {
    let mut response = parse_muse_lines(lines)?;
    response.content = response.content.trim().to_string();
    Ok(ChatMessage {
        id: run
            .assistant_message_id
            .clone()
            .unwrap_or_else(|| format!("assistant-{}", run.run_id)),
        session_id: String::new(),
        role: MessageRole::Assistant,
        content: response.content,
        timestamp: run.ended_at.unwrap_or(run.started_at),
        tool_calls: response.tool_calls,
        content_blocks: response.content_blocks,
        cancelled: run.cancelled || response.cancelled,
        plan_approved: false,
        model: run.model.clone(),
        backend: None,
        execution_mode: run.execution_mode.clone(),
        thinking_level: run.thinking_level.clone(),
        effort_level: run.effort_level.clone(),
        custom_profile_name: None,
        recovered: run.recovered,
        usage: response.usage.or_else(|| run.usage.clone()),
    })
}

/// Fold run-log lines (server lines + host markers) into a response.
pub(crate) fn parse_muse_lines(lines: &[String]) -> Result<MuseResponse, String> {
    let mut parser = MuseStreamParser::default();
    let mut response = MuseResponse::empty("");
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let _ = merge_muse_host_line(&mut response, &value)?;
        for item in parser.parse(&value) {
            apply_stream_item(&mut response, &item);
        }
    }
    if response.usage.is_none() {
        response.usage = parser.usage;
    }
    if response.session_id.is_empty() {
        response.session_id = parser.session_id.unwrap_or_default();
    }
    Ok(response)
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

pub fn execute_muse(mut options: MuseExecutionOptions<'_>) -> Result<MuseResponse, String> {
    let cli_path = crate::muse_cli::resolve_cli_binary(options.app);
    if !crate::muse_cli::binary_exists(&cli_path) {
        return Err("Muse Code CLI not installed".to_string());
    }

    #[cfg(unix)]
    let result = execute_muse_detached(&mut options, &cli_path);
    #[cfg(not(unix))]
    let result = execute_muse_attached(&mut options, &cli_path);

    result.map(|response| {
        finish_muse_response(
            options.app,
            options.jean_session_id,
            options.worktree_id,
            options.execution_mode,
            response,
        )
    })
}

fn cancelled_response(options: &MuseExecutionOptions<'_>) -> MuseResponse {
    let mut response = MuseResponse::empty(options.existing_muse_session_id.unwrap_or_default());
    response.cancelled = true;
    response
}

#[cfg(unix)]
fn execute_muse_detached(
    options: &mut MuseExecutionOptions<'_>,
    cli_path: &Path,
) -> Result<MuseResponse, String> {
    let (pid, socket_path) = spawn_muse_msp_host(options, cli_path)?;
    if let Some(callback) = options.pid_callback.take() {
        callback(pid);
    }
    if !super::registry::register_detached_process(options.jean_session_id.to_string(), pid) {
        let _ = crate::platform::kill_process_tree(pid);
        let _ = crate::platform::kill_process(pid);
        return Ok(cancelled_response(options));
    }

    let prompt = serialize_muse_host_command("prompt", Some(options.message));
    if let Err(error) = send_muse_msp_host_command(&socket_path, &prompt) {
        super::registry::unregister_process(options.jean_session_id);
        let _ = crate::platform::kill_process_tree(pid);
        let _ = crate::platform::kill_process(pid);
        return Err(error);
    }

    super::increment_tailer_count();
    let result = tail_muse_output(
        options.app,
        options.jean_session_id,
        options.worktree_id,
        options.output_file,
        pid,
    );
    super::decrement_tailer_count();
    super::registry::unregister_process(options.jean_session_id);
    let mut response = result?;
    if response.session_id.is_empty() {
        response.session_id = options
            .existing_muse_session_id
            .unwrap_or_default()
            .to_string();
    }
    Ok(response)
}

/// In-process fallback for platforms without the detached host. Compiled
/// everywhere so it cannot rot on the platform that uses it.
#[cfg_attr(unix, allow(dead_code))]
fn execute_muse_attached(
    options: &mut MuseExecutionOptions<'_>,
    cli_path: &Path,
) -> Result<MuseResponse, String> {
    let mode = muse_mode(options.execution_mode);
    let session_name = crate::agent_browser::session_name(options.jean_session_id);
    let env = [
        ("JEAN_SESSION_ID", options.jean_session_id),
        (crate::agent_browser::SESSION_ENV, session_name.as_str()),
        ("JEAN_WORKTREE_ID", options.worktree_id),
    ];
    let provider = crate::muse_cli::provider_override();
    let (mut child, mut client) = spawn_serve(
        cli_path,
        &ServeOptions {
            cwd: options.working_dir,
            mode,
            model: options.model,
            developer_prompt: options.system_prompt,
            provider: provider.as_deref(),
        },
        &env,
    )?;
    let pid = child.id();
    if let Some(callback) = options.pid_callback.take() {
        callback(pid);
    }
    if !super::registry::register_process(options.jean_session_id.to_string(), pid) {
        crate::platform::kill_and_reap(&mut child);
        return Ok(cancelled_response(options));
    }

    let app = options.app;
    let (session_id, worktree_id) = (options.jean_session_id, options.worktree_id);
    let mcp_servers = options.mcp_servers.as_ref().and_then(msp_mcp_servers);
    let mut sink = TurnSink::new("");
    let result = (|| {
        let mut ignore = |_: &Value| Ok(());
        initialize(&mut client, &mut ignore)?;
        let muse_session_id = open_session(
            &mut client,
            options.working_dir,
            mode,
            options.existing_muse_session_id,
            mcp_servers.as_ref(),
            &mut ignore,
        )?;
        sink.response.session_id = muse_session_id.clone();
        let mut live = |value: &Value| {
            sink.handle(app, session_id, worktree_id, value);
            Ok(())
        };
        start_turn(
            &mut client,
            &muse_session_id,
            options.message,
            options.effort_level,
            &mut live,
        )?;
        client.read_until(|value| turn_outcome(value).is_some(), &mut live)
    })();
    let cancelled = !super::registry::is_process_running(options.jean_session_id);
    super::registry::unregister_process(options.jean_session_id);
    crate::platform::kill_and_reap(&mut child);

    let outcome = match result {
        Ok(Some(value)) => turn_outcome(&value).unwrap_or(TurnOutcome::Completed),
        Ok(None) if cancelled => TurnOutcome::Cancelled,
        Ok(None) => TurnOutcome::Failed("Muse exited before the turn completed".to_string()),
        Err(_) if cancelled => TurnOutcome::Cancelled,
        Err(error) => return Err(error),
    };
    let mut response = sink.finish(app, session_id, worktree_id);
    match outcome {
        TurnOutcome::Completed => {}
        TurnOutcome::Cancelled => response.cancelled = true,
        TurnOutcome::Failed(message) => return Err(message),
    }
    response.cancelled |= cancelled;
    Ok(response)
}

// ---------------------------------------------------------------------------
// One-shot (magic prompts): `muse exec --json`
// ---------------------------------------------------------------------------

/// The final answer of an `exec --json` run: `payload.text` of the
/// `run.terminal.completed` record. A `run.terminal.failed` record is an error.
pub(crate) fn exec_terminal_text(stdout: &str) -> Result<String, String> {
    let mut failure = None;
    for line in stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let payload = value.get("payload").unwrap_or(&Value::Null);
        match value.get("payload_type").and_then(Value::as_str) {
            Some("run.terminal.completed") => {
                return Ok(payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string());
            }
            Some("run.terminal.failed") => {
                failure = Some(
                    payload
                        .get("reason")
                        .or_else(|| payload.get("error"))
                        .map(|reason| {
                            reason
                                .as_str()
                                .map(ToOwned::to_owned)
                                .unwrap_or_else(|| reason.to_string())
                        })
                        .unwrap_or_else(|| "Muse run failed".to_string()),
                );
            }
            _ => {}
        }
    }
    Err(failure.unwrap_or_else(|| "Muse exec produced no terminal record".to_string()))
}

pub(crate) fn extract_json_object(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if serde_json::from_str::<Value>(trimmed).is_ok() {
        return Ok(trimmed.to_string());
    }
    let start = trimmed
        .find('{')
        .ok_or("No JSON object found in Muse response")?;
    let end = trimmed
        .rfind('}')
        .ok_or("No JSON object found in Muse response")?;
    let candidate = &trimmed[start..=end];
    serde_json::from_str::<Value>(candidate)
        .map_err(|error| format!("Invalid JSON object in Muse response: {error}"))?;
    Ok(candidate.to_string())
}

pub fn execute_one_shot_muse(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    json_schema: Option<&str>,
    working_dir: Option<&Path>,
) -> Result<String, String> {
    let cli_path = crate::muse_cli::resolve_cli_binary(app);
    if !crate::muse_cli::binary_exists(&cli_path) {
        return Err("Muse Code CLI not installed".to_string());
    }
    let schema_instruction = json_schema
        .map(|schema| format!(" The object must match this JSON Schema exactly: {schema}"))
        .unwrap_or_default();
    let prompt = format!(
        "{prompt}\n\nReturn only one valid JSON object with no markdown.{schema_instruction}"
    );
    let dir = working_dir.unwrap_or_else(|| Path::new("."));
    let provider = crate::muse_cli::provider_override();
    let mut command = crate::platform::cli_command(&cli_path.to_string_lossy(), Some(dir));
    command.args(["exec", "--json", "--permission-profile", ":read-only"]);
    if let Some(provider) = provider.as_deref() {
        command.args(["--provider", provider]);
    }
    if let Some(model) = muse_model(Some(model)) {
        command.args(["--model", model]);
    }
    // `--output-schema` is meta-provider only; the prompt wrapper covers the rest.
    let schema_file = match (json_schema, provider.is_none()) {
        (Some(schema), true) => {
            let path = std::env::temp_dir()
                .join(format!("jean-muse-schema-{}.json", uuid::Uuid::new_v4()));
            std::fs::write(&path, schema)
                .map_err(|error| format!("Failed to write Muse output schema: {error}"))?;
            command.arg("--output-schema");
            command.arg(&path);
            Some(path)
        }
        _ => None,
    };
    command.arg(&prompt);
    let output = command
        .current_dir(dir)
        .output()
        .map_err(|error| format!("Failed to run Muse one-shot request: {error}"));
    if let Some(path) = schema_file {
        let _ = std::fs::remove_file(path);
    }
    let output = output?;
    if !output.status.success() {
        return Err(format!(
            "Muse one-shot request failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = exec_terminal_text(&String::from_utf8_lossy(&output.stdout))?;
    extract_json_object(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ECHO_TRANSCRIPT: &str = include_str!("fixtures/muse-msp-echo-transcript.jsonl");
    const ECHO_EXEC: &str = include_str!("fixtures/muse-exec-echo.jsonl");

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(ToOwned::to_owned).collect()
    }

    fn sample_run() -> RunEntry {
        RunEntry {
            run_id: "run-1".to_string(),
            user_message_id: "user-1".to_string(),
            user_message: "hello msp".to_string(),
            model: Some("muse/default".to_string()),
            execution_mode: Some("build".to_string()),
            thinking_level: None,
            effort_level: None,
            backend: Some(super::super::types::Backend::Muse),
            custom_profile_name: None,
            started_at: 1,
            ended_at: Some(2),
            status: super::super::types::RunStatus::Completed,
            assistant_message_id: None,
            cancelled: false,
            provider_rejected: false,
            recovered: false,
            claude_session_id: None,
            pid: None,
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
            grok_session_id: None,
            kimi_session_id: None,
            antigravity_session_id: None,
            devin_session_id: None,
            muse_session_id: None,
            checkpoint_id: None,
        }
    }

    fn blocks_json(blocks: &[ContentBlock]) -> Value {
        serde_json::to_value(blocks).unwrap()
    }

    #[test]
    fn command_id_is_uuid_v7() {
        let id = command_id();
        let parsed = uuid::Uuid::parse_str(&id).expect("valid uuid");
        assert_eq!(parsed.get_version_num(), 7, "{id}");
        assert_eq!(parsed.get_variant(), uuid::Variant::RFC4122);
    }

    #[test]
    fn real_echo_transcript_folds_into_one_reply() {
        let response = parse_muse_lines(&lines(ECHO_TRANSCRIPT)).expect("parse");

        assert_eq!(response.content, "echo: hello msp");
        assert_eq!(
            blocks_json(&response.content_blocks),
            json!([{"type": "text", "text": "echo: hello msp"}])
        );
        assert_eq!(response.session_id, "01a14f1f-c834-7492-baab-0dbc3634ef84");
        assert!(response.tool_calls.is_empty());
        let usage = response.usage.expect("usage from session/tokenUsage");
        assert_eq!((usage.input_tokens, usage.output_tokens), (0, 0));
        assert!(!response.cancelled);
    }

    #[test]
    fn real_echo_transcript_reports_completed_turn() {
        let outcomes = lines(ECHO_TRANSCRIPT)
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|value| turn_outcome(&value))
            .collect::<Vec<_>>();
        assert_eq!(outcomes, vec![TurnOutcome::Completed]);
    }

    #[test]
    fn history_parse_uses_host_markers_over_server_lines() {
        let mut log = lines(ECHO_TRANSCRIPT);
        log.insert(
            0,
            r#"{"type":"session","session_id":"marker-session"}"#.to_string(),
        );
        log.push(
            r#"{"type":"result","session_id":"marker-session","usage":{"inputTokens":12,"outputTokens":4,"cachedTokens":3,"reasoningTokens":0},"cancelled":false}"#.to_string(),
        );
        let run = sample_run();

        let message = parse_muse_run_to_message(&log, &run).expect("message");

        assert_eq!(message.content, "echo: hello msp");
        assert_eq!(message.id, "assistant-run-1");
        let usage = message.usage.expect("usage");
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 4);
        assert_eq!(usage.cache_read_input_tokens, 3);
        assert_eq!(
            parse_muse_lines(&log).expect("parse").session_id,
            "marker-session"
        );
    }

    #[test]
    fn tool_call_lifecycle_becomes_one_tool_call_with_output() {
        let started = json!({"jsonrpc":"2.0","method":"item/started","params":{"sessionId":"s","viewCursor":"v","item":{
            "itemId":"tool-1","kind":"toolCall","status":"inProgress","revision":1,"turnId":"t",
            "tool":"read_file","args":"{\"path\":\"README.md\"}","callId":"call_abc",
            "displayLabel":{"active":"Reading README.md","done":"Read README.md","neutral":"Read"}}}});
        let delta = json!({"jsonrpc":"2.0","method":"item/delta","params":{"sessionId":"s","viewCursor":"v",
            "itemId":"tool-1","field":"output","delta":"# Jean\n"}});
        let completed = json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"s","viewCursor":"v","item":{
            "itemId":"tool-1","kind":"toolCall","status":"completed","revision":2,"turnId":"t",
            "tool":"read_file","args":"{\"path\":\"README.md\"}","callId":"call_abc","visibleOutput":"# Jean\nA desktop app."}}});
        let failed = json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"s","viewCursor":"v","item":{
            "itemId":"tool-2","kind":"toolCall","status":"failed","revision":1,"turnId":"t",
            "tool":"shell","args":"not json at all","failureReason":"command refused"}}});

        let mut parser = MuseStreamParser::default();
        let mut response = MuseResponse::empty("");
        for value in [started, delta, completed, failed] {
            for item in parser.parse(&value) {
                apply_stream_item(&mut response, &item);
            }
        }

        assert_eq!(response.tool_calls.len(), 2);
        let read = &response.tool_calls[0];
        assert_eq!(read.id, "tool-1");
        assert_eq!(read.name, "read_file");
        assert_eq!(read.input, json!({"path": "README.md"}));
        assert_eq!(read.output.as_deref(), Some("# Jean\nA desktop app."));
        assert_eq!(read.is_error, None);
        let shell = &response.tool_calls[1];
        assert_eq!(shell.input, json!({"raw": "not json at all"}));
        assert_eq!(shell.output.as_deref(), Some("command refused"));
        assert_eq!(shell.is_error, Some(true));
        assert_eq!(
            blocks_json(&response.content_blocks),
            json!([
                {"type": "tool_use", "tool_call_id": "tool-1"},
                {"type": "tool_use", "tool_call_id": "tool-2"}
            ])
        );
    }

    #[test]
    fn reasoning_summary_deltas_become_thinking_without_duplication() {
        let started = json!({"method":"item/started","params":{"item":{"itemId":"r1","kind":"reasoning","status":"inProgress"}}});
        let part0 = json!({"method":"item/delta","params":{"itemId":"r1","field":"summary.0","delta":"Look at"}});
        let part0b = json!({"method":"item/delta","params":{"itemId":"r1","field":"summary.0","delta":" files"}});
        let part1 = json!({"method":"item/delta","params":{"itemId":"r1","field":"summary.1","delta":"Then edit"}});
        let completed = json!({"method":"item/completed","params":{"item":{"itemId":"r1","kind":"reasoning","status":"completed","summary":["Look at files","Then edit"]}}});

        let mut parser = MuseStreamParser::default();
        let mut thinking = Vec::new();
        for value in [started, part0, part0b, part1, completed] {
            for item in parser.parse(&value) {
                match item {
                    MuseStreamItem::Thinking(text) => thinking.push(text),
                    other => panic!("unexpected {other:?}"),
                }
            }
        }
        assert_eq!(thinking.concat(), "Look at files\nThen edit");
    }

    #[test]
    fn agent_message_completed_without_deltas_emits_full_text() {
        let completed = json!({"method":"item/completed","params":{"item":{"itemId":"m1","kind":"agentMessage","status":"completed","text":"Done."}}});
        let mut parser = MuseStreamParser::default();
        assert_eq!(
            parser.parse(&completed),
            vec![MuseStreamItem::Text("Done.".to_string())]
        );
    }

    #[test]
    fn failed_turn_carries_error_message() {
        let value = json!({"method":"turn/completed","params":{"terminal":"failed","error":{"kind":"provider","message":"quota exhausted","retryable":false}}});
        assert_eq!(
            turn_outcome(&value),
            Some(TurnOutcome::Failed("quota exhausted".to_string()))
        );
        let cancelled = json!({"method":"turn/completed","params":{"terminal":"cancelled"}});
        assert_eq!(turn_outcome(&cancelled), Some(TurnOutcome::Cancelled));
    }

    #[test]
    fn approval_decision_follows_mode() {
        let params = json!({
            "sessionId": "s", "approvalId": "a1",
            "currentRequirementId": {"approvalId": "a1", "sourceIndex": 0},
            "availableChoices": [
                {"choiceId": "allow-once", "decision": "approved", "label": "Allow", "scope": "once"},
                {"choiceId": "deny", "decision": "denied", "label": "Deny", "scope": "once"}
            ]
        });
        let approve = approval_decision(&params, true).expect("approve");
        assert_eq!(approve["choiceId"], "allow-once");
        assert_eq!(approve["requirementId"]["sourceIndex"], 0);
        let deny = approval_decision(&params, false).expect("deny");
        assert_eq!(deny["choiceId"], "deny");
        assert!(uuid::Uuid::parse_str(deny["commandId"].as_str().unwrap()).is_ok());
    }

    #[test]
    fn jean_mcp_entry_converts_to_optional_msp_stdio_server() {
        let entry = json!({"jean": {"type": "stdio", "command": "/opt/jean", "args": ["--jean-mcp-stdio"], "env": {"JEAN_MCP_TOKEN": "t"}}});
        let servers = msp_mcp_servers(&entry).expect("servers");
        assert_eq!(
            servers,
            json!({"jean": {"transport": "stdio", "command": "/opt/jean", "args": ["--jean-mcp-stdio"], "env": {"JEAN_MCP_TOKEN": "t"}, "mode": "optional"}})
        );
        assert_eq!(msp_mcp_servers(&json!({})), None);
    }

    #[test]
    fn real_exec_json_yields_terminal_text_and_json_extraction_is_tolerant() {
        let text = exec_terminal_text(ECHO_EXEC).expect("terminal text");
        assert_eq!(
            text,
            "echo: Return only one valid JSON object with no markdown."
        );
        assert_eq!(
            extract_json_object("Sure:\n```json\n{\"slug\":\"x\"}\n```").unwrap(),
            "{\"slug\":\"x\"}"
        );
        assert!(extract_json_object(&text).is_err());
        let failed = r#"{"payload_type":"run.terminal.failed","payload":{"kind":"run_terminal","terminal":"failed","reason":"provider down"}}"#;
        assert_eq!(exec_terminal_text(failed).unwrap_err(), "provider down");
    }

    #[test]
    fn injects_jean_plan_tool_from_muse_plan_text() {
        let mut response = MuseResponse::empty("session-1");
        response.content = "1. Inspect\n2. Implement".to_string();
        let tool = inject_synthetic_plan(&mut response).expect("plan tool");
        assert_eq!(tool.name, "ExitPlanMode");
        assert_eq!(tool.input["source"], "muse");
        assert_eq!(tool.input["plan"], "1. Inspect\n2. Implement");
    }

    #[cfg(unix)]
    #[test]
    fn muse_msp_socket_path_is_short_under_app_data() {
        let app_data = Path::new("/Users/heyandras/Library/Application Support/com.jean.desktop");
        let socket_path = muse_msp_socket_path(
            app_data,
            "b1c8040f-8e62-48b7-b915-36c2bac0e1de",
            "1489571e-fdd5-45ed-a1b9-bf0ba4943924",
        );
        assert_eq!(socket_path.parent(), Some(app_data.join("m").as_path()));
        assert!(socket_path.to_string_lossy().len() < 104);
    }

    /// Drives the real detached host against `muse serve --provider echo`.
    /// Run with: cargo test -p jean-core muse::tests::echo_host_round_trip -- --ignored
    #[cfg(unix)]
    #[test]
    fn host_args_parse_with_leading_host_flag() {
        let argv = [
            MUSE_MSP_HOST_ARG,
            "--socket",
            "/tmp/s.sock",
            "--output",
            "/tmp/run.jsonl",
            "--cwd",
            "/tmp/repo",
            "--muse-cli",
            "/opt/muse",
            "--model",
            "muse/muse-spark-1.2",
            "--execution-mode",
            "build",
        ]
        .map(String::from);
        let config = parse_muse_host_args(argv.into_iter()).unwrap();
        assert_eq!(config.socket_path, PathBuf::from("/tmp/s.sock"));
        assert_eq!(config.output_file, PathBuf::from("/tmp/run.jsonl"));
        assert_eq!(config.cwd, PathBuf::from("/tmp/repo"));
        assert_eq!(config.muse_cli, PathBuf::from("/opt/muse"));
        assert_eq!(config.model.as_deref(), Some("muse/muse-spark-1.2"));
        assert_eq!(config.execution_mode.as_deref(), Some("build"));
        assert_eq!(config.existing_session, None);
    }

    #[cfg(unix)]
    #[test]
    #[ignore]
    fn echo_host_round_trip() {
        use std::os::unix::net::UnixStream;

        let muse = dirs::home_dir().unwrap().join(".local/bin/muse");
        assert!(muse.is_file(), "muse CLI missing at {}", muse.display());
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("repo");
        std::fs::create_dir_all(&cwd).unwrap();
        let config = MuseHostConfig {
            socket_path: temp.path().join("h.sock"),
            output_file: temp.path().join("run.jsonl"),
            cwd,
            muse_cli: muse,
            execution_mode: Some("build".to_string()),
            developer_prompt: Some("You are Jean.".to_string()),
            provider: Some("echo".to_string()),
            ..Default::default()
        };
        let socket_path = config.socket_path.clone();
        let output_file = config.output_file.clone();
        let host = std::thread::spawn(move || run_muse_msp_host(config));

        let started = Instant::now();
        while UnixStream::connect(&socket_path).is_err() {
            assert!(
                started.elapsed() < Duration::from_secs(30),
                "host socket never appeared"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        send_muse_msp_host_command(
            &socket_path,
            &serialize_muse_host_command("prompt", Some("hi from jean")),
        )
        .unwrap();
        host.join().unwrap().expect("host run");

        let log = lines(&std::fs::read_to_string(&output_file).unwrap());
        let response = parse_muse_lines(&log).expect("parse");
        assert_eq!(response.content, "echo: hi from jean");
        assert!(!response.session_id.is_empty(), "session marker missing");
        assert!(!response.cancelled);
        let markers = log
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|value| {
                value
                    .get("type")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>();
        assert_eq!(markers, vec!["session", "result"], "host markers: {log:?}");
        assert!(
            log.iter()
                .any(|line| line.contains(r#""method":"turn/completed""#)),
            "server lines must be written verbatim"
        );
    }
}
