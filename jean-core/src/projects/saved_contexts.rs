use serde::{Deserialize, Serialize};

/// Attached saved context info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedSavedContext {
    pub slug: String,
    pub name: Option<String>,
    pub size: u64,
    pub created_at: u64,
}

/// Slug used when attaching a lightweight session reference to another session.
pub fn session_reference_slug(source_session_id: &str) -> String {
    format!("session-ref-{source_session_id}")
}

/// Build the MCP-pointer prompt attached when injecting a session into context.
///
/// Intentionally does **not** embed message history — the agent should use
/// Jean MCP `read_session_messages` to fetch only what it needs.
pub fn build_session_reference_content(
    source_session_id: &str,
    session_name: &str,
    project_name: &str,
    worktree_name: &str,
) -> String {
    format!(
        r#"# Session: {session_name}

The user has requested to take a look at session `{source_session_id}` (name: "{session_name}", project: {project_name}, worktree: {worktree_name}).

Use the Jean MCP tool `read_session_messages` with `sessionId` set to `{source_session_id}` to fetch the most recent messages from the user and agent (start with a small `limit`, e.g. 2–10; results are most recent first). If you need more context to understand what the user is looking for, you may fetch additional messages from the history. Do **not** consume the entire session at once.

You may also use `get_session_status` with the same `sessionId` if you need run state for that session.
"#
    )
}

/// Attach a saved context to a session by copying it to the session-specific location.
///
/// Storage location: `app-data/session-context/{session_id}-context-{slug}.md`
pub async fn attach_saved_context(
    app: tauri::AppHandle,
    session_id: String,
    source_path: String,
    slug: String,
) -> Result<AttachedSavedContext, String> {
    log::trace!("Attaching saved context '{slug}' for session {session_id}");

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let saved_contexts_dir = app_data_dir.join("session-context");
    std::fs::create_dir_all(&saved_contexts_dir)
        .map_err(|e| format!("Failed to create session-context directory: {e}"))?;

    // Read source file
    let source = std::path::Path::new(&source_path);
    if !source.exists() {
        return Err(format!("Source context file not found: {source_path}"));
    }

    let content = std::fs::read_to_string(source)
        .map_err(|e| format!("Failed to read source context file: {e}"))?;

    // Extract name from content (first line if it starts with # )
    let name = content
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("# "))
        .map(|s| s.to_string());

    // Destination file: {session_id}-context-{slug}.md
    let dest_file = saved_contexts_dir.join(format!("{session_id}-context-{slug}.md"));

    // If already attached for this session, return existing info without re-copying
    if dest_file.exists() {
        let metadata = std::fs::metadata(&dest_file)
            .map_err(|e| format!("Failed to get file metadata: {e}"))?;
        let size = metadata.len();
        let created_at = metadata
            .created()
            .or_else(|_| metadata.modified())
            .map_err(|e| format!("Failed to get file time: {e}"))?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Failed to convert time: {e}"))?
            .as_secs();
        log::trace!("Context '{slug}' already attached for session {session_id}, skipping copy");
        return Ok(AttachedSavedContext {
            slug,
            name,
            size,
            created_at,
        });
    }

    // Write content to destination
    std::fs::write(&dest_file, &content)
        .map_err(|e| format!("Failed to write attached context file: {e}"))?;

    // Get file metadata for size and created_at
    let metadata =
        std::fs::metadata(&dest_file).map_err(|e| format!("Failed to get file metadata: {e}"))?;

    let size = metadata.len();
    let created_at = metadata
        .created()
        .or_else(|_| metadata.modified())
        .map_err(|e| format!("Failed to get file time: {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to convert time: {e}"))?
        .as_secs();

    log::trace!("Attached saved context '{slug}' for session {session_id}");

    Ok(AttachedSavedContext {
        slug,
        name,
        size,
        created_at,
    })
}

/// Remove an attached saved context from a session.
pub async fn remove_saved_context(
    app: tauri::AppHandle,
    session_id: String,
    slug: String,
) -> Result<(), String> {
    log::trace!("Removing saved context '{slug}' from session {session_id}");

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let context_file = app_data_dir
        .join("session-context")
        .join(format!("{session_id}-context-{slug}.md"));

    if context_file.exists() {
        std::fs::remove_file(&context_file)
            .map_err(|e| format!("Failed to remove saved context file: {e}"))?;
        log::trace!("Removed saved context '{slug}' from session {session_id}");
    }

    Ok(())
}

/// List all attached saved contexts for a session.
pub async fn list_attached_saved_contexts(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<AttachedSavedContext>, String> {
    log::trace!("Listing attached saved contexts for session {session_id}");

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let saved_contexts_dir = app_data_dir.join("session-context");

    if !saved_contexts_dir.exists() {
        return Ok(vec![]);
    }

    let mut contexts = Vec::new();
    let prefix = format!("{session_id}-context-");

    if let Ok(entries) = std::fs::read_dir(&saved_contexts_dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();

            // Match files like "{session_id}-context-{slug}.md"
            if file_name.starts_with(&prefix) && file_name.ends_with(".md") {
                // Extract slug from filename
                let slug = file_name[prefix.len()..file_name.len() - 3].to_string();

                // Read file to extract name from first line
                let name = if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    content
                        .lines()
                        .next()
                        .and_then(|line| line.strip_prefix("# "))
                        .map(|s| s.to_string())
                } else {
                    None
                };

                // Get file metadata
                if let Ok(metadata) = std::fs::metadata(entry.path()) {
                    let size = metadata.len();
                    let created_at = metadata
                        .created()
                        .or_else(|_| metadata.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    contexts.push(AttachedSavedContext {
                        slug,
                        name,
                        size,
                        created_at,
                    });
                }
            }
        }
    }

    // Sort by created_at (newest first)
    contexts.sort_by_key(|context| std::cmp::Reverse(context.created_at));

    log::trace!("Found {} attached saved contexts", contexts.len());
    Ok(contexts)
}

/// Get the content of an attached saved context file.
pub async fn get_saved_context_content(
    app: tauri::AppHandle,
    session_id: String,
    slug: String,
) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let context_file = app_data_dir
        .join("session-context")
        .join(format!("{session_id}-context-{slug}.md"));

    if !context_file.exists() {
        return Err(format!("Saved context file not found for slug '{slug}'"));
    }

    std::fs::read_to_string(&context_file)
        .map_err(|e| format!("Failed to read saved context file: {e}"))
}

/// Delete all saved context files for a session.
///
/// Called during session deletion to clean up context files.
pub fn cleanup_saved_contexts_for_session(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let saved_contexts_dir = app_data_dir.join("session-context");
    if !saved_contexts_dir.exists() {
        return Ok(());
    }

    let prefix = format!("{session_id}-context-");
    if let Ok(entries) = std::fs::read_dir(&saved_contexts_dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.starts_with(&prefix) && file_name.ends_with(".md") {
                if let Err(e) = std::fs::remove_file(entry.path()) {
                    log::warn!("Failed to remove saved context file {file_name}: {e}");
                }
            }
        }
    }
    Ok(())
}

/// Inject a lightweight session reference into another session's context.
///
/// Writes a small markdown context file with an MCP pointer prompt (no message
/// dump) to `session-context/{target_session_id}-context-session-ref-{source}.md`.
pub async fn attach_session_reference(
    app: tauri::AppHandle,
    target_session_id: String,
    source_session_id: String,
    session_name: String,
    project_name: String,
    worktree_name: String,
) -> Result<AttachedSavedContext, String> {
    if target_session_id == source_session_id {
        return Err("Cannot inject a session into itself".to_string());
    }
    if source_session_id.trim().is_empty() {
        return Err("Source session id is required".to_string());
    }

    let slug = session_reference_slug(&source_session_id);
    let content = build_session_reference_content(
        &source_session_id,
        &session_name,
        &project_name,
        &worktree_name,
    );
    let name = Some(format!("Session: {session_name}"));

    log::trace!("Attaching session reference '{source_session_id}' to session {target_session_id}");

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let saved_contexts_dir = app_data_dir.join("session-context");
    std::fs::create_dir_all(&saved_contexts_dir)
        .map_err(|e| format!("Failed to create session-context directory: {e}"))?;

    let dest_file = saved_contexts_dir.join(format!("{target_session_id}-context-{slug}.md"));

    // Already attached — return existing metadata without rewriting.
    if dest_file.exists() {
        let metadata = std::fs::metadata(&dest_file)
            .map_err(|e| format!("Failed to get file metadata: {e}"))?;
        let size = metadata.len();
        let created_at = metadata
            .created()
            .or_else(|_| metadata.modified())
            .map_err(|e| format!("Failed to get file time: {e}"))?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Failed to convert time: {e}"))?
            .as_secs();
        log::trace!(
            "Session reference '{source_session_id}' already attached to {target_session_id}"
        );
        return Ok(AttachedSavedContext {
            slug,
            name,
            size,
            created_at,
        });
    }

    std::fs::write(&dest_file, &content)
        .map_err(|e| format!("Failed to write session reference file: {e}"))?;

    let metadata =
        std::fs::metadata(&dest_file).map_err(|e| format!("Failed to get file metadata: {e}"))?;
    let size = metadata.len();
    let created_at = metadata
        .created()
        .or_else(|_| metadata.modified())
        .map_err(|e| format!("Failed to get file time: {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to convert time: {e}"))?
        .as_secs();

    log::trace!("Attached session reference '{source_session_id}' to session {target_session_id}");

    Ok(AttachedSavedContext {
        slug,
        name,
        size,
        created_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_reference_slug_is_stable() {
        assert_eq!(session_reference_slug("abc-123"), "session-ref-abc-123");
    }

    #[test]
    fn session_reference_content_points_at_mcp_not_full_history() {
        let content =
            build_session_reference_content("sess-42", "Fix login bug", "jean", "issue-596");

        assert!(content.contains("# Session: Fix login bug"));
        assert!(content.contains("`sess-42`"));
        assert!(content.contains("read_session_messages"));
        assert!(content.contains("sessionId"));
        assert!(content.contains("get_session_status"));
        assert!(content.contains("Do **not** consume the entire session at once"));
        // Must not embed fabricated conversation content
        assert!(!content.contains("User:"));
        assert!(!content.contains("Assistant:"));
        assert!(content.contains("project: jean"));
        assert!(content.contains("worktree: issue-596"));
    }
}
