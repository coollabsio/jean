//! OpenCode HTTP execution engine (opencode serve).

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

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
pub struct ErrorEvent {
    pub session_id: String,
    pub worktree_id: String,
    pub error: String,
}

/// Response from OpenCode execution.
pub struct OpenCodeResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
}

#[derive(Debug, Clone)]
enum TrackedPartKind {
    Text {
        emitted_len: usize,
    },
    Reasoning {
        emitted_len: usize,
    },
    Tool {
        tool_call_id: String,
        tool_name: String,
        emitted_started: bool,
        last_output: Option<String>,
    },
    Other,
}

#[derive(Debug, Clone)]
struct TrackedPartState {
    session_id: String,
    kind: TrackedPartKind,
}

fn emit_chat_chunk(app: &AppHandle, session_id: &str, worktree_id: &str, content: &str) {
    if content.is_empty() {
        return;
    }

    let _ = app.emit_all(
        "chat:chunk",
        &ChunkEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            content: content.to_string(),
        },
    );
}

fn emit_chat_thinking(app: &AppHandle, session_id: &str, worktree_id: &str, content: &str) {
    if content.is_empty() {
        return;
    }

    let _ = app.emit_all(
        "chat:thinking",
        &ThinkingEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            content: content.to_string(),
        },
    );
}

fn emit_chat_tool_use(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    input: serde_json::Value,
) {
    let _ = app.emit_all(
        "chat:tool_use",
        &ToolUseEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            id: tool_call_id.to_string(),
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
            tool_call_id: tool_call_id.to_string(),
        },
    );
}

fn emit_chat_tool_result(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    tool_call_id: &str,
    output: &str,
) {
    let _ = app.emit_all(
        "chat:tool_result",
        &ToolResultEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            tool_use_id: tool_call_id.to_string(),
            output: output.to_string(),
        },
    );
}

fn unseen_suffix(full_text: &str, emitted_len: usize) -> &str {
    if emitted_len <= full_text.len() && full_text.is_char_boundary(emitted_len) {
        &full_text[emitted_len..]
    } else {
        full_text
    }
}

fn choose_model(all_providers: &serde_json::Value) -> Option<(String, String)> {
    // Best effort: pick first connected provider with first model.
    let connected = all_providers
        .get("connected")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let providers = all_providers
        .get("all")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for provider_id in connected.iter().filter_map(|v| v.as_str()) {
        for provider in &providers {
            if provider.get("id").and_then(|v| v.as_str()) != Some(provider_id) {
                continue;
            }
            if let Some(models) = provider.get("models").and_then(|v| v.as_object()) {
                if let Some((model_id, _)) = models.iter().next() {
                    return Some((provider_id.to_string(), model_id.to_string()));
                }
            }
        }
    }

    for provider in providers {
        let provider_id = match provider.get("id").and_then(|v| v.as_str()) {
            Some(v) => v,
            None => continue,
        };
        let model_id = provider
            .get("models")
            .and_then(|v| v.as_object())
            .and_then(|o| o.keys().next())
            .cloned();
        if let Some(model_id) = model_id {
            return Some((provider_id.to_string(), model_id));
        }
    }

    None
}

fn parse_provider_model(model: Option<&str>) -> Option<(String, String)> {
    let raw = model?.trim();
    if raw.is_empty() {
        return None;
    }

    // Strip "opencode/" prefix if present (e.g. "opencode/ollama/Qwen" → "ollama/Qwen")
    let raw = raw.strip_prefix("opencode/").unwrap_or(raw);
    // Expect provider/model; if not present, let backend pick default.
    let (provider, model_id) = raw.split_once('/')?;
    let provider = provider.trim();
    let model_id = model_id.trim();
    if provider.is_empty() || model_id.is_empty() {
        return None;
    }
    Some((provider.to_string(), model_id.to_string()))
}

/// Returns the bare model ID from a model string (strips `opencode/` prefix if present).
/// Returns `None` if the string is empty.
fn bare_model_id(model: &str) -> Option<&str> {
    let raw = model.trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.strip_prefix("opencode/").unwrap_or(raw))
}

/// Search the provider list for a provider that owns `target_model_id`.
/// Prefers connected providers. Returns `(provider_id, model_id)` or `None`.
pub(crate) fn find_provider_for_model(
    all_providers: &serde_json::Value,
    target_model_id: &str,
) -> Option<(String, String)> {
    let connected = all_providers
        .get("connected")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let providers = all_providers
        .get("all")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Search connected providers first
    for provider_id in connected.iter().filter_map(|v| v.as_str()) {
        for provider in &providers {
            if provider.get("id").and_then(|v| v.as_str()) != Some(provider_id) {
                continue;
            }
            if let Some(models) = provider.get("models").and_then(|v| v.as_object()) {
                if models.contains_key(target_model_id) {
                    return Some((provider_id.to_string(), target_model_id.to_string()));
                }
            }
        }
    }

    // Fall back to any provider
    for provider in &providers {
        let provider_id = match provider.get("id").and_then(|v| v.as_str()) {
            Some(v) => v,
            None => continue,
        };
        if let Some(models) = provider.get("models").and_then(|v| v.as_object()) {
            if models.contains_key(target_model_id) {
                return Some((provider_id.to_string(), target_model_id.to_string()));
            }
        }
    }

    None
}

fn agent_for_execution_mode(execution_mode: Option<&str>) -> &'static str {
    match execution_mode.unwrap_or("plan") {
        "plan" => "plan",
        _ => "build",
    }
}

fn variant_for_effort(reasoning_effort: Option<&str>) -> Option<&'static str> {
    match reasoning_effort {
        Some("xhigh") => Some("max"),
        Some("high") => Some("high"),
        Some("medium") => Some("medium"),
        Some("low") => Some("low"),
        _ => None,
    }
}

/// Build the OpenCode `parts` array by resolving file annotations in the prompt.
///
/// - Image annotations → base64-encoded file parts
/// - Skill annotations → inlined text content
/// - Pasted text annotations → inlined text content
fn prepare_opencode_parts(prompt: &str) -> serde_json::Value {
    let mut cleaned = prompt.to_string();
    let mut image_parts: Vec<serde_json::Value> = Vec::new();

    // Images: extract paths, read binary, base64-encode as file parts
    let image_re = Regex::new(r"\[Image attached: (.+?) - Use the Read tool to view this image\]")
        .expect("Invalid regex");
    for cap in image_re.captures_iter(prompt) {
        let path_str = &cap[1];
        let annotation = &cap[0];
        cleaned = cleaned.replace(annotation, "");

        let file_path = std::path::Path::new(path_str);
        match std::fs::read(file_path) {
            Ok(data) => {
                let mime = match file_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase()
                    .as_str()
                {
                    "jpg" | "jpeg" => "image/jpeg",
                    "gif" => "image/gif",
                    "webp" => "image/webp",
                    _ => "image/png",
                };
                let b64 = STANDARD.encode(&data);
                let filename = file_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("image.png");
                image_parts.push(serde_json::json!({
                    "type": "file",
                    "mime": mime,
                    "url": format!("data:{mime};base64,{b64}"),
                    "filename": filename,
                }));
            }
            Err(e) => {
                log::warn!("OpenCode: failed to read image {path_str}: {e}");
                cleaned.push_str(&format!("\n[Image could not be loaded: {path_str}]"));
            }
        }
    }

    // Skills: read text content and inline
    let skill_re = Regex::new(r"\[Skill: (.+?) - Read and use this skill to guide your response\]")
        .expect("Invalid regex");
    for cap in skill_re.captures_iter(prompt) {
        let path_str = &cap[1];
        let annotation = cap[0].to_string();
        let replacement = match std::fs::read_to_string(path_str) {
            Ok(content) => {
                let name = std::path::Path::new(path_str)
                    .file_stem()
                    .and_then(|n| n.to_str())
                    .unwrap_or("skill");
                format!("<skill name=\"{name}\">\n{content}\n</skill>")
            }
            Err(e) => {
                log::warn!("OpenCode: failed to read skill {path_str}: {e}");
                format!("[Skill could not be loaded: {path_str}]")
            }
        };
        cleaned = cleaned.replace(&annotation, &replacement);
    }

    // Pasted text files: read text content and inline
    let text_re =
        Regex::new(r"\[Text file attached: (.+?) - Use the Read tool to view this file\]")
            .expect("Invalid regex");
    for cap in text_re.captures_iter(prompt) {
        let path_str = &cap[1];
        let annotation = cap[0].to_string();
        let replacement = match std::fs::read_to_string(path_str) {
            Ok(content) => {
                let name = std::path::Path::new(path_str)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("pasted-text");
                format!("<pasted-text name=\"{name}\">\n{content}\n</pasted-text>")
            }
            Err(e) => {
                log::warn!("OpenCode: failed to read text file {path_str}: {e}");
                format!("[Text file could not be loaded: {path_str}]")
            }
        };
        cleaned = cleaned.replace(&annotation, &replacement);
    }

    let cleaned = cleaned.trim().to_string();
    let mut parts = vec![serde_json::json!({ "type": "text", "text": cleaned })];
    parts.extend(image_parts);
    serde_json::Value::Array(parts)
}

// ---------------------------------------------------------------------------
// SSE streaming support (OpenCode global event stream: GET /event)
// ---------------------------------------------------------------------------
//
// OpenCode SSE wire format:
//   data: {"directory":"...","payload":{"type":"message.part","properties":{...}}}
//
// Part types in properties:
//   text       → { id, type:"text", text }
//   tool_call  → { id, type:"tool_call", tool_name, tool_input, tool_call_id, metadata }
//   tool_result→ { id, type:"tool_result", tool_name, tool_output, tool_call_id, metadata }
//   (others: file, agent, subtask)

/// Spawn a background thread that connects to OpenCode's global SSE endpoint
/// (`GET /event`) and emits `chat:*` events in real-time.
///
/// Returns an `Arc<AtomicBool>` that becomes `true` once at least one
/// event has been successfully emitted to the UI.
#[allow(clippy::too_many_arguments)]
fn spawn_sse_listener(
    app: AppHandle,
    base_url: String,
    opencode_session_id: String,
    session_id: String,
    worktree_id: String,
    working_dir: String,
    done_flag: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    sse_ready_tx: std::sync::mpsc::SyncSender<bool>,
) -> Arc<AtomicBool> {
    let sse_active = Arc::new(AtomicBool::new(false));
    let sse_active_clone = sse_active.clone();

    std::thread::Builder::new()
        .name("opencode-sse".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    log::warn!("OpenCode SSE: failed to create tokio runtime: {e}");
                    let _ = sse_ready_tx.send(false);
                    return;
                }
            };

            rt.block_on(sse_listener_loop(
                app,
                base_url,
                opencode_session_id,
                session_id,
                worktree_id,
                working_dir,
                done_flag,
                cancelled,
                sse_active_clone,
                sse_ready_tx,
            ));
        })
        .ok(); // Detach — don't join

    sse_active
}

/// Async loop: connect to `GET /event`, parse SSE, emit `chat:*` events.
#[allow(clippy::too_many_arguments)]
async fn sse_listener_loop(
    app: AppHandle,
    base_url: String,
    opencode_session_id: String,
    session_id: String,
    worktree_id: String,
    working_dir: String,
    done_flag: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    sse_active: Arc<AtomicBool>,
    sse_ready_tx: std::sync::mpsc::SyncSender<bool>,
) {
    let client = match reqwest::Client::builder().no_proxy().build() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("OpenCode SSE: failed to build async client: {e}");
            let _ = sse_ready_tx.send(false);
            return;
        }
    };

    // The global SSE endpoint is GET /event (no directory filter — it broadcasts all events)
    let url = format!("{base_url}/event");
    log::info!("OpenCode SSE: connecting to {url}");
    let query = [("directory", working_dir.clone())];

    let response = match client
        .get(&url)
        .query(&query)
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if content_type.contains("text/event-stream") {
                log::info!("OpenCode SSE: connected (content-type: {content_type})");
                resp
            } else {
                log::info!(
                    "OpenCode SSE: /event returned 200 but content-type='{content_type}' (not SSE)"
                );
                let _ = sse_ready_tx.send(false);
                return;
            }
        }
        Ok(resp) => {
            log::info!("OpenCode SSE: /event returned {}", resp.status());
            let _ = sse_ready_tx.send(false);
            return;
        }
        Err(e) => {
            log::info!("OpenCode SSE: /event connection failed: {e}");
            let _ = sse_ready_tx.send(false);
            return;
        }
    };

    let _ = sse_ready_tx.send(true);

    // Read SSE stream chunk by chunk
    let mut response = response;
    let mut buffer = String::new();
    let mut current_data = String::new();
    let mut total_events_emitted: u64 = 0;
    let mut total_chunks: u64 = 0;
    let mut poll_count: u64 = 0;
    let mut tracked_parts: HashMap<String, TrackedPartState> = HashMap::new();
    let mut last_activity = tokio::time::Instant::now();
    let drain_window = Duration::from_millis(750);

    log::info!(
        "OpenCode SSE: listening for events (opencode_session={opencode_session_id}, directory={working_dir})"
    );

    loop {
        if cancelled.load(Ordering::Relaxed) {
            log::info!(
                "OpenCode SSE: stopping (cancelled), {total_chunks} chunks, \
                 {total_events_emitted} events, {poll_count} polls, buffer_len={}",
                buffer.len()
            );
            if !buffer.is_empty() {
                let preview: String = buffer.chars().take(500).collect();
                log::info!("OpenCode SSE: leftover buffer: {preview}");
            }
            break;
        }

        let draining = done_flag.load(Ordering::Relaxed);
        if draining && last_activity.elapsed() >= drain_window {
            log::info!(
                "OpenCode SSE: stopping after drain window, {total_chunks} chunks, \
                 {total_events_emitted} events, {poll_count} polls, buffer_len={}",
                buffer.len()
            );
            break;
        }

        poll_count += 1;
        let chunk = tokio::select! {
            biased;
            c = response.chunk() => c,
            _ = tokio::time::sleep(if draining {
                Duration::from_millis(100)
            } else {
                Duration::from_millis(500)
            }) => {
                if draining && last_activity.elapsed() >= drain_window {
                    log::info!(
                        "OpenCode SSE: drain window elapsed after {total_chunks} chunks, \
                         {total_events_emitted} events emitted"
                    );
                    break;
                }
                if !draining && poll_count % 4 == 0 {
                    log::info!(
                        "OpenCode SSE: poll #{poll_count} (no data), chunks={total_chunks}, \
                         events={total_events_emitted}, buffer_len={}",
                        buffer.len()
                    );
                }
                continue;
            },
        };

        match chunk {
            Ok(Some(bytes)) => {
                total_chunks += 1;
                last_activity = tokio::time::Instant::now();
                let chunk_str = String::from_utf8_lossy(&bytes);
                let preview: String = chunk_str.chars().take(300).collect();
                log::info!(
                    "OpenCode SSE: chunk #{total_chunks} ({} bytes): {preview}{}",
                    bytes.len(),
                    if chunk_str.len() > 300 { "..." } else { "" }
                );
                buffer.push_str(&chunk_str);

                while let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim_end_matches('\r').to_string();
                    buffer = buffer[newline_pos + 1..].to_string();

                    if line.is_empty() {
                        // Skip event dispatch if cancelled — prevents post-cancel
                        // chunks from leaking to the frontend and re-triggering
                        // streaming state after chat:cancelled was already handled.
                        if cancelled.load(Ordering::Relaxed) {
                            current_data.clear();
                            continue;
                        }
                        // End of SSE event — dispatch
                        if !current_data.is_empty() {
                            if let Some(emitted) = process_sse_event(
                                &app,
                                &current_data,
                                &opencode_session_id,
                                &session_id,
                                &worktree_id,
                                &mut tracked_parts,
                            ) {
                                if emitted {
                                    total_events_emitted += 1;
                                    sse_active.store(true, Ordering::Relaxed);
                                }
                            }
                        }
                        current_data.clear();
                    } else if let Some(data) = line.strip_prefix("data: ") {
                        if !current_data.is_empty() {
                            current_data.push('\n');
                        }
                        current_data.push_str(data);
                    } else if let Some(data) = line.strip_prefix("data:") {
                        if !current_data.is_empty() {
                            current_data.push('\n');
                        }
                        current_data.push_str(data);
                    }
                    // Ignore event:, id:, comments (:), etc.
                }
            }
            Ok(None) => {
                log::info!(
                    "OpenCode SSE: stream ended after {total_chunks} chunks, \
                     {total_events_emitted} events emitted"
                );
                break;
            }
            Err(e) => {
                log::info!("OpenCode SSE: read error after {total_chunks} chunks: {e}");
                break;
            }
        }
    }
}

/// Parse an OpenCode SSE event and emit the appropriate `chat:*` event.
///
/// OpenCode SSE format (flat, no wrapper):
///   `{"type":"message.part","properties":{...}}`
///
/// Returns `Some(true)` if a chat event was emitted, `Some(false)` if the
/// event was recognized but not emittable, `None` if parsing failed.
fn process_sse_event(
    app: &AppHandle,
    data: &str,
    opencode_session_id: &str,
    session_id: &str,
    worktree_id: &str,
    tracked_parts: &mut HashMap<String, TrackedPartState>,
) -> Option<bool> {
    let json: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => {
            log::info!("OpenCode SSE: JSON parse error: {e}, raw: {data}");
            return None;
        }
    };

    // Handle both flat format ({"type":"...","properties":{...}})
    // and wrapped format ({"directory":"...","payload":{"type":"...","properties":{...}}})
    let (event_type, properties) = if let Some(payload) = json.get("payload") {
        // Wrapped format
        let t = payload.get("type")?.as_str()?;
        let p = payload.get("properties").cloned().unwrap_or_default();
        (t.to_string(), p)
    } else {
        // Flat format
        let t = json.get("type")?.as_str()?;
        let p = json.get("properties").cloned().unwrap_or_default();
        (t.to_string(), p)
    };

    let event_type = event_type.as_str();

    match event_type {
        "server.connected" => {
            log::info!("OpenCode SSE: server.connected");
            Some(false)
        }
        "server.heartbeat" => Some(false),

        "message.part.updated" | "message.part" | "message.part.added" => {
            let part = if let Some(part) = properties.get("part") {
                part
            } else {
                &properties
            };
            let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let part_id = part
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let part_session_id = part.get("sessionID").and_then(|v| v.as_str()).unwrap_or("");
            let part_preview: String = part.to_string().chars().take(200).collect();
            log::info!(
                "OpenCode SSE: {event_type} type='{part_type}' session='{part_session_id}' → {part_preview}"
            );

            if part_session_id != opencode_session_id {
                return Some(false);
            }

            match part_type {
                "text" => {
                    let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let suffix = match tracked_parts.get_mut(&part_id) {
                        Some(TrackedPartState {
                            kind: TrackedPartKind::Text { emitted_len },
                            ..
                        }) => {
                            let suffix = unseen_suffix(text, *emitted_len).to_string();
                            *emitted_len = text.len();
                            suffix
                        }
                        _ => {
                            // New text part not previously seen via message.part.delta.
                            // This is likely a user message echo — track it but don't emit.
                            // Assistant text parts are always preceded by delta events.
                            tracked_parts.insert(
                                part_id,
                                TrackedPartState {
                                    session_id: part_session_id.to_string(),
                                    kind: TrackedPartKind::Text {
                                        emitted_len: text.len(),
                                    },
                                },
                            );
                            String::new()
                        }
                    };

                    if !suffix.is_empty() {
                        emit_chat_chunk(app, session_id, worktree_id, &suffix);
                        return Some(true);
                    }
                    Some(false)
                }
                "reasoning" => {
                    let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let suffix = match tracked_parts.get_mut(&part_id) {
                        Some(TrackedPartState {
                            kind: TrackedPartKind::Reasoning { emitted_len },
                            ..
                        }) => {
                            let suffix = unseen_suffix(text, *emitted_len).to_string();
                            *emitted_len = text.len();
                            suffix
                        }
                        Some(TrackedPartState {
                            kind: TrackedPartKind::Text { emitted_len },
                            ..
                        }) => {
                            // Auto-created as Text by delta handler; reclassify
                            // to Reasoning. Early deltas were emitted as chat:chunk
                            // — minor cosmetic issue, but streaming worked.
                            let prev_len = *emitted_len;
                            tracked_parts.insert(
                                part_id,
                                TrackedPartState {
                                    session_id: part_session_id.to_string(),
                                    kind: TrackedPartKind::Reasoning {
                                        emitted_len: text.len(),
                                    },
                                },
                            );
                            unseen_suffix(text, prev_len).to_string()
                        }
                        _ => {
                            // Same as text: don't emit new reasoning parts from
                            // message.part.updated — deltas handle initial streaming.
                            tracked_parts.insert(
                                part_id,
                                TrackedPartState {
                                    session_id: part_session_id.to_string(),
                                    kind: TrackedPartKind::Reasoning {
                                        emitted_len: text.len(),
                                    },
                                },
                            );
                            String::new()
                        }
                    };

                    if !suffix.is_empty() {
                        emit_chat_thinking(app, session_id, worktree_id, &suffix);
                        return Some(true);
                    }
                    Some(false)
                }
                "tool" | "tool_call" => {
                    let tool_name = part
                        .get("tool")
                        .or_else(|| part.get("tool_name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let tool_call_id = part
                        .get("callID")
                        .or_else(|| part.get("tool_call_id"))
                        .and_then(|v| v.as_str())
                        .or_else(|| part.get("id").and_then(|v| v.as_str()))
                        .unwrap_or("tool-call")
                        .to_string();
                    let state = part.get("state").cloned().unwrap_or_default();
                    let input = state
                        .get("input")
                        .or_else(|| part.get("tool_input"))
                        .cloned()
                        .unwrap_or(serde_json::json!({}));
                    let existing_output =
                        tracked_parts
                            .get(&part_id)
                            .and_then(|state| match &state.kind {
                                TrackedPartKind::Tool { last_output, .. } => last_output.clone(),
                                _ => None,
                            });
                    let mut emitted = false;

                    let entry = tracked_parts
                        .entry(part_id)
                        .or_insert_with(|| TrackedPartState {
                            session_id: part_session_id.to_string(),
                            kind: TrackedPartKind::Tool {
                                tool_call_id: tool_call_id.clone(),
                                tool_name: tool_name.clone(),
                                emitted_started: false,
                                last_output: None,
                            },
                        });

                    if entry.session_id != part_session_id {
                        entry.session_id = part_session_id.to_string();
                    }

                    if let TrackedPartKind::Tool {
                        tool_call_id: tracked_call_id,
                        tool_name: tracked_tool_name,
                        emitted_started,
                        last_output,
                    } = &mut entry.kind
                    {
                        *tracked_call_id = tool_call_id.clone();
                        *tracked_tool_name = tool_name.clone();

                        if !*emitted_started {
                            emit_chat_tool_use(
                                app,
                                session_id,
                                worktree_id,
                                &tool_call_id,
                                &tool_name,
                                input,
                            );
                            *emitted_started = true;
                            emitted = true;
                        }

                        let status = state
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let next_output = match status {
                            "completed" => state
                                .get("output")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            "error" => state
                                .get("error")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            _ => None,
                        };

                        if let Some(output) = next_output {
                            if existing_output.as_ref() != Some(&output) {
                                emit_chat_tool_result(
                                    app,
                                    session_id,
                                    worktree_id,
                                    &tool_call_id,
                                    &output,
                                );
                                *last_output = Some(output);
                                emitted = true;
                            }
                        }
                    }

                    Some(emitted)
                }
                _ => {
                    if !part_id.is_empty() {
                        tracked_parts
                            .entry(part_id)
                            .or_insert_with(|| TrackedPartState {
                                session_id: part_session_id.to_string(),
                                kind: TrackedPartKind::Other,
                            });
                    }
                    log::info!(
                        "OpenCode SSE: unknown part type '{part_type}', properties={part_preview}"
                    );
                    Some(false)
                }
            }
        }
        "message.part.delta" => {
            let delta_session_id = properties
                .get("sessionID")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if delta_session_id != opencode_session_id {
                return Some(false);
            }

            let part_id = properties
                .get("partID")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let field = properties
                .get("field")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let delta = properties
                .get("delta")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if part_id.is_empty() || delta.is_empty() {
                return Some(false);
            }

            match tracked_parts.get_mut(part_id) {
                Some(TrackedPartState {
                    kind: TrackedPartKind::Text { emitted_len },
                    ..
                }) if field == "text" => {
                    *emitted_len += delta.len();
                    emit_chat_chunk(app, session_id, worktree_id, delta);
                    Some(true)
                }
                Some(TrackedPartState {
                    kind: TrackedPartKind::Reasoning { emitted_len },
                    ..
                }) if field == "text" => {
                    *emitted_len += delta.len();
                    emit_chat_thinking(app, session_id, worktree_id, delta);
                    Some(true)
                }
                Some(TrackedPartState {
                    kind:
                        TrackedPartKind::Tool {
                            tool_call_id,
                            last_output,
                            ..
                        },
                    ..
                }) if field.contains("output") => {
                    let mut next_output = last_output.clone().unwrap_or_default();
                    next_output.push_str(delta);
                    *last_output = Some(next_output.clone());
                    emit_chat_tool_result(app, session_id, worktree_id, tool_call_id, &next_output);
                    Some(true)
                }
                _ => {
                    // Delta arrived before message.part.updated — auto-create
                    // tracking entry and emit immediately so streaming works.
                    match field {
                        "text" => {
                            // Cannot distinguish text vs reasoning from delta alone;
                            // default to Text. If message.part.updated later reveals
                            // reasoning, the handler reclassifies and unseen_suffix
                            // prevents duplicate emission.
                            tracked_parts.insert(
                                part_id.to_string(),
                                TrackedPartState {
                                    session_id: delta_session_id.to_string(),
                                    kind: TrackedPartKind::Text {
                                        emitted_len: delta.len(),
                                    },
                                },
                            );
                            emit_chat_chunk(app, session_id, worktree_id, delta);
                            Some(true)
                        }
                        f if f.contains("output") => {
                            // Tool output delta without a prior tool tracking entry.
                            // Can't emit tool_result without tool_call_id — defer.
                            log::info!(
                                "OpenCode SSE: tool output delta for untracked part_id='{part_id}', deferring"
                            );
                            Some(false)
                        }
                        _ => {
                            log::info!(
                                "OpenCode SSE: delta for unknown part part_id='{part_id}' field='{field}'"
                            );
                            Some(false)
                        }
                    }
                }
            }
        }

        "message.created" => {
            log::info!(
                "OpenCode SSE: message.created, role={:?}",
                properties.get("role").and_then(|v| v.as_str())
            );
            Some(false)
        }

        "session.updated" => {
            log::info!(
                "OpenCode SSE: session.updated id={:?}",
                properties
                    .get("info")
                    .and_then(|info| info.get("id"))
                    .and_then(|v| v.as_str())
                    .or_else(|| properties.get("id").and_then(|v| v.as_str()))
            );
            Some(false)
        }

        _ => {
            log::info!("OpenCode SSE: event type='{event_type}'");
            Some(false)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn execute_opencode_http(
    app: &tauri::AppHandle,
    session_id: &str,
    worktree_id: &str,
    working_dir: &std::path::Path,
    existing_opencode_session_id: Option<&str>,
    model: Option<&str>,
    execution_mode: Option<&str>,
    reasoning_effort: Option<&str>,
    prompt: &str,
    system_prompt: Option<&str>,
    cancelled: &Arc<AtomicBool>,
) -> Result<OpenCodeResponse, String> {
    // Check for cancellation before doing any work
    if cancelled.load(Ordering::SeqCst) {
        return Ok(OpenCodeResponse {
            content: String::new(),
            session_id: existing_opencode_session_id.unwrap_or("").to_string(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            usage: None,
        });
    }

    let base_url = crate::opencode_server::acquire(app)?;

    // RAII guard: decrements the server usage count when this function exits.
    // The server only shuts down when the last consumer releases.
    struct ServerReleaseGuard;
    impl Drop for ServerReleaseGuard {
        fn drop(&mut self) {
            crate::opencode_server::release();
        }
    }
    let _server_guard = ServerReleaseGuard;

    // 30 min timeout — OpenCode agentic tasks can run for extended periods
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| format!("Failed to build OpenCode HTTP client: {e}"))?;

    let query = [("directory", working_dir.to_string_lossy().to_string())];

    let opencode_session_id = if let Some(existing) = existing_opencode_session_id {
        existing.to_string()
    } else {
        let create_url = format!("{base_url}/session");
        let create_payload = serde_json::json!({
            "title": format!("Jean {session_id}"),
        });
        let create_resp = client
            .post(&create_url)
            .query(&query)
            .json(&create_payload)
            .send()
            .map_err(|e| format!("Failed to create OpenCode session: {e}"))?;

        if !create_resp.status().is_success() {
            let status = create_resp.status();
            let body = create_resp.text().unwrap_or_default();
            return Err(format!(
                "OpenCode session create failed: status={status}, body={body}"
            ));
        }

        let created: serde_json::Value = create_resp
            .json()
            .map_err(|e| format!("Failed to parse OpenCode session create response: {e}"))?;

        created
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("OpenCode session create response missing id")?
            .to_string()
    };

    // Update the cancel flag registry with the OpenCode session ID so that
    // cancel_process() can send a server-side interrupt request.
    super::registry::update_cancel_flag_session_id(session_id, opencode_session_id.clone());

    let selected_model = if let Some(pm) = parse_provider_model(model) {
        pm
    } else {
        let providers_url = format!("{base_url}/provider");
        let providers_resp = client
            .get(&providers_url)
            .query(&query)
            .send()
            .map_err(|e| format!("Failed to query OpenCode providers: {e}"))?;
        if !providers_resp.status().is_success() {
            let status = providers_resp.status();
            let body = providers_resp.text().unwrap_or_default();
            return Err(format!(
                "OpenCode provider query failed: status={status}, body={body}"
            ));
        }
        let providers: serde_json::Value = providers_resp
            .json()
            .map_err(|e| format!("Failed to parse OpenCode providers response: {e}"))?;

        // Try to find the bare model ID across providers before picking any random model
        model
            .and_then(bare_model_id)
            .and_then(|bare| find_provider_for_model(&providers, bare))
            .or_else(|| choose_model(&providers))
            .ok_or("No OpenCode models available. Authenticate a provider first.")?
    };

    // Check for cancellation before sending the (potentially long-running) message request
    if cancelled.load(Ordering::SeqCst) {
        return Ok(OpenCodeResponse {
            content: String::new(),
            session_id: opencode_session_id,
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            usage: None,
        });
    }

    // --- SSE streaming: spawn a background listener before sending POST ---
    let done_flag = Arc::new(AtomicBool::new(false));
    let (sse_ready_tx, sse_ready_rx) = std::sync::mpsc::sync_channel::<bool>(1);

    let sse_active = spawn_sse_listener(
        app.clone(),
        base_url.clone(),
        opencode_session_id.clone(),
        session_id.to_string(),
        worktree_id.to_string(),
        working_dir.to_string_lossy().to_string(),
        done_flag.clone(),
        cancelled.clone(),
        sse_ready_tx,
    );

    // Wait up to 3 seconds for SSE to signal ready (connected or failed)
    let sse_connected = sse_ready_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap_or(false);

    if sse_connected {
        log::info!("OpenCode: SSE streaming active, events will stream in real-time");
    } else {
        log::info!("OpenCode: SSE not available, will emit events from POST response");
    }

    let msg_url = format!("{base_url}/session/{opencode_session_id}/message");

    let mut payload = serde_json::json!({
        "agent": agent_for_execution_mode(execution_mode),
        "model": {
            "providerID": selected_model.0,
            "modelID": selected_model.1,
        },
        "parts": prepare_opencode_parts(prompt),
    });

    if let Some(v) = variant_for_effort(reasoning_effort) {
        payload["variant"] = serde_json::Value::String(v.to_string());
    }
    if let Some(system) = system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        payload["system"] = serde_json::Value::String(system.to_string());
    }

    // Retry once on connection-level errors (server temporarily unreachable).
    let response = match client.post(&msg_url).query(&query).json(&payload).send() {
        Ok(resp) => resp,
        Err(e) if e.is_connect() || e.is_request() => {
            log::warn!("OpenCode message connection error, retrying in 2s: {e}");
            std::thread::sleep(std::time::Duration::from_secs(2));
            client
                .post(&msg_url)
                .query(&query)
                .json(&payload)
                .send()
                .map_err(|e| format!("Failed to send OpenCode message: {e}"))?
        }
        Err(e) => return Err(format!("Failed to send OpenCode message: {e}")),
    };

    if !response.status().is_success() {
        done_flag.store(true, Ordering::Relaxed);
        let status = response.status();
        let body = response.text().unwrap_or_default();
        let error = format!("OpenCode message failed: status={status}, body={body}");
        let _ = app.emit_all(
            "chat:error",
            &ErrorEvent {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                error: error.clone(),
            },
        );
        return Err(error);
    }

    let response_json: serde_json::Value = response
        .json()
        .map_err(|e| format!("Failed to parse OpenCode message response: {e}"))?;

    // Let the SSE listener drain any trailing events before deciding whether
    // the POST response needs to synthesize the stream.
    std::thread::sleep(Duration::from_millis(200));

    // Check if SSE successfully streamed events — if so, skip emitting from
    // the POST response to avoid duplicates. The POST response is still parsed
    // to build the return value (content, tool_calls, content_blocks, usage).
    let streamed_via_sse = sse_active.load(Ordering::Relaxed);
    log::info!(
        "OpenCode: POST response received, streamed_via_sse={streamed_via_sse}, \
         will {} events from POST response",
        if streamed_via_sse {
            "SKIP emitting"
        } else {
            "EMIT"
        }
    );

    let mut content = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut content_blocks: Vec<ContentBlock> = Vec::new();
    let mut usage: Option<UsageData> = None;

    let parts = response_json
        .get("parts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for part in parts {
        match part.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        if !content.is_empty() {
                            content.push_str("\n\n");
                        }
                        content.push_str(text);
                        content_blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
                        if !streamed_via_sse {
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
            Some("reasoning") => {
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    content_blocks.push(ContentBlock::Thinking {
                        thinking: text.to_string(),
                    });
                    if !streamed_via_sse {
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
            }
            Some("tool") => {
                let tool_name = part
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let tool_call_id = part
                    .get("callID")
                    .and_then(|v| v.as_str())
                    .or_else(|| part.get("id").and_then(|v| v.as_str()))
                    .unwrap_or("tool-call")
                    .to_string();
                let state = part.get("state").cloned().unwrap_or_default();
                let input = state.get("input").cloned().unwrap_or(serde_json::json!({}));

                tool_calls.push(ToolCall {
                    id: tool_call_id.clone(),
                    name: tool_name.clone(),
                    input: input.clone(),
                    output: None,
                    parent_tool_use_id: None,
                });
                content_blocks.push(ContentBlock::ToolUse {
                    tool_call_id: tool_call_id.clone(),
                });

                if !streamed_via_sse {
                    let _ = app.emit_all(
                        "chat:tool_use",
                        &ToolUseEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            id: tool_call_id.clone(),
                            name: tool_name,
                            input,
                            parent_tool_use_id: None,
                        },
                    );
                    let _ = app.emit_all(
                        "chat:tool_block",
                        &ToolBlockEvent {
                            session_id: session_id.to_string(),
                            worktree_id: worktree_id.to_string(),
                            tool_call_id: tool_call_id.clone(),
                        },
                    );
                }

                let status = state
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let maybe_output = match status {
                    "completed" => state
                        .get("output")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    "error" => state
                        .get("error")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    _ => None,
                };

                if let Some(output) = maybe_output {
                    if let Some(call) = tool_calls.iter_mut().find(|t| t.id == tool_call_id) {
                        call.output = Some(output.clone());
                    }
                    if !streamed_via_sse {
                        let _ = app.emit_all(
                            "chat:tool_result",
                            &ToolResultEvent {
                                session_id: session_id.to_string(),
                                worktree_id: worktree_id.to_string(),
                                tool_use_id: tool_call_id,
                                output,
                            },
                        );
                    }
                }
            }
            Some("step-finish") => {
                let tokens = part.get("tokens").cloned().unwrap_or_default();
                let input = tokens.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
                let output = tokens.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache = tokens.get("cache").cloned().unwrap_or_default();
                let cache_read = cache.get("read").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_write = cache.get("write").and_then(|v| v.as_u64()).unwrap_or(0);
                usage = Some(UsageData {
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_input_tokens: cache_read,
                    cache_creation_input_tokens: cache_write,
                });
            }
            _ => {}
        }
    }

    // Check for cancellation before emitting chat:done — if the user cancelled
    // while we were parsing the response, suppress the done event to avoid stale UI updates.
    if cancelled.load(Ordering::SeqCst) {
        done_flag.store(true, Ordering::Relaxed);
        return Ok(OpenCodeResponse {
            content,
            session_id: opencode_session_id,
            tool_calls,
            content_blocks,
            cancelled: true,
            usage,
        });
    }

    let _ = app.emit_all(
        "chat:done",
        &DoneEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            waiting_for_plan: execution_mode == Some("plan") && !content.is_empty(),
        },
    );
    done_flag.store(true, Ordering::Relaxed);

    Ok(OpenCodeResponse {
        content,
        session_id: opencode_session_id,
        tool_calls,
        content_blocks,
        cancelled: false,
        usage,
    })
}

/// Execute a one-shot OpenCode call and return the text response.
///
/// Used by magic prompt commands (digest, commit, PR, review, etc.) when an
/// OpenCode model is selected. Starts the managed server, creates a temporary
/// session, sends the prompt, and returns the concatenated text output.
///
/// All HTTP work runs on a dedicated OS thread because `reqwest::blocking`
/// panics when called inside a Tokio async runtime (which Tauri async commands use).
pub fn execute_one_shot_opencode(
    app: &tauri::AppHandle,
    prompt: &str,
    model: &str,
    json_schema: Option<&str>,
    working_dir: Option<&std::path::Path>,
    reasoning_effort: Option<&str>,
) -> Result<String, String> {
    // Own all data for the spawned thread
    let app = app.clone();
    let model = model.to_string();
    let prompt = prompt.to_string();
    let reasoning = reasoning_effort.map(|s| s.to_string());
    // Parse the JSON schema string into a Value for the native `format` field
    let schema_value: Option<serde_json::Value> = json_schema
        .map(|s| serde_json::from_str(s))
        .transpose()
        .map_err(|e| format!("Invalid JSON schema: {e}"))?;
    let dir = working_dir
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_string_lossy()
        .to_string();

    // Run ALL blocking work (including server startup with reqwest health checks)
    // on a dedicated OS thread to avoid panicking reqwest::blocking inside
    // the Tokio async runtime that Tauri async commands use.
    let handle = std::thread::spawn(move || {
        let base_url = crate::opencode_server::acquire(&app)?;
        let result = one_shot_opencode_blocking(
            &base_url,
            &prompt,
            &model,
            schema_value.as_ref(),
            &dir,
            reasoning.as_deref(),
        );
        crate::opencode_server::release();
        result
    });

    handle
        .join()
        .map_err(|_| "OpenCode one-shot thread panicked".to_string())?
}

/// Blocking HTTP logic for one-shot OpenCode calls (runs on a dedicated OS thread).
fn one_shot_opencode_blocking(
    base_url: &str,
    prompt: &str,
    model: &str,
    json_schema: Option<&serde_json::Value>,
    dir: &str,
    reasoning_effort: Option<&str>,
) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("Failed to build OpenCode HTTP client: {e}"))?;

    let query = [("directory", dir.to_string())];

    // Create a temporary session
    let create_url = format!("{base_url}/session");
    let create_payload = serde_json::json!({ "title": "Jean one-shot" });
    let create_resp = client
        .post(&create_url)
        .query(&query)
        .json(&create_payload)
        .send()
        .map_err(|e| format!("Failed to create OpenCode session: {e}"))?;
    if !create_resp.status().is_success() {
        let status = create_resp.status();
        let body = create_resp.text().unwrap_or_default();
        return Err(format!(
            "OpenCode session create failed: status={status}, body={body}"
        ));
    }
    let created: serde_json::Value = create_resp
        .json()
        .map_err(|e| format!("Failed to parse OpenCode session response: {e}"))?;
    let session_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("OpenCode session create response missing id")?
        .to_string();

    // Resolve provider/model
    let selected_model = if let Some(pm) = parse_provider_model(Some(model)) {
        pm
    } else {
        let providers_url = format!("{base_url}/provider");
        let providers_resp = client
            .get(&providers_url)
            .query(&query)
            .send()
            .map_err(|e| format!("Failed to query OpenCode providers: {e}"))?;
        if !providers_resp.status().is_success() {
            let status = providers_resp.status();
            let body = providers_resp.text().unwrap_or_default();
            return Err(format!(
                "OpenCode provider query failed: status={status}, body={body}"
            ));
        }
        let providers: serde_json::Value = providers_resp
            .json()
            .map_err(|e| format!("Failed to parse OpenCode providers response: {e}"))?;
        // Try to find the bare model ID across providers before picking any random model
        bare_model_id(model)
            .and_then(|bare| find_provider_for_model(&providers, bare))
            .or_else(|| choose_model(&providers))
            .ok_or("No OpenCode models available. Authenticate a provider first.")?
    };

    // Send the prompt
    let msg_url = format!("{base_url}/session/{session_id}/message");
    let mut payload = serde_json::json!({
        "agent": "plan",
        "model": {
            "providerID": selected_model.0,
            "modelID": selected_model.1,
        },
        "parts": prepare_opencode_parts(prompt),
    });

    // Add reasoning effort if specified
    if let Some(effort) = reasoning_effort {
        payload["reasoning_effort"] = serde_json::Value::String(effort.to_string());
    }

    // Use OpenCode's native structured output support via the `format` field
    if let Some(schema) = json_schema {
        payload["format"] = serde_json::json!({
            "type": "json_schema",
            "schema": schema,
        });
    }

    // Retry once on connection-level errors (server temporarily unreachable).
    let response = match client.post(&msg_url).query(&query).json(&payload).send() {
        Ok(resp) => resp,
        Err(e) if e.is_connect() || e.is_request() => {
            log::warn!("OpenCode one-shot connection error, retrying in 2s: {e}");
            std::thread::sleep(std::time::Duration::from_secs(2));
            client
                .post(&msg_url)
                .query(&query)
                .json(&payload)
                .send()
                .map_err(|e| format!("Failed to send OpenCode message: {e}"))?
        }
        Err(e) => return Err(format!("Failed to send OpenCode message: {e}")),
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "OpenCode one-shot failed: status={status}, body={body}"
        ));
    }

    let response_json: serde_json::Value = response
        .json()
        .map_err(|e| format!("Failed to parse OpenCode response: {e}"))?;

    // When using json_schema format, the structured output is in info.structured
    if json_schema.is_some() {
        if let Some(structured) = response_json.get("info").and_then(|i| i.get("structured")) {
            if !structured.is_null() {
                return Ok(structured.to_string());
            }
        }
        // Check for structured output error
        if let Some(error) = response_json.get("info").and_then(|i| i.get("error")) {
            let error_name = error
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let error_msg = error
                .get("data")
                .and_then(|d| d.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("Structured output failed");
            return Err(format!("OpenCode {error_name}: {error_msg}"));
        }
    }

    // Fall back to concatenating text parts (for non-schema responses)
    let parts = response_json
        .get("parts")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut content = String::new();
    for part in parts {
        if part.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    content.push_str("\n\n");
                }
                content.push_str(text);
            }
        }
    }

    if content.trim().is_empty() {
        return Err("Empty response from OpenCode".to_string());
    }

    // Strip markdown code fences if the model wrapped JSON in ```json ... ```
    let trimmed = content.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim()
        .strip_suffix("```")
        .unwrap_or(trimmed)
        .trim();

    Ok(stripped.to_string())
}
