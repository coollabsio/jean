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
    prompt_id: Option<String>,
    prompt_delivered: bool,
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

fn usage_from_tokens(tokens: &Value) -> UsageData {
    let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let cache = tokens.get("cache").cloned().unwrap_or_default();
    UsageData {
        input_tokens: number(tokens, "input"),
        output_tokens: number(tokens, "output"),
        cache_read_input_tokens: number(&cache, "read"),
        cache_creation_input_tokens: number(&cache, "write"),
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
            prompt_id: None,
            prompt_delivered: false,
            blocks: Vec::new(),
            open_parts: HashMap::new(),
            tool_names: HashMap::new(),
            tool_calls: Vec::new(),
            usage: None,
            outcome: None,
        }
    }

    /// The inbox id of the prompt this turn sent. The turn cannot end before
    /// the server delivers it, so a late end event of an earlier execution
    /// does not end this turn.
    pub fn expect_prompt(&mut self, inbox_id: String) {
        self.prompt_id = Some(inbox_id);
    }

    pub fn outcome(&self) -> Option<&Outcome> {
        if self.prompt_delivered {
            self.outcome.as_ref()
        } else {
            None
        }
    }

    /// Catch up from `GET /api/session/{id}/message` (newest first) after the
    /// event stream reconnects, in case the end events fell in the gap.
    pub fn resync(&mut self, messages: &[Value]) {
        let Some(prompt_id) = self.prompt_id.as_deref() else {
            return;
        };
        let Some(prompt_at) = messages
            .iter()
            .position(|message| str_field(message, "id") == prompt_id)
        else {
            return;
        };
        self.prompt_delivered = true;
        let latest = &messages[0];
        if prompt_at == 0 || str_field(latest, "type") != "idle" {
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
                if self.prompt_id.as_deref() == Some(str_field(&data, "inboxID")) {
                    self.prompt_delivered = true;
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
                    self.usage = Some(usage_from_tokens(tokens));
                }
                vec![]
            }
            "session.retry.scheduled" if in_lineage => vec![TurnEmit::Retry {
                attempt: data.get("attempt").and_then(Value::as_u64).unwrap_or(0),
                at_ms: data.get("at").and_then(Value::as_u64).unwrap_or(0),
                reason: error_message(&data),
            }],
            "permission.asked" if in_lineage => {
                let source = data.get("source").cloned().unwrap_or_default();
                let tool_call_id =
                    Some(str_field(&source, "id").to_string()).filter(|id| !id.is_empty());
                let working_dir = event
                    .get("location")
                    .map(|location| str_field(location, "directory").to_string())
                    .filter(|dir| !dir.is_empty());
                vec![TurnEmit::PermissionAsked(OpenCodePermissionRequest {
                    request_id: str_field(&data, "id").to_string(),
                    opencode_session_id: session.to_string(),
                    permission: str_field(&data, "action").to_string(),
                    patterns: strings(data.get("resources")),
                    always: strings(data.get("save")),
                    metadata: data.get("metadata").cloned().filter(|v| !v.is_null()),
                    tool_call_id,
                    working_dir,
                    api_version: "v2".to_string(),
                })]
            }
            "permission.replied" if in_lineage => vec![TurnEmit::PermissionReplied {
                request_id: str_field(&data, "requestID").to_string(),
                reply: str_field(&data, "reply").to_string(),
            }],
            "form.created" => {
                let form = data.get("form").cloned().unwrap_or_default();
                let form_session = str_field(&form, "sessionID");
                if self.lineage.contains(form_session) {
                    vec![TurnEmit::FormCreated {
                        session_id: form_session.to_string(),
                        form_id: str_field(&form, "id").to_string(),
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
        turn.expect_prompt("msg_p".to_string());
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
        turn.expect_prompt("msg_p".to_string());
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
        turn.expect_prompt("msg_p".to_string());
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
    fn delivery_clears_an_end_event_of_an_earlier_execution() {
        let mut turn = TurnState::new("ses_root");
        turn.expect_prompt("msg_p".to_string());
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
}
