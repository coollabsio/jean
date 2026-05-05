//! Persisted ACP session-state sidecar.
//!
//! Each jean session that has ever bound to an ACP session gets a
//! `<app_data>/acp/sessions/<jean_id>/snapshot.json` file. It holds the
//! frequently-read, non-transcript state needed to resume and hydrate the
//! UI: the ACP session id/provider binding plus the latest session snapshot
//! (`config_options`, `available_commands`, `title`, `prompt_image`).
//!
//! Writes are atomic (tmp + rename + parent-dir sync) so a crash mid-write
//! can't leave the file half-populated or rename-only durable. A missing or
//! corrupt snapshot is treated as a hard error by the resume path.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::acp::domain::session::SessionBinding;
use crate::acp::provider::AcpProvider;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSessionState {
    pub jean_session_id: String,
    pub acp_session_id: String,
    pub provider: String,
    pub created_at_ms: u128,
    pub updated_at_ms: u128,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt_image: bool,
    #[serde(default = "null_json_value")]
    pub config_options: serde_json::Value,
    #[serde(default = "null_json_value")]
    pub available_commands: serde_json::Value,
}

impl PersistedSessionState {
    pub fn new(jean_session_id: String, acp_session_id: String, provider: AcpProvider) -> Self {
        let now = now_ms();
        Self {
            jean_session_id,
            acp_session_id,
            provider: provider.to_string(),
            created_at_ms: now,
            updated_at_ms: now,
            title: None,
            prompt_image: false,
            config_options: serde_json::Value::Null,
            available_commands: serde_json::Value::Null,
        }
    }

    pub fn touch(&mut self) {
        self.updated_at_ms = now_ms();
    }
}

#[derive(Debug)]
pub enum PairStatus {
    Both,
    Neither,
    OnlySnapshot(PathBuf),
    OnlyEvents(PathBuf),
}

impl PairStatus {
    pub fn corruption_error(&self, jean_session_id: &str) -> Option<String> {
        match self {
            PairStatus::Both | PairStatus::Neither => None,
            PairStatus::OnlySnapshot(missing) => Some(format!(
                "ACP session {jean_session_id} is corrupt: snapshot.json present \
                 but {missing:?} is missing"
            )),
            PairStatus::OnlyEvents(missing) => Some(format!(
                "ACP session {jean_session_id} is corrupt: events.jsonl present \
                 but {missing:?} is missing"
            )),
        }
    }
}

static CACHE: Lazy<RwLock<HashMap<String, PersistedSessionState>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub fn session_dir(app: &AppHandle, jean_session_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app_data_dir: {e}"))?;
    Ok(dir.join("acp").join("sessions").join(jean_session_id))
}

pub fn snapshot_path(app: &AppHandle, jean_session_id: &str) -> Result<PathBuf, String> {
    Ok(session_dir(app, jean_session_id)?.join("snapshot.json"))
}

pub fn events_path(app: &AppHandle, jean_session_id: &str) -> Result<PathBuf, String> {
    Ok(session_dir(app, jean_session_id)?.join("events.jsonl"))
}

pub fn read(
    app: &AppHandle,
    jean_session_id: &str,
) -> Result<Option<PersistedSessionState>, String> {
    if let Some(state) = CACHE
        .read()
        .map_err(|_| "acp snapshot cache poisoned".to_string())?
        .get(jean_session_id)
        .cloned()
    {
        return Ok(Some(state));
    }
    let path = snapshot_path(app, jean_session_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read {path:?}: {e}"))?;
    let state: PersistedSessionState =
        serde_json::from_str(&text).map_err(|e| format!("parse {path:?}: {e}"))?;
    CACHE
        .write()
        .map_err(|_| "acp snapshot cache poisoned".to_string())?
        .insert(jean_session_id.to_string(), state.clone());
    Ok(Some(state))
}

pub fn binding(app: &AppHandle, jean_session_id: &str) -> Result<Option<SessionBinding>, String> {
    match read(app, jean_session_id)? {
        Some(state) => Ok(Some(SessionBinding {
            acp_session_id: state.acp_session_id,
            provider: AcpProvider::from_wire(state.provider)?,
        })),
        None => Ok(None),
    }
}

pub fn write(app: &AppHandle, state: &PersistedSessionState) -> Result<(), String> {
    let dir = session_dir(app, &state.jean_session_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    let final_path = dir.join("snapshot.json");
    let tmp_path = dir.join("snapshot.json.tmp");

    let json = serde_json::to_vec_pretty(state).map_err(|e| format!("encode snapshot: {e}"))?;

    {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("create {tmp_path:?}: {e}"))?;
        f.write_all(&json)
            .map_err(|e| format!("write {tmp_path:?}: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("rename {tmp_path:?} -> {final_path:?}: {e}"))?;
    fs::File::open(&dir)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync dir {dir:?}: {e}"))?;
    CACHE
        .write()
        .map_err(|_| "acp snapshot cache poisoned".to_string())?
        .insert(state.jean_session_id.clone(), state.clone());
    Ok(())
}

pub fn pair_status(app: &AppHandle, jean_session_id: &str) -> Result<PairStatus, String> {
    let snapshot = snapshot_path(app, jean_session_id)?;
    let events = events_path(app, jean_session_id)?;
    Ok(match (snapshot.exists(), events.exists()) {
        (true, true) => PairStatus::Both,
        (false, false) => PairStatus::Neither,
        (true, false) => PairStatus::OnlySnapshot(events),
        (false, true) => PairStatus::OnlyEvents(snapshot),
    })
}

pub fn reset_events_file(app: &AppHandle, jean_session_id: &str) -> Result<PathBuf, String> {
    let path = events_path(app, jean_session_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    fs::File::create(&path).map_err(|e| format!("truncate {path:?}: {e}"))?;
    Ok(path)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn null_json_value() -> serde_json::Value {
    serde_json::Value::Null
}
