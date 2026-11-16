//! Blocking HTTP client for the OpenCode 2.x API (`/api/*`).

use crate::opencode_server::{OpenCodeServer, SERVER_USERNAME};
use reqwest::Method;
use serde_json::{json, Value};
use std::time::Duration;

pub struct V2Client {
    http: reqwest::blocking::Client,
    server: OpenCodeServer,
}

/// Parse a 2.x response. Success bodies are `{"data": ...}` or empty (204);
/// errors are `{"_tag": "SessionNotFoundError", "message": "..."}`.
fn parse_response(status: u16, body: &str) -> Result<Value, String> {
    let parsed = serde_json::from_str::<Value>(body).ok();
    if (200..300).contains(&status) {
        return Ok(parsed
            .and_then(|mut value| value.get_mut("data").map(Value::take))
            .unwrap_or(Value::Null));
    }
    let detail = parsed
        .as_ref()
        .and_then(|value| {
            let message = value.get("message")?.as_str()?;
            Some(match value.get("_tag").and_then(Value::as_str) {
                Some(tag) => format!("{tag}: {message}"),
                None => message.to_string(),
            })
        })
        .unwrap_or_else(|| body.chars().take(500).collect());
    Err(format!("status={status}, {detail}"))
}

impl V2Client {
    pub fn new(server: &OpenCodeServer, timeout: Duration) -> Result<Self, String> {
        let http = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .no_proxy()
            .build()
            .map_err(|e| format!("Failed to build OpenCode HTTP client: {e}"))?;
        Ok(Self {
            http,
            server: server.clone(),
        })
    }

    fn call(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        let mut request = self
            .http
            .request(method.clone(), format!("{}{path}", self.server.url))
            .basic_auth(SERVER_USERNAME, self.server.password.as_deref());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .map_err(|e| format!("OpenCode {method} {path} failed: {e}"))?;
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        parse_response(status, &text).map_err(|e| format!("OpenCode {method} {path} failed: {e}"))
    }

    /// Returns the new session id.
    pub fn create_session(&self, body: Value) -> Result<String, String> {
        let data = self.call(Method::POST, "/api/session", Some(body))?;
        data.get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("OpenCode session create response has no data.id: {data}"))
    }

    pub fn set_model(&self, session_id: &str, model: Value) -> Result<(), String> {
        let path = format!("/api/session/{session_id}/model");
        self.call(Method::POST, &path, Some(json!({ "model": model })))
            .map(drop)
    }

    pub fn set_agent(&self, session_id: &str, agent: &str) -> Result<(), String> {
        let path = format!("/api/session/{session_id}/agent");
        self.call(Method::POST, &path, Some(json!({ "agent": agent })))
            .map(drop)
    }

    pub fn set_permissions(&self, session_id: &str, rules: Value) -> Result<(), String> {
        let path = format!("/api/session/{session_id}");
        self.call(Method::PATCH, &path, Some(json!({ "permissions": rules })))
            .map(drop)
    }

    /// Store `text` as a per-session instruction entry (the 2.x system prompt).
    pub fn set_instructions(&self, session_id: &str, key: &str, text: &str) -> Result<(), String> {
        let path = format!("/api/experimental/session/{session_id}/instructions/entries/{key}");
        self.call(Method::PUT, &path, Some(json!({ "value": text })))
            .map(drop)
    }

    /// Queue a user message. Returns its inbox id (`msg_...`).
    /// Queue a prompt. Jean's image, skill and text-file annotations in
    /// `text` become attachments or inlined text, as on 1.x.
    pub fn prompt(&self, session_id: &str, text: &str, delivery: &str) -> Result<String, String> {
        let path = format!("/api/session/{session_id}/prompt");
        let data = self.call(Method::POST, &path, Some(prompt_body(text, delivery)))?;
        data.get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("OpenCode prompt response has no data.id: {data}"))
    }

    /// Session history, newest first.
    pub fn messages(&self, session_id: &str) -> Result<Vec<Value>, String> {
        let path = format!("/api/session/{session_id}/message?limit=50");
        match self.call(Method::GET, &path, None)? {
            Value::Array(items) => Ok(items),
            other => Err(format!("OpenCode message list is not an array: {other}")),
        }
    }

    /// The newest `limit` history items, newest first.
    pub fn history(&self, session_id: &str, limit: u32) -> Result<Vec<Value>, String> {
        let path = format!("/api/session/{session_id}/message?limit={limit}");
        match self.call(Method::GET, &path, None)? {
            Value::Array(items) => Ok(items),
            other => Err(format!("OpenCode message list is not an array: {other}")),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<Value>, String> {
        match self.call(Method::GET, path, None)? {
            Value::Array(items) => Ok(items),
            other => Err(format!("OpenCode {path} is not a list: {other}")),
        }
    }

    /// Prompts queued in the session inbox and not delivered yet.
    pub fn inbox(&self, session_id: &str) -> Result<Vec<Value>, String> {
        self.list(&format!("/api/session/{session_id}/inbox"))
    }

    /// Permission requests of the session that wait for a reply.
    pub fn pending_permissions(&self, session_id: &str) -> Result<Vec<Value>, String> {
        self.list(&format!("/api/session/{session_id}/permission"))
    }

    /// Forms of the session that wait for a reply.
    pub fn session_forms(&self, session_id: &str) -> Result<Vec<Value>, String> {
        self.list(&format!("/api/session/{session_id}/form"))
    }

    /// Whether the server runs no execution for the session now. The wait
    /// call returns at once for an idle session and blocks for a busy one,
    /// so a client timeout means busy. Use a client with a short timeout.
    pub fn is_idle(&self, session_id: &str) -> Result<bool, String> {
        let path = format!("/api/experimental/session/{session_id}/wait");
        let result = self
            .http
            .post(format!("{}{path}", self.server.url))
            .basic_auth(SERVER_USERNAME, self.server.password.as_deref())
            .send();
        match result {
            Ok(response) => {
                let status = response.status().as_u16();
                let text = response.text().unwrap_or_default();
                parse_response(status, &text)
                    .map(|_| true)
                    .map_err(|e| format!("OpenCode POST {path} failed: {e}"))
            }
            Err(e) if e.is_timeout() => Ok(false),
            Err(e) => Err(format!("OpenCode POST {path} failed: {e}")),
        }
    }

    pub fn interrupt(&self, session_id: &str) -> Result<(), String> {
        let path = format!("/api/session/{session_id}/interrupt");
        self.call(Method::POST, &path, None).map(drop)
    }

    pub fn reply_permission(
        &self,
        session_id: &str,
        request_id: &str,
        decision: &str,
        message: Option<&str>,
    ) -> Result<(), String> {
        let path = format!("/api/session/{session_id}/permission/{request_id}/reply");
        let body = json!({ "decision": decision, "message": message });
        self.call(Method::POST, &path, Some(body)).map(drop)
    }

    /// Pending forms of every session in `directory`.
    pub fn forms(&self, directory: &str) -> Result<Vec<Value>, String> {
        let response = self
            .http
            .get(format!("{}/api/form", self.server.url))
            .basic_auth(SERVER_USERNAME, self.server.password.as_deref())
            .query(&[("location[directory]", directory)])
            .send()
            .map_err(|e| format!("OpenCode GET /api/form failed: {e}"))?;
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        match parse_response(status, &text)
            .map_err(|e| format!("OpenCode GET /api/form failed: {e}"))?
        {
            Value::Array(forms) => Ok(forms),
            other => Err(format!("OpenCode form list is not an array: {other}")),
        }
    }

    pub fn reply_form(&self, session_id: &str, form_id: &str, answer: Value) -> Result<(), String> {
        let path = format!("/api/session/{session_id}/form/{form_id}/reply");
        self.call(Method::POST, &path, Some(json!({ "answer": answer })))
            .map(drop)
    }

    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let path = format!("/api/session/{session_id}");
        self.call(Method::DELETE, &path, None).map(drop)
    }

    pub fn cancel_form(&self, session_id: &str, form_id: &str) -> Result<(), String> {
        let path = format!("/api/session/{session_id}/form/{form_id}");
        self.call(Method::DELETE, &path, None).map(drop)
    }
}

/// The 2.x prompt body from the 1.x message parts: the text part, and file
/// parts as `files` with their data URI (2.x reads `file:` and `data:` URIs).
fn prompt_body(text: &str, delivery: &str) -> Value {
    let parts = super::super::opencode::prepare_opencode_parts(text);
    v2_prompt_body(
        parts.as_array().map(Vec::as_slice).unwrap_or_default(),
        delivery,
    )
}

fn v2_prompt_body(parts: &[Value], delivery: &str) -> Value {
    let text = parts
        .iter()
        .find(|part| part["type"] == "text")
        .and_then(|part| part["text"].as_str())
        .unwrap_or_default();
    let files: Vec<Value> = parts
        .iter()
        .filter(|part| part["type"] == "file")
        .map(|part| json!({ "uri": part["url"], "name": part["filename"] }))
        .collect();
    let mut body = json!({ "text": text, "delivery": delivery });
    if !files.is_empty() {
        body["files"] = Value::Array(files);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::{parse_response, v2_prompt_body};
    use serde_json::json;

    #[test]
    fn unwraps_the_data_envelope() {
        assert_eq!(
            parse_response(200, r#"{"data":{"id":"ses_1"}}"#),
            Ok(json!({ "id": "ses_1" }))
        );
        assert_eq!(parse_response(204, ""), Ok(serde_json::Value::Null));
    }

    #[test]
    fn reports_tagged_errors() {
        assert_eq!(
            parse_response(
                404,
                r#"{"_tag":"SessionNotFoundError","sessionID":"ses_x","message":"Session not found: ses_x"}"#
            ),
            Err("status=404, SessionNotFoundError: Session not found: ses_x".to_string())
        );
        assert_eq!(parse_response(405, ""), Err("status=405, ".to_string()));
    }

    #[test]
    fn file_parts_become_attachments() {
        let parts = [
            json!({ "type": "text", "text": "What is in the image?" }),
            json!({ "type": "file", "mime": "image/png", "url": "data:image/png;base64,AAAA", "filename": "a.png" }),
        ];
        assert_eq!(
            v2_prompt_body(&parts, "steer"),
            json!({
                "text": "What is in the image?",
                "delivery": "steer",
                "files": [{ "uri": "data:image/png;base64,AAAA", "name": "a.png" }],
            })
        );
        assert_eq!(
            v2_prompt_body(&parts[..1], "queue"),
            json!({ "text": "What is in the image?", "delivery": "queue" })
        );
    }
}
