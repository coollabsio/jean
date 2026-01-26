//! Context data from Claude Code hooks
//!
//! Reads context data written by Jean's context-writer hook.
//! The hook writes to ~/.jean/context-data/{session_id}.json after each response.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Context data written by the hook script
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookContextData {
    pub session_id: String,
    pub cost_usd: f64,
    pub duration_ms: u64,
    pub context_tokens: u64,
    pub context_max_tokens: u64,
    pub context_percentage: u64,
    pub timestamp: String,
}

/// Get the directory for context data files
fn get_context_data_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".jean").join("context-data"))
}

/// Get the path to context data file for a session
fn get_context_data_path(session_id: &str) -> Option<PathBuf> {
    let dir = get_context_data_dir()?;
    Some(dir.join(format!("{session_id}.json")))
}

/// Read context data from hook file
pub fn read_hook_context_data(session_id: &str) -> Option<HookContextData> {
    let path = get_context_data_path(session_id)?;

    if !path.exists() {
        return None;
    }

    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Ensure the context data directory exists
#[allow(dead_code)]
pub fn ensure_context_data_dir() -> Result<PathBuf, String> {
    let dir = get_context_data_dir().ok_or("Could not determine home directory")?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create context data directory: {e}"))?;
    Ok(dir)
}

/// Clean up old context data files (older than 7 days)
#[allow(dead_code)]
pub fn cleanup_old_context_data() -> Result<u32, String> {
    let dir = get_context_data_dir().ok_or("Could not determine home directory")?;

    if !dir.exists() {
        return Ok(0);
    }

    let now = std::time::SystemTime::now();
    let max_age = std::time::Duration::from_secs(7 * 24 * 60 * 60); // 7 days
    let mut removed = 0;

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(age) = now.duration_since(modified) {
                        if age > max_age && fs::remove_file(entry.path()).is_ok() {
                            removed += 1;
                        }
                    }
                }
            }
        }
    }

    Ok(removed)
}
