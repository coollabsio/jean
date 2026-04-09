use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};

use super::types::NightshiftRun;

/// Global mutex to prevent concurrent read-modify-write races on nightshift run files.
static NIGHTSHIFT_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Max runs to keep per project
const MAX_RUNS_PER_PROJECT: usize = 50;

/// Get the nightshift runs directory
fn get_runs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    let runs_dir = app_data_dir.join("nightshift").join("runs");
    std::fs::create_dir_all(&runs_dir)
        .map_err(|e| format!("Failed to create nightshift runs directory: {e}"))?;

    Ok(runs_dir)
}

/// Get the path to a project's run history file
fn get_project_runs_path(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let runs_dir = get_runs_dir(app)?;
    Ok(runs_dir.join(format!("{project_id}.json")))
}

/// Load all runs for a project
pub fn load_runs(app: &AppHandle, project_id: &str) -> Result<Vec<NightshiftRun>, String> {
    let _lock = NIGHTSHIFT_LOCK.lock().unwrap();
    let path = get_project_runs_path(app, project_id)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read nightshift runs: {e}"))?;

    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse nightshift runs: {e}"))
}

/// Save a run (append or update) for a project
pub fn save_run(app: &AppHandle, run: &NightshiftRun) -> Result<(), String> {
    let _lock = NIGHTSHIFT_LOCK.lock().unwrap();
    let path = get_project_runs_path(app, &run.project_id)?;

    let mut runs: Vec<NightshiftRun> = if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read nightshift runs: {e}"))?;
        serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse nightshift runs: {e}"))?
    } else {
        Vec::new()
    };

    // Update existing run or append new one
    if let Some(existing) = runs.iter_mut().find(|r| r.id == run.id) {
        *existing = run.clone();
    } else {
        runs.push(run.clone());
    }

    // Trim to max runs (keep most recent)
    if runs.len() > MAX_RUNS_PER_PROJECT {
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        runs.truncate(MAX_RUNS_PER_PROJECT);
    }

    let json = serde_json::to_string_pretty(&runs)
        .map_err(|e| format!("Failed to serialize nightshift runs: {e}"))?;

    // Atomic write: temp file + rename
    let temp_path = path.with_extension("tmp");
    std::fs::write(&temp_path, json)
        .map_err(|e| format!("Failed to write nightshift runs: {e}"))?;
    std::fs::rename(&temp_path, &path)
        .map_err(|e| format!("Failed to finalize nightshift runs: {e}"))?;

    Ok(())
}

/// Find a run by ID across all projects
pub fn find_run(app: &AppHandle, run_id: &str) -> Result<Option<NightshiftRun>, String> {
    let _lock = NIGHTSHIFT_LOCK.lock().unwrap();
    let runs_dir = get_runs_dir(app)?;

    let entries = std::fs::read_dir(&runs_dir)
        .map_err(|e| format!("Failed to read nightshift runs directory: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            if let Ok(contents) = std::fs::read_to_string(&path) {
                if let Ok(runs) = serde_json::from_str::<Vec<NightshiftRun>>(&contents) {
                    if let Some(run) = runs.into_iter().find(|r| r.id == run_id) {
                        return Ok(Some(run));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Get last run timestamp for a specific check on a project
pub fn get_last_check_run_time(
    app: &AppHandle,
    project_id: &str,
    check_id: &str,
) -> Result<Option<u64>, String> {
    let runs = load_runs(app, project_id)?;

    let last_time = runs
        .iter()
        .filter(|run| {
            run.check_results
                .iter()
                .any(|cr| cr.check_id == check_id && cr.status == super::types::RunStatus::Completed)
        })
        .map(|run| run.started_at)
        .max();

    Ok(last_time)
}
