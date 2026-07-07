//! Scheduled prompts — fire a queued chat prompt when a backend usage window
//! resets (or at an explicit timestamp).
//!
//! Flow:
//! 1. `create_scheduled_prompt` resolves the requested trigger to a concrete
//!    `fire_at` unix timestamp. For `sessionReset`/`weeklyReset` it reads the
//!    live Claude/Codex usage snapshot (`resets_at`, already fetched + cached by
//!    the CLI modules) — no chat-message parsing. For `explicit` it uses the
//!    caller-provided timestamp.
//! 2. Entries persist to `scheduled_prompts.json` in the app data dir so they
//!    survive restarts (a prompt whose reset elapsed while the app was closed
//!    fires on the next tick after launch).
//! 3. `start_scheduled_prompts_scheduler` runs a ~30 s tokio tick loop that
//!    fires every due entry via `crate::chat::send_chat_message` — the exact
//!    call Mr. Robot (`auto_fix`) uses, so it works with the app in background.
//!
//! Resolving the reset to a concrete timestamp at creation time (rather than
//! re-reading a live `resets_at` each tick) is what makes "fire when the window
//! resets" robust: the active window's `resets_at` is a fixed future instant,
//! and once it passes the API reports the *next* window — so a live comparison
//! could never observe the crossing. Capturing the target up front sidesteps
//! that and handles the app-closed-through-reset case for free.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const TICK_SECONDS: u64 = 30;
/// Fire slightly after the reset instant — quota refresh is not always instant.
const RESET_BUFFER_SECONDS: u64 = 30;
/// After a failed send, wait this long before retrying (avoids per-tick spam).
const RETRY_BACKOFF_SECONDS: u64 = 300;

/// Which usage window (or explicit instant) a scheduled prompt waits for.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ScheduleTrigger {
    /// Claude/Codex short "session" window (e.g. 5-hour) reset.
    SessionReset,
    /// Weekly window reset.
    WeeklyReset,
    /// A caller-provided unix timestamp.
    Explicit {
        #[serde(rename = "fireAt")]
        fire_at: u64,
    },
}

/// A persisted prompt waiting to fire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledPrompt {
    pub id: String,
    pub session_id: String,
    pub worktree_id: String,
    pub worktree_path: String,
    pub prompt: String,
    /// Backend to send with (e.g. "claude", "codex"). Also selects the usage
    /// window read for reset triggers.
    pub backend: String,
    pub model: Option<String>,
    pub trigger: ScheduleTrigger,
    /// Concrete unix timestamp the entry fires at (buffer added on top).
    pub fire_at: u64,
    pub created_at: u64,
    /// Last send error, if the most recent fire attempt failed.
    pub last_error: Option<String>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Sessions whose send is currently in flight — guards against a slow send
/// being started twice by consecutive ticks.
static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// Serializes read-modify-write of the on-disk store.
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn in_flight() -> &'static Mutex<HashSet<String>> {
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

fn store_lock() -> &'static Mutex<()> {
    STORE_LOCK.get_or_init(|| Mutex::new(()))
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;
    Ok(dir.join("scheduled_prompts.json"))
}

fn read_store(app: &AppHandle) -> Result<Vec<ScheduledPrompt>, String> {
    let path = store_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) if !contents.trim().is_empty() => serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse scheduled_prompts.json: {e}")),
        Ok(_) => Ok(Vec::new()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Failed to read scheduled_prompts.json: {e}")),
    }
}

fn write_store(app: &AppHandle, prompts: &[ScheduledPrompt]) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_string_pretty(prompts)
        .map_err(|e| format!("Failed to serialize scheduled prompts: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write scheduled_prompts.json: {e}"))
}

/// Read-modify-write the store under the store lock.
fn mutate_store<F, R>(app: &AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce(&mut Vec<ScheduledPrompt>) -> R,
{
    let _guard = store_lock().lock().expect("scheduled prompts store lock");
    let mut prompts = read_store(app)?;
    let result = f(&mut prompts);
    write_store(app, &prompts)?;
    Ok(result)
}

fn default_model_for_backend(backend: &str) -> String {
    match backend {
        "codex" => "gpt-5.3-codex".to_string(),
        "opencode" => "opencode/gpt-5.5".to_string(),
        "cursor" => "cursor/auto".to_string(),
        "pi" => "pi/sonnet".to_string(),
        "commandcode" => "commandcode/default".to_string(),
        _ => "claude-opus-4-8[1m]".to_string(),
    }
}

/// Read the `resets_at` for the requested window from the backend's usage
/// snapshot. `weekly` selects the weekly window instead of the session window.
async fn resolve_reset_timestamp(
    app: &AppHandle,
    backend: &str,
    weekly: bool,
) -> Result<u64, String> {
    let window_label = if weekly { "weekly" } else { "session" };
    match backend {
        "codex" => {
            let usage = crate::codex_cli::get_codex_usage(app.clone()).await?;
            let window = if weekly { usage.weekly } else { usage.session };
            let window = window.ok_or_else(|| {
                format!("Codex usage snapshot has no {window_label} window yet")
            })?;
            // Codex only reports an explicit reset timestamp once some quota is
            // consumed; at low usage it sends the window length instead. Fall
            // back to `now + window_length` so scheduling still works (this is a
            // conservative upper bound — it never fires before the real reset).
            if let Some(resets_at) = window.resets_at {
                return Ok(resets_at);
            }
            if let Some(window_secs) = window.limit_window_seconds {
                return Ok(now_unix().saturating_add(window_secs));
            }
            Err(format!(
                "Codex hasn't reported a {window_label} reset time yet. Use it a little, then retry — or pick an explicit time."
            ))
        }
        // Claude is the default backend for reset triggers; other backends do
        // not expose a usage window, so fall back to the Claude snapshot.
        _ => {
            let usage = crate::claude_cli::get_claude_usage().await?;
            let window = if weekly { usage.weekly } else { usage.session };
            window.and_then(|w| w.resets_at).ok_or_else(|| {
                format!("Claude usage snapshot has no {window_label} reset time")
            })
        }
    }
}

/// Create + persist a scheduled prompt. Resolves the trigger to a concrete
/// `fire_at` timestamp up front (reading the live usage snapshot for reset
/// triggers).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_scheduled_prompt(
    app: AppHandle,
    session_id: String,
    worktree_id: String,
    worktree_path: String,
    prompt: String,
    backend: String,
    model: Option<String>,
    trigger: ScheduleTrigger,
) -> Result<ScheduledPrompt, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }
    if worktree_path.trim().is_empty() {
        return Err("Worktree path cannot be empty".to_string());
    }

    let fire_at = match &trigger {
        ScheduleTrigger::SessionReset => resolve_reset_timestamp(&app, &backend, false).await?,
        ScheduleTrigger::WeeklyReset => resolve_reset_timestamp(&app, &backend, true).await?,
        ScheduleTrigger::Explicit { fire_at } => *fire_at,
    };

    let entry = ScheduledPrompt {
        id: uuid::Uuid::new_v4().to_string(),
        session_id,
        worktree_id,
        worktree_path,
        prompt,
        backend,
        model,
        trigger,
        fire_at,
        created_at: now_unix(),
        last_error: None,
    };

    mutate_store(&app, |prompts| prompts.push(entry.clone()))?;
    log::info!(
        "scheduled_prompts: queued {} (session={}) firing at {}",
        entry.id,
        entry.session_id,
        entry.fire_at
    );
    Ok(entry)
}

/// List every pending scheduled prompt.
#[tauri::command]
pub async fn list_scheduled_prompts(app: AppHandle) -> Result<Vec<ScheduledPrompt>, String> {
    read_store(&app)
}

/// Cancel (remove) a scheduled prompt by id. Returns true if one was removed.
#[tauri::command]
pub async fn cancel_scheduled_prompt(app: AppHandle, id: String) -> Result<bool, String> {
    mutate_store(&app, |prompts| {
        let before = prompts.len();
        prompts.retain(|p| p.id != id);
        prompts.len() != before
    })
}

/// Spawn the background tick loop. Called once at app startup.
pub fn start_scheduled_prompts_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            fire_due(&app).await;
            tokio::time::sleep(Duration::from_secs(TICK_SECONDS)).await;
        }
    });
}

/// Fire every entry whose `fire_at + buffer <= now` and that is not already
/// in flight.
async fn fire_due(app: &AppHandle) {
    let prompts = match read_store(app) {
        Ok(p) => p,
        Err(err) => {
            log::warn!("scheduled_prompts: failed to read store: {err}");
            return;
        }
    };
    if prompts.is_empty() {
        return;
    }

    let now = now_unix();
    for entry in prompts {
        if now < entry.fire_at.saturating_add(RESET_BUFFER_SECONDS) {
            continue;
        }
        // Claim the send slot; skip if a prior tick's send is still running.
        {
            let mut set = in_flight().lock().expect("scheduled prompts in flight");
            if !set.insert(entry.id.clone()) {
                continue;
            }
        }
        spawn_fire(app.clone(), entry);
    }
}

fn spawn_fire(app: AppHandle, entry: ScheduledPrompt) {
    tauri::async_runtime::spawn(async move {
        let result = send_scheduled_prompt(&app, &entry).await;

        match result {
            Ok(()) => {
                log::info!("scheduled_prompts: fired {} (session={})", entry.id, entry.session_id);
                if let Err(err) = mutate_store(&app, |prompts| prompts.retain(|p| p.id != entry.id)) {
                    log::warn!("scheduled_prompts: failed to remove fired entry {}: {err}", entry.id);
                }
            }
            Err(err) => {
                log::warn!("scheduled_prompts: send failed for {}: {err}", entry.id);
                let retry_at = now_unix().saturating_add(RETRY_BACKOFF_SECONDS);
                let _ = mutate_store(&app, |prompts| {
                    if let Some(p) = prompts.iter_mut().find(|p| p.id == entry.id) {
                        p.fire_at = retry_at;
                        p.last_error = Some(err.clone());
                    }
                });
            }
        }

        in_flight()
            .lock()
            .expect("scheduled prompts in flight")
            .remove(&entry.id);
    });
}

async fn send_scheduled_prompt(app: &AppHandle, entry: &ScheduledPrompt) -> Result<(), String> {
    let model = entry
        .model
        .clone()
        .or_else(|| Some(default_model_for_backend(&entry.backend)));

    crate::chat::send_chat_message(
        app.clone(),
        entry.session_id.clone(),
        entry.worktree_id.clone(),
        entry.worktree_path.clone(),
        entry.prompt.clone(),
        model,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(entry.backend.clone()),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_serializes_tagged_camel_case() {
        let json = serde_json::to_string(&ScheduleTrigger::SessionReset).unwrap();
        assert_eq!(json, r#"{"kind":"sessionReset"}"#);
        let json = serde_json::to_string(&ScheduleTrigger::Explicit { fire_at: 42 }).unwrap();
        assert_eq!(json, r#"{"kind":"explicit","fireAt":42}"#);
    }

    #[test]
    fn trigger_deserializes_from_frontend_shapes() {
        let t: ScheduleTrigger = serde_json::from_str(r#"{"kind":"weeklyReset"}"#).unwrap();
        assert_eq!(t, ScheduleTrigger::WeeklyReset);
        let t: ScheduleTrigger =
            serde_json::from_str(r#"{"kind":"explicit","fireAt":100}"#).unwrap();
        assert_eq!(t, ScheduleTrigger::Explicit { fire_at: 100 });
    }

    #[test]
    fn default_models_cover_backends() {
        assert_eq!(default_model_for_backend("claude"), "claude-opus-4-8[1m]");
        assert_eq!(default_model_for_backend("codex"), "gpt-5.3-codex");
        assert_eq!(default_model_for_backend("unknown"), "claude-opus-4-8[1m]");
    }

    #[test]
    fn prompt_round_trips_through_json() {
        let entry = ScheduledPrompt {
            id: "abc".to_string(),
            session_id: "s1".to_string(),
            worktree_id: "w1".to_string(),
            worktree_path: "/tmp/w1".to_string(),
            prompt: "do the thing".to_string(),
            backend: "claude".to_string(),
            model: None,
            trigger: ScheduleTrigger::SessionReset,
            fire_at: 1000,
            created_at: 900,
            last_error: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains(r#""fireAt":1000"#));
        assert!(json.contains(r#""sessionId":"s1""#));
        let back: ScheduledPrompt = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "abc");
        assert_eq!(back.trigger, ScheduleTrigger::SessionReset);
    }
}
