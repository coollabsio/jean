use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use tauri::AppHandle;
use uuid::Uuid;

use super::types::ProjectsData;

/// Global mutex to prevent concurrent read-modify-write races on projects.json.
/// Multiple threads (e.g., fetch_worktrees_status) can call save_projects_data simultaneously,
/// causing race conditions with the atomic write pattern (temp file + rename).
static PROJECTS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

const PROJECTS_BACKUP_COUNT: usize = 3;

/// Get the path to the projects.json data file
pub fn get_projects_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    // Ensure the directory exists
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    Ok(app_data_dir.join("projects.json"))
}

/// Get the base directory for all worktrees (~/jean)
///
/// When WSL mode is enabled, the base dir is inside WSL (e.g., `/home/<user>/jean/`)
/// stored as a Windows UNC path: `\\wsl.localhost\<distro>\home\<user>\jean\`
pub fn get_worktrees_base_dir() -> Result<PathBuf, String> {
    let wsl = crate::platform::get_wsl_config();
    if wsl.enabled {
        // Get the WSL home directory and construct the base dir
        let wsl_home = crate::platform::get_wsl_home_dir(&wsl.distro)?;
        let wsl_jean_dir = format!("{wsl_home}/jean");
        // Convert to Windows UNC path for std::fs operations
        let win_path = crate::platform::wsl_to_win_path(&wsl_jean_dir, &wsl.distro);
        let jean_dir = PathBuf::from(&win_path);

        // Ensure the directory exists (via WSL since UNC mkdir can be unreliable)
        let output = crate::platform::silent_command("wsl.exe")
            .args(["-d", &wsl.distro, "--", "mkdir", "-p", &wsl_jean_dir])
            .output()
            .map_err(|e| format!("Failed to create WSL worktrees base dir: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("Failed to create WSL worktrees base dir: {stderr}"));
        }

        return Ok(jean_dir);
    }

    let home_dir = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;

    let jean_dir = home_dir.join("jean");

    // Ensure the directory exists
    std::fs::create_dir_all(&jean_dir)
        .map_err(|e| format!("Failed to create jean directory: {e}"))?;

    Ok(jean_dir)
}

/// Get the directory for a specific project's worktrees.
/// When `custom_base_dir` is Some, uses that instead of ~/jean as the base.
/// In both cases, `<project-name>` subdirectory is appended.
pub fn get_project_worktrees_dir(
    project_name: &str,
    custom_base_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let base_dir = match custom_base_dir {
        Some(dir) => PathBuf::from(dir),
        None => get_worktrees_base_dir()?,
    };
    let project_dir = base_dir.join(sanitize_directory_name(project_name));

    // Ensure the directory exists
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create project worktrees directory: {e}"))?;

    Ok(project_dir)
}

/// Sanitize a string for use as a directory name
pub fn sanitize_directory_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn projects_backup_path(path: &Path, generation: usize) -> PathBuf {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| std::borrow::Cow::Borrowed("projects.json"));
    let suffix = if generation == 0 {
        ".bak".to_string()
    } else {
        format!(".bak.{generation}")
    };
    path.with_file_name(format!("{filename}{suffix}"))
}

fn projects_temp_path(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| std::borrow::Cow::Borrowed("projects.json"));
    path.with_file_name(format!("{filename}.tmp-{}", Uuid::new_v4()))
}

/// Flush a directory entry update where the platform supports opening and syncing directories.
/// Windows uses write-through replacement plus a synced temp file instead; opening a directory as
/// a File is not supported by the Windows standard library.
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::fs::File;

        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        File::open(parent)?.sync_all()
    }

    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(windows)]
fn replace_file_atomically(temp_path: &Path, path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        REPLACEFILE_WRITE_THROUGH,
    };

    let target_exists = path.exists();
    let temp_path: Vec<u16> = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let result = unsafe {
        if target_exists {
            ReplaceFileW(
                path.as_ptr(),
                temp_path.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        } else {
            MoveFileExW(
                temp_path.as_ptr(),
                path.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };

    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(temp_path: &Path, path: &Path) -> io::Result<()> {
    fs::rename(temp_path, path)
}

/// Write a file to a unique sibling temp file, flush its contents, then atomically replace the
/// destination. The old destination is never opened for writing, so a power loss cannot turn it
/// into a partially-written or NUL-filled file.
fn write_file_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let temp_path = projects_temp_path(path);
    let mut temp_created = false;
    let result = (|| {
        let mut temp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp_created = true;
        temp_file.write_all(contents)?;
        temp_file.sync_all()?;
        drop(temp_file);

        replace_file_atomically(&temp_path, path)?;
        sync_parent_directory(path)
    })();

    if temp_created && result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result
}

fn rotate_projects_backups(path: &Path, current_contents: &[u8]) -> Result<(), String> {
    for generation in (1..PROJECTS_BACKUP_COUNT).rev() {
        let source = projects_backup_path(path, generation - 1);
        if !source.exists() {
            continue;
        }

        let contents = fs::read(&source)
            .map_err(|e| format!("Failed to read projects backup {}: {e}", source.display()))?;
        let target = projects_backup_path(path, generation);
        write_file_atomically(&target, &contents)
            .map_err(|e| format!("Failed to rotate projects backup {}: {e}", target.display()))?;
    }

    let latest = projects_backup_path(path, 0);
    write_file_atomically(&latest, current_contents)
        .map_err(|e| format!("Failed to write projects backup {}: {e}", latest.display()))
}

fn save_projects_data_file(path: &Path, data: &ProjectsData) -> Result<(), String> {
    let json_content = serde_json::to_string_pretty(data).map_err(|e| {
        log::error!("Failed to serialize projects data: {e}");
        format!("Failed to serialize projects data: {e}")
    })?;

    if path.exists() {
        let current_contents = fs::read(path).map_err(|e| {
            log::error!("Failed to read projects file before saving: {e}");
            format!("Failed to read projects file before saving: {e}")
        })?;
        rotate_projects_backups(path, &current_contents)?;
    }

    write_file_atomically(path, json_content.as_bytes()).map_err(|e| {
        log::error!("Failed to finalize projects file: {e}");
        format!("Failed to finalize projects file: {e}")
    })
}

fn parse_projects_bytes(path: &Path, contents: &[u8]) -> Result<ProjectsData, String> {
    serde_json::from_slice(contents).map_err(|e| {
        log::error!("Failed to parse projects JSON at {}: {e}", path.display());
        format!("Failed to parse projects data: {e}")
    })
}

fn recovery_candidates(path: &Path) -> Vec<PathBuf> {
    let mut candidates = (0..PROJECTS_BACKUP_COUNT)
        .map(|generation| projects_backup_path(path, generation))
        .collect::<Vec<_>>();

    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "projects.json".to_string());
    let legacy_temp = path.with_file_name(format!("{filename}.tmp"));
    if legacy_temp.is_file() {
        candidates.push(legacy_temp);
    }

    if let Some(parent) = path.parent() {
        if let Ok(entries) = fs::read_dir(parent) {
            let mut temp_files = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|candidate| {
                    candidate.is_file()
                        && candidate
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with(&format!("{filename}.tmp-")))
                })
                .collect::<Vec<_>>();
            temp_files.sort_by_key(|candidate| {
                fs::metadata(candidate)
                    .and_then(|metadata| metadata.modified())
                    .ok()
            });
            temp_files.reverse();
            candidates.extend(temp_files);
        }
    }

    candidates
}

fn preserve_corrupt_projects_file(path: &Path, contents: &[u8]) -> Option<PathBuf> {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| std::borrow::Cow::Borrowed("projects.json"));
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let corrupt_path =
        path.with_file_name(format!("{filename}.corrupt-{timestamp}-{}", Uuid::new_v4()));

    match write_file_atomically(&corrupt_path, contents) {
        Ok(()) => Some(corrupt_path),
        Err(error) => {
            log::warn!(
                "Failed to preserve corrupt projects file {}: {error}",
                path.display()
            );
            None
        }
    }
}

fn load_projects_file_with_recovery(path: &Path) -> Result<ProjectsData, String> {
    let (primary_contents, primary_error, primary_missing) = match fs::read(path) {
        Ok(contents) => match parse_projects_bytes(path, &contents) {
            Ok(data) => return Ok(data),
            Err(error) => (Some(contents), error, false),
        },
        Err(error) => (
            None,
            format!("Failed to read projects file: {error}"),
            error.kind() == io::ErrorKind::NotFound,
        ),
    };

    for candidate in recovery_candidates(path) {
        let Ok(contents) = fs::read(&candidate) else {
            continue;
        };
        let Ok(data) = parse_projects_bytes(&candidate, &contents) else {
            log::warn!(
                "Ignoring invalid projects recovery candidate {}",
                candidate.display()
            );
            continue;
        };

        let corrupt_path = primary_contents
            .as_deref()
            .and_then(|contents| preserve_corrupt_projects_file(path, contents));
        write_file_atomically(path, &contents).map_err(|error| {
            format!(
                "Recovered projects data from {} but failed to restore {}: {error}",
                candidate.display(),
                path.display()
            )
        })?;

        log::warn!(
            "Recovered projects data from {} into {}{}",
            candidate.display(),
            path.display(),
            corrupt_path
                .as_ref()
                .map(|path| format!("; preserved corrupt file at {}", path.display()))
                .unwrap_or_default()
        );
        return Ok(data);
    }

    if primary_missing {
        log::trace!("Projects file not found, returning empty data");
        return Ok(ProjectsData::default());
    }

    Err(format!(
        "Projects data is corrupt at {}: {primary_error}. No valid backup could be recovered; the original file was left untouched.",
        path.display()
    ))
}

/// Load projects data from disk (internal, no locking)
fn load_projects_data_internal(app: &AppHandle) -> Result<ProjectsData, String> {
    log::trace!("Loading projects data from disk");
    let path = get_projects_path(app)?;

    let mut data = load_projects_file_with_recovery(&path)?;

    for worktree in &mut data.worktrees {
        worktree.normalize_labels();
    }

    let original_count = data.worktrees.len();

    // Filter out worktrees where path doesn't exist on disk
    // Skip recently created worktrees (< 5 min) - they may still be initializing in a background thread
    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let five_minutes_ago = now_ts.saturating_sub(300);

    let valid_worktrees: Vec<_> = data
        .worktrees
        .into_iter()
        .filter(|w| {
            let exists = std::path::Path::new(&w.path).exists();
            if !exists {
                if w.created_at > five_minutes_ago {
                    log::trace!(
                        "Keeping recently created worktree '{}' - path doesn't exist yet (created {}s ago)",
                        w.name,
                        now_ts - w.created_at
                    );
                    return true;
                }
                log::warn!(
                    "Removing orphaned worktree '{}' - path does not exist: {}",
                    w.name,
                    w.path
                );
            }
            exists
        })
        .collect();

    let removed_count = original_count - valid_worktrees.len();

    let data = ProjectsData {
        projects: data.projects,
        worktrees: valid_worktrees,
    };

    // Save cleaned data if any orphans were removed
    if removed_count > 0 {
        log::trace!("Cleaned up {removed_count} orphaned worktree(s)");
        save_projects_data_internal(app, &data)?;
    }

    log::trace!(
        "Loaded {} projects and {} worktrees",
        data.projects.len(),
        data.worktrees.len()
    );
    crate::auto_fix::scheduler::refresh_auto_fix_scan_cache(&data.projects);
    Ok(data)
}

/// Load projects data from disk (with locking for thread safety)
pub fn load_projects_data(app: &AppHandle) -> Result<ProjectsData, String> {
    let _lock = PROJECTS_LOCK.lock().unwrap();
    load_projects_data_internal(app)
}

/// Save projects data to disk (internal, no locking - durable atomic write with backups)
fn save_projects_data_internal(app: &AppHandle, data: &ProjectsData) -> Result<(), String> {
    log::trace!("Saving projects data to disk");
    let path = get_projects_path(app)?;

    save_projects_data_file(&path, data)?;

    log::trace!(
        "Saved {} projects and {} worktrees to {path:?}",
        data.projects.len(),
        data.worktrees.len()
    );
    crate::auto_fix::scheduler::refresh_auto_fix_scan_cache(&data.projects);
    Ok(())
}

/// Save projects data to disk (with locking for thread safety)
pub fn save_projects_data(app: &AppHandle, data: &ProjectsData) -> Result<(), String> {
    let _lock = PROJECTS_LOCK.lock().unwrap();
    save_projects_data_internal(app, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_directory_name() {
        assert_eq!(sanitize_directory_name("my-project"), "my-project");
        assert_eq!(sanitize_directory_name("my project"), "my-project");
        assert_eq!(sanitize_directory_name("my/project"), "my-project");
        assert_eq!(sanitize_directory_name("my_project"), "my_project");
        assert_eq!(sanitize_directory_name("MyProject123"), "MyProject123");
    }

    fn test_data(project_id: &str) -> ProjectsData {
        serde_json::from_value(serde_json::json!({
            "projects": [{
                "id": project_id,
                "name": project_id,
                "path": "",
                "default_branch": "main",
                "added_at": 1
            }],
            "worktrees": []
        }))
        .expect("valid project test data")
    }

    #[test]
    fn durable_atomic_write_replaces_file_without_leaving_a_shared_temp_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("projects.json");

        write_file_atomically(&path, br#"{"version":1}"#).expect("first write");
        write_file_atomically(&path, br#"{"version":2}"#).expect("second write");

        assert_eq!(fs::read(&path).expect("read result"), br#"{"version":2}"#);
        assert!(!directory.path().join("projects.json.tmp").exists());
    }

    #[test]
    fn save_rotates_previous_projects_data_into_recoverable_backups() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("projects.json");
        let first = test_data("first");
        let second = test_data("second");
        let third = test_data("third");

        save_projects_data_file(&path, &first).expect("first save");
        save_projects_data_file(&path, &second).expect("second save");
        save_projects_data_file(&path, &third).expect("third save");

        let latest_backup: ProjectsData = serde_json::from_slice(
            &fs::read(projects_backup_path(&path, 0)).expect("latest backup"),
        )
        .expect("latest backup JSON");
        let older_backup: ProjectsData = serde_json::from_slice(
            &fs::read(projects_backup_path(&path, 1)).expect("older backup"),
        )
        .expect("older backup JSON");

        assert!(latest_backup.find_project("second").is_some());
        assert!(older_backup.find_project("first").is_some());
    }

    #[test]
    fn corrupt_primary_is_quarantined_and_restored_from_backup() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("projects.json");
        let first = test_data("first");
        let second = test_data("second");

        save_projects_data_file(&path, &first).expect("first save");
        save_projects_data_file(&path, &second).expect("second save");
        fs::write(&path, vec![0; 128]).expect("corrupt primary");

        let recovered = load_projects_file_with_recovery(&path).expect("recover projects");

        assert!(recovered.find_project("first").is_some());
        assert!(recovered.find_project("second").is_none());
        assert!(serde_json::from_slice::<ProjectsData>(
            &fs::read(&path).expect("restored primary")
        )
        .is_ok());
        assert!(fs::read_dir(directory.path())
            .expect("read directory")
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("projects.json.corrupt-")
            }));
    }

    #[test]
    fn corrupt_primary_without_a_valid_recovery_source_returns_an_error() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("projects.json");
        fs::write(&path, vec![0; 128]).expect("corrupt primary");

        let error = load_projects_file_with_recovery(&path).expect_err("corrupt data error");

        assert!(error.contains("Projects data is corrupt"));
        assert_eq!(fs::read(&path).expect("original primary"), vec![0; 128]);
    }
}
