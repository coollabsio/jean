//! OpenCode HTTP execution engine (opencode serve).

use super::types::{ContentBlock, ToolCall, UsageData};
use crate::http_server::EmitExt;
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;

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

    // Expect provider/model; if not present, let backend pick default.
    let (provider, model_id) = raw.split_once('/')?;
    let provider = provider.trim();
    let model_id = model_id.trim();
    if provider.is_empty() || model_id.is_empty() {
        return None;
    }
    Some((provider.to_string(), model_id.to_string()))
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
        Some("high") | Some("medium") => Some("high"),
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
    let image_re =
        Regex::new(r"\[Image attached: (.+?) - Use the Read tool to view this image\]")
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
    let skill_re =
        Regex::new(r"\[Skill: (.+?) - Read and use this skill to guide your response\]")
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
) -> Result<OpenCodeResponse, String> {
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

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
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

        choose_model(&providers)
            .ok_or("No OpenCode models available. Authenticate a provider first.")?
    };

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

    let response = client
        .post(msg_url)
        .query(&query)
        .json(&payload)
        .send()
        .map_err(|e| format!("Failed to send OpenCode message: {e}"))?;

    if !response.status().is_success() {
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
                        content.push_str(text);
                        content_blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
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
            Some("reasoning") => {
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    content_blocks.push(ContentBlock::Thinking {
                        thinking: text.to_string(),
                    });
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

    let _ = app.emit_all(
        "chat:done",
        &DoneEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
        },
    );

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
) -> Result<String, String> {
    // Own all data for the spawned thread
    let app = app.clone();
    let model = model.to_string();
    let prompt = prompt.to_string();
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
        let result =
            one_shot_opencode_blocking(&base_url, &prompt, &model, schema_value.as_ref(), &dir);
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
) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
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
        choose_model(&providers)
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

    // Use OpenCode's native structured output support via the `format` field
    if let Some(schema) = json_schema {
        payload["format"] = serde_json::json!({
            "type": "json_schema",
            "schema": schema,
        });
    }

    let response = client
        .post(&msg_url)
        .query(&query)
        .json(&payload)
        .send()
        .map_err(|e| format!("Failed to send OpenCode message: {e}"))?;

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
