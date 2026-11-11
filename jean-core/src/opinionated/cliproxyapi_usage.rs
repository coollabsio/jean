//! Usage of every account connected to the Jean-managed CLIProxyAPI.
//!
//! The proxy owns the account tokens. Jean asks its management API for the
//! account list, then sends each usage request through `api-call`, which puts
//! that account's token in place of `$TOKEN$`. Jean never reads the tokens.

use base64::Engine;
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::cliproxyapi::{configured_port, endpoint_url, home_dir, layout, pid_is_cliproxy};
use crate::claude_cli::{claude_usage_snapshot_from_body, ClaudeUsageSnapshot};
use crate::codex_cli::{codex_usage_snapshot_from_response, CodexUsageSnapshot};

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliproxyAccountUsage {
    pub auth_index: String,
    pub provider: String,
    /// Email or account name shown on the card.
    pub label: String,
    pub status: Option<String>,
    pub disabled: bool,
    pub claude: Option<ClaudeUsageSnapshot>,
    pub codex: Option<CodexUsageSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthFileList {
    #[serde(default)]
    files: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct ApiCallResponse {
    status_code: u16,
    #[serde(default)]
    header: HashMap<String, Vec<String>>,
    #[serde(default)]
    body: String,
}

struct Management {
    client: reqwest::Client,
    base: String,
    key: String,
}

impl Management {
    async fn get(&self, path: &str) -> Result<Value, String> {
        self.client
            .get(format!("{}/v0/management/{path}", self.base))
            .bearer_auth(&self.key)
            .send()
            .await
            .map_err(|e| format!("CLIProxyAPI is not reachable: {e}"))?
            .error_for_status()
            .map_err(|e| format!("CLIProxyAPI management request failed: {e}"))?
            .json()
            .await
            .map_err(|e| format!("CLIProxyAPI returned unreadable JSON: {e}"))
    }

    async fn api_call(
        &self,
        auth_index: &str,
        url: &str,
        header: Value,
    ) -> Result<ApiCallResponse, String> {
        self.client
            .post(format!("{}/v0/management/api-call", self.base))
            .bearer_auth(&self.key)
            .json(&json!({
                "auth_index": auth_index,
                "method": "GET",
                "url": url,
                "header": header,
            }))
            .send()
            .await
            .map_err(|e| format!("CLIProxyAPI is not reachable: {e}"))?
            .error_for_status()
            .map_err(|e| format!("CLIProxyAPI api-call failed: {e}"))?
            .json()
            .await
            .map_err(|e| format!("CLIProxyAPI returned unreadable JSON: {e}"))
    }
}

/// Usage for each connected account. Empty when CLIProxyAPI is not installed
/// or not running, so the UI can hide the section.
pub async fn get_usage() -> Result<Vec<CliproxyAccountUsage>, String> {
    let paths = layout(&home_dir()?);
    if !paths.binary.is_file() || !pid_is_cliproxy(&paths.pid) {
        return Ok(Vec::new());
    }
    let key = std::fs::read_to_string(&paths.management_key)
        .map_err(|e| format!("Failed to read CLIProxyAPI management key: {e}"))?;
    let management = Management {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?,
        base: endpoint_url(configured_port(&paths)),
        key: key.trim().to_string(),
    };

    let list: AuthFileList = serde_json::from_value(management.get("auth-files").await?)
        .map_err(|e| format!("CLIProxyAPI returned an unreadable account list: {e}"))?;
    let accounts = list.files.iter().filter_map(account_from_entry);
    Ok(join_all(accounts.map(|account| load_usage(&management, account))).await)
}

fn str_field(entry: &Value, key: &str) -> Option<String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Account card data plus the Codex account id, from one `auth-files` entry.
fn account_from_entry(entry: &Value) -> Option<(CliproxyAccountUsage, Option<String>)> {
    let auth_index = str_field(entry, "auth_index")?;
    let provider = str_field(entry, "provider")
        .or_else(|| str_field(entry, "type"))
        .unwrap_or_else(|| "unknown".to_string())
        .to_lowercase();
    let label = ["email", "account", "label", "name"]
        .iter()
        .find_map(|key| str_field(entry, key))
        .unwrap_or_else(|| auth_index.clone());
    let account = CliproxyAccountUsage {
        auth_index,
        provider,
        label,
        status: str_field(entry, "status"),
        disabled: entry.get("disabled").and_then(Value::as_bool) == Some(true),
        claude: None,
        codex: None,
        error: None,
    };
    Some((account, codex_account_id(entry)))
}

/// ChatGPT account id from the entry, its metadata, or its `id_token` claims.
fn codex_account_id(entry: &Value) -> Option<String> {
    let scopes = [Some(entry), entry.get("metadata"), entry.get("attributes")];
    scopes.iter().flatten().find_map(|scope| {
        str_field(scope, "chatgpt_account_id").or_else(|| {
            let claims = id_token_claims(scope.get("id_token")?)?;
            str_field(&claims, "chatgpt_account_id").or_else(|| {
                str_field(
                    claims.get("https://api.openai.com/auth")?,
                    "chatgpt_account_id",
                )
            })
        })
    })
}

fn id_token_claims(token: &Value) -> Option<Value> {
    match token {
        Value::Object(_) => Some(token.clone()),
        Value::String(raw) => {
            if let Ok(value @ Value::Object(_)) = serde_json::from_str(raw) {
                return Some(value);
            }
            let payload = raw.split('.').nth(1)?;
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload.trim_end_matches('='))
                .ok()?;
            serde_json::from_slice(&bytes).ok()
        }
        _ => None,
    }
}

async fn load_usage(
    management: &Management,
    (mut account, codex_account_id): (CliproxyAccountUsage, Option<String>),
) -> CliproxyAccountUsage {
    if account.disabled {
        return account;
    }
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let result = match account.provider.as_str() {
        "claude" | "anthropic" => fetch_claude(management, &account.auth_index, now_secs)
            .await
            .map(|snapshot| account.claude = Some(snapshot)),
        "codex" | "openai" => {
            fetch_codex(management, &account.auth_index, codex_account_id, now_secs)
                .await
                .map(|snapshot| account.codex = Some(snapshot))
        }
        _ => Ok(()),
    };
    if let Err(error) = result {
        account.error = Some(error);
    }
    account
}

async fn fetch_claude(
    management: &Management,
    auth_index: &str,
    now_secs: u64,
) -> Result<ClaudeUsageSnapshot, String> {
    let header = json!({
        "Authorization": "Bearer $TOKEN$",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
    });
    let response = management
        .api_call(auth_index, CLAUDE_USAGE_URL, header)
        .await?;
    check_status(&response)?;
    claude_usage_snapshot_from_body(&response.body, None, None, now_secs)
}

async fn fetch_codex(
    management: &Management,
    auth_index: &str,
    account_id: Option<String>,
    now_secs: u64,
) -> Result<CodexUsageSnapshot, String> {
    let mut header = json!({
        "Authorization": "Bearer $TOKEN$",
        "Accept": "application/json",
    });
    if let Some(account_id) = account_id {
        header["ChatGPT-Account-Id"] = Value::String(account_id);
    }
    let response = management
        .api_call(auth_index, CODEX_USAGE_URL, header)
        .await?;
    check_status(&response)?;
    codex_usage_snapshot_from_response(&header_map(&response.header), &response.body, now_secs)
}

fn check_status(response: &ApiCallResponse) -> Result<(), String> {
    match response.status_code {
        200..=299 => Ok(()),
        401 | 403 => Err("Login expired. Sign in to this account again in CLIProxyAPI.".into()),
        429 => Err("Usage API is rate-limiting requests. Try again in a few minutes.".into()),
        code => Err(format!("Usage request failed (HTTP {code}).")),
    }
}

fn header_map(headers: &HashMap<String, Vec<String>>) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    for (name, values) in headers {
        let (Ok(name), Some(Ok(value))) = (
            reqwest::header::HeaderName::try_from(name.as_str()),
            values
                .first()
                .map(|v| reqwest::header::HeaderValue::from_str(v)),
        ) else {
            continue;
        };
        map.insert(name, value);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_from_entry_reads_label_provider_and_status() {
        let entry = json!({
            "auth_index": "abc",
            "provider": "Claude",
            "email": "dev@example.com",
            "status": "active",
            "disabled": false,
        });
        let (account, codex_id) = account_from_entry(&entry).expect("account");
        assert_eq!(account.auth_index, "abc");
        assert_eq!(account.provider, "claude");
        assert_eq!(account.label, "dev@example.com");
        assert_eq!(account.status.as_deref(), Some("active"));
        assert!(!account.disabled);
        assert_eq!(codex_id, None);
    }

    #[test]
    fn account_from_entry_skips_entries_without_auth_index() {
        assert!(account_from_entry(&json!({ "provider": "claude" })).is_none());
    }

    #[test]
    fn codex_account_id_reads_jwt_claims() {
        let claims = json!({ "https://api.openai.com/auth": { "chatgpt_account_id": "acct-1" } });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).expect("json"));
        let entry = json!({ "id_token": format!("h.{payload}.s") });
        assert_eq!(codex_account_id(&entry).as_deref(), Some("acct-1"));
    }

    #[test]
    fn codex_account_id_prefers_direct_field() {
        let entry =
            json!({ "chatgpt_account_id": "direct", "metadata": { "chatgpt_account_id": "meta" } });
        assert_eq!(codex_account_id(&entry).as_deref(), Some("direct"));
    }

    #[test]
    fn check_status_maps_errors() {
        let response = |status_code| ApiCallResponse {
            status_code,
            header: HashMap::new(),
            body: String::new(),
        };
        assert!(check_status(&response(200)).is_ok());
        assert!(check_status(&response(401))
            .unwrap_err()
            .contains("Login expired"));
        assert!(check_status(&response(500))
            .unwrap_err()
            .contains("HTTP 500"));
    }
}
