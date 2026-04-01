use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use super::storage::get_session_dir;
use crate::platform::silent_command;

fn checkpoint_git_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    Ok(get_session_dir(app, session_id)?.join("checkpoints.git"))
}

fn run_git(
    worktree_path: &Path,
    git_dir: &Path,
    args: &[&str],
) -> Result<std::process::Output, String> {
    silent_command("git")
        .arg("--git-dir")
        .arg(git_dir)
        .arg("--work-tree")
        .arg(worktree_path)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git {:?}: {e}", args))
}

fn ensure_repo(app: &AppHandle, session_id: &str, worktree_path: &Path) -> Result<PathBuf, String> {
    let git_dir = checkpoint_git_dir(app, session_id)?;
    if git_dir.exists() {
        return Ok(git_dir);
    }

    fs::create_dir_all(&git_dir)
        .map_err(|e| format!("Failed to create checkpoint directory {git_dir:?}: {e}"))?;

    let init = silent_command("git")
        .arg("init")
        .arg("--bare")
        .arg(&git_dir)
        .output()
        .map_err(|e| format!("Failed to initialize checkpoint git dir: {e}"))?;
    if !init.status.success() {
        return Err(format!(
            "Failed to initialize checkpoint repo: {}",
            String::from_utf8_lossy(&init.stderr)
        ));
    }

    for (key, value) in [
        ("core.autocrlf", "false"),
        ("core.longpaths", "true"),
        ("core.symlinks", "true"),
    ] {
        let out = silent_command("git")
            .arg("--git-dir")
            .arg(&git_dir)
            .args(["config", key, value])
            .output()
            .map_err(|e| format!("Failed to configure checkpoint repo: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Failed to configure checkpoint repo ({key}): {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }

    // Prime the index once so future write-tree operations are cheap.
    let _ = run_git(worktree_path, &git_dir, &["reset"]);

    Ok(git_dir)
}

fn current_tree(worktree_path: &Path, git_dir: &Path) -> Result<String, String> {
    let add = run_git(worktree_path, git_dir, &["add", "-A", "."])?;
    if !add.status.success() {
        return Err(format!(
            "Failed to stage files for checkpoint: {}",
            String::from_utf8_lossy(&add.stderr)
        ));
    }

    let write_tree = run_git(worktree_path, git_dir, &["write-tree"])?;
    if !write_tree.status.success() {
        return Err(format!(
            "Failed to write checkpoint tree: {}",
            String::from_utf8_lossy(&write_tree.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&write_tree.stdout)
        .trim()
        .to_string())
}

pub fn capture(app: &AppHandle, session_id: &str, worktree_path: &Path) -> Result<String, String> {
    let git_dir = ensure_repo(app, session_id, worktree_path)?;
    current_tree(worktree_path, &git_dir)
}

pub fn restore(
    app: &AppHandle,
    session_id: &str,
    worktree_path: &Path,
    checkpoint_id: &str,
) -> Result<(), String> {
    let git_dir = ensure_repo(app, session_id, worktree_path)?;

    let current = current_tree(worktree_path, &git_dir)?;
    let deleted = run_git(
        worktree_path,
        &git_dir,
        &[
            "diff",
            "--name-only",
            "--diff-filter=D",
            &current,
            checkpoint_id,
            "--",
            ".",
        ],
    )?;
    if !deleted.status.success() {
        return Err(format!(
            "Failed to compute deleted files during restore: {}",
            String::from_utf8_lossy(&deleted.stderr)
        ));
    }

    let read_tree = run_git(worktree_path, &git_dir, &["read-tree", checkpoint_id])?;
    if !read_tree.status.success() {
        return Err(format!(
            "Failed to read checkpoint tree {checkpoint_id}: {}",
            String::from_utf8_lossy(&read_tree.stderr)
        ));
    }

    let checkout = run_git(worktree_path, &git_dir, &["checkout-index", "-a", "-f"])?;
    if !checkout.status.success() {
        return Err(format!(
            "Failed to restore checkpoint {checkpoint_id}: {}",
            String::from_utf8_lossy(&checkout.stderr)
        ));
    }

    for rel in String::from_utf8_lossy(&deleted.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let abs = worktree_path.join(rel);
        let _ = fs::remove_file(&abs);
        let _ = fs::remove_dir_all(&abs);
    }

    Ok(())
}
