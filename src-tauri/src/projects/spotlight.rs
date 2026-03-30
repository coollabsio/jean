use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use super::storage::load_projects_data;
use super::types::SessionType;
use crate::platform::silent_command;

const SPOTLIGHT_PREFIX: &str = "spotlight-state-";
const WATCH_INTERVAL_MS: u64 = 500;
const WATCH_DEBOUNCE_MS: u64 = 700;

static WATCHERS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SYNC_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpotlightStatus {
    pub worktree_id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub root_path: String,
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<u64>,
    #[serde(default)]
    pub restore_pending: bool,
    pub recovery_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SpotlightManifest {
    pub worktree_id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub root_path: String,
    pub recovery_id: String,
    pub root_head_sha: String,
    pub root_branch: String,
    pub root_tracked_paths: Vec<String>,
    #[serde(default)]
    pub spotlight_only_paths: Vec<String>,
    #[serde(default)]
    pub moved_untracked_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracked_stash_message: Option<String>,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<u64>,
    #[serde(default)]
    pub restore_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn get_recovery_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let recovery_dir = app_data_dir.join("recovery");
    fs::create_dir_all(&recovery_dir)
        .map_err(|e| format!("Failed to create recovery directory: {e}"))?;
    Ok(recovery_dir)
}

fn manifest_path(app: &AppHandle, worktree_id: &str) -> Result<PathBuf, String> {
    Ok(get_recovery_dir(app)?.join(format!("{SPOTLIGHT_PREFIX}{worktree_id}.json")))
}

fn backup_dir_path(app: &AppHandle, recovery_id: &str) -> Result<PathBuf, String> {
    Ok(get_recovery_dir(app)?.join(format!("spotlight-backup-{recovery_id}")))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize spotlight state: {e}"))?;
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, json).map_err(|e| format!("Failed to write spotlight temp file: {e}"))?;
    fs::rename(&tmp_path, path).map_err(|e| format!("Failed to finalize spotlight file: {e}"))?;
    Ok(())
}

fn save_manifest(app: &AppHandle, manifest: &SpotlightManifest) -> Result<(), String> {
    let path = manifest_path(app, &manifest.worktree_id)?;
    write_json_atomic(&path, manifest)
}

fn load_manifest(app: &AppHandle, worktree_id: &str) -> Result<Option<SpotlightManifest>, String> {
    let path = manifest_path(app, worktree_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read spotlight file: {e}"))?;
    let manifest = serde_json::from_str::<SpotlightManifest>(&contents)
        .map_err(|e| format!("Failed to parse spotlight file: {e}"))?;
    Ok(Some(manifest))
}

fn load_all_manifests(app: &AppHandle) -> Result<Vec<SpotlightManifest>, String> {
    let recovery_dir = get_recovery_dir(app)?;
    let entries = fs::read_dir(&recovery_dir)
        .map_err(|e| format!("Failed to read recovery directory: {e}"))?;
    let mut manifests = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read recovery entry: {e}"))?;
        let path = entry.path();
        let Some(filename) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        if !filename.starts_with(SPOTLIGHT_PREFIX)
            || path.extension().and_then(|ext| ext.to_str()) != Some("json")
        {
            continue;
        }

        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) => {
                log::warn!("Failed to read spotlight manifest {path:?}: {error}");
                continue;
            }
        };
        match serde_json::from_str::<SpotlightManifest>(&contents) {
            Ok(manifest) => manifests.push(manifest),
            Err(error) => {
                log::warn!("Failed to parse spotlight manifest {path:?}: {error}");
            }
        }
    }

    manifests.sort_by(|a, b| a.worktree_id.cmp(&b.worktree_id));
    Ok(manifests)
}

fn remove_manifest(app: &AppHandle, worktree_id: &str) -> Result<(), String> {
    let path = manifest_path(app, worktree_id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to remove spotlight manifest: {e}"))?;
    }
    Ok(())
}

fn stop_watcher(worktree_id: &str) {
    if let Some(stop_flag) = WATCHERS.lock().unwrap().remove(worktree_id) {
        stop_flag.store(true, Ordering::SeqCst);
    }
}

fn get_sync_lock(worktree_id: &str) -> Arc<Mutex<()>> {
    let mut locks = SYNC_LOCKS.lock().unwrap();
    locks
        .entry(worktree_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn relative_git_paths(repo_path: &str, args: &[&str]) -> Result<Vec<String>, String> {
    let output = silent_command("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Git command failed".to_string()
        } else {
            stderr
        });
    }

    let stdout = output.stdout;
    let paths = stdout
        .split(|byte| *byte == 0)
        .filter_map(|chunk| {
            if chunk.is_empty() {
                None
            } else {
                Some(String::from_utf8_lossy(chunk).to_string())
            }
        })
        .collect();
    Ok(paths)
}

fn list_tracked_paths(repo_path: &str) -> Result<Vec<String>, String> {
    relative_git_paths(repo_path, &["ls-files", "-z"])
}

fn list_untracked_paths(repo_path: &str) -> Result<Vec<String>, String> {
    relative_git_paths(
        repo_path,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )
}

fn current_branch(repo_path: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to read git branch: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn head_sha(repo_path: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to read git HEAD: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_dir(repo_path: &str) -> Result<PathBuf, String> {
    let output = silent_command("git")
        .args(["rev-parse", "--absolute-git-dir"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to resolve git dir: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

fn git_operation_in_progress(repo_path: &str) -> Result<bool, String> {
    let git_dir = git_dir(repo_path)?;
    let markers = [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
        "REBASE_HEAD",
    ];
    if markers.iter().any(|marker| git_dir.join(marker).exists()) {
        return Ok(true);
    }
    Ok(git_dir.join("rebase-apply").exists() || git_dir.join("rebase-merge").exists())
}

fn tracked_changes_fingerprint(repo_path: &str) -> Result<String, String> {
    let head = head_sha(repo_path)?;
    let output = silent_command("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to read git status: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let status = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(format!("{head}\n{status}"))
}

fn has_tracked_changes(repo_path: &str) -> Result<bool, String> {
    let output = silent_command("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to read git status: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn unique_stash_message(worktree_id: &str) -> String {
    format!("jean-spotlight-{worktree_id}-{}", now())
}

fn stash_tracked_changes(repo_path: &str, message: &str) -> Result<Option<String>, String> {
    if !has_tracked_changes(repo_path)? {
        return Ok(None);
    }

    let output = silent_command("git")
        .args(["stash", "push", "-m", message])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to stash git changes: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(Some(message.to_string()))
}

fn find_stash_ref(repo_path: &str, message: &str) -> Result<Option<String>, String> {
    let output = silent_command("git")
        .args(["stash", "list", "--format=%gd%x00%s"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to read stash list: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    for line in output.stdout.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, |byte| *byte == 0);
        let Some(stash_ref) = parts.next() else {
            continue;
        };
        let Some(subject) = parts.next() else {
            continue;
        };
        if String::from_utf8_lossy(subject).contains(message) {
            return Ok(Some(String::from_utf8_lossy(stash_ref).to_string()));
        }
    }
    Ok(None)
}

fn pop_stash(repo_path: &str, stash_ref: &str) -> Result<(), String> {
    let output = silent_command("git")
        .args(["stash", "pop", stash_ref])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to restore stash: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<(), String> {
    if !path.exists() && !path.is_symlink() {
        return Ok(());
    }

    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect path {}: {e}", path.display()))?;
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove directory {}: {e}", path.display()))?;
    } else {
        fs::remove_file(path)
            .map_err(|e| format!("Failed to remove file {}: {e}", path.display()))?;
    }
    Ok(())
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let target =
        fs::read_link(src).map_err(|e| format!("Failed to read symlink {}: {e}", src.display()))?;
    let _ = remove_path(dst);
    ensure_parent(dst)?;
    symlink(target, dst).map_err(|e| format!("Failed to create symlink {}: {e}", dst.display()))?;
    Ok(())
}

#[cfg(windows)]
fn copy_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    use std::os::windows::fs::{symlink_dir, symlink_file};

    let target =
        fs::read_link(src).map_err(|e| format!("Failed to read symlink {}: {e}", src.display()))?;
    let _ = remove_path(dst);
    ensure_parent(dst)?;
    let metadata = fs::metadata(src)
        .map_err(|e| format!("Failed to inspect symlink target {}: {e}", src.display()))?;
    let result = if metadata.is_dir() {
        symlink_dir(target, dst)
    } else {
        symlink_file(target, dst)
    };
    result.map_err(|e| format!("Failed to create symlink {}: {e}", dst.display()))?;
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn copy_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    ensure_parent(dst)?;
    fs::copy(src, dst)
        .map_err(|e| format!("Failed to copy symlink target {}: {e}", dst.display()))?;
    Ok(())
}

fn copy_path(src: &Path, dst: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(src)
        .map_err(|e| format!("Failed to inspect source {}: {e}", src.display()))?;

    if metadata.file_type().is_symlink() {
        return copy_symlink(src, dst);
    }

    if metadata.is_dir() {
        fs::create_dir_all(dst)
            .map_err(|e| format!("Failed to create directory {}: {e}", dst.display()))?;
        for entry in fs::read_dir(src)
            .map_err(|e| format!("Failed to read directory {}: {e}", src.display()))?
        {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {e}"))?;
            let name = entry.file_name();
            copy_path(&entry.path(), &dst.join(name))?;
        }
        return Ok(());
    }

    ensure_parent(dst)?;
    fs::copy(src, dst).map_err(|e| {
        format!(
            "Failed to copy file {} -> {}: {e}",
            src.display(),
            dst.display()
        )
    })?;
    Ok(())
}

fn remove_empty_parent_dirs(root: &Path, path: &Path) {
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == root {
            break;
        }
        let is_empty = fs::read_dir(dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            break;
        }
        if fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

fn backup_and_remove_untracked(
    root_path: &str,
    backup_dir: &Path,
    relative_paths: &[String],
) -> Result<(), String> {
    if backup_dir.exists() {
        fs::remove_dir_all(backup_dir)
            .map_err(|e| format!("Failed to reset spotlight backup directory: {e}"))?;
    }
    fs::create_dir_all(backup_dir)
        .map_err(|e| format!("Failed to create spotlight backup directory: {e}"))?;

    let root = Path::new(root_path);
    for relative in relative_paths {
        let src = root.join(relative);
        if !src.exists() && !src.is_symlink() {
            continue;
        }
        let dst = backup_dir.join(relative);
        copy_path(&src, &dst)?;
        remove_path(&src)?;
        remove_empty_parent_dirs(root, &src);
    }

    Ok(())
}

fn restore_untracked(
    root_path: &str,
    backup_dir: &Path,
    relative_paths: &[String],
) -> Result<(), String> {
    let root = Path::new(root_path);
    for relative in relative_paths {
        let src = backup_dir.join(relative);
        if !src.exists() && !src.is_symlink() {
            continue;
        }
        let dst = root.join(relative);
        let _ = remove_path(&dst);
        copy_path(&src, &dst)?;
    }
    if backup_dir.exists() {
        fs::remove_dir_all(backup_dir)
            .map_err(|e| format!("Failed to clean spotlight backup directory: {e}"))?;
    }
    Ok(())
}

fn sync_manifest(manifest: &mut SpotlightManifest) -> Result<(), String> {
    let worktree_root = Path::new(&manifest.worktree_path);
    let root = Path::new(&manifest.root_path);
    let root_tracked: HashSet<String> = manifest.root_tracked_paths.iter().cloned().collect();
    let worktree_tracked_vec = list_tracked_paths(&manifest.worktree_path)?;
    let worktree_tracked: HashSet<String> = worktree_tracked_vec.iter().cloned().collect();
    let previous_spotlight_only: HashSet<String> =
        manifest.spotlight_only_paths.iter().cloned().collect();

    for relative in root_tracked.difference(&worktree_tracked) {
        let target = root.join(relative);
        remove_path(&target)?;
        remove_empty_parent_dirs(root, &target);
    }

    for relative in previous_spotlight_only.difference(&worktree_tracked) {
        let target = root.join(relative);
        remove_path(&target)?;
        remove_empty_parent_dirs(root, &target);
    }

    for relative in &worktree_tracked_vec {
        let src = worktree_root.join(relative);
        let dst = root.join(relative);
        if src.exists() || src.is_symlink() {
            let _ = remove_path(&dst);
            copy_path(&src, &dst)?;
        } else {
            remove_path(&dst)?;
            remove_empty_parent_dirs(root, &dst);
        }
    }

    let mut spotlight_only = worktree_tracked
        .difference(&root_tracked)
        .cloned()
        .collect::<Vec<_>>();
    spotlight_only.sort();
    manifest.spotlight_only_paths = spotlight_only;
    manifest.last_synced_at = Some(now());
    manifest.last_error = None;
    Ok(())
}

fn perform_sync(app: &AppHandle, worktree_id: &str) -> Result<SpotlightStatus, String> {
    let sync_lock = get_sync_lock(worktree_id);
    let _guard = sync_lock.lock().unwrap();

    let mut manifest = load_manifest(app, worktree_id)?
        .ok_or_else(|| format!("Spotlight is not active for worktree: {worktree_id}"))?;
    sync_manifest(&mut manifest)?;
    save_manifest(app, &manifest)?;
    Ok(status_from_manifest(&manifest))
}

fn restore_manifest(app: &AppHandle, manifest: &SpotlightManifest) -> Result<(), String> {
    let current_head = head_sha(&manifest.root_path)?;
    let current_branch = current_branch(&manifest.root_path)?;
    if current_head != manifest.root_head_sha || current_branch != manifest.root_branch {
        return Err(format!(
            "Repository root changed while Spotlight was active (expected {} @ {}, found {} @ {}). Disable manually after restoring the root branch.",
            manifest.root_branch, manifest.root_head_sha, current_branch, current_head
        ));
    }

    for relative in &manifest.spotlight_only_paths {
        let target = Path::new(&manifest.root_path).join(relative);
        remove_path(&target)?;
        remove_empty_parent_dirs(Path::new(&manifest.root_path), &target);
    }

    let restore_output = silent_command("git")
        .args(["restore", "--source=HEAD", "--staged", "--worktree", "."])
        .current_dir(&manifest.root_path)
        .output()
        .map_err(|e| format!("Failed to restore repository root: {e}"))?;
    if !restore_output.status.success() {
        return Err(String::from_utf8_lossy(&restore_output.stderr)
            .trim()
            .to_string());
    }

    if let Some(stash_message) = &manifest.tracked_stash_message {
        if let Some(stash_ref) = find_stash_ref(&manifest.root_path, stash_message)? {
            pop_stash(&manifest.root_path, &stash_ref)?;
        }
    }

    let backup_dir = backup_dir_path(app, &manifest.recovery_id)?;
    restore_untracked(
        &manifest.root_path,
        &backup_dir,
        &manifest.moved_untracked_paths,
    )?;
    remove_manifest(app, &manifest.worktree_id)?;
    Ok(())
}

fn start_watcher(app: AppHandle, manifest: SpotlightManifest) {
    stop_watcher(&manifest.worktree_id);

    let stop_flag = Arc::new(AtomicBool::new(false));
    WATCHERS
        .lock()
        .unwrap()
        .insert(manifest.worktree_id.clone(), stop_flag.clone());

    thread::spawn(move || {
        let mut last_fingerprint = tracked_changes_fingerprint(&manifest.worktree_path).ok();
        while !stop_flag.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(WATCH_INTERVAL_MS));
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }

            let fingerprint = match tracked_changes_fingerprint(&manifest.worktree_path) {
                Ok(value) => value,
                Err(error) => {
                    log::warn!(
                        "Spotlight watcher failed to fingerprint {}: {}",
                        manifest.worktree_id,
                        error
                    );
                    continue;
                }
            };

            if last_fingerprint.as_deref() == Some(fingerprint.as_str()) {
                continue;
            }

            thread::sleep(Duration::from_millis(WATCH_DEBOUNCE_MS));
            let stable_fingerprint = match tracked_changes_fingerprint(&manifest.worktree_path) {
                Ok(value) => value,
                Err(error) => {
                    log::warn!(
                        "Spotlight watcher failed after debounce {}: {}",
                        manifest.worktree_id,
                        error
                    );
                    continue;
                }
            };

            if last_fingerprint.as_deref() == Some(stable_fingerprint.as_str()) {
                continue;
            }

            match perform_sync(&app, &manifest.worktree_id) {
                Ok(_) => {
                    last_fingerprint = Some(stable_fingerprint);
                }
                Err(error) => {
                    log::error!(
                        "Spotlight auto-sync failed for {}: {}",
                        manifest.worktree_id,
                        error
                    );
                    if let Ok(Some(mut current)) = load_manifest(&app, &manifest.worktree_id) {
                        current.last_error = Some(error);
                        let _ = save_manifest(&app, &current);
                    }
                    stop_flag.store(true, Ordering::SeqCst);
                    WATCHERS.lock().unwrap().remove(&manifest.worktree_id);
                    break;
                }
            }
        }
    });
}

fn status_from_manifest(manifest: &SpotlightManifest) -> SpotlightStatus {
    SpotlightStatus {
        worktree_id: manifest.worktree_id.clone(),
        project_id: manifest.project_id.clone(),
        worktree_path: manifest.worktree_path.clone(),
        root_path: manifest.root_path.clone(),
        active: true,
        last_synced_at: manifest.last_synced_at,
        restore_pending: manifest.restore_pending,
        recovery_id: manifest.recovery_id.clone(),
        last_error: manifest.last_error.clone(),
    }
}

pub fn is_worktree_spotlight_active(app: &AppHandle, worktree_id: &str) -> bool {
    load_manifest(app, worktree_id).ok().flatten().is_some()
}

#[tauri::command]
pub async fn list_spotlights(app: AppHandle) -> Result<Vec<SpotlightStatus>, String> {
    let manifests = load_all_manifests(&app)?;
    Ok(manifests.iter().map(status_from_manifest).collect())
}

#[tauri::command]
pub async fn activate_spotlight(
    app: AppHandle,
    worktree_id: String,
) -> Result<SpotlightStatus, String> {
    if let Some(existing) = load_manifest(&app, &worktree_id)? {
        return Ok(status_from_manifest(&existing));
    }

    let data = load_projects_data(&app)?;
    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?
        .clone();
    if worktree.session_type == SessionType::Base {
        return Err("Spotlight is only available for worktrees".to_string());
    }
    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?
        .clone();

    for manifest in load_all_manifests(&app)? {
        if manifest.project_id == worktree.project_id {
            return Err("Another Spotlight is already active for this project".to_string());
        }
    }

    if git_operation_in_progress(&worktree.path)? || git_operation_in_progress(&project.path)? {
        return Err(
            "Cannot start Spotlight while a merge, rebase, cherry-pick, or bisect is in progress"
                .to_string(),
        );
    }

    let recovery_id = worktree.id.clone();
    let root_tracked_paths = list_tracked_paths(&project.path)?;
    let moved_untracked_paths = list_untracked_paths(&project.path)?;
    let tracked_stash_message =
        stash_tracked_changes(&project.path, &unique_stash_message(&worktree.id))?;
    let backup_dir = backup_dir_path(&app, &recovery_id)?;
    backup_and_remove_untracked(&project.path, &backup_dir, &moved_untracked_paths)?;

    let mut manifest = SpotlightManifest {
        worktree_id: worktree.id.clone(),
        project_id: worktree.project_id.clone(),
        worktree_path: worktree.path.clone(),
        root_path: project.path.clone(),
        recovery_id,
        root_head_sha: head_sha(&project.path)?,
        root_branch: current_branch(&project.path)?,
        root_tracked_paths,
        spotlight_only_paths: Vec::new(),
        moved_untracked_paths,
        tracked_stash_message,
        started_at: now(),
        last_synced_at: None,
        restore_pending: true,
        last_error: None,
    };

    sync_manifest(&mut manifest)?;
    save_manifest(&app, &manifest)?;
    start_watcher(app.clone(), manifest.clone());
    Ok(status_from_manifest(&manifest))
}

#[tauri::command]
pub async fn sync_spotlight(
    app: AppHandle,
    worktree_id: String,
) -> Result<SpotlightStatus, String> {
    let status = perform_sync(&app, &worktree_id)?;
    if let Some(manifest) = load_manifest(&app, &worktree_id)? {
        start_watcher(app.clone(), manifest);
    }
    Ok(status)
}

#[tauri::command]
pub async fn deactivate_spotlight(app: AppHandle, worktree_id: String) -> Result<(), String> {
    stop_watcher(&worktree_id);
    let manifest = load_manifest(&app, &worktree_id)?
        .ok_or_else(|| format!("Spotlight is not active for worktree: {worktree_id}"))?;
    restore_manifest(&app, &manifest)
}

#[tauri::command]
pub async fn recover_spotlights(app: AppHandle) -> Result<u32, String> {
    let manifests = load_all_manifests(&app)?;
    let mut recovered = 0;
    for manifest in manifests {
        stop_watcher(&manifest.worktree_id);
        match restore_manifest(&app, &manifest) {
            Ok(_) => {
                recovered += 1;
            }
            Err(error) => {
                log::error!(
                    "Failed to recover spotlight for {}: {}",
                    manifest.worktree_id,
                    error
                );
            }
        }
    }
    Ok(recovered)
}
