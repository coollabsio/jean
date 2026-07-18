//! Command Code CLI execution engine.
//!
//! Uses documented headless mode (`cmd -p`) which is final-output-only. With
//! `--verbose` the native session id is written to stderr (`session: <uuid>`);
//! Jean captures it and resumes the exact conversation on the next turn via
//! `--resume <id>`. Jean still injects transcript/context into the prompt and
//! emits one synthetic final chunk for frontend compatibility.
//! Docs: https://commandcode.ai/docs/core-concepts/headless

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::AppHandle;

const DEFAULT_MAX_TURNS: &str = "30";
const JEAN_PLAN_OPEN: &str = "<jean-plan>";
const JEAN_PLAN_CLOSE: &str = "</jean-plan>";
const COMMANDCODE_PLAN_CONTRACT: &str = r#"<commandcode_plan_contract>
Jean runs Command Code headlessly, so native interactive plan-exit callbacks are unavailable.
- For normal answers, questions, greetings, and analysis that is not ready for implementation approval: respond normally.
- When you have a concrete implementation plan that should pause for Jean's Approve/YOLO controls: wrap only that plan in <jean-plan>...</jean-plan>.
- Do not call exit_plan_mode in this headless integration.
</commandcode_plan_contract>"#;

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

pub struct CommandCodeResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub waiting_for_plan: bool,
    pub usage: Option<UsageData>,
}

struct ParsedCommandCodeOutput {
    content: String,
    waiting_for_plan: bool,
}

struct ParsedNativeCommandCodeTurn {
    tool_calls: Vec<ToolCall>,
    content_blocks: Vec<ContentBlock>,
}

/// Extract the native session id from `--verbose` stderr (line `session: <id>`).
fn parse_commandcode_session_id(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("session:")?;
        let id = rest.trim();
        (!id.is_empty()).then(|| id.to_string())
    })
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek().is_some_and(|c| *c == '[') {
                let _ = chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn commandcode_error_for_status(code: Option<i32>, stderr: &str) -> String {
    let base = match code {
        Some(3) => "Command Code is not authenticated. Run `cmd login`.",
        Some(4) => "Command Code denied a requested permission.",
        Some(5) => "Command Code rate limit exceeded.",
        Some(6) => "Command Code network failure.",
        Some(7) => "Command Code API server error.",
        Some(130) => "Command Code run interrupted.",
        _ => "Command Code run failed.",
    };
    let stderr = strip_ansi(stderr).trim().to_string();
    if stderr.is_empty() {
        base.to_string()
    } else {
        format!("{base}\n{stderr}")
    }
}

fn parse_commandcode_plan_output(content: &str) -> ParsedCommandCodeOutput {
    let trimmed = content.trim();
    let Some(start) = trimmed.find(JEAN_PLAN_OPEN) else {
        return ParsedCommandCodeOutput {
            content: trimmed.to_string(),
            waiting_for_plan: false,
        };
    };
    let plan_start = start + JEAN_PLAN_OPEN.len();
    let Some(relative_end) = trimmed[plan_start..].find(JEAN_PLAN_CLOSE) else {
        return ParsedCommandCodeOutput {
            content: trimmed.to_string(),
            waiting_for_plan: false,
        };
    };
    let end = plan_start + relative_end;
    ParsedCommandCodeOutput {
        content: trimmed[plan_start..end].trim().to_string(),
        waiting_for_plan: true,
    }
}

fn build_prompt(system_context: Option<&str>, message: &str, mode: &str) -> String {
    let mut prompt = String::new();
    if let Some(ctx) = system_context.map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str("<jean_context>\n");
        prompt.push_str(ctx);
        prompt.push_str("\n</jean_context>\n\n");
    }
    if mode == "plan" {
        prompt.push_str(COMMANDCODE_PLAN_CONTRACT);
        prompt.push_str("\n\n");
    }
    prompt.push_str(message);
    prompt
}

fn normalize_model_for_cli(model: Option<&str>) -> Option<String> {
    let model = model.map(str::trim).filter(|value| !value.is_empty())?;
    if model == "commandcode/default" || model == "default" {
        return None;
    }
    Some(
        model
            .strip_prefix("commandcode/")
            .unwrap_or(model)
            .to_string(),
    )
}

fn preview_for_log(text: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let mut preview: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        preview.push_str("…");
    }
    preview.replace('\n', "\\n")
}

fn commandcode_output_to_string(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(value) = value.get("value").and_then(|value| value.as_str()) {
        return Some(value.to_string());
    }
    if let Some(text) = value.get("text").and_then(|value| value.as_str()) {
        return Some(text.to_string());
    }
    if value.is_null() {
        None
    } else {
        Some(value.to_string())
    }
}

fn normalize_commandcode_tool_call(
    name: &str,
    input: serde_json::Value,
) -> (String, serde_json::Value) {
    let Some(input_object) = input.as_object() else {
        return (name.to_string(), input);
    };

    match name {
        "read_file" => {
            let file_path = input_object
                .get("absolutePath")
                .or_else(|| input_object.get("filePath"))
                .or_else(|| input_object.get("path"))
                .cloned();
            let mut normalized = serde_json::Map::new();
            if let Some(file_path) = file_path {
                normalized.insert("file_path".to_string(), file_path);
            }
            for key in ["limit", "offset"] {
                if let Some(value) = input_object.get(key) {
                    normalized.insert(key.to_string(), value.clone());
                }
            }
            ("Read".to_string(), serde_json::Value::Object(normalized))
        }
        "write_file" => {
            let file_path = input_object
                .get("filePath")
                .or_else(|| input_object.get("absolutePath"))
                .or_else(|| input_object.get("path"))
                .cloned();
            let mut normalized = serde_json::Map::new();
            if let Some(file_path) = file_path {
                normalized.insert("file_path".to_string(), file_path);
            }
            if let Some(content) = input_object.get("content") {
                normalized.insert("content".to_string(), content.clone());
            }
            ("Write".to_string(), serde_json::Value::Object(normalized))
        }
        "read_multiple_files" => {
            let path = input_object
                .get("targetDirectory")
                .or_else(|| input_object.get("path"))
                .cloned();
            let mut normalized = serde_json::Map::new();
            if let Some(path) = path {
                normalized.insert("path".to_string(), path);
            }
            if let Some(include) = input_object.get("include") {
                normalized.insert("include".to_string(), include.clone());
            }
            (
                "ReadMultipleFiles".to_string(),
                serde_json::Value::Object(normalized),
            )
        }
        "shell_command" => ("Bash".to_string(), input),
        "read_directory" | "list" => ("List".to_string(), input),
        "glob" => ("Glob".to_string(), input),
        "grep" => ("Grep".to_string(), input),
        _ => (name.to_string(), input),
    }
}

fn parse_native_commandcode_turn(jsonl: &str) -> Option<ParsedNativeCommandCodeTurn> {
    let entries: Vec<serde_json::Value> = jsonl
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let last_user_index = entries
        .iter()
        .rposition(|entry| entry.get("role").and_then(|role| role.as_str()) == Some("user"))?;

    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();

    for entry in entries.iter().skip(last_user_index + 1) {
        let role = entry.get("role").and_then(|role| role.as_str());
        let Some(content) = entry.get("content").and_then(|content| content.as_array()) else {
            continue;
        };

        for block in content {
            match (
                role,
                block.get("type").and_then(|block_type| block_type.as_str()),
            ) {
                (Some("assistant"), Some("text")) => {
                    if let Some(text) = block.get("text").and_then(|text| text.as_str()) {
                        content_blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
                    }
                }
                (Some("assistant"), Some("tool-call")) => {
                    let Some(id) = block
                        .get("toolCallId")
                        .or_else(|| block.get("tool_call_id"))
                        .or_else(|| block.get("id"))
                        .and_then(|id| id.as_str())
                    else {
                        continue;
                    };
                    let name = block
                        .get("toolName")
                        .or_else(|| block.get("name"))
                        .and_then(|name| name.as_str())
                        .unwrap_or("tool");
                    let (name, input) = normalize_commandcode_tool_call(
                        name,
                        block
                            .get("input")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    );
                    tool_calls.push(ToolCall {
                        id: id.to_string(),
                        name,
                        input,
                        output: None,
                        parent_tool_use_id: None,
                    });
                    content_blocks.push(ContentBlock::ToolUse {
                        tool_call_id: id.to_string(),
                    });
                }
                (Some("tool"), Some("tool-result")) => {
                    let Some(id) = block
                        .get("toolCallId")
                        .or_else(|| block.get("tool_call_id"))
                        .or_else(|| block.get("toolUseId"))
                        .or_else(|| block.get("tool_use_id"))
                        .and_then(|id| id.as_str())
                    else {
                        continue;
                    };
                    let output = block
                        .get("output")
                        .or_else(|| block.get("content"))
                        .and_then(commandcode_output_to_string);
                    if let Some(tool_call) =
                        tool_calls.iter_mut().find(|tool_call| tool_call.id == id)
                    {
                        tool_call.output = output;
                    }
                }
                _ => {}
            }
        }
    }

    (!tool_calls.is_empty() || !content_blocks.is_empty()).then_some(ParsedNativeCommandCodeTurn {
        tool_calls,
        content_blocks,
    })
}

fn find_native_commandcode_session_file(session_id: &str) -> Option<PathBuf> {
    let projects_dir = dirs::home_dir()?.join(".commandcode").join("projects");
    for entry in std::fs::read_dir(projects_dir).ok()? {
        let path = entry.ok()?.path().join(format!("{session_id}.jsonl"));
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn read_native_commandcode_turn(session_id: &str) -> Option<ParsedNativeCommandCodeTurn> {
    let path = find_native_commandcode_session_file(session_id)?;
    let jsonl = std::fs::read_to_string(&path).ok()?;
    let parsed = parse_native_commandcode_turn(&jsonl);
    if parsed.is_none() {
        log::debug!(
            "Command Code native session file had no parseable turn session={} path={}",
            session_id,
            path.display()
        );
    }
    parsed
}

pub fn execute_commandcode_headless(
    app: &AppHandle,
    jean_session_id: &str,
    worktree_id: &str,
    run_id: &str,
    working_dir: &Path,
    execution_mode: Option<&str>,
    model: Option<&str>,
    message: &str,
    system_context: Option<&str>,
    resume_session_id: Option<&str>,
    pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
) -> Result<(u32, CommandCodeResponse), String> {
    let binary_path = crate::commandcode_cli::resolve_cli_binary(app);
    if !binary_path.exists() {
        log::warn!(
            "Command Code CLI not found for session={} worktree={} resolved_path={}",
            jean_session_id,
            worktree_id,
            binary_path.display()
        );
        return Err("Command Code CLI not found. Install it with `npm install -g command-code` and run `cmd login`.".to_string());
    }

    let mode = execution_mode.unwrap_or("plan");
    log::info!(
        "Starting Command Code headless run session={} worktree={} mode={} binary={} cwd={} streaming=false",
        jean_session_id,
        worktree_id,
        mode,
        binary_path.display(),
        working_dir.display()
    );
    log::debug!(
        "Command Code prompt inputs session={} message_bytes={} system_context_bytes={} selected_model={:?}",
        jean_session_id,
        message.len(),
        system_context.map(str::len).unwrap_or(0),
        model
    );

    let mut command =
        crate::platform::cli_command(&binary_path.to_string_lossy(), Some(working_dir));
    command
        .arg("-p")
        .arg("--verbose") // prints `session: <id>` to stderr; stdout stays clean
        .arg("--trust")
        .arg("--skip-onboarding")
        .arg("--max-turns")
        .arg(DEFAULT_MAX_TURNS);
    // Resume the exact prior Command Code conversation by its native session id.
    if let Some(resume_id) = resume_session_id {
        command.arg("--resume").arg(resume_id);
        log::info!(
            "Command Code run session={} resuming native session {}",
            jean_session_id,
            resume_id
        );
    }
    let cli_model = normalize_model_for_cli(model);
    if let Some(cli_model) = &cli_model {
        command.arg("--model").arg(cli_model);
        log::info!(
            "Command Code run session={} using --model {} max_turns={}",
            jean_session_id,
            cli_model,
            DEFAULT_MAX_TURNS
        );
    }
    match mode {
        "yolo" => {
            command.arg("--yolo");
        }
        "build" => {
            command.arg("--auto-accept");
        }
        _ => {
            command.arg("--permission-mode").arg("plan");
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Command Code CLI: {e}"))?;
    let pid = child.id();
    log::info!(
        "Spawned Command Code process session={} worktree={} pid={} (output is final-only; waiting for process exit)",
        jean_session_id,
        worktree_id,
        pid
    );
    if let Some(cb) = pid_callback {
        cb(pid);
    }

    if let Some(mut stdin) = child.stdin.take() {
        let prompt = build_prompt(system_context, message, mode);
        log::debug!(
            "Writing Command Code stdin session={} prompt_bytes={} prompt_preview=\"{}\"",
            jean_session_id,
            prompt.len(),
            preview_for_log(&prompt)
        );
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("Failed to write Command Code prompt: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Command Code CLI: {e}"))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));

    // Prefer the native session id from `--verbose` stderr; fall back to the id we
    // resumed with so a turn that omits the verbose line still persists a resume id.
    let native_session_id = parse_commandcode_session_id(&stderr)
        .or_else(|| resume_session_id.map(str::to_string))
        .unwrap_or_default();
    log::info!(
        "Command Code native session id session={} resolved={:?}",
        jean_session_id,
        native_session_id
    );

    log::info!(
        "Command Code process exited session={} worktree={} pid={} success={} code={:?} stdout_bytes={} stderr_bytes={}",
        jean_session_id,
        worktree_id,
        pid,
        output.status.success(),
        output.status.code(),
        stdout.len(),
        stderr.len()
    );
    if !stdout.trim().is_empty() {
        log::debug!(
            "Command Code stdout session={} preview=\"{}\"",
            jean_session_id,
            preview_for_log(stdout.trim())
        );
    }
    if !stderr.trim().is_empty() {
        log::debug!(
            "Command Code stderr session={} preview=\"{}\"",
            jean_session_id,
            preview_for_log(stderr.trim())
        );
    }

    if !output.status.success() && output.status.code() == Some(130) {
        let waiting_for_plan = false;
        match app.emit_all(
            "chat:done",
            &DoneEvent {
                session_id: jean_session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                waiting_for_plan,
            },
        ) {
            Ok(_) => log::debug!(
                "Emitted Command Code cancellation chat:done session={} waiting_for_plan={}",
                jean_session_id,
                waiting_for_plan
            ),
            Err(error) => log::warn!(
                "Failed to emit Command Code cancellation chat:done session={}: {}",
                jean_session_id,
                error
            ),
        }
        return Ok((
            pid,
            CommandCodeResponse {
                content: String::new(),
                session_id: native_session_id.clone(),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: true,
                waiting_for_plan,
                usage: None,
            },
        ));
    }

    if !output.status.success() {
        return Err(commandcode_error_for_status(output.status.code(), &stderr));
    }

    let parsed_output = parse_commandcode_plan_output(stdout.trim());
    let content = parsed_output.content;
    let waiting_for_plan = mode == "plan" && parsed_output.waiting_for_plan;
    let native_turn = (!native_session_id.is_empty())
        .then(|| read_native_commandcode_turn(&native_session_id))
        .flatten();
    if !content.is_empty() {
        match app.emit_all(
            "chat:chunk",
            &ChunkEvent {
                session_id: jean_session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                content: content.clone(),
                run_id: Some(run_id.to_string()),
            },
        ) {
            Ok(_) => log::debug!(
                "Emitted Command Code synthetic chat:chunk session={} bytes={}",
                jean_session_id,
                content.len()
            ),
            Err(error) => log::warn!(
                "Failed to emit Command Code chat:chunk session={}: {}",
                jean_session_id,
                error
            ),
        }
    } else {
        log::warn!(
            "Command Code completed with empty stdout session={} worktree={}",
            jean_session_id,
            worktree_id
        );
    }
    match app.emit_all(
        "chat:done",
        &DoneEvent {
            session_id: jean_session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            waiting_for_plan,
        },
    ) {
        Ok(_) => log::debug!(
            "Emitted Command Code chat:done session={} waiting_for_plan={}",
            jean_session_id,
            waiting_for_plan
        ),
        Err(error) => log::warn!(
            "Failed to emit Command Code chat:done session={}: {}",
            jean_session_id,
            error
        ),
    }

    let (tool_calls, content_blocks) = if let Some(native_turn) = native_turn {
        log::debug!(
            "Parsed Command Code native turn session={} tool_calls={} content_blocks={}",
            jean_session_id,
            native_turn.tool_calls.len(),
            native_turn.content_blocks.len()
        );
        (native_turn.tool_calls, native_turn.content_blocks)
    } else if content.is_empty() {
        (vec![], vec![])
    } else {
        (
            vec![],
            vec![ContentBlock::Text {
                text: content.clone(),
            }],
        )
    };
    Ok((
        pid,
        CommandCodeResponse {
            content,
            session_id: native_session_id,
            tool_calls,
            content_blocks,
            cancelled: false,
            waiting_for_plan,
            usage: None,
        },
    ))
}

pub fn execute_one_shot_commandcode(
    app: &AppHandle,
    prompt: &str,
    working_dir: Option<&str>,
    execution_mode: Option<&str>,
    model: Option<&str>,
) -> Result<String, String> {
    let binary_path = crate::commandcode_cli::resolve_cli_binary(app);
    if !binary_path.exists() {
        log::warn!(
            "Command Code CLI not found for one-shot resolved_path={}",
            binary_path.display()
        );
        return Err(
            "Command Code CLI not found. Install it with `npm install -g command-code`."
                .to_string(),
        );
    }
    log::info!(
        "Starting Command Code one-shot mode={} binary={} cwd={:?} streaming=false prompt_bytes={} selected_model={:?}",
        execution_mode.unwrap_or("plan"),
        binary_path.display(),
        working_dir,
        prompt.len(),
        model
    );
    let cwd = working_dir.map(Path::new);
    let mut command = crate::platform::cli_command(&binary_path.to_string_lossy(), cwd);
    command
        .arg("-p")
        .arg("--trust")
        .arg("--skip-onboarding")
        .arg("--max-turns")
        .arg(DEFAULT_MAX_TURNS);
    let cli_model = normalize_model_for_cli(model);
    if let Some(cli_model) = &cli_model {
        command.arg("--model").arg(cli_model);
        log::info!("Command Code one-shot using --model {}", cli_model);
    }
    match execution_mode.unwrap_or("plan") {
        "yolo" => {
            command.arg("--yolo");
        }
        "build" => {
            command.arg("--auto-accept");
        }
        _ => {
            command.arg("--permission-mode").arg("plan");
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Command Code CLI: {e}"))?;
    let pid = child.id();
    log::info!("Spawned Command Code one-shot pid={}", pid);
    if let Some(mut stdin) = child.stdin.take() {
        log::debug!(
            "Writing Command Code one-shot stdin pid={} prompt_preview=\"{}\"",
            pid,
            preview_for_log(prompt)
        );
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("Failed to write Command Code prompt: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Command Code CLI: {e}"))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    log::info!(
        "Command Code one-shot exited pid={} success={} code={:?} stdout_bytes={} stderr_bytes={}",
        pid,
        output.status.success(),
        output.status.code(),
        stdout.len(),
        stderr.len()
    );
    if !stdout.trim().is_empty() {
        log::debug!(
            "Command Code one-shot stdout pid={} preview=\"{}\"",
            pid,
            preview_for_log(stdout.trim())
        );
    }
    if !stderr.trim().is_empty() {
        log::debug!(
            "Command Code one-shot stderr pid={} preview=\"{}\"",
            pid,
            preview_for_log(stderr.trim())
        );
    }
    if !output.status.success() {
        return Err(commandcode_error_for_status(output.status.code(), &stderr));
    }
    Ok(stdout.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commandcode_plan_detection_does_not_wait_for_plain_chat() {
        let output =
            parse_commandcode_plan_output("Doing well, thanks. What are we working on today?");

        assert_eq!(
            output.content,
            "Doing well, thanks. What are we working on today?"
        );
        assert!(!output.waiting_for_plan);
    }

    #[test]
    fn commandcode_plan_detection_waits_for_marked_plan() {
        let output = parse_commandcode_plan_output(
            "I found the issue.\n\n<jean-plan>\n1. Add regression test\n2. Fix parser\n</jean-plan>",
        );

        assert_eq!(output.content, "1. Add regression test\n2. Fix parser");
        assert!(output.waiting_for_plan);
    }

    #[test]
    fn commandcode_session_id_parsed_from_verbose_stderr() {
        let stderr = "some startup noise\nsession: f2d6faed-4c9e-4f59-bb8d-b45a9a79eb3c\nmore logs";
        assert_eq!(
            parse_commandcode_session_id(stderr).as_deref(),
            Some("f2d6faed-4c9e-4f59-bb8d-b45a9a79eb3c")
        );
    }

    #[test]
    fn commandcode_session_id_absent_returns_none() {
        assert!(parse_commandcode_session_id("no id here\njust logs").is_none());
    }

    #[test]
    fn commandcode_plan_prompt_guidance_is_only_added_in_plan_mode() {
        let plan_prompt = build_prompt(Some("context"), "message", "plan");
        assert!(plan_prompt.contains("<commandcode_plan_contract>"));
        assert!(plan_prompt.contains("<jean-plan>"));

        let build_prompt = build_prompt(Some("context"), "message", "build");
        assert!(!build_prompt.contains("<commandcode_plan_contract>"));
    }

    #[test]
    fn native_commandcode_turn_parses_tool_call_and_result_blocks() {
        let jsonl = r#"{"role":"user","content":"you can run it"}
{"role":"assistant","content":[{"type":"text","text":"I'll run the date command."},{"type":"tool-call","toolCallId":"call_1","toolName":"shell_command","input":{"command":"date"}},{"type":"tool-call","toolCallId":"call_2","toolName":"read_file","input":{"absolutePath":"/tmp/package.json","limit":20}},{"type":"tool-call","toolCallId":"call_3","toolName":"write_file","input":{"filePath":"/tmp/demo.md","content":"hello"}},{"type":"tool-call","toolCallId":"call_4","toolName":"read_multiple_files","input":{"targetDirectory":"/tmp","include":["*.md"]}}]}
{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_1","toolName":"shell_command","output":{"type":"text","value":"Fri Jun 26 23:56:08 CEST 2026"}},{"type":"tool-result","toolCallId":"call_2","toolName":"read_file","output":{"type":"text","value":"package contents"}},{"type":"tool-result","toolCallId":"call_3","toolName":"write_file","output":{"type":"text","value":"wrote file"}},{"type":"tool-result","toolCallId":"call_4","toolName":"read_multiple_files","output":{"type":"text","value":"read files"}}]}
{"role":"assistant","content":[{"type":"text","text":"It's Fri Jun 26 23:56:08 CEST 2026."}]}"#;

        let parsed = parse_native_commandcode_turn(jsonl).expect("native turn parsed");

        assert_eq!(parsed.tool_calls.len(), 4);
        assert_eq!(parsed.tool_calls[0].id, "call_1");
        assert_eq!(parsed.tool_calls[0].name, "Bash");
        assert_eq!(
            parsed.tool_calls[0].input,
            serde_json::json!({"command": "date"})
        );
        assert_eq!(
            parsed.tool_calls[0].output.as_deref(),
            Some("Fri Jun 26 23:56:08 CEST 2026")
        );
        assert_eq!(parsed.tool_calls[1].id, "call_2");
        assert_eq!(parsed.tool_calls[1].name, "Read");
        assert_eq!(
            parsed.tool_calls[1].input,
            serde_json::json!({"file_path": "/tmp/package.json", "limit": 20})
        );
        assert_eq!(parsed.tool_calls[2].name, "Write");
        assert_eq!(
            parsed.tool_calls[2].input,
            serde_json::json!({"file_path": "/tmp/demo.md", "content": "hello"})
        );
        assert_eq!(parsed.tool_calls[3].name, "ReadMultipleFiles");
        assert_eq!(
            parsed.tool_calls[3].input,
            serde_json::json!({"path": "/tmp", "include": ["*.md"]})
        );
        assert!(matches!(
            parsed.content_blocks.as_slice(),
            [
                ContentBlock::Text { .. },
                ContentBlock::ToolUse { tool_call_id },
                ContentBlock::ToolUse { .. },
                ContentBlock::ToolUse { .. },
                ContentBlock::ToolUse { .. },
                ContentBlock::Text { .. },
            ] if tool_call_id == "call_1"
        ));
    }
}
