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
    pub fn prompt(&self, session_id: &str, text: &str, delivery: &str) -> Result<String, String> {
        let path = format!("/api/session/{session_id}/prompt");
        let data = self.call(
            Method::POST,
            &path,
            Some(json!({ "text": text, "delivery": delivery })),
        )?;
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

#[cfg(test)]
mod tests {
    use super::parse_response;
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
}
