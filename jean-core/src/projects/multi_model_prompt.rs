//! "Prompt multiple models": one prompt, one new worktree per backend/model.
//!
//! Worktrees are created up front so every client shows them at once. The
//! wait → session → settings → enqueue part runs in a backend task per target,
//! so it survives the client disconnecting.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::http_server::EmitExt;

pub const MIN_PROMPT_TARGETS: usize = 2;
pub const MAX_PROMPT_TARGETS: usize = 6;
const WORKTREE_READY_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptModelTarget {
    pub backend: String,
    pub model: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub effort_level: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOnModelsResult {
    pub worktree_ids: Vec<String>,
}

fn validate_prompt_on_models(
    prompt: &str,
    targets: &[PromptModelTarget],
    execution_mode: Option<&str>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("Prompt is empty".to_string());
    }
    if !(MIN_PROMPT_TARGETS..=MAX_PROMPT_TARGETS).contains(&targets.len()) {
        return Err(format!(
            "Pick between {MIN_PROMPT_TARGETS} and {MAX_PROMPT_TARGETS} models (got {})",
            targets.len()
        ));
    }
    let mut seen = HashSet::new();
    for target in targets {
        if !seen.insert((target.backend.as_str(), target.model.as_str())) {
            return Err(format!(
                "Duplicate model: {}:{}",
                target.backend, target.model
            ));
        }
    }
    if let Some(mode) = execution_mode {
        if !matches!(mode, "plan" | "build" | "yolo") {
            return Err(format!("Invalid execution mode: {mode}"));
        }
    }
    Ok(())
}

pub async fn start_prompt_on_models(
    app: AppHandle,
    project_id: String,
    prompt: String,
    targets: Vec<PromptModelTarget>,
    execution_mode: Option<String>,
) -> Result<PromptOnModelsResult, String> {
    validate_prompt_on_models(&prompt, &targets, execution_mode.as_deref())?;
    let prefs = crate::load_preferences(app.clone()).await?;
    let execution_mode =
        execution_mode.unwrap_or_else(|| match prefs.default_execution_mode.as_str() {
            mode @ ("plan" | "build" | "yolo") => mode.to_string(),
            _ => "build".to_string(),
        });

    let mut worktree_ids = Vec::with_capacity(targets.len());
    for target in targets {
        let worktree = super::create_worktree(
            app.clone(),
            project_id.clone(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(false),
            None,
        )
        .await?;
        worktree_ids.push(worktree.id.clone());

        let app = app.clone();
        let prompt = prompt.clone();
        let execution_mode = execution_mode.clone();
        let thinking_level = prefs.thinking_level.clone();
        tauri::async_runtime::spawn(async move {
            let label = format!("{}:{}", target.backend, target.model);
            match send_prompt_to_new_worktree(
                &app,
                &worktree.id,
                prompt,
                &target,
                execution_mode,
                thinking_level,
            )
            .await
            {
                Ok(()) => log::info!(
                    "Prompt multiple models: queued prompt in worktree {} ({label})",
                    worktree.id
                ),
                Err(err) => log::error!(
                    "Prompt multiple models: worktree {} ({label}) failed: {err}",
                    worktree.id
                ),
            }
        });
    }

    Ok(PromptOnModelsResult { worktree_ids })
}

async fn wait_for_worktree_path(app: &AppHandle, worktree_id: &str) -> Result<String, String> {
    let started = Instant::now();
    loop {
        match super::get_worktree(app.clone(), worktree_id.to_string()).await {
            Ok(worktree) => return Ok(worktree.path),
            Err(err) if started.elapsed() >= WORKTREE_READY_TIMEOUT => {
                return Err(format!(
                    "worktree not ready after {}s: {err}",
                    WORKTREE_READY_TIMEOUT.as_secs()
                ));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
}

async fn send_prompt_to_new_worktree(
    app: &AppHandle,
    worktree_id: &str,
    prompt: String,
    target: &PromptModelTarget,
    execution_mode: String,
    thinking_level: String,
) -> Result<(), String> {
    let worktree_path = wait_for_worktree_path(app, worktree_id).await?;
    let worktree_id = worktree_id.to_string();

    let sessions = crate::chat::get_sessions(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        Some(false),
    )
    .await?;
    let session_id = match sessions
        .active_session_id
        .clone()
        .or_else(|| sessions.sessions.first().map(|session| session.id.clone()))
    {
        Some(id) => id,
        None => {
            crate::chat::create_session(
                app.clone(),
                worktree_id.clone(),
                worktree_path.clone(),
                None,
                Some(target.backend.clone()),
                None,
                None,
                None,
                None,
                None,
            )
            .await?
            .id
        }
    };

    crate::chat::set_session_backend(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        session_id.clone(),
        target.backend.clone(),
    )
    .await?;
    crate::chat::set_session_model(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        session_id.clone(),
        target.model.clone(),
    )
    .await?;
    crate::chat::set_session_provider(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        session_id.clone(),
        target.provider.clone(),
    )
    .await?;
    if let Some(effort) = &target.effort_level {
        let effort = serde_json::from_value(json!(effort))
            .map_err(|e| format!("invalid effort level {effort}: {e}"))?;
        crate::chat::set_session_effort_level(
            app.clone(),
            worktree_id.clone(),
            worktree_path.clone(),
            session_id.clone(),
            effort,
        )
        .await?;
    }
    // Backend-created sessions must persist their mode (legacy default is Plan).
    crate::chat::set_session_execution_mode(
        app.clone(),
        worktree_id.clone(),
        worktree_path.clone(),
        session_id.clone(),
        execution_mode.clone(),
    )
    .await?;

    // The queue drain fills custom profile, language, chrome and the parallel
    // prompt from preferences.
    let queued = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "message": prompt,
        "pendingImages": [],
        "pendingFiles": [],
        "pendingSkills": [],
        "pendingTextFiles": [],
        "model": target.model,
        "provider": target.provider,
        "backend": target.backend,
        "executionMode": execution_mode,
        "thinkingLevel": thinking_level,
        "effortLevel": target.effort_level,
        "allowAllTools": true,
        "queuedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    });
    crate::chat::enqueue_message(app.clone(), worktree_id, worktree_path, session_id, queued)
        .await?;
    if let Err(e) = app.emit_all("cache:invalidate", &json!({ "keys": ["sessions"] })) {
        log::error!("Failed to emit cache:invalidate: {e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(backend: &str, model: &str) -> PromptModelTarget {
        PromptModelTarget {
            backend: backend.to_string(),
            model: model.to_string(),
            provider: None,
            effort_level: None,
        }
    }

    #[test]
    fn prompt_on_models_rejects_empty_prompt() {
        let targets = [target("claude", "opus"), target("codex", "gpt-5.5")];
        assert!(validate_prompt_on_models("  \n", &targets, None).is_err());
    }

    #[test]
    fn prompt_on_models_requires_two_to_six_targets() {
        assert!(validate_prompt_on_models("hi", &[target("claude", "opus")], None).is_err());
        let seven: Vec<_> = (0..7).map(|i| target("claude", &format!("m{i}"))).collect();
        assert!(validate_prompt_on_models("hi", &seven, None).is_err());
        assert!(validate_prompt_on_models("hi", &seven[..6], None).is_ok());
        assert!(validate_prompt_on_models("hi", &seven[..2], Some("yolo")).is_ok());
    }

    #[test]
    fn prompt_on_models_rejects_duplicate_backend_model() {
        let targets = [target("claude", "opus"), target("claude", "opus")];
        assert!(validate_prompt_on_models("hi", &targets, None).is_err());
        let same_model_other_backend = [target("claude", "opus"), target("pi", "opus")];
        assert!(validate_prompt_on_models("hi", &same_model_other_backend, None).is_ok());
    }

    #[test]
    fn prompt_on_models_rejects_unknown_execution_mode() {
        let targets = [target("claude", "opus"), target("codex", "gpt-5.5")];
        assert!(validate_prompt_on_models("hi", &targets, Some("supervised")).is_err());
    }
}
