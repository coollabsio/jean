use tauri::AppHandle;

use super::checks::{all_check_metadata, get_default_prompt};
use super::engine;
use super::storage;
use super::types::*;
use crate::projects::storage::{load_projects_data, save_projects_data};

/// Get all available built-in checks
#[tauri::command]
pub async fn nightshift_list_checks() -> Result<Vec<NightshiftCheck>, String> {
    Ok(all_check_metadata())
}

/// Get Nightshift config for a project
#[tauri::command]
pub async fn nightshift_get_config(
    app: AppHandle,
    project_id: String,
) -> Result<NightshiftConfig, String> {
    let data = load_projects_data(&app)?;
    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    Ok(project.nightshift_config.clone().unwrap_or_default())
}

/// Save Nightshift config for a project
#[tauri::command]
pub async fn nightshift_save_config(
    app: AppHandle,
    project_id: String,
    config: NightshiftConfig,
) -> Result<(), String> {
    let mut data = load_projects_data(&app)?;
    let project = data
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    project.nightshift_config = Some(config);
    save_projects_data(&app, &data)?;

    Ok(())
}

/// Manually trigger a Nightshift run for a project.
/// Returns immediately with run_id; progress is emitted via events.
#[tauri::command]
pub async fn nightshift_start_run(app: AppHandle, project_id: String) -> Result<String, String> {
    engine::start_run(&app, &project_id, RunTrigger::Manual)
}

/// Cancel an in-progress Nightshift run
#[tauri::command]
pub async fn nightshift_cancel_run(run_id: String) -> Result<bool, String> {
    engine::cancel_run(&run_id)
}

/// Get run history for a project
#[tauri::command]
pub async fn nightshift_get_runs(
    app: AppHandle,
    project_id: String,
    limit: Option<u32>,
) -> Result<Vec<NightshiftRun>, String> {
    let mut runs = storage::load_runs(&app, &project_id)?;

    // Sort by started_at descending
    runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));

    if let Some(limit) = limit {
        runs.truncate(limit as usize);
    }

    Ok(runs)
}

/// Get a single run's details
#[tauri::command]
pub async fn nightshift_get_run(app: AppHandle, run_id: String) -> Result<NightshiftRun, String> {
    storage::find_run(&app, &run_id)?.ok_or_else(|| format!("Run not found: {run_id}"))
}

/// Report a check completion from the frontend (after session finishes)
#[tauri::command]
pub async fn nightshift_report_check_done(
    run_id: String,
    check_id: String,
    session_id: String,
    success: bool,
    error: Option<String>,
) -> Result<(), String> {
    engine::report_check_done(&run_id, &check_id, session_id, success, error);
    Ok(())
}

/// Get the built-in default prompt for a check (for UI reset-to-default)
#[tauri::command]
pub async fn nightshift_get_default_prompt(check_id: String) -> Result<Option<String>, String> {
    Ok(get_default_prompt(&check_id).map(|s| s.to_string()))
}
