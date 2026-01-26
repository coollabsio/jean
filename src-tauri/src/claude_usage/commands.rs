use tauri::AppHandle;

use super::api::fetch_usage_limits;
use super::credentials::has_oauth_credentials;
use super::types::{SessionUsage, UsageLimits};
use crate::chat::storage::{load_metadata, load_sessions};

/// Get Claude usage limits (5-hour and 7-day windows)
///
/// Returns current utilization percentages and reset times.
/// Uses a 60-second cache to avoid excessive API calls.
#[tauri::command]
pub async fn get_claude_usage_limits() -> Result<UsageLimits, String> {
    // Check if credentials are available first
    if !has_oauth_credentials().await {
        return Ok(UsageLimits::default());
    }

    fetch_usage_limits().await
}

/// Get session usage summary (tokens, cost, context percentage)
///
/// Aggregates usage data from all runs in the specified session.
#[tauri::command]
pub async fn get_session_usage(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
) -> Result<SessionUsage, String> {
    // Load sessions to verify session exists
    let sessions = load_sessions(&app, &worktree_path, &worktree_id)?;
    let _session = sessions
        .find_session(&session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;

    // Load session metadata to get run info
    let metadata = load_metadata(&app, &session_id)?;

    // For cost: sum all tokens from all runs
    // For context: use last run's tokens (represents current context window usage)
    let (total_input, total_output, total_cache_read, total_cache_creation, last_input, last_cache_read, last_cache_creation) = match metadata {
        Some(meta) => {
            let runs_with_usage: Vec<_> = meta.runs.iter().filter_map(|run| run.usage.as_ref()).collect();

            // Sum all for cost calculation
            let totals = runs_with_usage.iter().fold(
                (0u64, 0u64, 0u64, 0u64),
                |(inp, out, read, create), u| {
                    (
                        inp + u.input_tokens,
                        out + u.output_tokens,
                        read + u.cache_read_input_tokens,
                        create + u.cache_creation_input_tokens,
                    )
                },
            );

            // Last run for context size (input + cache_read + cache_creation = full context)
            let last = runs_with_usage.last();
            let last_input = last.map(|u| u.input_tokens).unwrap_or(0);
            let last_cache_read = last.map(|u| u.cache_read_input_tokens).unwrap_or(0);
            let last_cache_creation = last.map(|u| u.cache_creation_input_tokens).unwrap_or(0);

            (totals.0, totals.1, totals.2, totals.3, last_input, last_cache_read, last_cache_creation)
        }
        None => (0, 0, 0, 0, 0, 0, 0),
    };

    Ok(SessionUsage::from_tokens_with_context(
        total_input,
        total_output,
        total_cache_read,
        total_cache_creation,
        last_input,
        last_cache_read,
        last_cache_creation,
    ))
}

/// Check if OAuth credentials are available
///
/// Useful for UI to know whether to show limits section.
#[tauri::command]
pub async fn has_claude_credentials() -> bool {
    has_oauth_credentials().await
}

/// Get context data from the Jean hook
///
/// Returns context data written by the context-writer hook script.
/// This provides accurate context percentage from Claude Code directly.
/// Uses Claude Code's session ID from Jean's session metadata.
#[tauri::command]
pub fn get_hook_context_data(
    app: AppHandle,
    session_id: String,
) -> Option<super::context_hook::HookContextData> {
    // Load session metadata to get Claude Code's session ID
    let metadata = load_metadata(&app, &session_id).ok()??;

    // Get Claude Code's session ID from metadata
    let claude_session_id = metadata.claude_session_id.as_ref()?;

    // Read hook data using Claude Code's session ID
    super::context_hook::read_hook_context_data(claude_session_id)
}

/// Check if the context tracking hook is installed
#[tauri::command]
pub fn is_context_hook_installed() -> bool {
    super::hook_installer::is_hook_installed()
}

/// Install the context tracking hook in Claude Code settings
#[tauri::command]
pub fn install_context_hook() -> Result<(), String> {
    super::hook_installer::install_hook()
}

/// Uninstall the context tracking hook from Claude Code settings
#[tauri::command]
pub fn uninstall_context_hook() -> Result<(), String> {
    super::hook_installer::uninstall_hook()
}
