use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};

use super::types::{
    SavedContextsMetadata, Session, SessionIndexEntry, SessionMetadata, WorktreeIndex,
    WorktreeSessions,
};

// ============================================================================
// Locking
// ============================================================================

/// Per-worktree mutex to prevent concurrent read-modify-write races on index files.
/// Each worktree gets its own mutex so different worktrees don't block each other.
static INDEX_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Per-session mutex to prevent concurrent read-modify-write races on metadata files.
/// Each session gets its own mutex so different sessions don't block each other.
static METADATA_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Global mutex to prevent concurrent read-modify-write races on session-context-metadata.json.
static SAVED_CONTEXTS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Get or create a mutex for a specific worktree index
fn get_index_lock(worktree_id: &str) -> Arc<Mutex<()>> {
    let mut locks = INDEX_LOCKS.lock().unwrap();
    locks
        .entry(worktree_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Get or create a mutex for a specific session metadata
fn get_metadata_lock(session_id: &str) -> Arc<Mutex<()>> {
    let mut locks = METADATA_LOCKS.lock().unwrap();
    locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

// ============================================================================
// Utility Functions
// ============================================================================

/// Sanitize a string for use as a filename
pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

// ============================================================================
// Directory Structure
// ============================================================================

/// Get the sessions base directory in app data (creates if not exists)
/// Structure: sessions/
pub fn get_sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let sessions_dir = app_data_dir.join("sessions");

    fs::create_dir_all(&sessions_dir)
        .map_err(|e| format!("Failed to create sessions directory: {e}"))?;

    Ok(sessions_dir)
}

/// Get the index directory (creates if not exists)
/// Structure: sessions/index/
pub fn get_index_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let sessions_dir = get_sessions_dir(app)?;
    let index_dir = sessions_dir.join("index");

    fs::create_dir_all(&index_dir).map_err(|e| format!("Failed to create index directory: {e}"))?;

    Ok(index_dir)
}

/// Get the data directory (creates if not exists)
/// Structure: sessions/data/
pub fn get_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let sessions_dir = get_sessions_dir(app)?;
    let data_dir = sessions_dir.join("data");

    fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data directory: {e}"))?;

    Ok(data_dir)
}

/// Get the index file path for a worktree
/// Path: sessions/index/{worktree_id}.json
pub fn get_index_path(app: &AppHandle, worktree_id: &str) -> Result<PathBuf, String> {
    let index_dir = get_index_dir(app)?;
    let safe_id = sanitize_filename(worktree_id);
    Ok(index_dir.join(format!("{safe_id}.json")))
}

/// Get the session data directory (creates if not exists)
/// Path: sessions/data/{session_id}/
pub fn get_session_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let data_dir = get_data_dir(app)?;
    let session_dir = data_dir.join(session_id);

    fs::create_dir_all(&session_dir)
        .map_err(|e| format!("Failed to create session directory: {e}"))?;

    Ok(session_dir)
}

/// Get the metadata file path for a session
/// Path: sessions/data/{session_id}/metadata.json
pub fn get_metadata_path(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let session_dir = get_session_dir(app, session_id)?;
    Ok(session_dir.join("metadata.json"))
}

/// Get the path for a closed base session's preserved index file
/// Path: sessions/index/base-{project_id}.json
pub fn get_base_index_path(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let index_dir = get_index_dir(app)?;
    let safe_id = sanitize_filename(project_id);
    Ok(index_dir.join(format!("base-{safe_id}.json")))
}

// ============================================================================
// Index Operations (WorktreeIndex)
// ============================================================================

/// Load a worktree index (internal, no locking)
fn load_index_internal(app: &AppHandle, worktree_id: &str) -> Result<WorktreeIndex, String> {
    let path = get_index_path(app, worktree_id)?;

    if path.exists() {
        let contents = fs::read_to_string(&path).map_err(|e| {
            log::error!("Failed to read index file: {e}");
            format!("Failed to read index: {e}")
        })?;

        let index: WorktreeIndex = serde_json::from_str(&contents).map_err(|e| {
            log::error!("Failed to parse index JSON: {e}");
            format!("Failed to parse index: {e}")
        })?;

        return Ok(index);
    }

    // No data exists - create new index with default session
    log::trace!("No existing index found, creating default for worktree {worktree_id}");
    Ok(WorktreeIndex::new(worktree_id.to_string()))
}

/// Save a worktree index (internal, no locking - atomic write)
fn save_index_internal(app: &AppHandle, index: &WorktreeIndex) -> Result<(), String> {
    log::trace!("Saving index for worktree: {}", index.worktree_id);
    let path = get_index_path(app, &index.worktree_id)?;
    let temp_path = path.with_extension("tmp");

    let json_content = serde_json::to_string_pretty(index).map_err(|e| {
        log::error!("Failed to serialize index: {e}");
        format!("Failed to serialize index: {e}")
    })?;

    fs::write(&temp_path, &json_content).map_err(|e| {
        log::error!("Failed to write index file: {e}");
        format!("Failed to write index: {e}")
    })?;

    fs::rename(&temp_path, &path).map_err(|e| {
        log::error!("Failed to finalize index file: {e}");
        format!("Failed to finalize index: {e}")
    })?;

    log::trace!(
        "Saved {} sessions in index for worktree {}",
        index.sessions.len(),
        index.worktree_id
    );
    Ok(())
}

/// Load a worktree index (with locking for thread safety)
pub fn load_index(app: &AppHandle, worktree_id: &str) -> Result<WorktreeIndex, String> {
    let lock = get_index_lock(worktree_id);
    let _guard = lock.lock().unwrap();

    let index = load_index_internal(app, worktree_id)?;

    // If this was a new index file, save it
    let index_path = get_index_path(app, worktree_id)?;
    if !index_path.exists() {
        save_index_internal(app, &index)?;
    }

    Ok(index)
}

/// Atomically load, modify, and save a worktree index.
/// This prevents race conditions by holding a lock for the entire operation.
pub fn with_index_mut<F, T>(app: &AppHandle, worktree_id: &str, f: F) -> Result<T, String>
where
    F: FnOnce(&mut WorktreeIndex) -> Result<T, String>,
{
    let lock = get_index_lock(worktree_id);
    let _guard = lock.lock().unwrap();

    let mut index = load_index_internal(app, worktree_id)?;
    let result = f(&mut index)?;
    save_index_internal(app, &index)?;

    Ok(result)
}

// ============================================================================
// Metadata Operations (SessionMetadata)
// ============================================================================

/// Load session metadata (internal, no locking)
fn load_metadata_internal(
    app: &AppHandle,
    session_id: &str,
) -> Result<Option<SessionMetadata>, String> {
    let path = get_metadata_path(app, session_id)?;

    if !path.exists() {
        return Ok(None);
    }

    let file =
        File::open(&path).map_err(|e| format!("Failed to open metadata file {path:?}: {e}"))?;

    let reader = BufReader::new(file);
    let metadata: SessionMetadata = serde_json::from_reader(reader)
        .map_err(|e| format!("Failed to parse metadata file {path:?}: {e}"))?;

    Ok(Some(metadata))
}

/// Save session metadata (internal, no locking - atomic write)
fn save_metadata_internal(app: &AppHandle, metadata: &SessionMetadata) -> Result<(), String> {
    let path = get_metadata_path(app, &metadata.id)?;
    let temp_path = path.with_extension("tmp");

    let file = File::create(&temp_path)
        .map_err(|e| format!("Failed to create temp metadata file: {e}"))?;

    let writer = BufWriter::new(file);
    serde_json::to_writer_pretty(writer, metadata)
        .map_err(|e| format!("Failed to write metadata: {e}"))?;

    fs::rename(&temp_path, &path).map_err(|e| format!("Failed to rename metadata file: {e}"))?;

    log::trace!("Saved metadata for session: {}", metadata.id);
    Ok(())
}

/// Load session metadata (with locking for thread safety)
pub fn load_metadata(app: &AppHandle, session_id: &str) -> Result<Option<SessionMetadata>, String> {
    let lock = get_metadata_lock(session_id);
    let _guard = lock.lock().unwrap();
    load_metadata_internal(app, session_id)
}

/// Save session metadata (with locking for thread safety)
pub fn save_metadata(app: &AppHandle, metadata: &SessionMetadata) -> Result<(), String> {
    let lock = get_metadata_lock(&metadata.id);
    let _guard = lock.lock().unwrap();
    save_metadata_internal(app, metadata)
}

/// Atomically load, modify, and save session metadata.
/// Creates new metadata if it doesn't exist.
pub fn with_metadata_mut<F, T>(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
    session_name: &str,
    order: u32,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&mut SessionMetadata) -> Result<T, String>,
{
    let lock = get_metadata_lock(session_id);
    let _guard = lock.lock().unwrap();

    let mut metadata = load_metadata_internal(app, session_id)?.unwrap_or_else(|| {
        SessionMetadata::new(
            session_id.to_string(),
            worktree_id.to_string(),
            session_name.to_string(),
            order,
        )
    });

    let result = f(&mut metadata)?;
    save_metadata_internal(app, &metadata)?;

    Ok(result)
}

/// Delete a session's metadata and all data files (with locking)
pub fn delete_session_data(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let lock = get_metadata_lock(session_id);
    let _guard = lock.lock().unwrap();

    let data_dir = get_data_dir(app)?;
    let session_dir = data_dir.join(session_id);

    if session_dir.exists() {
        fs::remove_dir_all(&session_dir)
            .map_err(|e| format!("Failed to delete session directory: {e}"))?;
        log::trace!("Deleted session data for: {session_id}");
    }

    Ok(())
}

/// List all session IDs in the data directory (for recovery scanning)
pub fn list_all_session_ids(app: &AppHandle) -> Result<Vec<String>, String> {
    let data_dir = get_data_dir(app)?;
    let mut session_ids = Vec::new();

    let entries =
        fs::read_dir(&data_dir).map_err(|e| format!("Failed to read data directory: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();

        // Check if it's a directory with a metadata.json
        if path.is_dir() && path.join("metadata.json").exists() {
            if let Some(session_id) = path.file_name().and_then(|n| n.to_str()) {
                session_ids.push(session_id.to_string());
            }
        }
    }

    Ok(session_ids)
}

/// Delete orphaned session data directories that are not referenced by any index file.
/// Returns the number of orphaned directories deleted.
pub fn cleanup_orphaned_session_data(app: &AppHandle) -> Result<u32, String> {
    // Collect all session IDs referenced in index files
    let index_dir = get_index_dir(app)?;
    let mut referenced_ids = std::collections::HashSet::new();

    if let Ok(entries) = fs::read_dir(&index_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(index) =
                        serde_json::from_str::<crate::chat::types::WorktreeIndex>(&content)
                    {
                        for session in &index.sessions {
                            referenced_ids.insert(session.id.clone());
                        }
                    }
                }
            }
        }
    }

    // Compare with what's on disk
    let all_on_disk = list_all_session_ids(app)?;
    let mut deleted = 0u32;

    for session_id in all_on_disk {
        if !referenced_ids.contains(&session_id) {
            log::trace!("Deleting orphaned session data: {session_id}");
            if let Err(e) = delete_session_data(app, &session_id) {
                log::warn!("Failed to delete orphaned session data {session_id}: {e}");
            } else {
                deleted += 1;
            }
        }
    }

    if deleted > 0 {
        log::info!("Cleaned up {deleted} orphaned session data directories");
    }

    Ok(deleted)
}

// ============================================================================
// High-Level Session API (Backward Compatibility)
// ============================================================================

/// Load all sessions for a worktree as WorktreeSessions (backward compatible API).
/// This is the main function used by commands.rs for session management.
pub fn load_sessions(
    app: &AppHandle,
    _worktree_path: &str,
    worktree_id: &str,
) -> Result<WorktreeSessions, String> {
    let index = load_index(app, worktree_id)?;

    // Load metadata for each session to build full Session objects
    let mut sessions = Vec::new();
    for entry in &index.sessions {
        let session = if let Ok(Some(metadata)) = load_metadata(app, &entry.id) {
            metadata.to_session()
        } else {
            // No metadata found - create minimal session from index entry
            // Use resolved backend from preferences instead of hardcoded Claude
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            Session {
                id: entry.id.clone(),
                name: entry.name.clone(),
                order: entry.order,
                created_at: now,
                updated_at: now,
                messages: vec![],
                message_count: Some(entry.message_count),
                backend: super::commands::resolve_default_backend(app, Some(worktree_id)),
                claude_session_id: None,
                codex_thread_id: None,
                opencode_session_id: None,
                selected_model: None,
                selected_thinking_level: None,
                selected_provider: None,
                session_naming_completed: false,
                archived_at: entry.archived_at,
                answered_questions: vec![],
                submitted_answers: std::collections::HashMap::new(),
                fixed_findings: vec![],
                review_results: None,
                pending_permission_denials: vec![],
                denied_message_context: None,
                is_reviewing: false,
                waiting_for_input: false,
                waiting_for_input_type: None,
                approved_plan_message_ids: vec![],
                plan_file_path: None,
                pending_plan_message_id: None,
                enabled_mcp_servers: None,
                digest: None,
                last_run_status: None,
                last_run_execution_mode: None,
                label: None,
            }
        };
        sessions.push(session);
    }

    Ok(WorktreeSessions {
        worktree_id: index.worktree_id,
        sessions,
        active_session_id: index.active_session_id,
        default_model: None,
        version: index.version,
        branch_naming_completed: index.branch_naming_completed,
    })
}

/// Atomically modify sessions (backward compatible with old with_sessions_mut).
/// Updates both index and metadata files.
pub fn with_sessions_mut<F, T>(
    app: &AppHandle,
    _worktree_path: &str,
    worktree_id: &str,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&mut WorktreeSessions) -> Result<T, String>,
{
    // Load current state
    let mut sessions = load_sessions(app, "", worktree_id)?;

    // Apply mutation
    let result = f(&mut sessions)?;

    // Save changes back to index
    with_index_mut(app, worktree_id, |index| {
        index.active_session_id = sessions.active_session_id.clone();
        index.branch_naming_completed = sessions.branch_naming_completed;

        // Update index entries and track which sessions need metadata updates
        let mut session_ids_in_use: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for session in &sessions.sessions {
            session_ids_in_use.insert(session.id.clone());

            if let Some(entry) = index.find_session_mut(&session.id) {
                // Update existing entry
                entry.name = session.name.clone();
                entry.order = session.order;
                entry.archived_at = session.archived_at;
                entry.message_count = session.message_count.unwrap_or(0);
            } else {
                // Add new entry
                index.sessions.push(SessionIndexEntry {
                    id: session.id.clone(),
                    name: session.name.clone(),
                    order: session.order,
                    message_count: session.message_count.unwrap_or(0),
                    archived_at: session.archived_at,
                });
            }
        }

        // Remove sessions that were deleted
        index
            .sessions
            .retain(|e| session_ids_in_use.contains(&e.id));

        Ok(())
    })?;

    // Save metadata for each session
    for session in &sessions.sessions {
        let lock = get_metadata_lock(&session.id);
        let _guard = lock.lock().unwrap();

        let mut metadata = load_metadata_internal(app, &session.id)?.unwrap_or_else(|| {
            SessionMetadata::new(
                session.id.clone(),
                worktree_id.to_string(),
                session.name.clone(),
                session.order,
            )
        });

        metadata.update_from_session(session);
        save_metadata_internal(app, &metadata)?;
    }

    Ok(result)
}

/// Get the index file path (for backward compatibility with old get_sessions_path)
pub fn get_sessions_path(app: &AppHandle, worktree_id: &str) -> Result<PathBuf, String> {
    get_index_path(app, worktree_id)
}

/// Load sessions by worktree_id only (for cleanup when worktree path may not exist)
pub fn load_sessions_by_id(app: &AppHandle, worktree_id: &str) -> Result<WorktreeSessions, String> {
    load_sessions(app, "", worktree_id)
}

/// Get the path for a closed base session's preserved index file
/// (Backward compatible with old get_closed_base_sessions_path)
pub fn get_closed_base_sessions_path(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    get_base_index_path(app, project_id)
}

// ============================================================================
// Base Session Preservation
// ============================================================================

/// Preserve sessions when closing a base session
/// Moves index file to base-{project_id}.json
pub fn preserve_base_sessions(
    app: &AppHandle,
    worktree_id: &str,
    project_id: &str,
) -> Result<(), String> {
    let lock = get_index_lock(worktree_id);
    let _guard = lock.lock().unwrap();

    let current_path = get_index_path(app, worktree_id)?;
    let preserved_path = get_base_index_path(app, project_id)?;

    if current_path.exists() {
        fs::rename(&current_path, &preserved_path).map_err(|e| {
            log::error!("Failed to preserve base sessions: {e}");
            format!("Failed to preserve base sessions: {e}")
        })?;
        log::trace!("Preserved base sessions from {current_path:?} to {preserved_path:?}");
    }

    Ok(())
}

/// Restore preserved sessions when reopening a base session
/// Loads from base-{project_id}.json and updates worktree_id
pub fn restore_base_sessions(
    app: &AppHandle,
    project_id: &str,
    new_worktree_id: &str,
) -> Result<Option<WorktreeIndex>, String> {
    let lock = get_index_lock(new_worktree_id);
    let _guard = lock.lock().unwrap();

    let preserved_path = get_base_index_path(app, project_id)?;

    if !preserved_path.exists() {
        log::trace!("No preserved base sessions found for project {project_id}");
        return Ok(None);
    }

    // Load the preserved index
    let contents = fs::read_to_string(&preserved_path)
        .map_err(|e| format!("Failed to read preserved index: {e}"))?;

    let mut index: WorktreeIndex = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse preserved index: {e}"))?;

    // Update the worktree_id to the new one
    index.worktree_id = new_worktree_id.to_string();

    // Save to the new location
    save_index_internal(app, &index)?;

    // Delete the preserved file
    fs::remove_file(&preserved_path).map_err(|e| {
        log::warn!("Failed to delete preserved index file: {e}");
        format!("Failed to delete preserved index: {e}")
    })?;

    log::trace!(
        "Restored {} sessions for base session {new_worktree_id}",
        index.sessions.len()
    );

    Ok(Some(index))
}

// ============================================================================
// Saved Contexts (unchanged from original)
// ============================================================================

/// Get the images directory path in app data directory (creates if not exists)
/// Used for storing pasted images: ~/Library/Application Support/<app>/pasted-images/
pub fn get_images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let path = app_data_dir.join("pasted-images");

    fs::create_dir_all(&path).map_err(|e| format!("Failed to create images directory: {e}"))?;

    Ok(path)
}

/// Get the pastes directory path in app data directory (creates if not exists)
/// Used for storing pasted text files: ~/Library/Application Support/<app>/pasted-texts/
pub fn get_pastes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let path = app_data_dir.join("pasted-texts");

    fs::create_dir_all(&path).map_err(|e| format!("Failed to create pastes directory: {e}"))?;

    Ok(path)
}

/// Get the saved contexts directory path in app data directory (creates if not exists)
/// Used for storing conversation context summaries: ~/Library/Application Support/<app>/session-context/
pub fn get_saved_contexts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let path = app_data_dir.join("session-context");

    fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create session-context directory: {e}"))?;

    Ok(path)
}

/// Get the saved contexts metadata file path
pub fn get_saved_contexts_metadata_path(app: &AppHandle) -> Result<PathBuf, String> {
    let contexts_dir = get_saved_contexts_dir(app)?;
    Ok(contexts_dir.join("session-context-metadata.json"))
}

/// Load saved contexts metadata (returns empty if file doesn't exist or is corrupt)
pub fn load_saved_contexts_metadata(app: &AppHandle) -> SavedContextsMetadata {
    let path = match get_saved_contexts_metadata_path(app) {
        Ok(p) => p,
        Err(_) => return SavedContextsMetadata::default(),
    };

    if !path.exists() {
        return SavedContextsMetadata::default();
    }

    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => SavedContextsMetadata::default(),
    }
}

/// Save saved contexts metadata (atomic write: temp file + rename, with locking)
pub fn save_saved_contexts_metadata(
    app: &AppHandle,
    metadata: &SavedContextsMetadata,
) -> Result<(), String> {
    let _lock = SAVED_CONTEXTS_LOCK.lock().unwrap();

    let path = get_saved_contexts_metadata_path(app)?;
    let temp_path = path.with_extension("tmp");

    let json = serde_json::to_string_pretty(metadata)
        .map_err(|e| format!("Failed to serialize metadata: {e}"))?;

    fs::write(&temp_path, &json).map_err(|e| format!("Failed to write metadata file: {e}"))?;

    fs::rename(&temp_path, &path).map_err(|e| format!("Failed to finalize metadata file: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_filename() {
        // Basic alphanumeric
        assert_eq!(sanitize_filename("test-id"), "test-id");
        assert_eq!(sanitize_filename("test_id"), "test_id");
        assert_eq!(sanitize_filename("TestId123"), "TestId123");

        // Special characters get replaced with dashes
        assert_eq!(sanitize_filename("test/id"), "test-id");
        assert_eq!(sanitize_filename("test:id"), "test-id");
        assert_eq!(sanitize_filename("test id"), "test-id");
        assert_eq!(sanitize_filename("test.id"), "test-id");

        // UUID-like strings
        assert_eq!(
            sanitize_filename("550e8400-e29b-41d4-a716-446655440000"),
            "550e8400-e29b-41d4-a716-446655440000"
        );
    }

    #[test]
    fn test_worktree_index_new() {
        let index = WorktreeIndex::new("test-worktree".to_string());

        assert_eq!(index.worktree_id, "test-worktree");
        assert_eq!(index.sessions.len(), 1);
        assert_eq!(index.sessions[0].name, "Session 1");
        assert_eq!(index.sessions[0].message_count, 0);
        assert_eq!(index.version, 1);
    }

    #[test]
    fn test_worktree_index_find_methods() {
        let mut index = WorktreeIndex::new("test".to_string());
        let session_id = index.sessions[0].id.clone();

        // Test find_session
        let found = index.find_session(&session_id);
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "Session 1");

        // Test find_session with non-existent ID
        let not_found = index.find_session("non-existent");
        assert!(not_found.is_none());

        // Test find_session_mut
        let found_mut = index.find_session_mut(&session_id);
        assert!(found_mut.is_some());
        found_mut.unwrap().name = "Updated Name".to_string();

        // Verify mutation worked
        assert_eq!(index.sessions[0].name, "Updated Name");
    }

    #[test]
    fn test_next_session_number() {
        let mut index = WorktreeIndex::new("test".to_string());

        // Start with 1 session, so next is 2
        assert_eq!(index.sessions.len(), 1);
        assert_eq!(index.next_session_number(), 2);

        // Add another session
        index.sessions.push(SessionIndexEntry {
            id: "sess-2".to_string(),
            name: "Session 2".to_string(),
            order: 1,
            message_count: 0,
            archived_at: None,
        });
        assert_eq!(index.sessions.len(), 2);
        assert_eq!(index.next_session_number(), 3);
    }

    #[test]
    fn test_session_metadata_new() {
        let metadata = SessionMetadata::new(
            "sess-123".to_string(),
            "wt-456".to_string(),
            "Test Session".to_string(),
            0,
        );

        assert_eq!(metadata.id, "sess-123");
        assert_eq!(metadata.worktree_id, "wt-456");
        assert_eq!(metadata.name, "Test Session");
        assert_eq!(metadata.order, 0);
        assert!(metadata.runs.is_empty());
        assert_eq!(metadata.version, 1);
    }
}
