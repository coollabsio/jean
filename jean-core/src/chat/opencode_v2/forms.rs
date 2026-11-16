//! Answers to OpenCode 2.x `question` tool forms.
//!
//! The question tool's call input already has the shape Jean's question UI
//! renders (`{questions: [{question, header, options, multiple}]}`). Its form
//! names the tool call in `metadata.tool.id` and has one field per question
//! (`q0`, `q1`, ...).

use super::V2Client;
use crate::opencode_server::OpenCodeServer;
use serde_json::{Map, Value};
use std::time::Duration;

/// Map Jean's answers (selected labels or typed text, one list per question)
/// to form field values: an array for `multiselect`, a string otherwise.
fn form_answer(form: &Value, answers: &[Vec<String>]) -> Value {
    let fields = form
        .get("fields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut answer = Map::new();
    for (index, field) in fields.iter().enumerate() {
        let Some(key) = field.get("key").and_then(Value::as_str) else {
            continue;
        };
        let chosen = answers.get(index).cloned().unwrap_or_default();
        let value = if field.get("type").and_then(Value::as_str) == Some("multiselect") {
            Value::from(chosen)
        } else {
            Value::from(chosen.join(", "))
        };
        answer.insert(key.to_string(), value);
    }
    Value::Object(answer)
}

pub fn answer_question(
    server: &OpenCodeServer,
    working_dir: &str,
    tool_call_id: &str,
    answers: &[Vec<String>],
) -> Result<(), String> {
    let client = V2Client::new(server, Duration::from_secs(30))?;
    let form = client
        .forms(working_dir)?
        .into_iter()
        .find(|form| form["metadata"]["tool"]["id"] == tool_call_id)
        .ok_or_else(|| format!("No pending OpenCode question for tool call {tool_call_id}"))?;
    let session_id = form["sessionID"].as_str().unwrap_or_default();
    let form_id = form["id"].as_str().unwrap_or_default();
    client.reply_form(session_id, form_id, form_answer(&form, answers))
}

#[cfg(test)]
mod tests {
    use super::form_answer;
    use serde_json::json;

    #[test]
    fn answers_fill_fields_by_position_and_type() {
        // Field shapes recorded from OpenCode 2.3.0.
        let form = json!({
            "fields": [
                { "key": "q0", "type": "string", "options": [{ "value": "Red" }, { "value": "Blue" }], "custom": true },
                { "key": "q1", "type": "multiselect", "options": [{ "value": "A" }, { "value": "B" }] },
                { "key": "q2", "type": "string" }
            ]
        });
        let answers = vec![
            vec!["Blue".to_string()],
            vec!["A".to_string(), "B".to_string()],
        ];
        assert_eq!(
            form_answer(&form, &answers),
            json!({ "q0": "Blue", "q1": ["A", "B"], "q2": "" })
        );
    }
}
