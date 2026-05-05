//! Per-session append-only event log (`<session_dir>/events.jsonl`).
//!
//! Every wire frame (sent or received) gets appended as a single JSON
//! object per line:
//!
//!   `{ ts: u128, dir: "c2a"|"a2c"|"internal", frame: <wire body> }`
//!
//! The frontend replays this file to reconstruct the transcript on every
//! mount. We use `session/resume` (not `session/load`) so the agent does
//! NOT re-stream the transcript on rebind — the on-disk JSONL is preserved
//! across resumes and is the single source of truth for the UI.

use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::acp::infrastructure::snapshot_store::events_path;

#[derive(Clone, Copy)]
pub enum Direction {
    ClientToAgent,
    AgentToClient,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Direction::ClientToAgent => "c2a",
            Direction::AgentToClient => "a2c",
        }
    }
}

pub struct SessionLog {
    jean_session_id: String,
    path: PathBuf,
    file: Mutex<File>,
}

impl SessionLog {
    pub fn open(app: &AppHandle, jean_session_id: &str) -> Result<Self, String> {
        let path = events_path(app, jean_session_id)?;
        let file = OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|e| format!("open events log {path:?}: {e}"))?;
        Ok(SessionLog {
            jean_session_id: jean_session_id.to_string(),
            path,
            file: Mutex::new(file),
        })
    }

    pub fn jean_session_id(&self) -> &str {
        &self.jean_session_id
    }

    pub fn append(&self, direction: Direction, frame: &Value) {
        let entry = json!({
            "ts": now_ms(),
            "dir": direction.as_str(),
            "frame": frame,
        });
        let line = match serde_json::to_string(&entry) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[acp] failed to serialize log entry: {e}");
                return;
            }
        };
        let Ok(mut f) = self.file.lock() else {
            log::warn!("[acp] session log mutex poisoned for {:?}", self.path);
            return;
        };
        if let Err(e) = writeln!(f, "{line}") {
            log::warn!("[acp] failed appending to {:?}: {e}", self.path);
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
