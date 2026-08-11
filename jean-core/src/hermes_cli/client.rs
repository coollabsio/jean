//! HTTP client for Hermes API server (health, capabilities, jobs).

use super::types::{
    join_url, profile_prefix, HermesConnectionConfig, HermesCreateJobRequest, HermesJob,
    HermesUpdateJobRequest,
};
use serde_json::{json, Value};
use std::time::Duration;

/// Default timeout for control-plane requests (jobs, health, models).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Agent chat turns can run tools for a long time on the Hermes host.
const CHAT_COMPLETION_TIMEOUT: Duration = Duration::from_secs(60 * 30);

/// Result of a chat completions call, including Hermes continuity headers.
#[derive(Debug, Clone)]
pub struct HermesChatCompletionResult {
    pub body: Value,
    pub session_id: Option<String>,
    pub session_key: Option<String>,
    pub completed: Option<bool>,
    pub partial: Option<bool>,
    pub error_header: Option<String>,
    pub status: u16,
}

#[derive(Debug, Clone)]
pub struct HermesClient {
    base_url: String,
    api_key: Option<String>,
    profile: String,
    client: reqwest::Client,
}

impl HermesClient {
    pub fn new(config: HermesConnectionConfig) -> Result<Self, String> {
        // No global request timeout — chat uses a long per-request timeout;
        // control-plane calls set their own shorter timeouts below.
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Failed to build Hermes HTTP client: {e}"))?;
        Ok(Self {
            base_url: config.base_url.trim().trim_end_matches('/').to_string(),
            api_key: config.api_key.filter(|k| !k.trim().is_empty()),
            profile: config.profile,
            client,
        })
    }

    fn url(&self, path: &str) -> String {
        let prefix = profile_prefix(&self.profile);
        if prefix.is_empty() {
            join_url(&self.base_url, path)
        } else if path.starts_with('/') {
            join_url(&self.base_url, &format!("{prefix}{path}"))
        } else {
            join_url(&self.base_url, &format!("{prefix}/{path}"))
        }
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(key) = &self.api_key {
            req.header("Authorization", format!("Bearer {key}"))
        } else {
            req
        }
    }

    async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let url = self.url(path);
        let mut req = self
            .client
            .request(method, &url)
            .timeout(REQUEST_TIMEOUT);
        req = self.auth(req);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let response = req
            .send()
            .await
            .map_err(|e| format!("Hermes request failed ({url}): {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("Hermes response body error: {e}"))?;
        if !status.is_success() {
            let err = parse_error_message(&text).unwrap_or(text);
            return Err(format!("Hermes HTTP {status}: {err}"));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| format!("Hermes JSON parse error: {e}"))
    }

    /// OpenAI-compatible chat completions (non-stream).
    ///
    /// Returns body + Hermes continuity headers (`X-Hermes-Session-Id`, etc.).
    pub async fn chat_completions(
        &self,
        body: Value,
        session_id: Option<&str>,
        session_key: Option<&str>,
    ) -> Result<HermesChatCompletionResult, String> {
        let url = self.url("/v1/chat/completions");
        let mut req = self
            .client
            .request(reqwest::Method::POST, &url)
            .timeout(CHAT_COMPLETION_TIMEOUT)
            .json(&body);
        req = self.auth(req);
        if let Some(sid) = session_id.map(str::trim).filter(|s| !s.is_empty()) {
            req = req.header("X-Hermes-Session-Id", sid);
        }
        if let Some(key) = session_key.map(str::trim).filter(|s| !s.is_empty()) {
            req = req.header("X-Hermes-Session-Key", key);
        }
        let response = req
            .send()
            .await
            .map_err(|e| format!("Hermes chat request failed ({url}): {e}"))?;

        let status = response.status();
        let status_code = status.as_u16();
        let session_id = header_value(&response, "x-hermes-session-id");
        let session_key = header_value(&response, "x-hermes-session-key");
        let completed = header_value(&response, "x-hermes-completed").and_then(|v| match v.as_str()
        {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        });
        let partial = header_value(&response, "x-hermes-partial").and_then(|v| match v.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        });
        let error_header = header_value(&response, "x-hermes-error");

        let text = response
            .text()
            .await
            .map_err(|e| format!("Hermes chat response body error: {e}"))?;

        if text.trim().is_empty() {
            if !status.is_success() {
                return Err(format!("Hermes HTTP {status}: empty body"));
            }
            return Ok(HermesChatCompletionResult {
                body: Value::Null,
                session_id,
                session_key,
                completed,
                partial,
                error_header,
                status: status_code,
            });
        }

        let body: Value = serde_json::from_str(&text).map_err(|e| {
            format!(
                "Hermes chat JSON parse error: {e} (body starts with: {})",
                text.chars().take(200).collect::<String>()
            )
        })?;

        if !status.is_success() {
            let err = parse_error_message_from_value(&body)
                .or_else(|| parse_error_message(&text))
                .unwrap_or(text);
            return Err(format!("Hermes HTTP {status}: {err}"));
        }

        Ok(HermesChatCompletionResult {
            body,
            session_id,
            session_key,
            completed,
            partial,
            error_header,
            status: status_code,
        })
    }

    /// Hermes-aware model catalog (authenticated providers + curated models).
    pub async fn model_options(&self, refresh: bool) -> Result<Value, String> {
        let path = if refresh {
            "/api/model/options?refresh=1"
        } else {
            "/api/model/options"
        };
        self.send_json(reqwest::Method::GET, path, None).await
    }

    /// Cheap liveness — does not require auth.
    pub async fn health(&self) -> Result<Value, String> {
        // Public /health is not under /p/ prefix requirements for default; try unprefixed first.
        let url = join_url(&self.base_url, "/health");
        let response = self
            .client
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("Hermes health check failed: {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("Hermes health body error: {e}"))?;
        if !status.is_success() {
            return Err(format!("Hermes health HTTP {status}: {text}"));
        }
        serde_json::from_str(&text).or_else(|_| Ok(json!({ "status": "ok", "raw": text })))
    }

    pub async fn capabilities(&self) -> Result<Value, String> {
        self.send_json(reqwest::Method::GET, "/v1/capabilities", None)
            .await
    }

    pub async fn list_jobs(&self, include_disabled: bool) -> Result<Vec<HermesJob>, String> {
        let path = if include_disabled {
            "/api/jobs?include_disabled=true"
        } else {
            "/api/jobs"
        };
        let value = self.send_json(reqwest::Method::GET, path, None).await?;
        let jobs = value
            .get("jobs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(jobs.iter().filter_map(HermesJob::from_api_value).collect())
    }

    pub async fn get_job(&self, job_id: &str) -> Result<HermesJob, String> {
        let value = self
            .send_json(
                reqwest::Method::GET,
                &format!("/api/jobs/{}", urlencoding_lite(job_id)),
                None,
            )
            .await?;
        let job_val = value.get("job").cloned().unwrap_or(value);
        HermesJob::from_api_value(&job_val).ok_or_else(|| "Invalid job payload".to_string())
    }

    pub async fn create_job_api(&self, req: &HermesCreateJobRequest) -> Result<HermesJob, String> {
        let mut body = json!({
            "name": req.name,
            "schedule": req.schedule,
            "prompt": req.prompt,
            "deliver": req.deliver.clone().unwrap_or_else(|| "local".to_string()),
        });
        if let Some(skills) = &req.skills {
            body["skills"] = json!(skills);
        }
        if let Some(repeat) = req.repeat {
            body["repeat"] = json!(repeat);
        }
        let value = self
            .send_json(reqwest::Method::POST, "/api/jobs", Some(body))
            .await?;
        let job_val = value.get("job").cloned().unwrap_or(value);
        HermesJob::from_api_value(&job_val).ok_or_else(|| "Invalid create job payload".to_string())
    }

    pub async fn update_job(
        &self,
        job_id: &str,
        req: &HermesUpdateJobRequest,
    ) -> Result<HermesJob, String> {
        let body = serde_json::to_value(req).map_err(|e| e.to_string())?;
        // API expects snake_case field names.
        let body = camel_to_snake_keys(body);
        let value = self
            .send_json(
                reqwest::Method::PATCH,
                &format!("/api/jobs/{}", urlencoding_lite(job_id)),
                Some(body),
            )
            .await?;
        let job_val = value.get("job").cloned().unwrap_or(value);
        HermesJob::from_api_value(&job_val).ok_or_else(|| "Invalid update job payload".to_string())
    }

    pub async fn delete_job(&self, job_id: &str) -> Result<(), String> {
        self.send_json(
            reqwest::Method::DELETE,
            &format!("/api/jobs/{}", urlencoding_lite(job_id)),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn pause_job(&self, job_id: &str) -> Result<HermesJob, String> {
        self.job_action(job_id, "pause").await
    }

    pub async fn resume_job(&self, job_id: &str) -> Result<HermesJob, String> {
        self.job_action(job_id, "resume").await
    }

    pub async fn run_job(&self, job_id: &str) -> Result<Value, String> {
        self.send_json(
            reqwest::Method::POST,
            &format!("/api/jobs/{}/run", urlencoding_lite(job_id)),
            None,
        )
        .await
    }

    async fn job_action(&self, job_id: &str, action: &str) -> Result<HermesJob, String> {
        let value = self
            .send_json(
                reqwest::Method::POST,
                &format!("/api/jobs/{}/{action}", urlencoding_lite(job_id)),
                None,
            )
            .await?;
        let job_val = value.get("job").cloned().unwrap_or(value);
        HermesJob::from_api_value(&job_val).ok_or_else(|| format!("Invalid {action} job payload"))
    }
}

fn header_value(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_error_message(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    parse_error_message_from_value(&value)
}

fn parse_error_message_from_value(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    if let Some(s) = error.as_str() {
        return Some(s.to_string());
    }
    if let Some(message) = error.get("message").and_then(|m| m.as_str()) {
        return Some(message.to_string());
    }
    Some(error.to_string())
}

/// Minimal path-segment encoding (job ids are hex; keep safe).
fn urlencoding_lite(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

fn camel_to_snake_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if v.is_null() {
                    continue;
                }
                let snake = camel_to_snake(&k);
                out.insert(snake, camel_to_snake_keys(v));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(camel_to_snake_keys).collect()),
        other => other,
    }
}

fn camel_to_snake(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 4);
    for (i, ch) in input.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_to_snake_basic() {
        assert_eq!(camel_to_snake("scheduleDisplay"), "schedule_display");
        assert_eq!(camel_to_snake("enabled"), "enabled");
    }

    #[test]
    fn client_url_includes_profile_prefix() {
        let client = HermesClient::new(HermesConnectionConfig {
            base_url: "http://127.0.0.1:8642".into(),
            api_key: Some("secret".into()),
            profile: "coder".into(),
        })
        .unwrap();
        assert_eq!(
            client.url("/api/jobs"),
            "http://127.0.0.1:8642/p/coder/api/jobs"
        );
    }

    #[test]
    fn client_url_default_profile_unprefixed() {
        let client = HermesClient::new(HermesConnectionConfig {
            base_url: "http://127.0.0.1:8642/".into(),
            api_key: None,
            profile: String::new(),
        })
        .unwrap();
        assert_eq!(
            client.url("/v1/capabilities"),
            "http://127.0.0.1:8642/v1/capabilities"
        );
    }
}
