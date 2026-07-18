//! Cursor Agent execution engine.

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
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
struct ToolUseEvent {
    session_id: String,
    worktree_id: String,
    id: String,
    name: String,
    input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_tool_use_id: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct ToolBlockEvent {
    session_id: String,
    worktree_id: String,
    tool_call_id: String,
}

#[derive(serde::Serialize, Clone)]
struct ToolResultEvent {
    session_id: String,
    worktree_id: String,
    tool_use_id: String,
    output: String,
}

#[derive(serde::Serialize, Clone)]
pub struct ErrorEvent {
    pub session_id: String,
    pub worktree_id: String,
    pub error: String,
}

pub struct CursorResponse {
    pub content: String,
    pub chat_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

#[derive(Debug, Clone)]
struct ParsedToolCall {
    id: String,
    name: String,
    input: Value,
}

const CURSOR_SYNTHETIC_PLAN_TOOL_NAME: &str = "ExitPlanMode";

fn cursor_tool_type_to_name(key: &str) -> Option<&'static str> {
    match key {
        "editToolCall" => Some("Edit"),
        "shellToolCall" => Some("Bash"),
        "readToolCall" => Some("Read"),
        "writeToolCall" => Some("Write"),
        "grepToolCall" | "searchToolCall" => Some("Grep"),
        "globToolCall" | "listToolCall" | "listDirToolCall" => Some("Glob"),
        "createPlanToolCall" => None,
        _ => None,
    }
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

fn raw_cursor_model(model: Option<&str>) -> Option<&str> {
    model.map(|value| value.strip_prefix("cursor/").unwrap_or(value))
}

fn parse_enabled_mcp_names(mcp_config: Option<&str>) -> HashSet<String> {
    let Some(config) = mcp_config else {
        return HashSet::new();
    };

    serde_json::from_str::<Value>(config)
        .ok()
        .and_then(|json| json.get("mcpServers").and_then(Value::as_object).cloned())
        .map(|servers| servers.keys().cloned().collect())
        .unwrap_or_default()
}

fn build_cursor_message(
    message: &str,
    execution_mode: &str,
    system_prompt: Option<&str>,
) -> String {
    let prefix = match system_prompt {
        Some(sp) if !sp.trim().is_empty() => {
            format!(
                "<system_instructions>\n{}\n</system_instructions>\n\n",
                sp.trim()
            )
        }
        _ => String::new(),
    };
    let mode_marker = match execution_mode {
        "build" | "yolo" => "<end_plan_mode/>\n\n",
        _ => "",
    };
    format!("{prefix}{mode_marker}{message}")
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn first_string(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| {
        value_at_path(value, path)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn first_value(value: &Value, paths: &[&[&str]]) -> Option<Value> {
    paths
        .iter()
        .find_map(|path| value_at_path(value, path).cloned())
}

fn extract_chat_id(value: &Value) -> Option<String> {
    first_string(
        value,
        &[
            &["chat_id"],
            &["chatId"],
            &["session_id"],
            &["sessionId"],
            &["chat", "id"],
            &["session", "id"],
            &["result", "chat_id"],
            &["result", "chatId"],
            &["result", "session_id"],
            &["result", "sessionId"],
        ],
    )
}

fn extract_usage(value: &Value) -> Option<UsageData> {
    let usage = value
        .get("usage")
        .or_else(|| value_at_path(value, &["result", "usage"]))?;

    let input_tokens = usage
        .get("input_tokens")
        .or_else(|| usage.get("inputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .or_else(|| usage.get("outputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read_input_tokens = usage
        .get("cache_read_input_tokens")
        .or_else(|| usage.get("cacheReadInputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_creation_input_tokens = usage
        .get("cache_creation_input_tokens")
        .or_else(|| usage.get("cacheCreationInputTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    if input_tokens == 0
        && output_tokens == 0
        && cache_read_input_tokens == 0
        && cache_creation_input_tokens == 0
    {
        return None;
    }

    Some(UsageData {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
    })
}

fn extract_text_delta(value: &Value) -> Option<String> {
    [
        &["delta"][..],
        &["text"][..],
        &["content"][..],
        &["message", "delta"][..],
        &["message", "text"][..],
    ]
    .iter()
    .find_map(|path| {
        value_at_path(value, path)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn extract_text_from_block(block: &Value) -> Option<String> {
    if block.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }

    block
        .get("text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn extract_text_from_blocks(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(extract_text_from_block)
        .collect::<String>()
}

fn extract_tool_call_from_block(block: &Value) -> Option<ParsedToolCall> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return None;
    }

    let id = first_string(
        block,
        &[
            &["id"],
            &["tool_call_id"],
            &["toolCallId"],
            &["tool_use_id"],
        ],
    )?;
    let name = first_string(block, &[&["name"], &["tool_name"], &["toolName"]])?;
    let input = first_value(
        block,
        &[&["input"], &["args"], &["arguments"], &["parameters"]],
    )
    .unwrap_or(Value::Null);

    Some(ParsedToolCall { id, name, input })
}

fn extract_message_blocks(value: &Value) -> Option<&Vec<Value>> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .or_else(|| value.get("content").and_then(Value::as_array))
}

fn extract_tool_call_event(value: &Value) -> Option<ParsedToolCall> {
    if let Some(plan) = first_string(
        value,
        &[
            &["tool_call", "createPlanToolCall", "args", "plan"],
            &["query", "createPlanRequestQuery", "args", "plan"],
        ],
    ) {
        let id = first_string(
            value,
            &[
                &["call_id"],
                &["tool_call", "createPlanToolCall", "args", "toolCallId"],
                &["query", "createPlanRequestQuery", "args", "toolCallId"],
            ],
        )
        .unwrap_or_else(|| "cursor-create-plan".to_string());

        return Some(ParsedToolCall {
            id,
            name: CURSOR_SYNTHETIC_PLAN_TOOL_NAME.to_string(),
            input: serde_json::json!({
                "source": "cursor",
                "plan": plan,
            }),
        });
    }

    let id = first_string(
        value,
        &[
            &["id"],
            &["tool_call_id"],
            &["toolCallId"],
            &["tool_use_id"],
            &["toolUseId"],
        ],
    )?;
    let name = first_string(
        value,
        &[&["name"], &["tool_name"], &["toolName"], &["tool", "name"]],
    )?;
    let input = first_value(
        value,
        &[
            &["input"],
            &["args"],
            &["arguments"],
            &["parameters"],
            &["tool", "input"],
        ],
    )
    .unwrap_or(Value::Null);

    Some(ParsedToolCall { id, name, input })
}

fn extract_cursor_tool_call_event(value: &Value) -> Option<ParsedToolCall> {
    let raw_call_id = value.get("call_id").and_then(Value::as_str)?;
    let id = raw_call_id
        .split('\n')
        .next()
        .unwrap_or(raw_call_id)
        .to_string();

    let tool_call_obj = value.get("tool_call").and_then(Value::as_object)?;
    let (tool_type_key, tool_data) = tool_call_obj.iter().next()?;
    let name = cursor_tool_type_to_name(tool_type_key)?.to_string();

    let mut input = tool_data.get("args").cloned().unwrap_or(Value::Null);

    if let Some(obj) = input.as_object_mut() {
        if matches!(name.as_str(), "Edit" | "Read" | "Write") {
            if let Some(path) = obj.remove("path") {
                obj.entry("file_path").or_insert(path);
            }
        }
    }

    Some(ParsedToolCall { id, name, input })
}

fn extract_cursor_tool_result(value: &Value) -> Option<(String, String)> {
    let raw_call_id = value.get("call_id").and_then(Value::as_str)?;
    let id = raw_call_id
        .split('\n')
        .next()
        .unwrap_or(raw_call_id)
        .to_string();

    let tool_call_obj = value.get("tool_call").and_then(Value::as_object)?;
    let (_key, tool_data) = tool_call_obj.iter().next()?;
    let result = tool_data.get("result")?;

    let output = if let Some(success) = result.get("success") {
        success.to_string()
    } else if let Some(error) = result.get("error") {
        format!("Error: {error}")
    } else {
        result.to_string()
    };

    Some((id, output))
}

fn extract_tool_result_event(value: &Value) -> Option<(String, String)> {
    let tool_use_id = first_string(
        value,
        &[
            &["tool_use_id"],
            &["toolUseId"],
            &["tool_call_id"],
            &["toolCallId"],
        ],
    )?;

    let output_value = first_value(
        value,
        &[
            &["output"],
            &["result"],
            &["content"],
            &["text"],
            &["tool_result"],
        ],
    )?;

    let output = match output_value {
        Value::String(text) => text,
        other => other.to_string(),
    };

    Some((tool_use_id, output))
}

fn extract_final_result_text(value: &Value) -> Option<String> {
    match value.get("result") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => first_string(other, &[&["text"], &["content"]])
            .or_else(|| {
                value_at_path(other, &["message", "content"])
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(extract_text_from_block)
                            .collect::<String>()
                    })
                    .filter(|text| !text.is_empty())
            })
            .or_else(|| {
                if other.is_object() || other.is_array() {
                    Some(other.to_string())
                } else {
                    None
                }
            }),
        None => None,
    }
}

fn longest_suffix_prefix_overlap(existing: &str, incoming: &str) -> usize {
    for overlap in incoming
        .char_indices()
        .map(|(idx, _)| idx)
        .chain(std::iter::once(incoming.len()))
        .rev()
    {
        if overlap == 0 || overlap > existing.len() {
            continue;
        }
        if existing.ends_with(&incoming[..overlap]) {
            return overlap;
        }
    }
    0
}

fn common_prefix_len(existing: &str, incoming: &str) -> usize {
    existing
        .chars()
        .zip(incoming.chars())
        .take_while(|(a, b)| a == b)
        .map(|(ch, _)| ch.len_utf8())
        .sum()
}

fn common_suffix_len(existing: &str, incoming: &str, prefix_len: usize) -> usize {
    let existing = &existing[prefix_len.min(existing.len())..];
    let incoming = &incoming[prefix_len.min(incoming.len())..];
    existing
        .chars()
        .rev()
        .zip(incoming.chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(ch, _)| ch.len_utf8())
        .sum()
}

fn is_near_duplicate_snapshot(existing: &str, incoming: &str) -> bool {
    if existing.is_empty() || incoming.is_empty() {
        return false;
    }

    let common_prefix = common_prefix_len(existing, incoming);
    let common_suffix = common_suffix_len(existing, incoming, common_prefix);
    let min_len = existing.len().min(incoming.len());

    common_prefix > 0
        && common_suffix > 0
        && common_prefix + common_suffix >= min_len.saturating_sub(8)
}

pub(crate) fn normalize_cursor_content(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.len() < 24 {
        return trimmed.to_string();
    }

    let mut prefix_lengths = vec![64, 48, 32, 24, 18, 16];
    if let Some(first_line) = trimmed.lines().find(|line| !line.trim().is_empty()) {
        prefix_lengths.push(first_line.trim().len());
    }

    for prefix_len in prefix_lengths {
        if prefix_len < 16 || prefix_len >= trimmed.len() {
            continue;
        }

        let mut boundary = prefix_len;
        while boundary > 0 && !trimmed.is_char_boundary(boundary) {
            boundary -= 1;
        }
        if boundary < 16 {
            continue;
        }

        let prefix = &trimmed[..boundary];
        let search_start = boundary.min(trimmed.len());
        if let Some(relative_idx) = trimmed[search_start..].find(prefix) {
            let idx = search_start + relative_idx;
            let candidate = trimmed[idx..].trim();
            if candidate.len() >= trimmed.len() / 3 && candidate.len() < trimmed.len() {
                return candidate.to_string();
            }
        }
    }

    trimmed.to_string()
}

fn reconcile_cursor_text(current: &str, candidate: &str) -> Option<String> {
    let normalized_current = normalize_cursor_content(current);
    let normalized_candidate = normalize_cursor_content(candidate);

    if normalized_candidate.is_empty() {
        return if normalized_current != current.trim() {
            Some(normalized_current)
        } else {
            None
        };
    }

    if normalized_current.is_empty() {
        return Some(normalized_candidate);
    }

    if normalized_current == normalized_candidate {
        return if normalized_current != current.trim() {
            Some(normalized_current)
        } else {
            None
        };
    }

    if normalized_candidate.contains(&normalized_current)
        || (normalized_current.contains(&normalized_candidate)
            && is_near_duplicate_snapshot(&normalized_current, &normalized_candidate))
        || is_near_duplicate_snapshot(&normalized_current, &normalized_candidate)
    {
        return Some(normalized_candidate);
    }

    if normalized_current != current.trim() {
        return Some(normalized_current);
    }

    None
}

fn merge_stream_text(existing: &mut String, incoming: &str) -> Option<String> {
    if incoming.is_empty() {
        return None;
    }

    if existing.is_empty() {
        existing.push_str(incoming);
        return Some(incoming.to_string());
    }

    if incoming == existing.as_str() || existing.contains(incoming) {
        if let Some(reconciled) = reconcile_cursor_text(existing, incoming) {
            *existing = reconciled;
        }
        return None;
    }

    if incoming.starts_with(existing.as_str()) {
        let suffix = incoming[existing.len()..].to_string();
        existing.push_str(&suffix);
        return if suffix.is_empty() {
            None
        } else {
            Some(suffix)
        };
    }

    if existing.starts_with(incoming) {
        return None;
    }

    let common_prefix = common_prefix_len(existing, incoming);
    let _common_suffix = common_suffix_len(existing, incoming, common_prefix);
    let mostly_same_text = is_near_duplicate_snapshot(existing, incoming);

    if mostly_same_text {
        existing.clear();
        existing.push_str(incoming);
        return None;
    }

    let overlap = longest_suffix_prefix_overlap(existing, incoming);
    let suffix = incoming[overlap..].to_string();
    existing.push_str(&suffix);
    if suffix.is_empty() {
        None
    } else {
        Some(suffix)
    }
}

fn has_plan_tool(tool_calls: &[ToolCall]) -> bool {
    tool_calls
        .iter()
        .any(|tool| tool.name == CURSOR_SYNTHETIC_PLAN_TOOL_NAME)
}

fn emit_chunk(app: &AppHandle, session_id: &str, worktree_id: &str, run_id: &str, chunk: &str) {
    if chunk.is_empty() {
        return;
    }

    let _ = app.emit_all(
        "chat:chunk",
        &ChunkEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            content: chunk.to_string(),
            run_id: Some(run_id.to_string()),
        },
    );
}

fn emit_tool_use(app: &AppHandle, session_id: &str, worktree_id: &str, tool_call: &ParsedToolCall) {
    let _ = app.emit_all(
        "chat:tool_use",
        &ToolUseEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            id: tool_call.id.clone(),
            name: tool_call.name.clone(),
            input: tool_call.input.clone(),
            parent_tool_use_id: None,
        },
    );
    let _ = app.emit_all(
        "chat:tool_block",
        &ToolBlockEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            tool_call_id: tool_call.id.clone(),
        },
    );
}

fn emit_tool_result(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    tool_use_id: &str,
    output: &str,
) {
    let _ = app.emit_all(
        "chat:tool_result",
        &ToolResultEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            tool_use_id: tool_use_id.to_string(),
            output: output.to_string(),
        },
    );
}

fn emit_done(app: &AppHandle, session_id: &str, worktree_id: &str, waiting_for_plan: bool) {
    let _ = app.emit_all(
        "chat:done",
        &serde_json::json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "waiting_for_plan": waiting_for_plan,
        }),
    );
}

fn push_text_block(content_blocks: &mut Vec<ContentBlock>, text: &str) {
    if text.is_empty() {
        return;
    }

    if let Some(ContentBlock::Text { text: existing }) = content_blocks.last_mut() {
        existing.push_str(text);
        return;
    }

    content_blocks.push(ContentBlock::Text {
        text: text.to_string(),
    });
}

fn ensure_tool_use(content_blocks: &mut Vec<ContentBlock>, tool_call_id: &str) {
    if content_blocks.iter().any(|block| {
        matches!(
            block,
            ContentBlock::ToolUse {
                tool_call_id: existing
            } if existing == tool_call_id
        )
    }) {
        return;
    }

    content_blocks.push(ContentBlock::ToolUse {
        tool_call_id: tool_call_id.to_string(),
    });
}

fn upsert_tool_call(tool_calls: &mut Vec<ToolCall>, parsed: &ParsedToolCall) {
    if let Some(existing) = tool_calls.iter_mut().find(|tool| tool.id == parsed.id) {
        existing.name = parsed.name.clone();
        existing.input = parsed.input.clone();
        return;
    }

    tool_calls.push(ToolCall {
        id: parsed.id.clone(),
        name: parsed.name.clone(),
        input: parsed.input.clone(),
        output: None,
        parent_tool_use_id: None,
    });
}

fn process_message_blocks<ChunkFn, ToolUseFn>(
    blocks: &[Value],
    content: &mut String,
    content_blocks: &mut Vec<ContentBlock>,
    tool_calls: &mut Vec<ToolCall>,
    saw_partial_text: &mut bool,
    text_snapshots: &mut Vec<String>,
    on_chunk: &mut ChunkFn,
    on_tool_use: &mut ToolUseFn,
) where
    ChunkFn: FnMut(&str),
    ToolUseFn: FnMut(&ParsedToolCall),
{
    let mut message_snapshot = String::new();
    for block in blocks {
        if let Some(text) = extract_text_from_block(block) {
            message_snapshot.push_str(&text);
            if !*saw_partial_text {
                if let Some(suffix) = merge_stream_text(content, &text) {
                    on_chunk(&suffix);
                    push_text_block(content_blocks, &suffix);
                }
            }
        } else if let Some(tool_call) = extract_tool_call_from_block(block) {
            upsert_tool_call(tool_calls, &tool_call);
            ensure_tool_use(content_blocks, &tool_call.id);
            on_tool_use(&tool_call);
        }
    }

    if !message_snapshot.is_empty() {
        text_snapshots.push(message_snapshot);
    }
}

fn set_tool_result(tool_calls: &mut [ToolCall], tool_use_id: &str, output: &str) {
    if let Some(existing) = tool_calls.iter_mut().find(|tool| tool.id == tool_use_id) {
        existing.output = Some(output.to_string());
    }
}

fn find_existing_plan_tool_id(tool_calls: &[ToolCall], plan: &str) -> Option<String> {
    tool_calls.iter().find_map(|tool| {
        if tool.name != CURSOR_SYNTHETIC_PLAN_TOOL_NAME {
            return None;
        }

        tool.input
            .get("plan")
            .and_then(Value::as_str)
            .filter(|existing_plan| *existing_plan == plan)
            .map(|_| tool.id.clone())
    })
}

fn effective_execution_mode(execution_mode: Option<&str>) -> &'static str {
    match execution_mode {
        Some("plan") => "plan",
        Some("build") | Some("yolo") => "yolo",
        _ => "plan",
    }
}

fn parse_cursor_stream(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    reader: impl BufRead,
    initial_chat_id: Option<&str>,
    is_plan_mode: bool,
) -> Result<CursorResponse, String> {
    parse_cursor_stream_inner(
        reader,
        initial_chat_id,
        is_plan_mode,
        |chunk| emit_chunk(app, session_id, worktree_id, run_id, chunk),
        |tool_call| emit_tool_use(app, session_id, worktree_id, tool_call),
        |tool_use_id, output| emit_tool_result(app, session_id, worktree_id, tool_use_id, output),
    )
}

fn parse_cursor_stream_inner<ChunkFn, ToolUseFn, ToolResultFn>(
    reader: impl BufRead,
    initial_chat_id: Option<&str>,
    is_plan_mode: bool,
    mut on_chunk: ChunkFn,
    mut on_tool_use: ToolUseFn,
    mut on_tool_result: ToolResultFn,
) -> Result<CursorResponse, String>
where
    ChunkFn: FnMut(&str),
    ToolUseFn: FnMut(&ParsedToolCall),
    ToolResultFn: FnMut(&str, &str),
{
    let mut content = String::new();
    let mut content_blocks = Vec::new();
    let mut tool_calls = Vec::new();
    let mut chat_id = initial_chat_id.unwrap_or_default().to_string();
    let mut usage = None;
    let mut saw_partial_text = false;
    let mut final_result_text: Option<String> = None;
    let mut text_snapshots = Vec::new();
    let mut event_counts = std::collections::BTreeMap::<String, usize>::new();

    for line in reader.lines() {
        let raw_line = line.map_err(|e| format!("Failed to read Cursor CLI output: {e}"))?;
        log::debug!("Cursor raw response line: {raw_line}");
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let parsed: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                log::trace!("Skipping non-JSON Cursor output line: {line}");
                continue;
            }
        };

        if let Some(extracted_chat_id) = extract_chat_id(&parsed) {
            chat_id = extracted_chat_id;
        }
        if usage.is_none() {
            usage = extract_usage(&parsed);
        }

        let event_type = parsed
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        *event_counts.entry(event_type.clone()).or_insert(0) += 1;

        match event_type.as_str() {
            "assistant" => {
                if let Some(delta) = extract_text_delta(&parsed) {
                    if let Some(suffix) = merge_stream_text(&mut content, &delta) {
                        saw_partial_text = true;
                        on_chunk(&suffix);
                    }
                }

                if let Some(blocks) = extract_message_blocks(&parsed) {
                    process_message_blocks(
                        blocks,
                        &mut content,
                        &mut content_blocks,
                        &mut tool_calls,
                        &mut saw_partial_text,
                        &mut text_snapshots,
                        &mut on_chunk,
                        &mut on_tool_use,
                    );
                }
            }
            "user" => {}
            "tool_call" => {
                let subtype = parsed.get("subtype").and_then(Value::as_str);

                let tool_call = extract_tool_call_event(&parsed)
                    .or_else(|| extract_cursor_tool_call_event(&parsed));

                if let Some(tool_call) = tool_call {
                    upsert_tool_call(&mut tool_calls, &tool_call);
                    ensure_tool_use(&mut content_blocks, &tool_call.id);
                    on_tool_use(&tool_call);
                }

                if subtype == Some("completed") {
                    if let Some((tool_use_id, output)) = extract_cursor_tool_result(&parsed) {
                        set_tool_result(&mut tool_calls, &tool_use_id, &output);
                        on_tool_result(&tool_use_id, &output);
                    }
                }
            }
            "interaction_query" => {
                if let Some(tool_call) = extract_tool_call_event(&parsed) {
                    if let Some(plan) = tool_call.input.get("plan").and_then(Value::as_str) {
                        if let Some(existing_id) = find_existing_plan_tool_id(&tool_calls, plan) {
                            if existing_id != tool_call.id {
                                continue;
                            }
                        }
                    }
                    upsert_tool_call(&mut tool_calls, &tool_call);
                    ensure_tool_use(&mut content_blocks, &tool_call.id);
                    on_tool_use(&tool_call);
                }
            }
            "result" => {
                if let Some((tool_use_id, output)) = extract_tool_result_event(&parsed) {
                    set_tool_result(&mut tool_calls, &tool_use_id, &output);
                    on_tool_result(&tool_use_id, &output);
                } else {
                    if let Some(result_value) = parsed.get("result") {
                        if let Some(blocks) = extract_message_blocks(result_value) {
                            process_message_blocks(
                                blocks,
                                &mut content,
                                &mut content_blocks,
                                &mut tool_calls,
                                &mut saw_partial_text,
                                &mut text_snapshots,
                                &mut on_chunk,
                                &mut on_tool_use,
                            );
                        }
                    }

                    if let Some(result_text) = extract_final_result_text(&parsed) {
                        final_result_text = Some(result_text.clone());
                        if let Some(suffix) = merge_stream_text(&mut content, &result_text) {
                            saw_partial_text = true;
                            on_chunk(&suffix);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if content.is_empty() {
        if let Some(text) = final_result_text.as_ref() {
            content = text.clone();
        }
    }

    if saw_partial_text {
        if let Some(snapshot) = text_snapshots.last() {
            let normalized_snapshot = normalize_cursor_content(snapshot);
            if !normalized_snapshot.is_empty() {
                content = normalized_snapshot;
            }
        }
    }

    for snapshot in text_snapshots.iter().chain(final_result_text.iter()) {
        if let Some(reconciled) = reconcile_cursor_text(&content, snapshot) {
            content = reconciled;
        }
    }
    content = normalize_cursor_content(&content);

    // Synthetic plan injection removed: plan approval only triggers when Cursor
    // emits a real createPlanToolCall / interaction_query with plan content.

    let already_has_text_blocks = content_blocks
        .iter()
        .any(|b| matches!(b, ContentBlock::Text { text } if !text.is_empty()));
    let has_plan = has_plan_tool(&tool_calls);
    if !content.is_empty() && !already_has_text_blocks && !has_plan {
        push_text_block(&mut content_blocks, &content);
    }

    log::trace!(
        "Cursor parsed response: chat_id_present={} content_len={} tool_calls={} synthesized_plan={} events={:?}",
        !chat_id.is_empty(),
        content.len(),
        tool_calls.len(),
        is_plan_mode && has_plan_tool(&tool_calls),
        event_counts
    );

    log::debug!("Cursor parsed response content: {}", content.trim());
    log::debug!(
        "Cursor parsed response tool_calls: {}",
        serde_json::to_string(&tool_calls).unwrap_or_else(|_| "[]".to_string())
    );
    log::debug!(
        "Cursor parsed response content_blocks: {}",
        serde_json::to_string(&content_blocks).unwrap_or_else(|_| "[]".to_string())
    );

    Ok(CursorResponse {
        content: content.trim().to_string(),
        chat_id,
        tool_calls,
        content_blocks,
        cancelled: false,
        usage,
    })
}

pub fn execute_cursor(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    run_id: &str,
    working_dir: &Path,
    existing_chat_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    message: &str,
    mcp_config: Option<&str>,
    system_prompt: Option<&str>,
    pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
) -> Result<CursorResponse, String> {
    let cli_path = crate::cursor_cli::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Cursor CLI not installed".to_string());
    }

    // Resume an existing chat when we have an id; otherwise let `--print`
    // create the chat implicitly. Skipping a separate `create-chat` spawn
    // removes a full process cold start from every new session's first message.
    let existing = existing_chat_id.filter(|id| !id.is_empty());
    let is_new_chat = existing.is_none();
    let chat_id: Option<String> = existing.map(str::to_string);

    let enabled_mcp_names = parse_enabled_mcp_names(mcp_config);
    crate::cursor_cli::mcp::sync_cursor_mcp_approvals(app, working_dir, &enabled_mcp_names)?;

    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
    cmd.arg("--print")
        .args(["--output-format", "stream-json"])
        .arg("--trust")
        .args(["--workspace"])
        .arg(working_dir);
    if let Some(id) = &chat_id {
        cmd.args(["--resume", id]);
    }

    if let Some(model) = raw_cursor_model(model) {
        cmd.args(["--model", model]);
    }

    let effective_mode = effective_execution_mode(execution_mode);
    match effective_mode {
        "plan" => {
            cmd.args(["--mode", "plan", "--sandbox", "enabled"]);
        }
        "build" | "yolo" => {
            cmd.args(["--yolo", "--sandbox", "disabled", "--force"]);
        }
        _ => {
            cmd.args(["--sandbox", "enabled"]);
        }
    }

    let prepared_message = build_cursor_message(
        message,
        effective_mode,
        if is_new_chat { system_prompt } else { None },
    );
    cmd.arg(&prepared_message)
        .current_dir(working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Jean session/depth context for Jean MCP server (when called back).
    cmd.env("JEAN_SESSION_ID", session_id);
    cmd.env("JEAN_WORKTREE_ID", worktree_id);
    let (depth_key, depth_val) = super::jean_mcp::child_depth_env();
    cmd.env(depth_key, depth_val);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Cursor CLI: {e}"))?;

    let pid = child.id();
    if let Some(cb) = pid_callback {
        cb(pid);
    }

    if !super::registry::register_process(session_id.to_string(), pid) {
        return Ok(CursorResponse {
            content: String::new(),
            chat_id: chat_id.clone().unwrap_or_default(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            usage: None,
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture Cursor CLI stdout".to_string())?;
    let stderr_handle = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf);
            buf
        })
    });
    let response = parse_cursor_stream(
        app,
        session_id,
        worktree_id,
        run_id,
        BufReader::new(stdout),
        chat_id.as_deref(),
        effective_mode == "plan",
    );

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Cursor CLI: {e}"))?;
    let cancelled = !super::registry::is_process_running(session_id);
    super::registry::unregister_process(session_id);
    let stderr = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_else(|| String::from_utf8_lossy(&output.stderr).to_string());

    let mut response = response?;
    response.cancelled = cancelled;

    if !output.status.success() && !cancelled {
        let error = strip_ansi(&stderr);
        let message = if error.trim().is_empty() {
            "Cursor CLI exited with a non-zero status".to_string()
        } else {
            error.trim().to_string()
        };
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: message.clone(),
            },
        );
        return Err(message);
    }

    if response.chat_id.is_empty() {
        if let Some(id) = chat_id {
            response.chat_id = id;
        } else if is_new_chat {
            log::warn!("Cursor new chat produced no chat_id; next message will start a fresh chat");
        }
    }

    if !response.cancelled {
        emit_done(
            app,
            session_id,
            worktree_id,
            effective_mode == "plan" && has_plan_tool(&response.tool_calls),
        );
    }

    Ok(response)
}

pub fn execute_one_shot_cursor(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    working_dir: Option<&Path>,
) -> Result<String, String> {
    let cli_path = crate::cursor_cli::resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Cursor CLI not installed".to_string());
    }

    let dir = working_dir.unwrap_or_else(|| Path::new("."));
    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
    cmd.arg("--print")
        .args(["--output-format", "stream-json"])
        .arg("--trust")
        .args(["--workspace"])
        .arg(dir)
        .args(["--mode", "ask", "--sandbox", "enabled"]);

    let model = raw_cursor_model(Some(model)).unwrap_or("auto");
    cmd.args(["--model", model])
        .arg(prompt)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run Cursor one-shot request: {e}"))?;

    if !output.status.success() {
        let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
        return Err(format!("Cursor one-shot request failed: {}", stderr.trim()));
    }

    let response = parse_cursor_stream_inner(
        BufReader::new(output.stdout.as_slice()),
        None,
        false,
        |_| {},
        |_| {},
        |_, _| {},
    )?;

    if response.content.is_empty() {
        return Err("No text content found in Cursor response".to_string());
    }

    Ok(response.content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_escape_sequences() {
        let input = "\u{1b}[2K\u{1b}[G✓ Logged in as test@example.com";
        assert_eq!(strip_ansi(input), "✓ Logged in as test@example.com");
    }

    #[test]
    fn extracts_chat_id_from_multiple_shapes() {
        assert_eq!(
            extract_chat_id(&serde_json::json!({ "chat_id": "chat-1" })),
            Some("chat-1".to_string())
        );
        assert_eq!(
            extract_chat_id(&serde_json::json!({ "result": { "sessionId": "chat-2" } })),
            Some("chat-2".to_string())
        );
    }

    #[test]
    fn parse_cursor_stream_handles_partial_text_and_tool_events() {
        let stream = r#"
{"type":"assistant","text":"hello "}
{"type":"tool_call","id":"tool-1","name":"Read","input":{"file_path":"README.md"}}
{"type":"result","tool_use_id":"tool-1","output":"ok"}
{"type":"assistant","text":"world"}
{"type":"result","chat_id":"chat-123","usage":{"input_tokens":10,"output_tokens":20}}
"#;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(response.content, "hello world");
        assert_eq!(response.chat_id, "chat-123");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "Read");
        assert_eq!(response.tool_calls[0].output.as_deref(), Some("ok"));
        assert!(
            matches!(
                response.content_blocks.first(),
                Some(ContentBlock::ToolUse { tool_call_id }) if tool_call_id == "tool-1"
            ) || matches!(
                response.content_blocks.first(),
                Some(ContentBlock::Text { text }) if text == "hello world"
            )
        );
        assert_eq!(response.usage.as_ref().map(|u| u.output_tokens), Some(20));
    }

    #[test]
    fn build_mode_falls_back_to_yolo() {
        assert_eq!(effective_execution_mode(Some("build")), "yolo");
    }

    #[test]
    fn cumulative_partials_are_deduplicated() {
        let stream = r#"
{"type":"assistant","text":"Hi"}
{"type":"assistant","text":"Hi there"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there"}]}}
"#;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(response.content, "Hi there");
        assert_eq!(response.content_blocks.len(), 1);
    }

    #[test]
    fn near_duplicate_snapshots_replace_instead_of_append() {
        let stream = r#"
{"type":"assistant","text":"Hello! What would you like me to help plan or implement?"}
{"type":"assistant","text":"Hello! What would you like me to help you plan or implement?"}
"#;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(
            response.content,
            "Hello! What would you like me to help you plan or implement?"
        );
        assert_eq!(response.content_blocks.len(), 1);
    }

    #[test]
    fn contained_clean_snapshot_replaces_garbled_prefix() {
        let mut existing =
            "I’m running as **Codex5.3 in this Cursor sessionI’m running as **Codex 5.3** in this Cursor session."
                .to_string();

        let suffix = merge_stream_text(
            &mut existing,
            "I’m running as **Codex 5.3** in this Cursor session.",
        );

        assert_eq!(
            existing,
            "I’m running as **Codex 5.3** in this Cursor session."
        );
        assert_eq!(suffix, None);
    }

    #[test]
    fn parse_cursor_stream_prefers_clean_message_snapshot_over_garbled_partials() {
        let stream = r#"
{"type":"assistant","text":"I’m running as **Codex"}
{"type":"assistant","text":"5.3 in this Cursor sessionI’m running as **Codex 5.3** in this Cursor session."}
{"type":"assistant","message":{"content":[{"type":"text","text":"I’m running as **Codex 5.3** in this Cursor session."}]}}
"#;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(
            response.content,
            "I’m running as **Codex 5.3** in this Cursor session."
        );
        assert_eq!(response.content_blocks.len(), 1);
    }

    #[test]
    fn plan_text_does_not_synthesize_exit_plan_tool() {
        let stream = r#"
{"type":"assistant","message":{"content":[{"type":"text","text":"Plan:\n- Inspect code\n- Patch parser"}]}}
"#;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            true,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert!(!response
            .tool_calls
            .iter()
            .any(|tool| tool.name == CURSOR_SYNTHETIC_PLAN_TOOL_NAME));
        assert!(!response
            .tool_calls
            .iter()
            .any(|tool| tool.name == "EnterPlanMode"));
    }

    #[test]
    fn merge_stream_text_handles_multibyte_delta_without_panicking() {
        let mut existing = "I".to_string();
        let suffix = merge_stream_text(&mut existing, "’ll");

        assert_eq!(existing, "I’ll");
        assert_eq!(suffix.as_deref(), Some("’ll"));
    }

    #[test]
    fn overlap_helpers_return_char_boundary_offsets_for_multibyte_text() {
        assert_eq!(
            longest_suffix_prefix_overlap("Hello 🙂", "🙂 world"),
            "🙂".len()
        );
        assert_eq!(common_prefix_len("I’ll help", "I’ll plan"), "I’ll ".len());
        assert_eq!(common_suffix_len("abc🙂xyz", "def🙂xyz", 0), "🙂xyz".len());
    }

    #[test]
    fn parse_cursor_stream_handles_multibyte_partial_chunks() {
        let stream = r#"
{"type":"assistant","text":"I"}
{"type":"assistant","text":"’ll"}
{"type":"assistant","text":" help"}
"#;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(response.content, "I’ll help");
        assert_eq!(response.content_blocks.len(), 1);
    }

    #[test]
    fn parse_cursor_stream_emits_live_chunks_for_snapshot_only_assistant_messages() {
        let stream = r#"
{"type":"assistant","message":{"content":[{"type":"text","text":"I’ll help plan the bird post."}]}}
"#;

        let mut streamed_chunks = Vec::new();
        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |chunk| streamed_chunks.push(chunk.to_string()),
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(streamed_chunks, vec!["I’ll help plan the bird post."]);
        assert_eq!(response.content, "I’ll help plan the bird post.");
        assert_eq!(response.content_blocks.len(), 1);
    }

    #[test]
    fn parse_cursor_stream_ignores_non_assistant_events_until_snapshot_arrives() {
        let stream = r#"
{"type":"system","subtype":"init","session_id":"cursor-session"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Plan mode instructions:\n- Read/analyze only; do not write, edit, or create files.\n- Do not run mutating commands.\n- If you have enough context, return a concise implementation plan.\n- When giving a plan, prefer a 'Plan:' heading followed by bullets/steps.\n\nUser request:\nPlan me a bird post"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Plan:\n- Pick species\n- Draft outline"}]}}
"#;

        let mut streamed_chunks = Vec::new();
        let mut tool_uses = Vec::new();
        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            true,
            |chunk| streamed_chunks.push(chunk.to_string()),
            |tool| tool_uses.push((tool.id.clone(), tool.name.clone())),
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(
            streamed_chunks,
            vec!["Plan:\n- Pick species\n- Draft outline"]
        );
        assert!(
            tool_uses.is_empty(),
            "no tool uses emitted during streaming"
        );
        assert_eq!(response.content, "Plan:\n- Pick species\n- Draft outline");
        assert!(!response
            .tool_calls
            .iter()
            .any(|tool| tool.name == "EnterPlanMode"));
        assert!(!response
            .tool_calls
            .iter()
            .any(|tool| tool.name == CURSOR_SYNTHETIC_PLAN_TOOL_NAME));
    }

    #[test]
    fn parse_cursor_stream_emits_live_chunks_for_result_only_text() {
        let stream = r#"
{"type":"system","subtype":"init","session_id":"cursor-session"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Plan mode instructions:\n- Read/analyze only; do not write, edit, or create files.\n- Do not run mutating commands.\n- If you have enough context, return a concise implementation plan.\n- When giving a plan, prefer a 'Plan:' heading followed by bullets/steps.\n\nUser request:\nPlan me a bird post"}]}}
{"type":"result","subtype":"success","result":"Plan:\n- Pick birds\n- Draft sections"}
"#;

        let mut streamed_chunks = Vec::new();
        let mut tool_uses = Vec::new();
        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            true,
            |chunk| streamed_chunks.push(chunk.to_string()),
            |tool| tool_uses.push((tool.id.clone(), tool.name.clone())),
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(
            streamed_chunks,
            vec!["Plan:\n- Pick birds\n- Draft sections"]
        );
        assert!(
            tool_uses.is_empty(),
            "no tool uses emitted during streaming"
        );
        assert_eq!(response.content, "Plan:\n- Pick birds\n- Draft sections");
        assert!(!response
            .tool_calls
            .iter()
            .any(|tool| tool.name == "EnterPlanMode"));
        assert!(!response
            .tool_calls
            .iter()
            .any(|tool| tool.name == CURSOR_SYNTHETIC_PLAN_TOOL_NAME));
    }

    #[test]
    fn parse_cursor_stream_emits_live_chunks_for_structured_result_text() {
        let stream = r#"
{"type":"result","subtype":"success","result":{"text":"I’ll draft the bird post outline."}}
"#;

        let mut streamed_chunks = Vec::new();
        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |chunk| streamed_chunks.push(chunk.to_string()),
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(streamed_chunks, vec!["I’ll draft the bird post outline."]);
        assert_eq!(response.content, "I’ll draft the bird post outline.");
        assert_eq!(response.content_blocks.len(), 1);
    }

    #[test]
    fn parse_cursor_stream_treats_result_with_plain_id_as_final_text_not_tool_output() {
        let stream = r#"
{"type":"result","id":"final-response-1","result":"Bird outline incoming."}
"#;

        let mut streamed_chunks = Vec::new();
        let mut tool_results = Vec::new();
        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |chunk| streamed_chunks.push(chunk.to_string()),
            |_| {},
            |tool_id, output| tool_results.push((tool_id.to_string(), output.to_string())),
        )
        .expect("stream should parse");

        assert_eq!(streamed_chunks, vec!["Bird outline incoming."]);
        assert!(tool_results.is_empty());
        assert_eq!(response.content, "Bird outline incoming.");
    }

    #[test]
    fn parse_cursor_stream_extracts_text_from_result_message_blocks() {
        let stream = r#"
{"type":"result","result":{"message":{"content":[{"type":"text","text":"Plan:\n- Intro\n- Species\n- Migration"}]}}}
"#;

        let mut streamed_chunks = Vec::new();
        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            true,
            |chunk| streamed_chunks.push(chunk.to_string()),
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(
            streamed_chunks,
            vec!["Plan:\n- Intro\n- Species\n- Migration"]
        );
        assert_eq!(response.content, "Plan:\n- Intro\n- Species\n- Migration");
        assert!(!response
            .tool_calls
            .iter()
            .any(|tool| tool.name == CURSOR_SYNTHETIC_PLAN_TOOL_NAME));
    }

    #[test]
    fn parse_cursor_stream_extracts_tool_use_blocks_from_result_message_blocks() {
        let stream = r#"
{"type":"result","result":{"message":{"content":[{"type":"text","text":"Planning now."},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"birds.md"}}]}}}
"#;

        let mut tool_uses = Vec::new();
        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |tool| tool_uses.push((tool.id.clone(), tool.name.clone())),
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(response.content, "Planning now.");
        assert_eq!(tool_uses, vec![("tool-1".to_string(), "Read".to_string())]);
        assert!(response
            .content_blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse { tool_call_id } if tool_call_id == "tool-1")));
    }

    #[test]
    fn normalize_cursor_content_prefers_repeated_prefix_suffix_for_persisted_history() {
        let text = "In this session, I can see three user questions from you:\n\n1. Broken intro\n\nThat’s the full conversational content we’ve exchanged so farIn this session, I can see three user questions from you:\n\n1. Clean intro\n\nThat’s the full conversational content we’ve exchanged so far.";

        assert_eq!(
            normalize_cursor_content(text),
            "In this session, I can see three user questions from you:\n\n1. Clean intro\n\nThat’s the full conversational content we’ve exchanged so far."
        );
    }

    #[test]
    fn parse_cursor_stream_prefers_clean_multiline_snapshot_over_garbled_partials() {
        let stream = r#"
{"type":"assistant","text":"In this session, I can see three user questions from you:\n\n1. You asked **“what ll model are using?”"}
{"type":"assistant","text":"  \n - I repliedCodex53.\n\n2 sure in cod?”**  \n - I confirmed: **yes, Codex Now you asked about **what chat history I can see.  \n\nThat’s the full conversational content we’ve exchanged so far"}
{"type":"assistant","message":{"content":[{"type":"text","text":"In this session, I can see three user questions from you:\n\n1. You asked: **“what llm model are you using?”**\n   - I replied: **Codex 5.3**.\n\n2. You asked: **“are you sure in codex 5.3?”**\n   - I confirmed: **yes, Codex 5.3**.\n\n3. Now you asked about **what chat history I can see**.\n\nThat’s the full conversational content we’ve exchanged so far."}]}}
"#;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert_eq!(
            response.content,
            "In this session, I can see three user questions from you:\n\n1. You asked: **“what llm model are you using?”**\n   - I replied: **Codex 5.3**.\n\n2. You asked: **“are you sure in codex 5.3?”**\n   - I confirmed: **yes, Codex 5.3**.\n\n3. Now you asked about **what chat history I can see**.\n\nThat’s the full conversational content we’ve exchanged so far."
        );
    }

    #[test]
    fn parse_cursor_stream_captures_structured_create_plan_tool_calls() {
        let stream = r##"
{"type":"assistant","message":{"content":[{"type":"text","text":"I’ll draft a plan."}]}}
{"type":"tool_call","subtype":"started","call_id":"call_plan_1","tool_call":{"createPlanToolCall":{"args":{"plan":"# Plan: Birds\n\n- Pick angle\n- Draft outline"}}}}
{"type":"result","subtype":"success","result":"I’ll draft a plan."}
"##;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            true,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert!(response.tool_calls.iter().any(|tool| {
            tool.name == CURSOR_SYNTHETIC_PLAN_TOOL_NAME
                && tool.id == "call_plan_1"
                && tool.input.get("plan").and_then(Value::as_str)
                    == Some("# Plan: Birds\n\n- Pick angle\n- Draft outline")
        }));
    }

    #[test]
    fn parse_cursor_stream_captures_interaction_query_create_plan_events() {
        let stream = r##"
{"type":"interaction_query","subtype":"request","query_type":"createPlanRequestQuery","query":{"id":0,"createPlanRequestQuery":{"args":{"plan":"# Plan: Birds\n\n- Observe\n- Write","toolCallId":"query_plan_1"}}}}
"##;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        assert!(response.tool_calls.iter().any(|tool| {
            tool.name == CURSOR_SYNTHETIC_PLAN_TOOL_NAME
                && (tool.id == "query_plan_1" || tool.id == "cursor-create-plan")
                && tool.input.get("plan").and_then(Value::as_str)
                    == Some("# Plan: Birds\n\n- Observe\n- Write")
        }));
    }

    #[test]
    fn parse_cursor_stream_deduplicates_interaction_query_when_tool_call_has_same_plan() {
        let stream = r##"
{"type":"tool_call","subtype":"started","call_id":"call_plan_1","tool_call":{"createPlanToolCall":{"args":{"plan":"# Plan: Birds\n\n- Pick angle\n- Draft outline"}}}}
{"type":"interaction_query","subtype":"request","query_type":"createPlanRequestQuery","query":{"id":0,"createPlanRequestQuery":{"args":{"plan":"# Plan: Birds\n\n- Pick angle\n- Draft outline","toolCallId":"query_plan_1"}}}}
"##;

        let response = parse_cursor_stream_inner(
            BufReader::new(stream.as_bytes()),
            None,
            false,
            |_| {},
            |_| {},
            |_, _| {},
        )
        .expect("stream should parse");

        let matching_plan_tools = response
            .tool_calls
            .iter()
            .filter(|tool| {
                tool.name == CURSOR_SYNTHETIC_PLAN_TOOL_NAME
                    && tool.input.get("plan").and_then(Value::as_str)
                        == Some("# Plan: Birds\n\n- Pick angle\n- Draft outline")
            })
            .count();

        assert_eq!(matching_plan_tools, 1);
        assert_eq!(
            response
                .content_blocks
                .iter()
                .filter(|block| matches!(block, ContentBlock::ToolUse { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn longest_suffix_prefix_overlap_finds_overlap() {
        assert_eq!(longest_suffix_prefix_overlap("hello wo", "wo rld"), 2);
        assert_eq!(longest_suffix_prefix_overlap("abc", "def"), 0);
        assert_eq!(longest_suffix_prefix_overlap("abcdef", "defgh"), 3);
        assert_eq!(longest_suffix_prefix_overlap("", "abc"), 0);
        assert_eq!(longest_suffix_prefix_overlap("abc", ""), 0);
        assert_eq!(longest_suffix_prefix_overlap("abc", "abc"), 3);
    }

    #[test]
    fn is_near_duplicate_snapshot_detects_nearly_identical_text() {
        // Near-duplicates differ by a few chars in the middle
        assert!(is_near_duplicate_snapshot(
            "Hello world, how are you today?",
            "Hello world, how are we today?"
        ));
        // Completely different strings
        assert!(!is_near_duplicate_snapshot("abc", "xyz"));
        assert!(!is_near_duplicate_snapshot("", "hello"));
        assert!(!is_near_duplicate_snapshot("hello", ""));
        // Identical strings: common_suffix_len(s, s, full_prefix) == 0, so not "near duplicate"
        assert!(!is_near_duplicate_snapshot("abc", "abc"));
    }

    #[test]
    fn normalize_cursor_content_returns_short_text_unchanged() {
        assert_eq!(normalize_cursor_content("short"), "short");
        assert_eq!(normalize_cursor_content("  trimmed  "), "trimmed");
        assert_eq!(normalize_cursor_content("a"), "a");
    }

    #[test]
    fn normalize_cursor_content_removes_garbled_prefix_from_duplicated_text() {
        // Mirrors the pattern from parse_cursor_stream_prefers_clean_multiline_snapshot:
        // garbled partial followed by clean text that shares same prefix
        let clean = "In this session, I can see three user questions from you:\n\n1. Clean intro\n\nThat's the full conversational content.";
        let garbled = "In this session, I can see three user questions from you:\n\n1. Broken intro\n\nThat's the full conversational contentIn this session, I can see three user questions from you:\n\n1. Clean intro\n\nThat's the full conversational content.";
        let result = normalize_cursor_content(garbled);
        assert_eq!(result, clean);
    }

    #[test]
    fn reconcile_cursor_text_returns_none_for_identical_content() {
        assert_eq!(reconcile_cursor_text("hello world", "hello world"), None);
    }

    #[test]
    fn reconcile_cursor_text_returns_candidate_when_current_empty() {
        assert_eq!(
            reconcile_cursor_text("", "new content"),
            Some("new content".to_string())
        );
    }

    #[test]
    fn reconcile_cursor_text_returns_none_for_empty_candidate() {
        assert_eq!(reconcile_cursor_text("existing", ""), None);
    }

    #[test]
    fn reconcile_cursor_text_returns_candidate_when_it_contains_current() {
        assert_eq!(
            reconcile_cursor_text("Hello world", "Hello world, how are you doing today?"),
            Some("Hello world, how are you doing today?".to_string())
        );
    }

    #[test]
    fn merge_stream_text_appends_new_content() {
        let mut existing = String::from("hello ");
        let result = merge_stream_text(&mut existing, "world");
        assert_eq!(result, Some("world".to_string()));
        assert_eq!(existing, "hello world");
    }

    #[test]
    fn merge_stream_text_returns_none_for_duplicate() {
        let mut existing = String::from("hello world");
        let result = merge_stream_text(&mut existing, "hello world");
        assert_eq!(result, None);
    }

    #[test]
    fn merge_stream_text_handles_prefix_extension() {
        let mut existing = String::from("hello");
        let result = merge_stream_text(&mut existing, "hello world");
        assert_eq!(result, Some(" world".to_string()));
        assert_eq!(existing, "hello world");
    }

    #[test]
    fn merge_stream_text_handles_suffix_prefix_overlap() {
        let mut existing = String::from("abc def");
        let result = merge_stream_text(&mut existing, "def ghi");
        assert_eq!(result, Some(" ghi".to_string()));
        assert_eq!(existing, "abc def ghi");
    }

    #[test]
    fn merge_stream_text_handles_empty_inputs() {
        let mut existing = String::new();
        assert_eq!(merge_stream_text(&mut existing, ""), None);
        assert_eq!(
            merge_stream_text(&mut existing, "hello"),
            Some("hello".to_string())
        );
        assert_eq!(existing, "hello");
    }

    #[test]
    fn common_prefix_len_finds_shared_prefix() {
        assert_eq!(common_prefix_len("abcdef", "abcxyz"), 3);
        assert_eq!(common_prefix_len("hello", "hello"), 5);
        assert_eq!(common_prefix_len("abc", "xyz"), 0);
        assert_eq!(common_prefix_len("", "abc"), 0);
    }

    #[test]
    fn common_suffix_len_finds_shared_suffix() {
        assert_eq!(common_suffix_len("abcxyz", "defxyz", 0), 3);
        assert_eq!(common_suffix_len("hello", "hello", 5), 0);
        assert_eq!(common_suffix_len("abc", "xyz", 0), 0);
    }

    #[test]
    fn extract_usage_from_various_shapes() {
        let with_snake = serde_json::json!({
            "usage": { "input_tokens": 100, "output_tokens": 50 }
        });
        let usage = extract_usage(&with_snake).unwrap();
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);

        let with_camel = serde_json::json!({
            "usage": { "inputTokens": 200, "outputTokens": 75, "cacheReadInputTokens": 10 }
        });
        let usage = extract_usage(&with_camel).unwrap();
        assert_eq!(usage.input_tokens, 200);
        assert_eq!(usage.cache_read_input_tokens, 10);

        let empty_usage = serde_json::json!({
            "usage": { "input_tokens": 0, "output_tokens": 0 }
        });
        assert!(extract_usage(&empty_usage).is_none());
    }

    #[test]
    fn extract_text_delta_from_various_paths() {
        assert_eq!(
            extract_text_delta(&serde_json::json!({"delta": "hello"})),
            Some("hello".to_string())
        );
        assert_eq!(
            extract_text_delta(&serde_json::json!({"text": "world"})),
            Some("world".to_string())
        );
        assert_eq!(
            extract_text_delta(&serde_json::json!({"content": "foo"})),
            Some("foo".to_string())
        );
        assert_eq!(
            extract_text_delta(&serde_json::json!({"unrelated": "bar"})),
            None
        );
    }

    #[test]
    fn extract_tool_call_from_block_handles_various_field_names() {
        let block = serde_json::json!({
            "type": "tool_use",
            "id": "t1",
            "name": "Read",
            "input": {"path": "/tmp"}
        });
        let tc = extract_tool_call_from_block(&block).unwrap();
        assert_eq!(tc.id, "t1");
        assert_eq!(tc.name, "Read");

        let alt_block = serde_json::json!({
            "type": "tool_use",
            "tool_call_id": "t2",
            "toolName": "Write",
            "args": {"data": "hi"}
        });
        let tc = extract_tool_call_from_block(&alt_block).unwrap();
        assert_eq!(tc.id, "t2");
        assert_eq!(tc.name, "Write");

        let non_tool = serde_json::json!({"type": "text", "text": "hello"});
        assert!(extract_tool_call_from_block(&non_tool).is_none());
    }

    #[test]
    fn extract_tool_result_event_handles_various_shapes() {
        let result = serde_json::json!({
            "tool_use_id": "t1",
            "output": "file contents"
        });
        let (id, output) = extract_tool_result_event(&result).unwrap();
        assert_eq!(id, "t1");
        assert_eq!(output, "file contents");

        let alt_result = serde_json::json!({
            "toolCallId": "t2",
            "result": "success"
        });
        let (id, output) = extract_tool_result_event(&alt_result).unwrap();
        assert_eq!(id, "t2");
        assert_eq!(output, "success");
    }

    #[test]
    fn build_cursor_message_passes_through_in_plan_mode() {
        assert_eq!(build_cursor_message("Add tests", "plan", None), "Add tests");
    }

    #[test]
    fn build_cursor_message_prepends_end_plan_mode_for_yolo() {
        assert_eq!(
            build_cursor_message("Add tests", "yolo", None),
            "<end_plan_mode/>\n\nAdd tests"
        );
        assert_eq!(
            build_cursor_message("Add tests", "build", None),
            "<end_plan_mode/>\n\nAdd tests"
        );
    }

    #[test]
    fn build_cursor_message_prepends_system_prompt_for_new_chat() {
        assert_eq!(
            build_cursor_message("Add tests", "plan", Some("Always reply in French.")),
            "<system_instructions>\nAlways reply in French.\n</system_instructions>\n\nAdd tests"
        );
        assert_eq!(
            build_cursor_message("Add tests", "yolo", Some("Always reply in French.")),
            "<system_instructions>\nAlways reply in French.\n</system_instructions>\n\n<end_plan_mode/>\n\nAdd tests"
        );
    }

    #[test]
    fn build_cursor_message_skips_system_prompt_when_empty() {
        assert_eq!(
            build_cursor_message("Add tests", "plan", Some("   ")),
            "Add tests"
        );
        assert_eq!(
            build_cursor_message("Add tests", "plan", Some("")),
            "Add tests"
        );
    }
}
