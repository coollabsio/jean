//! ScheduleWakeup support — persists and fires delayed prompts requested
//! by Claude CLI via the `ScheduleWakeup` tool call.
//!
//! Flow:
//! 1. Claude stream handler detects tool_use with `name == "ScheduleWakeup"`
//!    and calls `schedule_from_tool_input()`.
//! 2. The scheduler clamps `delaySeconds` to [60, 3600], persists a
//!    `ScheduledWakeup` on `SessionMetadata`, and inserts an entry into
//!    an in-memory `BTreeMap<fire_at_unix, ...>` for O(log n) polling.
//! 3. `BackgroundTaskManager` calls `drain_due()` every 10 s; fired
//!    entries are removed from disk + memory and broadcast to the
//!    frontend via `chat:wakeup_fired`, which triggers `sendMessage`
//!    with the stored prompt.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::storage;
use super::types::ScheduledWakeup;

const MIN_DELAY_SECS: u64 = 60;
const MAX_DELAY_SECS: u64 = 3600;

/// Entry stored in the in-memory scheduler map.
#[derive(Debug, Clone)]
struct WakeupEntry {
    session_id: String,
    worktree_id: String,
    tool_call_id: String,
    prompt: String,
    #[allow(dead_code)]
    reason: String,
    #[allow(dead_code)]
    delay_seconds: u64,
    #[allow(dead_code)]
    scheduled_at_unix: u64,
}

/// Key = fire_at_unix; value = list of entries firing at that second.
/// Ties broken by insertion order within the vec.
type WakeupMap = BTreeMap<u64, Vec<WakeupEntry>>;

static SCHEDULER: Lazy<Mutex<WakeupMap>> = Lazy::new(|| Mutex::new(BTreeMap::new()));

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Payload broadcast to the frontend when a wakeup fires.
#[derive(Debug, Clone, Serialize)]
pub struct WakeupFiredEvent {
    pub session_id: String,
    pub worktree_id: String,
    pub worktree_path: String,
    pub prompt: String,
    pub tool_call_id: String,
}

/// Payload broadcast when a wakeup is newly scheduled (for UI countdown).
#[derive(Debug, Clone, Serialize)]
pub struct WakeupScheduledEvent {
    pub session_id: String,
    pub worktree_id: String,
    pub wakeup: ScheduledWakeup,
}

/// Payload broadcast when a wakeup is cancelled.
#[derive(Debug, Clone, Serialize)]
pub struct WakeupCancelledEvent {
    pub session_id: String,
    pub worktree_id: String,
    pub tool_call_id: Option<String>,
}

/// Extract scheduling parameters from a `ScheduleWakeup` tool_use input and persist.
/// Returns the resolved `ScheduledWakeup` on success.
pub fn schedule_from_tool_input(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    tool_call_id: &str,
    input: &Value,
) -> Result<ScheduledWakeup, String> {
    let delay_raw = input
        .get("delaySeconds")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "ScheduleWakeup: missing delaySeconds".to_string())?;
    let delay_seconds = delay_raw.clamp(MIN_DELAY_SECS, MAX_DELAY_SECS);
    if delay_raw != delay_seconds {
        log::warn!(
            "ScheduleWakeup: delaySeconds {delay_raw} clamped to {delay_seconds} (session={session_id})"
        );
    }

    let prompt = input
        .get("prompt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "ScheduleWakeup: missing prompt".to_string())?
        .to_string();
    if prompt.trim().is_empty() {
        return Err("ScheduleWakeup: prompt is empty".to_string());
    }

    let reason = input
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let scheduled_at_unix = now_unix();
    let fire_at_unix = scheduled_at_unix.saturating_add(delay_seconds);
    let wakeup = ScheduledWakeup {
        fire_at_unix,
        scheduled_at_unix,
        delay_seconds,
        prompt: prompt.clone(),
        reason: reason.clone(),
        tool_call_id: tool_call_id.to_string(),
    };

    schedule(app, session_id, worktree_id, wakeup.clone())?;
    Ok(wakeup)
}

/// Persist + register a wakeup. Overwrites any prior wakeup on the session
/// (last-wins, matches `/loop` semantics where each call replaces the tick).
pub fn schedule(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    wakeup: ScheduledWakeup,
) -> Result<(), String> {
    storage::with_existing_metadata_mut(app, session_id, |m| {
        m.scheduled_wakeup = Some(wakeup.clone());
    })?;

    {
        let mut map = SCHEDULER.lock().unwrap();
        remove_entries_for_session(&mut map, session_id);
        map.entry(wakeup.fire_at_unix)
            .or_default()
            .push(WakeupEntry {
                session_id: session_id.to_string(),
                worktree_id: worktree_id.to_string(),
                tool_call_id: wakeup.tool_call_id.clone(),
                prompt: wakeup.prompt.clone(),
                reason: wakeup.reason.clone(),
                delay_seconds: wakeup.delay_seconds,
                scheduled_at_unix: wakeup.scheduled_at_unix,
            });
    }

    let _ = app.emit(
        "chat:wakeup_scheduled",
        &WakeupScheduledEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            wakeup,
        },
    );

    Ok(())
}

/// Cancel any pending wakeup for a session (user action or system cleanup).
pub fn cancel(app: &AppHandle, session_id: &str) -> Result<Option<ScheduledWakeup>, String> {
    let cleared =
        storage::with_existing_metadata_mut(app, session_id, |m| m.scheduled_wakeup.take())?;

    let worktree_id_hint = {
        let mut map = SCHEDULER.lock().unwrap();
        let hint = map
            .values()
            .flat_map(|v| v.iter())
            .find(|e| e.session_id == session_id)
            .map(|e| e.worktree_id.clone());
        remove_entries_for_session(&mut map, session_id);
        hint
    };

    if let Some(wakeup) = &cleared {
        let worktree_id = worktree_id_hint.unwrap_or_default();
        let _ = app.emit(
            "chat:wakeup_cancelled",
            &WakeupCancelledEvent {
                session_id: session_id.to_string(),
                worktree_id,
                tool_call_id: Some(wakeup.tool_call_id.clone()),
            },
        );
    }

    Ok(cleared)
}

/// Drop entries for a specific session from the in-memory map.
fn remove_entries_for_session(map: &mut WakeupMap, session_id: &str) {
    let mut empty_keys: Vec<u64> = Vec::new();
    for (key, list) in map.iter_mut() {
        list.retain(|e| e.session_id != session_id);
        if list.is_empty() {
            empty_keys.push(*key);
        }
    }
    for key in empty_keys {
        map.remove(&key);
    }
}

/// Drain all entries whose `fire_at_unix <= now_unix`. For each,
/// clear the persisted wakeup on the session and emit `chat:wakeup_fired`.
///
/// Called by BackgroundTaskManager every ~10 s.
pub fn fire_due(app: &AppHandle) {
    let now = now_unix();
    let due: Vec<WakeupEntry> = {
        let mut map = SCHEDULER.lock().unwrap();
        let due_keys: Vec<u64> = map.range(..=now).map(|(k, _)| *k).collect();
        let mut out = Vec::new();
        for k in due_keys {
            if let Some(list) = map.remove(&k) {
                out.extend(list);
            }
        }
        out
    };

    if due.is_empty() {
        return;
    }

    log::info!("wakeup::fire_due: firing {} wakeup(s)", due.len());

    for entry in due {
        if let Err(e) = storage::with_existing_metadata_mut(app, &entry.session_id, |m| {
            // Only clear if the persisted wakeup matches (avoid racing a newer schedule).
            let matches = m
                .scheduled_wakeup
                .as_ref()
                .map(|w| w.tool_call_id == entry.tool_call_id)
                .unwrap_or(false);
            if matches {
                m.scheduled_wakeup = None;
            }
            matches
        }) {
            log::warn!(
                "wakeup::fire_due: failed to clear persisted wakeup for session={}: {e}",
                entry.session_id
            );
            continue;
        }

        let worktree_path = resolve_worktree_path(app, &entry.worktree_id).unwrap_or_default();
        if worktree_path.is_empty() {
            log::warn!(
                "wakeup::fire_due: cannot resolve worktree_path for worktree_id={}, skipping",
                entry.worktree_id
            );
            continue;
        }

        let _ = app.emit(
            "chat:wakeup_fired",
            &WakeupFiredEvent {
                session_id: entry.session_id.clone(),
                worktree_id: entry.worktree_id.clone(),
                worktree_path,
                prompt: entry.prompt.clone(),
                tool_call_id: entry.tool_call_id.clone(),
            },
        );

        let _ = (entry.delay_seconds, entry.scheduled_at_unix);
    }
}

/// Resolve a worktree's filesystem path from its ID via the projects registry.
fn resolve_worktree_path(app: &AppHandle, worktree_id: &str) -> Option<String> {
    let data = crate::projects::storage::load_projects_data(app).ok()?;
    data.find_worktree(worktree_id).map(|w| w.path.clone())
}

/// Load every persisted `ScheduledWakeup` from disk and repopulate the
/// in-memory map. Called once at app startup.
///
/// Entries whose `fire_at_unix <= now` remain in the map and will fire on
/// the next `fire_due()` poll tick — giving the frontend a moment to
/// subscribe before events land.
pub fn load_all_from_disk(app: &AppHandle) -> Result<usize, String> {
    let data_dir = storage::get_data_dir(app)?;
    let read_dir = match std::fs::read_dir(&data_dir) {
        Ok(d) => d,
        Err(_) => return Ok(0),
    };

    let mut loaded = 0usize;
    let mut map = SCHEDULER.lock().unwrap();
    map.clear();

    for entry in read_dir.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let session_id = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let metadata = match storage::load_metadata(app, &session_id) {
            Ok(Some(m)) => m,
            _ => continue,
        };
        let Some(w) = metadata.scheduled_wakeup.clone() else {
            continue;
        };
        map.entry(w.fire_at_unix).or_default().push(WakeupEntry {
            session_id: metadata.id.clone(),
            worktree_id: metadata.worktree_id.clone(),
            tool_call_id: w.tool_call_id.clone(),
            prompt: w.prompt.clone(),
            reason: w.reason.clone(),
            delay_seconds: w.delay_seconds,
            scheduled_at_unix: w.scheduled_at_unix,
        });
        loaded += 1;
    }

    log::info!("wakeup::load_all_from_disk: loaded {loaded} pending wakeup(s)");
    Ok(loaded)
}

/// Get the pending wakeup for a session (UI hydration).
pub fn get_for_session(
    app: &AppHandle,
    session_id: &str,
) -> Result<Option<ScheduledWakeup>, String> {
    Ok(storage::load_metadata(app, session_id)?.and_then(|m| m.scheduled_wakeup))
}

/// Entry returned by `list_pending`: session context + wakeup payload.
#[derive(Debug, Clone, Serialize)]
pub struct PendingWakeupEntry {
    pub session_id: String,
    pub worktree_id: String,
    pub wakeup: ScheduledWakeup,
}

/// Return all currently-pending wakeups from the in-memory map. Used by the
/// frontend on mount to hydrate the store so reloads do not leave historical
/// ScheduleWakeup tool_use blocks stuck in the "pending" spinner state.
pub fn list_pending() -> Vec<PendingWakeupEntry> {
    let map = SCHEDULER.lock().unwrap();
    let mut out = Vec::new();
    for (fire_at, list) in map.iter() {
        for e in list {
            out.push(PendingWakeupEntry {
                session_id: e.session_id.clone(),
                worktree_id: e.worktree_id.clone(),
                wakeup: ScheduledWakeup {
                    fire_at_unix: *fire_at,
                    scheduled_at_unix: e.scheduled_at_unix,
                    delay_seconds: e.delay_seconds,
                    prompt: e.prompt.clone(),
                    reason: e.reason.clone(),
                    tool_call_id: e.tool_call_id.clone(),
                },
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamp_min() {
        let v = json!({ "delaySeconds": 10u64, "prompt": "x" });
        assert_eq!(v.get("delaySeconds").and_then(|d| d.as_u64()).unwrap(), 10);
        let clamped = (10u64).clamp(MIN_DELAY_SECS, MAX_DELAY_SECS);
        assert_eq!(clamped, MIN_DELAY_SECS);
    }

    #[test]
    fn clamp_max() {
        let clamped = (100_000u64).clamp(MIN_DELAY_SECS, MAX_DELAY_SECS);
        assert_eq!(clamped, MAX_DELAY_SECS);
    }

    #[test]
    fn map_remove_for_session() {
        let mut map: WakeupMap = BTreeMap::new();
        map.entry(100).or_default().push(WakeupEntry {
            session_id: "s1".into(),
            worktree_id: "w1".into(),
            tool_call_id: "t1".into(),
            prompt: "p".into(),
            reason: "r".into(),
            delay_seconds: 60,
            scheduled_at_unix: 40,
        });
        map.entry(100).or_default().push(WakeupEntry {
            session_id: "s2".into(),
            worktree_id: "w1".into(),
            tool_call_id: "t2".into(),
            prompt: "p".into(),
            reason: "r".into(),
            delay_seconds: 60,
            scheduled_at_unix: 40,
        });
        remove_entries_for_session(&mut map, "s1");
        assert_eq!(map.get(&100).unwrap().len(), 1);
        remove_entries_for_session(&mut map, "s2");
        assert!(!map.contains_key(&100));
    }
}
