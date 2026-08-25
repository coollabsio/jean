//! Antigravity CLI headless execution engine.

use super::types::{ChatMessage, ContentBlock, MessageRole, RunEntry, ToolCall, UsageData};
use crate::http_server::EmitExt;
use serde_json::Value;
#[cfg(not(unix))]
use std::fs::OpenOptions;
#[cfg(not(unix))]
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
#[cfg(not(unix))]
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub struct AntigravityResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
    terminal_error: Option<String>,
    diagnostics: Vec<String>,
}

fn permission_diagnostic(response: &AntigravityResponse) -> Option<&str> {
    response.diagnostics.iter().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        (lower.contains("soft-denied")
            || (lower.contains("permission") && lower.contains("denied")))
        .then_some(line.as_str())
    })
}

pub struct AntigravityExecutionOptions<'a> {
    pub app: &'a AppHandle,
    pub jean_session_id: &'a str,
    pub worktree_id: &'a str,
    pub working_dir: &'a Path,
    pub output_file: &'a Path,
    pub existing_antigravity_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub execution_mode: Option<&'a str>,
    pub effort_level: Option<&'a str>,
    pub message: &'a str,
    pub system_prompt: Option<&'a str>,
    pub pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
}

fn antigravity_model(model: Option<&str>) -> Option<&str> {
    model
        .and_then(|value| value.strip_prefix("antigravity/").or(Some(value)))
        .filter(|value| !value.is_empty() && *value != "default" && *value != "auto")
}

fn mode_args(mode: Option<&str>) -> &'static [&'static str] {
    match mode.unwrap_or("plan") {
        "yolo" => &["--mode", "accept-edits", "--dangerously-skip-permissions"],
        "build" => &[
            "--mode",
            "accept-edits",
            "--sandbox",
            "--dangerously-skip-permissions",
        ],
        _ => &["--mode", "plan", "--sandbox"],
    }
}

fn emit(app: &AppHandle, event: &str, value: Value) {
    let _ = app.emit_all(event, &value);
}

fn usage(value: &Value) -> Option<UsageData> {
    let value = value.get("usage").unwrap_or(value);
    let number = |snake: &str, camel: &str| {
        value
            .get(snake)
            .or_else(|| value.get(camel))
            .and_then(Value::as_u64)
            .unwrap_or_default()
    };
    let result = UsageData {
        input_tokens: number("input_tokens", "inputTokens"),
        output_tokens: number("output_tokens", "outputTokens"),
        cache_read_input_tokens: number("cache_read_tokens", "cacheReadTokens"),
        cache_creation_input_tokens: 0,
    };
    (result.input_tokens + result.output_tokens + result.cache_read_input_tokens > 0)
        .then_some(result)
}

fn merge_usage(current: &mut Option<UsageData>, next: Option<UsageData>) {
    let Some(next) = next else {
        return;
    };
    match current {
        Some(current) => {
            current.input_tokens = current.input_tokens.max(next.input_tokens);
            current.output_tokens = current.output_tokens.max(next.output_tokens);
            current.cache_read_input_tokens = current
                .cache_read_input_tokens
                .max(next.cache_read_input_tokens);
        }
        None => *current = Some(next),
    }
}

fn tool_input(step: &Value) -> Value {
    step.pointer("/tool_info/parameters")
        .or_else(|| step.get("input"))
        .or_else(|| step.get("tool_input"))
        .or_else(|| step.get("args"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn merge_event(response: &mut AntigravityResponse, value: &Value) -> bool {
    match value.get("event").and_then(Value::as_str) {
        Some("init") => {
            if let Some(id) = value
                .get("conversation_id")
                .or_else(|| value.pointer("/init/conversation_id"))
                .and_then(Value::as_str)
            {
                response.session_id = id.to_string();
            }
        }
        Some("step_update") => {
            let step = value.get("step_update").unwrap_or(value);
            if let Some(id) = step.get("conversation_id").and_then(Value::as_str) {
                response.session_id = id.to_string();
            }
            merge_usage(&mut response.usage, usage(step));
            let kind = step
                .get("step_type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if kind == "agent_response" {
                if let Some(text) = step
                    .get("text_delta")
                    .or_else(|| step.get("text"))
                    .and_then(Value::as_str)
                {
                    response.content.push_str(text);
                    response.content_blocks.push(ContentBlock::Text {
                        text: text.to_string(),
                    });
                }
            } else if kind.contains("thinking") || kind.contains("reasoning") {
                if let Some(text) = step
                    .get("text_delta")
                    .or_else(|| step.get("text"))
                    .and_then(Value::as_str)
                {
                    response.content_blocks.push(ContentBlock::Thinking {
                        thinking: text.to_string(),
                    });
                }
            } else if kind.contains("tool") || kind == "command" || kind == "command_execution" {
                let id = step
                    .get("tool_call_id")
                    .or_else(|| step.get("step_id"))
                    .or_else(|| step.get("step_index"))
                    .map(|v| {
                        v.as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| v.to_string())
                    })
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let mut name = step
                    .pointer("/tool_info/name")
                    .or_else(|| step.get("tool_name"))
                    .or_else(|| step.get("name"))
                    .or_else(|| step.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or(kind)
                    .to_string();
                let mut input = tool_input(step);
                if let Some(subagents) = step
                    .pointer("/subagent_info/subagents")
                    .and_then(Value::as_array)
                {
                    name = "SpawnAgent".to_string();
                    let ids = subagents
                        .iter()
                        .filter_map(|agent| agent.get("conversation_id").and_then(Value::as_str))
                        .collect::<Vec<_>>();
                    let states = ids
                        .iter()
                        .map(|id| {
                            (
                                (*id).to_string(),
                                serde_json::json!({"status":"running","message":null}),
                            )
                        })
                        .collect::<serde_json::Map<_, _>>();
                    input = serde_json::json!({
                        "type":"sub_agent_activity",
                        "kind":"started",
                        "prompt":subagents.first().and_then(|agent| agent.get("role")).and_then(Value::as_str).unwrap_or("Antigravity subagents"),
                        "receiver_thread_ids":ids,
                        "agents_states":states,
                        "subagents":subagents,
                        "status":"completed"
                    });
                }
                let output = step
                    .pointer("/tool_info/output")
                    .or_else(|| step.pointer("/tool_info/error/message"))
                    .or_else(|| step.get("output"))
                    .or_else(|| step.get("result"))
                    .map(|v| {
                        v.as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| v.to_string())
                    });
                if let Some(tool) = response.tool_calls.iter_mut().find(|tool| tool.id == id) {
                    if output.is_some() {
                        tool.output = output;
                    }
                } else {
                    response.content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: id.clone(),
                    });
                    response.tool_calls.push(ToolCall {
                        id,
                        name,
                        input,
                        output,
                        parent_tool_use_id: None,
                    });
                }
            }
        }
        Some("result") => {
            let result = value.get("result").unwrap_or(value);
            match result.get("status").and_then(Value::as_str) {
                Some("CANCELED" | "INTERRUPTED") => response.cancelled = true,
                Some("ERROR" | "INVALID" | "WAITING" | "RUNNING") => {
                    response.terminal_error = Some(
                        result
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Antigravity did not complete the turn")
                            .to_string(),
                    );
                }
                _ => {}
            }
            if let Some(id) = result.get("conversation_id").and_then(Value::as_str) {
                response.session_id = id.to_string();
            }
            if response.content.is_empty() {
                if let Some(text) = result.get("response").and_then(Value::as_str) {
                    response.content = text.to_string();
                    response.content_blocks.push(ContentBlock::Text {
                        text: text.to_string(),
                    });
                }
            }
            merge_usage(&mut response.usage, usage(result));
            if response.terminal_error.is_none() {
                for tool in response
                    .tool_calls
                    .iter_mut()
                    .filter(|tool| tool.name == "SpawnAgent")
                {
                    if let Some(states) = tool
                        .input
                        .get_mut("agents_states")
                        .and_then(Value::as_object_mut)
                    {
                        for state in states.values_mut().filter_map(Value::as_object_mut) {
                            state.insert(
                                "status".to_string(),
                                Value::String("completed".to_string()),
                            );
                        }
                    }
                }
            }
            return true;
        }
        _ => {}
    }
    false
}

fn emit_new(
    app: &AppHandle,
    session: &str,
    worktree: &str,
    before: usize,
    response: &AntigravityResponse,
) {
    for block in response.content_blocks.iter().skip(before) {
        match block {
            ContentBlock::Text { text } => emit(
                app,
                "chat:chunk",
                serde_json::json!({"session_id":session,"worktree_id":worktree,"content":text}),
            ),
            ContentBlock::Thinking { thinking } => emit(
                app,
                "chat:thinking",
                serde_json::json!({"session_id":session,"worktree_id":worktree,"content":thinking}),
            ),
            ContentBlock::ToolUse { tool_call_id } => {
                if let Some(tool) = response
                    .tool_calls
                    .iter()
                    .find(|tool| &tool.id == tool_call_id)
                {
                    emit(
                        app,
                        "chat:tool_use",
                        serde_json::json!({"session_id":session,"worktree_id":worktree,"id":tool.id,"name":tool.name,"input":tool.input}),
                    );
                    if let Some(output) = &tool.output {
                        emit(
                            app,
                            "chat:tool_result",
                            serde_json::json!({"session_id":session,"worktree_id":worktree,"tool_call_id":tool.id,"output":output}),
                        );
                    }
                }
            }
            _ => {}
        }
    }
}

fn inject_plan(response: &mut AntigravityResponse) -> Option<ToolCall> {
    if response.content.trim().is_empty() {
        return None;
    }
    let tool = ToolCall {
        id: format!("antigravity-plan-{}", uuid::Uuid::new_v4()),
        name: "ExitPlanMode".to_string(),
        input: serde_json::json!({"plan": response.content.trim(), "source":"antigravity"}),
        output: None,
        parent_tool_use_id: None,
    };
    response.content_blocks.push(ContentBlock::ToolUse {
        tool_call_id: tool.id.clone(),
    });
    response.tool_calls.push(tool.clone());
    Some(tool)
}

pub(crate) fn finish_antigravity_response(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    execution_mode: Option<&str>,
    mut response: AntigravityResponse,
) -> AntigravityResponse {
    if !response.cancelled {
        let waiting = execution_mode == Some("plan");
        if waiting {
            if let Some(tool) = inject_plan(&mut response) {
                emit(
                    app,
                    "chat:tool_use",
                    serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"id":tool.id,"name":tool.name,"input":tool.input}),
                );
                emit(
                    app,
                    "chat:tool_block",
                    serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"tool_call_id":tool.id}),
                );
            }
        }
        emit(
            app,
            "chat:done",
            serde_json::json!({"session_id":session_id,"worktree_id":worktree_id,"waiting_for_plan":waiting}),
        );
    }
    response
}

pub(crate) fn parse_antigravity_run_to_message(
    lines: &[String],
    run: &RunEntry,
) -> Result<ChatMessage, String> {
    let mut response = AntigravityResponse {
        content: String::new(),
        session_id: String::new(),
        tool_calls: vec![],
        content_blocks: vec![],
        cancelled: false,
        usage: None,
        terminal_error: None,
        diagnostics: vec![],
    };
    for line in lines {
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            merge_event(&mut response, &value);
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
        backend: None,
        execution_mode: run.execution_mode.clone(),
        thinking_level: run.thinking_level.clone(),
        effort_level: run.effort_level.clone(),
        recovered: run.recovered,
        usage: response.usage.or_else(|| run.usage.clone()),
    })
}

pub fn execute_antigravity(
    mut options: AntigravityExecutionOptions<'_>,
) -> Result<AntigravityResponse, String> {
    let binary = crate::antigravity_cli::resolve_cli_binary(options.app);
    if !crate::antigravity_cli::binary_exists(&binary) {
        return Err("Antigravity CLI not installed".to_string());
    }
    let prompt = match options.system_prompt {
        Some(system) => format!("{system}\n\n{}", options.message),
        None => options.message.to_string(),
    };
    let mut args = vec![
        "-p".to_string(),
        prompt.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
    ];
    args.extend(
        mode_args(options.execution_mode)
            .iter()
            .map(|value| value.to_string()),
    );
    if let Some(id) = options
        .existing_antigravity_session_id
        .filter(|id| !id.is_empty())
    {
        args.extend(["--conversation".to_string(), id.to_string()]);
    }
    if let Some(model) = antigravity_model(options.model) {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    if let Some(effort) = options
        .effort_level
        .filter(|value| matches!(*value, "low" | "medium" | "high"))
    {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }

    #[cfg(unix)]
    {
        let pid = super::detached::spawn_detached_process(
            &binary,
            &args,
            options.output_file,
            options.working_dir,
        )?;
        if let Some(callback) = options.pid_callback.take() {
            callback(pid);
        }
        if !super::registry::register_detached_process(options.jean_session_id.to_string(), pid) {
            let _ = crate::platform::kill_process_tree(pid);
            return Err("Antigravity run cancelled before it started".to_string());
        }
        let response = tail_antigravity_output(
            options.app,
            options.jean_session_id,
            options.worktree_id,
            options.output_file,
            pid,
        );
        super::registry::unregister_process(options.jean_session_id);
        response.map(|response| {
            finish_antigravity_response(
                options.app,
                options.jean_session_id,
                options.worktree_id,
                options.execution_mode,
                response,
            )
        })
    }

    #[cfg(not(unix))]
    {
        let mut command =
            crate::platform::cli_command(&binary.to_string_lossy(), Some(options.working_dir));
        command.args(&args);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to start Antigravity CLI: {error}"))?;
        let pid = child.id();
        if let Some(callback) = options.pid_callback.take() {
            callback(pid);
        }
        if !super::registry::register_process(options.jean_session_id.to_string(), pid) {
            let _ = child.kill();
            return Err("Antigravity run cancelled before it started".to_string());
        }
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to read Antigravity output")?;
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(options.output_file)
            .map_err(|error| format!("Failed to open Antigravity run log: {error}"))?;
        let mut response = AntigravityResponse {
            content: String::new(),
            session_id: String::new(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: false,
            usage: None,
            terminal_error: None,
            diagnostics: vec![],
        };
        for line in BufReader::new(stdout).lines() {
            let line =
                line.map_err(|error| format!("Failed to read Antigravity output: {error}"))?;
            writeln!(log, "{line}")
                .map_err(|error| format!("Failed to save Antigravity output: {error}"))?;
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                let before = response.content_blocks.len();
                merge_event(&mut response, &value);
                emit_new(
                    options.app,
                    options.jean_session_id,
                    options.worktree_id,
                    before,
                    &response,
                );
            } else if !line.trim().is_empty() {
                response.diagnostics.push(line.trim().to_string());
            }
        }
        let status = child
            .wait()
            .map_err(|error| format!("Failed to wait for Antigravity CLI: {error}"))?;
        super::registry::unregister_process(options.jean_session_id);
        if !status.success() {
            return Err("Antigravity CLI exited before it completed. Open Settings → Antigravity CLI to check authentication and permissions.".to_string());
        }
        if let Some(error) = response.terminal_error.clone() {
            return Err(error);
        }
        if let Some(denial) = permission_diagnostic(&response) {
            return Err(format!("Antigravity permission denied: {denial}"));
        }
        response.content = response.content.trim().to_string();
        Ok(finish_antigravity_response(
            options.app,
            options.jean_session_id,
            options.worktree_id,
            options.execution_mode,
            response,
        ))
    }
}

pub fn tail_antigravity_output(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &Path,
    pid: u32,
) -> Result<AntigravityResponse, String> {
    use super::tail::{next_poll_interval, NdjsonTailer};
    let mut tailer = NdjsonTailer::new_from_start(output_file)?;
    let mut response = AntigravityResponse {
        content: String::new(),
        session_id: String::new(),
        tool_calls: vec![],
        content_blocks: vec![],
        cancelled: false,
        usage: None,
        terminal_error: None,
        diagnostics: vec![],
    };
    let start = Instant::now();
    loop {
        let lines = tailer.poll()?;
        let had_data = !lines.is_empty();
        for line in lines {
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                let before = response.content_blocks.len();
                if merge_event(&mut response, &value) {
                    response.content = response.content.trim().to_string();
                    if let Some(error) = response.terminal_error.clone() {
                        return Err(error);
                    }
                    if let Some(denial) = permission_diagnostic(&response) {
                        return Err(format!("Antigravity permission denied: {denial}"));
                    }
                    return Ok(response);
                }
                emit_new(app, session_id, worktree_id, before, &response);
            } else if !line.trim().is_empty() {
                response.diagnostics.push(line.trim().to_string());
            }
        }
        if !crate::platform::is_process_alive(pid) && start.elapsed() > Duration::from_secs(2) {
            response.content = response.content.trim().to_string();
            return Ok(response);
        }
        std::thread::sleep(next_poll_interval(had_data, start.elapsed()));
    }
}

pub fn execute_one_shot_antigravity(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    json_schema: Option<&str>,
    working_dir: Option<&Path>,
) -> Result<String, String> {
    let binary = crate::antigravity_cli::resolve_cli_binary(app);
    if !crate::antigravity_cli::binary_exists(&binary) {
        return Err("Antigravity CLI not installed".to_string());
    }
    let dir = working_dir.unwrap_or_else(|| Path::new("."));
    let mut command = crate::platform::cli_command(&binary.to_string_lossy(), Some(dir));
    command.args(["-p", prompt, "--output-format", "json", "--mode", "plan"]);
    if let Some(schema) = json_schema {
        command.args(["--json-schema", schema]);
    }
    if let Some(model) = antigravity_model(Some(model)) {
        command.args(["--model", model]);
    }
    let output = command
        .output()
        .map_err(|error| format!("Failed to run Antigravity one-shot request: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Antigravity one-shot request failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let envelope: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to parse Antigravity JSON output: {error}"))?;
    if let Some(value) = envelope.get("structured_output") {
        return serde_json::to_string(value).map_err(|error| error.to_string());
    }
    envelope
        .get("response")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            "Antigravity JSON output did not contain structured_output or response".to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_modes() {
        assert!(mode_args(Some("plan")).contains(&"--sandbox"));
        assert!(mode_args(Some("build")).contains(&"--sandbox"));
        assert!(mode_args(Some("build")).contains(&"--dangerously-skip-permissions"));
        assert!(mode_args(Some("yolo")).contains(&"--dangerously-skip-permissions"));
    }
    #[test]
    fn parses_official_stream() {
        let mut r = AntigravityResponse {
            content: String::new(),
            session_id: String::new(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: false,
            usage: None,
            terminal_error: None,
            diagnostics: vec![],
        };
        assert!(!merge_event(
            &mut r,
            &serde_json::json!({"event":"init","conversation_id":"c1"})
        ));
        assert!(!merge_event(
            &mut r,
            &serde_json::json!({"event":"step_update","step_update":{"conversation_id":"c1","step_type":"agent_response","text_delta":"hello","usage":{"input_tokens":3,"output_tokens":2}}})
        ));
        assert!(merge_event(
            &mut r,
            &serde_json::json!({"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"hello"}})
        ));
        assert_eq!(r.session_id, "c1");
        assert_eq!(r.content, "hello");
        assert_eq!(r.usage.unwrap().output_tokens, 2);
    }
    #[test]
    fn strips_backend_prefix() {
        assert_eq!(
            antigravity_model(Some("antigravity/gemini-3.1-pro-high")),
            Some("gemini-3.1-pro-high")
        );
        assert_eq!(antigravity_model(Some("antigravity/auto")), None);
    }

    #[test]
    fn parses_documented_nested_tool_info() {
        let mut response = empty_response();
        merge_event(
            &mut response,
            &serde_json::json!({
                "event":"step_update",
                "step_update":{
                    "step_index":4,
                    "step_type":"tool",
                    "tool_name":"run_command",
                    "tool_info":{
                        "name":"run_command",
                        "parameters":{"CommandLine":"npm test"},
                        "output":"passed"
                    }
                }
            }),
        );
        assert_eq!(response.tool_calls[0].name, "run_command");
        assert_eq!(response.tool_calls[0].input["CommandLine"], "npm test");
        assert_eq!(response.tool_calls[0].output.as_deref(), Some("passed"));
    }

    #[test]
    fn parses_documented_subagent_info_as_agent_activity() {
        let mut response = empty_response();
        merge_event(
            &mut response,
            &serde_json::json!({
                "event":"step_update",
                "step_update":{
                    "step_index":5,
                    "step_type":"tool",
                    "tool_name":"spawn_subagents",
                    "subagent_info":{"subagents":[{
                        "type_name":"reviewer",
                        "role":"Review the change",
                        "conversation_id":"agent-1",
                        "log_uri":"file:///tmp/agent-1.log",
                        "workspace_uris":["file:///repo"]
                    }]}
                }
            }),
        );
        assert_eq!(response.tool_calls[0].name, "SpawnAgent");
        assert_eq!(
            response.tool_calls[0].input["receiver_thread_ids"][0],
            "agent-1"
        );
    }

    #[test]
    fn preserves_terminal_error_and_cancellation_states() {
        let mut failed = empty_response();
        assert!(merge_event(
            &mut failed,
            &serde_json::json!({"event":"result","result":{"status":"WAITING","error":"question needs input"}})
        ));
        assert_eq!(
            failed.terminal_error.as_deref(),
            Some("question needs input")
        );

        let mut cancelled = empty_response();
        assert!(merge_event(
            &mut cancelled,
            &serde_json::json!({"event":"result","result":{"status":"INTERRUPTED"}})
        ));
        assert!(cancelled.cancelled);
    }

    #[test]
    fn detects_headless_permission_denials() {
        let mut response = empty_response();
        response
            .diagnostics
            .push("Tool command(git) was soft-denied by permission policy".to_string());
        assert!(permission_diagnostic(&response).is_some());
    }

    fn empty_response() -> AntigravityResponse {
        AntigravityResponse {
            content: String::new(),
            session_id: String::new(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: false,
            usage: None,
            terminal_error: None,
            diagnostics: vec![],
        }
    }
}
