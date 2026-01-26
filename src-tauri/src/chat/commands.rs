use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::naming::{spawn_naming_task, NamingRequest};
use super::registry::cancel_process;
use super::run_log;
use super::storage::{
    delete_session_data, get_data_dir, get_index_path, get_session_dir, load_metadata,
    load_sessions, with_sessions_mut,
};
use super::types::{
    AllSessionsEntry, AllSessionsResponse, ChatMessage, ClaudeContext, MessageRole, RunStatus,
    Session, ThinkingLevel, WorktreeSessions,
};
use crate::claude_cli::get_cli_binary_path;
use crate::projects::storage::load_projects_data;
use crate::projects::types::SessionType;

/// Get current Unix timestamp in seconds
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ============================================================================
// Session Management Commands
// ============================================================================

/// Get all sessions for a worktree (for tab bar display)
/// By default, archived sessions are filtered out
#[tauri::command]
pub async fn get_sessions(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    include_archived: Option<bool>,
    include_message_counts: Option<bool>,
) -> Result<WorktreeSessions, String> {
    log::trace!("Getting sessions for worktree: {worktree_id}");
    let mut sessions = load_sessions(&app, &worktree_path, &worktree_id)?;

    // Filter out archived sessions unless explicitly requested
    if !include_archived.unwrap_or(false) {
        sessions.sessions.retain(|s| s.archived_at.is_none());
    }

    // Optionally populate message counts from metadata (efficient alternative to loading full messages)
    if include_message_counts.unwrap_or(false) {
        for session in &mut sessions.sessions {
            if let Ok(Some(metadata)) = load_metadata(&app, &session.id) {
                // Count messages: each run has 1 user message, plus 1 assistant message if not undo_send
                let count: u32 = metadata
                    .runs
                    .iter()
                    .map(|run| {
                        let is_undo_send = run.status == RunStatus::Cancelled
                            && run.assistant_message_id.is_none();
                        if is_undo_send {
                            0
                        } else if run.assistant_message_id.is_some() {
                            2 // user + assistant
                        } else {
                            1 // just user (still running or cancelled without response)
                        }
                    })
                    .sum();
                session.message_count = Some(count);
            }
        }
    }

    Ok(sessions)
}

/// List all sessions across all worktrees and projects
///
/// Returns sessions grouped by project/worktree for the Load Context modal.
/// This allows users to generate context from any session in any project.
#[tauri::command]
pub async fn list_all_sessions(app: AppHandle) -> Result<AllSessionsResponse, String> {
    log::trace!("Listing all sessions across all worktrees");

    // Load all projects
    let projects_data = load_projects_data(&app)?;

    let mut entries = Vec::new();

    // For each project, get all worktrees
    for project in &projects_data.projects {
        let worktrees = projects_data.worktrees_for_project(&project.id);

        // For each worktree, load sessions
        for worktree in worktrees {
            match load_sessions(&app, &worktree.path, &worktree.id) {
                Ok(sessions_data) => {
                    entries.push(AllSessionsEntry {
                        project_id: project.id.clone(),
                        project_name: project.name.clone(),
                        worktree_id: worktree.id.clone(),
                        worktree_name: worktree.name.clone(),
                        worktree_path: worktree.path.clone(),
                        sessions: sessions_data.sessions,
                    });
                }
                Err(e) => {
                    // Log but don't fail - some worktrees might not have sessions yet
                    log::warn!(
                        "Failed to load sessions for worktree {}: {}",
                        worktree.id,
                        e
                    );
                }
            }
        }
    }

    log::trace!("Found {} worktree entries with sessions", entries.len());
    Ok(AllSessionsResponse { entries })
}

/// Get a single session with full message history
#[tauri::command]
pub async fn get_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<Session, String> {
    log::trace!("Getting session: {session_id}");
    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    let mut session = sessions
        .find_session(&session_id)
        .cloned()
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    // Load messages from NDJSON (single source of truth)
    let mut messages = run_log::load_session_messages(&app, &session_id)?;

    // Apply approved plan status from session metadata
    for msg in &mut messages {
        if session.approved_plan_message_ids.contains(&msg.id) {
            msg.plan_approved = true;
        }
    }

    session.messages = messages;
    Ok(session)
}

/// Create a new session tab
#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    name: Option<String>,
) -> Result<Session, String> {
    log::trace!("Creating new session for worktree: {worktree_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        // Generate name if not provided
        let session_number = sessions.next_session_number();
        let session_name = name.unwrap_or_else(|| format!("Session {session_number}"));

        let session = Session::new(session_name, sessions.sessions.len() as u32);
        let session_id = session.id.clone();

        sessions.sessions.push(session.clone());
        sessions.active_session_id = Some(session_id);

        log::trace!("Created session: {}", session.id);
        Ok(session)
    })
}

/// Rename a session tab
#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    new_name: String,
) -> Result<(), String> {
    log::trace!("Renaming session {session_id} to: {new_name}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.name = new_name;
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Update session-specific UI state (answered questions, fixed findings, etc.)
/// All fields are optional - only provided fields are updated
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_session_state(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    answered_questions: Option<Vec<String>>,
    submitted_answers: Option<std::collections::HashMap<String, serde_json::Value>>,
    fixed_findings: Option<Vec<String>>,
    pending_permission_denials: Option<Vec<super::types::PermissionDenial>>,
    denied_message_context: Option<Option<super::types::DeniedMessageContext>>,
    is_reviewing: Option<bool>,
    waiting_for_input: Option<bool>,
) -> Result<(), String> {
    log::trace!("Updating session state for: {session_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            if let Some(v) = answered_questions {
                session.answered_questions = v;
            }
            if let Some(v) = submitted_answers {
                session.submitted_answers = v;
            }
            if let Some(v) = fixed_findings {
                session.fixed_findings = v;
            }
            if let Some(v) = pending_permission_denials {
                session.pending_permission_denials = v;
            }
            if let Some(v) = denied_message_context {
                session.denied_message_context = v;
            }
            if let Some(v) = is_reviewing {
                session.is_reviewing = v;
            }
            if let Some(v) = waiting_for_input {
                session.waiting_for_input = v;
            }
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Extract pasted image paths from message content
/// Matches: [Image attached: /path/to/image.png - Use the Read tool to view this image]
fn extract_image_paths(content: &str) -> Vec<String> {
    use regex::Regex;
    // Lazy static would be better, but for simplicity we'll compile here
    let re = Regex::new(r"\[Image attached: (.+?) - Use the Read tool to view this image\]")
        .expect("Invalid regex");
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// Extract pasted text file paths from message content
/// Matches: [Text file attached: /path/to/file.txt - Use the Read tool to view this file]
fn extract_text_file_paths(content: &str) -> Vec<String> {
    use regex::Regex;
    let re = Regex::new(r"\[Text file attached: (.+?) - Use the Read tool to view this file\]")
        .expect("Invalid regex");
    re.captures_iter(content)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// Delete a pasted file (image or text) by path - internal helper
/// Does not validate path (validation done at command level)
fn delete_pasted_file(path: &str) {
    let file_path = std::path::PathBuf::from(path);
    if file_path.exists() {
        if let Err(e) = std::fs::remove_file(&file_path) {
            log::warn!("Failed to delete pasted file {path}: {e}");
        } else {
            log::trace!("Deleted pasted file: {path}");
        }
    }
}

/// Close/delete a session tab
/// Returns the new active session ID (if any)
/// Also cleans up any pasted images and text files associated with the session
#[tauri::command]
pub async fn close_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<Option<String>, String> {
    log::trace!("Closing session: {session_id}");

    // Cancel any running process first (outside lock - doesn't touch sessions file)
    let _ = cancel_process(&app, &session_id, &worktree_id);

    // Collect pasted file paths for cleanup (outside lock - read-only NDJSON access)
    let mut files_to_delete: Vec<String> = Vec::new();
    let messages = run_log::load_session_messages(&app, &session_id).unwrap_or_default();
    for message in &messages {
        files_to_delete.extend(extract_image_paths(&message.content));
        files_to_delete.extend(extract_text_file_paths(&message.content));
    }

    // Delete pasted files (outside lock - doesn't touch sessions file)
    if !files_to_delete.is_empty() {
        log::trace!(
            "Cleaning up {} pasted files for session {session_id}",
            files_to_delete.len()
        );
        for path in files_to_delete {
            delete_pasted_file(&path);
        }
    }

    // Delete session data (outside lock - separate directory)
    if let Err(e) = delete_session_data(&app, &session_id) {
        log::warn!("Failed to delete session data: {e}");
    }

    // Now atomically modify the sessions file
    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        // Find the index of the session being closed before removing it
        let closed_index = sessions.sessions.iter().position(|s| s.id == session_id);

        // Remove the session
        sessions.sessions.retain(|s| s.id != session_id);

        // Determine new active session
        let new_active = if sessions.active_session_id.as_deref() == Some(&session_id) {
            // The closed session was active, pick the previous one (or next if first)
            if let Some(idx) = closed_index {
                if idx > 0 {
                    sessions.sessions.get(idx - 1).map(|s| s.id.clone())
                } else {
                    sessions.sessions.first().map(|s| s.id.clone())
                }
            } else {
                sessions.sessions.first().map(|s| s.id.clone())
            }
        } else {
            sessions.active_session_id.clone()
        };
        sessions.active_session_id = new_active;

        // Ensure at least one session exists
        if sessions.sessions.is_empty() {
            let default_session = Session::default_session();
            sessions.active_session_id = Some(default_session.id.clone());
            sessions.sessions.push(default_session);
        }

        log::trace!(
            "Session closed, new active: {:?}",
            sessions.active_session_id
        );
        Ok(sessions.active_session_id.clone())
    })
}

/// Archive a session tab (hide from UI but keep messages)
/// Sessions with 0 messages are deleted instead of archived.
/// Returns the new active session ID (if any)
#[tauri::command]
pub async fn archive_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<Option<String>, String> {
    log::trace!("Archiving session: {session_id}");

    // Cancel any running process first (outside lock)
    let _ = cancel_process(&app, &session_id, &worktree_id);

    // Load messages from NDJSON to check if session has content (outside lock - read-only)
    let messages = run_log::load_session_messages(&app, &session_id).unwrap_or_default();
    let should_delete = messages.is_empty();

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        // Find the index before archiving/deleting
        let session_index = sessions.sessions.iter().position(|s| s.id == session_id);

        // Find the session
        let session = sessions
            .find_session(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        // Check if already archived
        if session.archived_at.is_some() {
            return Err("Session is already archived".to_string());
        }

        if should_delete {
            log::trace!("Session has 0 messages, deleting instead of archiving: {session_id}");
            if let Some(idx) = session_index {
                sessions.sessions.remove(idx);
            }
        } else {
            // Set archived timestamp
            let session = sessions
                .find_session_mut(&session_id)
                .ok_or_else(|| format!("Session not found: {session_id}"))?;
            session.archived_at = Some(now());
        }

        // Determine new active session if the archived/deleted one was active
        let new_active = if sessions.active_session_id.as_deref() == Some(&session_id) {
            if let Some(idx) = session_index {
                let mut candidate = None;
                let search_idx = if should_delete {
                    idx.saturating_sub(1)
                } else {
                    idx
                };
                for i in (0..=search_idx).rev() {
                    if sessions
                        .sessions
                        .get(i)
                        .is_some_and(|s| s.archived_at.is_none())
                    {
                        candidate = sessions.sessions.get(i).map(|s| s.id.clone());
                        break;
                    }
                }
                if candidate.is_none() {
                    let start_idx = if should_delete { idx } else { idx + 1 };
                    for i in start_idx..sessions.sessions.len() {
                        if sessions
                            .sessions
                            .get(i)
                            .is_some_and(|s| s.archived_at.is_none())
                        {
                            candidate = sessions.sessions.get(i).map(|s| s.id.clone());
                            break;
                        }
                    }
                }
                candidate
            } else {
                sessions
                    .sessions
                    .iter()
                    .find(|s| s.archived_at.is_none())
                    .map(|s| s.id.clone())
            }
        } else {
            sessions.active_session_id.clone()
        };
        sessions.active_session_id = new_active;

        // Ensure at least one session exists if all are archived or deleted
        let non_archived_count = sessions
            .sessions
            .iter()
            .filter(|s| s.archived_at.is_none())
            .count();
        if non_archived_count == 0 {
            let default_session = Session::default_session();
            sessions.active_session_id = Some(default_session.id.clone());
            sessions.sessions.push(default_session);
        }

        if should_delete {
            log::trace!(
                "Session deleted (0 messages), new active: {:?}",
                sessions.active_session_id
            );
        } else {
            log::trace!(
                "Session archived, new active: {:?}",
                sessions.active_session_id
            );
        }
        Ok(sessions.active_session_id.clone())
    })
}

/// Unarchive a session (restore it to the session list)
#[tauri::command]
pub async fn unarchive_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<Session, String> {
    log::trace!("Unarchiving session: {session_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        let session = sessions
            .find_session_mut(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        if session.archived_at.is_none() {
            return Err("Session is not archived".to_string());
        }

        session.archived_at = None;
        let restored_session = session.clone();

        log::trace!("Session unarchived: {session_id}");
        Ok(restored_session)
    })
}

/// Response from restoring a session with base session recreation
#[derive(Debug, Clone, serde::Serialize)]
pub struct RestoreSessionWithBaseResponse {
    /// The restored session
    pub session: Session,
    /// The worktree (either existing or newly created base session)
    pub worktree: crate::projects::types::Worktree,
}

/// Restore an archived session, recreating the base session if needed
///
/// This command handles the case where:
/// 1. The session belongs to a base session that was closed (worktree record removed)
/// 2. We need to recreate the base session and migrate the sessions to it
#[tauri::command]
pub async fn restore_session_with_base(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    project_id: String,
) -> Result<RestoreSessionWithBaseResponse, String> {
    log::trace!("Restoring session with base session check: {session_id}");

    // Load projects data to check if worktree exists
    let mut projects_data = load_projects_data(&app)?;

    // Check if the worktree exists
    if let Some(existing) = projects_data.find_worktree(&worktree_id) {
        // Worktree exists - just unarchive the session
        log::trace!("Worktree exists, unarchiving session normally");
        let existing_worktree = existing.clone();

        let restored_session = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            let session = sessions
                .find_session_mut(&session_id)
                .ok_or_else(|| format!("Session not found: {session_id}"))?;

            if session.archived_at.is_none() {
                return Err("Session is not archived".to_string());
            }

            session.archived_at = None;
            Ok(session.clone())
        })?;

        return Ok(RestoreSessionWithBaseResponse {
            session: restored_session,
            worktree: existing_worktree,
        });
    }

    // Worktree doesn't exist - check if this is a base session path
    let project = projects_data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();

    if worktree_path != project.path {
        return Err(
            "Worktree not found and path doesn't match project (not a base session)".to_string(),
        );
    }

    log::trace!("Recreating base session for project: {}", project.name);

    // Create new base session
    let new_worktree = crate::projects::types::Worktree {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: project_id.clone(),
        name: project.default_branch.clone(),
        path: project.path.clone(),
        branch: project.default_branch.clone(),
        created_at: now(),
        setup_output: None,
        setup_script: None,
        session_type: SessionType::Base,
        pr_number: None,
        pr_url: None,
        cached_pr_status: None,
        cached_check_status: None,
        cached_behind_count: None,
        cached_ahead_count: None,
        cached_status_at: None,
        cached_uncommitted_added: None,
        cached_uncommitted_removed: None,
        cached_branch_diff_added: None,
        cached_branch_diff_removed: None,
        cached_base_branch_ahead_count: None,
        cached_base_branch_behind_count: None,
        cached_worktree_ahead_count: None,
        order: 0,
        archived_at: None,
    };

    projects_data.add_worktree(new_worktree.clone());
    crate::projects::storage::save_projects_data(&app, &projects_data)?;

    // Atomically migrate sessions to new worktree
    let restored_session = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        let session = sessions
            .find_session_mut(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        if session.archived_at.is_none() {
            return Err("Session is not archived".to_string());
        }

        session.archived_at = None;
        let restored = session.clone();

        // Update the sessions file's worktree_id to the new one
        sessions.worktree_id = new_worktree.id.clone();

        Ok(restored)
    })?;

    // Delete the old sessions file (outside lock - it's already been saved with new worktree_id)
    let old_sessions_path = get_index_path(&app, &worktree_id)?;
    if old_sessions_path.exists() {
        if let Err(e) = std::fs::remove_file(&old_sessions_path) {
            log::warn!("Failed to remove old sessions file: {e}");
        }
    }

    log::trace!("Base session recreated and sessions migrated");

    Ok(RestoreSessionWithBaseResponse {
        session: restored_session,
        worktree: new_worktree,
    })
}

/// Permanently delete an archived session
#[tauri::command]
pub async fn delete_archived_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<(), String> {
    log::trace!("Permanently deleting archived session: {session_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        let session_idx = sessions
            .sessions
            .iter()
            .position(|s| s.id == session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        if sessions.sessions[session_idx].archived_at.is_none() {
            return Err("Cannot delete non-archived session. Archive it first.".to_string());
        }

        sessions.sessions.remove(session_idx);
        log::trace!("Archived session permanently deleted: {session_id}");
        Ok(())
    })
}

/// List archived sessions for a worktree
#[tauri::command]
pub async fn list_archived_sessions(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
) -> Result<Vec<Session>, String> {
    log::trace!("Listing archived sessions for worktree: {worktree_id}");

    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;

    let archived: Vec<Session> = sessions
        .sessions
        .into_iter()
        .filter(|s| s.archived_at.is_some())
        .collect();

    log::trace!("Found {} archived sessions", archived.len());
    Ok(archived)
}

/// An archived session with its worktree context
#[derive(Debug, Clone, serde::Serialize)]
pub struct ArchivedSessionEntry {
    pub session: Session,
    pub worktree_id: String,
    pub worktree_name: String,
    pub worktree_path: String,
    pub project_id: String,
    pub project_name: String,
}

/// List all archived sessions across all worktrees (including archived worktrees)
#[tauri::command]
pub async fn list_all_archived_sessions(
    app: AppHandle,
) -> Result<Vec<ArchivedSessionEntry>, String> {
    log::trace!("Listing all archived sessions across all worktrees");

    let projects_data = load_projects_data(&app)?;
    let mut entries = Vec::new();

    for project in &projects_data.projects {
        // Get ALL worktrees (including archived) to find their archived sessions
        let worktrees: Vec<_> = projects_data
            .worktrees_for_project(&project.id)
            .into_iter()
            .collect();

        for worktree in worktrees {
            match load_sessions(&app, &worktree.path, &worktree.id) {
                Ok(sessions_data) => {
                    // Filter to archived sessions only
                    for session in sessions_data.sessions {
                        if session.archived_at.is_some() {
                            entries.push(ArchivedSessionEntry {
                                session,
                                worktree_id: worktree.id.clone(),
                                worktree_name: worktree.name.clone(),
                                worktree_path: worktree.path.clone(),
                                project_id: project.id.clone(),
                                project_name: project.name.clone(),
                            });
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "Failed to load sessions for worktree {}: {}",
                        worktree.id,
                        e
                    );
                }
            }
        }
    }

    log::trace!("Found {} archived sessions total", entries.len());
    Ok(entries)
}

/// Reorder session tabs
#[tauri::command]
pub async fn reorder_sessions(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_ids: Vec<String>,
) -> Result<(), String> {
    log::trace!("Reordering sessions");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        for (index, session_id) in session_ids.iter().enumerate() {
            if let Some(session) = sessions.find_session_mut(session_id) {
                session.order = index as u32;
            }
        }
        sessions.sessions.sort_by_key(|s| s.order);
        log::trace!("Sessions reordered");
        Ok(())
    })
}

/// Set the active session tab
#[tauri::command]
pub async fn set_active_session(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<(), String> {
    log::trace!("Setting active session: {session_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        sessions.active_session_id = Some(session_id);
        Ok(())
    })
}

// ============================================================================
// Chat Commands (now session-based)
// ============================================================================

/// Send a message to Claude and get a response
///
/// This command:
/// 1. Loads existing session (includes Claude session ID if present)
/// 2. Adds the user message
/// 3. Executes Claude CLI (resumes Claude session if we have one)
/// 4. Stores the Claude session ID for future messages
/// 5. Adds the assistant response
/// 6. Saves the updated session
/// 7. Returns the assistant message
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_chat_message(
    app: tauri::AppHandle,
    session_id: String,
    worktree_id: String,
    worktree_path: String,
    message: String,
    model: Option<String>,
    execution_mode: Option<String>,
    thinking_level: Option<ThinkingLevel>,
    disable_thinking_for_mode: Option<bool>,
    parallel_execution_prompt_enabled: Option<bool>,
    ai_language: Option<String>,
    allowed_tools: Option<Vec<String>>,
) -> Result<ChatMessage, String> {
    log::trace!("Sending chat message for session: {session_id}, worktree: {worktree_id}, model: {model:?}, execution_mode: {execution_mode:?}, thinking: {thinking_level:?}, disable_thinking_for_mode: {disable_thinking_for_mode:?}, allowed_tools: {allowed_tools:?}");

    // Validate inputs
    if message.trim().is_empty() {
        return Err("Message cannot be empty".to_string());
    }

    if worktree_path.is_empty() {
        return Err("Worktree path cannot be empty".to_string());
    }

    // Load sessions
    let mut sessions = load_sessions(&app, &worktree_path, &worktree_id)?;

    log::trace!(
        "Loaded {} sessions, looking for session_id: {session_id}",
        sessions.sessions.len()
    );
    log::trace!(
        "Available session IDs: {:?}",
        sessions.sessions.iter().map(|s| &s.id).collect::<Vec<_>>()
    );

    // Check if we should trigger automatic naming (session and/or branch)
    // Branch naming: first user message ever AND not already attempted
    // Session naming: first user message in THIS session AND not already attempted
    let is_first_worktree_message = !sessions.branch_naming_completed
        && sessions
            .sessions
            .iter()
            .flat_map(|s| &s.messages)
            .filter(|m| m.role == MessageRole::User)
            .count()
            == 0;

    let session_for_naming = sessions.find_session(&session_id).cloned();
    let is_first_session_message = session_for_naming
        .as_ref()
        .map(|sess| {
            !sess.session_naming_completed
                && sess
                    .messages
                    .iter()
                    .filter(|m| m.role == MessageRole::User)
                    .count()
                    == 0
        })
        .unwrap_or(false);

    // Spawn unified naming task if either condition is met
    if is_first_worktree_message || is_first_session_message {
        if let Ok(prefs) = crate::load_preferences(app.clone()).await {
            // Check if this is a base session - don't rename the default branch
            let is_base_session = load_projects_data(&app)
                .ok()
                .and_then(|data| data.find_worktree(&worktree_id).cloned())
                .map(|w| w.session_type == SessionType::Base)
                .unwrap_or(false);

            let generate_branch =
                is_first_worktree_message && prefs.auto_branch_naming && !is_base_session;
            let generate_session = is_first_session_message && prefs.auto_session_naming;

            if generate_branch || generate_session {
                log::trace!(
                    "Spawning naming task (session: {generate_session}, branch: {generate_branch})"
                );

                // Get existing worktree names to avoid duplicates (only needed for branch naming)
                let existing_names = if generate_branch {
                    load_projects_data(&app)
                        .map(|data| data.worktrees.iter().map(|w| w.name.clone()).collect())
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };

                let request = NamingRequest {
                    session_id: session_id.clone(),
                    worktree_id: worktree_id.clone(),
                    worktree_path: PathBuf::from(&worktree_path),
                    first_message: message.clone(),
                    model: prefs.session_naming_model.clone(), // Use session naming model
                    existing_branch_names: existing_names,
                    generate_session_name: generate_session,
                    generate_branch_name: generate_branch,
                };

                // Spawn in background - does not block chat
                spawn_naming_task(app.clone(), request);
            }
        }

        // Mark as completed to prevent re-triggering (atomic update)
        with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            if is_first_worktree_message {
                sessions.branch_naming_completed = true;
            }
            if is_first_session_message {
                if let Some(session) = sessions.find_session_mut(&session_id) {
                    session.session_naming_completed = true;
                }
            }
            Ok(())
        })?;

        // Reload sessions to get fresh state after save
        sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    }

    // Find the session
    let session = match sessions.find_session_mut(&session_id) {
        Some(s) => s,
        None => {
            let error_msg = format!(
                "Session not found: {session_id}. Available sessions: {:?}",
                sessions.sessions.iter().map(|s| &s.id).collect::<Vec<_>>()
            );
            log::error!("{}", error_msg);

            // Emit error event so frontend knows what happened
            use tauri::Emitter;
            let error_event = super::claude::ErrorEvent {
                session_id: session_id.clone(),
                worktree_id: worktree_id.clone(),
                error: "Session not found. Please refresh the page or create a new session."
                    .to_string(),
            };
            if let Err(e) = app.emit("chat:error", &error_event) {
                log::error!("Failed to emit chat:error event: {e}");
            }

            return Err(error_msg);
        }
    };

    // Generate user message ID early (needed for run log)
    let user_message_id = Uuid::new_v4().to_string();

    // Capture session info for run log before borrowing session mutably
    let session_name = session.name.clone();
    let session_order = session.order;

    // Note: User message is stored in NDJSON run entry (run.user_message),
    // not in sessions JSON. Messages are loaded from NDJSON on demand.

    // Build context for Claude
    let context = ClaudeContext::new(worktree_path.clone());

    // Get the Claude session ID for resumption
    let claude_session_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.claude_session_id.clone());

    // Start NDJSON run log for crash recovery
    let mut run_log_writer = run_log::start_run(
        &app,
        &session_id,
        &worktree_id,
        &session_name,
        session_order,
        &user_message_id,
        &message,
        model.as_deref(),
        execution_mode.as_deref(),
        thinking_level
            .as_ref()
            .map(|t| format!("{t:?}").to_lowercase())
            .as_deref(),
    )?;

    // Get file paths for detached execution
    let input_file = run_log_writer.input_file_path()?;
    let output_file = run_log_writer.output_file_path()?;
    let run_id = run_log_writer.run_id().to_string();

    // Write input file with the user message
    run_log::write_input_file(&app, &session_id, &run_id, &message)?;

    // Use passed parameter for thinking override (computed by frontend based on preference + manual override)
    let disable_thinking_in_non_plan_modes = disable_thinking_for_mode.unwrap_or(false);

    // Use passed parameter for parallel execution prompt (default false - experimental)
    let parallel_execution_prompt = parallel_execution_prompt_enabled.unwrap_or(false);

    // Execute Claude CLI in detached mode
    // If resume fails with "session not found", retry without the session ID
    let mut claude_session_id_for_call = claude_session_id.clone();
    let (pid, claude_response) = loop {
        log::trace!("About to call execute_claude_detached...");

        match super::claude::execute_claude_detached(
            &app,
            &session_id,
            &worktree_id,
            &input_file,
            &output_file,
            context.worktree_path.as_ref(),
            claude_session_id_for_call.as_deref(),
            model.as_deref(),
            execution_mode.as_deref(),
            thinking_level.as_ref(),
            allowed_tools.as_deref(),
            disable_thinking_in_non_plan_modes,
            parallel_execution_prompt,
            ai_language.as_deref(),
        ) {
            Ok((pid, response)) => {
                log::trace!("execute_claude_detached succeeded (PID: {pid})");
                break (pid, response);
            }
            Err(e) => {
                // Check if this is a session not found error and we were trying to resume
                let is_session_not_found = e.to_lowercase().contains("session")
                    && (e.to_lowercase().contains("not found")
                        || e.to_lowercase().contains("invalid")
                        || e.to_lowercase().contains("expired"));

                if is_session_not_found && claude_session_id_for_call.is_some() {
                    log::warn!(
                        "Session not found, clearing stored session ID and retrying: {}",
                        claude_session_id_for_call.as_deref().unwrap_or("")
                    );

                    // Clear the invalid session ID from storage (atomic update)
                    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
                        if let Some(session) = sessions.find_session_mut(&session_id) {
                            session.claude_session_id = None;
                        }
                        Ok(())
                    })?;

                    // Retry without session ID
                    claude_session_id_for_call = None;
                    continue;
                }

                log::error!("execute_claude_detached FAILED: {e}");
                return Err(e);
            }
        }
    };

    // Store the PID in the run log for recovery
    run_log_writer.set_pid(pid)?;

    // Clean up input file (no longer needed)
    if let Err(e) = run_log::delete_input_file(&app, &session_id, &run_id) {
        log::warn!("Failed to delete input file: {e}");
    }

    // Handle cancellation: only save if there's meaningful content (>10 chars) or tool calls
    // This avoids cluttering history with empty cancelled messages from instant cancellations
    let has_meaningful_content = claude_response.content.len() >= 10;
    let has_tool_calls = !claude_response.tool_calls.is_empty();
    let claude_session_id_for_log = claude_response.session_id.clone();

    if claude_response.cancelled && !has_meaningful_content && !has_tool_calls {
        // Instant cancellation with no content
        // Cancel the run log (no assistant message to save)
        if let Err(e) = run_log_writer.cancel(None) {
            log::warn!("Failed to cancel run log: {e}");
        }

        // Atomically update session (store claude_session_id, remove last user message if present)
        with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            if let Some(session) = sessions.find_session_mut(&session_id) {
                if !claude_session_id_for_log.is_empty() {
                    session.claude_session_id = Some(claude_session_id_for_log.clone());
                }
                // Remove user message (undo send) - allows frontend to restore to input field
                if session
                    .messages
                    .last()
                    .is_some_and(|m| m.role == MessageRole::User)
                {
                    session.messages.pop();
                    log::trace!("Removed user message for undo send in session: {session_id}");
                }
            }
            Ok(())
        })?;

        log::trace!("Chat cancelled with no meaningful content for session: {session_id}");
        // Return a minimal cancelled message (not persisted, just for UI)
        return Ok(ChatMessage {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            role: MessageRole::Assistant,
            content: String::new(),
            timestamp: now(),
            tool_calls: vec![],
            content_blocks: vec![],
            cancelled: true,
            plan_approved: false,
            model: None,
            execution_mode: None,
            thinking_level: None,
            recovered: false,
            usage: None,
        });
    }

    // Create assistant message with tool calls and content blocks
    let assistant_msg_id = Uuid::new_v4().to_string();
    let assistant_msg = ChatMessage {
        id: assistant_msg_id.clone(),
        session_id: session_id.clone(),
        role: MessageRole::Assistant,
        content: claude_response.content,
        timestamp: now(),
        tool_calls: claude_response.tool_calls,
        content_blocks: claude_response.content_blocks,
        cancelled: claude_response.cancelled,
        plan_approved: false,
        model: None,
        execution_mode: None,
        thinking_level: None,
        recovered: false,
        usage: claude_response.usage.clone(),
    };
    // Note: Assistant message is stored in NDJSON, not sessions JSON.
    // Messages are loaded from NDJSON on demand via load_session_messages().

    // Finalize run log (complete or cancel based on response status)
    if claude_response.cancelled {
        if let Err(e) = run_log_writer.cancel(Some(&assistant_msg_id)) {
            log::warn!("Failed to cancel run log: {e}");
        }
    } else {
        let claude_sid = if claude_session_id_for_log.is_empty() {
            None
        } else {
            Some(claude_session_id_for_log.as_str())
        };
        if let Err(e) =
            run_log_writer.complete(&assistant_msg_id, claude_sid, claude_response.usage)
        {
            log::warn!("Failed to complete run log: {e}");
        }
    }

    // Atomically save session metadata (claude_session_id for resumption)
    // Note: Messages are NOT saved here - they're in NDJSON only
    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            if !claude_session_id_for_log.is_empty() {
                session.claude_session_id = Some(claude_session_id_for_log.clone());
            }
        }
        Ok(())
    })?;

    if claude_response.cancelled {
        log::trace!("Chat message cancelled but partial response saved for session: {session_id}");
    } else {
        log::trace!("Chat message sent and response received for session: {session_id}");
    }
    Ok(assistant_msg)
}

/// Clear chat history for a session
/// This also clears the Claude session ID, starting a fresh conversation
/// Preserves the selected model and thinking level preferences
#[tauri::command]
pub async fn clear_session_history(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<(), String> {
    log::trace!("Clearing chat history for session: {session_id}");

    // Delete NDJSON run data first (outside lock - separate file)
    if let Err(e) = delete_session_data(&app, &session_id) {
        log::warn!("Failed to delete session data: {e}");
    }

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            let selected_model = session.selected_model.clone();
            let selected_thinking_level = session.selected_thinking_level.clone();

            session.messages.clear();
            session.claude_session_id = None;
            session.selected_model = selected_model;
            session.selected_thinking_level = selected_thinking_level;

            log::trace!("Session history cleared");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Set the selected model for a session
#[tauri::command]
pub async fn set_session_model(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    model: String,
) -> Result<(), String> {
    log::trace!("Setting model for session {session_id}: {model}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.selected_model = Some(model);
            log::trace!("Model selection saved");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Set the selected thinking level for a session
#[tauri::command]
pub async fn set_session_thinking_level(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    thinking_level: ThinkingLevel,
) -> Result<(), String> {
    log::trace!("Setting thinking level for session {session_id}: {thinking_level:?}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.selected_thinking_level = Some(thinking_level);
            log::trace!("Thinking level selection saved");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Cancel a running Claude chat request for a session
/// Returns true if a process was found and cancelled, false if no process was running
#[tauri::command]
pub async fn cancel_chat_message(
    app: AppHandle,
    session_id: String,
    worktree_id: String,
) -> Result<bool, String> {
    log::trace!("Cancel chat message requested for session: {session_id}");
    cancel_process(&app, &session_id, &worktree_id)
}

/// Check if any sessions have running Claude processes
/// Used for quit confirmation dialog to prevent accidental closure during active sessions
#[tauri::command]
pub fn has_running_sessions() -> bool {
    !super::registry::get_running_sessions().is_empty()
}

/// Save a cancelled message to chat history
/// Called by frontend when a response is cancelled mid-stream
#[tauri::command]
pub async fn save_cancelled_message(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    content: String,
    tool_calls: Vec<super::types::ToolCall>,
    content_blocks: Vec<super::types::ContentBlock>,
) -> Result<(), String> {
    // With NDJSON-only storage, cancelled messages are already stored in the
    // NDJSON run log via run_log_writer.cancel(). This command is now a no-op
    // kept for frontend compatibility.
    log::trace!("Cancelled message already in NDJSON for session: {session_id}");

    // Suppress unused variable warnings
    let _ = (
        app,
        worktree_id,
        worktree_path,
        content,
        tool_calls,
        content_blocks,
    );

    Ok(())
}

/// Mark a message's plan as approved
///
/// With NDJSON-only storage, this adds the message ID to the session's
/// approved_plan_message_ids list. When loading messages from NDJSON,
/// we set plan_approved=true for messages in this list.
#[tauri::command]
pub async fn mark_plan_approved(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    log::trace!("Marking plan approved for message: {message_id}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            if !session.approved_plan_message_ids.contains(&message_id) {
                session.approved_plan_message_ids.push(message_id.clone());
                log::trace!("Plan marked as approved (added to approved_plan_message_ids)");
            }
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

// ============================================================================
// Image Commands (for pasted images in chat)
// ============================================================================

use super::storage::get_images_dir;
use super::types::SaveImageResponse;
use base64::{engine::general_purpose::STANDARD, Engine};

/// Allowed MIME types for pasted images
const ALLOWED_MIME_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Maximum image size in bytes (10MB)
const MAX_IMAGE_SIZE: usize = 10 * 1024 * 1024;

/// Save a pasted image to the app data directory
///
/// The image data should be base64-encoded (without the data URL prefix).
/// Returns the saved image path for referencing in messages.
#[tauri::command]
pub async fn save_pasted_image(
    app: AppHandle,
    data: String,
    mime_type: String,
) -> Result<SaveImageResponse, String> {
    log::trace!("Saving pasted image, mime_type: {mime_type}");

    // Validate MIME type
    if !ALLOWED_MIME_TYPES.contains(&mime_type.as_str()) {
        return Err(format!(
            "Invalid image type: {mime_type}. Allowed types: {}",
            ALLOWED_MIME_TYPES.join(", ")
        ));
    }

    // Decode base64 data
    let image_data = STANDARD
        .decode(&data)
        .map_err(|e| format!("Failed to decode base64 image data: {e}"))?;

    // Check size limit
    if image_data.len() > MAX_IMAGE_SIZE {
        return Err(format!(
            "Image too large: {} bytes. Maximum size: {} bytes (10MB)",
            image_data.len(),
            MAX_IMAGE_SIZE
        ));
    }

    // Get the images directory (now in app data dir)
    let images_dir = get_images_dir(&app)?;

    // Generate unique filename
    let extension = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png", // fallback
    };

    let timestamp = now();
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let filename = format!("image-{timestamp}-{short_uuid}.{extension}");
    let file_path = images_dir.join(&filename);

    // Write file atomically (temp file + rename)
    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, &image_data)
        .map_err(|e| format!("Failed to write image file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize image file: {e}"))?;

    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    log::trace!("Image saved to: {path_str}");

    Ok(SaveImageResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
    })
}

/// Save a dropped image file to the app data directory
///
/// Takes a source file path (from Tauri's drag-drop event) and copies it
/// to the images directory. More efficient than base64 encoding for dropped files.
#[tauri::command]
pub async fn save_dropped_image(
    app: AppHandle,
    source_path: String,
) -> Result<SaveImageResponse, String> {
    log::trace!("Saving dropped image from: {source_path}");

    let source = std::path::PathBuf::from(&source_path);

    // Validate source file exists
    if !source.exists() {
        return Err(format!("Source file not found: {source_path}"));
    }

    // Get extension and validate it's an allowed image type
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .ok_or_else(|| "File has no extension".to_string())?;

    let allowed_extensions = ["png", "jpg", "jpeg", "gif", "webp"];
    if !allowed_extensions.contains(&extension.as_str()) {
        return Err(format!(
            "Invalid image type: .{extension}. Allowed types: {}",
            allowed_extensions.join(", ")
        ));
    }

    // Check file size
    let metadata = std::fs::metadata(&source)
        .map_err(|e| format!("Failed to read file metadata: {e}"))?;

    if metadata.len() as usize > MAX_IMAGE_SIZE {
        return Err(format!(
            "Image too large: {} bytes. Maximum size: {} bytes (10MB)",
            metadata.len(),
            MAX_IMAGE_SIZE
        ));
    }

    // Get the images directory
    let images_dir = get_images_dir(&app)?;

    // Generate unique filename (normalize jpeg to jpg)
    let normalized_ext = if extension == "jpeg" { "jpg" } else { &extension };
    let timestamp = now();
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let filename = format!("image-{timestamp}-{short_uuid}.{normalized_ext}");
    let dest_path = images_dir.join(&filename);

    // Copy file atomically (copy to temp, then rename)
    let temp_path = dest_path.with_extension("tmp");
    std::fs::copy(&source, &temp_path)
        .map_err(|e| format!("Failed to copy image file: {e}"))?;

    std::fs::rename(&temp_path, &dest_path)
        .map_err(|e| format!("Failed to finalize image file: {e}"))?;

    let path_str = dest_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    log::trace!("Dropped image saved to: {path_str}");

    Ok(SaveImageResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
    })
}

/// Delete a pasted image
///
/// Validates that the path is within allowed directories before deleting.
/// Supports both old (.jean/images/) and new (app data pasted-images/) locations.
#[tauri::command]
pub async fn delete_pasted_image(app: AppHandle, path: String) -> Result<(), String> {
    log::trace!("Deleting pasted image: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Validate that the path exists
    if !file_path.exists() {
        log::warn!("Image file not found: {path}");
        return Ok(()); // Not an error if file doesn't exist
    }

    // Validate that the path is within allowed directories
    let path_str = file_path.to_string_lossy();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let app_data_str = app_data_dir.to_string_lossy();

    // Check if path is in old .jean/images/ or new app data pasted-images/
    let is_old_location =
        path_str.contains(".jean/images/") || path_str.contains(".jean\\images\\");
    let is_new_location = path_str.contains(&format!("{app_data_str}/pasted-images/"))
        || path_str.contains(&format!("{app_data_str}\\pasted-images\\"));

    if !is_old_location && !is_new_location {
        return Err("Invalid path: must be within allowed directories".to_string());
    }

    // Delete the file
    std::fs::remove_file(&file_path).map_err(|e| format!("Failed to delete image: {e}"))?;

    log::trace!("Image deleted: {path}");
    Ok(())
}

// ============================================================================
// Text Paste Commands (for large text pastes in chat)
// ============================================================================

use super::storage::get_pastes_dir;
use super::types::{ReadTextResponse, SaveTextResponse};

/// Maximum text file size in bytes (10MB)
const MAX_TEXT_SIZE: usize = 10 * 1024 * 1024;

/// Save pasted text to the app data directory
///
/// Large text pastes (500+ chars) are saved as files instead of being inlined.
/// Returns the saved file path for referencing in messages.
#[tauri::command]
pub async fn save_pasted_text(app: AppHandle, content: String) -> Result<SaveTextResponse, String> {
    let size = content.len();
    log::trace!("Saving pasted text, size: {size} bytes");

    // Check size limit
    if size > MAX_TEXT_SIZE {
        return Err(format!(
            "Text too large: {size} bytes. Maximum size: {MAX_TEXT_SIZE} bytes (10MB)"
        ));
    }

    // Get the pastes directory (now in app data dir)
    let pastes_dir = get_pastes_dir(&app)?;

    // Generate unique filename
    let timestamp = now();
    let short_uuid = &Uuid::new_v4().to_string()[..8];
    let filename = format!("paste-{timestamp}-{short_uuid}.txt");
    let file_path = pastes_dir.join(&filename);

    // Write file atomically (temp file + rename)
    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, &content).map_err(|e| format!("Failed to write text file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize text file: {e}"))?;

    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    log::trace!("Text file saved to: {path_str}");

    Ok(SaveTextResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
        size,
    })
}

/// Delete a pasted text file
///
/// Validates that the path is within allowed directories before deleting.
/// Supports both old (.jean/pastes/) and new (app data pasted-texts/) locations.
#[tauri::command]
pub async fn delete_pasted_text(app: AppHandle, path: String) -> Result<(), String> {
    log::trace!("Deleting pasted text file: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Validate that the path exists
    if !file_path.exists() {
        log::warn!("Text file not found: {path}");
        return Ok(()); // Not an error if file doesn't exist
    }

    // Validate that the path is within allowed directories
    let path_str = file_path.to_string_lossy();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let app_data_str = app_data_dir.to_string_lossy();

    // Check if path is in old .jean/pastes/ or new app data pasted-texts/
    let is_old_location =
        path_str.contains(".jean/pastes/") || path_str.contains(".jean\\pastes\\");
    let is_new_location = path_str.contains(&format!("{app_data_str}/pasted-texts/"))
        || path_str.contains(&format!("{app_data_str}\\pasted-texts\\"));

    if !is_old_location && !is_new_location {
        return Err("Invalid path: must be within allowed directories".to_string());
    }

    // Delete the file
    std::fs::remove_file(&file_path).map_err(|e| format!("Failed to delete text file: {e}"))?;

    log::trace!("Text file deleted: {path}");
    Ok(())
}

/// Read a pasted text file from disk
///
/// Used by the frontend to display pasted text content in sent messages.
/// Returns the file content along with its size in bytes.
#[tauri::command]
pub async fn read_pasted_text(app: AppHandle, path: String) -> Result<ReadTextResponse, String> {
    log::trace!("Reading pasted text file: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Validate that the path exists
    if !file_path.exists() {
        return Err(format!("Text file not found: {path}"));
    }

    // Validate that the path is within allowed directories
    let path_str = file_path.to_string_lossy();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let app_data_str = app_data_dir.to_string_lossy();

    // Check if path is in old .jean/pastes/ or new app data pasted-texts/
    let is_old_location =
        path_str.contains(".jean/pastes/") || path_str.contains(".jean\\pastes\\");
    let is_new_location = path_str.contains(&format!("{app_data_str}/pasted-texts/"))
        || path_str.contains(&format!("{app_data_str}\\pasted-texts\\"));

    if !is_old_location && !is_new_location {
        return Err("Invalid path: must be within allowed directories".to_string());
    }

    // Check file size
    let metadata =
        std::fs::metadata(&file_path).map_err(|e| format!("Failed to read file metadata: {e}"))?;
    let size = metadata.len() as usize;

    // Check size limit
    if size > MAX_TEXT_SIZE {
        return Err(format!(
            "Text file too large: {size} bytes. Maximum size: {MAX_TEXT_SIZE} bytes (10MB)"
        ));
    }

    // Read file content
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read text file: {e}"))?;

    log::trace!("Successfully read pasted text file: {path} ({size} bytes)");
    Ok(ReadTextResponse { content, size })
}

/// Read a plan file from disk
///
/// Used by the frontend to display plan file content in the approval UI.
/// Only allows reading .md files from ~/.claude/plans/ directory.
#[tauri::command]
pub async fn read_plan_file(path: String) -> Result<String, String> {
    log::trace!("Reading plan file: {path}");

    // Validate that the path is within ~/.claude/plans/
    if !path.contains("/.claude/plans/") && !path.contains("\\.claude\\plans\\") {
        return Err("Invalid path: must be within ~/.claude/plans/ directory".to_string());
    }

    // Validate it's a .md file
    if !path.ends_with(".md") {
        return Err("Invalid path: must be a .md file".to_string());
    }

    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read plan file: {e}"))
}

/// Read file content from disk for previewing in the UI
///
/// Used to display file content when clicking on a filename in Read tool calls.
/// Has a 10MB size limit to prevent memory issues with large files.
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    log::trace!("Reading file content: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Check if file exists
    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }

    // Check file size (10MB limit)
    let metadata =
        std::fs::metadata(&file_path).map_err(|e| format!("Failed to read file metadata: {e}"))?;

    const MAX_SIZE: u64 = 10 * 1024 * 1024; // 10MB
    if metadata.len() > MAX_SIZE {
        return Err(format!(
            "File too large: {} bytes (max {} bytes)",
            metadata.len(),
            MAX_SIZE
        ));
    }

    // Read the file content
    std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {e}"))
}

/// Write file content to disk
///
/// Used to save file content when editing in the inline editor.
/// Has a 10MB size limit to prevent memory issues with large files.
#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    log::trace!("Writing file content: {path}");

    let file_path = std::path::PathBuf::from(&path);

    // Check content size (10MB limit)
    const MAX_SIZE: usize = 10 * 1024 * 1024; // 10MB
    if content.len() > MAX_SIZE {
        return Err(format!(
            "Content too large: {} bytes (max {} bytes)",
            content.len(),
            MAX_SIZE
        ));
    }

    // Write the file content
    std::fs::write(&file_path, &content).map_err(|e| format!("Failed to write file: {e}"))
}

/// Open a file in the user's preferred editor
///
/// Uses the editor preference (vscode, cursor, xcode) to open files.
#[tauri::command]
pub async fn open_file_in_default_app(
    path: String,
    editor: Option<String>,
) -> Result<(), String> {
    let editor_app = editor.unwrap_or_else(|| "vscode".to_string());
    log::trace!("Opening file in {editor_app}: {path}");

    #[cfg(target_os = "macos")]
    {
        let result = match editor_app.as_str() {
            "cursor" => std::process::Command::new("cursor").arg(&path).spawn(),
            "xcode" => std::process::Command::new("xed").arg(&path).spawn(),
            _ => std::process::Command::new("code").arg(&path).spawn(),
        };

        result.map_err(|e| format!("Failed to open {editor_app}: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        let result = match editor_app.as_str() {
            "cursor" => std::process::Command::new("cursor").arg(&path).spawn(),
            _ => std::process::Command::new("code").arg(&path).spawn(),
        };

        result.map_err(|e| format!("Failed to open {editor_app}: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        let result = match editor_app.as_str() {
            "cursor" => std::process::Command::new("cursor").arg(&path).spawn(),
            _ => std::process::Command::new("code").arg(&path).spawn(),
        };

        result.map_err(|e| format!("Failed to open {editor_app}: {e}"))?;
    }

    Ok(())
}

// ============================================================================
// Saved Context Commands (for Save/Load Context magic commands)
// ============================================================================

use super::storage::{
    get_saved_contexts_dir, load_saved_contexts_metadata, save_saved_contexts_metadata,
};
use super::types::{SaveContextResponse, SavedContext, SavedContextsResponse};

/// Sanitize a string for use as a filename component
/// Keeps only alphanumeric characters and hyphens, converts to lowercase
fn sanitize_for_filename(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        // Collapse multiple consecutive hyphens into one
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Parse a saved context filename into metadata
/// Filename format: {project}-{timestamp}-{slug}.md
/// Also handles non-standard formats by using file metadata
fn parse_context_filename(path: &std::path::Path) -> Option<SavedContext> {
    let filename = path.file_name()?.to_str()?;

    // Must end with .md
    if !filename.ends_with(".md") {
        return None;
    }

    // Get file metadata
    let metadata = std::fs::metadata(path).ok()?;
    let size = metadata.len();

    // Try to get created_at from file metadata, fallback to modified time
    let file_created_at = metadata
        .created()
        .or_else(|_| metadata.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Remove .md extension
    let name_without_ext = &filename[..filename.len() - 3];

    // Split by hyphens and find the timestamp (10 digits)
    let parts: Vec<&str> = name_without_ext.split('-').collect();

    // Find the timestamp index (10-digit number)
    if let Some(timestamp_idx) = parts
        .iter()
        .position(|p| p.len() == 10 && p.parse::<u64>().is_ok())
    {
        // Standard format: {project}-{timestamp}-{slug}.md
        let project_name = parts[..timestamp_idx].join("-");
        let slug = parts[timestamp_idx + 1..].join("-");
        let parsed_timestamp = parts[timestamp_idx]
            .parse::<u64>()
            .unwrap_or(file_created_at);

        Some(SavedContext {
            id: Uuid::new_v4().to_string(),
            filename: filename.to_string(),
            path: path.to_string_lossy().to_string(),
            project_name,
            slug,
            size,
            created_at: parsed_timestamp,
            name: None, // Custom name loaded separately from metadata
        })
    } else {
        // Non-standard format: use filename as slug, unknown project
        log::trace!("Non-standard context filename: {filename}");
        Some(SavedContext {
            id: Uuid::new_v4().to_string(),
            filename: filename.to_string(),
            path: path.to_string_lossy().to_string(),
            project_name: "Unknown".to_string(),
            slug: name_without_ext.to_string(),
            size,
            created_at: file_created_at,
            name: None, // Custom name loaded separately from metadata
        })
    }
}

/// List all saved contexts from the app data directory
///
/// Returns contexts sorted by creation time (newest first).
/// Includes custom names from the metadata file.
#[tauri::command]
pub async fn list_saved_contexts(app: AppHandle) -> Result<SavedContextsResponse, String> {
    log::trace!("Listing saved contexts");

    let contexts_dir = get_saved_contexts_dir(&app)?;

    // Load metadata for custom names
    let metadata = load_saved_contexts_metadata(&app);

    let mut contexts = Vec::new();

    // Read all .md files from the directory
    let entries = std::fs::read_dir(&contexts_dir)
        .map_err(|e| format!("Failed to read contexts directory: {e}"))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let path = entry.path();

        if path.extension().is_some_and(|ext| ext == "md") {
            if let Some(mut context) = parse_context_filename(&path) {
                // Merge custom name from metadata if present
                context.name = metadata.names.get(&context.filename).cloned();
                contexts.push(context);
            }
        }
    }

    // Sort by created_at descending (newest first)
    contexts.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    log::trace!("Found {} saved contexts", contexts.len());
    Ok(SavedContextsResponse { contexts })
}

/// Save context content to a file
///
/// Filename format: {project}-{timestamp}-{slug}.md
#[tauri::command]
pub async fn save_context_file(
    app: AppHandle,
    project_name: String,
    slug: String,
    content: String,
) -> Result<SaveContextResponse, String> {
    log::trace!("Saving context for project: {project_name}, slug: {slug}");

    let contexts_dir = get_saved_contexts_dir(&app)?;

    // Generate filename
    let timestamp = now();
    let safe_project = sanitize_for_filename(&project_name);
    let safe_slug = sanitize_for_filename(&slug);
    let filename = format!("{safe_project}-{timestamp}-{safe_slug}.md");

    let file_path = contexts_dir.join(&filename);

    // Write content atomically (temp file + rename)
    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, &content)
        .map_err(|e| format!("Failed to write context file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize context file: {e}"))?;

    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    let size = content.len() as u64;

    log::trace!("Context saved to: {path_str}");

    Ok(SaveContextResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
        size,
    })
}

/// Read a saved context file content
///
/// Validates that the path is within the session-context directory.
#[tauri::command]
pub async fn read_context_file(app: AppHandle, path: String) -> Result<String, String> {
    log::trace!("Reading context file: {path}");

    // Validate path is within session-context directory
    let contexts_dir = get_saved_contexts_dir(&app)?;
    let file_path = std::path::PathBuf::from(&path);

    // Canonicalize both paths to resolve symlinks and normalize
    let contexts_dir_canonical = contexts_dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize contexts dir: {e}"))?;
    let file_path_canonical = file_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize file path: {e}"))?;

    if !file_path_canonical.starts_with(&contexts_dir_canonical) {
        return Err("Invalid context file path".to_string());
    }

    std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read context file: {e}"))
}

/// Delete a saved context file
///
/// Validates that the path is within the session-context directory.
/// Also removes any custom name from the metadata file.
#[tauri::command]
pub async fn delete_context_file(app: AppHandle, path: String) -> Result<(), String> {
    log::trace!("Deleting context file: {path}");

    // Validate path is within session-context directory
    let contexts_dir = get_saved_contexts_dir(&app)?;
    let file_path = std::path::PathBuf::from(&path);

    // Extract filename before deletion for metadata cleanup
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());

    // Check if file exists first
    if !file_path.exists() {
        log::warn!("Context file not found: {path}");
        return Ok(()); // Not an error if file doesn't exist
    }

    // Canonicalize both paths to resolve symlinks and normalize
    let contexts_dir_canonical = contexts_dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize contexts dir: {e}"))?;
    let file_path_canonical = file_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize file path: {e}"))?;

    if !file_path_canonical.starts_with(&contexts_dir_canonical) {
        return Err("Invalid context file path".to_string());
    }

    std::fs::remove_file(&file_path).map_err(|e| format!("Failed to delete context file: {e}"))?;

    // Remove from metadata if present
    if let Some(filename) = filename {
        let mut metadata = load_saved_contexts_metadata(&app);
        if metadata.names.remove(&filename).is_some() {
            // Only save if we actually removed something
            if let Err(e) = save_saved_contexts_metadata(&app, &metadata) {
                log::warn!("Failed to update metadata after delete: {e}");
            }
        }
    }

    log::trace!("Context file deleted: {path}");
    Ok(())
}

/// Rename a saved context (sets custom display name in metadata)
///
/// The filename is unchanged - only the display name stored in metadata is updated.
/// An empty name removes the custom name (reverts to showing the slug).
#[tauri::command]
pub async fn rename_saved_context(
    app: AppHandle,
    filename: String,
    new_name: String,
) -> Result<(), String> {
    log::trace!("Renaming saved context: {filename} -> {new_name}");

    // Validate the context file exists
    let contexts_dir = get_saved_contexts_dir(&app)?;
    let context_path = contexts_dir.join(&filename);

    if !context_path.exists() {
        return Err(format!("Context file not found: {filename}"));
    }

    // Load existing metadata
    let mut metadata = load_saved_contexts_metadata(&app);

    // Update or remove the name
    let trimmed_name = new_name.trim();
    if trimmed_name.is_empty() {
        // Empty name removes the custom name (reverts to slug)
        metadata.names.remove(&filename);
    } else {
        metadata
            .names
            .insert(filename.clone(), trimmed_name.to_string());
    }

    // Save metadata
    save_saved_contexts_metadata(&app, &metadata)?;

    log::trace!("Saved context renamed successfully");
    Ok(())
}

// ============================================================================
// Background Context Generation
// ============================================================================

/// Prompt template for context summarization (JSON schema output)
const CONTEXT_SUMMARY_PROMPT: &str = r#"Summarize the following conversation for future context loading.

Your summary should include:
1. **Main Goal**: What was the primary objective?
2. **Key Decisions & Rationale**: Important decisions made and WHY they were chosen over alternatives
3. **Trade-offs Considered**: What approaches were weighed? What was rejected and why?
4. **Problems Solved**: Errors, blockers, or gotchas encountered and how they were resolved
5. **Current State**: What has been implemented or discussed so far?
6. **Unresolved Questions**: Open questions, blockers, or things that need user input
7. **Key Files & Patterns**: Critical file paths, function names, or code patterns established
8. **Next Steps**: What remains to be done?

Format the summary as clean markdown. Be concise but capture the reasoning behind decisions.

---
**Project:** {project_name}
**Date:** {date}
---

## Conversation History

{conversation}"#;

/// JSON schema for structured context summarization output
const CONTEXT_SUMMARY_SCHEMA: &str = r#"{"type":"object","properties":{"summary":{"type":"string","description":"The markdown context summary including main goal, key decisions with rationale, trade-offs considered, problems solved, current state, unresolved questions, key files/patterns, and next steps"},"slug":{"type":"string","description":"A 2-4 word lowercase hyphenated slug describing the main topic (e.g. implement-magic-commands, fix-auth-bug)"}},"required":["summary","slug"]}"#;

/// Format chat messages into a conversation history string for summarization
fn format_messages_for_summary(messages: &[ChatMessage]) -> String {
    if messages.is_empty() {
        return "No messages in this conversation.".to_string();
    }

    messages
        .iter()
        .map(|msg| {
            let role = match msg.role {
                MessageRole::User => "User",
                MessageRole::Assistant => "Assistant",
            };
            // Truncate very long messages to avoid context overflow
            let content = if msg.content.len() > 5000 {
                format!(
                    "{}...\n[Message truncated - {} chars total]",
                    &msg.content[..5000],
                    msg.content.len()
                )
            } else {
                msg.content.clone()
            };
            format!("### {role}\n{content}")
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

/// Extract text or JSON content from stream-json output
/// Handles both regular text responses and JSON schema structured responses
/// For --json-schema, Claude returns structured output via a tool call named "StructuredOutput"
fn extract_text_from_stream_json(output: &str) -> Result<String, String> {
    let mut text_content = String::new();
    let mut structured_output: Option<serde_json::Value> = None;

    log::trace!("Parsing stream-json output ({} bytes)", output.len());

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                log::trace!("Failed to parse line as JSON: {e}, line: {line}");
                continue;
            }
        };

        let msg_type = parsed.get("type").and_then(|t| t.as_str());
        log::trace!("Parsed message type: {msg_type:?}");

        if parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
            if let Some(message) = parsed.get("message") {
                if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
                    for block in content {
                        let block_type = block.get("type").and_then(|t| t.as_str());

                        // Handle regular text blocks
                        if block_type == Some("text") {
                            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                text_content.push_str(text);
                            }
                        }

                        // Handle StructuredOutput tool call (from --json-schema)
                        if block_type == Some("tool_use") {
                            let tool_name = block.get("name").and_then(|n| n.as_str());
                            log::trace!(
                                "Found tool_use block: name={:?}, block={block}",
                                tool_name
                            );
                            if tool_name == Some("StructuredOutput") {
                                if let Some(input) = block.get("input") {
                                    log::trace!("Found StructuredOutput input: {input}");
                                    structured_output = Some(input.clone());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Handle result - can be either a string or a JSON object
        if parsed.get("type").and_then(|t| t.as_str()) == Some("result") {
            if let Some(result) = parsed.get("result") {
                if let Some(result_str) = result.as_str() {
                    if text_content.is_empty() {
                        text_content = result_str.to_string();
                    }
                }
                if result.is_object() && structured_output.is_none() {
                    structured_output = Some(result.clone());
                }
            }
        }
    }

    // Prefer structured output from StructuredOutput tool call
    if let Some(json_val) = structured_output {
        let result = json_val.to_string();
        log::trace!("Returning structured output: {result}");
        return Ok(result);
    }

    log::trace!(
        "No structured output found, text_content length: {}",
        text_content.len()
    );

    if text_content.is_empty() {
        log::error!("No content found in stream-json output. Raw output: {output}");
        return Err("No text content found in Claude response".to_string());
    }

    Ok(text_content.trim().to_string())
}

/// Structured response from context summarization
#[derive(Debug, serde::Deserialize)]
struct ContextSummaryResponse {
    summary: String,
    slug: String,
}

/// Generate a fallback slug from project and session name
/// Sanitizes and combines both, truncates to reasonable length
fn generate_fallback_slug(project_name: &str, session_name: &str) -> String {
    let combined = format!("{project_name} {session_name}");
    let sanitized = sanitize_for_filename(&combined);
    // Limit to first 4 "words" (hyphen-separated parts)
    let parts: Vec<&str> = sanitized.split('-').take(4).collect();
    if parts.is_empty() {
        "context".to_string()
    } else {
        parts.join("-")
    }
}

/// Execute one-shot Claude CLI call for summarization with JSON schema (non-streaming)
fn execute_summarization_claude(
    app: &AppHandle,
    prompt: &str,
) -> Result<ContextSummaryResponse, String> {
    let cli_path = get_cli_binary_path(app)?;

    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::trace!("Executing one-shot Claude summarization with JSON schema");

    let mut cmd = Command::new(&cli_path);
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "opus", // High-quality model for summarization
        "--no-session-persistence",
        "--max-turns",
        "1",
        "--json-schema",
        CONTEXT_SUMMARY_SCHEMA,
    ]);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

    // Write prompt to stdin as stream-json format
    {
        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let input_message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });
        writeln!(stdin, "{input_message}").map_err(|e| format!("Failed to write to stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Claude CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Claude CLI failed (exit code {:?}): stderr={}, stdout={}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    log::trace!("Claude CLI stdout: {stdout}");
    log::trace!("Claude CLI stderr: {stderr}");

    let text_content = extract_text_from_stream_json(&stdout)?;

    log::trace!("Extracted text content for JSON parsing: {text_content}");

    // Check for empty content before trying to parse
    if text_content.trim().is_empty() {
        log::error!(
            "Empty content extracted from Claude response. stdout: {}, stderr: {}",
            stdout,
            stderr
        );
        return Err("Empty response from Claude CLI".to_string());
    }

    // Parse the JSON response
    serde_json::from_str(&text_content).map_err(|e| {
        log::error!(
            "Failed to parse JSON response: {e}, content: {text_content}, stdout: {stdout}"
        );
        format!("Failed to parse structured response: {e}")
    })
}

/// Generate a context summary from a session's messages in the background
///
/// This command loads a session's messages, sends them to Claude for summarization,
/// and saves the result as a context file. It does NOT show anything in the current chat.
#[tauri::command]
pub async fn generate_context_from_session(
    app: AppHandle,
    worktree_path: String,
    worktree_id: String,
    source_session_id: String,
    project_name: String,
    custom_prompt: Option<String>,
) -> Result<SaveContextResponse, String> {
    log::trace!(
        "Generating context from session {} for project {}",
        source_session_id,
        project_name
    );

    // 1. Verify session exists
    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    let session = sessions
        .find_session(&source_session_id)
        .ok_or_else(|| format!("Session not found: {source_session_id}"))?;

    // 2. Load actual messages from NDJSON
    let messages = run_log::load_session_messages(&app, &source_session_id)?;

    if messages.is_empty() {
        return Err("Session has no messages to summarize".to_string());
    }

    // 3. Format messages into conversation history
    let conversation_history = format_messages_for_summary(&messages);

    // 4. Build summarization prompt - use custom if provided and non-empty, otherwise use default
    let today = format!("timestamp:{}", now()); // Use timestamp instead of formatted date
    let prompt_template = custom_prompt
        .as_ref()
        .filter(|p| !p.trim().is_empty())
        .map(|s| s.as_str())
        .unwrap_or(CONTEXT_SUMMARY_PROMPT);

    let prompt = prompt_template
        .replace("{project_name}", &project_name)
        .replace("{date}", &today)
        .replace("{conversation}", &conversation_history);

    // 4. Call Claude CLI with JSON schema (non-streaming)
    // If JSON parsing fails, use fallback slug from project + session name
    let (summary, slug) = match execute_summarization_claude(&app, &prompt) {
        Ok(response) => {
            // Validate slug is not empty
            let slug = if response.slug.trim().is_empty() {
                log::warn!("Empty slug in response, using fallback");
                generate_fallback_slug(&project_name, &session.name)
            } else {
                response.slug
            };
            (response.summary, slug)
        }
        Err(e) => {
            log::error!("Structured summarization failed: {e}, cannot generate context");
            return Err(e);
        }
    };

    // 5. Save context file
    let contexts_dir = get_saved_contexts_dir(&app)?;
    let timestamp = now();
    let safe_project = sanitize_for_filename(&project_name);
    let safe_slug = sanitize_for_filename(&slug);
    let filename = format!("{safe_project}-{timestamp}-{safe_slug}.md");
    let file_path = contexts_dir.join(&filename);

    // Write content atomically
    let temp_path = file_path.with_extension("tmp");
    std::fs::write(&temp_path, &summary)
        .map_err(|e| format!("Failed to write context file: {e}"))?;

    std::fs::rename(&temp_path, &file_path)
        .map_err(|e| format!("Failed to finalize context file: {e}"))?;

    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Failed to convert path to string".to_string())?
        .to_string();

    let size = summary.len() as u64;

    log::trace!("Context generated and saved to: {path_str}");

    Ok(SaveContextResponse {
        id: Uuid::new_v4().to_string(),
        filename,
        path: path_str,
        size,
    })
}

// ============================================================================
// Session Debug Info Commands
// ============================================================================

use super::types::{RunLogFileInfo, SessionDebugInfo, UsageData};

/// Get debug information about a session's storage paths and JSONL files
///
/// Returns paths to all storage files for debugging and the "reveal in Finder" feature.
#[tauri::command]
pub async fn get_session_debug_info(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<SessionDebugInfo, String> {
    // Get app data directory
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let app_data_str = app_data_dir.to_str().unwrap_or("unknown").to_string();

    // Get index file path (was sessions file)
    let sessions_file = get_index_path(&app, &worktree_id)?
        .to_str()
        .unwrap_or("unknown")
        .to_string();

    // Get data directory (was runs directory)
    let runs_dir = get_data_dir(&app)?
        .to_str()
        .unwrap_or("unknown")
        .to_string();

    // Load session to get claude_session_id
    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    let session = sessions.find_session(&session_id);
    let claude_session_id = session.and_then(|s| s.claude_session_id.clone());

    // Try to find Claude CLI's JSONL file
    let claude_jsonl_file = claude_session_id.as_ref().and_then(|sid| {
        // Claude CLI stores sessions in ~/.claude/projects/<project-hash>/<session-id>.jsonl
        let home = dirs::home_dir()?;
        let claude_projects = home.join(".claude").join("projects");

        // We need to search for the session file in the projects directory
        // The project hash is based on the worktree path
        if claude_projects.exists() {
            for entry in std::fs::read_dir(&claude_projects).ok()? {
                let entry = entry.ok()?;
                let project_dir = entry.path();
                if project_dir.is_dir() {
                    let session_file = project_dir.join(format!("{sid}.jsonl"));
                    if session_file.exists() {
                        return session_file.to_str().map(|s| s.to_string());
                    }
                }
            }
        }
        None
    });

    // Get session directory and metadata file path (was manifest)
    let session_dir = get_session_dir(&app, &session_id)?;
    let metadata_path = session_dir.join("metadata.json");
    let manifest_file = if metadata_path.exists() {
        metadata_path.to_str().map(|s| s.to_string())
    } else {
        None
    };

    // Load metadata to get run info
    let metadata = load_metadata(&app, &session_id)?;

    // Build JSONL file info list
    let mut run_log_files = Vec::new();
    if let Some(metadata) = metadata {
        for run in &metadata.runs {
            let jsonl_path = session_dir.join(format!("{}.jsonl", run.run_id));
            if jsonl_path.exists() {
                // Truncate user message preview to 50 chars
                let preview = if run.user_message.len() > 50 {
                    format!("{}...", &run.user_message[..47])
                } else {
                    run.user_message.clone()
                };

                run_log_files.push(RunLogFileInfo {
                    run_id: run.run_id.clone(),
                    path: jsonl_path.to_str().unwrap_or("unknown").to_string(),
                    status: run.status.clone(),
                    user_message_preview: preview,
                    usage: run.usage.clone(),
                });
            }
        }
    }

    // Calculate total usage across all runs
    let total_usage = run_log_files.iter().filter_map(|f| f.usage.as_ref()).fold(
        UsageData::default(),
        |mut acc, u| {
            acc.input_tokens += u.input_tokens;
            acc.output_tokens += u.output_tokens;
            acc.cache_read_input_tokens += u.cache_read_input_tokens;
            acc.cache_creation_input_tokens += u.cache_creation_input_tokens;
            acc
        },
    );

    Ok(SessionDebugInfo {
        app_data_dir: app_data_str,
        sessions_file,
        runs_dir,
        manifest_file,
        claude_session_id,
        claude_jsonl_file,
        run_log_files,
        total_usage,
    })
}

// ============================================================================
// Session Resume Commands
// ============================================================================

/// Response for resume_session command
#[derive(Debug, Clone, serde::Serialize)]
pub struct ResumeSessionResponse {
    /// Whether any runs were resumed
    pub resumed: bool,
    /// Number of runs resumed
    pub run_count: usize,
}

/// Resume a session that has resumable runs (detached processes still running).
///
/// This is called when the frontend detects that a session has a "Resumable" run
/// (process still running after app restart). It starts tailing the output file
/// to continue receiving events.
#[tauri::command]
pub async fn resume_session(
    app: AppHandle,
    session_id: String,
    worktree_id: String,
) -> Result<ResumeSessionResponse, String> {
    use super::run_log::RunLogWriter;
    use super::storage::save_metadata;

    log::trace!("Attempting to resume session: {session_id}");

    // Load the metadata to find resumable runs
    let mut metadata = match load_metadata(&app, &session_id)? {
        Some(m) => m,
        None => {
            log::trace!("No metadata found for session: {session_id}");
            return Ok(ResumeSessionResponse {
                resumed: false,
                run_count: 0,
            });
        }
    };

    // Find resumable runs
    let resumable_runs: Vec<_> = metadata
        .runs
        .iter()
        .filter(|r| r.status == RunStatus::Resumable && r.pid.is_some())
        .cloned()
        .collect();

    if resumable_runs.is_empty() {
        log::trace!("No resumable runs found for session: {session_id}");
        return Ok(ResumeSessionResponse {
            resumed: false,
            run_count: 0,
        });
    }

    let run_count = resumable_runs.len();
    log::trace!(
        "Found {} resumable run(s) for session: {session_id}",
        run_count
    );

    // Get session directory for output files
    let session_dir = get_session_dir(&app, &session_id)?;

    // Process each resumable run
    for run in resumable_runs {
        let run_id = run.run_id.clone();
        let pid = run.pid.unwrap(); // Safe because we filtered for Some above
        let output_file = session_dir.join(format!("{run_id}.jsonl"));

        log::trace!(
            "Resuming run: {run_id}, PID: {pid}, output: {:?}",
            output_file
        );

        // Mark the run as Running again (from Resumable)
        if let Some(metadata_run) = metadata.find_run_mut(&run_id) {
            metadata_run.status = RunStatus::Running;
        }
        save_metadata(&app, &metadata)?;

        // Clone values for the async task
        let app_clone = app.clone();
        let session_id_clone = session_id.clone();
        let worktree_id_clone = worktree_id.clone();
        let run_id_clone = run_id.clone();

        // Spawn a task to tail the output file
        tauri::async_runtime::spawn(async move {
            log::trace!("Starting tail task for run: {run_id_clone}, session: {session_id_clone}");

            // Tail the output file
            let result = super::claude::tail_claude_output(
                &app_clone,
                &session_id_clone,
                &worktree_id_clone,
                &output_file,
                pid,
            );

            match result {
                Ok(response) => {
                    log::trace!(
                        "Resume completed for run: {run_id_clone}, session_id: {:?}",
                        response.session_id
                    );

                    // Create a RunLogWriter to update the manifest
                    if let Ok(mut writer) =
                        RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                    {
                        // Mark as completed
                        let assistant_message_id = uuid::Uuid::new_v4().to_string();
                        let claude_session_id = if response.session_id.is_empty() {
                            None
                        } else {
                            Some(response.session_id.as_str())
                        };
                        if let Err(e) = writer.complete(
                            &assistant_message_id,
                            claude_session_id,
                            response.usage.clone(),
                        ) {
                            log::error!("Failed to mark run as completed: {e}");
                        }

                        // Clean up input file if it exists
                        if let Err(e) = super::run_log::delete_input_file(
                            &app_clone,
                            &session_id_clone,
                            &run_id_clone,
                        ) {
                            log::trace!("Could not delete input file (may not exist): {e}");
                        }
                    }
                }
                Err(e) => {
                    log::error!("Resume failed for run: {run_id_clone}, error: {e}");

                    // Mark as crashed
                    if let Ok(mut writer) =
                        RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                    {
                        if let Err(e) = writer.crash() {
                            log::error!("Failed to mark run as crashed: {e}");
                        }
                    }
                }
            }
        });
    }

    Ok(ResumeSessionResponse {
        resumed: true,
        run_count,
    })
}

/// Check for resumable sessions on startup and return their info.
///
/// Called by frontend on app startup to check if there are any sessions
/// with detached Claude processes still running.
#[tauri::command]
pub async fn check_resumable_sessions(
    app: AppHandle,
) -> Result<Vec<super::run_log::RecoveredRun>, String> {
    log::trace!("Checking for resumable sessions");

    // This calls recover_incomplete_runs which updates statuses and returns info
    let recovered = super::run_log::recover_incomplete_runs(&app)?;

    let resumable: Vec<_> = recovered.into_iter().filter(|r| r.resumable).collect();

    log::trace!("Found {} resumable session(s)", resumable.len());

    Ok(resumable)
}

// ============================================================================
// Session Digest Commands (for context recall after switching)
// ============================================================================

/// JSON schema for session digest response
const SESSION_DIGEST_SCHEMA: &str = r#"{"type":"object","properties":{"chat_summary":{"type":"string","description":"One sentence (max 100 chars) summarizing the overall chat goal and progress"},"last_action":{"type":"string","description":"One sentence (max 80 chars) describing what was just completed"}},"required":["chat_summary","last_action"]}"#;

/// Prompt template for session digest generation
const SESSION_DIGEST_PROMPT: &str = r#"You are a summarization assistant. Your ONLY job is to summarize the following conversation transcript. Do NOT continue the conversation or take any actions. Just summarize.

CONVERSATION TRANSCRIPT:
{conversation}

END OF TRANSCRIPT.

Now provide a brief summary with exactly two fields:
- chat_summary: One sentence (max 100 chars) describing the overall goal and current status
- last_action: One sentence (max 80 chars) describing what was just completed in the last exchange"#;

/// Response from session digest generation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionDigestResponse {
    pub chat_summary: String,
    pub last_action: String,
}

/// Execute one-shot Claude CLI call for session digest with JSON schema (non-streaming)
fn execute_digest_claude(
    app: &AppHandle,
    prompt: &str,
    model: &str,
) -> Result<SessionDigestResponse, String> {
    let cli_path = get_cli_binary_path(app)?;

    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::trace!("Executing one-shot Claude digest with JSON schema");

    let mut cmd = Command::new(&cli_path);
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--no-session-persistence",
        "--max-turns",
        "2", // Need 2 turns: one for thinking, one for structured output
        "--json-schema",
        SESSION_DIGEST_SCHEMA,
        "--permission-mode",
        "plan", // Read-only mode - don't allow any tool use
    ]);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

    // Write prompt to stdin as stream-json format
    {
        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let input_message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });
        writeln!(stdin, "{input_message}").map_err(|e| format!("Failed to write to stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Claude CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Claude CLI failed (exit code {:?}): stderr={}, stdout={}",
            output.status.code(),
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    log::trace!("Claude CLI stdout: {stdout}");
    log::trace!("Claude CLI stderr: {stderr}");

    let text_content = extract_text_from_stream_json(&stdout)?;

    log::trace!("Extracted text content for JSON parsing: {text_content}");

    // Check for empty content before trying to parse
    if text_content.trim().is_empty() {
        log::error!(
            "Empty content extracted from Claude response. stdout: {}, stderr: {}",
            stdout,
            stderr
        );
        return Err("Empty response from Claude CLI".to_string());
    }

    // Parse the JSON response
    serde_json::from_str(&text_content).map_err(|e| {
        log::error!(
            "Failed to parse JSON response: {e}, content: {text_content}, stdout: {stdout}"
        );
        format!("Failed to parse structured response: {e}")
    })
}

/// Generate a brief digest of a session for context recall
///
/// This command is called when a user opens a session that had activity while
/// it was out of focus. It generates a short summary to help the user recall
/// what was happening in the session.
#[tauri::command]
pub async fn generate_session_digest(
    app: AppHandle,
    session_id: String,
) -> Result<SessionDigestResponse, String> {
    log::trace!("Generating digest for session {}", session_id);

    // Load preferences to get model
    let prefs = crate::load_preferences(app.clone())
        .await
        .map_err(|e| format!("Failed to load preferences: {e}"))?;

    // Load messages from session
    let messages = run_log::load_session_messages(&app, &session_id)?;

    if messages.len() < 2 {
        return Err("Session has too few messages for digest".to_string());
    }

    // Format messages into conversation history (reuse existing function)
    let conversation_history = format_messages_for_summary(&messages);

    // Build digest prompt
    let prompt = SESSION_DIGEST_PROMPT.replace("{conversation}", &conversation_history);

    // Call Claude CLI with JSON schema (non-streaming)
    execute_digest_claude(&app, &prompt, &prefs.session_recap_model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_text_from_stream_json_text_only() {
        let output =
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Hello world");
    }

    #[test]
    fn test_extract_text_from_stream_json_structured_output() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Processing..."},{"type":"tool_use","id":"toolu_123","name":"StructuredOutput","input":{"summary":"Test summary","slug":"test-slug"}}]}}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        let json = result.unwrap();
        // Structured output takes priority
        assert!(json.contains("summary"));
        assert!(json.contains("Test summary"));
    }

    #[test]
    fn test_extract_text_from_stream_json_multiline() {
        let output = r#"{"type":"system","data":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Line 1"}]}}
{"type":"result","result":"Final"}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        // Text from assistant message
        assert_eq!(result.unwrap(), "Line 1");
    }

    #[test]
    fn test_extract_text_from_stream_json_result_fallback() {
        let output = r#"{"type":"result","result":"Result text"}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Result text");
    }

    #[test]
    fn test_extract_text_from_stream_json_empty() {
        let result = extract_text_from_stream_json("");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No text content"));
    }

    #[test]
    fn test_extract_text_from_stream_json_no_content() {
        let output = r#"{"type":"system","data":"processing"}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_text_from_stream_json_skips_malformed() {
        let output = r#"not json
{"type":"assistant","message":{"content":[{"type":"text","text":"Valid"}]}}
also not json"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Valid");
    }

    #[test]
    fn test_extract_text_from_stream_json_concatenates_text() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "},{"type":"text","text":"World"}]}}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Hello World");
    }

    #[test]
    fn test_extract_text_from_stream_json_ignores_other_tools() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file":"/test.txt"}},{"type":"text","text":"After tool"}]}}"#;

        let result = extract_text_from_stream_json(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "After tool");
    }
}
