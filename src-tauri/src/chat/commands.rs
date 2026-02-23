use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::naming::{spawn_naming_task, NamingRequest};
use super::registry::cancel_process;
use super::run_log;
use super::storage::{
    delete_session_data, get_base_index_path, get_data_dir, get_index_path, get_session_dir,
    load_metadata, load_sessions, with_sessions_mut,
};
use super::types::{
    AllSessionsEntry, AllSessionsResponse, Backend, ChatMessage, ClaudeContext, EffortLevel,
    LabelData, MessageRole, RunStatus, Session, SessionDigest, ThinkingLevel, WorktreeIndex,
    WorktreeSessions,
};
use crate::claude_cli::resolve_cli_binary;
use crate::http_server::EmitExt;
use crate::platform::silent_command;
use crate::projects::github_issues::{
    add_issue_reference, add_pr_reference, get_session_issue_refs, get_session_pr_refs,
};
use crate::projects::storage::load_projects_data;
use crate::projects::types::SessionType;

/// Resolve the default backend from preferences + project settings (sync).
/// Falls back to Claude if preferences can't be loaded.
pub(crate) fn resolve_default_backend(app: &AppHandle, worktree_id: Option<&str>) -> Backend {
    // Read preferences file synchronously (avoid async in sync contexts)
    let prefs_backend = crate::get_preferences_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<crate::AppPreferences>(&contents).ok())
        .map(|p| p.default_backend)
        .unwrap_or_else(|| "claude".to_string());

    let mut resolved = match prefs_backend.as_str() {
        "codex" => Backend::Codex,
        "opencode" => Backend::Opencode,
        _ => Backend::Claude,
    };

    // Check project-level override if worktree_id is provided
    if let Some(wt_id) = worktree_id {
        if let Ok(data) = load_projects_data(app) {
            if let Some(project) = data.projects.iter().find(|p| {
                !p.is_folder
                    && data
                        .worktrees
                        .iter()
                        .any(|w| w.id == wt_id && w.project_id == p.id)
            }) {
                if let Some(ref pb) = project.default_backend {
                    resolved = match pb.as_str() {
                        "codex" => Backend::Codex,
                        "opencode" => Backend::Opencode,
                        "claude" => Backend::Claude,
                        _ => resolved,
                    };
                }
            }
        }
    }

    resolved
}

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

    // Debug logging for session recovery
    for session in &sessions.sessions {
        log::trace!(
            "get_sessions: session={}, last_run_status={:?}, last_run_mode={:?}",
            session.id,
            session.last_run_status,
            session.last_run_execution_mode
        );
        if session.enabled_mcp_servers.is_some() {
            log::debug!(
                "get_sessions: session={}, enabled_mcp_servers={:?}",
                session.id,
                session.enabled_mcp_servers
            );
        }
    }

    // Propagate issue/PR references from worktree_id to session IDs
    // (create_worktree stores refs under worktree_id, but toolbar queries by session_id)
    let worktree_issue_keys = get_session_issue_refs(&app, &worktree_id).unwrap_or_default();
    let worktree_pr_keys = get_session_pr_refs(&app, &worktree_id).unwrap_or_default();

    if !worktree_issue_keys.is_empty() || !worktree_pr_keys.is_empty() {
        for session in &sessions.sessions {
            let session_issues = get_session_issue_refs(&app, &session.id).unwrap_or_default();
            let session_prs = get_session_pr_refs(&app, &session.id).unwrap_or_default();

            if session_issues.is_empty() && !worktree_issue_keys.is_empty() {
                for key in &worktree_issue_keys {
                    if let Some(number_str) = key.rsplit('-').next() {
                        if let Ok(number) = number_str.parse::<u32>() {
                            let repo_key = &key[..key.len() - number_str.len() - 1];
                            let _ = add_issue_reference(&app, repo_key, number, &session.id);
                        }
                    }
                }
            }
            if session_prs.is_empty() && !worktree_pr_keys.is_empty() {
                for key in &worktree_pr_keys {
                    if let Some(number_str) = key.rsplit('-').next() {
                        if let Ok(number) = number_str.parse::<u32>() {
                            let repo_key = &key[..key.len() - number_str.len() - 1];
                            let _ = add_pr_reference(&app, repo_key, number, &session.id);
                        }
                    }
                }
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
    backend: Option<String>,
) -> Result<Session, String> {
    log::trace!("Creating new session for worktree: {worktree_id}");

    // Resolve backend: explicit param → project default → global preference → Claude
    let backend_enum = match backend.as_deref() {
        Some("codex") => Backend::Codex,
        Some("opencode") => Backend::Opencode,
        Some("claude") => Backend::Claude,
        _ => {
            // No explicit backend — check project default, then global preference
            let mut resolved = Backend::Claude;
            if let Ok(prefs) = crate::load_preferences(app.clone()).await {
                if prefs.default_backend == "codex" {
                    resolved = Backend::Codex;
                } else if prefs.default_backend == "opencode" {
                    resolved = Backend::Opencode;
                }
            }
            // Check project-level override
            if let Ok(data) = crate::projects::storage::load_projects_data(&app) {
                // Find project that owns this worktree path
                if let Some(project) = data.projects.iter().find(|p| {
                    // Match by worktree's project (worktree_id → project)
                    !p.is_folder
                        && data
                            .worktrees
                            .iter()
                            .any(|w| w.id == worktree_id && w.project_id == p.id)
                }) {
                    if let Some(ref pb) = project.default_backend {
                        resolved = match pb.as_str() {
                            "codex" => Backend::Codex,
                            "opencode" => Backend::Opencode,
                            "claude" => Backend::Claude,
                            _ => resolved,
                        };
                    }
                }
            }
            resolved
        }
    };

    let session = with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        // Generate name if not provided
        let session_number = sessions.next_session_number();
        let session_name = name.unwrap_or_else(|| format!("Session {session_number}"));

        let session = Session::new(
            session_name,
            sessions.sessions.len() as u32,
            backend_enum.clone(),
        );
        let session_id = session.id.clone();

        sessions.sessions.push(session.clone());
        sessions.active_session_id = Some(session_id);

        log::trace!("Created session: {}", session.id);
        Ok(session)
    })?;

    // Copy issue/PR context references from worktree_id to new session_id
    // (worktree creation stores refs under worktree_id, but toolbar queries by session_id)
    if let Ok(issue_keys) = get_session_issue_refs(&app, &worktree_id) {
        for key in &issue_keys {
            if let Some(number_str) = key.rsplit('-').next() {
                if let Ok(number) = number_str.parse::<u32>() {
                    let repo_key = &key[..key.len() - number_str.len() - 1];
                    let _ = add_issue_reference(&app, repo_key, number, &session.id);
                }
            }
        }
    }
    if let Ok(pr_keys) = get_session_pr_refs(&app, &worktree_id) {
        for key in &pr_keys {
            if let Some(number_str) = key.rsplit('-').next() {
                if let Ok(number) = number_str.parse::<u32>() {
                    let repo_key = &key[..key.len() - number_str.len() - 1];
                    let _ = add_pr_reference(&app, repo_key, number, &session.id);
                }
            }
        }
    }

    Ok(session)
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

/// Regenerate session name using AI based on the first user message
#[tauri::command]
pub async fn regenerate_session_name(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    custom_prompt: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
) -> Result<(), String> {
    log::trace!("Regenerating session name for {session_id}");

    // Load messages from NDJSON (load_sessions returns empty messages)
    let messages = run_log::load_session_messages(&app, &session_id)?;

    // Find the first user message to use for naming
    let first_message = messages
        .iter()
        .find(|m| m.role == MessageRole::User)
        .map(|m| m.content.clone())
        .ok_or_else(|| "No user messages in session to generate name from".to_string())?;

    let naming_model = model.unwrap_or_else(|| "haiku".to_string());

    let request = NamingRequest {
        session_id,
        worktree_id,
        worktree_path: std::path::PathBuf::from(&worktree_path),
        first_message,
        model: naming_model,
        existing_branch_names: Vec::new(),
        generate_session_name: true,
        generate_branch_name: false,
        custom_session_prompt: custom_prompt,
        custom_profile_name,
    };

    spawn_naming_task(app, request);
    Ok(())
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
    waiting_for_input_type: Option<Option<String>>,
    plan_file_path: Option<Option<String>>,
    pending_plan_message_id: Option<Option<String>>,
    label: Option<Option<LabelData>>,
    clear_label: Option<bool>,
    review_results: Option<Option<serde_json::Value>>,
    enabled_mcp_servers: Option<Option<Vec<String>>>,
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
            if let Some(v) = waiting_for_input_type {
                session.waiting_for_input_type = v;
            }
            if let Some(v) = plan_file_path {
                session.plan_file_path = v;
            }
            if let Some(v) = pending_plan_message_id {
                session.pending_plan_message_id = v;
            }
            if let Some(v) = label {
                session.label = v;
            }
            if let Some(clear) = clear_label {
                if clear {
                    session.label = None;
                }
            }
            if let Some(v) = review_results {
                session.review_results = v;
            }
            if let Some(v) = enabled_mcp_servers {
                log::debug!("Saving session MCP servers: {v:?} for session {session_id}");
                session.enabled_mcp_servers = v;
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

    // Clean up context references for this session
    if let Err(e) =
        crate::projects::github_issues::cleanup_issue_contexts_for_session(&app, &session_id)
    {
        log::warn!("Failed to cleanup issue/PR contexts for session: {e}");
    }
    if let Err(e) =
        crate::projects::saved_contexts::cleanup_saved_contexts_for_session(&app, &session_id)
    {
        log::warn!("Failed to cleanup saved contexts for session: {e}");
    }

    // Resolve default backend for fallback session creation
    let fallback_backend = resolve_default_backend(&app, Some(&worktree_id));

    // Now atomically modify the sessions file
    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        // Remove the session
        sessions.sessions.retain(|s| s.id != session_id);

        // Clear active if the closed session was active (frontend will set the new active)
        if sessions.active_session_id.as_deref() == Some(&session_id) {
            sessions.active_session_id = None;
        }

        // Ensure at least one session exists
        if sessions.sessions.is_empty() {
            let default_session = Session::default_session_with_backend(fallback_backend.clone());
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

    // Resolve default backend for fallback session creation
    let fallback_backend = resolve_default_backend(&app, Some(&worktree_id));

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
            let default_session = Session::default_session_with_backend(fallback_backend.clone());
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
        issue_number: None,
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
        cached_unpushed_count: None,
        order: 0,
        archived_at: None,
    };

    projects_data.add_worktree(new_worktree.clone());
    crate::projects::storage::save_projects_data(&app, &projects_data)?;

    // Restore preserved base sessions file (base-{project_id}.json -> {new_worktree_id}.json)
    // This is needed because close_base_session_archive renamed the index file
    let _restored_index =
        crate::chat::storage::restore_base_sessions(&app, &project_id, &new_worktree.id)?;

    // Atomically unarchive the target session within the restored sessions
    let restored_session = with_sessions_mut(&app, &worktree_path, &new_worktree.id, |sessions| {
        let session = sessions
            .find_session_mut(&session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;

        if session.archived_at.is_none() {
            return Err("Session is not archived".to_string());
        }

        session.archived_at = None;
        Ok(session.clone())
    })?;

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

    // Delete session data directory (outside lock - separate directory)
    if let Err(e) = delete_session_data(&app, &session_id) {
        log::warn!("Failed to delete session data: {e}");
    }

    // Clean up context references
    if let Err(e) =
        crate::projects::github_issues::cleanup_issue_contexts_for_session(&app, &session_id)
    {
        log::warn!("Failed to cleanup issue/PR contexts for session: {e}");
    }
    if let Err(e) =
        crate::projects::saved_contexts::cleanup_saved_contexts_for_session(&app, &session_id)
    {
        log::warn!("Failed to cleanup saved contexts for session: {e}");
    }

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

        // Also check preserved base session files (base-{project_id}.json)
        // These are created when a base session is closed with archiving
        if let Ok(base_path) = get_base_index_path(&app, &project.id) {
            if base_path.exists() {
                if let Ok(contents) = std::fs::read_to_string(&base_path) {
                    if let Ok(index) = serde_json::from_str::<WorktreeIndex>(&contents) {
                        for entry in &index.sessions {
                            if entry.archived_at.is_some() {
                                // Load full session metadata
                                let session =
                                    if let Ok(Some(metadata)) = load_metadata(&app, &entry.id) {
                                        let mut s = metadata.to_session();
                                        // Ensure archived_at from index is preserved
                                        if s.archived_at.is_none() {
                                            s.archived_at = entry.archived_at;
                                        }
                                        s
                                    } else {
                                        // No metadata — build a minimal Session from index entry
                                        let mut s = Session::new(
                                            entry.name.clone(),
                                            entry.order,
                                            Backend::default(),
                                        );
                                        s.id = entry.id.clone();
                                        s.message_count = Some(entry.message_count);
                                        s.archived_at = entry.archived_at;
                                        s
                                    };

                                entries.push(ArchivedSessionEntry {
                                    session,
                                    worktree_id: index.worktree_id.clone(),
                                    worktree_name: format!("{} (base)", project.name),
                                    worktree_path: project.path.clone(),
                                    project_id: project.id.clone(),
                                    project_name: project.name.clone(),
                                });
                            }
                        }
                    }
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
    effort_level: Option<EffortLevel>,
    parallel_execution_prompt: Option<String>,
    ai_language: Option<String>,
    allowed_tools: Option<Vec<String>>,
    mcp_config: Option<String>,
    chrome_enabled: Option<bool>,
    custom_profile_name: Option<String>,
    backend: Option<String>,
) -> Result<ChatMessage, String> {
    log::trace!("Sending chat message for session: {session_id}, worktree: {worktree_id}, model: {model:?}, execution_mode: {execution_mode:?}, thinking: {thinking_level:?}, effort: {effort_level:?}, allowed_tools: {allowed_tools:?}");

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

                let custom_session_prompt = if generate_session {
                    prefs.magic_prompts.session_naming.clone()
                } else {
                    None
                };

                let request = NamingRequest {
                    session_id: session_id.clone(),
                    worktree_id: worktree_id.clone(),
                    worktree_path: PathBuf::from(&worktree_path),
                    first_message: message.clone(),
                    model: prefs.magic_prompt_models.session_naming_model.clone(),
                    existing_branch_names: existing_names,
                    generate_session_name: generate_session,
                    generate_branch_name: generate_branch,
                    custom_session_prompt,
                    // Keep provider semantics consistent with manual regeneration:
                    // session_naming_provider = None means Anthropic (no custom profile),
                    // not fallback to global default_provider.
                    custom_profile_name: prefs
                        .magic_prompt_providers
                        .session_naming_provider
                        .clone(),
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

    // Notify all clients that a message is being sent (for real-time sync)
    if let Err(e) = app.emit_all(
        "chat:sending",
        &serde_json::json!({
            "session_id": session_id,
            "worktree_id": worktree_id,
        }),
    ) {
        log::error!("Failed to emit chat:sending event: {e}");
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

            let error_event = super::claude::ErrorEvent {
                session_id: session_id.clone(),
                worktree_id: worktree_id.clone(),
                error: "Session not found. Please refresh the page or create a new session."
                    .to_string(),
            };
            if let Err(e) = app.emit_all("chat:error", &error_event) {
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

    // Determine backend from session (or explicit param, or default to claude)
    let session_backend = sessions
        .find_session(&session_id)
        .map(|s| s.backend.clone())
        .unwrap_or_default();
    let effective_backend = match backend.as_deref() {
        Some("codex") => Backend::Codex,
        Some("opencode") => Backend::Opencode,
        Some("claude") => Backend::Claude,
        _ => session_backend,
    };
    // Override backend based on model string (safety net: model always wins)
    let effective_backend = if let Some(ref m) = model {
        if crate::is_opencode_model(m) {
            Backend::Opencode
        } else if crate::is_codex_model(m) {
            Backend::Codex
        } else {
            effective_backend
        }
    } else {
        effective_backend
    };

    // Build context for Claude
    let context = ClaudeContext::new(worktree_path.clone());

    // Get the session IDs for resumption
    let claude_session_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.claude_session_id.clone());
    let codex_thread_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.codex_thread_id.clone());
    let opencode_session_id = sessions
        .find_session(&session_id)
        .and_then(|s| s.opencode_session_id.clone());

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
        effort_level
            .as_ref()
            .and_then(|e| e.effort_value())
            .or(None),
    )?;

    // Get file paths for detached execution
    let input_file = run_log_writer.input_file_path()?;
    let output_file = run_log_writer.output_file_path()?;
    let run_id = run_log_writer.run_id().to_string();

    // Write input file with the user message
    run_log::write_input_file(&app, &session_id, &run_id, &message)?;

    // Use passed parameter for parallel execution prompt (None = disabled)
    let parallel_execution_prompt = parallel_execution_prompt.filter(|p| !p.trim().is_empty());

    // Use passed parameter for Chrome browser integration (default false - beta)
    let chrome = chrome_enabled.unwrap_or(false);

    // Inject web tools in plan mode if preference is enabled
    // Claude: add WebFetch/WebSearch to allowed tools
    // Codex: set search_enabled flag for --search
    let mut final_allowed_tools = allowed_tools.unwrap_or_default();
    let mut codex_search_enabled = false;
    let mut codex_multi_agent_enabled = false;
    let mut codex_max_agent_threads: Option<u32> = None;
    if execution_mode.as_deref() == Some("plan") {
        if let Ok(prefs) = crate::load_preferences(app.clone()).await {
            if prefs.allow_web_tools_in_plan_mode {
                match effective_backend {
                    Backend::Claude => {
                        final_allowed_tools.push("WebFetch".to_string());
                        final_allowed_tools.push("WebSearch".to_string());
                    }
                    Backend::Codex => {
                        codex_search_enabled = true;
                    }
                    Backend::Opencode => {}
                }
            }
        }
    }
    // Read Codex multi-agent preferences
    if effective_backend == Backend::Codex {
        if let Ok(prefs) = crate::load_preferences(app.clone()).await {
            codex_multi_agent_enabled = prefs.codex_multi_agent_enabled;
            if codex_multi_agent_enabled {
                codex_max_agent_threads = Some(prefs.codex_max_agent_threads.clamp(1, 8));
            }
        }
    }
    let allowed_tools_for_cli = if final_allowed_tools.is_empty() {
        None
    } else {
        Some(final_allowed_tools)
    };

    // Unified response type for both backends
    struct UnifiedResponse {
        content: String,
        /// Claude session ID or Codex thread ID (for resumption)
        resume_id: String,
        tool_calls: Vec<super::types::ToolCall>,
        content_blocks: Vec<super::types::ContentBlock>,
        cancelled: bool,
        /// Whether a chat:error event was emitted during execution
        error_emitted: bool,
        usage: Option<super::types::UsageData>,
        backend: Backend,
    }

    // Execute CLI in detached mode on a dedicated OS thread.
    // This prevents tokio thread pool starvation when many sessions run concurrently.
    let thread_app = app.clone();
    let thread_session_id = session_id.clone();
    let thread_worktree_id = worktree_id.clone();
    let thread_worktree_path = worktree_path.clone();
    let thread_input_file = input_file.clone();
    let thread_output_file = output_file.clone();
    let thread_working_dir = context.worktree_path.clone();
    let thread_claude_session_id = claude_session_id.clone();
    let thread_codex_thread_id = codex_thread_id.clone();
    let thread_opencode_session_id = opencode_session_id.clone();
    let thread_model = model.clone();
    let thread_execution_mode = execution_mode.clone();
    let thread_thinking_level = thinking_level.clone();
    let thread_effort_level = effort_level.clone();
    let thread_allowed_tools = allowed_tools_for_cli.clone();
    let thread_parallel_prompt = parallel_execution_prompt.clone();
    let thread_ai_language = ai_language.clone();
    let thread_mcp_config = mcp_config.clone();
    let thread_custom_profile = custom_profile_name.clone();
    let thread_message = message.clone();
    let thread_backend = effective_backend.clone();
    let thread_codex_search = codex_search_enabled;
    let thread_codex_multi_agent = codex_multi_agent_enabled;
    let thread_codex_max_threads = codex_max_agent_threads;

    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let result: Result<(u32, UnifiedResponse), String> = match thread_backend {
            Backend::Claude => {
                // === Claude execution path (unchanged) ===
                let mut claude_session_id_for_call = thread_claude_session_id;
                let result = loop {
                    log::trace!("About to call execute_claude_detached...");

                    match super::claude::execute_claude_detached(
                        &thread_app,
                        &thread_session_id,
                        &thread_worktree_id,
                        &thread_input_file,
                        &thread_output_file,
                        std::path::Path::new(&thread_working_dir),
                        claude_session_id_for_call.as_deref(),
                        thread_model.as_deref(),
                        thread_execution_mode.as_deref(),
                        thread_thinking_level.as_ref(),
                        thread_effort_level.as_ref(),
                        thread_allowed_tools.as_deref(),
                        thread_parallel_prompt.as_deref(),
                        thread_ai_language.as_deref(),
                        thread_mcp_config.as_deref(),
                        chrome,
                        thread_custom_profile.as_deref(),
                    ) {
                        Ok((pid, response)) => {
                            log::trace!("execute_claude_detached succeeded (PID: {pid})");

                            if response.content.is_empty()
                                && response.usage.is_none()
                                && claude_session_id_for_call.is_some()
                            {
                                log::warn!(
                                    "Empty response while resuming session {}, clearing stale session ID",
                                    claude_session_id_for_call.as_deref().unwrap_or("")
                                );
                                let _ = with_sessions_mut(
                                    &thread_app,
                                    &thread_worktree_path,
                                    &thread_worktree_id,
                                    |sessions| {
                                        if let Some(session) =
                                            sessions.find_session_mut(&thread_session_id)
                                        {
                                            session.claude_session_id = None;
                                        }
                                        Ok(())
                                    },
                                );
                            }

                            break Ok((
                                pid,
                                UnifiedResponse {
                                    content: response.content,
                                    resume_id: response.session_id,
                                    tool_calls: response.tool_calls,
                                    content_blocks: response.content_blocks,
                                    cancelled: response.cancelled,
                                    error_emitted: false,
                                    usage: response.usage,
                                    backend: Backend::Claude,
                                },
                            ));
                        }
                        Err(e) => {
                            let is_session_not_found = e.to_lowercase().contains("session")
                                && (e.to_lowercase().contains("not found")
                                    || e.to_lowercase().contains("invalid")
                                    || e.to_lowercase().contains("expired"));

                            if is_session_not_found && claude_session_id_for_call.is_some() {
                                log::warn!(
                                    "Session not found, clearing stored session ID and retrying: {}",
                                    claude_session_id_for_call.as_deref().unwrap_or("")
                                );
                                match with_sessions_mut(
                                    &thread_app,
                                    &thread_worktree_path,
                                    &thread_worktree_id,
                                    |sessions| {
                                        if let Some(session) =
                                            sessions.find_session_mut(&thread_session_id)
                                        {
                                            session.claude_session_id = None;
                                        }
                                        Ok(())
                                    },
                                ) {
                                    Ok(_) => {
                                        claude_session_id_for_call = None;
                                        continue;
                                    }
                                    Err(e) => {
                                        break Err(format!(
                                            "Session expired and failed to clear stale session state: {e}"
                                        ));
                                    }
                                }
                            }

                            log::error!("execute_claude_detached FAILED: {e}");
                            break Err(e);
                        }
                    }
                };
                result
            }
            Backend::Codex => {
                // === Codex execution path ===
                log::trace!("About to call execute_codex_detached...");

                // Map EffortLevel to Codex reasoning effort values
                let codex_reasoning_effort: Option<String> =
                    thread_effort_level.as_ref().and_then(|e| match e {
                        super::types::EffortLevel::Low => Some("low".to_string()),
                        super::types::EffortLevel::Medium => Some("medium".to_string()),
                        super::types::EffortLevel::High => Some("high".to_string()),
                        super::types::EffortLevel::Max => Some("xhigh".to_string()),
                        super::types::EffortLevel::Off => None,
                    });

                // Build add_dirs for Codex
                let mut codex_add_dirs = Vec::new();
                if let Ok(app_data_dir) = thread_app.path().app_data_dir() {
                    if cfg!(debug_assertions) {
                        codex_add_dirs.push(app_data_dir.to_string_lossy().to_string());
                    } else {
                        for subdir in [
                            "pasted-images",
                            "pasted-texts",
                            "session-context",
                            "git-context",
                            "combined-contexts",
                        ] {
                            codex_add_dirs
                                .push(app_data_dir.join(subdir).to_string_lossy().to_string());
                        }
                        codex_add_dirs.push(
                            app_data_dir
                                .join("runs")
                                .join(&thread_session_id)
                                .to_string_lossy()
                                .to_string(),
                        );
                    }
                }
                if let Some(home) = dirs::home_dir() {
                    let codex_skills_dir = home.join(".codex").join("skills");
                    if codex_skills_dir.exists() {
                        codex_add_dirs.push(codex_skills_dir.to_string_lossy().to_string());
                    }
                }

                // Build combined instructions file (system prompt equivalent for Codex)
                let codex_instructions_file = {
                    use crate::projects::github_issues::{
                        get_github_contexts_dir, get_session_issue_refs, get_session_pr_refs,
                    };
                    use crate::projects::storage::load_projects_data;

                    const DEFAULT_GLOBAL_SYSTEM_PROMPT: &str = "\
## Plan Mode\n\
\n\
- Make the plan extremely concise. Sacrifice grammar for the sake of concision.\n\
- At the end of each plan, give me a list of unresolved questions to answer, if any.\n\
\n\
## Not Plan Mode\n\
\n\
- After each finished task, please write a few bullet points on how to test the changes.\n\
- When multiple independent operations are needed, batch them into parallel tool calls. Launch independent Task subagents simultaneously rather than sequentially.\n\
- When specifying subagent_type for Task tool calls, always use the fully qualified name exactly as listed in the system prompt (e.g., \"code-simplifier:code-simplifier\", not just \"code-simplifier\"). If the agent type contains a colon, include the full namespace:name string.";

                    let mut system_prompt_parts: Vec<String> = Vec::new();

                    // Codex plan mode: inject planning-only instructions
                    if thread_execution_mode.as_deref() == Some("plan") {
                        system_prompt_parts.push(
                            "You are in PLANNING MODE (read-only sandbox). Create a detailed implementation plan. \
                             Do NOT attempt to make any file changes — you are running in a read-only sandbox and writes will fail. \
                             Describe exactly what changes you WOULD make: which files to create/modify, \
                             what code to write, and in what order. End with any unresolved questions."
                                .to_string(),
                        );
                    }

                    // AI language preference
                    if let Some(lang) = &thread_ai_language {
                        let lang = lang.trim();
                        if !lang.is_empty() {
                            system_prompt_parts.push(format!("Respond to the user in {lang}."));
                        }
                    }

                    // Global system prompt from preferences
                    if let Ok(prefs_path) = crate::get_preferences_path(&thread_app) {
                        if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                            if let Ok(prefs) =
                                serde_json::from_str::<crate::AppPreferences>(&contents)
                            {
                                let prompt = prefs
                                    .magic_prompts
                                    .global_system_prompt
                                    .as_deref()
                                    .map(|s| s.trim())
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or(DEFAULT_GLOBAL_SYSTEM_PROMPT);
                                system_prompt_parts.push(prompt.to_string());
                            }
                        }
                    }

                    // Parallel execution prompt
                    if let Some(prompt) = &thread_parallel_prompt {
                        let prompt = prompt.trim();
                        if !prompt.is_empty() {
                            system_prompt_parts.push(prompt.to_string());
                        }
                    }

                    // Per-project custom system prompt
                    if let Ok(data) = load_projects_data(&thread_app) {
                        if let Some(worktree) = data.find_worktree(&thread_worktree_id) {
                            if let Some(project) = data.find_project(&worktree.project_id) {
                                if let Some(prompt) = &project.custom_system_prompt {
                                    let prompt = prompt.trim();
                                    if !prompt.is_empty() {
                                        system_prompt_parts.push(prompt.to_string());
                                    }
                                }
                            }
                        }
                    }

                    // Embedded binary path hints
                    let gh_binary = crate::gh_cli::config::resolve_gh_binary(&thread_app);
                    if gh_binary != std::path::PathBuf::from("gh") {
                        system_prompt_parts.push(format!(
                            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
                             Do NOT use bare `gh` — always use the full path above.",
                            gh_binary.display()
                        ));
                    }
                    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(&thread_app) {
                        if claude_binary.exists() {
                            system_prompt_parts.push(format!(
                                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `claude` — always use the full path above.",
                                claude_binary.display()
                            ));
                        }
                    }
                    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(&thread_app) {
                        if codex_binary.exists() {
                            system_prompt_parts.push(format!(
                                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `codex` — always use the full path above.",
                                codex_binary.display()
                            ));
                        }
                    }

                    // Collect context file paths (issues, PRs, saved contexts)
                    let mut all_context_paths: Vec<std::path::PathBuf> = Vec::new();

                    let mut issue_keys =
                        get_session_issue_refs(&thread_app, &thread_session_id).unwrap_or_default();
                    if let Ok(wt_keys) = get_session_issue_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !issue_keys.contains(&key) {
                                issue_keys.push(key);
                            }
                        }
                    }
                    if !issue_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &issue_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path =
                                        contexts_dir.join(format!("{repo_key}-issue-{number}.md"));
                                    if file_path.exists() {
                                        all_context_paths.push(file_path);
                                    }
                                }
                            }
                        }
                    }

                    let mut pr_keys =
                        get_session_pr_refs(&thread_app, &thread_session_id).unwrap_or_default();
                    if let Ok(wt_keys) = get_session_pr_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !pr_keys.contains(&key) {
                                pr_keys.push(key);
                            }
                        }
                    }
                    if !pr_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &pr_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path =
                                        contexts_dir.join(format!("{repo_key}-pr-{number}.md"));
                                    if file_path.exists() {
                                        all_context_paths.push(file_path);
                                    }
                                }
                            }
                        }
                    }

                    // Saved context files
                    if let Ok(app_data_dir) = thread_app.path().app_data_dir() {
                        let saved_contexts_dir = app_data_dir.join("session-context");
                        if saved_contexts_dir.exists() {
                            let prefix = format!("{}-context-", thread_session_id);
                            if let Ok(entries) = std::fs::read_dir(&saved_contexts_dir) {
                                let mut context_files: Vec<_> = entries
                                    .flatten()
                                    .filter(|entry| {
                                        let name = entry.file_name().to_string_lossy().to_string();
                                        name.starts_with(&prefix) && name.ends_with(".md")
                                    })
                                    .collect();
                                context_files.sort_by_key(|e| e.file_name());
                                for entry in context_files {
                                    all_context_paths.push(entry.path());
                                }
                            }
                        }
                    }

                    // Write combined instructions file if we have anything
                    if !system_prompt_parts.is_empty() || !all_context_paths.is_empty() {
                        if let Ok(app_data_dir) = thread_app.path().app_data_dir() {
                            let combined_dir = app_data_dir.join("combined-contexts");
                            let _ = std::fs::create_dir_all(&combined_dir);
                            let combined_file = combined_dir
                                .join(format!("{}-codex-combined.md", thread_session_id));

                            let mut content = String::new();

                            if !system_prompt_parts.is_empty() {
                                content.push_str("# Instructions\n\n");
                                for part in &system_prompt_parts {
                                    content.push_str(part);
                                    content.push('\n');
                                }
                                content.push_str("\n---\n\n");
                            }

                            if !all_context_paths.is_empty() {
                                content.push_str("# Loaded Context\n\n");
                                content.push_str(
                                    "The following context has been loaded. \
                                     You should be aware of this when working on this task.\n\n---\n\n",
                                );
                                for path in &all_context_paths {
                                    if let Ok(file_content) = std::fs::read_to_string(path) {
                                        content.push_str(&file_content);
                                        content.push_str("\n\n---\n\n");
                                    }
                                }
                            }

                            match std::fs::write(&combined_file, &content) {
                                Ok(_) => {
                                    log::debug!(
                                        "Created Codex instructions file: {:?}",
                                        combined_file
                                    );
                                    Some(combined_file)
                                }
                                Err(e) => {
                                    log::error!("Failed to write Codex instructions file: {e}");
                                    None
                                }
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                // For Codex: first message uses positional arg, resume pipes via stdin
                let prompt = Some(thread_message.as_str());

                match super::codex::execute_codex_detached(
                    &thread_app,
                    &thread_session_id,
                    &thread_worktree_id,
                    &thread_output_file,
                    std::path::Path::new(&thread_working_dir),
                    thread_codex_thread_id.as_deref(),
                    thread_model.as_deref(),
                    thread_execution_mode.as_deref(),
                    codex_reasoning_effort.as_deref(),
                    thread_codex_search,
                    &codex_add_dirs,
                    prompt,
                    codex_instructions_file.as_deref(),
                    thread_codex_multi_agent,
                    thread_codex_max_threads,
                ) {
                    Ok((pid, response)) => Ok((
                        pid,
                        UnifiedResponse {
                            content: response.content,
                            resume_id: response.thread_id,
                            tool_calls: response.tool_calls,
                            content_blocks: response.content_blocks,
                            cancelled: response.cancelled,
                            error_emitted: response.error_emitted,
                            usage: response.usage,
                            backend: Backend::Codex,
                        },
                    )),
                    Err(e) => {
                        log::error!("execute_codex_detached FAILED: {e}");
                        Err(e)
                    }
                }
            }
            Backend::Opencode => {
                log::trace!("About to call execute_opencode...");
                let opencode_reasoning_effort: Option<String> =
                    thread_effort_level.as_ref().and_then(|e| match e {
                        super::types::EffortLevel::Low => Some("low".to_string()),
                        super::types::EffortLevel::Medium => Some("medium".to_string()),
                        super::types::EffortLevel::High => Some("high".to_string()),
                        super::types::EffortLevel::Max => Some("xhigh".to_string()),
                        super::types::EffortLevel::Off => None,
                    });

                let system_prompt = {
                    use crate::projects::github_issues::{
                        get_github_contexts_dir, get_session_issue_refs, get_session_pr_refs,
                    };
                    use crate::projects::storage::load_projects_data;

                    let mut system_prompt_parts: Vec<String> = Vec::new();

                    // AI language preference
                    if let Some(lang) = &thread_ai_language {
                        let lang = lang.trim();
                        if !lang.is_empty() {
                            system_prompt_parts.push(format!("Respond to the user in {lang}."));
                        }
                    }

                    // Global system prompt from preferences
                    if let Ok(prefs_path) = crate::get_preferences_path(&thread_app) {
                        if let Ok(contents) = std::fs::read_to_string(&prefs_path) {
                            if let Ok(prefs) =
                                serde_json::from_str::<crate::AppPreferences>(&contents)
                            {
                                if let Some(prompt) = prefs
                                    .magic_prompts
                                    .global_system_prompt
                                    .as_deref()
                                    .map(|s| s.trim())
                                    .filter(|s| !s.is_empty())
                                {
                                    system_prompt_parts.push(prompt.to_string());
                                }
                            }
                        }
                    }

                    // Parallel execution prompt
                    if let Some(prompt) = &thread_parallel_prompt {
                        let prompt = prompt.trim();
                        if !prompt.is_empty() {
                            system_prompt_parts.push(prompt.to_string());
                        }
                    }

                    // Per-project custom system prompt
                    if let Ok(data) = load_projects_data(&thread_app) {
                        if let Some(worktree) = data.find_worktree(&thread_worktree_id) {
                            if let Some(project) = data.find_project(&worktree.project_id) {
                                if let Some(prompt) = &project.custom_system_prompt {
                                    let prompt = prompt.trim();
                                    if !prompt.is_empty() {
                                        system_prompt_parts.push(prompt.to_string());
                                    }
                                }
                            }
                        }
                    }

                    // Embedded binary path hints
                    let gh_binary = crate::gh_cli::config::resolve_gh_binary(&thread_app);
                    if gh_binary != std::path::PathBuf::from("gh") {
                        system_prompt_parts.push(format!(
                            "When running GitHub CLI commands, use the full path to the embedded binary: {}\n\
                             Do NOT use bare `gh` — always use the full path above.",
                            gh_binary.display()
                        ));
                    }
                    if let Ok(claude_binary) = crate::claude_cli::get_cli_binary_path(&thread_app) {
                        if claude_binary.exists() {
                            system_prompt_parts.push(format!(
                                "When running Claude CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `claude` — always use the full path above.",
                                claude_binary.display()
                            ));
                        }
                    }
                    if let Ok(codex_binary) = crate::codex_cli::get_cli_binary_path(&thread_app) {
                        if codex_binary.exists() {
                            system_prompt_parts.push(format!(
                                "When running Codex CLI commands, use the full path to the embedded binary: {}\n\
                                 Do NOT use bare `codex` — always use the full path above.",
                                codex_binary.display()
                            ));
                        }
                    }

                    // Collect and inline context files (issues, PRs, saved contexts)
                    let mut context_content = String::new();

                    let mut issue_keys =
                        get_session_issue_refs(&thread_app, &thread_session_id).unwrap_or_default();
                    if let Ok(wt_keys) = get_session_issue_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !issue_keys.contains(&key) {
                                issue_keys.push(key);
                            }
                        }
                    }
                    if !issue_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &issue_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path =
                                        contexts_dir.join(format!("{repo_key}-issue-{number}.md"));
                                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    let mut pr_keys =
                        get_session_pr_refs(&thread_app, &thread_session_id).unwrap_or_default();
                    if let Ok(wt_keys) = get_session_pr_refs(&thread_app, &thread_worktree_id) {
                        for key in wt_keys {
                            if !pr_keys.contains(&key) {
                                pr_keys.push(key);
                            }
                        }
                    }
                    if !pr_keys.is_empty() {
                        if let Ok(contexts_dir) = get_github_contexts_dir(&thread_app) {
                            for key in &pr_keys {
                                let parts: Vec<&str> = key.rsplitn(2, '-').collect();
                                if parts.len() == 2 {
                                    let number = parts[0];
                                    let repo_key = parts[1];
                                    let file_path =
                                        contexts_dir.join(format!("{repo_key}-pr-{number}.md"));
                                    if let Ok(content) = std::fs::read_to_string(&file_path) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    // Saved context files
                    if let Ok(app_data_dir) = thread_app.path().app_data_dir() {
                        let saved_contexts_dir = app_data_dir.join("session-context");
                        if saved_contexts_dir.exists() {
                            let prefix = format!("{}-context-", thread_session_id);
                            if let Ok(entries) = std::fs::read_dir(&saved_contexts_dir) {
                                let mut context_files: Vec<_> = entries
                                    .flatten()
                                    .filter(|entry| {
                                        let name = entry.file_name().to_string_lossy().to_string();
                                        name.starts_with(&prefix) && name.ends_with(".md")
                                    })
                                    .collect();
                                context_files.sort_by_key(|e| e.file_name());
                                for entry in context_files {
                                    if let Ok(content) = std::fs::read_to_string(entry.path()) {
                                        context_content.push_str(&content);
                                        context_content.push_str("\n\n---\n\n");
                                    }
                                }
                            }
                        }
                    }

                    // Build final system prompt
                    let mut final_prompt = String::new();
                    if !system_prompt_parts.is_empty() {
                        final_prompt.push_str(&system_prompt_parts.join("\n\n"));
                    }
                    if !context_content.is_empty() {
                        if !final_prompt.is_empty() {
                            final_prompt.push_str("\n\n---\n\n");
                        }
                        final_prompt.push_str("# Loaded Context\n\n");
                        final_prompt.push_str(
                            "The following context has been loaded. \
                             You should be aware of this when working on this task.\n\n---\n\n",
                        );
                        final_prompt.push_str(&context_content);
                    }

                    if final_prompt.is_empty() {
                        None
                    } else {
                        Some(final_prompt)
                    }
                };

                match super::opencode::execute_opencode_http(
                    &thread_app,
                    &thread_session_id,
                    &thread_worktree_id,
                    std::path::Path::new(&thread_working_dir),
                    thread_opencode_session_id.as_deref(),
                    thread_model.as_deref(),
                    thread_execution_mode.as_deref(),
                    opencode_reasoning_effort.as_deref(),
                    &thread_message,
                    system_prompt.as_deref(),
                ) {
                    Ok(response) => Ok((
                        std::process::id(),
                        UnifiedResponse {
                            content: response.content,
                            resume_id: response.session_id,
                            tool_calls: response.tool_calls,
                            content_blocks: response.content_blocks,
                            cancelled: response.cancelled,
                            error_emitted: false,
                            usage: response.usage,
                            backend: Backend::Opencode,
                        },
                    )),
                    Err(e) => {
                        log::error!("execute_opencode FAILED: {e}");
                        Err(e)
                    }
                }
            }
        };
        let _ = tx.send(result);
    });

    let (pid, unified_response) = rx.await.map_err(|_| {
        "CLI execution thread closed unexpectedly (possible crash or panic)".to_string()
    })??;

    // Store PID only for detached CLI runs (Claude/Codex). OpenCode is HTTP-based.
    if unified_response.backend != Backend::Opencode {
        run_log_writer.set_pid(pid)?;
    }

    // OpenCode runs are HTTP-based (no detached JSONL stream).
    // Write a synthetic assistant line so history reload can reconstruct content.
    if unified_response.backend == Backend::Opencode {
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&output_file) {
            let synthetic = serde_json::json!({
                "type": "assistant",
                "message": {
                    "content": [{
                        "type": "text",
                        "text": unified_response.content
                    }]
                }
            });
            let _ = writeln!(file, "{synthetic}");
            let _ = file.flush();
        }
    }

    // Clean up input file (no longer needed)
    if let Err(e) = run_log::delete_input_file(&app, &session_id, &run_id) {
        log::warn!("Failed to delete input file: {e}");
    }

    // Handle cancellation: only save if there's meaningful content (>10 chars) or tool calls
    // This avoids cluttering history with empty cancelled messages from instant cancellations
    let has_meaningful_content = unified_response.content.len() >= 10;
    let has_tool_calls = !unified_response.tool_calls.is_empty();
    let resume_id_for_log = unified_response.resume_id.clone();
    let response_backend = unified_response.backend.clone();

    // Handle error_emitted: backend emitted chat:error during execution (e.g., Codex usage limit).
    // Treat like undo_send so the user message doesn't persist in history.
    if unified_response.error_emitted {
        if let Err(e) = run_log_writer.cancel(None) {
            log::warn!("Failed to cancel run log after error: {e}");
        }
        log::trace!("Run cancelled after chat:error for session: {session_id}");
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
            effort_level: None,
            recovered: false,
            usage: None,
        });
    }

    if unified_response.cancelled && !has_meaningful_content && !has_tool_calls {
        // Instant cancellation with no content
        // Cancel the run log (no assistant message to save)
        if let Err(e) = run_log_writer.cancel(None) {
            log::warn!("Failed to cancel run log: {e}");
        }

        // Atomically update session (remove last user message for undo send)
        // NOTE: Do NOT persist claude_session_id here — a cancelled run with no content
        // means the CLI session is invalid/incomplete and would break future --resume
        with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            if let Some(session) = sessions.find_session_mut(&session_id) {
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
            effort_level: None,
            recovered: false,
            usage: None,
        });
    }

    // Create assistant message with tool calls and content blocks
    let has_content = !unified_response.content.is_empty();
    let assistant_msg_id = Uuid::new_v4().to_string();
    let assistant_msg = ChatMessage {
        id: assistant_msg_id.clone(),
        session_id: session_id.clone(),
        role: MessageRole::Assistant,
        content: unified_response.content,
        timestamp: now(),
        tool_calls: unified_response.tool_calls,
        content_blocks: unified_response.content_blocks,
        cancelled: unified_response.cancelled,
        plan_approved: false,
        model: None,
        execution_mode: None,
        thinking_level: None,
        effort_level: None,
        recovered: false,
        usage: unified_response.usage.clone(),
    };
    // Note: Assistant message is stored in NDJSON, not sessions JSON.
    // Messages are loaded from NDJSON on demand via load_session_messages().

    // Finalize run log (complete or cancel based on response status)
    if unified_response.cancelled {
        if let Err(e) = run_log_writer.cancel(Some(&assistant_msg_id)) {
            log::warn!("Failed to cancel run log: {e}");
        }
    } else {
        let resume_sid = if response_backend != Backend::Claude || resume_id_for_log.is_empty() {
            None
        } else {
            Some(resume_id_for_log.as_str())
        };
        if let Err(e) =
            run_log_writer.complete(&assistant_msg_id, resume_sid, unified_response.usage)
        {
            log::warn!("Failed to complete run log: {e}");
        }
    }

    // Atomically save session metadata (resume ID for session continuity)
    // Note: Messages are NOT saved here - they're in NDJSON only
    // Only persist if the run produced meaningful content
    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            if !resume_id_for_log.is_empty() && has_content {
                match response_backend {
                    Backend::Claude => {
                        session.claude_session_id = Some(resume_id_for_log.clone());
                    }
                    Backend::Codex => {
                        session.codex_thread_id = Some(resume_id_for_log.clone());
                    }
                    Backend::Opencode => {
                        session.opencode_session_id = Some(resume_id_for_log.clone());
                    }
                }
            }
        }
        Ok(())
    })?;

    // For Codex plan mode: persist waiting state so frontend shows plan approval UI
    if (response_backend == Backend::Codex || response_backend == Backend::Opencode)
        && execution_mode.as_deref() == Some("plan")
        && !unified_response.cancelled
        && has_content
    {
        let plan_session_id = session_id.clone();
        let plan_msg_id = assistant_msg_id.clone();
        with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
            if let Some(session) = sessions.find_session_mut(&plan_session_id) {
                session.waiting_for_input = true;
                session.waiting_for_input_type = Some("plan".to_string());
                session.pending_plan_message_id = Some(plan_msg_id);
            }
            Ok(())
        })?;
    }

    if unified_response.cancelled {
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
            let selected_provider = session.selected_provider.clone();

            session.messages.clear();
            session.claude_session_id = None;
            session.codex_thread_id = None;
            session.opencode_session_id = None;
            session.selected_model = selected_model;
            session.selected_thinking_level = selected_thinking_level;
            session.selected_provider = selected_provider;

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

/// Set the selected provider (custom CLI profile) for a session
#[tauri::command]
pub async fn set_session_provider(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    provider: Option<String>,
) -> Result<(), String> {
    log::trace!("Setting provider for session {session_id}: {provider:?}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.selected_provider = provider;
            log::trace!("Provider selection saved");
            Ok(())
        } else {
            Err(format!("Session not found: {session_id}"))
        }
    })
}

/// Set the backend for a session
#[tauri::command]
pub async fn set_session_backend(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    backend: String,
) -> Result<(), String> {
    log::trace!("Setting backend for session {session_id}: {backend}");

    with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
        if let Some(session) = sessions.find_session_mut(&session_id) {
            session.backend = match backend.as_str() {
                "codex" => super::types::Backend::Codex,
                "opencode" => super::types::Backend::Opencode,
                _ => super::types::Backend::Claude,
            };
            log::trace!("Backend selection saved");
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
            // Clear waiting state after approval
            session.waiting_for_input = false;
            session.pending_plan_message_id = None;
            session.waiting_for_input_type = None;
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

/// Max dimension per Claude's vision docs: images >1568px get downscaled internally
/// by Claude anyway, so pre-scaling saves bandwidth with zero quality loss.
/// See: https://platform.claude.com/docs/en/build-with-claude/vision
const MAX_IMAGE_DIMENSION: u32 = 1568;

/// JPEG quality for compression (85 = good quality/size balance)
const JPEG_QUALITY: u8 = 85;

/// Minimum file size to bother processing (skip tiny images)
const MIN_PROCESS_SIZE: usize = 50 * 1024; // 50KB

/// Process image: resize to Claude's optimal limit (1568px) and convert opaque PNG→JPEG.
/// Returns (processed_bytes, final_extension) — extension may change (e.g. png→jpg).
fn process_image(image_data: &[u8], extension: &str) -> Result<(Vec<u8>, String), String> {
    // Skip GIFs (may be animated) and small images
    if extension == "gif" || image_data.len() < MIN_PROCESS_SIZE {
        return Ok((image_data.to_vec(), extension.to_string()));
    }

    let img =
        image::load_from_memory(image_data).map_err(|e| format!("Failed to decode image: {e}"))?;

    let (width, height) = (img.width(), img.height());
    let max_dim = width.max(height);
    let needs_resize = max_dim > MAX_IMAGE_DIMENSION;

    // Determine target format: convert opaque PNGs to JPEG
    let (target_ext, convert_to_jpeg) = if extension == "png" && !img.color().has_alpha() {
        ("jpg", true)
    } else {
        (extension, false)
    };

    // Nothing to do — return original bytes
    if !needs_resize && !convert_to_jpeg {
        return Ok((image_data.to_vec(), extension.to_string()));
    }

    // Resize if needed (preserve aspect ratio)
    let processed = if needs_resize {
        let scale = MAX_IMAGE_DIMENSION as f32 / max_dim as f32;
        let new_w = (width as f32 * scale) as u32;
        let new_h = (height as f32 * scale) as u32;
        img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
    } else {
        img
    };

    // Encode to target format
    let mut buf = std::io::Cursor::new(Vec::new());
    if convert_to_jpeg || target_ext == "jpg" {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY);
        processed
            .write_with_encoder(encoder)
            .map_err(|e| format!("Failed to encode JPEG: {e}"))?;
    } else {
        processed
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode PNG: {e}"))?;
    }

    let result = buf.into_inner();
    log::debug!(
        "Image processed: {width}x{height} -> {}x{}, {extension}->{target_ext} ({} -> {} bytes)",
        processed.width(),
        processed.height(),
        image_data.len(),
        result.len()
    );

    Ok((result, target_ext.to_string()))
}

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

    // Determine original extension from MIME type
    let original_ext = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png", // fallback
    }
    .to_string();

    // Offload CPU-heavy image processing to a blocking thread
    let result = tokio::task::spawn_blocking(move || -> Result<SaveImageResponse, String> {
        let (processed_data, final_ext) = process_image(&image_data, &original_ext)?;

        let timestamp = now();
        let short_uuid = &Uuid::new_v4().to_string()[..8];
        let filename = format!("image-{timestamp}-{short_uuid}.{final_ext}");
        let file_path = images_dir.join(&filename);

        // Write file atomically (temp file + rename)
        let temp_path = file_path.with_extension("tmp");
        std::fs::write(&temp_path, &processed_data)
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
    })
    .await
    .map_err(|e| format!("Image processing task failed: {e}"))??;

    Ok(result)
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
    let metadata =
        std::fs::metadata(&source).map_err(|e| format!("Failed to read file metadata: {e}"))?;

    if metadata.len() as usize > MAX_IMAGE_SIZE {
        return Err(format!(
            "Image too large: {} bytes. Maximum size: {} bytes (10MB)",
            metadata.len(),
            MAX_IMAGE_SIZE
        ));
    }

    // Get the images directory
    let images_dir = get_images_dir(&app)?;

    // Normalize jpeg to jpg
    let normalized_ext = if extension == "jpeg" {
        "jpg".to_string()
    } else {
        extension
    };

    // Offload CPU-heavy image processing to a blocking thread
    let result = tokio::task::spawn_blocking(move || -> Result<SaveImageResponse, String> {
        let source_data =
            std::fs::read(&source).map_err(|e| format!("Failed to read source file: {e}"))?;
        let (processed_data, final_ext) = process_image(&source_data, &normalized_ext)?;

        let timestamp = now();
        let short_uuid = &Uuid::new_v4().to_string()[..8];
        let filename = format!("image-{timestamp}-{short_uuid}.{final_ext}");
        let dest_path = images_dir.join(&filename);

        // Write processed file atomically (temp file + rename)
        let temp_path = dest_path.with_extension("tmp");
        std::fs::write(&temp_path, &processed_data)
            .map_err(|e| format!("Failed to write image file: {e}"))?;

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
    })
    .await
    .map_err(|e| format!("Image processing task failed: {e}"))??;

    Ok(result)
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
/// Uses the editor preference (zed, vscode, cursor, xcode) to open files.
#[tauri::command]
pub async fn open_file_in_default_app(path: String, editor: Option<String>) -> Result<(), String> {
    let editor_app = editor.unwrap_or_else(|| "zed".to_string());
    log::trace!("Opening file in {editor_app}: {path}");

    #[cfg(target_os = "macos")]
    {
        let result = match editor_app.as_str() {
            "zed" => std::process::Command::new("zed").arg(&path).spawn(),
            "cursor" => std::process::Command::new("cursor").arg(&path).spawn(),
            "xcode" => std::process::Command::new("xed").arg(&path).spawn(),
            _ => std::process::Command::new("code").arg(&path).spawn(),
        };

        result.map_err(|e| format!("Failed to open {editor_app}: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        let result = match editor_app.as_str() {
            "zed" => std::process::Command::new("zed").arg(&path).spawn(),
            "cursor" => std::process::Command::new("cursor").arg(&path).spawn(),
            _ => std::process::Command::new("code").arg(&path).spawn(),
        };

        result.map_err(|e| format!("Failed to open {editor_app}: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        let result = match editor_app.as_str() {
            "zed" => std::process::Command::new("zed").arg(&path).spawn(),
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
const CONTEXT_SUMMARY_PROMPT: &str = r#"<task>Summarize the following conversation for future context loading</task>

<output_format>
Your summary should include:
1. Main Goal - What was the primary objective?
2. Key Decisions & Rationale - Important decisions and WHY they were chosen
3. Trade-offs Considered - What approaches were weighed and rejected?
4. Problems Solved - Errors, blockers, or gotchas and how resolved
5. Current State - What has been implemented so far?
6. Unresolved Questions - Open questions or blockers
7. Key Files & Patterns - Critical file paths and code patterns
8. Next Steps - What remains to be done?

Format as clean markdown. Be concise but capture reasoning.
</output_format>

<context>
<project>{project_name}</project>
<date>{date}</date>
</context>

<conversation>
{conversation}
</conversation>"#;

/// JSON schema for structured context summarization output
const CONTEXT_SUMMARY_SCHEMA: &str = r#"{"type":"object","properties":{"summary":{"type":"string","description":"The markdown context summary including main goal, key decisions with rationale, trade-offs considered, problems solved, current state, unresolved questions, key files/patterns, and next steps"},"slug":{"type":"string","description":"A 2-4 word lowercase hyphenated slug describing the main topic (e.g. implement-magic-commands, fix-auth-bug)"}},"required":["summary","slug"],"additionalProperties":false}"#;

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
    model: Option<&str>,
    custom_profile_name: Option<&str>,
    working_dir: Option<&std::path::Path>,
) -> Result<ContextSummaryResponse, String> {
    let model_str = model.unwrap_or("opus");

    // Route to OpenCode if model is an OpenCode model
    if crate::is_opencode_model(model_str) {
        log::trace!("Executing one-shot OpenCode summarization");
        let json_str = super::opencode::execute_one_shot_opencode(
            app,
            prompt,
            model_str,
            Some(CONTEXT_SUMMARY_SCHEMA),
            working_dir,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse OpenCode summarization JSON: {e}, content: {json_str}");
            format!("Failed to parse summarization response: {e}")
        });
    }

    // Route to Codex CLI if model is a Codex model
    if crate::is_codex_model(model_str) {
        log::trace!("Executing one-shot Codex summarization with output-schema");
        let json_str = super::codex::execute_one_shot_codex(
            app,
            prompt,
            model_str,
            CONTEXT_SUMMARY_SCHEMA,
            working_dir,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Codex summarization JSON: {e}, content: {json_str}");
            format!("Failed to parse summarization response: {e}")
        });
    }

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::trace!("Executing one-shot Claude summarization with JSON schema");

    let mut cmd = silent_command(&cli_path);
    crate::chat::claude::apply_custom_profile_settings(&mut cmd, custom_profile_name);
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model_str,
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
#[allow(clippy::too_many_arguments)]
pub async fn generate_context_from_session(
    app: AppHandle,
    worktree_path: String,
    worktree_id: String,
    source_session_id: String,
    project_name: String,
    custom_prompt: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
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
    let (summary, slug) = match execute_summarization_claude(
        &app,
        &prompt,
        model.as_deref(),
        custom_profile_name.as_deref(),
        Some(std::path::Path::new(&worktree_path)),
    ) {
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
        let is_codex = metadata.backend == Backend::Codex;

        // Spawn a task to tail the output file
        tauri::async_runtime::spawn(async move {
            log::trace!("Starting tail task for run: {run_id_clone}, session: {session_id_clone}");

            // Tail the output file — route by backend
            let (resume_id, usage, _cancelled) = if is_codex {
                match super::codex::tail_codex_output(
                    &app_clone,
                    &session_id_clone,
                    &worktree_id_clone,
                    &output_file,
                    pid,
                ) {
                    Ok(response) => (response.thread_id, response.usage, response.cancelled),
                    Err(e) => {
                        log::error!("Resume Codex tail failed for run: {run_id_clone}, error: {e}");
                        if let Ok(mut writer) =
                            RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                        {
                            if let Err(e) = writer.crash() {
                                log::error!("Failed to mark run as crashed: {e}");
                            }
                        }
                        return;
                    }
                }
            } else {
                match super::claude::tail_claude_output(
                    &app_clone,
                    &session_id_clone,
                    &worktree_id_clone,
                    &output_file,
                    pid,
                ) {
                    Ok(response) => (response.session_id, response.usage, response.cancelled),
                    Err(e) => {
                        log::error!(
                            "Resume Claude tail failed for run: {run_id_clone}, error: {e}"
                        );
                        if let Ok(mut writer) =
                            RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                        {
                            if let Err(e) = writer.crash() {
                                log::error!("Failed to mark run as crashed: {e}");
                            }
                        }
                        return;
                    }
                }
            };

            log::trace!(
                "Resume completed for run: {run_id_clone}, resume_id: {:?}",
                resume_id
            );

            // Create a RunLogWriter to update the manifest
            {
                if let Ok(mut writer) =
                    RunLogWriter::resume(&app_clone, &session_id_clone, &run_id_clone)
                {
                    let assistant_message_id = uuid::Uuid::new_v4().to_string();
                    let resume_sid = if resume_id.is_empty() {
                        None
                    } else {
                        Some(resume_id.as_str())
                    };
                    if let Err(e) =
                        writer.complete(&assistant_message_id, resume_sid, usage.clone())
                    {
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
const SESSION_DIGEST_SCHEMA: &str = r#"{"type":"object","properties":{"chat_summary":{"type":"string","description":"One sentence (max 100 chars) summarizing the overall chat goal and progress"},"last_action":{"type":"string","description":"One sentence (max 200 chars) describing what was just completed"}},"required":["chat_summary","last_action"],"additionalProperties":false}"#;

/// Prompt template for session digest generation
const SESSION_DIGEST_PROMPT: &str = r#"You are a summarization assistant. Your ONLY job is to summarize the following conversation transcript. Do NOT continue the conversation or take any actions. Just summarize.

CONVERSATION TRANSCRIPT:
{conversation}

END OF TRANSCRIPT.

Now provide a brief summary with exactly two fields:
- chat_summary: One sentence (max 100 chars) describing the overall goal and current status
- last_action: One sentence (max 200 chars) describing what was just completed in the last exchange"#;

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
    custom_profile_name: Option<&str>,
    working_dir: Option<&std::path::Path>,
) -> Result<SessionDigestResponse, String> {
    // Route to OpenCode if model is an OpenCode model
    if crate::is_opencode_model(model) {
        log::trace!("Executing one-shot OpenCode digest");
        let json_str = super::opencode::execute_one_shot_opencode(
            app,
            prompt,
            model,
            Some(SESSION_DIGEST_SCHEMA),
            working_dir,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse OpenCode digest JSON: {e}, content: {json_str}");
            format!("Failed to parse digest response: {e}")
        });
    }

    // Route to Codex CLI if model is a Codex model
    if crate::is_codex_model(model) {
        log::trace!("Executing one-shot Codex digest with output-schema");
        let json_str = super::codex::execute_one_shot_codex(
            app,
            prompt,
            model,
            SESSION_DIGEST_SCHEMA,
            working_dir,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Codex digest JSON: {e}, content: {json_str}");
            format!("Failed to parse digest response: {e}")
        });
    }

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::trace!("Executing one-shot Claude digest with JSON schema");

    let mut cmd = silent_command(&cli_path);
    crate::chat::claude::apply_custom_profile_settings(&mut cmd, custom_profile_name);
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
) -> Result<SessionDigest, String> {
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

    // Build digest prompt (use custom magic prompt if set, otherwise default)
    let prompt_template = prefs
        .magic_prompts
        .session_recap
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(SESSION_DIGEST_PROMPT);
    let prompt = prompt_template.replace("{conversation}", &conversation_history);

    // Use magic prompt model/provider
    let model = &prefs.magic_prompt_models.session_recap_model;
    let provider = prefs
        .magic_prompt_providers
        .session_recap_provider
        .as_deref();

    // Call Claude CLI with JSON schema (non-streaming)
    let response = execute_digest_claude(&app, &prompt, model, provider, None)?;

    Ok(SessionDigest {
        chat_summary: response.chat_summary,
        last_action: response.last_action,
        created_at: Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        ),
        message_count: Some(messages.len()),
    })
}

/// Update a session's persisted digest
///
/// Called after generating a digest to persist it to disk so it survives app reload.
#[tauri::command]
pub async fn update_session_digest(
    app: AppHandle,
    session_id: String,
    digest: SessionDigest,
) -> Result<(), String> {
    log::trace!("Persisting digest for session {session_id}");

    // Load existing metadata
    let metadata = load_metadata(&app, &session_id)?
        .ok_or_else(|| format!("Session {session_id} not found"))?;

    // Update and save with new digest
    let mut updated = metadata;
    updated.digest = Some(digest);

    super::storage::save_metadata(&app, &updated)?;

    log::trace!("Digest persisted for session {session_id}");
    Ok(())
}

/// Broadcast a session setting change to all connected clients.
/// Used for real-time sync of model, thinking level, and execution mode.
#[tauri::command]
pub async fn broadcast_session_setting(
    app: AppHandle,
    session_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    app.emit_all(
        "session:setting-changed",
        &serde_json::json!({
            "session_id": session_id,
            "key": key,
            "value": value,
        }),
    )
}

// ============================================================================
// MCP Server Discovery Commands
// ============================================================================

/// Information about a configured MCP server
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    pub config: serde_json::Value,
    pub scope: String, // "user", "local", "project"
    /// Whether the server is disabled in its config (has "disabled": true)
    pub disabled: bool,
}

/// Health status of an MCP server as reported by `claude mcp list`
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum McpHealthStatus {
    Connected,
    NeedsAuthentication,
    CouldNotConnect,
    Disabled,
    Unknown,
}

/// Result of a health check across all MCP servers
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpHealthResult {
    pub statuses: std::collections::HashMap<String, McpHealthStatus>,
}

/// Discover MCP servers from all configuration sources:
/// - User scope: ~/.claude.json top-level mcpServers
/// - Local scope: ~/.claude.json under projects[worktreePath].mcpServers
/// - Project scope: <worktree_path>/.mcp.json mcpServers
#[tauri::command]
pub async fn get_mcp_servers(worktree_path: Option<String>) -> Result<Vec<McpServerInfo>, String> {
    let mut servers = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    // Read ~/.claude.json once for both user and local scope
    let claude_json_data = if let Some(home) = dirs::home_dir() {
        let claude_json = home.join(".claude.json");
        if claude_json.exists() {
            std::fs::read_to_string(&claude_json)
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        } else {
            None
        }
    } else {
        None
    };

    // 1. Local scope (highest precedence): project-specific servers in ~/.claude.json
    if let (Some(ref json), Some(ref wt_path)) = (&claude_json_data, &worktree_path) {
        if let Some(projects) = json.get("projects").and_then(|v| v.as_object()) {
            // Look for the worktree path key (may need to check with/without trailing slash)
            let path_key = wt_path.trim_end_matches('/');
            for (key, project_val) in projects {
                let key_normalized = key.trim_end_matches('/');
                if key_normalized == path_key {
                    if let Some(mcp) = project_val.get("mcpServers").and_then(|v| v.as_object()) {
                        for (name, config) in mcp {
                            if seen_names.insert(name.clone()) {
                                let disabled = config
                                    .get("disabled")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                servers.push(McpServerInfo {
                                    name: name.clone(),
                                    config: config.clone(),
                                    scope: "local".to_string(),
                                    disabled,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Project scope: .mcp.json in worktree root
    if let Some(ref wt_path) = worktree_path {
        let mcp_json_path = std::path::PathBuf::from(wt_path).join(".mcp.json");
        if mcp_json_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&mcp_json_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(mcp) = json.get("mcpServers").and_then(|v| v.as_object()) {
                        for (name, config) in mcp {
                            if seen_names.insert(name.clone()) {
                                let disabled = config
                                    .get("disabled")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                servers.push(McpServerInfo {
                                    name: name.clone(),
                                    config: config.clone(),
                                    scope: "project".to_string(),
                                    disabled,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. User scope (lowest precedence): top-level mcpServers in ~/.claude.json
    if let Some(ref json) = claude_json_data {
        if let Some(mcp) = json.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, config) in mcp {
                if seen_names.insert(name.clone()) {
                    let disabled = config
                        .get("disabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    servers.push(McpServerInfo {
                        name: name.clone(),
                        config: config.clone(),
                        scope: "user".to_string(),
                        disabled,
                    });
                }
            }
        }
    }

    Ok(servers)
}

/// Parse `claude mcp list` text output into server health statuses.
///
/// Expected format per line: `name: url/path (Type) - Status`
/// Examples:
///   `notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication`
///   `filesystem: /usr/bin/fs (STDIO) - connected`
fn parse_mcp_list_output(output: &str) -> std::collections::HashMap<String, McpHealthStatus> {
    let mut statuses = std::collections::HashMap::new();

    for line in output.lines() {
        let line = line.trim();

        // Skip header/empty lines
        if line.is_empty() || line.starts_with("Checking MCP") {
            continue;
        }

        // Extract server name (everything before first ':')
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_string();

        // Extract status (everything after last " - ")
        let status_str = rest.rsplit_once(" - ").map(|(_, s)| s.trim()).unwrap_or("");

        let status = if status_str.contains("connected") {
            McpHealthStatus::Connected
        } else if status_str.contains("Needs authentication") {
            McpHealthStatus::NeedsAuthentication
        } else if status_str.contains("Could not connect") {
            McpHealthStatus::CouldNotConnect
        } else if status_str.contains("disabled") {
            McpHealthStatus::Disabled
        } else {
            McpHealthStatus::Unknown
        };

        statuses.insert(name, status);
    }

    statuses
}

/// Check health status of all MCP servers by running `claude mcp list`.
#[tauri::command]
pub async fn check_mcp_health(app: AppHandle) -> Result<McpHealthResult, String> {
    let cli_path = resolve_cli_binary(&app);

    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::debug!("Running: claude mcp list");

    let output = silent_command(&cli_path)
        .args(["mcp", "list"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run claude mcp list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("claude mcp list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let statuses = parse_mcp_list_output(&stdout);

    log::debug!("MCP health check: {} servers", statuses.len());

    Ok(McpHealthResult { statuses })
}

/// Approve or decline a Codex command execution approval request.
///
/// Called by the frontend when the user clicks "Approve" or "Cancel" in the
/// PermissionApproval UI during a Codex build-mode session.
#[tauri::command]
pub fn approve_codex_command(
    session_id: String,
    rpc_id: u64,
    decision: String,
) -> Result<(), String> {
    super::codex::send_approval(&session_id, rpc_id, &decision)
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

    #[test]
    fn test_parse_mcp_list_output() {
        let output = "\
Checking MCP server health...

notion: https://mcp.notion.com/mcp (HTTP) - ! Needs authentication
filesystem: /usr/bin/fs-server (STDIO) - connected
broken: http://localhost:9999 (HTTP) - ! Could not connect
my-disabled: /usr/bin/disabled (STDIO) - disabled";

        let statuses = parse_mcp_list_output(output);
        assert_eq!(statuses.len(), 4);
        assert_eq!(
            statuses.get("notion"),
            Some(&McpHealthStatus::NeedsAuthentication)
        );
        assert_eq!(
            statuses.get("filesystem"),
            Some(&McpHealthStatus::Connected)
        );
        assert_eq!(
            statuses.get("broken"),
            Some(&McpHealthStatus::CouldNotConnect)
        );
        assert_eq!(
            statuses.get("my-disabled"),
            Some(&McpHealthStatus::Disabled)
        );
    }

    #[test]
    fn test_parse_mcp_list_output_empty() {
        let output = "Checking MCP server health...\n\n";
        let statuses = parse_mcp_list_output(output);
        assert!(statuses.is_empty());
    }
}
