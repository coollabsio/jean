//! Grok Build CLI execution engine.
//!
//! On Unix, interactive Grok turns run through a detached ACP host process
//! (`--jean-grok-acp-host`) so the turn survives Jean restart — same pattern as
//! PI's RPC host. Jean tails the run JSONL and reattaches via `resume_session`.
//! Windows keeps the in-process ACP child path (non-survivable).

use super::coalesce::ChunkCoalescer;
use super::types::{ChatMessage, ContentBlock, MessageRole, RunEntry, ToolCall, UsageData};
use crate::http_server::EmitExt;
use base64::{engine::general_purpose::STANDARD, Engine};
use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::HashMap;
#[cfg(unix)]
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
/// Jean self-relaunch flag for the detached Grok ACP host (Unix).
pub const GROK_ACP_HOST_ARG: &str = "--jean-grok-acp-host";

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

pub struct GrokResponse {
    pub content: String,
    pub session_id: String,
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

const GROK_SYNTHETIC_PLAN_TOOL_NAME: &str = "ExitPlanMode";

/// Map a Grok tool variant / ACP title / kind onto Jean's display tool names.
///
/// Grok ACP frequently sets `title` to a human summary (grep pattern, `Read \`path\``,
/// `Execute \`cmd\``) and puts the real tool type in `rawInput.variant` (or message-block
/// `input.variant`). Without normalization the UI shows the title as the tool name and
/// cannot render Read/Bash/Grep/etc. affordances.
fn map_grok_tool_name(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        // Shell
        "Bash"
        | "bash"
        | "Shell"
        | "shell"
        | "CursorShell"
        | "run_terminal_cmd"
        | "run_terminal_command"
        | "shell_command"
        | "Execute" => Some("Bash"),
        // Search
        "Grep" | "grep" | "CursorGrep" => Some("Grep"),
        "Glob" | "glob" | "CursorGlob" => Some("Glob"),
        // Filesystem
        "Read" | "ReadFile" | "CursorRead" | "read_file" | "readFile" => Some("Read"),
        "Write" | "write" | "WriteFile" | "CursorWrite" | "write_file" | "writeFile" => {
            Some("Write")
        }
        "Edit" | "EditFile" | "edit_file" | "SearchReplace" | "search_replace" | "StrReplace"
        | "str_replace" | "CursorStrReplace" => Some("Edit"),
        "Delete" | "DeleteFile" | "delete_file" => Some("Delete"),
        "List" | "ListDir" | "list_dir" | "LS" | "ls" | "read_directory" => Some("List"),
        // Web
        "WebFetch" | "web_fetch" | "WebFetchTool" | "Fetch" => Some("WebFetch"),
        "WebSearch" | "web_search" | "WebSearchTool" | "Web search" => Some("WebSearch"),
        // Agents
        "Task" | "task" | "spawn_subagent" => Some("Task"),
        "TaskOutput" | "get_command_or_subagent_output" => Some("WaitForAgents"),
        "Agent" | "agent" | "SubAgent" | "subagent" => Some("Agent"),
        // Todos (Grok ACP uses TodoWrite / todo_write; titles like "Updating plan")
        "TodoWrite" | "CursorTodoWrite" | "todo_write" | "todowrite" | "Todo" | "Todos"
        | "todo" => Some("TodoWrite"),
        // Plan
        "EnterPlanMode" | "enter_plan_mode" => Some("EnterPlanMode"),
        "ExitPlanMode" | "exit_plan_mode" => Some(GROK_SYNTHETIC_PLAN_TOOL_NAME),
        _ => None,
    }
}

fn normalize_todo_status(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "completed" | "complete" | "done" | "finished" => "completed",
        "in_progress" | "in-progress" | "inprogress" | "running" | "active" => "in_progress",
        "cancelled" | "canceled" | "skipped" => "cancelled",
        _ => "pending",
    }
}

/// Normalize Grok/Claude-style todo items to Jean's Todo shape:
/// `{ content, activeForm, status }` (status is pending|in_progress|completed|cancelled).
fn normalize_todos_array(todos: &Value) -> Value {
    let Some(items) = todos.as_array() else {
        return todos.clone();
    };
    let normalized: Vec<Value> = items
        .iter()
        .filter_map(|item| {
            let map = item.as_object()?;
            let content = map
                .get("content")
                .or_else(|| map.get("text"))
                .or_else(|| map.get("title"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            let active_form = map
                .get("activeForm")
                .or_else(|| map.get("active_form"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(content.as_str())
                .to_string();
            let status = map
                .get("status")
                .and_then(Value::as_str)
                .map(normalize_todo_status)
                .unwrap_or("pending");

            let mut out = serde_json::Map::new();
            // Preserve id when present (Grok includes it; Claude usually does not).
            if let Some(id) = map.get("id").cloned().filter(|v| !v.is_null()) {
                out.insert("id".to_string(), id);
            }
            out.insert("content".to_string(), Value::String(content));
            out.insert("activeForm".to_string(), Value::String(active_form));
            out.insert("status".to_string(), Value::String(status.to_string()));
            Some(Value::Object(out))
        })
        .collect();
    Value::Array(normalized)
}

fn input_as_object_mut(input: &mut Value) -> &mut serde_json::Map<String, Value> {
    if !input.is_object() {
        *input = Value::Object(serde_json::Map::new());
    }
    input.as_object_mut().expect("object just ensured")
}

fn take_string_field(map: &mut serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = map.remove(*key) {
            match value {
                Value::String(s) if !s.is_empty() => return Some(s),
                Value::Number(n) => return Some(n.to_string()),
                Value::Bool(b) => return Some(b.to_string()),
                other if !other.is_null() => {
                    // Put non-string values back under the first key so we don't drop data.
                    map.insert((*key).to_string(), other);
                    return None;
                }
                _ => {}
            }
        }
    }
    None
}

fn ensure_string_field(map: &mut serde_json::Map<String, Value>, target: &str, sources: &[&str]) {
    if map
        .get(target)
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        return;
    }
    if let Some(value) = take_string_field(map, sources) {
        map.insert(target.to_string(), Value::String(value));
    }
}

fn strip_variant_fields(map: &mut serde_json::Map<String, Value>) {
    map.remove("variant");
    // ACP sometimes mirrors the tool type as `type` inside rawInput; drop only when it
    // looks like a tool variant, not a content-type string.
    if let Some(Value::String(t)) = map.get("type").cloned() {
        if map_grok_tool_name(&t).is_some() {
            map.remove("type");
        }
    }
}

/// Infer a tool name from Grok ACP display titles when variant is missing.
fn infer_name_from_title(title: &str) -> Option<&'static str> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(mapped) = map_grok_tool_name(trimmed) {
        return Some(mapped);
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("web search") {
        return Some("WebSearch");
    }
    if lower.starts_with("fetch:") || lower.starts_with("fetch ") {
        return Some("WebFetch");
    }
    if lower.starts_with("execute ") || lower.starts_with("execute`") || lower.starts_with("run ") {
        return Some("Bash");
    }
    if lower.starts_with("read ") || lower.starts_with("read`") {
        return Some("Read");
    }
    if lower.starts_with("write ") || lower.starts_with("write`") {
        return Some("Write");
    }
    if lower.starts_with("edit ") || lower.starts_with("edit`") {
        return Some("Edit");
    }
    if lower.starts_with("list ") || lower.starts_with("list`") {
        return Some("List");
    }
    if lower.starts_with("grep ") || lower.starts_with("search ") {
        return Some("Grep");
    }
    // Grok often titles todo updates "Updating plan" / "Updated todos" / similar.
    if lower.contains("todo")
        || lower == "updating plan"
        || lower.starts_with("update plan")
        || lower.starts_with("updating tasks")
        || lower.starts_with("update tasks")
    {
        return Some("TodoWrite");
    }
    None
}

fn query_from_web_search_title(title: &str) -> Option<String> {
    let trimmed = title.trim();
    for prefix in ["Web search:", "Web search", "WebSearch:", "web_search:"] {
        if let Some(rest) = trimmed
            .strip_prefix(prefix)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(rest.to_string());
        }
    }
    None
}

fn url_from_fetch_title(title: &str) -> Option<String> {
    let trimmed = title.trim();
    for prefix in ["Fetch:", "Fetch", "WebFetch:"] {
        if let Some(rest) = trimmed
            .strip_prefix(prefix)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(rest.to_string());
        }
    }
    None
}

/// Normalize a parsed Grok tool call so Jean's UI can render it like Claude/Codex tools.
fn normalize_grok_tool_call(mut tool: ParsedToolCall) -> ParsedToolCall {
    let original_name = tool.name.clone();
    let mut input = tool.input;

    // Prefer explicit variant / type inside input (ACP rawInput / message blocks).
    let variant_from_input = input.as_object().and_then(|map| {
        map.get("variant")
            .or_else(|| map.get("type"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    });

    let mapped_from_variant = variant_from_input.as_deref().and_then(map_grok_tool_name);
    let mapped_from_name = map_grok_tool_name(&original_name);
    let mapped_from_title = infer_name_from_title(&original_name);

    let name = mapped_from_variant
        .or(mapped_from_name)
        .or(mapped_from_title)
        .unwrap_or(original_name.as_str())
        .to_string();

    {
        let map = input_as_object_mut(&mut input);
        strip_variant_fields(map);

        match name.as_str() {
            "Read" => {
                ensure_string_field(
                    map,
                    "file_path",
                    &[
                        "file_path",
                        "target_file",
                        "path",
                        "filePath",
                        "absolutePath",
                    ],
                );
            }
            "Write" | "Edit" | "Delete" => {
                ensure_string_field(
                    map,
                    "file_path",
                    &[
                        "file_path",
                        "target_file",
                        "path",
                        "filePath",
                        "absolutePath",
                    ],
                );
                // ACP Diff-style keys → Claude Edit keys
                ensure_string_field(map, "old_string", &["old_string", "oldText", "old_text"]);
                ensure_string_field(map, "new_string", &["new_string", "newText", "new_text"]);
                if name == "Write" {
                    ensure_string_field(map, "content", &["content", "contents"]);
                }
            }
            "List" => {
                ensure_string_field(
                    map,
                    "path",
                    &["path", "target_directory", "targetDirectory", "directory"],
                );
            }
            "Bash" => {
                ensure_string_field(map, "command", &["command", "cmd", "shell"]);
                // Prefer Jean's description field; drop background flag noise if present.
                if let Some(Value::Bool(_)) = map.get("is_background") {
                    // Keep for completeness but ensure boolean stays; no rename needed.
                }
            }
            "Grep" => {
                ensure_string_field(map, "pattern", &["pattern", "query", "regex"]);
                ensure_string_field(map, "path", &["path", "target_directory", "directory"]);
                ensure_string_field(map, "glob", &["glob", "include"]);
                // Grok emits case-insensitive as JSON key "-i" (bool/null).
                if !map.contains_key("case_insensitive") {
                    if let Some(Value::Bool(true)) = map.get("-i") {
                        map.insert("case_insensitive".to_string(), Value::Bool(true));
                    }
                }
            }
            "Glob" => {
                ensure_string_field(map, "pattern", &["pattern", "glob_pattern", "glob"]);
                ensure_string_field(
                    map,
                    "path",
                    &["path", "target_directory", "targetDirectory", "directory"],
                );
            }
            "WebSearch" => {
                if map
                    .get("query")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.is_empty())
                {
                    if let Some(query) = query_from_web_search_title(&original_name) {
                        map.insert("query".to_string(), Value::String(query));
                    }
                }
            }
            "WebFetch" => {
                ensure_string_field(map, "url", &["url", "uri", "href"]);
                if map
                    .get("url")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.is_empty())
                {
                    if let Some(url) = url_from_fetch_title(&original_name) {
                        map.insert("url".to_string(), Value::String(url));
                    }
                }
            }
            "TodoWrite" => {
                // Grok sends `{ merge, todos: [{id, content, status}], variant }`.
                // Jean TodoWidget expects `{ todos: [{content, activeForm, status}] }`.
                if let Some(todos) = map.get("todos").cloned() {
                    map.insert("todos".to_string(), normalize_todos_array(&todos));
                } else if let Some(todos) = map.get("items").cloned() {
                    map.insert("todos".to_string(), normalize_todos_array(&todos));
                    map.remove("items");
                }
                // merge is Grok-specific; keep it for potential future merge logic but
                // strip nulls. Frontend currently replaces with latest TodoWrite snapshot.
            }
            "WaitForAgents" if !map.contains_key("receiver_thread_ids") => {
                if let Some(task_ids) = map.remove("task_ids") {
                    map.insert("receiver_thread_ids".to_string(), task_ids);
                }
            }
            _ => {}
        }
    }

    // If input ended up empty object and original was null, keep empty object (UI-friendly).
    tool.name = name;
    tool.input = input;
    tool
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

/// Default Grok model used when no Grok-specific model is supplied.
pub const GROK_DEFAULT_MODEL: &str = "grok-4.5";

fn raw_grok_model(model: Option<&str>) -> Option<&str> {
    match model.map(|value| value.strip_prefix("grok/").unwrap_or(value)) {
        // Map legacy Grok CLI defaults to the currently available model.
        Some("grok-build-0.1") | Some("grok-composer-2.5-fast") => Some("grok-4.5"),
        value => value,
    }
}

/// Resolve a one-shot Grok model. Magic-prompt callers share a global model
/// string that defaults to a Claude model when none is set; coerce any
/// non-Grok model to the Grok default so the Grok executor never receives a
/// Claude/other-backend model id.
fn resolve_one_shot_grok_model(model: &str) -> &str {
    let stripped = model.strip_prefix("grok/").unwrap_or(model);
    if stripped.starts_with("grok") {
        model
    } else {
        GROK_DEFAULT_MODEL
    }
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

fn extract_session_id(value: &Value) -> Option<String> {
    first_string(
        value,
        &[
            &["session_id"],
            &["sessionId"],
            &["id"],
            &["session", "id"],
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
        &["update", "content", "text"][..],
        &["params", "update", "content", "text"][..],
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

fn extract_message_blocks(value: &Value) -> Option<&Vec<Value>> {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .or_else(|| value.get("content").and_then(Value::as_array))
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("message"))
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
        })
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
    Some(normalize_grok_tool_call(ParsedToolCall { id, name, input }))
}

fn extract_tool_call_event(value: &Value) -> Option<ParsedToolCall> {
    let id = first_string(
        value,
        &[
            &["id"],
            &["tool_call_id"],
            &["toolCallId"],
            &["tool_use_id"],
            &["toolUseId"],
            &["call_id"],
        ],
    )?;
    let name = first_string(
        value,
        &[
            &["name"],
            &["tool_name"],
            &["toolName"],
            &["tool", "name"],
            &["tool_call", "name"],
        ],
    )?;
    let input = first_value(
        value,
        &[
            &["input"],
            &["args"],
            &["arguments"],
            &["parameters"],
            &["tool", "input"],
            &["tool_call", "input"],
        ],
    )
    .unwrap_or(Value::Null);
    Some(normalize_grok_tool_call(ParsedToolCall { id, name, input }))
}

fn extract_tool_result_event(value: &Value) -> Option<(String, String)> {
    let tool_use_id = first_string(
        value,
        &[
            &["tool_use_id"],
            &["toolUseId"],
            &["tool_call_id"],
            &["toolCallId"],
            &["call_id"],
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
    let output = value_to_output_text(&output_value)?;
    Some((tool_use_id, output))
}

fn extract_tool_result_from_block(block: &Value) -> Option<(String, String)> {
    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
        return None;
    }
    let tool_use_id = first_string(
        block,
        &[
            &["tool_use_id"],
            &["toolUseId"],
            &["tool_call_id"],
            &["toolCallId"],
            &["id"],
        ],
    )?;
    let output_value = first_value(block, &[&["content"], &["output"], &["result"], &["text"]])?;
    let output = value_to_output_text(&output_value)?;
    Some((tool_use_id, output))
}

fn extract_final_result_text(value: &Value) -> Option<String> {
    match value.get("result") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            first_string(other, &[&["text"], &["content"], &["output_text"]]).or_else(|| {
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
        }
        None => None,
    }
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

fn set_tool_result(tool_calls: &mut [ToolCall], tool_use_id: &str, output: &str) {
    if let Some(tool) = tool_calls.iter_mut().find(|tool| tool.id == tool_use_id) {
        tool.output = Some(output.to_string());
    }
}

fn process_message_blocks<ChunkFn, ToolUseFn, ToolResultFn>(
    blocks: &[Value],
    content: &mut String,
    content_blocks: &mut Vec<ContentBlock>,
    tool_calls: &mut Vec<ToolCall>,
    on_chunk: &mut ChunkFn,
    on_tool_use: &mut ToolUseFn,
    on_tool_result: &mut ToolResultFn,
) where
    ChunkFn: FnMut(&str),
    ToolUseFn: FnMut(&ParsedToolCall),
    ToolResultFn: FnMut(&str, &str),
{
    for block in blocks {
        if let Some(text) = extract_text_from_block(block) {
            content.push_str(&text);
            push_text_block(content_blocks, &text);
            on_chunk(&text);
            continue;
        }
        if let Some(tool_call) = extract_tool_call_from_block(block) {
            upsert_tool_call(tool_calls, &tool_call);
            ensure_tool_use(content_blocks, &tool_call.id);
            on_tool_use(&tool_call);
            continue;
        }
        if let Some((tool_use_id, output)) = extract_tool_result_from_block(block) {
            set_tool_result(tool_calls, &tool_use_id, &output);
            on_tool_result(&tool_use_id, &output);
        }
    }
}

fn extract_acp_update(value: &Value) -> Option<&Value> {
    value_at_path(value, &["params", "update"])
}

fn extract_acp_session_id(value: &Value) -> Option<String> {
    first_string(
        value,
        &[&["params", "sessionId"], &["result", "_meta", "sessionId"]],
    )
}

fn extract_text_from_acp_content(content: &Value) -> Option<String> {
    // Grok usually sends `{ "type": "text", "text": "..." }`. Accept a bare
    // string too (same as Kimi) so we never drop a space-only or leading-space
    // delta just because the wrapper shape differed.
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if content.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    content
        .get("text")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn extract_acp_tool_call(update: &Value) -> Option<ParsedToolCall> {
    let id = first_string(update, &[&["toolCallId"], &["tool_call_id"]])?;
    if update.get("title").is_none()
        && update.get("kind").is_none()
        && update.get("name").is_none()
        && update.get("rawInput").is_none()
    {
        return None;
    }
    // Prefer structured name/kind when present; title is often a human summary
    // (grep pattern, `Read \`path\``) and is only used as a fallback by normalizer.
    let name = first_string(update, &[&["name"], &["kind"], &["title"]])
        .unwrap_or_else(|| "Tool".to_string());
    let input = update
        .get("rawInput")
        .cloned()
        .or_else(|| update.get("input").cloned())
        .unwrap_or(Value::Null);
    Some(normalize_grok_tool_call(ParsedToolCall { id, name, input }))
}

fn acp_tool_output(update: &Value) -> Option<String> {
    let raw_output = update.get("rawOutput")?;
    if let Some(text) = first_string(
        raw_output,
        &[
            &["output_for_prompt"],
            &["outputForPrompt"],
            &["raw_output"],
            &["rawOutput"],
            &["content"],
            &["text"],
        ],
    ) {
        return Some(text).filter(|text| !text.is_empty());
    }
    if let Some(output) = raw_output.get("output") {
        return value_to_output_text(output);
    }
    value_to_output_text(raw_output)
}

fn value_to_output_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let bytes: Option<Vec<u8>> = items
                .iter()
                .map(|item| item.as_u64().and_then(|number| u8::try_from(number).ok()))
                .collect();
            if let Some(bytes) = bytes {
                String::from_utf8_lossy(&bytes).to_string()
            } else {
                let content_text = items
                    .iter()
                    .filter_map(|item| {
                        item.as_str()
                            .map(ToOwned::to_owned)
                            .or_else(|| extract_text_from_block(item))
                    })
                    .collect::<String>();
                if content_text.is_empty() {
                    value.to_string()
                } else {
                    content_text
                }
            }
        }
        Value::Null => return None,
        other => other.to_string(),
    };
    Some(text).filter(|text| !text.is_empty())
}

fn usage_from_acp_meta(meta: &Value) -> Option<UsageData> {
    let input_tokens = meta
        .get("inputTokens")
        .or_else(|| meta.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = meta
        .get("outputTokens")
        .or_else(|| meta.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read_input_tokens = meta
        .get("cachedReadTokens")
        .or_else(|| meta.get("cache_read_input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input_tokens == 0 && output_tokens == 0 && cache_read_input_tokens == 0 {
        return None;
    }
    Some(UsageData {
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens: 0,
    })
}

fn emit_chunk_raw(app: &AppHandle, session_id: &str, worktree_id: &str, chunk: &str) {
    if chunk.is_empty() {
        return;
    }
    let _ = app.emit_all(
        "chat:chunk",
        &ChunkEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            content: chunk.to_string(),
        },
    );
}

/// Buffer tiny Grok token deltas and release them as larger batches.
///
/// Grok ACP emits word fragments (often with a leading space) at high rate.
/// Emitting every fragment forces a full streaming-markdown reparse per token
/// and has been observed to paint without spaces until the turn settles.
fn push_coalesced_chunk(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    coalescer: &mut ChunkCoalescer,
    chunk: &str,
) {
    if let Some(batch) = coalescer.push(chunk) {
        emit_chunk_raw(app, session_id, worktree_id, &batch);
    }
}

fn flush_coalesced_chunks(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    coalescer: &mut ChunkCoalescer,
) {
    if let Some(batch) = coalescer.flush() {
        emit_chunk_raw(app, session_id, worktree_id, &batch);
    }
}

/// Immediate emit (no coalesce). Prefer [`push_coalesced_chunk`] on hot paths.
fn emit_chunk(app: &AppHandle, session_id: &str, worktree_id: &str, chunk: &str) {
    emit_chunk_raw(app, session_id, worktree_id, chunk);
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

/// Emit `chat:done`. `final_content` is the authoritative assistant text
/// (spaces preserved). Frontend prefers it over streamed accumulation so
/// Grok word-fragment deltas cannot leave a permanently glued message.
fn emit_done(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    waiting_for_plan: bool,
    final_content: Option<&str>,
) {
    let _ = app.emit_all(
        "chat:done",
        &serde_json::json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
            "waiting_for_plan": waiting_for_plan,
            "content": final_content,
        }),
    );
}

fn parse_grok_stream(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    reader: impl BufRead,
    initial_session_id: Option<&str>,
) -> Result<GrokResponse, String> {
    parse_grok_stream_inner_with_callbacks(
        reader,
        initial_session_id,
        |chunk| emit_chunk(app, session_id, worktree_id, chunk),
        |tool_call| emit_tool_use(app, session_id, worktree_id, tool_call),
        |tool_use_id, output| emit_tool_result(app, session_id, worktree_id, tool_use_id, output),
    )
}

fn parse_grok_stream_inner(
    reader: impl BufRead,
    initial_session_id: Option<&str>,
) -> Result<GrokResponse, String> {
    parse_grok_stream_inner_with_callbacks(reader, initial_session_id, |_| {}, |_| {}, |_, _| {})
}

fn parse_grok_stream_inner_with_callbacks<ChunkFn, ToolUseFn, ToolResultFn>(
    reader: impl BufRead,
    initial_session_id: Option<&str>,
    mut on_chunk: ChunkFn,
    mut on_tool_use: ToolUseFn,
    mut on_tool_result: ToolResultFn,
) -> Result<GrokResponse, String>
where
    ChunkFn: FnMut(&str),
    ToolUseFn: FnMut(&ParsedToolCall),
    ToolResultFn: FnMut(&str, &str),
{
    let mut content = String::new();
    let mut content_blocks = Vec::new();
    let mut tool_calls = Vec::new();
    let mut session_id = initial_session_id.unwrap_or_default().to_string();
    let mut usage = None;

    for line in reader.lines() {
        let raw_line = line.map_err(|e| format!("Failed to read Grok CLI output: {e}"))?;
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        log::debug!("[Grok] stream line: {line}");
        let parsed: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                log::debug!("[Grok] skipping non-JSON line: {line}");
                continue;
            }
        };

        // Jean run-log markers (mid-turn steer). Must not fall through to
        // extract_text_delta, which reads any top-level `text` field and would
        // glue the steered prompt into assistant content (e.g. "who are youI'm").
        if parsed.get("type").and_then(Value::as_str) == Some("steered_user_message") {
            if let Some(text) = parsed
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                content_blocks.push(ContentBlock::UserInput {
                    text: text.to_string(),
                });
            }
            continue;
        }

        if let Some(extracted_session_id) = extract_session_id(&parsed) {
            session_id = extracted_session_id;
        }
        if let Some(extracted_session_id) = extract_acp_session_id(&parsed) {
            session_id = extracted_session_id;
        }
        if usage.is_none() {
            usage = extract_usage(&parsed).or_else(|| {
                value_at_path(&parsed, &["result", "_meta"]).and_then(usage_from_acp_meta)
            });
        }

        if let Some(update) = extract_acp_update(&parsed) {
            match update.get("sessionUpdate").and_then(Value::as_str) {
                Some("agent_message_chunk") => {
                    if let Some(text) = update
                        .get("content")
                        .and_then(extract_text_from_acp_content)
                        .filter(|text| !text.is_empty())
                    {
                        content.push_str(&text);
                        push_text_block(&mut content_blocks, &text);
                        on_chunk(&text);
                    }
                }
                Some("tool_call") => {
                    if let Some(tool_call) = extract_acp_tool_call(update) {
                        upsert_tool_call(&mut tool_calls, &tool_call);
                        ensure_tool_use(&mut content_blocks, &tool_call.id);
                        on_tool_use(&tool_call);
                    }
                }
                Some("tool_call_update") => {
                    if let Some(tool_call) = extract_acp_tool_call(update) {
                        upsert_tool_call(&mut tool_calls, &tool_call);
                        ensure_tool_use(&mut content_blocks, &tool_call.id);
                        on_tool_use(&tool_call);
                    }
                    if let (Some(tool_use_id), Some(output)) = (
                        first_string(update, &[&["toolCallId"], &["tool_call_id"]]),
                        acp_tool_output(update),
                    ) {
                        set_tool_result(&mut tool_calls, &tool_use_id, &output);
                        on_tool_result(&tool_use_id, &output);
                    }
                }
                _ => {}
            }
        } else if let Some(blocks) = extract_message_blocks(&parsed) {
            process_message_blocks(
                blocks,
                &mut content,
                &mut content_blocks,
                &mut tool_calls,
                &mut on_chunk,
                &mut on_tool_use,
                &mut on_tool_result,
            );
        } else if let Some(delta) = extract_text_delta(&parsed) {
            content.push_str(&delta);
            push_text_block(&mut content_blocks, &delta);
            on_chunk(&delta);
        }

        let event_type = parsed
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| parsed.get("event").and_then(Value::as_str))
            .unwrap_or("unknown");
        match event_type {
            // Grok streaming-json text deltas: {"type":"text","data":"..."}.
            // extract_text_delta above does not read `data`, so capture it here.
            // `thought` events (reasoning) are intentionally ignored, not appended to content.
            "text" => {
                if let Some(text) = parsed
                    .get("data")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    content.push_str(text);
                    push_text_block(&mut content_blocks, text);
                    on_chunk(text);
                }
            }
            "tool_call" | "tool_use" | "tool" => {
                if let Some(tool_call) = extract_tool_call_event(&parsed) {
                    upsert_tool_call(&mut tool_calls, &tool_call);
                    ensure_tool_use(&mut content_blocks, &tool_call.id);
                    on_tool_use(&tool_call);
                }
            }
            "tool_result" | "tool_output" => {
                if let Some((tool_use_id, output)) = extract_tool_result_event(&parsed) {
                    set_tool_result(&mut tool_calls, &tool_use_id, &output);
                    on_tool_result(&tool_use_id, &output);
                }
            }
            "result" | "complete" | "completion" => {
                if let Some(text) = extract_final_result_text(&parsed) {
                    if content.is_empty() {
                        push_text_block(&mut content_blocks, &text);
                        on_chunk(&text);
                        content = text;
                    }
                }
            }
            _ => {}
        }
    }

    Ok(GrokResponse {
        content,
        session_id,
        tool_calls,
        content_blocks,
        cancelled: false,
        usage,
    })
}

/// True when assistant text looks like a finished plan (not a research preamble).
///
/// Grok plan-mode turns often start with "I'll draft a plan…" then tool research.
/// If those tools fail or the turn ends early, that preamble must NOT become an
/// ExitPlanMode approval gate — only real plan structure should.
fn looks_like_plan_content(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed.chars().count() < 280 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("implementation plan")
        || lower.contains("# plan")
        || trimmed.contains("## ")
        || trimmed.contains("### ")
        || trimmed.contains("- [ ]")
        || trimmed.contains("- [x]")
    {
        return true;
    }
    let structured_lines = trimmed
        .lines()
        .filter(|line| {
            let s = line.trim_start();
            if s.starts_with("- ") || s.starts_with("* ") {
                return true;
            }
            // Numbered steps: "1. " / "12. "
            let mut chars = s.chars();
            let Some(first) = chars.next() else {
                return false;
            };
            if !first.is_ascii_digit() {
                return false;
            }
            let mut saw_digit = true;
            for ch in chars.by_ref() {
                if ch.is_ascii_digit() {
                    saw_digit = true;
                    continue;
                }
                return saw_digit && ch == '.' && chars.next() == Some(' ');
            }
            false
        })
        .count();
    structured_lines >= 4
}

fn inject_synthetic_plan(response: &mut GrokResponse) -> bool {
    if response.content.trim().is_empty()
        || response
            .tool_calls
            .iter()
            .any(|tool| tool.name == GROK_SYNTHETIC_PLAN_TOOL_NAME)
        || !looks_like_plan_content(&response.content)
    {
        return false;
    }
    let id = "grok-plan".to_string();
    response.tool_calls.push(ToolCall {
        id: id.clone(),
        name: GROK_SYNTHETIC_PLAN_TOOL_NAME.to_string(),
        input: serde_json::json!({
            "source": "grok",
            "plan": response.content,
        }),
        output: None,
        parent_tool_use_id: None,
    });
    response
        .content_blocks
        .push(ContentBlock::ToolUse { tool_call_id: id });
    true
}

/// Render the resolved Grok CLI invocation as a copy-pasteable shell command for debug logs.
/// The prompt value (after `-p`/`--prompt`) is redacted so user prompt text / PII never
/// reaches persistent logs.
fn format_grok_command(cli_path: &Path, args: &[String]) -> String {
    fn quote(arg: &str) -> String {
        if arg.is_empty() || arg.contains([' ', '"', '\'', '\n', '\t']) {
            format!("'{}'", arg.replace('\'', "'\\''"))
        } else {
            arg.to_string()
        }
    }
    let mut parts = vec![quote(&cli_path.to_string_lossy())];
    let mut redact_next = false;
    for arg in args {
        if redact_next {
            parts.push("<REDACTED_PROMPT>".to_string());
            redact_next = false;
            continue;
        }
        if arg == "-p" || arg == "--prompt" || arg == "--prompt-file" {
            redact_next = true;
        }
        parts.push(quote(arg));
    }
    parts.join(" ")
}

fn build_grok_args(
    prompt: &str,
    model: Option<&str>,
    execution_mode: Option<&str>,
    effort_level: Option<&str>,
    grok_session_id: Option<&str>,
    working_dir: &str,
) -> Vec<String> {
    let effective_mode = execution_mode.unwrap_or("plan");
    let mut args = vec![
        "--no-auto-update".to_string(),
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "streaming-json".to_string(),
        "--cwd".to_string(),
        working_dir.to_string(),
    ];

    if let Some(id) = grok_session_id.filter(|id| !id.is_empty()) {
        args.push("--resume".to_string());
        args.push(id.to_string());
    }
    if let Some(model) = raw_grok_model(model).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = effort_level.filter(|effort| !effort.is_empty()) {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }

    match effective_mode {
        "build" => {
            args.push("--permission-mode".to_string());
            args.push("acceptEdits".to_string());
            args.push("--sandbox".to_string());
            args.push("workspace".to_string());
        }
        "yolo" => {
            args.push("--permission-mode".to_string());
            args.push("bypassPermissions".to_string());
            args.push("--sandbox".to_string());
            args.push("off".to_string());
            args.push("--always-approve".to_string());
        }
        _ => {
            args.push("--permission-mode".to_string());
            args.push("plan".to_string());
            args.push("--sandbox".to_string());
            args.push("read-only".to_string());
        }
    }
    args
}

fn build_grok_agent_args(
    model: Option<&str>,
    execution_mode: Option<&str>,
    effort_level: Option<&str>,
) -> Vec<String> {
    // Always disable Grok's native plan state for ACP stdio. Native exit_plan_mode
    // requires the TUI approval surface Jean cannot show — leaving it enabled causes
    // plan-mode turns to hang after research. Jean owns plan UX via tool permissions
    // + synthetic ExitPlanMode on structured plan text.
    let mut args = vec!["--no-auto-update".to_string(), "--no-plan".to_string()];
    args.push("agent".to_string());
    args.push("--no-leader".to_string());
    if matches!(execution_mode, Some("build") | Some("yolo")) {
        args.push("--always-approve".to_string());
    }
    if let Some(model) = raw_grok_model(model).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = effort_level.filter(|effort| !effort.is_empty()) {
        args.push("--reasoning-effort".to_string());
        args.push(effort.to_string());
    }
    args.push("stdio".to_string());
    args
}

struct AcpTerminal {
    child: Arc<Mutex<Child>>,
    output: Arc<Mutex<String>>,
    truncated: Arc<AtomicBool>,
    output_limit: usize,
}

/// Grok ACP extension method for mid-turn user text injection.
///
/// Grok agent stdio exposes this as `_x.ai/interject` (underscore-prefixed
/// extension, same family as `_x.ai/settings/update`). Bare `x.ai/interject`
/// returns JSON-RPC -32601 Method not found.
pub(crate) const GROK_ACP_INTERJECT_METHOD: &str = "_x.ai/interject";

/// Stdin + request-id counter shared so mid-turn `_x.ai/interject` can write
/// while the prompt loop holds the connection mutex for reading stdout.
struct GrokAcpWriter {
    stdin: ChildStdin,
    next_request_id: i64,
}

struct GrokAcpConnection {
    child: Child,
    writer: Arc<Mutex<GrokAcpWriter>>,
    reader: BufReader<ChildStdout>,
    stderr: Arc<Mutex<String>>,
    terminals: HashMap<String, AcpTerminal>,
    /// Shared with the steer handle so injectors do not need the connection lock.
    acp_session_id: Arc<Mutex<String>>,
    args: Vec<String>,
    pid: u32,
    in_use: bool,
    last_used: Instant,
}

/// Writer + session id for mid-turn steering without contending on the
/// exclusive connection lock held by `send_grok_acp_prompt`.
#[derive(Clone)]
struct GrokSteerHandle {
    writer: Arc<Mutex<GrokAcpWriter>>,
    acp_session_id: Arc<Mutex<String>>,
}

static GROK_ACP_CONNECTIONS: Lazy<Mutex<HashMap<String, Arc<Mutex<GrokAcpConnection>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

static GROK_ACP_STEER_HANDLES: Lazy<Mutex<HashMap<String, GrokSteerHandle>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const GROK_ACP_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn register_grok_steer_handle(jean_session_id: &str, handle: GrokSteerHandle) {
    if let Ok(mut map) = GROK_ACP_STEER_HANDLES.lock() {
        map.insert(jean_session_id.to_string(), handle);
    }
}

fn unregister_grok_steer_handle(jean_session_id: &str) {
    if let Ok(mut map) = GROK_ACP_STEER_HANDLES.lock() {
        map.remove(jean_session_id);
    }
}

fn grok_acp_session_id(connection: &GrokAcpConnection) -> String {
    connection
        .acp_session_id
        .lock()
        .map(|id| id.clone())
        .unwrap_or_default()
}

fn set_grok_acp_session_id(connection: &GrokAcpConnection, session_id: String) {
    if let Ok(mut id) = connection.acp_session_id.lock() {
        *id = session_id;
    }
}

fn send_acp_request_on_writer(
    writer: &Arc<Mutex<GrokAcpWriter>>,
    method: &str,
    params: Value,
) -> Result<i64, String> {
    let mut writer = writer
        .lock()
        .map_err(|_| "Failed to lock Grok ACP writer".to_string())?;
    let request_id = writer.next_request_id;
    writer.next_request_id += 1;
    send_acp_request(&mut writer.stdin, request_id, method, params)?;
    writer
        .stdin
        .flush()
        .map_err(|e| format!("Failed to flush Grok ACP stdin: {e}"))?;
    Ok(request_id)
}

/// Build params for Grok's mid-turn interjection ACP extension.
pub(crate) fn build_grok_interject_params(
    acp_session_id: &str,
    text: &str,
    interjection_id: &str,
) -> Value {
    serde_json::json!({
        "sessionId": acp_session_id,
        "text": text,
        "interjectionId": interjection_id,
    })
}

/// Inject a text-only user message into a running Grok ACP turn via
/// `_x.ai/interject` (in-process) or the detached host socket (Unix).
/// Fire-and-forget on the wire: the prompt loop ignores non-matching JSON-RPC
/// response ids, and Grok drains interjections at the next safe point.
pub fn inject_grok_interjection(
    // Used only on Unix (detached host socket path); kept in signature for all platforms.
    #[cfg_attr(not(unix), allow(unused_variables))] app: &AppHandle,
    jean_session_id: &str,
    #[cfg_attr(not(unix), allow(unused_variables))] run_id: &str,
    text: &str,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Cannot steer empty message into Grok turn".to_string());
    }
    if !super::registry::is_process_running(jean_session_id) {
        return Err(format!(
            "No active Grok turn for session: {jean_session_id}"
        ));
    }

    // Prefer detached host socket (Unix survivable path).
    #[cfg(unix)]
    {
        if let Ok(app_data) = app.path().app_data_dir() {
            let socket_path = grok_acp_socket_path(&app_data, jean_session_id, run_id);
            if socket_path.exists() {
                let line = serialize_grok_host_command(
                    "interject",
                    Some(text),
                    Some(&format!("interject-{run_id}")),
                );
                send_grok_acp_host_command(&socket_path, &line)?;
                log::info!(
                    "[GrokSteer] host interject session={jean_session_id} run={run_id} text_len={}",
                    text.len()
                );
                return Ok(());
            }
        }
    }

    // In-process ACP connection (Windows / non-host fallback).
    let handle = GROK_ACP_STEER_HANDLES
        .lock()
        .map_err(|_| "Failed to lock Grok ACP steer registry".to_string())?
        .get(jean_session_id)
        .cloned()
        .ok_or_else(|| format!("No Grok ACP connection for session: {jean_session_id}"))?;

    let acp_session_id = handle
        .acp_session_id
        .lock()
        .map_err(|_| "Failed to lock Grok ACP session id".to_string())?
        .clone();
    if acp_session_id.is_empty() {
        return Err(format!(
            "Grok ACP session id not ready for session: {jean_session_id}"
        ));
    }

    let interjection_id = format!(
        "jean-steer-{}-{}",
        jean_session_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let params = build_grok_interject_params(&acp_session_id, text, &interjection_id);
    let request_id = send_acp_request_on_writer(&handle.writer, GROK_ACP_INTERJECT_METHOD, params)?;
    log::info!(
        "[GrokSteer] interject session={jean_session_id} acp_session={acp_session_id} \
         request_id={request_id} method={GROK_ACP_INTERJECT_METHOD} text_len={}",
        text.len()
    );
    Ok(())
}

pub(crate) fn serialize_grok_host_command(
    command_type: &str,
    message: Option<&str>,
    id: Option<&str>,
) -> String {
    let mut value = serde_json::Map::new();
    if let Some(id) = id {
        value.insert("id".to_string(), Value::String(id.to_string()));
    }
    value.insert("type".to_string(), Value::String(command_type.to_string()));
    if let Some(message) = message {
        value.insert("message".to_string(), Value::String(message.to_string()));
    }
    format!("{}\n", Value::Object(value))
}

fn grok_line_is_completion_result(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .is_some_and(|event_type| event_type == "result" || event_type == "complete")
}

#[cfg(unix)]
pub(crate) fn grok_acp_socket_path(app_data_dir: &Path, session_id: &str, run_id: &str) -> PathBuf {
    fn short_id(value: &str) -> String {
        let short = value
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect::<String>();
        if short.is_empty() {
            "x".to_string()
        } else {
            short
        }
    }
    // Keep under macOS Unix socket path limits (~104 bytes).
    app_data_dir.join("grok-acp").join(format!(
        "s{}-r{}.sock",
        short_id(session_id),
        short_id(run_id)
    ))
}

#[cfg(unix)]
fn wait_for_grok_acp_socket(socket_path: &Path, pid: u32) -> Result<(), String> {
    use crate::platform::is_process_alive;

    let started = Instant::now();
    let timeout = Duration::from_secs(60);
    loop {
        if socket_path.exists() {
            return Ok(());
        }
        if !is_process_alive(pid) {
            return Err(format!(
                "Grok ACP host exited before socket appeared at {}",
                socket_path.display()
            ));
        }
        if started.elapsed() > timeout {
            return Err(format!(
                "Timed out waiting for Grok ACP host socket at {}",
                socket_path.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
pub(crate) fn send_grok_acp_host_command(socket_path: &Path, line: &str) -> Result<(), String> {
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket_path)
        .map_err(|e| format!("Failed to connect to Grok ACP host: {e}"))?;
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write Grok ACP host command: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("Failed to flush Grok ACP host command: {e}"))?;
    Ok(())
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn spawn_grok_acp_host(
    app: &AppHandle,
    session_id: &str,
    run_id: &str,
    output_file: &Path,
    working_dir: &Path,
    cli_path: &Path,
    grok_args: &[String],
    existing_grok_session_id: Option<&str>,
    execution_mode: Option<&str>,
    mcp_servers: &[Value],
) -> Result<(u32, PathBuf), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let socket_path = grok_acp_socket_path(&app_data, session_id, run_id);
    if let Some(socket_dir) = socket_path.parent() {
        std::fs::create_dir_all(socket_dir)
            .map_err(|e| format!("Failed to create Grok ACP socket dir: {e}"))?;
    }
    let _ = std::fs::remove_file(&socket_path);

    let log_dir = app_data.join("grok-acp-hosts");
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create Grok ACP host log dir: {e}"))?;
    let log_file = log_dir.join(format!("{session_id}-{run_id}.log"));
    let mcp_file = log_dir.join(format!("{session_id}-{run_id}.mcp.json"));
    std::fs::write(
        &mcp_file,
        serde_json::to_string(mcp_servers).unwrap_or_else(|_| "[]".to_string()),
    )
    .map_err(|e| format!("Failed to write Grok MCP servers file: {e}"))?;
    let exe = std::env::current_exe().map_err(|e| format!("Failed to get Jean executable: {e}"))?;

    let mut args = vec![
        GROK_ACP_HOST_ARG.to_string(),
        "--socket".to_string(),
        socket_path.to_string_lossy().to_string(),
        "--output".to_string(),
        output_file.to_string_lossy().to_string(),
        "--cwd".to_string(),
        working_dir.to_string_lossy().to_string(),
        "--grok-cli".to_string(),
        cli_path.to_string_lossy().to_string(),
        "--mcp-servers-file".to_string(),
        mcp_file.to_string_lossy().to_string(),
    ];
    if let Some(session) = existing_grok_session_id.filter(|id| !id.is_empty()) {
        args.push("--existing-session".to_string());
        args.push(session.to_string());
    }
    if let Some(mode) = execution_mode.filter(|m| !m.is_empty()) {
        args.push("--execution-mode".to_string());
        args.push(mode.to_string());
    }
    for arg in grok_args {
        args.push("--grok-arg".to_string());
        args.push(arg.clone());
    }

    let pid = super::detached::spawn_detached_process(&exe, &args, &log_file, &app_data)?;
    wait_for_grok_acp_socket(&socket_path, pid)?;
    Ok((pid, socket_path))
}

/// Detached Grok ACP host entrypoint (Unix). Owns the Grok CLI ACP child,
/// writes stream JSONL for Jean to tail, and accepts prompt/interject/abort
/// over a local Unix socket so Jean can quit mid-turn and reattach.
#[cfg(unix)]
pub fn run_grok_acp_host_from_args() -> Result<(), String> {
    use crate::platform::silent_command;
    use std::os::unix::net::{UnixListener, UnixStream};

    let mut socket_path: Option<PathBuf> = None;
    let mut output_file: Option<PathBuf> = None;
    let mut cwd: Option<PathBuf> = None;
    let mut grok_cli: Option<PathBuf> = None;
    let mut existing_session: Option<String> = None;
    let mut execution_mode: Option<String> = None;
    let mut mcp_servers_file: Option<PathBuf> = None;
    let mut grok_args: Vec<String> = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket_path = args.next().map(PathBuf::from),
            "--output" => output_file = args.next().map(PathBuf::from),
            "--cwd" => cwd = args.next().map(PathBuf::from),
            "--grok-cli" => grok_cli = args.next().map(PathBuf::from),
            "--existing-session" => existing_session = args.next(),
            "--execution-mode" => execution_mode = args.next(),
            "--mcp-servers-file" => mcp_servers_file = args.next().map(PathBuf::from),
            "--grok-arg" => {
                if let Some(value) = args.next() {
                    grok_args.push(value);
                }
            }
            _ => {}
        }
    }

    let socket_path = socket_path.ok_or("--socket is required")?;
    let output_file = output_file.ok_or("--output is required")?;
    let cwd = cwd.ok_or("--cwd is required")?;
    let grok_cli = grok_cli.ok_or("--grok-cli is required")?;
    let execution_mode = execution_mode.as_deref();
    let mcp_servers: Vec<Value> = mcp_servers_file
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default();

    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Grok ACP socket directory: {e}"))?;
    }
    if let Some(parent) = output_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Grok output directory: {e}"))?;
    }
    let output = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_file)
            .map_err(|e| format!("Failed to open Grok output file: {e}"))?,
    ));

    let mut child = silent_command(&grok_cli)
        .args(&grok_args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Grok ACP child: {e}"))?;

    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture Grok ACP stdin".to_string())?;
    let writer = Arc::new(Mutex::new(GrokAcpWriter {
        stdin: child_stdin,
        next_request_id: 1,
    }));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Grok ACP stdout".to_string())?;

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[grok-acp] {line}");
            }
        });
    }

    // Initialize + authenticate + open/load session before advertising the socket.
    let mut reader = BufReader::new(stdout);
    let mut terminals: HashMap<String, AcpTerminal> = HashMap::new();
    let mut acp_session_id = existing_session.clone().unwrap_or_default();

    let initialize_id = send_acp_request_on_writer(
        &writer,
        "initialize",
        serde_json::json!({
            "protocolVersion": 1,
            "clientCapabilities": grok_client_capabilities(),
        }),
    )?;
    let init_value = host_read_acp_response(
        &writer,
        &mut reader,
        &mut terminals,
        execution_mode,
        initialize_id,
        "initialize",
        &output,
    )?;
    let init = init_value
        .get("result")
        .cloned()
        .ok_or("Grok ACP did not return initialize result".to_string())?;
    let method_id =
        acp_auth_method(&init).ok_or("Run `grok login` first, or set XAI_API_KEY.".to_string())?;

    let auth_id = send_acp_request_on_writer(
        &writer,
        "authenticate",
        serde_json::json!({ "methodId": method_id, "_meta": { "headless": true } }),
    )?;
    let _ = host_read_acp_response(
        &writer,
        &mut reader,
        &mut terminals,
        execution_mode,
        auth_id,
        "authenticate",
        &output,
    )?;

    let (session_method, session_params) =
        match existing_session.as_deref().filter(|s| !s.is_empty()) {
            Some(session_id) => (
                "session/load",
                serde_json::json!({
                    "sessionId": session_id,
                    "cwd": cwd.to_string_lossy(),
                    "mcpServers": mcp_servers,
                }),
            ),
            None => (
                "session/new",
                serde_json::json!({
                    "cwd": cwd.to_string_lossy(),
                    "mcpServers": mcp_servers,
                }),
            ),
        };
    let session_req_id = send_acp_request_on_writer(&writer, session_method, session_params)?;
    let session_value = host_read_acp_response(
        &writer,
        &mut reader,
        &mut terminals,
        execution_mode,
        session_req_id,
        "session",
        &output,
    )?;
    if let Some(session_id) =
        extract_session_id(&session_value).or_else(|| extract_acp_session_id(&session_value))
    {
        acp_session_id = session_id;
    }
    if acp_session_id.is_empty() {
        return Err("Grok ACP did not return a session id".to_string());
    }
    // Persist session id early so crash recovery can resume conversation continuity.
    {
        let marker = serde_json::json!({
            "type": "session",
            "session_id": acp_session_id,
        });
        host_write_output_line(&output, &marker.to_string())?;
    }
    if let Some(path) = mcp_servers_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }

    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)
        .map_err(|e| format!("Failed to bind Grok ACP host socket: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let abort = Arc::new(AtomicBool::new(false));
    let pending_prompt: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let pending_interject: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let listener_stop = stop.clone();
    let listener_abort = abort.clone();
    let listener_prompt = pending_prompt.clone();
    let listener_interject = pending_interject.clone();
    let listener_writer = writer.clone();
    let listener_session = acp_session_id.clone();
    std::thread::spawn(move || {
        fn handle_client(
            stream: UnixStream,
            abort: Arc<AtomicBool>,
            pending_prompt: Arc<Mutex<Option<String>>>,
            pending_interject: Arc<Mutex<Vec<String>>>,
            writer: Arc<Mutex<GrokAcpWriter>>,
            acp_session_id: String,
        ) {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("prompt") => {
                        if let Some(message) = value.get("message").and_then(Value::as_str) {
                            if let Ok(mut slot) = pending_prompt.lock() {
                                *slot = Some(message.to_string());
                            }
                        }
                    }
                    Some("interject") | Some("steer") => {
                        if let Some(message) =
                            value.get("message").and_then(Value::as_str).map(str::trim)
                        {
                            if message.is_empty() {
                                continue;
                            }
                            // Best-effort immediate interject when prompt is already active.
                            let interjection_id = format!(
                                "jean-steer-host-{}",
                                std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_nanos())
                                    .unwrap_or(0)
                            );
                            let params = build_grok_interject_params(
                                &acp_session_id,
                                message,
                                &interjection_id,
                            );
                            if send_acp_request_on_writer(
                                &writer,
                                GROK_ACP_INTERJECT_METHOD,
                                params,
                            )
                            .is_err()
                            {
                                if let Ok(mut queue) = pending_interject.lock() {
                                    queue.push(message.to_string());
                                }
                            }
                        }
                    }
                    Some("abort") => {
                        abort.store(true, Ordering::SeqCst);
                    }
                    _ => {}
                }
            }
        }

        while !listener_stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    if listener_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let abort = listener_abort.clone();
                    let pending_prompt = listener_prompt.clone();
                    let pending_interject = listener_interject.clone();
                    let writer = listener_writer.clone();
                    let session = listener_session.clone();
                    std::thread::spawn(move || {
                        handle_client(
                            stream,
                            abort,
                            pending_prompt,
                            pending_interject,
                            writer,
                            session,
                        )
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    eprintln!("[grok-acp-host] listener error: {e}");
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });

    // Wait for the first prompt command from Jean.
    let prompt_message = loop {
        if abort.load(Ordering::SeqCst) {
            break None;
        }
        if let Ok(mut slot) = pending_prompt.lock() {
            if let Some(message) = slot.take() {
                break Some(message);
            }
        }
        // If Grok died during idle wait, fail fast.
        if child.try_wait().ok().flatten().is_some() {
            return Err("Grok ACP exited before receiving prompt".to_string());
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let Some(prompt_message) = prompt_message else {
        stop.store(true, Ordering::SeqCst);
        let _ = UnixStream::connect(&socket_path);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(&socket_path);
        return Ok(());
    };

    // Drain any interjections queued before prompt started.
    if let Ok(mut queue) = pending_interject.lock() {
        for message in queue.drain(..) {
            let interjection_id = format!(
                "jean-steer-host-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            let params = build_grok_interject_params(&acp_session_id, &message, &interjection_id);
            let _ = send_acp_request_on_writer(&writer, GROK_ACP_INTERJECT_METHOD, params);
        }
    }

    let prompt = build_grok_acp_prompt(&prompt_message)?;
    let prompt_request_id = send_acp_request_on_writer(
        &writer,
        "session/prompt",
        serde_json::json!({
            "sessionId": acp_session_id,
            "prompt": prompt,
        }),
    )?;

    let mut line = String::new();
    let mut completed = false;
    loop {
        if abort.load(Ordering::SeqCst) {
            break;
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("Failed to read Grok ACP prompt stream: {e}")),
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(session_id) = extract_acp_session_id(&value) {
            acp_session_id = session_id;
        }
        if value.get("method").is_some() && value.get("id").is_some() {
            // Client requests (fs/terminal/permission) — handle, don't persist.
            // Do not abort the whole turn if one client request fails; Grok will
            // otherwise hang waiting for a JSON-RPC response that never arrives.
            let mut writer_guard = writer
                .lock()
                .map_err(|_| "Failed to lock Grok ACP writer".to_string())?;
            if let Err(error) = handle_acp_client_request(
                &mut writer_guard.stdin,
                &value,
                &mut terminals,
                execution_mode,
            ) {
                eprintln!("[grok-acp-host] client request failed: {error}");
                if let Some(id) = value.get("id") {
                    let _ = send_acp_error(
                        &mut writer_guard.stdin,
                        id,
                        &format!("Jean ACP client error: {error}"),
                    );
                }
            }
            continue;
        }
        if grok_host_line_should_persist(trimmed) {
            host_write_output_line(&output, trimmed)?;
        }
        // Surface errors for fire-and-forget requests (e.g. interject) that are
        // not the main session/prompt response — otherwise Method not found
        // style failures look like a successful steer in Jean.
        if let Some(resp_id) = value.get("id").and_then(Value::as_i64) {
            if resp_id != prompt_request_id {
                if let Some(error) = value.get("error") {
                    eprintln!("[grok-acp-host] non-prompt JSON-RPC error id={resp_id}: {error}");
                }
            }
        }
        if value.get("id").and_then(Value::as_i64) == Some(prompt_request_id) {
            if let Some(error) = value.get("error") {
                let err_line = serde_json::json!({
                    "type": "error",
                    "error": error,
                    "session_id": acp_session_id,
                });
                host_write_output_line(&output, &err_line.to_string())?;
            }
            completed = true;
            break;
        }
    }

    if completed {
        let result = serde_json::json!({
            "type": "result",
            "session_id": acp_session_id,
        });
        host_write_output_line(&output, &result.to_string())?;
    }

    stop.store(true, Ordering::SeqCst);
    let _ = UnixStream::connect(&socket_path);
    for (_, terminal) in terminals.drain() {
        if let Ok(mut child) = terminal.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&socket_path);
    Ok(())
}

#[cfg(not(unix))]
pub fn run_grok_acp_host_from_args() -> Result<(), String> {
    Err("Grok ACP host is only supported on Unix-like systems".to_string())
}

#[cfg(unix)]
fn host_write_output_line(output: &Arc<Mutex<std::fs::File>>, line: &str) -> Result<(), String> {
    let mut out = output
        .lock()
        .map_err(|_| "Grok output file lock poisoned".to_string())?;
    writeln!(out, "{line}").map_err(|e| format!("Failed to write Grok output: {e}"))?;
    out.flush()
        .map_err(|e| format!("Failed to flush Grok output: {e}"))?;
    Ok(())
}

/// Whether an ACP stdout line is useful for Jean's run log / history.
/// Skip JSON-RPC request/response chatter (numeric ids can be mistaken for session ids).
#[cfg(unix)]
fn grok_host_line_should_persist(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("session" | "result" | "error") => return true,
        _ => {}
    }
    // session/update notifications (streaming text + tools)
    value.get("method").and_then(Value::as_str) == Some("session/update")
}

#[cfg(unix)]
fn host_read_acp_response(
    writer: &Arc<Mutex<GrokAcpWriter>>,
    reader: &mut BufReader<ChildStdout>,
    terminals: &mut HashMap<String, AcpTerminal>,
    execution_mode: Option<&str>,
    request_id: i64,
    context: &str,
    _output: &Arc<Mutex<std::fs::File>>,
) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read Grok ACP {context} response: {e}"))?
            == 0
        {
            return Err(format!("Grok ACP exited before {context} completed"));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Do not persist init/auth JSON-RPC chatter — only the explicit session
        // marker written after session/new|load, plus stream updates during prompt.
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("method").is_some()
            && value.get("id").is_some()
            && value.get("id").and_then(Value::as_i64) != Some(request_id)
        {
            let mut writer_guard = writer
                .lock()
                .map_err(|_| "Failed to lock Grok ACP writer".to_string())?;
            if let Err(error) = handle_acp_client_request(
                &mut writer_guard.stdin,
                &value,
                terminals,
                execution_mode,
            ) {
                log::warn!("[Grok ACP] client request failed during {context}: {error}");
                if let Some(id) = value.get("id") {
                    let _ = send_acp_error(
                        &mut writer_guard.stdin,
                        id,
                        &format!("Jean ACP client error: {error}"),
                    );
                }
            }
            continue;
        }
        if value.get("id").and_then(Value::as_i64) == Some(request_id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Grok ACP {context} failed: {error}"));
            }
            return Ok(value);
        }
    }
}

/// Tail a detached Grok ACP host JSONL run log and emit live chat events.
pub fn tail_grok_output(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    output_file: &Path,
    pid: u32,
) -> Result<GrokResponse, String> {
    use super::tail::{next_poll_interval, NdjsonTailer};
    use crate::platform::is_process_alive;

    let mut tailer = NdjsonTailer::new_from_start(output_file)?;
    let mut response = GrokResponse {
        content: String::new(),
        session_id: String::new(),
        tool_calls: Vec::new(),
        content_blocks: Vec::new(),
        cancelled: false,
        usage: None,
    };
    let started_at = Instant::now();
    let startup_timeout = Duration::from_secs(120);
    let dead_process_timeout = Duration::from_secs(2);
    let mut last_output_at = Instant::now();
    let mut received_output = false;
    let mut completed = false;
    let mut cancelled = false;
    let mut known_tool_outputs: HashMap<String, Option<String>> = HashMap::new();
    // Batch tiny token deltas (~30ms) so streaming markdown re-parses less often
    // and leading spaces between word fragments stay mid-string in each batch.
    let mut chunk_coalescer = ChunkCoalescer::new();

    loop {
        let lines = tailer.poll()?;
        let got_lines = !lines.is_empty();
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            if grok_line_is_completion_result(&line) {
                completed = true;
            }

            // Each host line is independent ACP JSON. Parse one line so we only
            // emit that line's deltas (no full-buffer reparse).
            let line_reader = BufReader::new(line.as_bytes());
            let session_hint = if response.session_id.is_empty() {
                None
            } else {
                Some(response.session_id.as_str())
            };
            match parse_grok_stream_inner(line_reader, session_hint) {
                Ok(partial) => {
                    if !partial.session_id.is_empty() {
                        response.session_id = partial.session_id;
                    }
                    if let Some(usage) = partial.usage {
                        response.usage = Some(usage);
                    }
                    // Preserve mid-turn steered prompts in block order. Live UI
                    // already gets `chat:steered` from steer_grok_turn; this keeps
                    // content_blocks correct for finalization/history rebuild.
                    for block in &partial.content_blocks {
                        if let ContentBlock::UserInput { text } = block {
                            response
                                .content_blocks
                                .push(ContentBlock::UserInput { text: text.clone() });
                        }
                    }
                    if !partial.content.is_empty() {
                        response.content.push_str(&partial.content);
                        push_text_block(&mut response.content_blocks, &partial.content);
                        push_coalesced_chunk(
                            app,
                            session_id,
                            worktree_id,
                            &mut chunk_coalescer,
                            &partial.content,
                        );
                    }
                    for tool in partial.tool_calls {
                        let parsed = ParsedToolCall {
                            id: tool.id.clone(),
                            name: tool.name.clone(),
                            input: tool.input.clone(),
                        };
                        let is_new = !known_tool_outputs.contains_key(&tool.id);
                        let previous = known_tool_outputs.get(&tool.id).cloned().flatten();
                        let output_changed = tool.output != previous;
                        if is_new || output_changed {
                            // Flush text before tool events so UI order is stable.
                            flush_coalesced_chunks(
                                app,
                                session_id,
                                worktree_id,
                                &mut chunk_coalescer,
                            );
                            upsert_tool_call(&mut response.tool_calls, &parsed);
                            ensure_tool_use(&mut response.content_blocks, &tool.id);
                            if is_new {
                                emit_tool_use(app, session_id, worktree_id, &parsed);
                            } else if tool.output.is_none() {
                                // Updated input without result — refresh tool use UI.
                                emit_tool_use(app, session_id, worktree_id, &parsed);
                            }
                            if let Some(output) = &tool.output {
                                set_tool_result(&mut response.tool_calls, &tool.id, output);
                                emit_tool_result(app, session_id, worktree_id, &tool.id, output);
                            }
                            known_tool_outputs.insert(tool.id, tool.output);
                        }
                    }
                }
                Err(e) => {
                    log::debug!("[Grok tail] skipped line parse error: {e}");
                }
            }
            received_output = true;
            last_output_at = Instant::now();
        }

        // Release buffered text when the coalesce window elapses, even if no
        // new lines arrived (idle mid-sentence).
        if let Some(deadline) = chunk_coalescer.deadline() {
            if Instant::now() >= deadline {
                flush_coalesced_chunks(app, session_id, worktree_id, &mut chunk_coalescer);
            }
        }

        if completed {
            break;
        }

        let process_alive = is_process_alive(pid);
        if !process_alive {
            if !received_output && started_at.elapsed() > startup_timeout {
                cancelled = true;
                break;
            }
            if received_output && last_output_at.elapsed() > dead_process_timeout {
                cancelled = true;
                break;
            }
        }

        let quiet_for = last_output_at.elapsed();
        let mut sleep_for = next_poll_interval(got_lines, quiet_for);
        if let Some(deadline) = chunk_coalescer.deadline() {
            let until_flush = deadline.saturating_duration_since(Instant::now());
            if until_flush < sleep_for {
                sleep_for = until_flush;
            }
        }
        std::thread::sleep(sleep_for);
    }

    flush_coalesced_chunks(app, session_id, worktree_id, &mut chunk_coalescer);
    response.cancelled = cancelled && !completed;
    response.content = response.content.trim().to_string();
    if !response.cancelled {
        // Plan-mode synthetic tool injection happens in execute_grok after tail.
        // Pass authoritative content so the UI can replace any space-glued
        // streaming accumulation (Grok emits leading-space word fragments).
        let final_content = (!response.content.is_empty()).then_some(response.content.as_str());
        emit_done(app, session_id, worktree_id, false, final_content);
    }
    Ok(response)
}

pub(crate) fn parse_grok_run_to_message(
    lines: &[String],
    run: &RunEntry,
) -> Result<ChatMessage, String> {
    let joined = lines.join("\n");
    let mut response = parse_grok_stream_inner(BufReader::new(joined.as_bytes()), None)?;
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

fn should_keep_grok_acp_connection_alive(
    last_used: Instant,
    in_use: bool,
    now: Instant,
    timeout: Duration,
) -> bool {
    in_use || now.duration_since(last_used) < timeout
}

fn append_terminal_output(
    output: &Arc<Mutex<String>>,
    truncated: &Arc<AtomicBool>,
    output_limit: usize,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    let Ok(mut output) = output.lock() else {
        return;
    };
    output.push_str(text);
    while output.len() > output_limit {
        output.remove(0);
        truncated.store(true, Ordering::Relaxed);
    }
}

fn spawn_terminal_reader(
    mut reader: impl Read + Send + 'static,
    output: Arc<Mutex<String>>,
    truncated: Arc<AtomicBool>,
    output_limit: usize,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buffer[..n]);
                    append_terminal_output(&output, &truncated, output_limit, &text);
                }
            }
        }
    });
}

fn exit_status_json(status: ExitStatus) -> Value {
    serde_json::json!({
        "exitCode": status.code(),
        "signal": null,
    })
}

fn send_acp_message(stdin: &mut impl std::io::Write, value: &Value) -> Result<(), String> {
    writeln!(stdin, "{value}").map_err(|e| format!("Failed to write Grok ACP message: {e}"))
}

fn send_acp_request(
    stdin: &mut impl std::io::Write,
    id: i64,
    method: &str,
    params: Value,
) -> Result<(), String> {
    send_acp_message(
        stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }),
    )
}

fn send_acp_response(
    stdin: &mut impl std::io::Write,
    id: &Value,
    result: Value,
) -> Result<(), String> {
    send_acp_message(
        stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }),
    )
}

fn send_acp_error(
    stdin: &mut impl std::io::Write,
    id: &Value,
    message: &str,
) -> Result<(), String> {
    send_acp_message(
        stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32000,
                "message": message,
            },
        }),
    )
}

fn acp_auth_method(init: &Value) -> Option<String> {
    let methods = init
        .get("authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ids = methods
        .iter()
        .filter_map(|method| method.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if std::env::var("XAI_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        && ids.contains(&"xai.api_key")
    {
        return Some("xai.api_key".to_string());
    }
    if ids.contains(&"cached_token") {
        return Some("cached_token".to_string());
    }
    None
}

fn selected_permission_option(params: &Value, allow: bool) -> Option<String> {
    let preferred = if allow {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };
    let options = params.get("options").and_then(Value::as_array)?;
    if let Some(id) = preferred.iter().find_map(|kind| {
        options
            .iter()
            .find(|option| option.get("kind").and_then(Value::as_str) == Some(*kind))
            .and_then(|option| option.get("optionId").and_then(Value::as_str))
            .map(ToOwned::to_owned)
    }) {
        return Some(id);
    }

    // Fallback: Grok occasionally omits standard kind values. Matching by prefix
    // avoids returning no option (JSON-RPC error), which can hang the agent tool loop.
    let prefixes: &[&str] = if allow {
        &["allow"]
    } else {
        &["reject", "deny"]
    };
    options.iter().find_map(|option| {
        let kind = option
            .get("kind")
            .and_then(Value::as_str)?
            .to_ascii_lowercase();
        if prefixes.iter().any(|prefix| kind.starts_with(prefix)) {
            option
                .get("optionId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        } else {
            None
        }
    })
}

fn is_plan_execution_mode(execution_mode: Option<&str>) -> bool {
    matches!(execution_mode, Some("plan") | None)
}

/// Whether a Grok tool name mutates the workspace / plan state (blocked in plan mode).
fn is_plan_mutating_tool_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "write"
            | "write_file"
            | "writefile"
            | "create_file"
            | "search_replace"
            | "str_replace"
            | "strreplace"
            | "edit"
            | "edit_file"
            | "editfile"
            | "delete"
            | "delete_file"
            | "deletefile"
            | "move"
            | "rename"
            | "apply_patch"
            | "applypatch"
            | "multi_edit"
            | "multiedit"
            | "enter_plan_mode"
            | "enterplanmode"
            | "exit_plan_mode"
            | "exitplanmode"
    ) || matches!(
        map_grok_tool_name(name),
        Some("Write" | "Edit" | "Delete" | "EnterPlanMode" | "ExitPlanMode")
    )
}

fn tool_call_name_candidates(tool_call: &Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(meta) = tool_call.get("_meta").and_then(|m| m.get("x.ai/tool")) {
        if let Some(name) = meta.get("name").and_then(Value::as_str) {
            names.push(name.to_string());
        }
        if let Some(kind) = meta.get("kind").and_then(Value::as_str) {
            names.push(kind.to_string());
        }
    }
    if let Some(variant) = tool_call
        .get("rawInput")
        .or_else(|| tool_call.get("raw_input"))
        .and_then(|input| {
            input
                .get("variant")
                .or_else(|| input.get("name"))
                .and_then(Value::as_str)
        })
    {
        names.push(variant.to_string());
    }
    if let Some(title) = tool_call.get("title").and_then(Value::as_str) {
        names.push(title.to_string());
        if let Some(inferred) = infer_name_from_title(title) {
            names.push(inferred.to_string());
        }
    }
    names
}

/// Plan mode auto-approves research tools (read/search/fetch/shell/tasks) so
/// investigations can run. Mutating file tools stay rejected; `fs/write` is also
/// hard-blocked below. Shell is allowed because Grok investigations rely on
/// `run_terminal_command` (`gh`, `git`, `rg`, `find`); rejecting it made turns
/// stop after "I'll investigate…".
fn plan_mode_permission_allowed(tool_call: Option<&Value>) -> bool {
    let Some(tool_call) = tool_call else {
        // Missing toolCall metadata should not stall research; write path is
        // still hard-blocked via fs/write_text_file.
        return true;
    };

    if let Some(kind) = tool_call.get("kind").and_then(Value::as_str) {
        match kind {
            "edit" | "delete" | "move" | "switch_mode" => return false,
            "read" | "search" | "think" | "fetch" | "execute" => return true,
            _ => {}
        }
    }

    // Explicit read_only meta always wins for allow.
    if let Some(meta) = tool_call.get("_meta").and_then(|m| m.get("x.ai/tool")) {
        if meta.get("read_only").and_then(Value::as_bool) == Some(true) {
            return true;
        }
        if meta.get("read_only").and_then(Value::as_bool) == Some(false) {
            if let Some(name) = meta.get("name").and_then(Value::as_str) {
                if is_plan_mutating_tool_name(name) {
                    return false;
                }
            }
        }
    }

    for name in tool_call_name_candidates(tool_call) {
        if is_plan_mutating_tool_name(&name) {
            return false;
        }
    }

    // Default allow: Task/subagent, search_tool, shell (if kind missing), etc.
    true
}

/// Build/yolo auto-approve every tool permission. Plan mode blocks file
/// mutations only (see [`plan_mode_permission_allowed`]).
fn should_allow_acp_permission(execution_mode: Option<&str>, params: &Value) -> bool {
    if !is_plan_execution_mode(execution_mode) {
        return true;
    }
    let tool_call = params.get("toolCall").or_else(|| params.get("tool_call"));
    plan_mode_permission_allowed(tool_call)
}

fn handle_acp_client_request(
    stdin: &mut impl std::io::Write,
    request: &Value,
    terminals: &mut HashMap<String, AcpTerminal>,
    execution_mode: Option<&str>,
) -> Result<(), String> {
    let Some(id) = request.get("id") else {
        return Ok(());
    };
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "session/request_permission" => {
            let allow = should_allow_acp_permission(execution_mode, &params);
            let kind = params
                .get("toolCall")
                .or_else(|| params.get("tool_call"))
                .and_then(|tc| tc.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let title = params
                .get("toolCall")
                .or_else(|| params.get("tool_call"))
                .and_then(|tc| tc.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("");
            log::info!(
                "[Grok ACP] request_permission allow={allow} mode={execution_mode:?} kind={kind} title={title}"
            );
            let Some(option_id) = selected_permission_option(&params, allow) else {
                return send_acp_error(stdin, id, "No matching permission option");
            };
            send_acp_response(
                stdin,
                id,
                serde_json::json!({
                    "outcome": {
                        "outcome": "selected",
                        "optionId": option_id,
                    }
                }),
            )
        }
        "terminal/create" => {
            // Plan mode allows shell for research (gh/git/rg/find). File mutations
            // stay blocked via permission deny-list + fs/write_text_file below.
            let Some(command) = params.get("command").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminal command");
            };
            let terminal_id = format!("grok-terminal-{}", terminals.len() + 1);
            let cwd = params.get("cwd").and_then(Value::as_str);
            let output_limit = params
                .get("outputByteLimit")
                .and_then(Value::as_u64)
                .unwrap_or(20_000)
                .clamp(1024, 200_000) as usize;

            #[cfg(windows)]
            let mut command_builder = {
                let mut cmd = crate::platform::silent_command("cmd");
                cmd.args(["/C", command]);
                cmd
            };
            #[cfg(not(windows))]
            let mut command_builder = {
                let mut cmd = crate::platform::silent_command("sh");
                cmd.args(["-lc", command]);
                cmd
            };
            if let Some(cwd) = cwd {
                command_builder.current_dir(cwd);
            }
            if let Some(env) = params.get("env").and_then(Value::as_array) {
                for entry in env {
                    if let (Some(name), Some(value)) = (
                        entry.get("name").and_then(Value::as_str),
                        entry.get("value").and_then(Value::as_str),
                    ) {
                        command_builder.env(name, value);
                    }
                }
            }
            let mut child = command_builder
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn Grok ACP terminal command: {e}"))?;
            let output = Arc::new(Mutex::new(String::new()));
            let truncated = Arc::new(AtomicBool::new(false));
            if let Some(stdout) = child.stdout.take() {
                spawn_terminal_reader(stdout, output.clone(), truncated.clone(), output_limit);
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_terminal_reader(stderr, output.clone(), truncated.clone(), output_limit);
            }
            terminals.insert(
                terminal_id.clone(),
                AcpTerminal {
                    child: Arc::new(Mutex::new(child)),
                    output,
                    truncated,
                    output_limit,
                },
            );
            send_acp_response(stdin, id, serde_json::json!({ "terminalId": terminal_id }))
        }
        "terminal/output" => {
            let Some(terminal_id) = params.get("terminalId").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminalId");
            };
            let Some(terminal) = terminals.get(terminal_id) else {
                return send_acp_error(stdin, id, "Unknown terminalId");
            };
            let exit_status = terminal
                .child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok().flatten())
                .map(exit_status_json);
            let output = terminal
                .output
                .lock()
                .map(|output| output.clone())
                .unwrap_or_default();
            send_acp_response(
                stdin,
                id,
                serde_json::json!({
                    "output": output,
                    "truncated": terminal.truncated.load(Ordering::Relaxed),
                    "exitStatus": exit_status,
                }),
            )
        }
        "terminal/wait_for_exit" => {
            let Some(terminal_id) = params.get("terminalId").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminalId");
            };
            let Some(terminal) = terminals.get(terminal_id) else {
                return send_acp_error(stdin, id, "Unknown terminalId");
            };
            let status = terminal
                .child
                .lock()
                .map_err(|_| "Failed to lock terminal process".to_string())?
                .wait()
                .map_err(|e| format!("Failed to wait for terminal: {e}"))?;
            send_acp_response(stdin, id, exit_status_json(status))
        }
        "terminal/kill" => {
            let Some(terminal_id) = params.get("terminalId").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminalId");
            };
            if let Some(terminal) = terminals.get(terminal_id) {
                if let Ok(mut child) = terminal.child.lock() {
                    let _ = child.kill();
                }
            }
            send_acp_response(stdin, id, serde_json::json!({}))
        }
        "terminal/release" => {
            let Some(terminal_id) = params.get("terminalId").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing terminalId");
            };
            if let Some(terminal) = terminals.remove(terminal_id) {
                if let Ok(mut child) = terminal.child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            send_acp_response(stdin, id, serde_json::json!({}))
        }
        "fs/read_text_file" | "fs/readTextFile" => {
            let Some(path) = params.get("path").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing path");
            };
            let content = match std::fs::read_to_string(path) {
                Ok(content) => content,
                Err(error) => {
                    return send_acp_error(
                        stdin,
                        id,
                        &format!("Failed to read Grok ACP file {path}: {error}"),
                    );
                }
            };
            let line = params.get("line").and_then(Value::as_u64).unwrap_or(1);
            let limit = params.get("limit").and_then(Value::as_u64);
            let selected = if line > 1 || limit.is_some() {
                let start = line.saturating_sub(1) as usize;
                let iter = content.lines().skip(start);
                match limit {
                    Some(limit) => iter.take(limit as usize).collect::<Vec<_>>().join("\n"),
                    None => iter.collect::<Vec<_>>().join("\n"),
                }
            } else {
                content
            };
            send_acp_response(stdin, id, serde_json::json!({ "content": selected }))
        }
        "fs/write_text_file" | "fs/writeTextFile" => {
            if is_plan_execution_mode(execution_mode) {
                return send_acp_error(stdin, id, "File writes are disabled in plan mode");
            }
            let Some(path) = params.get("path").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing path");
            };
            let Some(content) = params.get("content").and_then(Value::as_str) else {
                return send_acp_error(stdin, id, "Missing content");
            };
            std::fs::write(path, content)
                .map_err(|e| format!("Failed to write Grok ACP file {path}: {e}"))?;
            send_acp_response(stdin, id, serde_json::json!({}))
        }
        _ => send_acp_error(
            stdin,
            id,
            &format!("Unsupported Grok ACP request: {method}"),
        ),
    }
}

fn grok_execution_mode_instruction(execution_mode: Option<&str>) -> Option<&'static str> {
    match execution_mode.unwrap_or("plan") {
        "build" => Some(
            "You are in BUILD MODE. Start implementing immediately. \
             This instruction supersedes any earlier plan-mode state or instructions. \
             Do not call enter_plan_mode or exit_plan_mode unless the user explicitly asks \
             for a new plan. Ask the user directly if a required decision is missing.",
        ),
        "yolo" => Some(
            "You are in YOLO EXECUTION MODE. Start implementing immediately. \
             This instruction supersedes any earlier plan-mode state or instructions. \
             Do not call enter_plan_mode or exit_plan_mode unless the user explicitly asks \
             for a new plan. Do not ask for confirmation before routine implementation steps. \
             Ask the user directly if a required decision is missing.",
        ),
        // Plan mode must allow research shell: Grok investigations often start with
        // run_terminal_command (gh/git/rg). Rejecting shell made turns stop after
        // "I'll investigate…". File writes stay blocked; Jean owns plan approval UI.
        _ => Some(
            "You are in PLAN MODE (research only — do not implement). Investigate with \
             read/search/list/fetch tools and shell commands as needed (e.g. git status, \
             gh, rg, find, cat, ls). Do NOT edit or write files, apply patches, or make \
             irreversible changes. Do not call enter_plan_mode / exit_plan_mode — Jean \
             owns plan approval. When research is enough, finish the turn by writing a \
             complete structured implementation plan as markdown with a clear title \
             (e.g. \"# … Implementation Plan\"), section headings (##), and concrete task \
             steps (numbered or checkbox lists). Do not implement the work in this mode.",
        ),
    }
}

fn build_grok_message(
    message: &str,
    system_prompt: Option<&str>,
    execution_mode: Option<&str>,
) -> String {
    let mut instructions = system_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .map(|prompt| vec![prompt.to_string()])
        .unwrap_or_default();
    if let Some(mode_instruction) = grok_execution_mode_instruction(execution_mode) {
        instructions.push(mode_instruction.to_string());
    }

    if instructions.is_empty() {
        message.to_string()
    } else {
        format!(
            "<system_instructions>\n{}\n</system_instructions>\n\n{message}",
            instructions.join("\n\n")
        )
    }
}

pub struct GrokExecutionOptions<'a> {
    pub app: &'a AppHandle,
    pub jean_session_id: &'a str,
    pub worktree_id: &'a str,
    pub working_dir: &'a Path,
    /// Run log path the detached host writes ACP JSONL into (Unix host path).
    pub output_file: &'a Path,
    pub existing_grok_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub execution_mode: Option<&'a str>,
    pub effort_level: Option<&'a str>,
    pub message: &'a str,
    pub system_prompt: Option<&'a str>,
    /// Jean `{ "mcpServers": { name: config } }` JSON — converted to ACP `mcpServers`.
    pub mcp_config: Option<&'a str>,
    pub pid_callback: Option<Box<dyn FnOnce(u32) + Send>>,
}

/// Restores `~/.grok/config.toml` `disabled_mcp_servers` after a Jean Grok turn.
struct GrokDisabledRestoreGuard {
    /// `None` means sync never succeeded — do not touch the user's config on drop.
    previous: Option<Option<Vec<String>>>,
}

impl Drop for GrokDisabledRestoreGuard {
    fn drop(&mut self) {
        let Some(previous) = self.previous.take() else {
            return;
        };
        if let Err(e) = crate::grok_cli::mcp::restore_disabled_list(previous) {
            log::warn!("[Grok MCP] failed to restore disabled_mcp_servers: {e}");
        }
    }
}

fn read_acp_response(
    connection: &mut GrokAcpConnection,
    request_id: i64,
    execution_mode: Option<&str>,
    context: &str,
) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        if connection
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read Grok ACP {context} response: {e}"))?
            == 0
        {
            return Err(format!("Grok ACP exited before {context} completed"));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("method").is_some()
            && value.get("id").is_some()
            && value.get("id").and_then(Value::as_i64) != Some(request_id)
        {
            let mut writer = connection
                .writer
                .lock()
                .map_err(|_| "Failed to lock Grok ACP writer".to_string())?;
            if let Err(error) = handle_acp_client_request(
                &mut writer.stdin,
                &value,
                &mut connection.terminals,
                execution_mode,
            ) {
                log::warn!("[Grok ACP] client request failed during {context}: {error}");
                if let Some(id) = value.get("id") {
                    let _ = send_acp_error(
                        &mut writer.stdin,
                        id,
                        &format!("Jean ACP client error: {error}"),
                    );
                }
            }
            continue;
        }
        if value.get("id").and_then(Value::as_i64) == Some(request_id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Grok ACP {context} failed: {error}"));
            }
            return Ok(value);
        }
    }
}

fn spawn_grok_acp_connection(
    cli_path: &Path,
    args: Vec<String>,
    jean_session_id: &str,
    worktree_id: &str,
    working_dir: &Path,
    existing_grok_session_id: Option<&str>,
    execution_mode: Option<&str>,
    mcp_servers: &[Value],
) -> Result<GrokAcpConnection, String> {
    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), Some(working_dir));
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.env("JEAN_SESSION_ID", jean_session_id);
    cmd.env("JEAN_WORKTREE_ID", worktree_id);
    let (depth_key, depth_val) = super::jean_mcp::child_depth_env();
    cmd.env(depth_key, depth_val);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Grok CLI: {e}"))?;
    let pid = child.id();
    log::info!("[Grok ACP] spawned pid={pid}");
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture Grok CLI stdout".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or("Failed to open Grok CLI stdin".to_string())?;
    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(mut child_stderr) = child.stderr.take() {
        let stderr = stderr.clone();
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = child_stderr.read_to_string(&mut buf);
            if let Ok(mut stderr) = stderr.lock() {
                stderr.push_str(&buf);
            }
        });
    }

    let writer = Arc::new(Mutex::new(GrokAcpWriter {
        stdin,
        next_request_id: 1,
    }));
    let acp_session_id = Arc::new(Mutex::new(
        existing_grok_session_id.unwrap_or_default().to_string(),
    ));
    let mut connection = GrokAcpConnection {
        child,
        writer: writer.clone(),
        reader: BufReader::new(stdout),
        stderr,
        terminals: HashMap::new(),
        acp_session_id: acp_session_id.clone(),
        args,
        pid,
        in_use: true,
        last_used: Instant::now(),
    };

    let initialize_id = send_acp_request_on_writer(
        &connection.writer,
        "initialize",
        serde_json::json!({
            "protocolVersion": 1,
            "clientCapabilities": grok_client_capabilities(),
        }),
    )?;
    let init_value =
        read_acp_response(&mut connection, initialize_id, execution_mode, "initialize")?;
    let init = init_value
        .get("result")
        .cloned()
        .ok_or("Grok ACP did not return initialize result".to_string())?;
    let method_id =
        acp_auth_method(&init).ok_or("Run `grok login` first, or set XAI_API_KEY.".to_string())?;

    let auth_id = send_acp_request_on_writer(
        &connection.writer,
        "authenticate",
        serde_json::json!({ "methodId": method_id, "_meta": { "headless": true } }),
    )?;
    let _ = read_acp_response(&mut connection, auth_id, execution_mode, "authenticate")?;

    let (session_method, session_params) = match existing_grok_session_id {
        Some(session_id) => (
            "session/load",
            serde_json::json!({
                "sessionId": session_id,
                "cwd": working_dir.to_string_lossy(),
                "mcpServers": mcp_servers,
            }),
        ),
        None => (
            "session/new",
            serde_json::json!({
                "cwd": working_dir.to_string_lossy(),
                "mcpServers": mcp_servers,
            }),
        ),
    };
    let session_req_id =
        send_acp_request_on_writer(&connection.writer, session_method, session_params)?;
    let session_value =
        read_acp_response(&mut connection, session_req_id, execution_mode, "session")?;
    if let Some(session_id) = extract_session_id(&session_value) {
        set_grok_acp_session_id(&connection, session_id);
    }
    if grok_acp_session_id(&connection).is_empty() {
        return Err("Grok ACP did not return a session id".to_string());
    }

    // Publish steer handle only after the ACP session is ready.
    register_grok_steer_handle(
        jean_session_id,
        GrokSteerHandle {
            writer,
            acp_session_id,
        },
    );

    Ok(connection)
}

fn grok_client_capabilities() -> Value {
    // Grok and Jean run on the same machine. Advertising ACP client filesystem
    // support makes Grok proxy binary image reads through the text-only
    // fs/read_text_file method, corrupting its own session assets.
    serde_json::json!({ "terminal": true })
}

fn kill_grok_acp_connection(connection: &mut GrokAcpConnection) {
    for (_, terminal) in connection.terminals.drain() {
        if let Ok(mut child) = terminal.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let _ = connection.child.kill();
    let _ = connection.child.wait();
}

fn schedule_grok_acp_idle_cleanup(key: String, connection: Arc<Mutex<GrokAcpConnection>>) {
    std::thread::spawn(move || {
        std::thread::sleep(GROK_ACP_IDLE_TIMEOUT);
        let should_remove = connection
            .lock()
            .map(|conn| {
                !should_keep_grok_acp_connection_alive(
                    conn.last_used,
                    conn.in_use,
                    Instant::now(),
                    GROK_ACP_IDLE_TIMEOUT,
                )
            })
            .unwrap_or(true);
        if !should_remove {
            return;
        }
        let Ok(mut registry) = GROK_ACP_CONNECTIONS.lock() else {
            return;
        };
        let Some(current) = registry.get(&key) else {
            return;
        };
        if !Arc::ptr_eq(current, &connection) {
            return;
        }
        if let Some(connection) = registry.remove(&key) {
            unregister_grok_steer_handle(&key);
            if let Ok(mut connection) = connection.lock() {
                log::info!(
                    "[Grok ACP] idle timeout reached; shutting down pid={}",
                    connection.pid
                );
                kill_grok_acp_connection(&mut connection);
            }
        }
    });
}

fn get_or_spawn_grok_acp_connection(
    cli_path: &Path,
    args: Vec<String>,
    jean_session_id: &str,
    worktree_id: &str,
    working_dir: &Path,
    existing_grok_session_id: Option<&str>,
    execution_mode: Option<&str>,
    mcp_servers: &[Value],
) -> Result<Arc<Mutex<GrokAcpConnection>>, String> {
    let key = jean_session_id.to_string();
    // Include MCP set in reuse key so enabling/disabling between prompts
    // restarts ACP with the new server list.
    let mcp_fingerprint = serde_json::to_string(mcp_servers).unwrap_or_default();
    let mut effective_args = args.clone();
    effective_args.push(format!("__jean_mcp__={mcp_fingerprint}"));

    let mut registry = GROK_ACP_CONNECTIONS
        .lock()
        .map_err(|_| "Failed to lock Grok ACP registry".to_string())?;
    if let Some(existing) = registry.get(&key).cloned() {
        let mut keep_existing = false;
        if let Ok(mut connection) = existing.lock() {
            let alive = connection.child.try_wait().ok().flatten().is_none();
            keep_existing = alive && connection.args == effective_args;
            if !keep_existing {
                kill_grok_acp_connection(&mut connection);
            }
        }
        if keep_existing {
            // Re-publish steer handle in case a partial cleanup removed it.
            if let Ok(conn) = existing.lock() {
                register_grok_steer_handle(
                    jean_session_id,
                    GrokSteerHandle {
                        writer: conn.writer.clone(),
                        acp_session_id: conn.acp_session_id.clone(),
                    },
                );
            }
            return Ok(existing);
        }
        registry.remove(&key);
        unregister_grok_steer_handle(jean_session_id);
    }

    let mut connection = spawn_grok_acp_connection(
        cli_path,
        args,
        jean_session_id,
        worktree_id,
        working_dir,
        existing_grok_session_id,
        execution_mode,
        mcp_servers,
    )?;
    // Store fingerprint so reuse comparisons work across prompts.
    connection.args = effective_args;
    let connection = Arc::new(Mutex::new(connection));
    registry.insert(key, connection.clone());
    Ok(connection)
}

fn send_grok_acp_prompt(
    app: &AppHandle,
    connection: &mut GrokAcpConnection,
    jean_session_id: &str,
    worktree_id: &str,
    execution_mode: Option<&str>,
    prepared_message: &str,
) -> Result<GrokResponse, String> {
    let prompt = build_grok_acp_prompt(prepared_message)?;
    let session_id = grok_acp_session_id(connection);
    let prompt_request_id = send_acp_request_on_writer(
        &connection.writer,
        "session/prompt",
        serde_json::json!({
            "sessionId": session_id,
            "prompt": prompt,
        }),
    )?;

    // Steer any text-only prompts that were queued before the ACP session /
    // process registration made mid-turn inject available (auto-steer, default on).
    super::commands::trigger_grok_queue_steer(
        app.clone(),
        worktree_id.to_string(),
        jean_session_id.to_string(),
    );

    let mut response = GrokResponse {
        content: String::new(),
        session_id,
        tool_calls: Vec::new(),
        content_blocks: Vec::new(),
        cancelled: false,
        usage: None,
    };
    let mut chunk_coalescer = ChunkCoalescer::new();
    let mut line = String::new();
    loop {
        line.clear();
        if connection
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read Grok ACP prompt stream: {e}"))?
            == 0
        {
            flush_coalesced_chunks(app, jean_session_id, worktree_id, &mut chunk_coalescer);
            return Err("Grok ACP exited before prompt completed".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        log::debug!("[Grok ACP] {trimmed}");
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("method").is_some() && value.get("id").is_some() {
            let mut writer = connection
                .writer
                .lock()
                .map_err(|_| "Failed to lock Grok ACP writer".to_string())?;
            if let Err(error) = handle_acp_client_request(
                &mut writer.stdin,
                &value,
                &mut connection.terminals,
                execution_mode,
            ) {
                log::warn!("[Grok ACP] client request failed during prompt: {error}");
                if let Some(id) = value.get("id") {
                    let _ = send_acp_error(
                        &mut writer.stdin,
                        id,
                        &format!("Jean ACP client error: {error}"),
                    );
                }
            }
            continue;
        }
        if let Some(session_id) = extract_acp_session_id(&value) {
            response.session_id = session_id;
        }
        if let Some(update) = extract_acp_update(&value) {
            match update.get("sessionUpdate").and_then(Value::as_str) {
                Some("agent_message_chunk") => {
                    if let Some(text) = update
                        .get("content")
                        .and_then(extract_text_from_acp_content)
                        .filter(|text| !text.is_empty())
                    {
                        response.content.push_str(&text);
                        push_text_block(&mut response.content_blocks, &text);
                        push_coalesced_chunk(
                            app,
                            jean_session_id,
                            worktree_id,
                            &mut chunk_coalescer,
                            &text,
                        );
                    }
                }
                Some("tool_call") => {
                    if let Some(tool_call) = extract_acp_tool_call(update) {
                        flush_coalesced_chunks(
                            app,
                            jean_session_id,
                            worktree_id,
                            &mut chunk_coalescer,
                        );
                        upsert_tool_call(&mut response.tool_calls, &tool_call);
                        ensure_tool_use(&mut response.content_blocks, &tool_call.id);
                        emit_tool_use(app, jean_session_id, worktree_id, &tool_call);
                    }
                }
                Some("tool_call_update") => {
                    if let Some(tool_call) = extract_acp_tool_call(update) {
                        flush_coalesced_chunks(
                            app,
                            jean_session_id,
                            worktree_id,
                            &mut chunk_coalescer,
                        );
                        upsert_tool_call(&mut response.tool_calls, &tool_call);
                        ensure_tool_use(&mut response.content_blocks, &tool_call.id);
                        emit_tool_use(app, jean_session_id, worktree_id, &tool_call);
                    }
                    if let (Some(tool_use_id), Some(output)) = (
                        first_string(update, &[&["toolCallId"], &["tool_call_id"]]),
                        acp_tool_output(update),
                    ) {
                        flush_coalesced_chunks(
                            app,
                            jean_session_id,
                            worktree_id,
                            &mut chunk_coalescer,
                        );
                        set_tool_result(&mut response.tool_calls, &tool_use_id, &output);
                        emit_tool_result(app, jean_session_id, worktree_id, &tool_use_id, &output);
                    }
                }
                _ => {}
            }
        } else if let Some(blocks) = extract_message_blocks(&value) {
            // Rare non-ACP path: flush any coalesced text first, then emit
            // immediately (avoids overlapping &mut borrows on the coalescer).
            flush_coalesced_chunks(app, jean_session_id, worktree_id, &mut chunk_coalescer);
            process_message_blocks(
                blocks,
                &mut response.content,
                &mut response.content_blocks,
                &mut response.tool_calls,
                &mut |text| emit_chunk_raw(app, jean_session_id, worktree_id, text),
                &mut |tool_call| emit_tool_use(app, jean_session_id, worktree_id, tool_call),
                &mut |tool_use_id, output| {
                    emit_tool_result(app, jean_session_id, worktree_id, tool_use_id, output)
                },
            );
        }
        if value.get("id").and_then(Value::as_i64) == Some(prompt_request_id) {
            if let Some(error) = value.get("error") {
                flush_coalesced_chunks(app, jean_session_id, worktree_id, &mut chunk_coalescer);
                return Err(format!("Grok ACP prompt failed: {error}"));
            }
            if response.usage.is_none() {
                response.usage =
                    value_at_path(&value, &["result", "_meta"]).and_then(usage_from_acp_meta);
            }
            break;
        }
    }
    flush_coalesced_chunks(app, jean_session_id, worktree_id, &mut chunk_coalescer);
    response.content = response.content.trim().to_string();
    set_grok_acp_session_id(connection, response.session_id.clone());
    Ok(response)
}

fn build_grok_acp_prompt(message: &str) -> Result<Value, String> {
    let image_paths = super::commands::extract_image_paths(message);
    let mut cleaned = message.to_string();
    let mut prompt = Vec::with_capacity(image_paths.len() + 1);

    for path in image_paths {
        cleaned = cleaned.replace(
            &format!("[Image attached: {path} - Use the Read tool to view this image]"),
            "",
        );
        let data = std::fs::read(&path)
            .map_err(|error| format!("Failed to read Grok image attachment {path}: {error}"))?;
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
        prompt.push(serde_json::json!({
            "type": "image",
            "data": STANDARD.encode(data),
            "mimeType": mime_type,
        }));
    }

    prompt.insert(
        0,
        serde_json::json!({ "type": "text", "text": cleaned.trim() }),
    );
    Ok(Value::Array(prompt))
}

pub fn execute_grok(options: GrokExecutionOptions<'_>) -> Result<GrokResponse, String> {
    let GrokExecutionOptions {
        app,
        jean_session_id,
        worktree_id,
        working_dir,
        output_file,
        existing_grok_session_id,
        model,
        execution_mode,
        effort_level,
        message,
        system_prompt,
        mcp_config,
        pid_callback,
    } = options;
    let cli_path = crate::grok_cli::resolve_cli_binary(app);
    if !crate::grok_cli::binary_exists(&cli_path) {
        return Err("Grok CLI not installed".to_string());
    }

    let existing_grok_session_id = existing_grok_session_id.filter(|id| !id.is_empty());
    let prepared_message = build_grok_message(message, system_prompt, execution_mode);
    let args = build_grok_agent_args(model, execution_mode, effort_level);
    let acp_mcp_servers = crate::grok_cli::mcp::mcp_config_to_acp_servers(mcp_config);
    let desired_enabled = crate::grok_cli::mcp::enabled_names_from_mcp_config(mcp_config);
    let worktree_str = working_dir.to_str();
    let previous_disabled =
        match crate::grok_cli::mcp::sync_disabled_for_enabled_set(worktree_str, &desired_enabled) {
            Ok(prev) => Some(prev),
            Err(e) => {
                log::warn!("[Grok MCP] failed to sync disabled_mcp_servers: {e}");
                None
            }
        };
    // Restore Grok's previous disabled list after this turn (even on error),
    // but only if we successfully rewrote it.
    let _disabled_guard = GrokDisabledRestoreGuard {
        previous: previous_disabled,
    };

    log::info!(
        "[Grok] execute session={jean_session_id} worktree={worktree_id} \
         model={model:?} execution_mode={execution_mode:?} \
         existing_grok_session_id={existing_grok_session_id:?} \
         mcp_servers={} cwd={}",
        acp_mcp_servers.len(),
        working_dir.display()
    );
    log::info!("[Grok] cli_path={}", cli_path.display());
    log::info!("[Grok] command: {}", format_grok_command(&cli_path, &args));

    // Unix: detached ACP host so the turn survives Jean restart (mirrors PI).
    #[cfg(unix)]
    {
        let run_id = super::pi::run_id_from_output_file(output_file);
        let (pid, socket_path) = spawn_grok_acp_host(
            app,
            jean_session_id,
            &run_id,
            output_file,
            working_dir,
            &cli_path,
            &args,
            existing_grok_session_id,
            execution_mode,
            &acp_mcp_servers,
        )?;
        if let Some(cb) = pid_callback {
            cb(pid);
        }
        if !super::registry::register_detached_process(jean_session_id.to_string(), pid) {
            let _ = crate::platform::kill_process_tree(pid);
            let _ = crate::platform::kill_process(pid);
            return Ok(GrokResponse {
                content: String::new(),
                session_id: existing_grok_session_id.unwrap_or_default().to_string(),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: true,
                usage: None,
            });
        }

        let prompt_line = serialize_grok_host_command(
            "prompt",
            Some(&prepared_message),
            Some(&format!("prompt-{run_id}")),
        );
        if let Err(e) = send_grok_acp_host_command(&socket_path, &prompt_line) {
            super::registry::unregister_process(jean_session_id);
            let _ = crate::platform::kill_process_tree(pid);
            let _ = crate::platform::kill_process(pid);
            return Err(e);
        }

        // Drain steerable queue once the host is ready for interjections.
        super::commands::trigger_grok_queue_steer(
            app.clone(),
            worktree_id.to_string(),
            jean_session_id.to_string(),
        );

        super::increment_tailer_count();
        let mut response =
            match tail_grok_output(app, jean_session_id, worktree_id, output_file, pid) {
                Ok(response) => response,
                Err(e) => {
                    super::decrement_tailer_count();
                    super::registry::unregister_process(jean_session_id);
                    let _ = app.emit_all(
                        "chat:error",
                        &ErrorEvent {
                            session_id: jean_session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            error: e.clone(),
                        },
                    );
                    return Err(e);
                }
            };
        super::decrement_tailer_count();
        super::registry::unregister_process(jean_session_id);

        if response.session_id.is_empty() {
            response.session_id = existing_grok_session_id.unwrap_or_default().to_string();
        }

        let waiting_for_plan =
            execution_mode == Some("plan") && inject_synthetic_plan(&mut response);
        // tail_grok_output already emitted chat:done when not cancelled; re-emit
        // only when plan-mode waiting state differs from the generic done event.
        if !response.cancelled && waiting_for_plan {
            let final_content = (!response.content.is_empty()).then_some(response.content.as_str());
            emit_done(app, jean_session_id, worktree_id, true, final_content);
        }

        log::info!(
            "[Grok ACP host] turn finished session={jean_session_id} pid={pid} cancelled={} \
             content_len={} tool_calls={}",
            response.cancelled,
            response.content.len(),
            response.tool_calls.len(),
        );
        Ok(response)
    }

    // Windows / non-Unix: in-process ACP child (does not survive Jean quit).
    #[cfg(not(unix))]
    {
        let _ = output_file;
        let connection = get_or_spawn_grok_acp_connection(
            &cli_path,
            args,
            jean_session_id,
            worktree_id,
            working_dir,
            existing_grok_session_id,
            execution_mode,
            &acp_mcp_servers,
        )?;

        let key = jean_session_id.to_string();
        let mut connection_guard = connection
            .lock()
            .map_err(|_| "Failed to lock Grok ACP connection".to_string())?;
        connection_guard.in_use = true;
        let pid = connection_guard.pid;
        if let Some(cb) = pid_callback {
            cb(pid);
        }
        if !super::registry::register_process(jean_session_id.to_string(), pid) {
            connection_guard.in_use = false;
            connection_guard.last_used = Instant::now();
            return Ok(GrokResponse {
                content: String::new(),
                session_id: grok_acp_session_id(&connection_guard),
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: true,
                usage: None,
            });
        }

        let mut response = match send_grok_acp_prompt(
            app,
            &mut connection_guard,
            jean_session_id,
            worktree_id,
            execution_mode,
            &prepared_message,
        ) {
            Ok(response) => response,
            Err(error) => {
                let cancelled = !super::registry::is_process_running(jean_session_id);
                super::registry::unregister_process(jean_session_id);
                connection_guard.in_use = false;
                if cancelled || connection_guard.child.try_wait().ok().flatten().is_some() {
                    kill_grok_acp_connection(&mut connection_guard);
                    drop(connection_guard);
                    if let Ok(mut registry) = GROK_ACP_CONNECTIONS.lock() {
                        registry.remove(&key);
                    }
                    unregister_grok_steer_handle(&key);
                }
                if cancelled {
                    return Ok(GrokResponse {
                        content: String::new(),
                        session_id: existing_grok_session_id.unwrap_or_default().to_string(),
                        tool_calls: vec![],
                        content_blocks: vec![],
                        cancelled: true,
                        usage: None,
                    });
                }
                let _ = app.emit_all(
                    "chat:error",
                    &ErrorEvent {
                        session_id: jean_session_id.to_string(),
                        worktree_id: worktree_id.to_string(),
                        error: error.clone(),
                    },
                );
                return Err(error);
            }
        };

        let cancelled = !super::registry::is_process_running(jean_session_id);
        super::registry::unregister_process(jean_session_id);
        response.cancelled = cancelled;
        let exited = connection_guard.child.try_wait().ok().flatten().is_some();
        let stderr = connection_guard
            .stderr
            .lock()
            .map(|stderr| stderr.clone())
            .unwrap_or_default();
        log::info!(
            "[Grok ACP] turn finished session={jean_session_id} pid={} cancelled={} exited={} \
             content_len={} tool_calls={} stderr_len={}",
            connection_guard.pid,
            cancelled,
            exited,
            response.content.len(),
            response.tool_calls.len(),
            stderr.len()
        );
        if !stderr.trim().is_empty() {
            log::warn!("[Grok ACP] stderr: {}", strip_ansi(&stderr).trim());
        }

        let waiting_for_plan =
            execution_mode == Some("plan") && inject_synthetic_plan(&mut response);
        if !response.cancelled {
            response.content = response.content.trim().to_string();
            let final_content = (!response.content.is_empty()).then_some(response.content.as_str());
            emit_done(
                app,
                jean_session_id,
                worktree_id,
                waiting_for_plan,
                final_content,
            );
        }

        connection_guard.in_use = false;
        connection_guard.last_used = Instant::now();
        if cancelled || exited {
            kill_grok_acp_connection(&mut connection_guard);
            drop(connection_guard);
            if let Ok(mut registry) = GROK_ACP_CONNECTIONS.lock() {
                registry.remove(&key);
            }
            unregister_grok_steer_handle(&key);
        } else {
            drop(connection_guard);
            schedule_grok_acp_idle_cleanup(key, connection.clone());
        }

        Ok(response)
    }
}

/// True when stdout is the Grok CLI headless JSON envelope (`--output-format json`
/// / `--json-schema`), not the model's payload itself.
fn is_grok_cli_json_wrapper(value: &Value) -> bool {
    value.get("stopReason").is_some()
        || value.get("sessionId").is_some()
        || value.get("requestId").is_some()
        || value.get("structuredOutput").is_some()
        || value.get("structuredOutputError").is_some()
        || (value.get("text").is_some() && value.get("usage").is_some())
}

/// Scan free-form text for the first parseable JSON object.
fn scan_json_object(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("No JSON object found in Grok response".to_string());
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        // Avoid treating the CLI envelope as payload when nested extractors call us.
        if is_grok_cli_json_wrapper(&value) {
            return Err("No JSON object found in Grok response".to_string());
        }
        return Ok(trimmed.to_string());
    }
    let start = trimmed
        .find('{')
        .ok_or("No JSON object found in Grok response".to_string())?;
    let end = trimmed
        .rfind('}')
        .ok_or("No JSON object found in Grok response".to_string())?;
    let candidate = &trimmed[start..=end];
    serde_json::from_str::<Value>(candidate)
        .map_err(|e| format!("Invalid JSON object in Grok response: {e}"))?;
    Ok(candidate.to_string())
}

fn extract_json_object(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if is_grok_cli_json_wrapper(&value) {
            // Native --json-schema path: preferred structured payload.
            match value.get("structuredOutput") {
                Some(Value::Object(_)) | Some(Value::Array(_)) => {
                    return serde_json::to_string(value.get("structuredOutput").unwrap())
                        .map_err(|e| format!("Failed to serialize Grok structuredOutput: {e}"));
                }
                Some(Value::String(inner)) if !inner.trim().is_empty() => {
                    return scan_json_object(inner);
                }
                Some(Value::Null) | None => {}
                Some(other) => {
                    return Err(format!(
                        "Unexpected structuredOutput type in Grok response: {other}"
                    ));
                }
            }

            // Fall back to assistant text, then thought (models sometimes only
            // draft JSON there when structured output is cancelled mid-turn).
            let mut last_err = "No JSON object found in Grok response".to_string();
            for key in ["text", "thought"] {
                if let Some(inner) = value.get(key).and_then(Value::as_str) {
                    match scan_json_object(inner) {
                        Ok(json) => return Ok(json),
                        Err(err) => last_err = err,
                    }
                }
            }

            if let Some(err) = value
                .get("structuredOutputError")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                return Err(format!(
                    "Grok structured output failed: {err} ({last_err})"
                ));
            }

            return Err(last_err);
        }
        // Already a bare JSON object/array/value — return as-is.
        return Ok(trimmed.to_string());
    }
    scan_json_object(trimmed)
}

fn build_one_shot_json_prompt(prompt: &str, json_schema: Option<&str>) -> String {
    match json_schema {
        // Schema is passed via --json-schema; only remind the model to answer as JSON.
        Some(_) => format!(
            "{prompt}\n\nReturn only a single valid JSON object matching the provided JSON schema. Do not wrap it in markdown or add commentary. Do not invoke skills, subagents, or tools — the full input is already in this message."
        ),
        None => {
            format!("{prompt}\n\nReturn only a single valid JSON object. Do not wrap it in markdown.")
        }
    }
}

/// Rules injected for structured one-shot calls so Grok does not detour into
/// interactive review skills / MCP / tool exploration (which frequently cancels
/// constrained decoding and yields empty or missing findings).
const ONE_SHOT_STRUCTURED_RULES: &str = "\
Complete structured JSON output in a single turn without tools, skills, subagents, or MCP. \
Review/answer only from content already in the user message. \
When the task is a code review, report clear security, correctness, race, data-loss, and contract bugs with high confidence — do not approve with empty findings when the provided diff introduces obvious defects. \
Prefer no finding only when no actionable defect is present.";

/// Build argv for a headless Grok one-shot. The prompt is always referenced via
/// `--prompt-file` (never inline `-p`) so large magic-prompt inputs (PR diffs up
/// to ~200KB plus commits/context) do not exceed OS ARG_MAX (E2BIG / os error 7).
fn build_one_shot_grok_cli_args(
    prompt_file: &str,
    cwd: &str,
    model: &str,
    json_schema: Option<&str>,
    effort_level: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--no-auto-update".to_string(),
        "--no-memory".to_string(),
        "--no-subagents".to_string(),
        "--disable-web-search".to_string(),
        "--prompt-file".to_string(),
        prompt_file.to_string(),
        "--cwd".to_string(),
        cwd.to_string(),
        "--permission-mode".to_string(),
        "dontAsk".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "--model".to_string(),
        raw_grok_model(Some(model))
            .unwrap_or(model)
            .to_string(),
    ];
    // Prefer native constrained decoding when a schema is available. Implies
    // --output-format json and populates structuredOutput on success.
    //
    // Structured one-shots must not use tools/MCP: Grok's auto skill discovery
    // (review / caveman-review) plus MCP frequently cancels constrained decoding
    // and returns empty findings even when the model drafted real issues.
    if let Some(schema) = json_schema {
        args.extend([
            "--json-schema".to_string(),
            schema.to_string(),
            // Empty allowlist removes built-in tools for this headless run.
            "--tools".to_string(),
            String::new(),
            "--deny".to_string(),
            "MCPTool(*)".to_string(),
            "--rules".to_string(),
            ONE_SHOT_STRUCTURED_RULES.to_string(),
            // One-shot magic prompts should finish quickly once tools are gone.
            "--max-turns".to_string(),
            "2".to_string(),
        ]);
    } else {
        args.extend(["--output-format".to_string(), "json".to_string()]);
    }
    if let Some(effort) = effort_level.filter(|effort| !effort.is_empty()) {
        args.extend(["--effort".to_string(), effort.to_string()]);
    }
    args
}

fn write_one_shot_prompt_file(prompt: &str) -> Result<std::path::PathBuf, String> {
    let prompt_file = std::env::temp_dir().join(format!(
        "jean-grok-one-shot-prompt-{}-{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&prompt_file, prompt)
        .map_err(|e| format!("Failed to write Grok one-shot prompt file: {e}"))?;
    Ok(prompt_file)
}

/// Resolve a host-local path for the Grok CLI child. On Windows+WSL the CLI runs
/// inside the distro, so temp paths must be converted to Unix form.
fn resolve_cli_path_arg(path: &Path) -> String {
    let wsl = crate::platform::get_wsl_config();
    if cfg!(windows) && wsl.enabled {
        crate::platform::win_to_wsl_path(&path.to_string_lossy())
    } else {
        path.to_string_lossy().into_owned()
    }
}

pub fn execute_one_shot_grok(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    json_schema: Option<&str>,
    working_dir: Option<&Path>,
    effort_level: Option<&str>,
) -> Result<String, String> {
    let cli_path = crate::grok_cli::resolve_cli_binary(app);
    if !crate::grok_cli::binary_exists(&cli_path) {
        return Err("Grok CLI not installed".to_string());
    }
    let dir = working_dir.unwrap_or_else(|| Path::new("."));
    let model = resolve_one_shot_grok_model(model);
    let json_prompt = build_one_shot_json_prompt(prompt, json_schema);
    let prompt_file = write_one_shot_prompt_file(&json_prompt)?;
    let prompt_file_arg = resolve_cli_path_arg(&prompt_file);

    let args = build_one_shot_grok_cli_args(
        &prompt_file_arg,
        &dir.to_string_lossy(),
        model,
        json_schema,
        effort_level,
    );

    let mut cmd = crate::platform::cli_command(&cli_path.to_string_lossy(), None);
    cmd.args(&args);
    cmd.current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    log::info!(
        "[Grok one-shot] command: {}",
        format_grok_command(&cli_path, &args)
    );
    log::debug!(
        "[Grok one-shot] prompt_file={} prompt_bytes={}",
        prompt_file.display(),
        json_prompt.len()
    );

    let output = cmd.output().map_err(|e| {
        let _ = std::fs::remove_file(&prompt_file);
        format!("Failed to run Grok one-shot request: {e}")
    })?;
    let _ = std::fs::remove_file(&prompt_file);

    if !output.status.success() {
        let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
        return Err(format!("Grok one-shot request failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(wrapper) = serde_json::from_str::<Value>(stdout.trim()) {
        if is_grok_cli_json_wrapper(&wrapper) {
            let stop = wrapper
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("");
            let has_structured = matches!(
                wrapper.get("structuredOutput"),
                Some(Value::Object(_)) | Some(Value::Array(_)) | Some(Value::String(_))
            );
            if stop.eq_ignore_ascii_case("cancelled") && !has_structured {
                log::warn!(
                    "Grok one-shot cancelled without structuredOutput; attempting recovery from text/thought"
                );
            }
        }
    }
    extract_json_object(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn one_shot_json_prompt_reminds_schema_without_embedding_it() {
        let schema = r#"{"type":"object","required":["summary","slug"]}"#;

        let prompt = build_one_shot_json_prompt("Summarize this session", Some(schema));

        assert!(prompt.contains("Summarize this session"));
        // Schema is passed via --json-schema; do not bloat the prompt with a copy.
        assert!(!prompt.contains(schema));
        assert!(prompt.contains("matching the provided JSON schema"));
        assert!(prompt.contains("Do not invoke skills"));
    }

    #[test]
    fn one_shot_json_prompt_without_schema_still_requests_json() {
        let prompt = build_one_shot_json_prompt("Name this session", None);
        assert!(prompt.contains("Name this session"));
        assert!(prompt.contains("Return only a single valid JSON object"));
    }

    #[test]
    fn one_shot_cli_args_use_prompt_file_not_inline_prompt() {
        // ARG_MAX / E2BIG: never put large PR diffs on argv via `-p`.
        let args = build_one_shot_grok_cli_args(
            "/tmp/jean-prompt.txt",
            "/repo",
            "grok-build",
            Some(r#"{"type":"object"}"#),
            Some("high"),
        );

        assert!(args.contains(&"--prompt-file".to_string()));
        let prompt_file_idx = args.iter().position(|a| a == "--prompt-file").unwrap();
        assert_eq!(args[prompt_file_idx + 1], "/tmp/jean-prompt.txt");
        assert!(!args.iter().any(|a| a == "-p" || a == "--prompt" || a == "--single"));
        // Prompt body must not appear as an argv entry.
        assert!(!args.iter().any(|a| a.contains("diff --git") || a.len() > 10_000));
        assert!(args.contains(&"--json-schema".to_string()));
        assert!(args.contains(&"--effort".to_string()));
        assert!(args.contains(&"high".to_string()));
        assert!(args.contains(&"--max-turns".to_string()));
    }

    #[test]
    fn one_shot_cli_args_without_schema_use_json_output() {
        let args =
            build_one_shot_grok_cli_args("/tmp/p.txt", ".", "grok-build", None, None);
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"json".to_string()));
        assert!(!args.iter().any(|a| a == "--json-schema"));
    }

    #[test]
    fn write_one_shot_prompt_file_round_trips_large_content() {
        // Simulate a PR-sized payload that would blow ARG_MAX if inlined as `-p`.
        let large = "x".repeat(250_000);
        let path = write_one_shot_prompt_file(&large).expect("write prompt file");
        let read = std::fs::read_to_string(&path).expect("read prompt file");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read.len(), 250_000);
        assert_eq!(read, large);
    }

    #[test]
    fn format_grok_command_redacts_prompt_file_path() {
        let args = vec![
            "--prompt-file".to_string(),
            "/tmp/secret-prompt.txt".to_string(),
            "--model".to_string(),
            "grok-build".to_string(),
        ];
        let rendered = format_grok_command(Path::new("grok"), &args);
        assert!(rendered.contains("--prompt-file"));
        assert!(rendered.contains("<REDACTED_PROMPT>"));
        assert!(!rendered.contains("secret-prompt"));
    }

    #[test]
    fn resolve_one_shot_grok_model_coerces_non_grok_to_default() {
        // Claude/other-backend defaults must collapse to the Grok default.
        assert_eq!(
            resolve_one_shot_grok_model("claude-opus-4-8[1m]"),
            GROK_DEFAULT_MODEL
        );
        assert_eq!(resolve_one_shot_grok_model("sonnet"), GROK_DEFAULT_MODEL);
        // Grok models pass through unchanged.
        assert_eq!(resolve_one_shot_grok_model("grok-build"), "grok-build");
        assert_eq!(
            resolve_one_shot_grok_model("grok/grok-4.5"),
            "grok/grok-4.5"
        );
    }

    #[test]
    fn builds_acp_image_blocks_from_jean_attachments() {
        let path = std::env::temp_dir().join(format!(
            "jean-grok-image-{}-{}.png",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, [1, 2, 3]).unwrap();
        let message = format!(
            "Inspect this image\n\n[Image attached: {} - Use the Read tool to view this image]",
            path.display()
        );

        let prompt = build_grok_acp_prompt(&message).unwrap();
        let _ = std::fs::remove_file(path);

        assert_eq!(prompt[0]["type"], "text");
        assert_eq!(prompt[0]["text"], "Inspect this image");
        assert_eq!(prompt[1]["type"], "image");
        assert_eq!(prompt[1]["mimeType"], "image/png");
        assert_eq!(prompt[1]["data"], "AQID");
    }

    #[test]
    fn client_capabilities_leave_local_file_reads_to_grok() {
        let capabilities = grok_client_capabilities();

        assert_eq!(capabilities["terminal"], true);
        assert!(capabilities.get("fs").is_none());
    }

    #[test]
    fn binary_text_file_request_returns_acp_error_without_ending_connection() {
        let path = std::env::temp_dir().join(format!(
            "jean-grok-acp-binary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "fs/read_text_file",
            "params": { "path": path },
        });
        let mut output = Vec::new();
        let mut terminals = HashMap::new();

        let result = handle_acp_client_request(&mut output, &request, &mut terminals, Some("yolo"));
        let _ = std::fs::remove_file(&path);

        assert!(result.is_ok());
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert!(response["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("stream did not contain valid UTF-8")));
    }

    fn permission_options() -> Value {
        serde_json::json!([
            { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
            { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
        ])
    }

    #[test]
    fn plan_mode_allows_web_fetch_permission() {
        let params = serde_json::json!({
            "sessionId": "sess-1",
            "toolCall": {
                "toolCallId": "call-1",
                "title": "Fetch: https://example.com/docs",
                "kind": "fetch",
                "rawInput": { "variant": "WebFetch", "url": "https://example.com/docs" },
                "_meta": {
                    "x.ai/tool": {
                        "name": "web_fetch",
                        "kind": "web_fetch",
                        "read_only": true
                    }
                }
            },
            "options": permission_options(),
        });
        assert!(should_allow_acp_permission(Some("plan"), &params));

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/request_permission",
            "params": params,
        });
        let mut output = Vec::new();
        let mut terminals = HashMap::new();
        handle_acp_client_request(&mut output, &request, &mut terminals, Some("plan")).unwrap();
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(
            response["result"]["outcome"]["optionId"].as_str(),
            Some("allow-once")
        );
    }

    #[test]
    fn plan_mode_allows_execute_permission_for_research_shell() {
        // Grok investigations typically open with run_terminal_command (gh/git/rg).
        // Rejecting execute caused turns to stop after the research preamble.
        let params = serde_json::json!({
            "sessionId": "sess-1",
            "toolCall": {
                "toolCallId": "call-2",
                "title": "Execute `/usr/bin/gh pr view 10538`",
                "kind": "execute",
                "rawInput": { "variant": "Bash", "command": "/usr/bin/gh pr view 10538" },
                "_meta": {
                    "x.ai/tool": {
                        "name": "run_terminal_command",
                        "kind": "execute",
                        "read_only": false
                    }
                }
            },
            "options": permission_options(),
        });
        assert!(should_allow_acp_permission(Some("plan"), &params));

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "session/request_permission",
            "params": params,
        });
        let mut output = Vec::new();
        let mut terminals = HashMap::new();
        handle_acp_client_request(&mut output, &request, &mut terminals, Some("plan")).unwrap();
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(
            response["result"]["outcome"]["optionId"].as_str(),
            Some("allow-once")
        );
    }

    #[test]
    fn plan_mode_rejects_edit_permission() {
        let params = serde_json::json!({
            "sessionId": "sess-1",
            "toolCall": {
                "toolCallId": "call-edit",
                "title": "Edit `src/foo.rs`",
                "kind": "edit",
                "rawInput": { "variant": "SearchReplace", "file_path": "src/foo.rs" },
                "_meta": {
                    "x.ai/tool": {
                        "name": "search_replace",
                        "kind": "edit",
                        "read_only": false
                    }
                }
            },
            "options": permission_options(),
        });
        assert!(!should_allow_acp_permission(Some("plan"), &params));

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "session/request_permission",
            "params": params,
        });
        let mut output = Vec::new();
        let mut terminals = HashMap::new();
        handle_acp_client_request(&mut output, &request, &mut terminals, Some("plan")).unwrap();
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(
            response["result"]["outcome"]["optionId"].as_str(),
            Some("reject-once")
        );
    }

    #[test]
    fn plan_mode_allows_terminal_create() {
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "terminal/create",
            "params": {
                "command": "echo research-ok",
                "cwd": "/tmp",
            },
        });
        let mut output = Vec::new();
        let mut terminals = HashMap::new();
        handle_acp_client_request(&mut output, &request, &mut terminals, Some("plan")).unwrap();
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert!(
            response.get("error").is_none(),
            "plan mode must allow research shell: {response}"
        );
        assert!(response["result"]["terminalId"].as_str().is_some());
        // Clean up spawned shell.
        for (_, terminal) in terminals.drain() {
            if let Ok(mut child) = terminal.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[test]
    fn yolo_mode_allows_execute_permission() {
        let params = serde_json::json!({
            "sessionId": "sess-1",
            "toolCall": {
                "toolCallId": "call-3",
                "kind": "execute",
                "title": "Execute `ls`"
            },
            "options": permission_options(),
        });
        assert!(should_allow_acp_permission(Some("yolo"), &params));
    }

    #[test]
    fn inject_synthetic_plan_skips_research_preamble() {
        let mut response = GrokResponse {
            content: "I'll draft a full Hermes integration plan with Hermes profiles as a first-class requirement. Gathering Jean's backend patterns and Hermes profile docs so the plan matches both systems.".to_string(),
            session_id: "s1".into(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: false,
            usage: None,
        };
        assert!(!inject_synthetic_plan(&mut response));
        assert!(response.tool_calls.is_empty());
    }

    #[test]
    fn inject_synthetic_plan_accepts_structured_plan() {
        let plan = r#"# Hermes Backend Integration Plan

## Overview
Integrate Hermes as a first-class Jean AI backend with profile support.

## Tasks
1. Add backend enum and preferences
2. Wire Rust execution module
3. Add auth/install CLI commands
4. Update chat toolbar and settings UI

### Testing
- [ ] Unit tests for profile resolution
- [ ] E2E session create with Hermes backend
"#;
        let mut response = GrokResponse {
            content: plan.to_string(),
            session_id: "s1".into(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: false,
            usage: None,
        };
        assert!(inject_synthetic_plan(&mut response));
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "ExitPlanMode");
    }

    #[test]
    fn parse_grok_streaming_json_text_chunks_and_session_id() {
        let input = r#"
{"type":"session","session_id":"grok-session-1"}
{"type":"assistant","delta":"Hello "}
{"type":"assistant","delta":"from Grok"}
{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.content, "Hello from Grok");
        assert_eq!(response.session_id, "grok-session-1");
        assert_eq!(response.usage.unwrap().output_tokens, 4);
    }

    #[test]
    fn parse_grok_streaming_json_text_data_and_end_event() {
        // Grok's documented streaming-json schema: text via `data`, terminal `end` event.
        let input = r#"
{"type":"text","data":"Hello "}
{"type":"thought","data":"thinking out loud"}
{"type":"text","data":"world"}
{"type":"end","stopReason":"EndTurn","sessionId":"grok-session-9"}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        // `thought` data must NOT leak into content.
        assert_eq!(response.content, "Hello world");
        assert_eq!(response.session_id, "grok-session-9");
    }

    #[test]
    fn build_grok_args_omits_undocumented_alt_screen_flag() {
        let args = build_grok_args(
            "hello",
            Some("grok-4.5"),
            Some("plan"),
            None,
            Some("session-1"),
            "/tmp/worktree",
        );
        assert!(!args.contains(&"--no-alt-screen".to_string()));
    }

    #[test]
    fn build_grok_args_uses_resume_flag_for_existing_session() {
        let args = build_grok_args(
            "hello",
            Some("grok-4.5"),
            Some("plan"),
            None,
            Some("grok-session-1"),
            "/tmp/worktree",
        );

        assert!(!args.contains(&"--session-id".to_string()));
        let idx = args
            .iter()
            .position(|arg| arg == "--resume")
            .expect("--resume flag present");
        assert_eq!(args.get(idx + 1), Some(&"grok-session-1".to_string()));
    }

    #[test]
    fn extract_json_object_reads_grok_json_output_text_wrapper() {
        let stdout = r#"{
  "text": "{\"summary\":\"Done\",\"slug\":\"done\"}",
  "stopReason": "EndTurn",
  "sessionId": "grok-session-1"
}"#;

        assert_eq!(
            extract_json_object(stdout).unwrap(),
            r#"{"summary":"Done","slug":"done"}"#
        );
    }

    #[test]
    fn extract_json_object_prefers_structured_output_field() {
        let stdout = r#"{
  "text": "I'll produce structured output now.",
  "stopReason": "EndTurn",
  "sessionId": "grok-session-1",
  "structuredOutput": {"summary":"Looks good","findings":[],"approval_status":"approved"},
  "structuredOutputError": null
}"#;

        let json = extract_json_object(stdout).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value.get("approval_status").and_then(Value::as_str),
            Some("approved")
        );
        assert_eq!(
            value.get("summary").and_then(Value::as_str),
            Some("Looks good")
        );
        assert_eq!(value.get("findings").and_then(Value::as_array).map(|a| a.len()), Some(0));
    }

    #[test]
    fn extract_json_object_surfaces_structured_output_error() {
        let stdout = r#"{
  "text": "Working on it...",
  "stopReason": "Cancelled",
  "sessionId": "grok-session-1",
  "structuredOutput": null,
  "structuredOutputError": "model did not produce structured output"
}"#;

        let err = extract_json_object(stdout).unwrap_err();
        assert!(
            err.contains("model did not produce structured output"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn extract_json_object_recovers_json_from_thought_when_structured_output_missing() {
        let stdout = r#"{
  "text": "",
  "thought": "Drafting review.\n{\"summary\":\"Bug found\",\"findings\":[{\"severity\":\"critical\",\"category\":\"security\",\"confidence\":\"high\",\"blocking\":true,\"introduced_by_diff\":true,\"file\":\"a.rs\",\"line\":1,\"title\":\"auth bypass\",\"description\":\"always true\",\"failure_scenario\":\"any login\",\"suggestion\":\"check password\"}],\"approval_status\":\"changes_requested\"}",
  "stopReason": "Cancelled",
  "sessionId": "grok-session-1",
  "structuredOutput": null,
  "structuredOutputError": "model did not produce structured output"
}"#;

        let json = extract_json_object(stdout).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value.get("approval_status").and_then(Value::as_str),
            Some("changes_requested")
        );
        assert_eq!(
            value
                .get("findings")
                .and_then(Value::as_array)
                .map(|a| a.len()),
            Some(1)
        );
    }

    #[test]
    fn build_grok_interject_params_shape() {
        let params = build_grok_interject_params("acp-sess-1", "also fix tests", "jean-steer-1");
        assert_eq!(
            params.get("sessionId").and_then(Value::as_str),
            Some("acp-sess-1")
        );
        assert_eq!(
            params.get("text").and_then(Value::as_str),
            Some("also fix tests")
        );
        assert_eq!(
            params.get("interjectionId").and_then(Value::as_str),
            Some("jean-steer-1")
        );
    }

    #[test]
    fn grok_acp_interject_method_uses_underscore_extension_prefix() {
        // Grok agent stdio rejects bare `x.ai/interject` with Method not found;
        // the live extension method is underscore-prefixed.
        assert_eq!(GROK_ACP_INTERJECT_METHOD, "_x.ai/interject");
        assert!(
            GROK_ACP_INTERJECT_METHOD.starts_with("_x.ai/"),
            "expected underscore-prefixed xAI ACP extension method"
        );
    }

    #[test]
    fn build_grok_args_map_execution_modes() {
        let plan = build_grok_args(
            "hello",
            Some("grok-4.5"),
            Some("plan"),
            None,
            Some("session-1"),
            "/tmp/worktree",
        );
        assert!(plan.contains(&"--permission-mode".to_string()));
        assert!(plan.contains(&"plan".to_string()));
        assert!(plan.contains(&"--sandbox".to_string()));
        assert!(plan.contains(&"read-only".to_string()));

        let yolo = build_grok_args(
            "hello",
            Some("grok-4.5"),
            Some("yolo"),
            None,
            Some("session-1"),
            "/tmp/worktree",
        );
        assert!(yolo.contains(&"bypassPermissions".to_string()));
        assert!(yolo.contains(&"off".to_string()));
    }

    #[test]
    fn build_grok_args_includes_effort_flag() {
        let args = build_grok_args(
            "hello",
            Some("grok-4.5"),
            Some("plan"),
            Some("high"),
            Some("session-1"),
            "/tmp/worktree",
        );
        let idx = args
            .iter()
            .position(|a| a == "--effort")
            .expect("--effort flag present");
        assert_eq!(args.get(idx + 1), Some(&"high".to_string()));
    }

    #[test]
    fn build_grok_args_omits_effort_flag_when_none() {
        let args = build_grok_args(
            "hello",
            Some("grok-4.5"),
            Some("plan"),
            None,
            Some("session-1"),
            "/tmp/worktree",
        );
        assert!(!args.contains(&"--effort".to_string()));
    }

    #[test]
    fn parse_grok_stream_reads_acp_agent_message_chunks() {
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-acp-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-acp-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" world"}}}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.content, "Hello world");
        assert_eq!(response.session_id, "grok-acp-1");
        assert_eq!(response.content_blocks.len(), 1);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::Text { text } if text == "Hello world"
        ));
    }

    #[test]
    fn parse_grok_stream_reads_acp_tool_call_updates() {
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-acp-2","update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"Shell","rawInput":{"command":"ls -la"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-acp-2","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","rawOutput":"file list"}}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.session_id, "grok-acp-2");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "tool-1");
        // "Shell" title normalizes to Jean's Bash tool name.
        assert_eq!(response.tool_calls[0].name, "Bash");
        assert_eq!(response.tool_calls[0].input["command"], "ls -la");
        assert_eq!(response.tool_calls[0].output.as_deref(), Some("file list"));
        assert_eq!(response.content_blocks.len(), 1);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "tool-1"
        ));
    }

    #[test]
    fn parse_grok_stream_attaches_message_content_tool_results() {
        let input = r#"
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call-1","name":"Read `src/main.ts`","input":{"target_file":"src/main.ts","variant":"ReadFile"}},{"type":"text","text":"Done"}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":"file contents"}]}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.content, "Done");
        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].id, "call-1");
        assert_eq!(response.tool_calls[0].name, "Read");
        assert_eq!(response.tool_calls[0].input["file_path"], "src/main.ts");
        assert_eq!(
            response.tool_calls[0].output.as_deref(),
            Some("file contents")
        );
        assert_eq!(response.content_blocks.len(), 2);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "call-1"
        ));
        assert!(matches!(
            &response.content_blocks[1],
            ContentBlock::Text { text } if text == "Done"
        ));
    }

    #[test]
    fn normalize_grok_tool_call_maps_variants_and_title_summaries() {
        // Grep: title is the pattern; real type is input.variant
        let grep = normalize_grok_tool_call(ParsedToolCall {
            id: "g1".into(),
            name: "steer|steering".into(),
            input: serde_json::json!({
                "pattern": "steer|steering",
                "path": "/tmp",
                "glob": "**/*.rs",
                "-i": true,
                "variant": "Grep"
            }),
        });
        assert_eq!(grep.name, "Grep");
        assert_eq!(grep.input["pattern"], "steer|steering");
        assert_eq!(grep.input["case_insensitive"], true);
        assert!(grep.input.get("variant").is_none());

        // Bash from Execute title + variant
        let bash = normalize_grok_tool_call(ParsedToolCall {
            id: "b1".into(),
            name: "Execute `ls -la`".into(),
            input: serde_json::json!({
                "command": "ls -la",
                "description": "list files",
                "variant": "Bash"
            }),
        });
        assert_eq!(bash.name, "Bash");
        assert_eq!(bash.input["command"], "ls -la");

        // ListDir → List with path
        let list = normalize_grok_tool_call(ParsedToolCall {
            id: "l1".into(),
            name: "List `/tmp`".into(),
            input: serde_json::json!({
                "target_directory": "/tmp",
                "variant": "ListDir"
            }),
        });
        assert_eq!(list.name, "List");
        assert_eq!(list.input["path"], "/tmp");

        // WebFetch from title when input lacks url
        let fetch = normalize_grok_tool_call(ParsedToolCall {
            id: "f1".into(),
            name: "Fetch: https://docs.x.ai/build".into(),
            input: serde_json::json!({ "variant": "WebFetch" }),
        });
        assert_eq!(fetch.name, "WebFetch");
        assert_eq!(fetch.input["url"], "https://docs.x.ai/build");

        // WebSearch title with null/empty input
        let search = normalize_grok_tool_call(ParsedToolCall {
            id: "w1".into(),
            name: "Web search:".into(),
            input: Value::Null,
        });
        assert_eq!(search.name, "WebSearch");

        // Edit from SearchReplace + oldText/newText
        let edit = normalize_grok_tool_call(ParsedToolCall {
            id: "e1".into(),
            name: "Edit `src/a.ts`".into(),
            input: serde_json::json!({
                "path": "src/a.ts",
                "oldText": "foo",
                "newText": "bar",
                "variant": "SearchReplace"
            }),
        });
        assert_eq!(edit.name, "Edit");
        assert_eq!(edit.input["file_path"], "src/a.ts");
        assert_eq!(edit.input["old_string"], "foo");
        assert_eq!(edit.input["new_string"], "bar");

        // TodoWrite: title summary + Grok-shaped items without activeForm
        let todos = normalize_grok_tool_call(ParsedToolCall {
            id: "t1".into(),
            name: "Updating plan".into(),
            input: serde_json::json!({
                "merge": false,
                "todos": [
                    {"id": "1", "content": "Investigate steering", "status": "in_progress"},
                    {"id": "2", "content": "Fix tool calls", "status": "pending"}
                ],
                "variant": "TodoWrite"
            }),
        });
        assert_eq!(todos.name, "TodoWrite");
        assert_eq!(todos.input["todos"][0]["content"], "Investigate steering");
        assert_eq!(
            todos.input["todos"][0]["activeForm"],
            "Investigate steering"
        );
        assert_eq!(todos.input["todos"][0]["status"], "in_progress");
        assert_eq!(todos.input["todos"][1]["status"], "pending");
        assert!(todos.input.get("variant").is_none());

        // todo_write snake_case name
        let todos2 = normalize_grok_tool_call(ParsedToolCall {
            id: "t2".into(),
            name: "todo_write".into(),
            input: serde_json::json!({
                "todos": [{"content": "A", "status": "completed"}]
            }),
        });
        assert_eq!(todos2.name, "TodoWrite");
        assert_eq!(todos2.input["todos"][0]["activeForm"], "A");
    }

    #[test]
    fn normalize_grok_tool_call_maps_all_observed_acp_variants() {
        let cases = [
            (
                "CursorRead",
                serde_json::json!({"variant": "CursorRead", "path": "/tmp/a.rs"}),
                "Read",
                "file_path",
                serde_json::json!("/tmp/a.rs"),
            ),
            (
                "CursorGrep",
                serde_json::json!({"variant": "CursorGrep", "pattern": "needle"}),
                "Grep",
                "pattern",
                serde_json::json!("needle"),
            ),
            (
                "CursorGlob",
                serde_json::json!({
                    "variant": "CursorGlob",
                    "target_directory": "/tmp",
                    "glob_pattern": "**/*.rs"
                }),
                "Glob",
                "pattern",
                serde_json::json!("**/*.rs"),
            ),
            (
                "CursorShell",
                serde_json::json!({"variant": "CursorShell", "command": "pwd"}),
                "Bash",
                "command",
                serde_json::json!("pwd"),
            ),
            (
                "CursorStrReplace",
                serde_json::json!({
                    "variant": "CursorStrReplace",
                    "path": "/tmp/a.rs",
                    "old_string": "old",
                    "new_string": "new"
                }),
                "Edit",
                "file_path",
                serde_json::json!("/tmp/a.rs"),
            ),
            (
                "CursorWrite",
                serde_json::json!({
                    "variant": "CursorWrite",
                    "path": "/tmp/a.rs",
                    "contents": "hello"
                }),
                "Write",
                "content",
                serde_json::json!("hello"),
            ),
            (
                "CursorTodoWrite",
                serde_json::json!({
                    "variant": "CursorTodoWrite",
                    "todos": [{"content": "Test", "status": "pending"}]
                }),
                "TodoWrite",
                "todos",
                serde_json::json!([{
                    "content": "Test",
                    "activeForm": "Test",
                    "status": "pending"
                }]),
            ),
            (
                "TaskOutput",
                serde_json::json!({
                    "variant": "TaskOutput",
                    "task_ids": ["task-1", "task-2"],
                    "timeout_ms": 120000
                }),
                "WaitForAgents",
                "receiver_thread_ids",
                serde_json::json!(["task-1", "task-2"]),
            ),
        ];

        for (variant, input, expected_name, expected_key, expected_value) in cases {
            let tool = normalize_grok_tool_call(ParsedToolCall {
                id: variant.to_string(),
                name: "other".to_string(),
                input,
            });
            assert_eq!(tool.name, expected_name, "variant {variant}");
            assert_eq!(
                tool.input[expected_key], expected_value,
                "variant {variant} input"
            );
            assert!(tool.input.get("variant").is_none(), "variant {variant}");
        }

        let enter_plan = normalize_grok_tool_call(ParsedToolCall {
            id: "plan".to_string(),
            name: "Plan: Enter".to_string(),
            input: serde_json::json!({"variant": "EnterPlanMode"}),
        });
        assert_eq!(enter_plan.name, "EnterPlanMode");
    }

    #[test]
    fn normalize_grok_tool_call_maps_initial_native_tool_names() {
        let cases = [
            ("write", "Write"),
            ("spawn_subagent", "Task"),
            ("get_command_or_subagent_output", "WaitForAgents"),
            ("enter_plan_mode", "EnterPlanMode"),
            ("exit_plan_mode", "ExitPlanMode"),
        ];

        for (native_name, expected_name) in cases {
            let tool = normalize_grok_tool_call(ParsedToolCall {
                id: native_name.to_string(),
                name: native_name.to_string(),
                input: Value::Null,
            });
            assert_eq!(tool.name, expected_name, "native tool {native_name}");
        }
    }

    #[test]
    fn parse_grok_stream_normalizes_mixed_acp_tool_kinds() {
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"t-read","title":"Read `/a.rs`","rawInput":{"target_file":"/a.rs","limit":10,"variant":"ReadFile"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"t-grep","title":"foo|bar","rawInput":{"pattern":"foo|bar","path":".","variant":"Grep"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"t-bash","title":"Execute `echo hi`","rawInput":{"command":"echo hi","variant":"Bash"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"t-web","title":"Web search: grok steering","rawInput":null}}}
"#;

        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();
        assert_eq!(response.tool_calls.len(), 4);

        let by_id = |id: &str| {
            response
                .tool_calls
                .iter()
                .find(|t| t.id == id)
                .unwrap_or_else(|| panic!("missing tool {id}"))
        };

        assert_eq!(by_id("t-read").name, "Read");
        assert_eq!(by_id("t-read").input["file_path"], "/a.rs");
        assert_eq!(by_id("t-grep").name, "Grep");
        assert_eq!(by_id("t-grep").input["pattern"], "foo|bar");
        assert_eq!(by_id("t-bash").name, "Bash");
        assert_eq!(by_id("t-bash").input["command"], "echo hi");
        assert_eq!(by_id("t-web").name, "WebSearch");
        assert_eq!(by_id("t-web").input["query"], "grok steering");
    }

    #[test]
    fn acp_tool_output_prefers_readable_raw_output_fields() {
        let output_for_prompt = serde_json::json!({
            "rawOutput": {
                "type": "Bash",
                "output": [105, 103, 110, 111, 114, 101, 100],
                "output_for_prompt": "Exit code: 0\nhello"
            }
        });
        assert_eq!(
            acp_tool_output(&output_for_prompt).as_deref(),
            Some("Exit code: 0\nhello")
        );

        let byte_output = serde_json::json!({
            "rawOutput": {
                "type": "Bash",
                "output": [102, 105, 108, 101, 115]
            }
        });
        assert_eq!(acp_tool_output(&byte_output).as_deref(), Some("files"));
    }

    #[test]
    fn build_grok_agent_args_use_acp_stdio() {
        let args = build_grok_agent_args(Some("grok/grok-4.5"), Some("yolo"), Some("high"));

        assert_eq!(args[0], "--no-auto-update");
        assert!(args.contains(&"agent".to_string()));
        assert!(args.contains(&"stdio".to_string()));
        assert!(!args.contains(&"-p".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"grok-4.5".to_string()));
        assert!(args.contains(&"--reasoning-effort".to_string()));
        assert!(args.contains(&"high".to_string()));
        assert!(args.contains(&"--always-approve".to_string()));
        assert_eq!(args[1], "--no-plan");
        assert_eq!(args[2], "agent");
    }

    #[test]
    fn build_grok_agent_args_disables_native_plan_in_all_modes() {
        let plan = build_grok_agent_args(None, Some("plan"), None);
        let build = build_grok_agent_args(None, Some("build"), None);
        let yolo = build_grok_agent_args(None, Some("yolo"), None);

        // ACP cannot surface Grok native exit_plan_mode TUI — always --no-plan.
        assert!(plan.contains(&"--no-plan".to_string()));
        assert!(build.contains(&"--no-plan".to_string()));
        assert!(yolo.contains(&"--no-plan".to_string()));
        assert!(!plan.contains(&"--always-approve".to_string()));
        assert!(build.contains(&"--always-approve".to_string()));
    }

    #[test]
    fn build_grok_message_includes_plan_mode_contract() {
        let message = build_grok_message("plan the feature", None, Some("plan"));
        assert!(message.contains("PLAN MODE"));
        // Research shell is allowed; file mutations are not.
        assert!(message.contains("shell commands") || message.contains("gh"));
        assert!(message.contains("Do NOT edit or write files"));
        assert!(message.contains("exit_plan_mode"));
        assert!(message.contains("Implementation Plan") || message.contains("structured"));
        assert!(message.ends_with("plan the feature"));
    }

    #[test]
    fn selected_permission_option_falls_back_to_kind_prefix() {
        let params = serde_json::json!({
            "options": [
                { "optionId": "ok", "kind": "allow_for_session" },
                { "optionId": "nope", "kind": "deny_once" }
            ]
        });
        assert_eq!(
            selected_permission_option(&params, true).as_deref(),
            Some("ok")
        );
        assert_eq!(
            selected_permission_option(&params, false).as_deref(),
            Some("nope")
        );
    }

    #[test]
    fn build_grok_message_makes_yolo_mode_authoritative() {
        let message =
            build_grok_message("fix it", Some("Custom project instructions"), Some("yolo"));

        let custom_instructions = message
            .find("Custom project instructions")
            .expect("custom instructions are included");
        let mode_override = message
            .find("YOLO EXECUTION MODE")
            .expect("yolo mode override is included");
        assert!(mode_override > custom_instructions);
        assert!(message.contains("Do not call enter_plan_mode or exit_plan_mode"));
        assert!(message.ends_with("fix it"));
    }

    #[test]
    fn serialize_grok_host_command_is_lf_jsonl() {
        let line = serialize_grok_host_command("prompt", Some("hello"), Some("req-1"));
        assert!(line.ends_with('\n'));
        let value: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value.get("type").and_then(Value::as_str), Some("prompt"));
        assert_eq!(value.get("message").and_then(Value::as_str), Some("hello"));
        assert_eq!(value.get("id").and_then(Value::as_str), Some("req-1"));
    }

    #[test]
    fn grok_line_is_completion_result_detects_result_marker() {
        assert!(grok_line_is_completion_result(
            r#"{"type":"result","session_id":"abc"}"#
        ));
        assert!(!grok_line_is_completion_result(
            r#"{"jsonrpc":"2.0","method":"session/update"}"#
        ));
    }

    #[test]
    #[cfg(unix)]
    fn grok_acp_socket_path_is_short_under_app_data() {
        let path = grok_acp_socket_path(
            Path::new("/tmp/jean-app-data"),
            "session-abcdefghijklmnop",
            "run-1234567890",
        );
        assert!(path.starts_with("/tmp/jean-app-data/grok-acp"));
        assert!(path.to_string_lossy().len() < 100);
    }

    #[test]
    fn parse_grok_run_to_message_reads_acp_stream() {
        let lines = vec![
            r#"{"type":"session","session_id":"grok-hist-1"}"#.to_string(),
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"grok-hist-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Survived restart"}}}}"#.to_string(),
            r#"{"type":"result","session_id":"grok-hist-1"}"#.to_string(),
        ];
        let run = RunEntry {
            run_id: "run-1".to_string(),
            user_message_id: "u1".to_string(),
            user_message: "hi".to_string(),
            model: Some("grok-build".to_string()),
            execution_mode: Some("build".to_string()),
            thinking_level: None,
            effort_level: None,
            backend: Some(super::super::types::Backend::Grok),
            custom_profile_name: None,
            started_at: 1,
            ended_at: Some(2),
            status: super::super::types::RunStatus::Completed,
            assistant_message_id: Some("a1".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: Some(42),
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
            grok_session_id: Some("grok-hist-1".to_string()),
            kimi_session_id: None,
        };
        let message = parse_grok_run_to_message(&lines, &run).unwrap();
        assert_eq!(message.content, "Survived restart");
        assert_eq!(message.id, "a1");
    }

    #[test]
    fn parse_grok_stream_keeps_steered_user_message_out_of_assistant_text() {
        // Jean writes steered prompts into the same JSONL the host tails.
        // extract_text_delta used to treat `{"type":"steered_user_message","text":...}`
        // as an agent_message_chunk, gluing the steer into the reply.
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Waiting 10 seconds."}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"t-bash","title":"Bash","rawInput":{"command":"sleep 10","variant":"Bash"}}}}
{"type":"steered_user_message","text":"who are you"}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"I'm Grok 4.5"}}}}
"#;
        let response = parse_grok_stream_inner(BufReader::new(input.as_bytes()), None).unwrap();

        assert_eq!(response.content, "Waiting 10 seconds.I'm Grok 4.5");
        assert!(
            !response.content.contains("who are you"),
            "steered prompt must not leak into assistant content blob: {}",
            response.content
        );
        assert_eq!(response.content_blocks.len(), 4);
        assert!(matches!(
            &response.content_blocks[0],
            ContentBlock::Text { text } if text == "Waiting 10 seconds."
        ));
        assert!(matches!(
            &response.content_blocks[1],
            ContentBlock::ToolUse { tool_call_id } if tool_call_id == "t-bash"
        ));
        assert!(matches!(
            &response.content_blocks[2],
            ContentBlock::UserInput { text } if text == "who are you"
        ));
        assert!(matches!(
            &response.content_blocks[3],
            ContentBlock::Text { text } if text == "I'm Grok 4.5"
        ));
    }

    #[test]
    fn parse_grok_run_to_message_preserves_steered_user_messages() {
        let lines = vec![
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Before"}}}}"#.to_string(),
            r#"{"type":"steered_user_message","text":"also check tests"}"#.to_string(),
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"After"}}}}"#.to_string(),
            r#"{"type":"result","session_id":"s"}"#.to_string(),
        ];
        let run = RunEntry {
            run_id: "run-steer".to_string(),
            user_message_id: "u-steer".to_string(),
            user_message: "start".to_string(),
            model: Some("grok-build".to_string()),
            execution_mode: Some("build".to_string()),
            thinking_level: None,
            effort_level: None,
            backend: Some(super::super::types::Backend::Grok),
            custom_profile_name: None,
            started_at: 1,
            ended_at: Some(2),
            status: super::super::types::RunStatus::Completed,
            assistant_message_id: Some("a-steer".to_string()),
            cancelled: false,
            recovered: false,
            claude_session_id: None,
            pid: Some(42),
            usage: None,
            codex_thread_id: None,
            codex_turn_id: None,
            cursor_chat_id: None,
            grok_session_id: Some("s".to_string()),
            kimi_session_id: None,
        };
        let message = parse_grok_run_to_message(&lines, &run).unwrap();
        assert_eq!(message.content, "BeforeAfter");
        assert!(!message.content.contains("also check tests"));
        assert_eq!(message.content_blocks.len(), 3);
        assert!(matches!(
            &message.content_blocks[0],
            ContentBlock::Text { text } if text == "Before"
        ));
        assert!(matches!(
            &message.content_blocks[1],
            ContentBlock::UserInput { text } if text == "also check tests"
        ));
        assert!(matches!(
            &message.content_blocks[2],
            ContentBlock::Text { text } if text == "After"
        ));
    }

    fn grok_acp_idle_lifecycle_keeps_recent_idle_connections_alive() {
        let last_used = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(300);

        assert!(should_keep_grok_acp_connection_alive(
            last_used,
            false,
            last_used + std::time::Duration::from_secs(299),
            timeout,
        ));
        assert!(should_keep_grok_acp_connection_alive(
            last_used,
            true,
            last_used + std::time::Duration::from_secs(301),
            timeout,
        ));
        assert!(!should_keep_grok_acp_connection_alive(
            last_used,
            false,
            last_used + std::time::Duration::from_secs(301),
            timeout,
        ));
    }
}

#[cfg(test)]
mod space_regression_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn line_by_line_tail_parsing_preserves_leading_spaces() {
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"I'll"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" check"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" how"}}}}
"#;
        let mut content = String::new();

        for line in input.lines().filter(|line| !line.is_empty()) {
            let partial = parse_grok_stream_inner(Cursor::new(line.as_bytes()), None).unwrap();
            content.push_str(&partial.content);
        }

        assert_eq!(content, "I'll check how");
    }

    #[test]
    fn grok_agent_message_chunks_preserve_leading_spaces() {
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"I'll"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" add"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" SQ"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Lite"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" backup"}}}}
"#;
        let mut emitted = String::new();
        let response = parse_grok_stream_inner_with_callbacks(
            Cursor::new(input.as_bytes()),
            None,
            |chunk| emitted.push_str(chunk),
            |_| {},
            |_, _| {},
        )
        .unwrap();

        assert_eq!(response.content, "I'll add SQLite backup");
        assert_eq!(emitted, "I'll add SQLite backup");
        assert!(
            !emitted.contains("I'lladd"),
            "emitted stream must keep spaces between tokens: {emitted:?}"
        );
        assert!(
            !response.content.contains("I'lladd"),
            "content must keep spaces between tokens: {:?}",
            response.content
        );
    }

    #[test]
    fn real_style_invoice_chunks_preserve_spaces_through_parser() {
        // Mirrors production Grok ACP fragments from a real invoice reply.
        let input = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"```"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"bash"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"\n"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"bun"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" run"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" process"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":":"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"in"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"voices"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"\n"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"```"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"\n\n"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"**"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Test"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" first"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"**"}}}}
"#;
        let mut emitted = String::new();
        let response = parse_grok_stream_inner_with_callbacks(
            Cursor::new(input.as_bytes()),
            None,
            |chunk| emitted.push_str(chunk),
            |_| {},
            |_, _| {},
        )
        .unwrap();
        assert!(
            response.content.contains("bun run process:invoices"),
            "content missing spaced command: {:?}",
            response.content
        );
        assert!(
            !response.content.contains("bunrunprocess"),
            "content glued: {:?}",
            response.content
        );
        assert!(
            !emitted.contains("bunrunprocess"),
            "emitted glued: {:?}",
            emitted
        );
        assert!(
            response.content.contains("Test first"),
            "missing Test first: {:?}",
            response.content
        );
        assert!(
            !response.content.contains("Testfirst"),
            "Testfirst glued: {:?}",
            response.content
        );
    }

    #[test]
    fn chunk_event_json_preserves_leading_space() {
        let event = ChunkEvent {
            session_id: "s".into(),
            worktree_id: "w".into(),
            content: " add".into(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(
            json.contains("\"content\":\" add\""),
            "JSON must preserve leading space in content: {json}"
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["content"].as_str(), Some(" add"));
    }
}
