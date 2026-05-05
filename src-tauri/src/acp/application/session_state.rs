//! In-memory ACP session snapshot + early-notification buffering.
//!
//! This module owns the latest non-transcript ACP session state:
//! - binding (jean session id <-> ACP session id)
//! - latest config options
//! - latest available slash commands
//! - latest title
//! - prompt-image capability
//! - per-session log registration and early notification buffering
//!
//! `events.jsonl` remains the append-only transcript of raw wire frames.
//! `snapshot_store` persists the latest derived session state so commands can
//! build `AcpSessionInfo` without replaying the log.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, RwLock};

use crate::acp::domain::session::{SessionBinding, SessionInfoState};
use crate::acp::infrastructure::{
    session_log::{Direction, SessionLog},
    snapshot_store::{self, PairStatus, PersistedSessionState},
};
use crate::acp::provider::AcpProvider;

static LOGS: Lazy<RwLock<HashMap<String, Arc<SessionLog>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
static SNAPSHOTS: Lazy<RwLock<HashMap<String, RuntimeSessionSnapshot>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
static PENDING_NOTIFICATIONS: Lazy<RwLock<HashMap<String, Vec<Value>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));
/// Per-ACP-session transaction locks. Create/resume registration and
/// notification handling for the same ACP session must serialize so older
/// snapshot writes cannot land after newer notification-derived state.
static SESSION_TXNS: Lazy<RwLock<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

#[derive(Debug, Clone)]
struct RuntimeSessionSnapshot {
    provider: AcpProvider,
    jean_session_id: Option<String>,
    config_options: Option<Value>,
    available_commands: Option<Value>,
    title: Option<Option<String>>,
}

#[derive(Serialize)]
struct AcpEventPayload<'a> {
    provider: &'a str,
    session_id: Option<String>,
    jean_session_id: Option<String>,
    frame: &'a Value,
}

pub fn pair_status(app: &AppHandle, jean_session_id: &str) -> Result<PairStatus, String> {
    snapshot_store::pair_status(app, jean_session_id)
}

pub fn events_path(app: &AppHandle, jean_session_id: &str) -> Result<PathBuf, String> {
    snapshot_store::events_path(app, jean_session_id)
}

pub fn reset_events_file(app: &AppHandle, jean_session_id: &str) -> Result<PathBuf, String> {
    snapshot_store::reset_events_file(app, jean_session_id)
}

pub fn resolve_binding(
    app: &AppHandle,
    jean_session_id: &str,
) -> Result<Option<SessionBinding>, String> {
    snapshot_store::binding(app, jean_session_id)
}

pub fn current_session_info(
    app: &AppHandle,
    jean_session_id: &str,
) -> Result<SessionInfoState, String> {
    let state = snapshot_store::read(app, jean_session_id)?
        .ok_or_else(|| format!("ACP snapshot missing for {jean_session_id}"))?;
    Ok(build_session_info(&state))
}

pub async fn seed_new_session(
    app: &AppHandle,
    jean_session_id: String,
    provider: AcpProvider,
    acp_session_id: String,
    config_options: Value,
    prompt_image: bool,
) -> Result<SessionInfoState, String> {
    let txn = session_txn(&acp_session_id).await;
    let _txn = txn.lock().await;
    let mut state = PersistedSessionState::new(jean_session_id, acp_session_id.clone(), provider);
    state.config_options = config_options;
    state.prompt_image = prompt_image;
    merge_runtime_overrides(&acp_session_id, &mut state).await;
    snapshot_store::write(app, &state)?;
    seed_runtime_from_persisted(&state, provider, &acp_session_id).await;
    Ok(build_session_info(&state))
}

pub async fn refresh_session(
    app: &AppHandle,
    jean_session_id: &str,
    provider: AcpProvider,
    acp_session_id: &str,
    config_options: Value,
    prompt_image: bool,
) -> Result<SessionInfoState, String> {
    let txn = session_txn(acp_session_id).await;
    let _txn = txn.lock().await;
    let mut state = snapshot_store::read(app, jean_session_id)?
        .ok_or_else(|| format!("ACP snapshot missing for {jean_session_id}"))?;
    state.provider = provider.to_string();
    state.acp_session_id = acp_session_id.to_string();
    state.config_options = config_options;
    state.prompt_image = prompt_image;
    state.touch();
    merge_runtime_overrides(acp_session_id, &mut state).await;
    snapshot_store::write(app, &state)?;
    seed_runtime_from_persisted(&state, provider, acp_session_id).await;
    Ok(build_session_info(&state))
}

pub async fn register_session_log(
    app: &AppHandle,
    provider: AcpProvider,
    acp_session_id: String,
    log: Arc<SessionLog>,
) -> Result<SessionInfoState, String> {
    let txn = session_txn(&acp_session_id).await;
    let _txn = txn.lock().await;
    let jean_session_id = log.jean_session_id().to_string();
    LOGS.write()
        .await
        .insert(acp_session_id.clone(), log.clone());
    {
        let mut snapshots = SNAPSHOTS.write().await;
        let snapshot = snapshots
            .entry(acp_session_id.clone())
            .or_insert_with(|| runtime_snapshot(provider, Some(jean_session_id.clone())));
        snapshot.provider = provider;
        snapshot.jean_session_id = Some(jean_session_id.clone());
    }
    persist_bound_snapshot(app, &acp_session_id).await?;

    if let Some(frames) = PENDING_NOTIFICATIONS.write().await.remove(&acp_session_id) {
        for frame in frames {
            log.append(Direction::AgentToClient, &frame);
            emit_session_event(
                app,
                provider,
                acp_session_id.clone(),
                Some(jean_session_id.clone()),
                &frame,
            )
            .await;
        }
    }
    let state = snapshot_store::read(app, &jean_session_id)?
        .ok_or_else(|| format!("ACP snapshot missing for {jean_session_id}"))?;
    Ok(build_session_info(&state))
}

pub async fn handle_session_notification(
    app: &AppHandle,
    provider: AcpProvider,
    acp_session_id: String,
    frame: Value,
) {
    let txn = session_txn(&acp_session_id).await;
    let _txn = txn.lock().await;
    let jean_session_id = LOGS.read().await.get(&acp_session_id).map(|log| {
        log.append(Direction::AgentToClient, &frame);
        log.jean_session_id().to_string()
    });

    let snapshot_changed =
        apply_frame(&acp_session_id, provider, jean_session_id.clone(), &frame).await;

    if jean_session_id.is_some() {
        if snapshot_changed {
            if let Err(e) = persist_bound_snapshot(app, &acp_session_id).await {
                log::warn!("[acp:{provider}] persist session snapshot for {acp_session_id}: {e}");
            }
        }
        emit_session_event(app, provider, acp_session_id, jean_session_id, &frame).await;
    } else {
        PENDING_NOTIFICATIONS
            .write()
            .await
            .entry(acp_session_id)
            .or_default()
            .push(frame);
    }
}

pub async fn log_to_session(acp_session_id: &str, direction: Direction, frame: &Value) {
    if let Some(log) = LOGS.read().await.get(acp_session_id).cloned() {
        log.append(direction, frame);
    }
}

pub async fn lookup_jean_session_id(acp_session_id: &str) -> Option<String> {
    if let Some(id) = LOGS
        .read()
        .await
        .get(acp_session_id)
        .map(|log| log.jean_session_id().to_string())
    {
        return Some(id);
    }
    SNAPSHOTS
        .read()
        .await
        .get(acp_session_id)
        .and_then(|snapshot| snapshot.jean_session_id.clone())
}

fn build_session_info(state: &PersistedSessionState) -> SessionInfoState {
    SessionInfoState {
        session_id: state.acp_session_id.clone(),
        provider: state.provider.clone(),
        config_options: state.config_options.clone(),
        available_commands: state.available_commands.clone(),
        title: state.title.clone(),
        prompt_image: state.prompt_image,
    }
}

fn runtime_snapshot(
    provider: AcpProvider,
    jean_session_id: Option<String>,
) -> RuntimeSessionSnapshot {
    RuntimeSessionSnapshot {
        provider,
        jean_session_id,
        config_options: None,
        available_commands: None,
        title: None,
    }
}

async fn seed_runtime_from_persisted(
    state: &PersistedSessionState,
    provider: AcpProvider,
    acp_session_id: &str,
) {
    SNAPSHOTS.write().await.insert(
        acp_session_id.to_string(),
        RuntimeSessionSnapshot {
            provider,
            jean_session_id: Some(state.jean_session_id.clone()),
            config_options: Some(state.config_options.clone()),
            available_commands: Some(state.available_commands.clone()),
            title: Some(state.title.clone()),
        },
    );
}

async fn merge_runtime_overrides(acp_session_id: &str, state: &mut PersistedSessionState) {
    let snapshot = SNAPSHOTS.read().await.get(acp_session_id).cloned();
    let Some(snapshot) = snapshot else {
        return;
    };
    state.provider = snapshot.provider.to_string();
    if let Some(jean_session_id) = snapshot.jean_session_id {
        state.jean_session_id = jean_session_id;
    }
    if let Some(config_options) = snapshot.config_options {
        state.config_options = config_options;
    }
    if let Some(available_commands) = snapshot.available_commands {
        state.available_commands = available_commands;
    }
    if let Some(title) = snapshot.title {
        state.title = title;
    }
}

async fn apply_frame(
    acp_session_id: &str,
    provider: AcpProvider,
    jean_session_id: Option<String>,
    frame: &Value,
) -> bool {
    let mut snapshots = SNAPSHOTS.write().await;
    let snapshot = snapshots
        .entry(acp_session_id.to_string())
        .or_insert_with(|| runtime_snapshot(provider, jean_session_id.clone()));
    snapshot.provider = provider;
    if jean_session_id.is_some() {
        snapshot.jean_session_id = jean_session_id;
    }
    let mut changed = false;
    if let Some(config_options) = parse_config_options_update(frame) {
        if snapshot.config_options.as_ref() != Some(&config_options) {
            snapshot.config_options = Some(config_options);
            changed = true;
        }
    }
    if let Some(available_commands) = parse_available_commands_update(frame) {
        if snapshot.available_commands.as_ref() != Some(&available_commands) {
            snapshot.available_commands = Some(available_commands);
            changed = true;
        }
    }
    if let Some(title) = parse_title_update(frame) {
        if snapshot.title.as_ref() != Some(&title) {
            snapshot.title = Some(title);
            changed = true;
        }
    }
    changed
}

async fn persist_bound_snapshot(app: &AppHandle, acp_session_id: &str) -> Result<(), String> {
    let snapshot = SNAPSHOTS.read().await.get(acp_session_id).cloned();
    let Some(snapshot) = snapshot else {
        return Ok(());
    };
    let Some(jean_session_id) = snapshot.jean_session_id.as_deref() else {
        return Ok(());
    };
    let mut state = snapshot_store::read(app, jean_session_id)?
        .ok_or_else(|| format!("ACP snapshot missing for {jean_session_id}"))?;
    state.provider = snapshot.provider.to_string();
    state.acp_session_id = acp_session_id.to_string();
    state.touch();
    if let Some(config_options) = snapshot.config_options {
        state.config_options = config_options;
    }
    if let Some(available_commands) = snapshot.available_commands {
        state.available_commands = available_commands;
    }
    if let Some(title) = snapshot.title {
        state.title = title;
    }
    snapshot_store::write(app, &state)
}

async fn emit_session_event(
    app: &AppHandle,
    provider: AcpProvider,
    acp_session_id: String,
    jean_session_id: Option<String>,
    frame: &Value,
) {
    let payload = AcpEventPayload {
        provider: provider.as_str(),
        session_id: Some(acp_session_id),
        jean_session_id,
        frame,
    };
    if let Err(e) = app.emit("acp:event", &payload) {
        log::warn!("[acp:{provider}] failed to emit acp:event: {e}");
    }
}

async fn session_txn(acp_session_id: &str) -> Arc<Mutex<()>> {
    if let Some(txn) = SESSION_TXNS.read().await.get(acp_session_id).cloned() {
        return txn;
    }
    let mut txns = SESSION_TXNS.write().await;
    txns.entry(acp_session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn parse_title_update(frame: &Value) -> Option<Option<String>> {
    let title_field = frame
        .get("update")
        .filter(|u| u.get("sessionUpdate").and_then(Value::as_str) == Some("session_info_update"))
        .and_then(|u| u.get("title"))?;
    if title_field.is_null() {
        Some(None)
    } else {
        title_field.as_str().map(|s| Some(s.to_string()))
    }
}

fn parse_config_options_update(frame: &Value) -> Option<Value> {
    frame
        .get("update")
        .filter(|u| u.get("sessionUpdate").and_then(Value::as_str) == Some("config_option_update"))
        .and_then(|u| u.get("configOptions"))
        .cloned()
}

fn parse_available_commands_update(frame: &Value) -> Option<Value> {
    frame
        .get("update")
        .filter(|u| {
            u.get("sessionUpdate").and_then(Value::as_str) == Some("available_commands_update")
        })
        .and_then(|u| u.get("availableCommands"))
        .cloned()
}
