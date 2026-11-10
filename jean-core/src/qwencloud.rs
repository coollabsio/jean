//! QwenCloud model discovery for custom providers.
//!
//! The OpenAI-compatible endpoint exposes `GET {base_url}/models`. The
//! Anthropic-compatible endpoint deliberately does NOT expose a model list
//! (it returns 404), so this is the only way to enumerate models at runtime.
//!
//! The API key is read from the Jean process environment and never from the
//! UI, so it is never stored in preferences or sent over the WebSocket
//! transport used by Web Access. Pay-as-you-go (`sk-ws-`) keys default to
//! `DASHSCOPE_API_KEY`; Token Plan (`sk-sp-`) keys use
//! `QWENCLOUD_TOKEN_PLAN_API_KEY` and the `token-plan` host. Both hosts are
//! accepted by `validate_base_url` because keys and endpoints are not
//! interchangeable between the two billing modes.

use serde::Deserialize;
use std::time::Duration;

const DEFAULT_API_KEY_ENV: &str = "DASHSCOPE_API_KEY";

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    #[serde(default)]
    data: Vec<OpenAiModel>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
}

/// Parse an OpenAI-compatible `GET /models` response into sorted, unique ids.
pub fn parse_openai_models(body: &str) -> Result<Vec<String>, String> {
    let response: OpenAiModelsResponse = serde_json::from_str(body)
        .map_err(|error| format!("Invalid model list response: {error}"))?;
    let mut ids: Vec<String> = response
        .data
        .into_iter()
        .map(|model| model.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Only allow QwenCloud hosts. The API key is attached to this request, so an
/// arbitrary base URL coming from the UI must never be able to receive it.
fn validate_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("https://")
        .ok_or_else(|| "QwenCloud base URL must use https".to_string())?;
    let host = rest.split('/').next().unwrap_or("");
    let is_bare_alias = host == "maas.qwencloudapi.com";
    let is_region_host = host.ends_with(".maas.qwencloudapi.com") && !host.contains('@');
    if !is_bare_alias && !is_region_host {
        return Err(format!("Not a QwenCloud base URL: {base_url}"));
    }
    Ok(trimmed.to_string())
}

/// Fetch the model ids available to a QwenCloud API key in the selected region.
pub async fn fetch_qwencloud_models(
    base_url: String,
    api_key_env: Option<String>,
) -> Result<Vec<String>, String> {
    let base = validate_base_url(&base_url)?;
    let env_name = api_key_env
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| DEFAULT_API_KEY_ENV.to_string());
    let api_key = std::env::var(&env_name)
        .map_err(|_| format!("{env_name} is not set in Jean's environment"))?;
    if api_key.trim().is_empty() {
        return Err(format!("{env_name} is empty"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
    let response = client
        .get(format!("{base}/models"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| format!("Failed to reach QwenCloud: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read QwenCloud response: {error}"))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(|message| message.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| body.chars().take(200).collect());
        return Err(format!("QwenCloud returned HTTP {status}: {detail}"));
    }
    parse_openai_models(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_deduplicates_openai_model_list() {
        let body = r#"{"object":"list","data":[{"id":"qwen3.8-max"},{"id":"qwen3.7-plus"},{"id":"qwen3.8-max"},{"id":"  "}]}"#;
        assert_eq!(
            parse_openai_models(body).unwrap(),
            ["qwen3.7-plus", "qwen3.8-max"]
        );
    }

    #[test]
    fn accepts_all_region_and_token_plan_urls() {
        for url in [
            "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1",
            "https://cn-beijing.maas.qwencloudapi.com/compatible-mode/v1/",
            "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
            "https://maas.qwencloudapi.com/compatible-mode/v1",
        ] {
            assert!(validate_base_url(url).is_ok(), "rejected {url}");
        }
    }

    #[test]
    fn rejects_urls_that_could_exfiltrate_the_api_key() {
        for url in [
            "http://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1",
            "https://evil.example.com/compatible-mode/v1",
            "https://ap-southeast-1.maas.qwencloudapi.com.evil.com/v1",
            "https://evil.com@ap-southeast-1.maas.qwencloudapi.com/v1",
        ] {
            assert!(validate_base_url(url).is_err(), "accepted {url}");
        }
    }
}
