//! Secrets the user enters on a `request_secret` card (Jean MCP).
//!
//! The value never enters chat history, run logs, or model context. It goes to
//! an owner-only file under `<app_data>/secrets/`; the agent gets only the path
//! and reads it inside a shell command. Same model as t3code's `file` delivery:
//! no encryption, because the agent's shell must read the plain value anyway.
//!
//! The file name comes from the session and tool call ids, so the card can
//! find its file again (status, forget) without an index. The user picks the
//! retention: kept until forgotten (periodic tasks need this) or 24 hours.
//! A `<stem>.json` file beside each value holds its label and ids, so the
//! `list_secrets` card can list and delete secrets without reading values.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_SECRET_BYTES: usize = 16 * 1024;
/// File name suffix of secrets the sweep deletes after 24 hours.
const DAY_SUFFIX: &str = "-24h";
const META_EXT: &str = ".json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretRetention {
    /// Kept until the user forgets it.
    Forever,
    Day,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSecret {
    pub path: String,
    pub retention: SecretRetention,
}

/// Metadata of a saved secret. Never holds the value or its path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEntry {
    /// File stem; the id for `delete_secret`.
    #[serde(default)]
    pub id: String,
    pub label: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub retention: SecretRetention,
    /// Unix seconds.
    pub saved_at: u64,
}

fn secrets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(app_data.join("secrets"))
}

/// Stable file stem of one `request_secret` call.
fn file_stem(session_id: &str, tool_call_id: &str) -> String {
    let key = format!("{session_id}\u{0}{tool_call_id}");
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, key.as_bytes())
        .simple()
        .to_string()
}

fn file_path(dir: &Path, stem: &str, retention: SecretRetention) -> PathBuf {
    match retention {
        SecretRetention::Forever => dir.join(stem),
        SecretRetention::Day => dir.join(format!("{stem}{DAY_SUFFIX}")),
    }
}

fn meta_path(dir: &Path, stem: &str) -> PathBuf {
    dir.join(format!("{stem}{META_EXT}"))
}

fn find_saved(dir: &Path, stem: &str) -> Option<SavedSecret> {
    [SecretRetention::Forever, SecretRetention::Day]
        .into_iter()
        .map(|retention| (retention, file_path(dir, stem, retention)))
        .find(|(_, path)| path.is_file())
        .map(|(retention, path)| SavedSecret {
            path: path.to_string_lossy().into_owned(),
            retention,
        })
}

/// Save the secret of a `request_secret` card and return its file path.
pub fn save_secret_request(
    app: tauri::AppHandle,
    session_id: String,
    tool_call_id: String,
    label: String,
    secret: String,
    retention: SecretRetention,
) -> Result<SavedSecret, String> {
    let dir = secrets_dir(&app)?;
    sweep_expired(&dir);
    let stem = file_stem(&session_id, &tool_call_id);
    let saved = write_secret_file(&dir, &stem, &secret, retention)?;
    let saved_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let entry = SecretEntry {
        id: stem.clone(),
        label: label.trim().chars().take(80).collect(),
        session_id,
        tool_call_id,
        retention,
        saved_at,
    };
    if let Err(e) = write_meta(&dir, &stem, &entry) {
        let _ = forget(&dir, &stem);
        return Err(e);
    }
    Ok(saved)
}

/// All saved secrets, newest first. Labels and ids only, never values.
pub fn list_secrets(app: tauri::AppHandle) -> Result<Vec<SecretEntry>, String> {
    let dir = secrets_dir(&app)?;
    sweep_expired(&dir);
    Ok(list_entries(&dir))
}

/// Delete a saved secret by its id from `list_secrets`.
pub fn delete_secret(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid secret id".to_string());
    }
    forget(&secrets_dir(&app)?, &id)
}

/// The saved secret of a `request_secret` card, if its file still exists.
pub fn secret_request_status(
    app: tauri::AppHandle,
    session_id: String,
    tool_call_id: String,
) -> Result<Option<SavedSecret>, String> {
    let dir = secrets_dir(&app)?;
    Ok(find_saved(&dir, &file_stem(&session_id, &tool_call_id)))
}

/// Delete the saved secret of a `request_secret` card. No-op when it is gone.
pub fn forget_secret_request(
    app: tauri::AppHandle,
    session_id: String,
    tool_call_id: String,
) -> Result<(), String> {
    let dir = secrets_dir(&app)?;
    forget(&dir, &file_stem(&session_id, &tool_call_id))
}

/// Delete expired 24-hour secrets. Called at startup, hourly, and on save.
pub fn sweep_expired_secrets(app: &tauri::AppHandle) {
    if let Ok(dir) = secrets_dir(app) {
        sweep_expired(&dir);
    }
}

fn write_secret_file(
    dir: &Path,
    stem: &str,
    secret: &str,
    retention: SecretRetention,
) -> Result<SavedSecret, String> {
    let value = secret.trim();
    if value.is_empty() {
        return Err("The secret is empty".to_string());
    }
    if value.len() > MAX_SECRET_BYTES {
        return Err(format!(
            "The secret is too long (max {MAX_SECRET_BYTES} bytes)"
        ));
    }
    if find_saved(dir, stem).is_some() {
        return Err("This secret is already saved. Forget it first.".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create secrets dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed to secure secrets dir: {e}"))?;
    }

    let path = file_path(dir, stem, retention);
    let partial = dir.join(format!("{stem}.partial"));
    let _ = std::fs::remove_file(&partial);
    let mut options = std::fs::OpenOptions::new();
    // create_new never follows or replaces an existing path.
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write = options.open(&partial).and_then(|mut file| {
        use std::io::Write;
        file.write_all(value.as_bytes())?;
        file.sync_all()
    });
    if let Err(e) = write.and_then(|()| std::fs::rename(&partial, &path)) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("Failed to save the secret: {e}"));
    }
    Ok(SavedSecret {
        path: path.to_string_lossy().into_owned(),
        retention,
    })
}

fn write_meta(dir: &Path, stem: &str, entry: &SecretEntry) -> Result<(), String> {
    let json =
        serde_json::to_vec(entry).map_err(|e| format!("Failed to encode secret info: {e}"))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(meta_path(dir, stem))
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(&json)
        })
        .map_err(|e| format!("Failed to save secret info: {e}"))
}

fn list_entries(dir: &Path) -> Vec<SecretEntry> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<SecretEntry> = read
        .flatten()
        .filter_map(|file| {
            let name = file.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(META_EXT)?.to_string();
            if find_saved(dir, &stem).is_none() {
                // The value is gone (sweep or a failed save): drop its info
                let _ = std::fs::remove_file(file.path());
                return None;
            }
            let bytes = std::fs::read(file.path()).ok()?;
            let mut entry: SecretEntry = serde_json::from_slice(&bytes).ok()?;
            entry.id = stem;
            Some(entry)
        })
        .collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.saved_at));
    entries
}

fn forget(dir: &Path, stem: &str) -> Result<(), String> {
    let paths = [
        file_path(dir, stem, SecretRetention::Forever),
        file_path(dir, stem, SecretRetention::Day),
        meta_path(dir, stem),
    ];
    for path in paths {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to delete the secret: {e}")),
        }
    }
    Ok(())
}

/// Delete 24-hour secrets and leftover `.partial` files older than a day.
fn sweep_expired(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(DAY_SUFFIX) && !name.ends_with(".partial") {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > DAY);
        if expired {
            if let Err(e) = std::fs::remove_file(entry.path()) {
                log::warn!("Failed to delete expired secret file: {e}");
            }
            if let Some(stem) = name.strip_suffix(DAY_SUFFIX) {
                let _ = std::fs::remove_file(meta_path(dir, stem));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn age(path: &Path, by: Duration) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - by).unwrap();
    }

    #[test]
    fn writes_trimmed_value_to_owner_only_file_per_request() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("secrets");
        let first = write_secret_file(
            &dir,
            &file_stem("s1", "t1"),
            "  tskey-abc \n",
            SecretRetention::Forever,
        )
        .unwrap();
        let second = write_secret_file(
            &dir,
            &file_stem("s1", "t2"),
            "tskey-abc",
            SecretRetention::Day,
        )
        .unwrap();

        assert_ne!(first.path, second.path);
        assert!(second.path.ends_with(DAY_SUFFIX));
        assert_eq!(std::fs::read_to_string(&first.path).unwrap(), "tskey-abc");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(Path::new(&first.path)), 0o600);
            assert_eq!(mode(&dir), 0o700);
        }
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            2,
            "no .partial files remain"
        );
    }

    #[test]
    fn rejects_empty_oversized_and_duplicate_values() {
        let tmp = tempfile::tempdir().unwrap();
        let stem = file_stem("s1", "t1");
        let save = |value: &str| write_secret_file(tmp.path(), &stem, value, SecretRetention::Day);
        assert!(save("  \n").is_err());
        assert!(save(&"x".repeat(MAX_SECRET_BYTES + 1)).is_err());
        save("one").unwrap();
        assert!(save("two").is_err());
        assert!(write_secret_file(tmp.path(), &stem, "two", SecretRetention::Forever).is_err());
    }

    #[test]
    fn forget_deletes_the_request_file_so_it_can_be_saved_again() {
        let tmp = tempfile::tempdir().unwrap();
        let stem = file_stem("s1", "t1");
        let saved = write_secret_file(tmp.path(), &stem, "one", SecretRetention::Forever).unwrap();
        assert_eq!(find_saved(tmp.path(), &stem).unwrap().path, saved.path);

        forget(tmp.path(), &stem).unwrap();
        assert!(find_saved(tmp.path(), &stem).is_none());
        forget(tmp.path(), &stem).unwrap();
        write_secret_file(tmp.path(), &stem, "two", SecretRetention::Day).unwrap();
    }

    fn entry(stem: &str, label: &str, saved_at: u64) -> SecretEntry {
        SecretEntry {
            id: String::new(),
            label: label.to_string(),
            session_id: "s1".to_string(),
            tool_call_id: "t".to_string(),
            retention: SecretRetention::Forever,
            saved_at,
        }
        .with_id(stem)
    }

    impl SecretEntry {
        fn with_id(mut self, id: &str) -> Self {
            self.id = id.to_string();
            self
        }
    }

    #[test]
    fn lists_saved_secrets_newest_first_without_values() {
        let tmp = tempfile::tempdir().unwrap();
        let (old, new, orphan) = (
            file_stem("s1", "a"),
            file_stem("s1", "b"),
            file_stem("s1", "c"),
        );
        for (stem, label, at) in [(&old, "Old key", 10), (&new, "New key", 20)] {
            write_secret_file(tmp.path(), stem, "secret-value", SecretRetention::Forever).unwrap();
            write_meta(tmp.path(), stem, &entry(stem, label, at)).unwrap();
        }
        write_meta(tmp.path(), &orphan, &entry(&orphan, "Gone", 30)).unwrap();

        let listed = list_entries(tmp.path());

        assert_eq!(
            listed,
            vec![entry(&new, "New key", 20), entry(&old, "Old key", 10)]
        );
        assert!(!serde_json::to_string(&listed)
            .unwrap()
            .contains("secret-value"));
        assert!(
            !meta_path(tmp.path(), &orphan).exists(),
            "orphan info removed"
        );

        forget(tmp.path(), &new).unwrap();
        assert_eq!(list_entries(tmp.path()), vec![entry(&old, "Old key", 10)]);
    }

    #[test]
    fn sweep_deletes_only_expired_day_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let save = |tool: &str, retention| {
            PathBuf::from(
                write_secret_file(tmp.path(), &file_stem("s1", tool), "v", retention)
                    .unwrap()
                    .path,
            )
        };
        let fresh_day = save("t1", SecretRetention::Day);
        let old_day = save("t2", SecretRetention::Day);
        let old_forever = save("t3", SecretRetention::Forever);
        age(&old_day, DAY + Duration::from_secs(60));
        age(&old_forever, DAY * 30);

        sweep_expired(tmp.path());

        assert!(fresh_day.exists());
        assert!(!old_day.exists());
        assert!(old_forever.exists());
    }
}
