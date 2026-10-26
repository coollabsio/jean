//! Per-client UI navigation snapshots.
//!
//! `ui-state.json` stays the shared record for pinned recent sessions and
//! pinned canvas labels. Each browser, phone, and desktop window stores its
//! own navigation snapshot under `ui-clients/<client-id>.json`.
//!
//! The installation's native client claims the legacy shared snapshot once,
//! at startup. Other clients start from an empty navigation snapshot and only
//! inherit the shared pins and labels.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::{
    lock_ui_state_writes, read_ui_state_file, write_ui_state_file, TerminalInstancePersisted,
    UIState,
};

const UI_CLIENTS_DIR: &str = "ui-clients";
const LEGACY_CLAIMED_FILE: &str = "legacy-claimed";
const NATIVE_CLIENT_ID_FILE: &str = "native-client-id";
const SHARED_UI_STATE_FILE: &str = "ui-state.json";

pub const INVALID_CLIENT_ID: &str = "Invalid client id";

#[derive(Debug, Clone, Default)]
pub struct AggregatedTerminalUi {
    pub terminal_instances: HashMap<String, Vec<TerminalInstancePersisted>>,
    pub active_session_ids: HashMap<String, String>,
}

pub fn shared_ui_state_path(app_data: &Path) -> PathBuf {
    app_data.join(SHARED_UI_STATE_FILE)
}

fn ui_clients_dir(app_data: &Path) -> PathBuf {
    app_data.join(UI_CLIENTS_DIR)
}

fn legacy_claimed_path(app_data: &Path) -> PathBuf {
    ui_clients_dir(app_data).join(LEGACY_CLAIMED_FILE)
}

fn native_client_id_path(app_data: &Path) -> PathBuf {
    app_data.join(NATIVE_CLIENT_ID_FILE)
}

pub fn canonical_client_id(client_id: &str) -> Result<String, String> {
    let trimmed = client_id.trim();
    let parsed = uuid::Uuid::parse_str(trimmed).map_err(|_| INVALID_CLIENT_ID.to_string())?;
    if parsed.is_nil() {
        return Err(INVALID_CLIENT_ID.to_string());
    }
    let canonical = parsed.to_string();
    if trimmed != canonical {
        return Err(INVALID_CLIENT_ID.to_string());
    }
    Ok(canonical)
}

pub fn client_ui_state_path(app_data: &Path, client_id: &str) -> Result<PathBuf, String> {
    let id = canonical_client_id(client_id)?;
    Ok(ui_clients_dir(app_data).join(format!("{id}.json")))
}

/// Copy the legacy shared snapshot onto this installation's native client, once.
///
/// Browsers and remote clients never receive that snapshot. Pins and pinned
/// canvas labels remain in `ui-state.json` for every client.
pub fn ensure_native_ui_client(app_data: &Path) -> Result<String, String> {
    let _guard = lock_ui_state_writes();
    ensure_native_ui_client_locked(app_data)
}

pub fn load_client_ui_state(app_data: &Path, client_id: &str) -> Result<UIState, String> {
    let id = canonical_client_id(client_id)?;
    let _guard = lock_ui_state_writes();
    let path = ui_clients_dir(app_data).join(format!("{id}.json"));
    let state = if path.exists() {
        read_ui_state_file(&path)?
    } else {
        UIState::default()
    };
    overlay_shared_ui_state_locked(app_data, state)
}

pub fn load_shared_navigation_defaults(app_data: &Path) -> Result<UIState, String> {
    let _guard = lock_ui_state_writes();
    overlay_shared_ui_state_locked(app_data, UIState::default())
}

pub fn save_client_ui_state(
    app_data: &Path,
    client_id: &str,
    mut ui_state: UIState,
) -> Result<(), String> {
    let id = canonical_client_id(client_id)?;
    let _guard = lock_ui_state_writes();
    let path = ui_clients_dir(app_data).join(format!("{id}.json"));
    // Pins live only in the shared file. A full snapshot must not replace them.
    ui_state.pinned_recent_session_ids.clear();
    let canvas_settings = ui_state.project_canvas_settings.clone();
    write_ui_state_file(&path, &ui_state)?;
    merge_shared_canvas_settings_locked(app_data, canvas_settings)
}

/// Running and stopped command terminals recorded by any client's panel list.
///
/// Conflicting per-worktree active sessions are omitted so one client does not
/// pick another client's open chat.
pub fn aggregated_terminal_snapshot(app_data: &Path) -> Result<AggregatedTerminalUi, String> {
    let _guard = lock_ui_state_writes();
    let mut snapshot = AggregatedTerminalUi::default();
    let mut session_conflicts = HashSet::new();

    if let Ok(entries) = std::fs::read_dir(ui_clients_dir(app_data)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if canonical_client_id(stem).is_err() {
                continue;
            }
            merge_terminal_ui(&mut snapshot, &mut session_conflicts, &path);
        }
    }

    let shared = shared_ui_state_path(app_data);
    if shared.exists() {
        merge_terminal_ui(&mut snapshot, &mut session_conflicts, &shared);
    }

    Ok(snapshot)
}

fn merge_terminal_ui(
    snapshot: &mut AggregatedTerminalUi,
    conflicts: &mut HashSet<String>,
    path: &Path,
) {
    let state = match read_ui_state_file(path) {
        Ok(state) => state,
        Err(error) => {
            log::warn!("Skipping unreadable UI state {}: {error}", path.display());
            return;
        }
    };

    let mut seen_ids: HashSet<String> = snapshot
        .terminal_instances
        .values()
        .flatten()
        .map(|terminal| terminal.id.clone())
        .collect();
    for (worktree_id, terminals) in state.terminal_instances {
        let dest = snapshot.terminal_instances.entry(worktree_id).or_default();
        for terminal in terminals {
            if seen_ids.insert(terminal.id.clone()) {
                dest.push(terminal);
            }
        }
    }

    for (worktree_id, session_id) in state.active_session_ids {
        if conflicts.contains(&worktree_id) {
            continue;
        }
        match snapshot.active_session_ids.get(&worktree_id) {
            Some(existing) if existing != &session_id => {
                snapshot.active_session_ids.remove(&worktree_id);
                conflicts.insert(worktree_id);
            }
            Some(_) => {}
            None => {
                snapshot.active_session_ids.insert(worktree_id, session_id);
            }
        }
    }
}

fn overlay_shared_ui_state_locked(app_data: &Path, mut state: UIState) -> Result<UIState, String> {
    let shared_path = shared_ui_state_path(app_data);
    if !shared_path.exists() {
        state.pinned_recent_session_ids.clear();
        return Ok(state);
    }

    match read_ui_state_file(&shared_path) {
        Ok(shared) => {
            state.pinned_recent_session_ids = shared.pinned_recent_session_ids;
            state.project_canvas_settings = shared.project_canvas_settings;
            Ok(state)
        }
        Err(error) => {
            log::warn!(
                "Shared UI state is unreadable; this client keeps its own pins and labels: {error}"
            );
            Ok(state)
        }
    }
}

fn merge_shared_canvas_settings_locked(
    app_data: &Path,
    canvas_settings: HashMap<String, super::ProjectCanvasSettings>,
) -> Result<(), String> {
    let path = shared_ui_state_path(app_data);
    let mut shared = if path.exists() {
        match read_ui_state_file(&path) {
            Ok(state) => state,
            Err(error) => {
                log::warn!(
                    "Replacing unreadable shared UI state while saving canvas labels: {error}"
                );
                UIState::default()
            }
        }
    } else {
        UIState::default()
    };
    shared.project_canvas_settings = canvas_settings;
    write_ui_state_file(&path, &shared)
}

fn ensure_native_ui_client_locked(app_data: &Path) -> Result<String, String> {
    let id = read_or_create_native_client_id(app_data)?;
    let marker = legacy_claimed_path(app_data);
    if marker.exists() {
        return Ok(id);
    }

    let shared_path = shared_ui_state_path(app_data);
    if shared_path.exists() {
        match read_ui_state_file(&shared_path) {
            Ok(legacy) => {
                let client_path = ui_clients_dir(app_data).join(format!("{id}.json"));
                if !client_path.exists() {
                    write_ui_state_file(&client_path, &legacy)?;
                    log::info!("Assigned legacy UI navigation to the native client {id}");
                }
                write_ui_state_file(&shared_path, &shared_fields_only(&legacy))?;
            }
            Err(error) => {
                log::warn!(
                    "Left unreadable legacy UI state in place; native client {id} starts empty: {error}"
                );
                write_claimed_marker(&marker, &id)?;
                return Ok(id);
            }
        }
    }

    write_claimed_marker(&marker, &id)?;
    Ok(id)
}

fn shared_fields_only(state: &UIState) -> UIState {
    UIState {
        pinned_recent_session_ids: state.pinned_recent_session_ids.clone(),
        project_canvas_settings: state.project_canvas_settings.clone(),
        version: state.version,
        ..UIState::default()
    }
}

fn read_or_create_native_client_id(app_data: &Path) -> Result<String, String> {
    let path = native_client_id_path(app_data);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if let Ok(id) = canonical_client_id(&existing) {
            return Ok(id);
        }
        log::warn!("Replacing invalid native client id at {}", path.display());
    }

    let id = uuid::Uuid::new_v4().to_string();
    write_text_file(&path, &id)?;
    Ok(id)
}

fn write_claimed_marker(path: &Path, client_id: &str) -> Result<(), String> {
    write_text_file(path, client_id)
}

fn write_text_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    crate::platform::write_file_atomically(path, contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;
    use crate::chat::types::LabelData;
    use crate::{ProjectCanvasSettings, TerminalInstancePersisted, UIState};

    fn client_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn write_raw(path: &Path, state: &UIState) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, serde_json::to_string_pretty(state).unwrap()).unwrap();
    }

    fn terminal(id: &str) -> TerminalInstancePersisted {
        TerminalInstancePersisted {
            id: id.to_string(),
            command: Some("bun run dev".to_string()),
            command_args: None,
            label: "dev".to_string(),
            kind: Some("panel".to_string()),
            session_id: None,
        }
    }

    #[test]
    fn clients_keep_independent_navigation_and_share_pins() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let client_a = client_id();
        let client_b = client_id();

        write_raw(
            &shared_ui_state_path(app_data),
            &UIState {
                pinned_recent_session_ids: vec!["shared-pin".to_string()],
                active_worktree_id: Some("legacy-worktree".to_string()),
                ..UIState::default()
            },
        );

        save_client_ui_state(
            app_data,
            &client_a,
            UIState {
                active_worktree_id: Some("worktree-a".to_string()),
                active_project_id: Some("project-a".to_string()),
                input_drafts: HashMap::from([("session-a".to_string(), "draft-a".to_string())]),
                project_canvas_settings: HashMap::from([(
                    "project-a".to_string(),
                    ProjectCanvasSettings {
                        pinned_labels: vec![LabelData {
                            name: "Important".to_string(),
                            color: "#ef4444".to_string(),
                            pinned: true,
                        }],
                        ..ProjectCanvasSettings::default()
                    },
                )]),
                pinned_recent_session_ids: vec!["stale-pin".to_string()],
                ..UIState::default()
            },
        )
        .unwrap();

        let fresh = load_client_ui_state(app_data, &client_id()).unwrap();
        assert_eq!(fresh.active_worktree_id, None);
        assert!(fresh.input_drafts.is_empty());
        assert_eq!(
            fresh.pinned_recent_session_ids,
            vec!["shared-pin".to_string()]
        );
        assert_eq!(
            fresh.project_canvas_settings["project-a"].pinned_labels[0].name,
            "Important"
        );

        save_client_ui_state(
            app_data,
            &client_b,
            UIState {
                active_worktree_id: Some("worktree-b".to_string()),
                input_drafts: HashMap::from([("session-b".to_string(), "draft-b".to_string())]),
                project_canvas_settings: fresh.project_canvas_settings.clone(),
                ..UIState::default()
            },
        )
        .unwrap();

        let loaded_a = load_client_ui_state(app_data, &client_a).unwrap();
        let loaded_b = load_client_ui_state(app_data, &client_b).unwrap();
        assert_eq!(loaded_a.active_worktree_id.as_deref(), Some("worktree-a"));
        assert_eq!(loaded_a.active_project_id.as_deref(), Some("project-a"));
        assert_eq!(
            loaded_a.input_drafts.get("session-a").map(String::as_str),
            Some("draft-a")
        );
        assert_eq!(loaded_b.active_worktree_id.as_deref(), Some("worktree-b"));
        assert!(loaded_b.input_drafts.get("session-a").is_none());
        assert_eq!(
            loaded_a.pinned_recent_session_ids,
            vec!["shared-pin".to_string()]
        );
        assert_eq!(
            loaded_b.pinned_recent_session_ids,
            loaded_a.pinned_recent_session_ids
        );

        let shared = read_ui_state_file(&shared_ui_state_path(app_data)).unwrap();
        assert_eq!(
            shared.active_worktree_id.as_deref(),
            Some("legacy-worktree")
        );
        assert_eq!(
            shared.pinned_recent_session_ids,
            vec!["shared-pin".to_string()]
        );
    }

    #[test]
    fn native_client_claims_legacy_navigation_once() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        write_raw(
            &shared_ui_state_path(app_data),
            &UIState {
                active_worktree_id: Some("desktop-worktree".to_string()),
                active_project_id: Some("desktop-project".to_string()),
                active_session_ids: HashMap::from([(
                    "desktop-worktree".to_string(),
                    "desktop-session".to_string(),
                )]),
                input_drafts: HashMap::from([(
                    "desktop-session".to_string(),
                    "keep me".to_string(),
                )]),
                pinned_recent_session_ids: vec!["pin".to_string()],
                ..UIState::default()
            },
        );

        let browser = client_id();
        let browser_state = load_client_ui_state(app_data, &browser).unwrap();
        assert_eq!(browser_state.active_worktree_id, None);
        assert_eq!(browser_state.input_drafts.len(), 0);
        assert_eq!(
            browser_state.pinned_recent_session_ids,
            vec!["pin".to_string()]
        );

        let native_id = ensure_native_ui_client(app_data).unwrap();
        let native_state = load_client_ui_state(app_data, &native_id).unwrap();
        assert_eq!(
            native_state.active_worktree_id.as_deref(),
            Some("desktop-worktree")
        );
        assert_eq!(
            native_state.active_project_id.as_deref(),
            Some("desktop-project")
        );
        assert_eq!(
            native_state
                .input_drafts
                .get("desktop-session")
                .map(String::as_str),
            Some("keep me")
        );
        assert_eq!(
            native_state.pinned_recent_session_ids,
            vec!["pin".to_string()]
        );

        let shared = read_ui_state_file(&shared_ui_state_path(app_data)).unwrap();
        assert_eq!(shared.active_worktree_id, None);
        assert!(shared.active_session_ids.is_empty());
        assert!(shared.input_drafts.is_empty());
        assert_eq!(shared.pinned_recent_session_ids, vec!["pin".to_string()]);

        save_client_ui_state(
            app_data,
            &browser,
            UIState {
                active_worktree_id: Some("phone-worktree".to_string()),
                ..UIState::default()
            },
        )
        .unwrap();
        assert_eq!(
            ensure_native_ui_client(app_data).unwrap(),
            native_id,
            "a second startup must keep the same native client"
        );
        let native_again = load_client_ui_state(app_data, &native_id).unwrap();
        assert_eq!(
            native_again.active_worktree_id.as_deref(),
            Some("desktop-worktree")
        );
        let browser_again = load_client_ui_state(app_data, &browser).unwrap();
        assert_eq!(
            browser_again.active_worktree_id.as_deref(),
            Some("phone-worktree")
        );
        assert_eq!(
            read_ui_state_file(&shared_ui_state_path(app_data))
                .unwrap()
                .active_worktree_id,
            None
        );
    }

    #[test]
    fn invalid_client_ids_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for id in [
            "../ui-state",
            "not-a-uuid",
            "",
            "00000000-0000-0000-0000-000000000000",
            "UUID",
        ] {
            let error = save_client_ui_state(dir.path(), id, UIState::default()).unwrap_err();
            assert_eq!(error, INVALID_CLIENT_ID);
        }
        assert!(!ui_clients_dir(dir.path()).exists());
    }

    #[test]
    fn aggregated_terminals_union_clients_and_drop_session_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path();
        let client_a = client_id();
        let client_b = client_id();

        save_client_ui_state(
            app_data,
            &client_a,
            UIState {
                terminal_instances: HashMap::from([(
                    "wt".to_string(),
                    vec![terminal("term-a"), terminal("shared-term")],
                )]),
                active_session_ids: HashMap::from([
                    ("wt".to_string(), "session-a".to_string()),
                    ("other".to_string(), "only-a".to_string()),
                ]),
                ..UIState::default()
            },
        )
        .unwrap();
        save_client_ui_state(
            app_data,
            &client_b,
            UIState {
                terminal_instances: HashMap::from([(
                    "wt".to_string(),
                    vec![terminal("term-b"), terminal("shared-term")],
                )]),
                active_session_ids: HashMap::from([
                    ("wt".to_string(), "session-b".to_string()),
                    ("other".to_string(), "only-a".to_string()),
                ]),
                ..UIState::default()
            },
        )
        .unwrap();

        let snapshot = aggregated_terminal_snapshot(app_data).unwrap();
        let ids: HashSet<&str> = snapshot.terminal_instances["wt"]
            .iter()
            .map(|terminal| terminal.id.as_str())
            .collect();
        assert_eq!(ids, HashSet::from(["term-a", "shared-term", "term-b"]));
        assert!(!snapshot.active_session_ids.contains_key("wt"));
        assert_eq!(
            snapshot.active_session_ids.get("other").map(String::as_str),
            Some("only-a")
        );
    }
}
