use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

use super::storage::{list_all_session_ids, load_metadata};
use super::types::{Backend, SessionMetadata};
use tauri::AppHandle;

/// Token usage of every run of one (backend, model) pair.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryRow {
    pub backend: Backend,
    pub model: Option<String>,
    pub run_count: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    /// Sum of CLI-reported `cost_usd` over the runs that reported one.
    pub reported_cost_usd: f64,
    pub reported_cost_runs: u32,
}

/// Aggregate run usage per (backend, model). Runs without usage, or that
/// started before `since` (unix seconds), are skipped. A run without its own
/// backend inherits the session's.
pub fn summarize_usage(sessions: &[SessionMetadata], since: Option<u64>) -> Vec<UsageSummaryRow> {
    let mut rows: Vec<UsageSummaryRow> = Vec::new();
    for session in sessions {
        for run in &session.runs {
            let Some(usage) = run.usage.as_ref() else {
                continue;
            };
            if since.is_some_and(|since| run.started_at < since) {
                continue;
            }
            let backend = run
                .backend
                .clone()
                .unwrap_or_else(|| session.backend.clone());
            let index = match rows
                .iter()
                .position(|row| row.backend == backend && row.model == run.model)
            {
                Some(index) => index,
                None => {
                    rows.push(UsageSummaryRow {
                        backend,
                        model: run.model.clone(),
                        run_count: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                        reported_cost_usd: 0.0,
                        reported_cost_runs: 0,
                    });
                    rows.len() - 1
                }
            };
            let row = &mut rows[index];
            row.run_count += 1;
            row.input_tokens += usage.input_tokens;
            row.output_tokens += usage.output_tokens;
            row.cache_read_input_tokens += usage.cache_read_input_tokens;
            row.cache_creation_input_tokens += usage.cache_creation_input_tokens;
            if let Some(cost) = usage.cost_usd {
                row.reported_cost_usd += cost;
                row.reported_cost_runs += 1;
            }
        }
    }
    rows
}

/// Token usage across all sessions on this server, optionally limited to runs
/// started in the last `days` days.
pub async fn get_usage_summary(
    app: AppHandle,
    days: Option<u32>,
) -> Result<Vec<UsageSummaryRow>, String> {
    let since = days.map(|days| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        now.saturating_sub(u64::from(days) * 86_400)
    });
    let sessions: Vec<SessionMetadata> = list_all_session_ids(&app)?
        .iter()
        .filter_map(|session_id| load_metadata(&app, session_id).ok().flatten())
        .collect();
    Ok(summarize_usage(&sessions, since))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(backend: &str, runs: serde_json::Value) -> SessionMetadata {
        serde_json::from_value(json!({
            "id": "s",
            "worktree_id": "w",
            "name": "Session 1",
            "order": 0,
            "created_at": 0,
            "backend": backend,
            "runs": runs,
        }))
        .unwrap()
    }

    fn run(started_at: u64, model: &str, usage: serde_json::Value) -> serde_json::Value {
        json!({
            "run_id": format!("r{started_at}"),
            "user_message_id": "m",
            "user_message": "hi",
            "model": model,
            "started_at": started_at,
            "status": "completed",
            "usage": usage,
        })
    }

    #[test]
    fn sums_runs_per_backend_and_model() {
        let claude = session(
            "claude",
            json!([
                run(
                    100,
                    "claude-opus-5-5",
                    json!({
                        "input_tokens": 10, "output_tokens": 5,
                        "cache_read_input_tokens": 100, "cache_creation_input_tokens": 1,
                        "cost_usd": 0.5
                    })
                ),
                run(
                    200,
                    "claude-opus-5-5",
                    json!({ "input_tokens": 3, "output_tokens": 2 })
                ),
                run(
                    300,
                    "claude-sonnet-5",
                    json!({ "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.25 })
                ),
            ]),
        );
        let codex = session(
            "codex",
            json!([
                run(
                    400,
                    "gpt-5.5",
                    json!({ "input_tokens": 7, "output_tokens": 8 })
                ),
                json!({
                    "run_id": "no-usage", "user_message_id": "m", "user_message": "hi",
                    "started_at": 500, "status": "cancelled"
                }),
            ]),
        );

        let rows = summarize_usage(&[claude, codex], None);

        assert_eq!(
            rows,
            vec![
                UsageSummaryRow {
                    backend: Backend::Claude,
                    model: Some("claude-opus-5-5".to_string()),
                    run_count: 2,
                    input_tokens: 13,
                    output_tokens: 7,
                    cache_read_input_tokens: 100,
                    cache_creation_input_tokens: 1,
                    reported_cost_usd: 0.5,
                    reported_cost_runs: 1,
                },
                UsageSummaryRow {
                    backend: Backend::Claude,
                    model: Some("claude-sonnet-5".to_string()),
                    run_count: 1,
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                    reported_cost_usd: 0.25,
                    reported_cost_runs: 1,
                },
                UsageSummaryRow {
                    backend: Backend::Codex,
                    model: Some("gpt-5.5".to_string()),
                    run_count: 1,
                    input_tokens: 7,
                    output_tokens: 8,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                    reported_cost_usd: 0.0,
                    reported_cost_runs: 0,
                },
            ]
        );
    }

    #[test]
    fn skips_runs_started_before_since() {
        let claude = session(
            "claude",
            json!([
                run(
                    100,
                    "claude-opus-5-5",
                    json!({ "input_tokens": 10, "output_tokens": 5 })
                ),
                run(
                    200,
                    "claude-opus-5-5",
                    json!({ "input_tokens": 3, "output_tokens": 2 })
                ),
            ]),
        );

        let rows = summarize_usage(&[claude], Some(200));

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].run_count, 1);
        assert_eq!(rows[0].input_tokens, 3);
    }

    #[test]
    fn run_backend_overrides_session_backend() {
        let mut run = run(
            100,
            "gpt-5.5",
            json!({ "input_tokens": 1, "output_tokens": 1 }),
        );
        run["backend"] = json!("codex");
        let rows = summarize_usage(&[session("claude", json!([run]))], None);
        assert_eq!(rows[0].backend, Backend::Codex);
    }
}
