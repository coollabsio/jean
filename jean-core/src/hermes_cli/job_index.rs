//! Jean-side Hermes job index: links Hermes job ids to projects/worktrees.
//!
//! Hermes remains source of truth for schedule/prompt/status. This file only
//! stores Jean linkage so the Jobs panel can filter and show worktree context.

use super::config::connection_config_from_prefs;
use super::types::HermesJob;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const INDEX_FILE: &str = "hermes-job-index.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HermesJobLink {
    pub hermes_job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct HermesJobIndexFile {
    #[serde(default)]
    pub jobs: HashMap<String, HermesJobLink>,
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    Ok(dir.join(INDEX_FILE))
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_index(app: &AppHandle) -> HermesJobIndexFile {
    let Ok(path) = index_path(app) else {
        return HermesJobIndexFile::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HermesJobIndexFile::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_index(app: &AppHandle, index: &HermesJobIndexFile) -> Result<(), String> {
    let path = index_path(app)?;
    let json = serde_json::to_string_pretty(index)
        .map_err(|e| format!("Failed to serialize job index: {e}"))?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, json).map_err(|e| format!("Failed to write job index: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to finalize job index: {e}")
    })?;
    Ok(())
}

pub fn upsert_job_link(app: &AppHandle, link: HermesJobLink) -> Result<(), String> {
    let mut index = load_index(app);
    index.jobs.insert(link.hermes_job_id.clone(), link);
    save_index(app, &index)
}

pub fn remove_job_link(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let mut index = load_index(app);
    index.jobs.remove(job_id);
    save_index(app, &index)
}

pub fn get_job_link(app: &AppHandle, job_id: &str) -> Option<HermesJobLink> {
    load_index(app).jobs.get(job_id).cloned()
}

pub fn list_job_links(app: &AppHandle) -> Vec<HermesJobLink> {
    load_index(app).jobs.into_values().collect()
}

/// Attach Jean linkage to API jobs (index match, then path match).
pub fn enrich_jobs(app: &AppHandle, jobs: &mut [HermesJob]) {
    let index = load_index(app);
    let profile = connection_config_from_prefs(app).profile;

    // path → worktree resolution from index + known worktrees
    let path_to_link: HashMap<String, HermesJobLink> = index
        .jobs
        .values()
        .filter_map(|link| {
            let path = link.worktree_path.as_ref()?.trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some((normalize_path(&path), link.clone()))
            }
        })
        .collect();

    // Also build path map from live worktrees for unindexed jobs with workdir.
    let worktree_by_path = load_worktree_path_map(app);

    for job in jobs.iter_mut() {
        if let Some(link) = index.jobs.get(&job.id) {
            apply_link(job, link);
            continue;
        }
        if let Some(workdir) = job.workdir.as_ref().map(|w| normalize_path(w)) {
            if let Some(link) = path_to_link.get(&workdir) {
                apply_link(job, link);
                continue;
            }
            if let Some((project_id, worktree_id, path)) = worktree_by_path.get(&workdir) {
                job.project_id = Some(project_id.clone());
                job.worktree_id = Some(worktree_id.clone());
                job.worktree_path = Some(path.clone());
                job.profile = Some(profile.clone());
            }
        }
    }
}

fn apply_link(job: &mut HermesJob, link: &HermesJobLink) {
    job.project_id = link.project_id.clone();
    job.worktree_id = link.worktree_id.clone();
    job.worktree_path = link.worktree_path.clone().or_else(|| job.workdir.clone());
    job.session_id = link.session_id.clone();
    if !link.profile.is_empty() {
        job.profile = Some(link.profile.clone());
    }
}

fn normalize_path(path: &str) -> String {
    Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

fn load_worktree_path_map(app: &AppHandle) -> HashMap<String, (String, String, String)> {
    // project_id, worktree_id, path
    let mut map = HashMap::new();
    let Ok(data) = crate::projects::storage::load_projects_data(app) else {
        return map;
    };
    for wt in data.worktrees {
        let key = normalize_path(&wt.path);
        map.insert(key, (wt.project_id.clone(), wt.id.clone(), wt.path.clone()));
    }
    map
}

pub fn link_from_create_request(
    app: &AppHandle,
    job_id: &str,
    project_id: Option<String>,
    worktree_id: Option<String>,
    worktree_path: Option<String>,
    session_id: Option<String>,
) -> HermesJobLink {
    let profile = connection_config_from_prefs(app).profile;
    HermesJobLink {
        hermes_job_id: job_id.to_string(),
        project_id,
        worktree_id,
        worktree_path,
        session_id,
        profile,
        created_at: now_unix(),
    }
}

/// Latest cron output markdown for a job (Hermes `deliver: local`).
pub fn read_latest_job_output(job_id: &str) -> Result<HermesJobOutput, String> {
    validate_hermes_job_id(job_id)?;

    let output_dir = super::config::hermes_home_dir().join("cron").join("output");
    let dir = output_dir.join(job_id);
    if !dir.exists() {
        return Ok(HermesJobOutput {
            job_id: job_id.to_string(),
            path: None,
            content: None,
            modified_at: None,
        });
    }
    let canonical_output_dir = output_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {}: {e}", output_dir.display()))?;
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {}: {e}", dir.display()))?;
    if !canonical_dir.starts_with(&canonical_output_dir) {
        return Err("Hermes job output path escapes the output directory".to_string());
    }
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .collect();
    entries.sort_by_key(|e| {
        e.metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    });
    let Some(latest) = entries.last() else {
        return Ok(HermesJobOutput {
            job_id: job_id.to_string(),
            path: None,
            content: None,
            modified_at: None,
        });
    };
    let path = latest
        .path()
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {}: {e}", latest.path().display()))?;
    if !path.starts_with(&canonical_dir) {
        return Err("Hermes job output file escapes the job directory".to_string());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let modified_at = latest
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Ok(HermesJobOutput {
        job_id: job_id.to_string(),
        path: Some(path.to_string_lossy().to_string()),
        content: Some(content),
        modified_at,
    })
}

fn validate_hermes_job_id(job_id: &str) -> Result<(), String> {
    if job_id.len() == 12
        && job_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("Invalid Hermes job id: expected 12 lowercase hexadecimal characters".to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HermesJobOutput {
    pub job_id: String,
    pub path: Option<String>,
    pub content: Option<String>,
    pub modified_at: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_keeps_relative() {
        let p = normalize_path("./foo");
        assert!(!p.is_empty());
    }

    #[test]
    fn hermes_job_id_requires_twelve_hex_characters() {
        assert!(validate_hermes_job_id("a1b2c3d4e5f6").is_ok());
        assert!(validate_hermes_job_id("A1B2C3D4E5F6").is_err());
        assert!(validate_hermes_job_id("../a1b2c3d4e5f6").is_err());
        assert!(validate_hermes_job_id("a1b2/c3d4e5f6").is_err());
        assert!(validate_hermes_job_id("a1b2c3d4e5f").is_err());
        assert!(validate_hermes_job_id("a1b2c3d4e5fg").is_err());
    }
}
