//! Cross-platform file persistence helpers.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

/// Resolve the file that a write to `path` must update.
///
/// An atomic rename replaces a symlink itself, so a symlinked `path` resolves
/// through its whole chain (absolute or relative links, symlinked parents).
/// Other paths, including new files, return unchanged. A dangling link or a
/// cycle is an error, so the caller never replaces the link with a file.
pub fn resolve_write_target(path: &Path) -> Result<PathBuf, String> {
    let is_symlink = fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink());
    if !is_symlink {
        return Ok(path.to_path_buf());
    }

    fs::canonicalize(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!(
                "{} is a symlink to a missing file; create the target or remove the link",
                path.display()
            )
        } else {
            format!("Failed to resolve symlink {}: {error}", path.display())
        }
    })
}

fn temporary_path(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| std::borrow::Cow::Borrowed("file"));

    path.with_file_name(format!("{filename}.tmp-{}", Uuid::new_v4()))
}

/// Flush a directory entry update where the platform supports opening and syncing directories.
/// Windows does not support opening a directory as a `File` through the standard library.
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::File::open(parent)?.sync_all()
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

    // ReplaceFileW preserves the destination's metadata when it exists. If the
    // destination was removed between the existence check and this call, use
    // MoveFileExW as a race-safe fallback.
    if target_exists {
        let replaced = unsafe {
            ReplaceFileW(
                path.as_ptr(),
                temp_path.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        };

        if replaced != 0 {
            return Ok(());
        }
    }

    let moved = unsafe {
        MoveFileExW(
            temp_path.as_ptr(),
            path.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(temp_path: &Path, path: &Path) -> io::Result<()> {
    fs::rename(temp_path, path)
}

/// Write bytes through a unique sibling temp file and atomically replace `path`.
///
/// A symlinked `path` keeps its link: the write replaces the resolved target.
///
/// POSIX `rename` replaces an existing destination. Windows requires the native
/// replacement APIs instead; using `std::fs::rename` there silently turns every
/// update after the first successful write into an error.
pub fn write_file_atomically(path: &Path, contents: &[u8]) -> Result<(), String> {
    let path = &resolve_write_target(path)?;
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create parent directory: {error}"))?;
    }

    let temp_path = temporary_path(path);
    let mut temp_created = false;
    let result = (|| {
        let mut temp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp_created = true;
        temp_file.write_all(contents)?;

        // A POSIX rename installs the temp file's mode at the destination.
        // Keep restrictive modes on existing preference and configuration files.
        #[cfg(unix)]
        if let Ok(metadata) = fs::metadata(path) {
            temp_file.set_permissions(metadata.permissions())?;
        }

        temp_file.sync_all()?;
        drop(temp_file);

        replace_file_atomically(&temp_path, path)?;
        sync_parent_directory(path)
    })();

    if temp_created && result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result.map_err(|error| format!("Failed to atomically replace {}: {error}", path.display()))
}

/// Copy the existing file to a timestamped `.bak` sibling, then write atomically.
///
/// Returns the backup path, or `None` when there was no file to back up. The
/// backup sits next to the resolved target, so it matches the file that changed.
pub fn write_file_atomically_with_backup(
    path: &Path,
    contents: &[u8],
) -> Result<Option<PathBuf>, String> {
    let path = &resolve_write_target(path)?;
    let backup = if path.exists() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        let backup = path.with_extension(format!(
            "{}.bak.{ts}",
            path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("config")
        ));
        fs::copy(path, &backup)
            .map_err(|e| format!("Failed to create backup {}: {e}", backup.display()))?;
        Some(backup)
    } else {
        None
    };

    write_file_atomically(path, contents)?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_an_existing_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("state.json");

        write_file_atomically(&path, br#"{"version":1}"#).expect("first write");
        write_file_atomically(&path, br#"{"version":2}"#).expect("second write");

        assert_eq!(fs::read(&path).expect("read result"), br#"{"version":2}"#);
        let has_temp_file = fs::read_dir(directory.path())
            .expect("read directory")
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("state.json.tmp-")
            });
        assert!(!has_temp_file);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("settings.json");
        fs::write(&path, b"old").expect("initial write");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("set permissions");

        write_file_atomically(&path, b"new").expect("replace file");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    mod symlinks {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        fn assert_link_kept(link: &Path, target: &Path, contents: &[u8]) {
            assert!(fs::symlink_metadata(link)
                .expect("link metadata")
                .file_type()
                .is_symlink());
            assert_eq!(fs::read(target).expect("read target"), contents);
        }

        #[test]
        fn writes_through_absolute_and_relative_links() {
            let directory = tempfile::tempdir().expect("tempdir");
            let dotfiles = directory.path().join("dotfiles");
            fs::create_dir(&dotfiles).expect("dotfiles");
            let target = dotfiles.join("config.toml");
            fs::write(&target, b"old").expect("target");

            let absolute = directory.path().join("absolute.toml");
            symlink(&target, &absolute).expect("absolute link");
            write_file_atomically(&absolute, b"absolute").expect("write absolute");
            assert_link_kept(&absolute, &target, b"absolute");

            let relative = directory.path().join("relative.toml");
            symlink("dotfiles/config.toml", &relative).expect("relative link");
            write_file_atomically(&relative, b"relative").expect("write relative");
            assert_link_kept(&relative, &target, b"relative");
        }

        #[test]
        fn writes_through_link_chains_and_symlinked_parents() {
            let directory = tempfile::tempdir().expect("tempdir");
            let real_dir = directory.path().join("real");
            fs::create_dir(&real_dir).expect("real dir");
            let target = real_dir.join("config.toml");
            fs::write(&target, b"old").expect("target");

            // ~/.codex -> real, real/link.toml -> config.toml, top.toml -> .codex/link.toml
            let linked_dir = directory.path().join(".codex");
            symlink(&real_dir, &linked_dir).expect("dir link");
            symlink("config.toml", real_dir.join("link.toml")).expect("inner link");
            let top = directory.path().join("top.toml");
            symlink(".codex/link.toml", &top).expect("top link");

            write_file_atomically(&top, b"chain").expect("write chain");
            assert_link_kept(&top, &target, b"chain");
            assert_link_kept(&real_dir.join("link.toml"), &target, b"chain");

            write_file_atomically(&linked_dir.join("config.toml"), b"parent")
                .expect("write in linked dir");
            assert_link_kept(&linked_dir, &target, b"parent");
        }

        #[test]
        fn rejects_dangling_links_and_cycles_without_replacing_them() {
            let directory = tempfile::tempdir().expect("tempdir");
            let dangling = directory.path().join("dangling.toml");
            symlink("missing.toml", &dangling).expect("dangling link");
            let error = write_file_atomically(&dangling, b"new").expect_err("dangling");
            assert!(error.contains("symlink to a missing file"), "{error}");

            let first = directory.path().join("a.toml");
            let second = directory.path().join("b.toml");
            symlink(&second, &first).expect("cycle a");
            symlink(&first, &second).expect("cycle b");
            let error = write_file_atomically(&first, b"new").expect_err("cycle");
            assert!(error.contains("Failed to resolve symlink"), "{error}");

            for link in [&dangling, &first, &second] {
                assert!(fs::symlink_metadata(link)
                    .expect("metadata")
                    .file_type()
                    .is_symlink());
            }
            assert!(!directory.path().join("missing.toml").exists());
        }

        #[test]
        fn backup_and_permissions_follow_the_resolved_target() {
            let directory = tempfile::tempdir().expect("tempdir");
            let dotfiles = directory.path().join("dotfiles");
            fs::create_dir(&dotfiles).expect("dotfiles");
            let target = dotfiles.join("config.toml");
            fs::write(&target, b"old").expect("target");
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).expect("mode");
            let link = directory.path().join("config.toml");
            symlink(&target, &link).expect("link");

            let backup = write_file_atomically_with_backup(&link, b"new")
                .expect("write")
                .expect("backup");

            assert_link_kept(&link, &target, b"new");
            assert_eq!(
                backup.parent(),
                Some(fs::canonicalize(&dotfiles).unwrap().as_path())
            );
            assert_eq!(fs::read(&backup).expect("read backup"), b"old");
            let mode = fs::metadata(&target)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        #[test]
        fn new_and_regular_files_keep_their_path() {
            let directory = tempfile::tempdir().expect("tempdir");
            let path = directory.path().join("new").join("config.toml");

            assert_eq!(resolve_write_target(&path).expect("resolve"), path);
            assert_eq!(
                write_file_atomically_with_backup(&path, b"first").expect("create"),
                None
            );
            assert_eq!(resolve_write_target(&path).expect("resolve"), path);
            assert!(write_file_atomically_with_backup(&path, b"second")
                .expect("update")
                .is_some());
            assert_eq!(fs::read(&path).expect("read"), b"second");
        }
    }
}
