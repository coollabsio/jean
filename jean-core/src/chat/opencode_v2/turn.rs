//! Folds OpenCode 2.x `/api/event` events into one Jean turn.
//!
//! Pure: no I/O. The executor feeds every event for the server through
//! [`TurnState::apply`] and acts on the returned [`TurnEmit`]s.

use crate::chat::opencode::normalize_opencode_tool;
use crate::chat::types::{ContentBlock, OpenCodePermissionRequest, ToolCall, UsageData};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub enum TurnEmit {
    Chunk(String),
    Thinking(String),
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        output: String,
    },
    Retry {
        attempt: u64,
        at_ms: u64,
        reason: String,
    },
    PermissionAsked(OpenCodePermissionRequest),
    PermissionReplied {
        request_id: String,
        reply: String,
    },
    FormCreated {
        session_id: String,
        form_id: String,
        /// A `question` tool form, answered through Jean's question UI.
        question: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Failed(String),
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum PartKind {
    Text,
    Reasoning,
}

pub struct TurnState {
    root: String,
    /// Root session plus every subagent session created under it.
    lineage: HashSet<String>,
    /// Inbox ids of every message this turn sent (prompt and steers).
    sent: Vec<String>,
    /// Sent messages the server has not delivered yet.
    undelivered: HashSet<String>,
    blocks: Vec<ContentBlock>,
    /// (assistant message id, ordinal, kind) → index into `blocks`.
    open_parts: HashMap<(String, u64, PartKind), usize>,
    tool_names: HashMap<String, String>,
    tool_calls: Vec<ToolCall>,
    usage: Option<UsageData>,
    outcome: Option<Outcome>,
}

pub struct TurnResult {
    pub content: String,
    pub content_blocks: Vec<ContentBlock>,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Option<UsageData>,
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn error_message(data: &Value) -> String {
    let error = data.get("error").cloned().unwrap_or_default();
    let message = str_field(&error, "message");
    if message.is_empty() {
        "OpenCode run failed".to_string()
    } else {
        message.to_string()
    }
}

fn tool_output_text(data: &Value) -> String {
    data.get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Usage of one step/message: its `tokens` object plus its `cost` sibling.
fn usage_from_tokens(tokens: &Value, cost: Option<&Value>) -> UsageData {
    let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let cache = tokens.get("cache").cloned().unwrap_or_default();
    UsageData {
        input_tokens: number(tokens, "input"),
        output_tokens: number(tokens, "output"),
        cache_read_input_tokens: number(&cache, "read"),
        cache_creation_input_tokens: number(&cache, "write"),
        cost_usd: cost.and_then(Value::as_f64),
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

impl TurnState {
    pub fn new(root_session_id: &str) -> Self {
        Self {
            root: root_session_id.to_string(),
            lineage: HashSet::from([root_session_id.to_string()]),
            sent: Vec::new(),
            undelivered: HashSet::new(),
            blocks: Vec::new(),
            open_parts: HashMap::new(),
            tool_names: HashMap::new(),
            tool_calls: Vec::new(),
            usage: None,
            outcome: None,
        }
    }

    /// Track a message this turn sent (the prompt or a steer). The turn
    /// cannot end before the server delivers every tracked message, so a
    /// late end event of an earlier execution does not end it, and a steer
    /// sent near the end is part of the turn.
    pub fn expect_delivery(&mut self, inbox_id: String) {
        self.undelivered.insert(inbox_id.clone());
        self.sent.push(inbox_id);
    }

    pub fn outcome(&self) -> Option<&Outcome> {
        if self.sent.is_empty() || !self.undelivered.is_empty() {
            return None;
        }
        self.outcome.as_ref()
    }

    /// Catch up from `GET /api/session/{id}/message` (newest first) after the
    /// event stream reconnects, in case delivery or end events fell in the gap.
    pub fn resync(&mut self, messages: &[Value]) {
        let positions: Vec<usize> = messages
            .iter()
            .enumerate()
            .filter(|(_, message)| self.sent.iter().any(|id| id == str_field(message, "id")))
            .map(|(index, message)| {
                self.undelivered.remove(str_field(message, "id"));
                index
            })
            .collect();
        let Some(newest_ours) = positions.into_iter().min() else {
            return;
        };
        let latest = &messages[0];
        if !self.undelivered.is_empty() || newest_ours == 0 || str_field(latest, "type") != "idle" {
            return;
        }
        self.outcome = match str_field(latest, "outcome") {
            "succeeded" => Some(Outcome::Succeeded),
            "interrupted" => Some(Outcome::Interrupted),
            "failed" => Some(Outcome::Failed(
                messages.get(1).map(error_message).unwrap_or_default(),
            )),
            _ => return,
        };
    }

    pub fn apply(&mut self, event: &Value) -> Vec<TurnEmit> {
        let kind = str_field(event, "type");
        let data = event.get("data").cloned().unwrap_or_default();
        let session = str_field(&data, "sessionID");
        let is_root = session == self.root;
        let in_lineage = self.lineage.contains(session);

        match kind {
            "session.created" => {
                let parent = str_field(&data, "parentID");
                if !session.is_empty() && self.lineage.contains(parent) {
                    self.lineage.insert(session.to_string());
                }
                vec![]
            }
            "session.inbox.delivered" if is_root => {
                if self.undelivered.remove(str_field(&data, "inboxID")) {
                    // An end event seen so far belongs to an earlier execution.
                    self.outcome = None;
                }
                vec![]
            }
            "session.execution.started" if is_root => {
                self.outcome = None;
                vec![]
            }
            "session.execution.succeeded" if is_root => {
                self.outcome = Some(Outcome::Succeeded);
                vec![]
            }
            "session.execution.failed" if is_root => {
                self.outcome = Some(Outcome::Failed(error_message(&data)));
                vec![]
            }
            "session.execution.interrupted" if is_root => {
                self.outcome = Some(Outcome::Interrupted);
                vec![]
            }
            "session.text.started" | "session.reasoning.started" if is_root => {
                self.open_part(&data, part_kind(kind));
                vec![]
            }
            "session.text.delta" | "session.reasoning.delta" if is_root => {
                let delta = str_field(&data, "delta").to_string();
                let index = self.open_part(&data, part_kind(kind));
                self.append(index, &delta);
                self.part_emit(part_kind(kind), delta)
            }
            "session.text.ended" | "session.reasoning.ended" if is_root => {
                let full = str_field(&data, "text");
                let index = self.open_part(&data, part_kind(kind));
                let current = block_text(&self.blocks[index]).to_string();
                match full.strip_prefix(current.as_str()) {
                    Some(missing) if !missing.is_empty() => {
                        let missing = missing.to_string();
                        self.append(index, &missing);
                        self.part_emit(part_kind(kind), missing)
                    }
                    Some(_) => vec![],
                    // A delta was lost (stream gap): keep the server's full text.
                    None => {
                        self.set_text(index, full);
                        vec![]
                    }
                }
            }
            "session.tool.input.started" if is_root => {
                self.tool_names.insert(
                    str_field(&data, "id").to_string(),
                    str_field(&data, "name").to_string(),
                );
                vec![]
            }
            "session.tool.called" if is_root => self.tool_called(&data),
            "session.tool.success" | "session.tool.failed" if is_root => {
                let failed = kind == "session.tool.failed";
                let mut output = tool_output_text(&data);
                if failed && output.is_empty() {
                    output = error_message(&data);
                }
                let id = str_field(&data, "id").to_string();
                let Some(call) = self.tool_calls.iter_mut().find(|call| call.id == id) else {
                    return vec![];
                };
                call.output = Some(output.clone());
                call.is_error = failed.then_some(true);
                vec![TurnEmit::ToolResult { id, output }]
            }
            "session.step.ended" if is_root => {
                if let Some(tokens) = data.get("tokens") {
                    self.usage = Some(usage_from_tokens(tokens, data.get("cost")));
                }
                vec![]
            }
            "session.retry.scheduled" if in_lineage => vec![TurnEmit::Retry {
                attempt: data.get("attempt").and_then(Value::as_u64).unwrap_or(0),
                at_ms: data.get("at").and_then(Value::as_u64).unwrap_or(0),
                reason: error_message(&data),
            }],
            "permission.asked" if in_lineage => {
                let working_dir = event
                    .get("location")
                    .map(|location| str_field(location, "directory").to_string())
                    .filter(|dir| !dir.is_empty());
                vec![TurnEmit::PermissionAsked(permission_request(
                    &data,
                    working_dir,
                ))]
            }
            "permission.replied" if in_lineage => vec![TurnEmit::PermissionReplied {
                request_id: str_field(&data, "requestID").to_string(),
                reply: str_field(&data, "reply").to_string(),
            }],
            "form.created" => {
                let form = data.get("form").cloned().unwrap_or_default();
                let form_session = str_field(&form, "sessionID");
                if self.lineage.contains(form_session) {
                    let kind = form.get("metadata").map(|m| str_field(m, "kind"));
                    vec![TurnEmit::FormCreated {
                        session_id: form_session.to_string(),
                        form_id: str_field(&form, "id").to_string(),
                        question: kind == Some("question"),
                    }]
                } else {
                    vec![]
                }
            }
            _ => vec![],
        }
    }

    fn open_part(&mut self, data: &Value, kind: PartKind) -> usize {
        let key = (
            str_field(data, "assistantMessageID").to_string(),
            data.get("ordinal").and_then(Value::as_u64).unwrap_or(0),
            kind,
        );
        if let Some(index) = self.open_parts.get(&key) {
            return *index;
        }
        self.blocks.push(match kind {
            PartKind::Text => ContentBlock::Text {
                text: String::new(),
            },
            PartKind::Reasoning => ContentBlock::Thinking {
                thinking: String::new(),
            },
        });
        let index = self.blocks.len() - 1;
        self.open_parts.insert(key, index);
        index
    }

    fn append(&mut self, index: usize, delta: &str) {
        match &mut self.blocks[index] {
            ContentBlock::Text { text } => text.push_str(delta),
            ContentBlock::Thinking { thinking } => thinking.push_str(delta),
            _ => {}
        }
    }

    fn set_text(&mut self, index: usize, full: &str) {
        match &mut self.blocks[index] {
            ContentBlock::Text { text } => *text = full.to_string(),
            ContentBlock::Thinking { thinking } => *thinking = full.to_string(),
            _ => {}
        }
    }

    fn part_emit(&self, kind: PartKind, delta: String) -> Vec<TurnEmit> {
        if delta.is_empty() {
            return vec![];
        }
        vec![match kind {
            PartKind::Text => TurnEmit::Chunk(delta),
            PartKind::Reasoning => TurnEmit::Thinking(delta),
        }]
    }

    fn tool_called(&mut self, data: &Value) -> Vec<TurnEmit> {
        let id = str_field(data, "id").to_string();
        let raw_name = self
            .tool_names
            .get(&id)
            .cloned()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "tool".to_string());
        let mut input = data
            .get("input")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let name = normalize_opencode_tool(&raw_name, &mut input);
        if let Some(call) = self.tool_calls.iter_mut().find(|call| call.id == id) {
            call.input = input.clone();
        } else {
            self.tool_calls.push(ToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
                output: None,
                parent_tool_use_id: None,
                is_error: None,
                subagent_usage: None,
            });
            self.blocks.push(ContentBlock::ToolUse {
                tool_call_id: id.clone(),
            });
        }
        vec![TurnEmit::ToolUse { id, name, input }]
    }

    /// A `tool` item of a history assistant message.
    fn history_tool(&mut self, item: &Value) {
        let id = str_field(item, "id").to_string();
        let tool_state = item.get("state").cloned().unwrap_or_default();
        let mut input = tool_state
            .get("input")
            .filter(|input| input.is_object())
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let name = normalize_opencode_tool(str_field(item, "name"), &mut input);
        let (output, is_error) = match str_field(&tool_state, "status") {
            "completed" => (Some(tool_output_text(&tool_state)), None),
            "error" => {
                let text = tool_output_text(&tool_state);
                let text = if text.is_empty() {
                    error_message(&tool_state)
                } else {
                    text
                };
                (Some(text), Some(true))
            }
            _ => (None, None),
        };
        self.tool_calls.push(ToolCall {
            id: id.clone(),
            name,
            input,
            output,
            parent_tool_use_id: None,
            is_error,
            subagent_usage: None,
        });
        self.blocks.push(ContentBlock::ToolUse { tool_call_id: id });
    }

    pub fn finish(self) -> TurnResult {
        let content_blocks: Vec<ContentBlock> = self
            .blocks
            .into_iter()
            .filter(|block| {
                !block_text(block).is_empty() || matches!(block, ContentBlock::ToolUse { .. })
            })
            .collect();
        let content = content_blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        TurnResult {
            content,
            content_blocks: crate::chat::opencode::merge_consecutive_thinking(content_blocks),
            tool_calls: self.tool_calls,
            usage: self.usage,
        }
    }
}

/// A 2.x permission request (`permission.asked` data, or an item of the
/// session's pending permission list) in Jean's shape.
pub fn permission_request(data: &Value, working_dir: Option<String>) -> OpenCodePermissionRequest {
    let source = data.get("source").cloned().unwrap_or_default();
    OpenCodePermissionRequest {
        request_id: str_field(data, "id").to_string(),
        opencode_session_id: str_field(data, "sessionID").to_string(),
        permission: str_field(data, "action").to_string(),
        patterns: strings(data.get("resources")),
        always: strings(data.get("save")),
        metadata: data.get("metadata").cloned().filter(|v| !v.is_null()),
        tool_call_id: Some(str_field(&source, "id").to_string()).filter(|id| !id.is_empty()),
        working_dir,
        api_version: "v2".to_string(),
    }
}

/// Rebuild a turn from session history (newest first) after it ran while
/// Jean was closed. `prompt_id` is the inbox id of the turn's prompt; 2.x
/// also uses it as the id of the user message. Returns `None` while the
/// session has not reached idle after the prompt.
pub fn turn_from_history(messages: &[Value], prompt_id: &str) -> Option<(Outcome, TurnResult)> {
    let latest = messages.first()?;
    if str_field(latest, "type") != "idle" {
        return None;
    }
    let prompt_index = messages
        .iter()
        .position(|message| str_field(message, "id") == prompt_id);
    let newer = match prompt_index {
        Some(index) => &messages[..index],
        None => {
            log::warn!("OpenCode: prompt {prompt_id} is not in the history window");
            messages
        }
    };
    let outcome = match str_field(latest, "outcome") {
        "succeeded" => Outcome::Succeeded,
        "interrupted" => Outcome::Interrupted,
        _ => Outcome::Failed(
            newer
                .iter()
                .find(|message| message.get("error").is_some())
                .map(error_message)
                .unwrap_or_else(|| "OpenCode run failed".to_string()),
        ),
    };
    let mut state = TurnState::new("");
    for message in newer.iter().rev() {
        if str_field(message, "type") != "assistant" {
            continue;
        }
        if let Some(tokens) = message.get("tokens") {
            state.usage = Some(usage_from_tokens(tokens, message.get("cost")));
        }
        for item in message
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let text = str_field(item, "text").to_string();
            match str_field(item, "type") {
                "text" => state.blocks.push(ContentBlock::Text { text }),
                "reasoning" => state.blocks.push(ContentBlock::Thinking { thinking: text }),
                "tool" => state.history_tool(item),
                _ => {}
            }
        }
    }
    Some((outcome, state.finish()))
}

fn part_kind(event_type: &str) -> PartKind {
    if event_type.starts_with("session.reasoning.") {
        PartKind::Reasoning
    } else {
        PartKind::Text
    }
}

fn block_text(block: &ContentBlock) -> &str {
    match block {
        ContentBlock::Text { text } => text,
        ContentBlock::Thinking { thinking } => thinking,
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, data: Value) -> Value {
        json!({ "type": kind, "location": { "directory": "/repo" }, "data": data })
    }

    /// A tool turn recorded from OpenCode 2.3.0 (ids shortened).
    fn recorded_tool_turn() -> Vec<Value> {
        let s = "ses_root";
        vec![
            event(
                "session.inbox.enqueued",
                json!({ "sessionID": s, "inboxID": "msg_p" }),
            ),
            event("session.execution.started", json!({ "sessionID": s })),
            event(
                "session.inbox.delivered",
                json!({ "sessionID": s, "inboxID": "msg_p" }),
            ),
            event(
                "session.reasoning.started",
                json!({ "sessionID": s, "assistantMessageID": "msg_a1", "ordinal": 0 }),
            ),
            event(
                "session.reasoning.delta",
                json!({ "sessionID": s, "assistantMessageID": "msg_a1", "ordinal": 0, "delta": "Read it." }),
            ),
            event(
                "session.tool.input.started",
                json!({ "sessionID": s, "assistantMessageID": "msg_a1", "id": "call_1", "name": "read" }),
            ),
            event(
                "session.reasoning.ended",
                json!({ "sessionID": s, "assistantMessageID": "msg_a1", "ordinal": 0, "text": "Read it." }),
            ),
            event(
                "session.tool.called",
                json!({ "sessionID": s, "assistantMessageID": "msg_a1", "id": "call_1", "input": { "path": "a.txt" } }),
            ),
            event(
                "session.tool.success",
                json!({ "sessionID": s, "assistantMessageID": "msg_a1", "id": "call_1", "content": [{ "type": "text", "text": "1: hello" }] }),
            ),
            event(
                "session.step.ended",
                json!({ "sessionID": s, "assistantMessageID": "msg_a1", "tokens": { "input": 316, "output": 14, "reasoning": 20, "cache": { "read": 4864, "write": 0 } } }),
            ),
            event(
                "session.text.started",
                json!({ "sessionID": s, "assistantMessageID": "msg_a2", "ordinal": 0 }),
            ),
            event(
                "session.text.delta",
                json!({ "sessionID": s, "assistantMessageID": "msg_a2", "ordinal": 0, "delta": "hel" }),
            ),
            event(
                "session.text.ended",
                json!({ "sessionID": s, "assistantMessageID": "msg_a2", "ordinal": 0, "text": "hello" }),
            ),
            event(
                "session.step.ended",
                json!({ "sessionID": s, "assistantMessageID": "msg_a2", "tokens": { "input": 3636, "output": 3, "reasoning": 0, "cache": { "read": 1792, "write": 0 } } }),
            ),
            event("session.execution.succeeded", json!({ "sessionID": s })),
        ]
    }

    #[test]
    fn builds_a_tool_turn_from_recorded_events() {
        let mut turn = TurnState::new("ses_root");
        turn.expect_delivery("msg_p".to_string());
        let emits: Vec<TurnEmit> = recorded_tool_turn()
            .iter()
            .flat_map(|e| turn.apply(e))
            .collect();

        assert_eq!(
            emits,
            vec![
                TurnEmit::Thinking("Read it.".to_string()),
                TurnEmit::ToolUse {
                    id: "call_1".to_string(),
                    name: "Read".to_string(),
                    input: json!({ "file_path": "a.txt" }),
                },
                TurnEmit::ToolResult {
                    id: "call_1".to_string(),
                    output: "1: hello".to_string(),
                },
                TurnEmit::Chunk("hel".to_string()),
                TurnEmit::Chunk("lo".to_string()),
            ]
        );
        assert_eq!(turn.outcome(), Some(&Outcome::Succeeded));

        let result = turn.finish();
        assert_eq!(result.content, "hello");
        assert_eq!(
            result.content_blocks,
            vec![
                ContentBlock::Thinking {
                    thinking: "Read it.".to_string()
                },
                ContentBlock::ToolUse {
                    tool_call_id: "call_1".to_string()
                },
                ContentBlock::Text {
                    text: "hello".to_string()
                },
            ]
        );
        assert_eq!(result.tool_calls[0].output.as_deref(), Some("1: hello"));
        let usage = result.usage.expect("usage");
        assert_eq!(
            (
                usage.input_tokens,
                usage.output_tokens,
                usage.cache_read_input_tokens
            ),
            (3636, 3, 1792)
        );
    }

    #[test]
    fn an_end_event_before_the_prompt_is_delivered_does_not_end_the_turn() {
        let mut turn = TurnState::new("ses_root");
        turn.expect_delivery("msg_p".to_string());
        turn.apply(&event(
            "session.execution.succeeded",
            json!({ "sessionID": "ses_root" }),
        ));
        assert_eq!(turn.outcome(), None);

        turn.apply(&event(
            "session.execution.started",
            json!({ "sessionID": "ses_root" }),
        ));
        turn.apply(&event(
            "session.inbox.delivered",
            json!({ "sessionID": "ses_root", "inboxID": "msg_p" }),
        ));
        assert_eq!(turn.outcome(), None);
        turn.apply(&event(
            "session.execution.failed",
            json!({ "sessionID": "ses_root", "error": { "type": "api", "message": "Insufficient balance" } }),
        ));
        assert_eq!(
            turn.outcome(),
            Some(&Outcome::Failed("Insufficient balance".to_string()))
        );
    }

    #[test]
    fn subagent_permissions_reach_the_turn_but_their_text_does_not() {
        let mut turn = TurnState::new("ses_root");
        turn.apply(&event(
            "session.created",
            json!({ "sessionID": "ses_child", "parentID": "ses_root" }),
        ));
        assert_eq!(
            turn.apply(&event(
                "session.text.delta",
                json!({ "sessionID": "ses_child", "assistantMessageID": "m", "ordinal": 0, "delta": "child" }),
            )),
            vec![]
        );
        let asked = turn.apply(&event(
            "permission.asked",
            json!({
                "id": "per_1", "sessionID": "ses_child", "action": "shell",
                "resources": ["echo hi"], "save": ["echo *"],
                "source": { "type": "tool", "messageID": "m", "id": "call_9" }
            }),
        ));
        assert_eq!(
            asked,
            vec![TurnEmit::PermissionAsked(OpenCodePermissionRequest {
                request_id: "per_1".to_string(),
                opencode_session_id: "ses_child".to_string(),
                permission: "shell".to_string(),
                patterns: vec!["echo hi".to_string()],
                always: vec!["echo *".to_string()],
                metadata: None,
                tool_call_id: Some("call_9".to_string()),
                working_dir: Some("/repo".to_string()),
                api_version: "v2".to_string(),
            })]
        );
        assert_eq!(
            turn.apply(&event(
                "permission.asked",
                json!({ "id": "per_2", "sessionID": "ses_other", "action": "shell" }),
            )),
            vec![]
        );
    }

    #[test]
    fn resync_ends_a_turn_whose_end_events_were_missed() {
        let mut turn = TurnState::new("ses_root");
        turn.expect_delivery("msg_p".to_string());
        // Newest first, as returned by GET /api/session/{id}/message.
        let running = vec![
            json!({ "id": "msg_a", "type": "assistant" }),
            json!({ "id": "msg_p", "type": "user", "text": "hi" }),
            json!({ "id": "msg_i0", "type": "idle", "outcome": "succeeded" }),
        ];
        turn.resync(&running);
        assert_eq!(
            turn.outcome(),
            None,
            "older idle item does not end the turn"
        );

        let failed = vec![
            json!({ "id": "msg_i1", "type": "idle", "outcome": "failed" }),
            json!({ "id": "msg_a", "type": "assistant", "error": { "type": "api", "message": "Insufficient balance" } }),
            json!({ "id": "msg_p", "type": "user", "text": "hi" }),
        ];
        turn.resync(&failed);
        assert_eq!(
            turn.outcome(),
            Some(&Outcome::Failed("Insufficient balance".to_string()))
        );
    }

    #[test]
    fn a_steer_delivered_after_the_end_extends_the_turn() {
        let mut turn = TurnState::new("ses_root");
        let root = |kind: &str, extra: Value| {
            let mut data = json!({ "sessionID": "ses_root" });
            data.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            event(kind, data)
        };
        turn.expect_delivery("msg_p".to_string());
        turn.apply(&root("session.execution.started", json!({})));
        turn.apply(&root(
            "session.inbox.delivered",
            json!({ "inboxID": "msg_p" }),
        ));
        turn.expect_delivery("msg_s".to_string());
        turn.apply(&root("session.execution.succeeded", json!({})));
        assert_eq!(turn.outcome(), None, "steer not delivered yet");

        turn.apply(&root("session.execution.started", json!({})));
        turn.apply(&root(
            "session.inbox.delivered",
            json!({ "inboxID": "msg_s" }),
        ));
        assert_eq!(turn.outcome(), None, "second execution still running");
        turn.apply(&root("session.execution.succeeded", json!({})));
        assert_eq!(turn.outcome(), Some(&Outcome::Succeeded));
    }

    #[test]
    fn question_forms_are_told_apart() {
        let mut turn = TurnState::new("ses_root");
        let form = |kind: &str| {
            event(
                "form.created",
                json!({ "form": { "id": "frm_1", "sessionID": "ses_root", "metadata": { "kind": kind } } }),
            )
        };
        assert_eq!(
            turn.apply(&form("question")),
            vec![TurnEmit::FormCreated {
                session_id: "ses_root".to_string(),
                form_id: "frm_1".to_string(),
                question: true,
            }]
        );
        assert!(matches!(
            turn.apply(&form("mcp")).as_slice(),
            [TurnEmit::FormCreated {
                question: false,
                ..
            }]
        ));
    }

    #[test]
    fn delivery_clears_an_end_event_of_an_earlier_execution() {
        let mut turn = TurnState::new("ses_root");
        turn.expect_delivery("msg_p".to_string());
        turn.apply(&event(
            "session.execution.succeeded",
            json!({ "sessionID": "ses_root" }),
        ));
        turn.apply(&event(
            "session.inbox.delivered",
            json!({ "sessionID": "ses_root", "inboxID": "msg_p" }),
        ));
        assert_eq!(turn.outcome(), None);
    }

    #[test]
    fn text_ended_replaces_text_with_a_lost_delta() {
        let mut turn = TurnState::new("ses_root");
        let part = |kind, extra: Value| {
            let mut data =
                json!({ "sessionID": "ses_root", "assistantMessageID": "m", "ordinal": 0 });
            data.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            event(kind, data)
        };
        turn.apply(&part("session.text.delta", json!({ "delta": "Hel" })));
        // The "lo, wor" delta was lost.
        turn.apply(&part("session.text.delta", json!({ "delta": "ld" })));
        turn.apply(&part(
            "session.text.ended",
            json!({ "text": "Hello, world" }),
        ));
        assert_eq!(turn.finish().content, "Hello, world");
    }

    #[test]
    fn failed_tools_carry_the_error() {
        let mut turn = TurnState::new("ses_root");
        turn.apply(&event(
            "session.tool.input.started",
            json!({ "sessionID": "ses_root", "id": "c", "name": "shell" }),
        ));
        turn.apply(&event(
            "session.tool.called",
            json!({ "sessionID": "ses_root", "id": "c", "input": { "command": "false" } }),
        ));
        assert_eq!(
            turn.apply(&event(
                "session.tool.failed",
                json!({ "sessionID": "ses_root", "id": "c", "error": { "type": "tool", "message": "exit 1" } }),
            )),
            vec![TurnEmit::ToolResult { id: "c".to_string(), output: "exit 1".to_string() }]
        );
        let result = turn.finish();
        assert_eq!(result.tool_calls[0].name, "Bash");
        assert_eq!(result.tool_calls[0].is_error, Some(true));
    }

    #[test]
    fn rebuilds_a_turn_that_ran_while_jean_was_closed() {
        // Newest first; item shapes from the OpenCode 2.3.0 API schema.
        let history = vec![
            json!({ "id": "msg_idle", "type": "idle", "outcome": "succeeded" }),
            json!({ "id": "msg_a2", "type": "assistant", "content": [{ "type": "text", "text": "done" }], "tokens": { "input": 10, "output": 2, "cache": { "read": 5, "write": 0 } } }),
            json!({ "id": "msg_a1", "type": "assistant", "content": [
                { "type": "reasoning", "text": "look first" },
                { "type": "tool", "id": "call_1", "name": "read", "state": { "status": "completed", "input": { "path": "/a.txt" }, "content": [{ "type": "text", "text": "1: hi" }] }, "time": { "created": 1 } },
                { "type": "tool", "id": "call_2", "name": "shell", "state": { "status": "error", "input": { "command": "false" }, "error": { "message": "exit 1" } }, "time": { "created": 2 } }
            ] }),
            json!({ "id": "msg_prompt", "type": "user", "text": "go" }),
            json!({ "id": "msg_old", "type": "assistant", "content": [{ "type": "text", "text": "earlier turn" }] }),
        ];
        let (outcome, result) = turn_from_history(&history, "msg_prompt").unwrap();
        assert_eq!(outcome, Outcome::Succeeded);
        assert_eq!(result.content, "done");
        assert_eq!(
            result.content_blocks,
            vec![
                ContentBlock::Thinking {
                    thinking: "look first".to_string()
                },
                ContentBlock::ToolUse {
                    tool_call_id: "call_1".to_string()
                },
                ContentBlock::ToolUse {
                    tool_call_id: "call_2".to_string()
                },
                ContentBlock::Text {
                    text: "done".to_string()
                },
            ]
        );
        assert_eq!(result.tool_calls[0].output.as_deref(), Some("1: hi"));
        assert_eq!(result.tool_calls[0].input["file_path"], "/a.txt");
        assert_eq!(result.tool_calls[0].name, "Read");
        assert_eq!(result.tool_calls[1].output.as_deref(), Some("exit 1"));
        assert_eq!(result.tool_calls[1].is_error, Some(true));
        assert_eq!(result.usage.unwrap().input_tokens, 10);
    }

    #[test]
    fn a_turn_is_rebuilt_only_after_the_session_is_idle() {
        let running = vec![
            json!({ "id": "msg_a1", "type": "assistant", "content": [{ "type": "text", "text": "part" }] }),
            json!({ "id": "msg_prompt", "type": "user", "text": "go" }),
        ];
        assert!(turn_from_history(&running, "msg_prompt").is_none());
        // An idle item older than the prompt belongs to an earlier turn.
        let queued = vec![
            json!({ "id": "msg_prompt", "type": "user", "text": "go" }),
            json!({ "id": "msg_idle", "type": "idle", "outcome": "succeeded" }),
        ];
        assert!(turn_from_history(&queued, "msg_prompt").is_none());
        let failed = vec![
            json!({ "id": "msg_idle", "type": "idle", "outcome": "failed" }),
            json!({ "id": "msg_a1", "type": "assistant", "content": [], "error": { "message": "quota" } }),
            json!({ "id": "msg_prompt", "type": "user", "text": "go" }),
        ];
        let (outcome, _) = turn_from_history(&failed, "msg_prompt").unwrap();
        assert_eq!(outcome, Outcome::Failed("quota".to_string()));
    }
}
