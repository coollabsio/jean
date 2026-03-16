//! Tauri commands for controlling background tasks

use tauri::State;

use super::{
    BackgroundTaskManager, MAX_POLL_INTERVAL, MAX_REMOTE_POLL_INTERVAL, MIN_POLL_INTERVAL,
    MIN_REMOTE_POLL_INTERVAL,
};
use crate::projects::git_status::ActiveWorktreeInfo;
use serde::Deserialize;

/// Set the application focus state
///
/// This controls whether background polling is active.
/// Polling only occurs when the application is focused.
#[tauri::command]
pub fn set_app_focus_state(
    state: State<'_, BackgroundTaskManager>,
    focused: bool,
) -> Result<(), String> {
    state.set_focused(focused);
    Ok(())
}

/// Set the active worktree for git status polling
///
/// Pass null/None values to clear the active worktree and stop polling.
#[tauri::command]
pub fn set_active_worktree_for_polling(
    state: State<'_, BackgroundTaskManager>,
    worktree_id: Option<String>,
    worktree_path: Option<String>,
    base_branch: Option<String>,
    pr_number: Option<u32>,
    pr_url: Option<String>,
) -> Result<(), String> {
    let info = match (worktree_id, worktree_path, base_branch) {
        (Some(id), Some(path), Some(branch)) => Some(ActiveWorktreeInfo {
            worktree_id: id,
            worktree_path: path,
            base_branch: branch,
            pr_number,
            pr_url,
        }),
        _ => None,
    };

    state.set_active_worktree(info);
    Ok(())
}

/// Set the git polling interval in seconds
///
/// The interval must be between 10 and 600 seconds (10 seconds to 10 minutes).
/// Values outside this range will be clamped.
#[tauri::command]
pub fn set_git_poll_interval(
    state: State<'_, BackgroundTaskManager>,
    seconds: u64,
) -> Result<(), String> {
    if !(MIN_POLL_INTERVAL..=MAX_POLL_INTERVAL).contains(&seconds) {
        log::warn!(
            "Git poll interval {seconds} out of range, will be clamped to {MIN_POLL_INTERVAL}-{MAX_POLL_INTERVAL}"
        );
    }
    state.set_poll_interval(seconds);
    Ok(())
}

/// Get the current git polling interval in seconds
#[tauri::command]
pub fn get_git_poll_interval(state: State<'_, BackgroundTaskManager>) -> Result<u64, String> {
    Ok(state.get_poll_interval())
}

/// Trigger an immediate local git status poll
///
/// This bypasses the normal polling interval and debounce timer
/// to immediately check git status. Useful after git operations like pull/push.
#[tauri::command]
pub fn trigger_immediate_git_poll(state: State<'_, BackgroundTaskManager>) -> Result<(), String> {
    state.trigger_immediate_poll();
    Ok(())
}

/// Set the remote polling interval in seconds
///
/// The interval must be between 30 and 600 seconds (30 seconds to 10 minutes).
/// Values outside this range will be clamped.
/// This controls how often remote API calls (like PR status via `gh`) are made.
#[tauri::command]
pub fn set_remote_poll_interval(
    state: State<'_, BackgroundTaskManager>,
    seconds: u64,
) -> Result<(), String> {
    if !(MIN_REMOTE_POLL_INTERVAL..=MAX_REMOTE_POLL_INTERVAL).contains(&seconds) {
        log::warn!(
            "Remote poll interval {seconds} out of range, will be clamped to {MIN_REMOTE_POLL_INTERVAL}-{MAX_REMOTE_POLL_INTERVAL}"
        );
    }
    state.set_remote_poll_interval(seconds);
    Ok(())
}

/// Get the current remote polling interval in seconds
#[tauri::command]
pub fn get_remote_poll_interval(state: State<'_, BackgroundTaskManager>) -> Result<u64, String> {
    Ok(state.get_remote_poll_interval())
}

/// Trigger an immediate remote poll
///
/// This bypasses the normal remote polling interval
/// to immediately check PR status and other remote data.
#[tauri::command]
pub fn trigger_immediate_remote_poll(
    state: State<'_, BackgroundTaskManager>,
) -> Result<(), String> {
    state.trigger_immediate_remote_poll();
    Ok(())
}

/// Info about a worktree with an open PR, for sweep polling
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrWorktreeInfo {
    pub worktree_id: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub pr_number: u32,
    pub pr_url: String,
}

/// Set all worktrees with open PRs for background sweep polling.
///
/// The sweep polls these worktrees round-robin at a slow interval (5 min)
/// to detect PR merges even when the worktree isn't actively selected.
#[tauri::command]
pub fn set_pr_worktrees_for_polling(
    state: State<'_, BackgroundTaskManager>,
    worktrees: Vec<PrWorktreeInfo>,
) -> Result<(), String> {
    let infos: Vec<ActiveWorktreeInfo> = worktrees
        .into_iter()
        .map(|w| ActiveWorktreeInfo {
            worktree_id: w.worktree_id,
            worktree_path: w.worktree_path,
            base_branch: w.base_branch,
            pr_number: Some(w.pr_number),
            pr_url: Some(w.pr_url),
        })
        .collect();
    state.set_pr_worktrees(infos);
    Ok(())
}

/// Info about a worktree for git status sweep polling
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllWorktreeInfo {
    pub worktree_id: String,
    pub worktree_path: String,
    pub base_branch: String,
}

/// Set all worktrees for background git status sweep polling.
///
/// The sweep polls these worktrees round-robin at a slow interval (60s)
/// to keep uncommitted diff stats up to date even when not actively selected.
#[tauri::command]
pub fn set_all_worktrees_for_polling(
    state: State<'_, BackgroundTaskManager>,
    worktrees: Vec<AllWorktreeInfo>,
) -> Result<(), String> {
    let infos: Vec<ActiveWorktreeInfo> = worktrees
        .into_iter()
        .map(|w| ActiveWorktreeInfo {
            worktree_id: w.worktree_id,
            worktree_path: w.worktree_path,
            base_branch: w.base_branch,
            pr_number: None,
            pr_url: None,
        })
        .collect();
    state.set_all_worktrees(infos);
    Ok(())
}
