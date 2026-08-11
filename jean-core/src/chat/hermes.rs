//! Hermes Agent chat execution via the OpenAI-compatible API server.
//!
//! MVP: non-streaming chat completions after ensuring the gateway is up.
//! Hermes runs tools server-side; Jean maps the final assistant text (+ usage
//! / resume id) into the common chat events and run log.

use super::types::{
    ChatMessage, ContentBlock, EffortLevel, MessageRole, ThinkingLevel, ToolCall, UsageData,
};
use crate::hermes_cli::parse_hermes_model_selection;
use crate::hermes_cli::{
    connection_config_from_prefs, ensure_gateway_running, selected_model_from_prefs, HermesClient,
};
use crate::http_server::EmitExt;
use serde_json::{json, Value};
use tauri::AppHandle;

#[derive(Debug, Clone)]
pub struct HermesResponse {
    pub content: String,
    pub session_id: String,
    pub tool_calls: Vec<ToolCall>,
    pub content_blocks: Vec<ContentBlock>,
    pub cancelled: bool,
    pub usage: Option<UsageData>,
    pub error: Option<String>,
}

pub struct HermesExecutionOptions<'a> {
    pub app: &'a AppHandle,
    pub jean_session_id: &'a str,
    pub worktree_id: &'a str,
    pub worktree_path: &'a str,
    pub message: &'a str,
    pub system_prompt: Option<&'a str>,
    pub model: Option<&'a str>,
    pub hermes_session_id: Option<&'a str>,
    /// Jean effort control (preferred). Hermes API: model_options.reasoning_effort.
    pub effort_level: Option<&'a EffortLevel>,
    /// Legacy thinking control — used only when effort_level is unset.
    pub thinking_level: Option<&'a ThinkingLevel>,
}

/// Frontend `ChunkEvent` / `DoneEvent` / `ErrorEvent` use snake_case field names.
/// Emitting camelCase (sessionId/chunk) leaves the UI stuck in "sending" forever.
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
    /// Authoritative final text (frontend prefers this over streamed chunks).
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct ErrorEvent {
    session_id: String,
    worktree_id: String,
    error: String,
}

fn emit_chunk(app: &AppHandle, session_id: &str, worktree_id: &str, content: &str) {
    let _ = app.emit_all(
        "chat:chunk",
        &ChunkEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            content: content.to_string(),
            run_id: None,
        },
    );
}

fn emit_done(app: &AppHandle, session_id: &str, worktree_id: &str, content: Option<&str>) {
    let _ = app.emit_all(
        "chat:done",
        &DoneEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            waiting_for_plan: false,
            content: content.map(str::to_string),
        },
    );
}

fn emit_error(app: &AppHandle, session_id: &str, worktree_id: &str, error: &str) {
    let _ = app.emit_all(
        "chat:error",
        &ErrorEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            error: error.to_string(),
        },
    );
}

/// Stable memory / conversation scope for Hermes (independent of rotating transcript ids).
pub fn jean_hermes_session_key(worktree_id: &str, jean_session_id: &str) -> String {
    format!("jean:{worktree_id}:{jean_session_id}")
}

/// Hermes API accepts: none | minimal | low | medium | high | xhigh.
///
/// Returns `Some(effort)` to force a level, or `None` to omit (gateway default /
/// Jean Adaptive).
pub fn resolve_hermes_reasoning_effort(
    effort: Option<&EffortLevel>,
    thinking: Option<&ThinkingLevel>,
) -> Option<&'static str> {
    if let Some(effort) = effort {
        return match effort {
            EffortLevel::Off => Some("none"),
            // Adaptive = leave gateway/model default (omit model_options).
            EffortLevel::Adaptive => None,
            EffortLevel::Minimal => Some("minimal"),
            EffortLevel::Low => Some("low"),
            EffortLevel::Medium => Some("medium"),
            EffortLevel::High => Some("high"),
            // Hermes has no max/ultracode — collapse to xhigh.
            EffortLevel::Xhigh | EffortLevel::Max | EffortLevel::Ultracode => Some("xhigh"),
            EffortLevel::Other(value) => match value.as_str() {
                "none" | "off" => Some("none"),
                "minimal" => Some("minimal"),
                "low" => Some("low"),
                "medium" => Some("medium"),
                "high" => Some("high"),
                "xhigh" | "max" | "ultracode" | "ultra" => Some("xhigh"),
                _ => None,
            },
        };
    }

    // Fallback for sessions still on Claude-style thinking levels.
    match thinking {
        None => None,
        Some(ThinkingLevel::Off) => Some("none"),
        Some(ThinkingLevel::Adaptive) => None,
        Some(ThinkingLevel::Think) => Some("medium"),
        Some(ThinkingLevel::Megathink) => Some("high"),
        Some(ThinkingLevel::Ultrathink) => Some("xhigh"),
        Some(ThinkingLevel::Other(value)) => match value.as_str() {
            "none" | "off" => Some("none"),
            "think" | "low" => Some("low"),
            "medium" => Some("medium"),
            "megathink" | "high" => Some("high"),
            "ultrathink" | "xhigh" => Some("xhigh"),
            _ => None,
        },
    }
}

fn hermes_model_options_for_effort(effort: Option<&str>) -> Option<Value> {
    let effort = effort?;
    if effort == "none" {
        return Some(json!({
            "reasoning_effort": "none",
            "reasoning": { "enabled": false }
        }));
    }
    Some(json!({
        "reasoning_effort": effort,
        "reasoning": { "enabled": true, "effort": effort }
    }))
}

/// Execute one Hermes turn. Ensures local gateway is running first.
pub fn execute_hermes(options: HermesExecutionOptions<'_>) -> Result<HermesResponse, String> {
    let HermesExecutionOptions {
        app,
        jean_session_id,
        worktree_id,
        worktree_path,
        message,
        system_prompt,
        model,
        hermes_session_id,
        effort_level,
        thinking_level,
    } = options;

    let reasoning_effort = resolve_hermes_reasoning_effort(effort_level, thinking_level);

    // Block on async ensure + HTTP in a nested runtime-friendly way.
    let result = tauri::async_runtime::block_on(async {
        ensure_gateway_running(app).await?;
        run_chat_completion(
            app,
            jean_session_id,
            worktree_id,
            worktree_path,
            message,
            system_prompt,
            model,
            hermes_session_id,
            reasoning_effort,
        )
        .await
    })?;
    Ok(result)
}

async fn run_chat_completion(
    app: &AppHandle,
    jean_session_id: &str,
    worktree_id: &str,
    worktree_path: &str,
    message: &str,
    system_prompt: Option<&str>,
    model: Option<&str>,
    hermes_session_id: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<HermesResponse, String> {
    let config = connection_config_from_prefs(app);
    if config.api_key.as_ref().is_none_or(|k| k.trim().is_empty()) {
        return Err(
            "Hermes API key missing. Set it in Settings, or ensure API_SERVER_KEY is in ~/.hermes/.env"
                .into(),
        );
    }
    let client = HermesClient::new(config)?;
    let raw_model = model
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| selected_model_from_prefs(app));
    // Jean wire id `hermes/{provider}/{model}` → Hermes API fields.
    // Sending `provider` is required so bare model names are not ignored.
    let (provider, model_id) = parse_hermes_model_selection(&raw_model);

    let mut transcript = super::run_log::load_session_messages(app, jean_session_id)
        .map_err(|error| format!("Failed to load Hermes conversation history: {error}"))?;
    if !transcript
        .last()
        .is_some_and(|entry| entry.role == MessageRole::User && entry.content == message)
    {
        transcript.push(ChatMessage {
            role: MessageRole::User,
            content: message.to_string(),
            ..Default::default()
        });
    }
    let messages = build_messages(system_prompt, worktree_path, jean_session_id, &transcript);

    let mut body = json!({
        "model": model_id,
        "messages": messages,
        "stream": false,
    });
    if let Some(provider) = provider {
        body["provider"] = json!(provider);
    }
    if let Some(model_options) = hermes_model_options_for_effort(reasoning_effort) {
        body["model_options"] = model_options;
    }

    let session_key = jean_hermes_session_key(worktree_id, jean_session_id);

    let result = client
        .chat_completions(body, hermes_session_id, Some(&session_key))
        .await?;

    // Prefer Hermes continuity id from headers; body may also carry it.
    let resume_id = result
        .session_id
        .filter(|s| !s.is_empty())
        .or_else(|| extract_session_id_from_body(&result.body))
        .unwrap_or_default();

    if let Some(err) = hermes_hard_error(&result.body, result.error_header.as_deref()) {
        // Soft-fail paths still include assistant text; only hard-fail when empty.
        let text = extract_assistant_text(&result.body).unwrap_or_default();
        if text.trim().is_empty() {
            emit_error(app, jean_session_id, worktree_id, &err);
            // Always pair error with done-clearing path via error_emitted on the
            // UnifiedResponse; chat:error handler also clears sending state.
            return Ok(HermesResponse {
                content: String::new(),
                session_id: resume_id,
                tool_calls: vec![],
                content_blocks: vec![],
                cancelled: false,
                usage: extract_usage(&result.body),
                error: Some(err),
            });
        }
        // Partial/failed with recoverable text — surface text to the user.
        log::warn!("[Hermes] completed with error but text present: {err}");
    }

    let content = extract_assistant_text(&result.body).unwrap_or_default();
    let usage = extract_usage(&result.body);

    if content.trim().is_empty() {
        let detail = result
            .error_header
            .clone()
            .or_else(|| extract_hermes_error_field(&result.body))
            .unwrap_or_else(|| "Hermes returned an empty assistant message".to_string());
        emit_error(app, jean_session_id, worktree_id, &detail);
        return Ok(HermesResponse {
            content: String::new(),
            session_id: resume_id,
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: false,
            usage,
            error: Some(detail),
        });
    }

    // One synthetic final chunk (final-output backends pattern) + done with
    // authoritative content so the UI clears sending and shows the message.
    emit_chunk(app, jean_session_id, worktree_id, &content);
    emit_done(app, jean_session_id, worktree_id, Some(&content));

    Ok(HermesResponse {
        content: content.clone(),
        session_id: resume_id,
        tool_calls: vec![],
        content_blocks: vec![ContentBlock::Text { text: content }],
        cancelled: false,
        usage,
        error: None,
    })
}

fn build_messages(
    system_prompt: Option<&str>,
    worktree_path: &str,
    jean_session_id: &str,
    transcript: &[ChatMessage],
) -> Vec<Value> {
    let mut messages = Vec::new();
    if let Some(system) = system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        // Layer Jean context; Hermes keeps its own tools/skills.
        let layered = format!(
            "{system}\n\nWorking directory: {worktree_path}\nJean session: {jean_session_id}\nPrefer tools and file operations under the working directory unless the user asks otherwise."
        );
        messages.push(json!({"role": "system", "content": layered}));
    } else {
        messages.push(json!({
            "role": "system",
            "content": format!(
                "Working directory: {worktree_path}\nJean session: {jean_session_id}\nPrefer tools and file operations under the working directory unless the user asks otherwise."
            )
        }));
    }
    messages.extend(transcript.iter().map(|entry| {
        let role = match entry.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
        };
        // Prefer plain text; if content is empty but blocks have text, use those.
        let content = if !entry.content.is_empty() {
            entry.content.clone()
        } else {
            entry
                .content_blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    ContentBlock::Thinking { thinking } => Some(thinking.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        json!({"role": role, "content": content})
    }));
    messages
}

/// Extract assistant-visible text from OpenAI-compatible (and Hermes-variant) payloads.
fn extract_assistant_text(value: &Value) -> Option<String> {
    // Standard chat.completion
    if let Some(text) = value
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|choice| {
            choice
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(content_value_to_text)
                .or_else(|| {
                    choice
                        .get("delta")
                        .and_then(|d| d.get("content"))
                        .and_then(content_value_to_text)
                })
                .or_else(|| choice.get("text").and_then(content_value_to_text))
        })
    {
        if !text.trim().is_empty() {
            return Some(text);
        }
    }

    // Responses API-ish / Hermes session chat shapes
    if let Some(text) = value
        .get("output_text")
        .and_then(content_value_to_text)
        .filter(|t| !t.trim().is_empty())
    {
        return Some(text);
    }
    if let Some(text) = value
        .get("output")
        .and_then(content_value_to_text)
        .filter(|t| !t.trim().is_empty())
    {
        return Some(text);
    }
    if let Some(text) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(content_value_to_text)
        .filter(|t| !t.trim().is_empty())
    {
        return Some(text);
    }
    if let Some(text) = value
        .get("final_response")
        .and_then(content_value_to_text)
        .filter(|t| !t.trim().is_empty())
    {
        return Some(text);
    }

    // Output array: [{type: message, content: [{type: output_text, text: "..."}]}]
    if let Some(arr) = value.get("output").and_then(|v| v.as_array()) {
        let mut parts = Vec::new();
        for item in arr {
            if let Some(t) = item
                .get("content")
                .and_then(content_value_to_text)
                .filter(|t| !t.trim().is_empty())
            {
                parts.push(t);
            } else if let Some(t) = item
                .get("text")
                .and_then(content_value_to_text)
                .filter(|t| !t.trim().is_empty())
            {
                parts.push(t);
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("\n"));
        }
    }

    None
}

/// Normalize OpenAI `content` which may be a string, array of parts, or object.
fn content_value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => {
            if s.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Array(parts) => {
            let mut out = String::new();
            for part in parts {
                if let Some(piece) = content_part_to_text(part) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(&piece);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        Value::Object(map) => {
            if let Some(t) = map.get("text").and_then(|v| v.as_str()) {
                return Some(t.to_string());
            }
            if let Some(t) = map.get("content").and_then(content_value_to_text) {
                return Some(t);
            }
            if let Some(t) = map.get("output_text").and_then(|v| v.as_str()) {
                return Some(t.to_string());
            }
            // Last resort: join string-ish values (avoid dumping whole JSON with binary).
            None
        }
    }
}

fn content_part_to_text(part: &Value) -> Option<String> {
    if let Some(s) = part.as_str() {
        return if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        };
    }
    let typ = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match typ {
        "text" | "output_text" | "input_text" => part
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .or_else(|| part.get("content").and_then(content_value_to_text)),
        "refusal" => part
            .get("refusal")
            .and_then(|t| t.as_str())
            .map(|s| format!("Refusal: {s}")),
        // Skip images / tools in the assistant text stream for Jean chat.
        "image_url" | "input_image" | "tool_use" | "tool_result" | "function_call" => None,
        _ => part
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .or_else(|| part.get("content").and_then(content_value_to_text)),
    }
}

fn extract_usage(value: &Value) -> Option<UsageData> {
    let usage = value.get("usage")?;
    let input = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    Some(UsageData {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
    })
}

fn extract_session_id_from_body(value: &Value) -> Option<String> {
    value
        .get("session_id")
        .or_else(|| value.get("id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with("chatcmpl-"))
        .map(str::to_string)
}

fn extract_hermes_error_field(value: &Value) -> Option<String> {
    value
        .get("hermes")
        .and_then(|h| h.get("error"))
        .and_then(|e| e.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("error")
                .and_then(|e| {
                    e.as_str()
                        .map(str::to_string)
                        .or_else(|| e.get("message").and_then(|m| m.as_str()).map(str::to_string))
                })
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

/// True when Hermes signals an incomplete/failed agent run that should not be
/// treated as a clean assistant turn unless text is also present.
fn hermes_hard_error(body: &Value, error_header: Option<&str>) -> Option<String> {
    if let Some(h) = body.get("hermes") {
        let failed = h.get("failed").and_then(|v| v.as_bool()).unwrap_or(false);
        let completed = h.get("completed").and_then(|v| v.as_bool()).unwrap_or(true);
        let partial = h.get("partial").and_then(|v| v.as_bool()).unwrap_or(false);
        if failed || !completed || partial {
            return extract_hermes_error_field(body)
                .or_else(|| error_header.map(str::to_string))
                .or_else(|| Some("Hermes agent run did not complete".into()));
        }
    }
    if let Some(choices) = body.get("choices").and_then(|c| c.as_array()) {
        if let Some(reason) = choices
            .first()
            .and_then(|c| c.get("finish_reason"))
            .and_then(|r| r.as_str())
        {
            if reason == "error" {
                return extract_hermes_error_field(body)
                    .or_else(|| error_header.map(str::to_string))
                    .or_else(|| Some("Hermes agent finished with error".into()));
            }
        }
    }
    error_header
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(
        role: super::super::types::MessageRole,
        content: &str,
    ) -> super::super::types::ChatMessage {
        super::super::types::ChatMessage {
            role,
            content: content.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn extract_assistant_text_from_chat_completion() {
        let value = json!({
            "choices": [{
                "message": { "role": "assistant", "content": "Hello from Hermes" }
            }]
        });
        assert_eq!(
            extract_assistant_text(&value).as_deref(),
            Some("Hello from Hermes")
        );
    }

    #[test]
    fn extract_assistant_text_from_content_array() {
        let value = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "Part one" },
                        { "type": "text", "text": "Part two" }
                    ]
                }
            }]
        });
        assert_eq!(
            extract_assistant_text(&value).as_deref(),
            Some("Part one\nPart two")
        );
    }

    #[test]
    fn extract_assistant_text_from_output_text_field() {
        let value = json!({ "output_text": "Responses API style" });
        assert_eq!(
            extract_assistant_text(&value).as_deref(),
            Some("Responses API style")
        );
    }

    #[test]
    fn extract_assistant_text_ignores_image_parts() {
        let value = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "image_url", "image_url": { "url": "http://x" } },
                        { "type": "text", "text": "Visible" }
                    ]
                }
            }]
        });
        assert_eq!(extract_assistant_text(&value).as_deref(), Some("Visible"));
    }

    #[test]
    fn second_turn_messages_include_the_first_turn() {
        use super::super::types::MessageRole;

        let transcript = vec![
            message(MessageRole::User, "First question"),
            message(MessageRole::Assistant, "First answer"),
            message(MessageRole::User, "Follow-up question"),
        ];

        let messages = build_messages(None, "/repo", "session-1", &transcript);

        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"]
            .as_str()
            .unwrap()
            .contains("Working directory: /repo"));
        assert_eq!(messages[1], json!({"role": "user", "content": "First question"}));
        assert_eq!(
            messages[2],
            json!({"role": "assistant", "content": "First answer"})
        );
        assert_eq!(
            messages[3],
            json!({"role": "user", "content": "Follow-up question"})
        );
    }

    #[test]
    fn session_key_is_stable() {
        assert_eq!(
            jean_hermes_session_key("wt", "sess"),
            "jean:wt:sess"
        );
    }

    #[test]
    fn hermes_hard_error_detects_failed_flag() {
        let body = json!({
            "choices": [{"message": {"content": ""}, "finish_reason": "error"}],
            "hermes": { "completed": false, "failed": true, "error": "boom" }
        });
        assert_eq!(hermes_hard_error(&body, None).as_deref(), Some("boom"));
    }

    #[test]
    fn resolve_effort_maps_jean_levels_to_hermes() {
        assert_eq!(
            resolve_hermes_reasoning_effort(Some(&EffortLevel::Off), None),
            Some("none")
        );
        assert_eq!(
            resolve_hermes_reasoning_effort(Some(&EffortLevel::Adaptive), None),
            None
        );
        assert_eq!(
            resolve_hermes_reasoning_effort(Some(&EffortLevel::Minimal), None),
            Some("minimal")
        );
        assert_eq!(
            resolve_hermes_reasoning_effort(Some(&EffortLevel::High), None),
            Some("high")
        );
        assert_eq!(
            resolve_hermes_reasoning_effort(Some(&EffortLevel::Max), None),
            Some("xhigh")
        );
        assert_eq!(
            resolve_hermes_reasoning_effort(Some(&EffortLevel::Ultracode), None),
            Some("xhigh")
        );
    }

    #[test]
    fn resolve_effort_falls_back_from_thinking_level() {
        assert_eq!(
            resolve_hermes_reasoning_effort(None, Some(&ThinkingLevel::Think)),
            Some("medium")
        );
        assert_eq!(
            resolve_hermes_reasoning_effort(None, Some(&ThinkingLevel::Ultrathink)),
            Some("xhigh")
        );
        assert_eq!(
            resolve_hermes_reasoning_effort(None, Some(&ThinkingLevel::Off)),
            Some("none")
        );
        // Effort wins over thinking when both present.
        assert_eq!(
            resolve_hermes_reasoning_effort(
                Some(&EffortLevel::Low),
                Some(&ThinkingLevel::Ultrathink)
            ),
            Some("low")
        );
    }

    #[test]
    fn model_options_shape_for_effort_and_none() {
        let high = hermes_model_options_for_effort(Some("high")).unwrap();
        assert_eq!(high["reasoning_effort"], "high");
        assert_eq!(high["reasoning"]["enabled"], true);
        assert_eq!(high["reasoning"]["effort"], "high");

        let none = hermes_model_options_for_effort(Some("none")).unwrap();
        assert_eq!(none["reasoning_effort"], "none");
        assert_eq!(none["reasoning"]["enabled"], false);

        assert!(hermes_model_options_for_effort(None).is_none());
    }
}
