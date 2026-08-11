//! Hermes connection + Jobs API DTOs.
//!
//! Field names match Hermes API JSON (snake_case). Frontend may receive them
//! as-is or map via transport; keep serde defaults tolerant of extra fields.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// CLI install detection (PATH hermes binary).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// True when Jean ran the official installer for this machine.
    #[serde(default)]
    pub jean_managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesGatewayStatus {
    pub running: bool,
    /// Raw `hermes gateway status` text when available.
    #[serde(default)]
    pub service_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesInstallCommand {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
}

/// Model row for Jean's Hermes picker (same role as PI's `list_pi_models`).
///
/// `id` is Jean's wire id: `hermes/{provider}/{model}`.
/// Chat requests split that into Hermes API `provider` + `model` fields so
/// bare-model ignore rules on `/v1/chat/completions` don't drop the selection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesModelInfo {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub is_default: bool,
}

/// Jean model id ↔ Hermes request fields.
///
/// Accepted forms:
/// - `hermes/{provider}/{model...}` (preferred)
/// - `{provider}/{model...}` when provider looks known
/// - bare model / `hermes-agent` → no provider (gateway default)
pub fn parse_hermes_model_selection(raw: &str) -> (Option<String>, String) {
    let raw = raw.trim();
    if raw.is_empty() {
        return (None, "hermes-agent".to_string());
    }
    let without_prefix = raw
        .strip_prefix("hermes/")
        .or_else(|| raw.strip_prefix("hermes:"))
        .unwrap_or(raw);
    if without_prefix == "hermes-agent" || without_prefix == "agent" {
        return (None, "hermes-agent".to_string());
    }
    if let Some((provider, model)) = without_prefix.split_once('/') {
        let provider = provider.trim();
        let model = model.trim();
        if !provider.is_empty() && !model.is_empty() {
            return (Some(provider.to_string()), model.to_string());
        }
    }
    (None, without_prefix.to_string())
}

pub fn jean_hermes_model_id(provider: &str, model: &str) -> String {
    format!("hermes/{}/{}", provider.trim(), model.trim())
}

/// Combined readiness for Settings / onboarding.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HermesConnectionStatus {
    pub cli: HermesCliStatus,
    /// API liveness (`GET /health`).
    pub api_reachable: bool,
    /// Detailed readiness when key is valid (`GET /health/detailed` or capabilities).
    pub api_authenticated: bool,
    pub base_url: String,
    pub profile: String,
    pub model: Option<String>,
    pub error: Option<String>,
    /// Raw capabilities.features when available.
    #[serde(default)]
    pub capabilities: Option<Value>,
    #[serde(default)]
    pub gateway: Option<HermesGatewayStatus>,
}

/// Connection settings resolved from AppPreferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesConnectionConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub profile: String,
}

/// Create-job request from Jean UI / MCP-style callers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HermesCreateJobRequest {
    pub name: String,
    pub schedule: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub deliver: Option<String>,
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    #[serde(default)]
    pub repeat: Option<i64>,
    /// Absolute worktree path. Forces CLI create path until Hermes Jobs API accepts workdir.
    #[serde(default)]
    pub workdir: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub script: Option<String>,
    #[serde(default)]
    pub no_agent: Option<bool>,
    #[serde(default)]
    pub enabled_toolsets: Option<Vec<String>>,
    #[serde(default)]
    pub context_from: Option<Vec<String>>,
    /// Optional Jean linkage (stored only on Jean side later; not sent to Hermes API).
    #[serde(default)]
    pub worktree_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
}

/// Patch body for Jobs API (allowed fields only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HermesUpdateJobRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

/// Normalized job row for Jean UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HermesJob {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub schedule_display: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub deliver: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub workdir: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub next_run_at: Option<String>,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub no_agent: bool,
    /// Original Hermes job object for debugging / forward-compat fields.
    #[serde(default)]
    pub raw: Option<Value>,
    // --- Jean linkage (from job index / workdir match) ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

impl HermesJob {
    /// Map a Hermes jobs.json / API job object into the Jean DTO.
    pub fn from_api_value(value: &Value) -> Option<Self> {
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())?
            .to_string();
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string();
        let prompt = value
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let schedule_display = value
            .get("schedule_display")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| {
                value.get("schedule").and_then(|s| {
                    if let Some(text) = s.as_str() {
                        Some(text.to_string())
                    } else {
                        s.get("display")
                            .and_then(|d| d.as_str())
                            .map(str::to_string)
                    }
                })
            });
        let skills = value
            .get("skills")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            id,
            name,
            prompt,
            schedule_display,
            enabled: value
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            state: value
                .get("state")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            deliver: value
                .get("deliver")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            skills,
            workdir: value
                .get("workdir")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            model: value
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            provider: value
                .get("provider")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            next_run_at: value
                .get("next_run_at")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            last_run_at: value
                .get("last_run_at")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            last_status: value
                .get("last_status")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            last_error: value
                .get("last_error")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            no_agent: value
                .get("no_agent")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            raw: Some(value.clone()),
            project_id: None,
            worktree_id: None,
            worktree_path: None,
            session_id: None,
            profile: None,
        })
    }
}

/// True when create/update needs fields the thin Jobs HTTP API cannot express.
pub fn requires_cli_create(req: &HermesCreateJobRequest) -> bool {
    req.workdir.as_ref().is_some_and(|w| !w.trim().is_empty())
        || req.model.as_ref().is_some_and(|m| !m.trim().is_empty())
        || req.provider.as_ref().is_some_and(|p| !p.trim().is_empty())
        || req.script.as_ref().is_some_and(|s| !s.trim().is_empty())
        || req.no_agent == Some(true)
        || req.enabled_toolsets.as_ref().is_some_and(|t| !t.is_empty())
        || req.context_from.as_ref().is_some_and(|c| !c.is_empty())
}

/// Join base URL + path without double slashes.
pub fn join_url(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let path = path.trim();
    if path.is_empty() {
        return base.to_string();
    }
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

/// Optional profile prefix for multiplexed gateways: `/p/<profile>`.
pub fn profile_prefix(profile: &str) -> String {
    let profile = profile.trim();
    if profile.is_empty() || profile == "default" {
        String::new()
    } else {
        format!("/p/{profile}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn join_url_strips_trailing_slash() {
        assert_eq!(
            join_url("http://127.0.0.1:8642/", "/api/jobs"),
            "http://127.0.0.1:8642/api/jobs"
        );
        assert_eq!(
            join_url("http://127.0.0.1:8642", "api/jobs"),
            "http://127.0.0.1:8642/api/jobs"
        );
    }

    #[test]
    fn profile_prefix_default_is_empty() {
        assert_eq!(profile_prefix(""), "");
        assert_eq!(profile_prefix("default"), "");
        assert_eq!(profile_prefix("coder"), "/p/coder");
    }

    #[test]
    fn parse_hermes_model_selection_splits_provider() {
        assert_eq!(
            parse_hermes_model_selection("hermes/openrouter/anthropic/claude-sonnet-4.6"),
            (
                Some("openrouter".into()),
                "anthropic/claude-sonnet-4.6".into()
            )
        );
        assert_eq!(
            parse_hermes_model_selection("hermes/anthropic/claude-sonnet-4-6"),
            (Some("anthropic".into()), "claude-sonnet-4-6".into())
        );
        assert_eq!(
            parse_hermes_model_selection("hermes-agent"),
            (None, "hermes-agent".into())
        );
    }

    #[test]
    fn requires_cli_when_workdir_set() {
        let mut req = HermesCreateJobRequest {
            name: "n".into(),
            schedule: "every 1h".into(),
            prompt: "p".into(),
            deliver: None,
            skills: None,
            repeat: None,
            workdir: None,
            model: None,
            provider: None,
            script: None,
            no_agent: None,
            enabled_toolsets: None,
            context_from: None,
            worktree_id: None,
            project_id: None,
        };
        assert!(!requires_cli_create(&req));
        req.workdir = Some("/tmp/proj".into());
        assert!(requires_cli_create(&req));
    }

    #[test]
    fn job_from_api_value_maps_core_fields() {
        let value = json!({
            "id": "abc123def456",
            "name": "Morning audit",
            "prompt": "Audit open PRs",
            "schedule_display": "every 1d at 09:00",
            "enabled": true,
            "state": "scheduled",
            "deliver": "local",
            "skills": ["github-pr-workflow"],
            "workdir": "/home/me/proj",
            "next_run_at": "2026-08-01T09:00:00",
            "last_status": "completed",
            "no_agent": false
        });
        let job = HermesJob::from_api_value(&value).unwrap();
        assert_eq!(job.id, "abc123def456");
        assert_eq!(job.name, "Morning audit");
        assert_eq!(job.skills, vec!["github-pr-workflow"]);
        assert_eq!(job.workdir.as_deref(), Some("/home/me/proj"));
        assert_eq!(job.schedule_display.as_deref(), Some("every 1d at 09:00"));
    }
}
