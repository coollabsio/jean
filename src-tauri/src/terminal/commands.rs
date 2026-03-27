use tauri::AppHandle;

use super::pty::{
    kill_all_terminals as pty_kill_all_terminals, kill_terminal, resize_terminal, spawn_terminal,
    write_to_terminal,
};
use super::registry::{get_all_terminal_ids, has_terminal};
use crate::projects::git::read_jean_config;

/// Start a terminal
#[tauri::command]
pub async fn start_terminal(
    app: AppHandle,
    terminal_id: String,
    worktree_path: String,
    cols: u16,
    rows: u16,
    command: Option<String>,
    command_args: Option<Vec<String>>,
) -> Result<(), String> {
    log::trace!("start_terminal called for terminal: {terminal_id}");
    if command.is_some() || command_args.is_some() {
        log::debug!(
            "start_terminal {terminal_id}: worktree_path={worktree_path}, command={:?}, command_args={:?}",
            command,
            command_args
        );
    }

    // Check if terminal already exists
    if has_terminal(&terminal_id) {
        return Err("Terminal already exists".to_string());
    }

    spawn_terminal(
        &app,
        terminal_id,
        worktree_path,
        cols,
        rows,
        command,
        command_args,
    )
}

/// Get the run script(s) from jean.json for a worktree
#[tauri::command]
pub async fn get_run_scripts(worktree_path: String) -> Vec<String> {
    read_jean_config(&worktree_path)
        .and_then(|config| config.scripts.run)
        .map(|r| r.into_vec())
        .unwrap_or_default()
}

/// Get configured ports from jean.json for a worktree
#[tauri::command]
pub async fn get_ports(worktree_path: String) -> Vec<crate::projects::types::PortEntry> {
    read_jean_config(&worktree_path)
        .and_then(|config| config.ports)
        .unwrap_or_default()
}

/// Write data to a terminal (stdin)
#[tauri::command]
pub async fn terminal_write(terminal_id: String, data: String) -> Result<(), String> {
    write_to_terminal(&terminal_id, &data)
}

/// Resize a terminal
#[tauri::command]
pub async fn terminal_resize(terminal_id: String, cols: u16, rows: u16) -> Result<(), String> {
    log::trace!("terminal_resize for {terminal_id}: {cols}x{rows}");
    resize_terminal(&terminal_id, cols, rows)
}

/// Stop a terminal
#[tauri::command]
pub async fn stop_terminal(app: AppHandle, terminal_id: String) -> Result<bool, String> {
    log::trace!("stop_terminal called for terminal: {terminal_id}");
    kill_terminal(&app, &terminal_id)
}

/// Get list of active terminal IDs
#[tauri::command]
pub async fn get_active_terminals() -> Vec<String> {
    get_all_terminal_ids()
}

/// Check if a terminal exists
#[tauri::command]
pub async fn has_active_terminal(terminal_id: String) -> bool {
    has_terminal(&terminal_id)
}

/// Kill all active terminals (used during app shutdown/refresh)
#[tauri::command]
pub fn kill_all_terminals() -> usize {
    log::trace!("kill_all_terminals command invoked");
    pty_kill_all_terminals()
}
