//! Tauri commands for controlling background tasks

use std::collections::HashMap;

use tauri::{AppHandle, State};

use super::{
    BackgroundTaskManager, MAX_POLL_INTERVAL, MAX_REMOTE_POLL_INTERVAL, MIN_POLL_INTERVAL,
    MIN_REMOTE_POLL_INTERVAL,
};
use crate::projects::git_status::ActiveWorktreeInfo;
use crate::projects::storage::load_projects_data;
use serde::Deserialize;

/// Persisted bits of a worktree needed to compute its git status. Falls back to
/// defaults when the worktree isn't found or projects data can't be loaded.
#[derive(Clone, Default)]
struct WorktreeStatusContext {
    pr_push_remote: Option<String>,
    pr_push_branch: Option<String>,
    base_remote: Option<String>,
}

fn lookup_status_context(app: &AppHandle, worktree_id: &str) -> WorktreeStatusContext {
    match load_projects_data(app) {
        Ok(data) => data
            .worktrees
            .iter()
            .find(|w| w.id == worktree_id)
            .map(|w| WorktreeStatusContext {
                pr_push_remote: w.pr_push_remote.clone(),
                pr_push_branch: w.pr_push_branch.clone(),
                base_remote: w.base_remote.clone(),
            })
            .unwrap_or_default(),
        Err(_) => WorktreeStatusContext::default(),
    }
}

/// Build a map of worktree_id → status context from persisted data.
fn load_status_contexts(app: &AppHandle) -> HashMap<String, WorktreeStatusContext> {
    match load_projects_data(app) {
        Ok(data) => data
            .worktrees
            .into_iter()
            .map(|w| {
                (
                    w.id,
                    WorktreeStatusContext {
                        pr_push_remote: w.pr_push_remote,
                        pr_push_branch: w.pr_push_branch,
                        base_remote: w.base_remote,
                    },
                )
            })
            .collect(),
        Err(_) => HashMap::new(),
    }
}

/// Set the application focus state
///
/// This controls whether background polling is active.
/// Polling only occurs when the application is focused.
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
pub fn set_active_worktree_for_polling(
    app: AppHandle,
    state: State<'_, BackgroundTaskManager>,
    worktree_id: Option<String>,
    worktree_path: Option<String>,
    base_branch: Option<String>,
    pr_number: Option<u32>,
    pr_url: Option<String>,
) -> Result<(), String> {
    let info = match (worktree_id, worktree_path, base_branch) {
        (Some(id), Some(path), Some(branch)) => {
            let context = lookup_status_context(&app, &id);
            Some(ActiveWorktreeInfo {
                worktree_id: id,
                worktree_path: path,
                base_branch: branch,
                base_remote: context.base_remote,
                pr_number,
                pr_url,
                pr_push_remote: context.pr_push_remote,
                pr_push_branch: context.pr_push_branch,
            })
        }
        _ => None,
    };

    state.set_active_worktree(info);
    Ok(())
}

/// Set the git polling interval in seconds
///
/// The interval must be between 10 and 600 seconds (10 seconds to 10 minutes).
/// Values outside this range will be clamped.
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
pub fn get_git_poll_interval(state: State<'_, BackgroundTaskManager>) -> Result<u64, String> {
    Ok(state.get_poll_interval())
}

/// Trigger an immediate local git status poll
///
/// This bypasses the normal polling interval and debounce timer
/// to immediately check git status. Useful after git operations like pull/push.
pub fn trigger_immediate_git_poll(state: State<'_, BackgroundTaskManager>) -> Result<(), String> {
    state.trigger_immediate_poll();
    Ok(())
}

/// Set the remote polling interval in seconds
///
/// The interval must be between 30 and 600 seconds (30 seconds to 10 minutes).
/// Values outside this range will be clamped.
/// This controls how often remote API calls (like PR status via `gh`) are made.
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
pub fn get_remote_poll_interval(state: State<'_, BackgroundTaskManager>) -> Result<u64, String> {
    Ok(state.get_remote_poll_interval())
}

/// Trigger an immediate remote poll
///
/// This bypasses the normal remote polling interval
/// to immediately check PR status and other remote data.
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
pub fn set_pr_worktrees_for_polling(
    app: AppHandle,
    state: State<'_, BackgroundTaskManager>,
    worktrees: Vec<PrWorktreeInfo>,
) -> Result<(), String> {
    let contexts = load_status_contexts(&app);
    let infos: Vec<ActiveWorktreeInfo> = worktrees
        .into_iter()
        .map(|w| {
            let context = contexts.get(&w.worktree_id).cloned().unwrap_or_default();
            ActiveWorktreeInfo {
                worktree_id: w.worktree_id,
                worktree_path: w.worktree_path,
                base_branch: w.base_branch,
                base_remote: context.base_remote,
                pr_number: Some(w.pr_number),
                pr_url: Some(w.pr_url),
                pr_push_remote: context.pr_push_remote,
                pr_push_branch: context.pr_push_branch,
            }
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
pub fn set_all_worktrees_for_polling(
    app: AppHandle,
    state: State<'_, BackgroundTaskManager>,
    worktrees: Vec<AllWorktreeInfo>,
) -> Result<(), String> {
    let contexts = load_status_contexts(&app);
    let infos: Vec<ActiveWorktreeInfo> = worktrees
        .into_iter()
        .map(|w| {
            let context = contexts.get(&w.worktree_id).cloned().unwrap_or_default();
            ActiveWorktreeInfo {
                worktree_id: w.worktree_id,
                worktree_path: w.worktree_path,
                base_branch: w.base_branch,
                base_remote: context.base_remote,
                pr_number: None,
                pr_url: None,
                pr_push_remote: context.pr_push_remote,
                pr_push_branch: context.pr_push_branch,
            }
        })
        .collect();
    state.set_all_worktrees(infos);
    Ok(())
}
