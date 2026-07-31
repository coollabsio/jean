//! Kimi Code ACP execution engine.
//!
//! On Unix, Jean starts each turn through a detached ACP host so Kimi keeps
//! running while Jean is closed; Jean tails the host's run JSONL and reattaches
//! after restart. Windows uses the attached ACP fallback.

use super::types::{ChatMessage, ContentBlock, MessageRole, RunEntry, ToolCall, UsageData};
use crate::http_server::EmitExt;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(not(unix))]
use std::process::Child;
use std::process::{ChildStdin, ChildStdout, Stdio};
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
/// Jean self-relaunch flag for the detached Kimi ACP host (Unix).
pub const KIMI_ACP_HOST_ARG: &str = "--jean-kimi-acp-host";

#[derive(Debug, Clone, PartialEq)]
enum KimiStreamItem {
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

pub struct KimiResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

pub struct KimiExecutionOptions<'a> {
    pub app: &'a AppHandle,
    pub jean_session_id: &'a str,
    pub worktree_id: &'a str,
    pub working_dir: &'a Path,
    pub output_file: &'a Path,
    pub existing_kimi_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub execution_mode: Option<&'a str>,
    pub effort_level: Option<&'a str>,
    pub message: &'a str,
    pub system_prompt: Option<&'a str>,
    pub pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
}

fn kimi_mode(mode: Option<&str>) -> &'static str {
    match mode.unwrap_or("plan") {
        "build" => "auto",
        "yolo" => "yolo",
        _ => "plan",
    }
}

fn kimi_model(model: Option<&str>) -> Option<&str> {
    model
        .and_then(|value| value.strip_prefix("kimi/").or(Some(value)))
        .filter(|value| !value.is_empty() && *value != "default")
}

fn kimi_thinking(effort: Option<&str>) -> Option<&'static str> {
    effort
        .filter(|value| !value.is_empty())
        .map(|value| if value == "off" { "off" } else { "on" })
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

fn parse_stream_item(value: &Value) -> Option<KimiStreamItem> {
    let update = update_from_message(value)?;
    match update.get("sessionUpdate").and_then(Value::as_str)? {
        "agent_message_chunk" => Some(KimiStreamItem::Text(text_content(update.get("content")?)?)),
        "agent_thought_chunk" => Some(KimiStreamItem::Thinking(text_content(
            update.get("content")?,
        )?)),
        "tool_call" => Some(KimiStreamItem::ToolStart {
            id: update.get("toolCallId")?.as_str()?.to_string(),
            name: update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Tool")
                .to_string(),
            input: update.get("rawInput").cloned().unwrap_or(Value::Null),
        }),
        "tool_call_update" => {
            let completed = matches!(
                update.get("status").and_then(Value::as_str),
                Some("completed" | "failed")
            );
            if !completed {
                return None;
            }
            let output = update
                .get("rawOutput")
                .and_then(text_content)
                .or_else(|| update.get("content").and_then(text_content))
                .unwrap_or_default();
            Some(KimiStreamItem::ToolResult {
                id: update.get("toolCallId")?.as_str()?.to_string(),
                output,
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
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })
    )
    .map_err(|error| format!("Failed to write Kimi ACP request: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Failed to flush Kimi ACP request: {error}"))
}

fn send_response(stdin: &mut ChildStdin, id: &Value, result: Value) -> Result<(), String> {
    writeln!(
        stdin,
        "{}",
        serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
    )
    .map_err(|error| format!("Failed to write Kimi ACP response: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Failed to flush Kimi ACP response: {error}"))
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
        Some(option_id) => serde_json::json!({
            "outcome": {"outcome": "selected", "optionId": option_id}
        }),
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
            .map_err(|error| format!("Failed to read Kimi ACP response: {error}"))?
            == 0
        {
            return Err("Kimi ACP exited before responding".to_string());
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if handle_reverse_request(stdin, &value, execution_mode)? {
            continue;
        }
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Kimi ACP request failed: {error}"));
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

fn merge_kimi_host_line(response: &mut KimiResponse, value: &Value) -> Result<bool, String> {
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
            if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
                response.usage = Some(usage_from_value(usage));
            }
            response.cancelled = value
                .get("cancelled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(true)
        }
        Some("error") => Err(value
            .get("error")
            .map(ToString::to_string)
            .unwrap_or_else(|| "Kimi ACP host failed".to_string())),
        _ => Ok(false),
    }
}

#[cfg(unix)]
pub(crate) fn kimi_acp_socket_path(app_data_dir: &Path, session_id: &str, run_id: &str) -> PathBuf {
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

    app_data_dir.join("k").join(format!(
        "s{}-r{}.sock",
        short_id(session_id),
        short_id(run_id)
    ))
}

pub(crate) fn serialize_kimi_host_command(command_type: &str, message: Option<&str>) -> String {
    let mut value = serde_json::Map::new();
    value.insert("type".to_string(), Value::String(command_type.to_string()));
    if let Some(message) = message {
        value.insert("message".to_string(), Value::String(message.to_string()));
    }
    format!("{}\n", Value::Object(value))
}

fn prompt_blocks(message: &str) -> Result<Value, String> {
    let image_paths = super::commands::extract_image_paths(message);
    let mut cleaned = message.to_string();
    let mut blocks = Vec::with_capacity(image_paths.len() + 1);
    for path in image_paths {
        cleaned = cleaned.replace(
            &format!("[Image attached: {path} - Use the Read tool to view this image]"),
            "",
        );
        let data = std::fs::read(&path)
            .map_err(|error| format!("Failed to read Kimi image attachment {path}: {error}"))?;
        let mime_type = match Path::new(&path)
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
        blocks.push(serde_json::json!({
            "type": "image",
            "data": STANDARD.encode(data),
            "mimeType": mime_type,
        }));
    }
    blocks.insert(
        0,
        serde_json::json!({"type": "text", "text": cleaned.trim()}),
    );
    Ok(Value::Array(blocks))
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

fn inject_synthetic_plan(response: &mut KimiResponse) -> Option<ToolCall> {
    if response.content.trim().is_empty()
        || response
            .tool_calls
            .iter()
            .any(|tool| matches!(tool.name.as_str(), "ExitPlanMode" | "CodexPlan"))
    {
        return None;
    }
    let tool = ToolCall {
        id: "kimi-plan".to_string(),
        name: "ExitPlanMode".to_string(),
        input: serde_json::json!({
            "source": "kimi",
            "plan": response.content,
        }),
        output: None,
        parent_tool_use_id: None,
    };
    response.content_blocks.push(ContentBlock::ToolUse {
        tool_call_id: tool.id.clone(),
    });
    response.tool_calls.push(tool.clone());
    Some(tool)
}

fn configure_session(
    reader: &mut BufReader<ChildStdout>,
    stdin: &mut ChildStdin,
    next_id: &mut i64,
    session_id: &str,
    model: Option<&str>,
    mode: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    let mut configure = |config_id: &str, value: &str| -> Result<(), String> {
        let id = *next_id;
        *next_id += 1;
        send_request(
            stdin,
            id,
            "session/set_config_option",
            serde_json::json!({
                "sessionId": session_id,
                "configId": config_id,
                "value": value,
            }),
        )?;
        read_response(reader, stdin, id, mode)?;
        Ok(())
    };

    configure("mode", kimi_mode(mode))?;
    if let Some(model) = kimi_model(model) {
        configure("model", model)?;
    }
    if let Some(thinking) = kimi_thinking(effort) {
        configure("thinking", thinking)?;
    }
    Ok(())
}

#[cfg(unix)]
fn wait_for_kimi_acp_socket(socket_path: &Path, pid: u32) -> Result<(), String> {
    use crate::platform::is_process_alive;
    use std::os::unix::net::UnixStream;

    let started = Instant::now();
    let timeout = Duration::from_secs(60);
    loop {
        if UnixStream::connect(socket_path).is_ok() {
            return Ok(());
        }
        if !is_process_alive(pid) {
            return Err(format!(
                "Kimi ACP host exited before socket appeared at {}",
                socket_path.display()
            ));
        }
        if started.elapsed() > timeout {
            return Err(format!(
                "Timed out waiting for Kimi ACP host socket at {}",
                socket_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
pub(crate) fn send_kimi_acp_host_command(socket_path: &Path, line: &str) -> Result<(), String> {
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket_path)
        .map_err(|error| format!("Failed to connect to Kimi ACP host: {error}"))?;
    stream
        .write_all(line.as_bytes())
        .map_err(|error| format!("Failed to write Kimi ACP host command: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("Failed to flush Kimi ACP host command: {error}"))
}

#[cfg(unix)]
fn spawn_kimi_acp_host(
    options: &KimiExecutionOptions<'_>,
    cli_path: &Path,
) -> Result<(u32, PathBuf), String> {
    let app_data = options
        .app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    let run_id = super::pi::run_id_from_output_file(options.output_file);
    let socket_path = kimi_acp_socket_path(&app_data, options.jean_session_id, &run_id);
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Kimi ACP socket directory: {error}"))?;
    }
    let _ = std::fs::remove_file(&socket_path);

    let log_dir = app_data.join("kimi-acp-hosts");
    std::fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Failed to create Kimi ACP host log directory: {error}"))?;
    let log_file = log_dir.join(format!("{}-{run_id}.log", options.jean_session_id));
    let executable = super::detached::current_executable_for_detached_host()?;
    let mut args = vec![
        KIMI_ACP_HOST_ARG.to_string(),
        "--socket".to_string(),
        socket_path.to_string_lossy().to_string(),
        "--output".to_string(),
        options.output_file.to_string_lossy().to_string(),
        "--cwd".to_string(),
        options.working_dir.to_string_lossy().to_string(),
        "--kimi-cli".to_string(),
        cli_path.to_string_lossy().to_string(),
        "--jean-session".to_string(),
        options.jean_session_id.to_string(),
        "--worktree".to_string(),
        options.worktree_id.to_string(),
    ];
    for (name, value) in [
        ("--existing-session", options.existing_kimi_session_id),
        ("--model", options.model),
        ("--execution-mode", options.execution_mode),
        ("--effort", options.effort_level),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            args.push(name.to_string());
            args.push(value.to_string());
        }
    }

    let pid = super::detached::spawn_detached_process(&executable, &args, &log_file, &app_data)?;
    wait_for_kimi_acp_socket(&socket_path, pid)?;
    Ok((pid, socket_path))
}

#[cfg(unix)]
fn write_host_line(output: &Arc<Mutex<std::fs::File>>, value: &Value) -> Result<(), String> {
    let mut output = output
        .lock()
        .map_err(|_| "Kimi ACP output file lock poisoned".to_string())?;
    writeln!(output, "{value}")
        .map_err(|error| format!("Failed to write Kimi ACP output: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("Failed to flush Kimi ACP output: {error}"))
}

/// Detached Kimi ACP host entrypoint. It owns the ACP stdio pipes and appends
/// stream updates to the run JSONL, allowing Jean to quit and reattach later.
#[cfg(unix)]
pub fn run_kimi_acp_host_from_args() -> Result<(), String> {
    use crate::platform::silent_command;
    use std::os::unix::net::{UnixListener, UnixStream};

    let mut socket_path = None;
    let mut output_file = None;
    let mut cwd = None;
    let mut kimi_cli = None;
    let mut existing_session = None;
    let mut jean_session_id = None;
    let mut worktree_id = None;
    let mut model = None;
    let mut execution_mode = None;
    let mut effort = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket_path = args.next().map(PathBuf::from),
            "--output" => output_file = args.next().map(PathBuf::from),
            "--cwd" => cwd = args.next().map(PathBuf::from),
            "--kimi-cli" => kimi_cli = args.next().map(PathBuf::from),
            "--existing-session" => existing_session = args.next(),
            "--jean-session" => jean_session_id = args.next(),
            "--worktree" => worktree_id = args.next(),
            "--model" => model = args.next(),
            "--execution-mode" => execution_mode = args.next(),
            "--effort" => effort = args.next(),
            _ => {}
        }
    }

    let socket_path = socket_path.ok_or("--socket is required")?;
    let output_file = output_file.ok_or("--output is required")?;
    let cwd = cwd.ok_or("--cwd is required")?;
    let kimi_cli = kimi_cli.ok_or("--kimi-cli is required")?;
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Kimi ACP socket directory: {error}"))?;
    }
    let output = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_file)
            .map_err(|error| format!("Failed to open Kimi ACP output: {error}"))?,
    ));

    let mut command = silent_command(&kimi_cli);
    command
        .arg("acp")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(session_id) = jean_session_id {
        command.env("JEAN_SESSION_ID", session_id);
    }
    if let Some(worktree_id) = worktree_id {
        command.env("JEAN_WORKTREE_ID", worktree_id);
    }
    let (depth_key, depth_value) = super::jean_mcp::child_depth_env();
    command.env(depth_key, depth_value);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Kimi Code ACP: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Failed to open Kimi ACP stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture Kimi ACP stdout")?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[kimi-acp] {line}");
            }
        });
    }
    let mut reader = BufReader::new(stdout);
    let mode = execution_mode.as_deref();
    let mut next_id = 1;

    send_request(
        &mut stdin,
        next_id,
        "initialize",
        serde_json::json!({"protocolVersion": 1, "clientCapabilities": {}}),
    )?;
    let initialize = read_response(&mut reader, &mut stdin, next_id, mode)?;
    next_id += 1;
    let auth_method = initialize
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
    read_response(&mut reader, &mut stdin, next_id, mode)
        .map_err(|_| "Kimi Code is not authenticated. Run `kimi login`.".to_string())?;
    next_id += 1;

    let (session_method, session_params) = match existing_session
        .as_deref()
        .filter(|session_id| !session_id.is_empty())
    {
        Some(session_id) => (
            "session/resume",
            serde_json::json!({
                "sessionId": session_id,
                "cwd": cwd.to_string_lossy(),
                "mcpServers": [],
            }),
        ),
        None => (
            "session/new",
            serde_json::json!({"cwd": cwd.to_string_lossy(), "mcpServers": []}),
        ),
    };
    send_request(&mut stdin, next_id, session_method, session_params)?;
    let session_response = read_response(&mut reader, &mut stdin, next_id, mode)?;
    next_id += 1;
    let session_id = session_id_from_response(&session_response)
        .or(existing_session)
        .ok_or("Kimi ACP did not return a session id")?;
    configure_session(
        &mut reader,
        &mut stdin,
        &mut next_id,
        &session_id,
        model.as_deref(),
        mode,
        effort.as_deref(),
    )?;
    write_host_line(
        &output,
        &serde_json::json!({"type": "session", "session_id": session_id}),
    )?;

    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)
        .map_err(|error| format!("Failed to bind Kimi ACP host socket: {error}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let abort = Arc::new(AtomicBool::new(false));
    let (prompt_tx, prompt_rx) = mpsc::channel();
    let listener_stop = stop.clone();
    let listener_abort = abort.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if listener_stop.load(Ordering::SeqCst) {
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
                        let _ = prompt_tx.send(message.to_string());
                    }
                }
                Some("abort") => listener_abort.store(true, Ordering::SeqCst),
                _ => {}
            }
        }
    });

    let message = prompt_rx
        .recv_timeout(Duration::from_secs(120))
        .map_err(|_| "Timed out waiting for Kimi ACP prompt".to_string())?;
    send_request(
        &mut stdin,
        next_id,
        "session/prompt",
        serde_json::json!({"sessionId": session_id, "prompt": prompt_blocks(&message)?}),
    )?;
    let prompt_id = next_id;
    let mut prompt_result = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|error| format!("Failed to read Kimi ACP stream: {error}"))?
            == 0
        {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if handle_reverse_request(&mut stdin, &value, mode)? {
            continue;
        }
        if update_from_message(&value).is_some() {
            write_host_line(&output, &value)?;
        }
        if value.get("id").and_then(Value::as_i64) == Some(prompt_id) {
            prompt_result = Some(value);
            break;
        }
        if abort.load(Ordering::SeqCst) {
            break;
        }
    }

    let result_marker = match prompt_result {
        Some(value) if value.get("error").is_some() => serde_json::json!({
            "type": "error",
            "session_id": session_id,
            "error": value.get("error"),
        }),
        None if !abort.load(Ordering::SeqCst) => serde_json::json!({
            "type": "error",
            "session_id": session_id,
            "error": "Kimi ACP exited before the turn completed",
        }),
        value => {
            let usage = value.as_ref().and_then(usage_from_result);
            let cancelled = abort.load(Ordering::SeqCst)
                || value
                    .as_ref()
                    .and_then(|value| value.pointer("/result/stopReason"))
                    .and_then(Value::as_str)
                    == Some("cancelled");
            serde_json::json!({
                "type": "result",
                "session_id": session_id,
                "usage": usage,
                "cancelled": cancelled,
            })
        }
    };
    write_host_line(&output, &result_marker)?;

    stop.store(true, Ordering::SeqCst);
    let _ = UnixStream::connect(&socket_path);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&socket_path);
    Ok(())
}

#[cfg(not(unix))]
pub fn run_kimi_acp_host_from_args() -> Result<(), String> {
    Err("Kimi ACP host is only supported on Unix-like systems".to_string())
}

fn apply_kimi_stream_item(response: &mut KimiResponse, item: &KimiStreamItem) {
    match item {
        KimiStreamItem::Text(text) => {
            response.content.push_str(text);
            push_text_block(&mut response.content_blocks, text);
        }
        KimiStreamItem::Thinking(thinking) => {
            response.content_blocks.push(ContentBlock::Thinking {
                thinking: thinking.clone(),
            });
        }
        KimiStreamItem::ToolStart { id, name, input } => {
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
                });
            }
        }
        KimiStreamItem::ToolResult { id, output } => {
            if let Some(tool) = response.tool_calls.iter_mut().find(|tool| tool.id == *id) {
                tool.output = Some(output.clone());
            }
        }
    }
}

pub fn tail_kimi_output(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &Path,
    pid: u32,
) -> Result<KimiResponse, String> {
    use super::tail::{next_poll_interval, NdjsonTailer};
    use crate::platform::is_process_alive;

    let mut tailer = NdjsonTailer::new_from_start(output_file)?;
    let mut response = KimiResponse {
        content: String::new(),
        session_id: String::new(),
        tool_calls: vec![],
        content_blocks: vec![],
        cancelled: false,
        usage: None,
    };
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
            completed |= merge_kimi_host_line(&mut response, &value)?;
            if let Some(item) = parse_stream_item(&value) {
                apply_kimi_stream_item(&mut response, &item);
                match item {
                    KimiStreamItem::Text(content) => emit(
                        app,
                        "chat:chunk",
                        serde_json::json!({
                            "session_id": session_id,
                            "worktree_id": worktree_id,
                            "content": content,
                        }),
                    ),
                    KimiStreamItem::Thinking(content) => emit(
                        app,
                        "chat:thinking",
                        serde_json::json!({
                            "session_id": session_id,
                            "worktree_id": worktree_id,
                            "content": content,
                        }),
                    ),
                    KimiStreamItem::ToolStart { id, name, input } => {
                        emit(
                            app,
                            "chat:tool_use",
                            serde_json::json!({
                                "session_id": session_id,
                                "worktree_id": worktree_id,
                                "id": id,
                                "name": name,
                                "input": input,
                            }),
                        );
                        emit(
                            app,
                            "chat:tool_block",
                            serde_json::json!({
                                "session_id": session_id,
                                "worktree_id": worktree_id,
                                "tool_call_id": id,
                            }),
                        );
                    }
                    KimiStreamItem::ToolResult { id, output } => emit(
                        app,
                        "chat:tool_result",
                        serde_json::json!({
                            "session_id": session_id,
                            "worktree_id": worktree_id,
                            "tool_use_id": id,
                            "output": output,
                        }),
                    ),
                }
            }
            received_output = true;
            last_output_at = Instant::now();
        }

        if completed {
            break;
        }
        if !is_process_alive(pid) {
            if !received_output && started_at.elapsed() > startup_timeout {
                response.cancelled = true;
                break;
            }
            if received_output && last_output_at.elapsed() > dead_process_timeout {
                response.cancelled = true;
                break;
            }
        }
        std::thread::sleep(next_poll_interval(got_lines, last_output_at.elapsed()));
    }

    response.content = response.content.trim().to_string();
    Ok(response)
}

pub(crate) fn parse_kimi_run_to_message(
    lines: &[String],
    run: &RunEntry,
) -> Result<ChatMessage, String> {
    let mut response = KimiResponse {
        content: String::new(),
        session_id: String::new(),
        tool_calls: vec![],
        content_blocks: vec![],
        cancelled: false,
        usage: None,
    };
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let _ = merge_kimi_host_line(&mut response, &value)?;
        if let Some(item) = parse_stream_item(&value) {
            apply_kimi_stream_item(&mut response, &item);
        }
    }
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
        execution_mode: run.execution_mode.clone(),
        thinking_level: run.thinking_level.clone(),
        effort_level: run.effort_level.clone(),
        recovered: run.recovered,
        usage: response.usage.or_else(|| run.usage.clone()),
    })
}

pub(crate) fn finish_kimi_response(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    execution_mode: Option<&str>,
    mut response: KimiResponse,
) -> KimiResponse {
    if !response.cancelled {
        let waiting_for_plan = execution_mode == Some("plan");
        if waiting_for_plan {
            if let Some(tool) = inject_synthetic_plan(&mut response) {
                emit(
                    app,
                    "chat:tool_use",
                    serde_json::json!({
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
                    serde_json::json!({
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
            serde_json::json!({
                "session_id": session_id,
                "worktree_id": worktree_id,
                "waiting_for_plan": waiting_for_plan,
            }),
        );
    }
    response
}

pub fn execute_kimi(mut options: KimiExecutionOptions<'_>) -> Result<KimiResponse, String> {
    let cli_path = crate::kimi_cli::resolve_cli_binary(options.app);
    if !crate::kimi_cli::binary_exists(&cli_path) {
        return Err("Kimi Code CLI not installed".to_string());
    }

    #[cfg(unix)]
    let result = execute_kimi_detached(&mut options, &cli_path);
    #[cfg(not(unix))]
    let result = execute_kimi_attached(&mut options, &cli_path);

    result.map(|response| {
        finish_kimi_response(
            options.app,
            options.jean_session_id,
            options.worktree_id,
            options.execution_mode,
            response,
        )
    })
}

#[cfg(unix)]
fn execute_kimi_detached(
    options: &mut KimiExecutionOptions<'_>,
    cli_path: &Path,
) -> Result<KimiResponse, String> {
    let prepared_message = prepared_message(options.message, options.system_prompt);
    let (pid, socket_path) = spawn_kimi_acp_host(options, cli_path)?;
    if let Some(callback) = options.pid_callback.take() {
        callback(pid);
    }
    if !super::registry::register_detached_process(options.jean_session_id.to_string(), pid) {
        let _ = crate::platform::kill_process_tree(pid);
        let _ = crate::platform::kill_process(pid);
        return Ok(KimiResponse {
            content: String::new(),
            session_id: options
                .existing_kimi_session_id
                .unwrap_or_default()
                .to_string(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            usage: None,
        });
    }

    let prompt = serialize_kimi_host_command("prompt", Some(&prepared_message));
    if let Err(error) = send_kimi_acp_host_command(&socket_path, &prompt) {
        super::registry::unregister_process(options.jean_session_id);
        let _ = crate::platform::kill_process_tree(pid);
        let _ = crate::platform::kill_process(pid);
        return Err(error);
    }

    super::increment_tailer_count();
    let result = tail_kimi_output(
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
            .existing_kimi_session_id
            .unwrap_or_default()
            .to_string();
    }
    Ok(response)
}

#[cfg(not(unix))]
fn execute_kimi_attached(
    options: &mut KimiExecutionOptions<'_>,
    cli_path: &Path,
) -> Result<KimiResponse, String> {
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
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Kimi Code ACP: {error}"))?;
    let pid = child.id();
    if let Some(callback) = options.pid_callback.take() {
        callback(pid);
    }
    if !super::registry::register_process(options.jean_session_id.to_string(), pid) {
        let _ = child.kill();
        return Ok(KimiResponse {
            content: String::new(),
            session_id: options
                .existing_kimi_session_id
                .unwrap_or_default()
                .to_string(),
            tool_calls: Vec::new(),
            content_blocks: Vec::new(),
            cancelled: true,
            usage: None,
        });
    }

    let result = execute_kimi_child(&mut child, options);
    let cancelled = !super::registry::is_process_running(options.jean_session_id);
    super::registry::unregister_process(options.jean_session_id);
    let _ = child.kill();
    let _ = child.wait();

    match result {
        Ok(mut response) => {
            response.cancelled |= cancelled;
            Ok(response)
        }
        Err(_error) if cancelled => Ok(KimiResponse {
            content: String::new(),
            session_id: options
                .existing_kimi_session_id
                .unwrap_or_default()
                .to_string(),
            tool_calls: Vec::new(),
            content_blocks: Vec::new(),
            cancelled: true,
            usage: None,
        }),
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn execute_kimi_child(
    child: &mut Child,
    options: &KimiExecutionOptions<'_>,
) -> Result<KimiResponse, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture Kimi ACP stdout")?;
    let mut stdin = child.stdin.take().ok_or("Failed to open Kimi ACP stdin")?;
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = String::new();
            let _ = stderr.read_to_string(&mut sink);
            if !sink.trim().is_empty() {
                log::debug!("[Kimi ACP stderr] {}", sink.trim());
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
    let initialize = read_response(&mut reader, &mut stdin, next_id, options.execution_mode)?;
    next_id += 1;
    let auth_method = initialize
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
        .map_err(|_| "Kimi Code is not authenticated. Run `kimi login`.".to_string())?;
    next_id += 1;

    let (method, params) = match options
        .existing_kimi_session_id
        .filter(|session_id| !session_id.is_empty())
    {
        Some(session_id) => (
            "session/resume",
            serde_json::json!({
                "sessionId": session_id,
                "cwd": options.working_dir.to_string_lossy(),
                "mcpServers": [],
            }),
        ),
        None => (
            "session/new",
            serde_json::json!({
                "cwd": options.working_dir.to_string_lossy(),
                "mcpServers": [],
            }),
        ),
    };
    send_request(&mut stdin, next_id, method, params)?;
    let session_response = read_response(&mut reader, &mut stdin, next_id, options.execution_mode)?;
    next_id += 1;
    let session_id = session_id_from_response(&session_response)
        .or_else(|| options.existing_kimi_session_id.map(ToOwned::to_owned))
        .ok_or("Kimi ACP did not return a session id")?;

    configure_session(
        &mut reader,
        &mut stdin,
        &mut next_id,
        &session_id,
        options.model,
        options.execution_mode,
        options.effort_level,
    )?;

    let message = prepared_message(options.message, options.system_prompt);
    send_request(
        &mut stdin,
        next_id,
        "session/prompt",
        serde_json::json!({"sessionId": session_id, "prompt": prompt_blocks(&message)?}),
    )?;
    let prompt_id = next_id;

    let mut response = KimiResponse {
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
            .map_err(|error| format!("Failed to read Kimi ACP stream: {error}"))?
            == 0
        {
            return Err("Kimi ACP exited before the turn completed".to_string());
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if handle_reverse_request(&mut stdin, &value, options.execution_mode)? {
            continue;
        }
        if let Some(item) = parse_stream_item(&value) {
            match item {
                KimiStreamItem::Text(text) => {
                    response.content.push_str(&text);
                    push_text_block(&mut response.content_blocks, &text);
                    emit(
                        options.app,
                        "chat:chunk",
                        serde_json::json!({
                            "session_id": options.jean_session_id,
                            "worktree_id": options.worktree_id,
                            "content": text,
                        }),
                    );
                }
                KimiStreamItem::Thinking(thinking) => {
                    response.content_blocks.push(ContentBlock::Thinking {
                        thinking: thinking.clone(),
                    });
                    emit(
                        options.app,
                        "chat:thinking",
                        serde_json::json!({
                            "session_id": options.jean_session_id,
                            "worktree_id": options.worktree_id,
                            "content": thinking,
                        }),
                    );
                }
                KimiStreamItem::ToolStart { id, name, input } => {
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
                        });
                    }
                    emit(
                        options.app,
                        "chat:tool_use",
                        serde_json::json!({
                            "session_id": options.jean_session_id,
                            "worktree_id": options.worktree_id,
                            "id": id,
                            "name": name,
                            "input": input,
                        }),
                    );
                    emit(
                        options.app,
                        "chat:tool_block",
                        serde_json::json!({
                            "session_id": options.jean_session_id,
                            "worktree_id": options.worktree_id,
                            "tool_call_id": id,
                        }),
                    );
                }
                KimiStreamItem::ToolResult { id, output } => {
                    if let Some(tool) = response.tool_calls.iter_mut().find(|tool| tool.id == id) {
                        tool.output = Some(output.clone());
                    }
                    emit(
                        options.app,
                        "chat:tool_result",
                        serde_json::json!({
                            "session_id": options.jean_session_id,
                            "worktree_id": options.worktree_id,
                            "tool_use_id": id,
                            "output": output,
                        }),
                    );
                }
            }
        }
        if value.get("id").and_then(Value::as_i64) == Some(prompt_id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Kimi ACP prompt failed: {error}"));
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

fn extract_json_object(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if serde_json::from_str::<Value>(trimmed).is_ok() {
        return Ok(trimmed.to_string());
    }
    let start = trimmed
        .find('{')
        .ok_or("No JSON object found in Kimi response")?;
    let end = trimmed
        .rfind('}')
        .ok_or("No JSON object found in Kimi response")?;
    let candidate = &trimmed[start..=end];
    serde_json::from_str::<Value>(candidate)
        .map_err(|error| format!("Invalid JSON object in Kimi response: {error}"))?;
    Ok(candidate.to_string())
}

pub fn execute_one_shot_kimi(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    json_schema: Option<&str>,
    working_dir: Option<&Path>,
) -> Result<String, String> {
    let cli_path = crate::kimi_cli::resolve_cli_binary(app);
    if !crate::kimi_cli::binary_exists(&cli_path) {
        return Err("Kimi Code CLI not installed".to_string());
    }
    let schema_instruction = json_schema
        .map(|schema| format!(" The object must match this JSON Schema exactly: {schema}"))
        .unwrap_or_default();
    let prompt = format!(
        "{prompt}\n\nReturn only one valid JSON object with no markdown.{schema_instruction}"
    );
    let dir = working_dir.unwrap_or_else(|| Path::new("."));
    let mut command = crate::platform::cli_command(&cli_path.to_string_lossy(), Some(dir));
    command.args(["-p", &prompt]);
    if let Some(model) = kimi_model(Some(model)) {
        command.args(["--model", model]);
    }
    let output = command
        .current_dir(dir)
        .output()
        .map_err(|error| format!("Failed to run Kimi one-shot request: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Kimi one-shot request failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    extract_json_object(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_jean_execution_modes_to_kimi_acp_modes() {
        assert_eq!(kimi_mode(Some("plan")), "plan");
        assert_eq!(kimi_mode(Some("build")), "auto");
        assert_eq!(kimi_mode(Some("yolo")), "yolo");
        assert_eq!(kimi_mode(None), "plan");
    }

    #[test]
    fn strips_backend_prefix_and_uses_configured_default() {
        assert_eq!(kimi_model(Some("kimi/custom")), Some("custom"));
        assert_eq!(kimi_model(Some("kimi/default")), None);
        assert_eq!(kimi_model(None), None);
    }

    #[test]
    fn maps_jean_effort_to_kimi_thinking() {
        assert_eq!(kimi_thinking(Some("off")), Some("off"));
        assert_eq!(kimi_thinking(Some("high")), Some("on"));
        assert_eq!(kimi_thinking(None), None);
    }

    #[test]
    fn parses_assistant_and_thinking_chunks() {
        let assistant = serde_json::json!({
            "method": "session/update",
            "params": {"update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "hello"}
            }}
        });
        let thought = serde_json::json!({
            "method": "session/update",
            "params": {"update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "thinking"}
            }}
        });
        assert_eq!(
            parse_stream_item(&assistant),
            Some(KimiStreamItem::Text("hello".into()))
        );
        assert_eq!(
            parse_stream_item(&thought),
            Some(KimiStreamItem::Thinking("thinking".into()))
        );
    }

    #[test]
    fn parses_tool_start_and_result() {
        let start = serde_json::json!({
            "method": "session/update",
            "params": {"update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "1:call-1",
                "title": "Read",
                "rawInput": {"path": "README.md"}
            }}
        });
        let result = serde_json::json!({
            "method": "session/update",
            "params": {"update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "1:call-1",
                "status": "completed",
                "rawOutput": "done"
            }}
        });
        assert_eq!(
            parse_stream_item(&start),
            Some(KimiStreamItem::ToolStart {
                id: "1:call-1".into(),
                name: "Read".into(),
                input: serde_json::json!({"path": "README.md"}),
            })
        );
        assert_eq!(
            parse_stream_item(&result),
            Some(KimiStreamItem::ToolResult {
                id: "1:call-1".into(),
                output: "done".into()
            })
        );
    }

    #[test]
    fn injects_jean_plan_tool_from_kimi_plan_text() {
        let mut response = KimiResponse {
            content: "1. Inspect\n2. Implement".to_string(),
            session_id: "session-1".to_string(),
            tool_calls: vec![],
            content_blocks: vec![ContentBlock::Text {
                text: "1. Inspect\n2. Implement".to_string(),
            }],
            cancelled: false,
            usage: None,
        };

        let tool = inject_synthetic_plan(&mut response).expect("plan tool");

        assert_eq!(tool.name, "ExitPlanMode");
        assert_eq!(tool.input["source"], "kimi");
        assert_eq!(tool.input["plan"], "1. Inspect\n2. Implement");
    }

    #[cfg(unix)]
    #[test]
    fn kimi_acp_socket_path_is_short_under_app_data() {
        let app_data = Path::new("/Users/heyandras/Library/Application Support/com.jean.desktop");
        let socket_path = kimi_acp_socket_path(
            app_data,
            "b1c8040f-8e62-48b7-b915-36c2bac0e1de",
            "1489571e-fdd5-45ed-a1b9-bf0ba4943924",
        );

        assert!(socket_path.starts_with(app_data));
        assert_eq!(socket_path.parent(), Some(app_data.join("k").as_path()));
        assert!(socket_path.to_string_lossy().len() < 104);
    }

    #[test]
    fn detached_host_markers_restore_session_usage_and_completion() {
        let mut response = KimiResponse {
            content: String::new(),
            session_id: String::new(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: false,
            usage: None,
        };

        assert!(!merge_kimi_host_line(
            &mut response,
            &serde_json::json!({"type": "session", "session_id": "kimi-session-1"})
        )
        .expect("session marker"));
        assert!(merge_kimi_host_line(
            &mut response,
            &serde_json::json!({
                "type": "result",
                "session_id": "kimi-session-1",
                "usage": {"inputTokens": 12, "outputTokens": 4},
                "cancelled": false
            })
        )
        .expect("result marker"));

        assert_eq!(response.session_id, "kimi-session-1");
        assert_eq!(
            response.usage.as_ref().map(|usage| usage.input_tokens),
            Some(12)
        );
        assert_eq!(
            response.usage.as_ref().map(|usage| usage.output_tokens),
            Some(4)
        );
        assert!(!response.cancelled);
    }
}
