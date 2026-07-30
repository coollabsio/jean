//! AI change checkpoints — snapshot the worktree before an agent turn and
//! restore files/project state later.
//!
//! Snapshots are real git commit objects (via a temporary index) stored under
//! `refs/jean/checkpoints/<id>` so they survive `git gc` and can be diffed or
//! restored with ordinary git commands. Metadata lives in Jean's app-data dir.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::platform::wsl_aware_command;

use super::git::resolve_git_dirs;
use super::git_status::{parse_unified_diff, DiffFile, GitDiff};

/// Max checkpoints retained per worktree (oldest pruned first).
const MAX_CHECKPOINTS_PER_WORKTREE: usize = 100;

/// Preview length for the triggering user message.
const MESSAGE_PREVIEW_CHARS: usize = 120;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckpointStatus {
    /// Snapshot taken; agent may still be running.
    Open,
    /// Agent turn finished; file stats captured.
    Finalized,
    /// User restored this checkpoint at some point (still restorable).
    Restored,
}

impl Default for CheckpointStatus {
    fn default() -> Self {
        Self::Open
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFileSummary {
    pub path: String,
    /// "added" | "modified" | "deleted" | "renamed"
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCheckpoint {
    pub id: String,
    pub worktree_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_id: Option<String>,
    /// Truncated user message that triggered the agent turn.
    pub user_message_preview: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalized_at: Option<u64>,
    /// Commit object capturing the full working tree at snapshot time.
    pub start_commit: String,
    /// Commit object capturing the real index at snapshot time. Older
    /// checkpoints omit this and preserve the index that exists at restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_index_commit: Option<String>,
    /// Commit object capturing the working tree when the turn finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_commit: Option<String>,
    /// HEAD commit at snapshot time (may differ from start_commit when there
    /// were uncommitted changes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit: Option<String>,
    pub worktree_path: String,
    #[serde(default)]
    pub status: CheckpointStatus,
    #[serde(default)]
    pub files_changed: Vec<CheckpointFileSummary>,
    #[serde(default)]
    pub total_additions: u32,
    #[serde(default)]
    pub total_deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CheckpointStore {
    checkpoints: Vec<AiCheckpoint>,
}

// ============================================================================
// Storage
// ============================================================================

/// Per-worktree mutexes serialize checkpoint store read-modify-write cycles
/// without blocking checkpoint writes for unrelated worktrees.
static CHECKPOINT_STORE_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn checkpoint_store_lock(worktree_id: &str) -> Arc<Mutex<()>> {
    let mut locks = CHECKPOINT_STORE_LOCKS.lock().unwrap();
    locks
        .entry(worktree_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn checkpoints_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let dir = app_data_dir.join("ai-checkpoints");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create checkpoints dir: {e}"))?;
    Ok(dir)
}

fn store_path(app: &AppHandle, worktree_id: &str) -> Result<PathBuf, String> {
    // Sanitize worktree id for filesystem use (UUIDs are fine as-is).
    let safe: String = worktree_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(checkpoints_dir(app)?.join(format!("{safe}.json")))
}

fn load_store(app: &AppHandle, worktree_id: &str) -> Result<CheckpointStore, String> {
    let path = store_path(app, worktree_id)?;
    if !path.exists() {
        return Ok(CheckpointStore::default());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read checkpoints: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse checkpoints: {e}"))
}

fn save_store(app: &AppHandle, worktree_id: &str, store: &CheckpointStore) -> Result<(), String> {
    let path = store_path(app, worktree_id)?;
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize checkpoints: {e}"))?;
    let tmp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&tmp, json).map_err(|e| format!("Failed to write checkpoints: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to finalize checkpoints: {e}"))?;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn truncate_preview(message: &str) -> String {
    let trimmed = message.trim();
    let count = trimmed.chars().count();
    if count <= MESSAGE_PREVIEW_CHARS {
        return trimmed.to_string();
    }
    let preview: String = trimmed.chars().take(MESSAGE_PREVIEW_CHARS).collect();
    format!("{preview}…")
}

// ============================================================================
// Git helpers
// ============================================================================

fn git_output(repo_path: &str, args: &[&str], index_file: Option<&Path>) -> Result<String, String> {
    let mut cmd = wsl_aware_command("git", Some(Path::new(repo_path)));
    if let Some(index) = index_file {
        cmd.env("GIT_INDEX_FILE", index);
    }
    let output = cmd
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run git {}: {e}", args.first().unwrap_or(&"")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {} failed: {stderr}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_ok(repo_path: &str, args: &[&str], index_file: Option<&Path>) -> bool {
    git_output(repo_path, args, index_file).is_ok()
}

fn has_head(repo_path: &str) -> bool {
    git_ok(repo_path, &["rev-parse", "--verify", "HEAD"], None)
}

fn head_commit(repo_path: &str) -> Option<String> {
    git_output(repo_path, &["rev-parse", "HEAD"], None).ok()
}

#[derive(Clone, Copy)]
enum CheckpointRefKind {
    Start,
    End,
}

fn checkpoint_ref(id: &str, kind: CheckpointRefKind) -> String {
    let suffix = match kind {
        CheckpointRefKind::Start => "start",
        CheckpointRefKind::End => "end",
    };
    format!("refs/jean/checkpoints/{id}/{suffix}")
}

/// Capture the full working tree (tracked + untracked, excluding ignored) as a
/// commit object without modifying HEAD or the real index.
///
/// Returns the commit SHA.
pub fn capture_working_tree_commit(repo_path: &str, message: &str) -> Result<String, String> {
    capture_checkpoint_commits(repo_path, message).map(|(working_commit, _)| working_commit)
}

/// Capture the working tree and real index as separate commits.
///
/// The index commit is a parent of the working-tree commit so the checkpoint
/// ref keeps both objects reachable.
fn capture_checkpoint_commits(repo_path: &str, message: &str) -> Result<(String, String), String> {
    let (git_dir, _) = resolve_git_dirs(Path::new(repo_path))
        .ok_or_else(|| format!("Not a git repository: {repo_path}"))?;

    let index_path = Path::new(&git_dir).join(format!("jean-checkpoint-index-{}", Uuid::new_v4()));

    // Best-effort cleanup of the temp index on all exit paths.
    let cleanup = || {
        let _ = fs::remove_file(&index_path);
    };

    let result = (|| {
        let index_tree = git_output(repo_path, &["write-tree"], None)?;
        let index_message = format!("{message}:index");
        let index_commit = if let Some(parent) = head_commit(repo_path) {
            git_output(
                repo_path,
                &[
                    "commit-tree",
                    &index_tree,
                    "-p",
                    &parent,
                    "-m",
                    &index_message,
                ],
                None,
            )?
        } else {
            git_output(
                repo_path,
                &["commit-tree", &index_tree, "-m", &index_message],
                None,
            )?
        };

        // Seed temp index from HEAD when possible, otherwise start empty.
        if has_head(repo_path) {
            git_output(repo_path, &["read-tree", "HEAD"], Some(&index_path))?;
        } else {
            git_output(repo_path, &["read-tree", "--empty"], Some(&index_path))?;
        }

        // Stage everything (tracked modifications + untracked files).
        // `-A` respects .gitignore so build artifacts stay out.
        git_output(repo_path, &["add", "-A", "--"], Some(&index_path))?;

        let tree = git_output(repo_path, &["write-tree"], Some(&index_path))?;
        if tree.is_empty() {
            return Err("git write-tree returned empty tree hash".to_string());
        }

        // Parent the worktree snapshot to the index snapshot, which itself is
        // parented to HEAD. This keeps both commits reachable from one ref.
        let commit = git_output(
            repo_path,
            &["commit-tree", &tree, "-p", &index_commit, "-m", message],
            None,
        )?;

        if commit.len() < 7 {
            return Err(format!("Unexpected commit hash: {commit}"));
        }

        Ok((commit, index_commit))
    })();

    cleanup();
    result
}

fn update_checkpoint_ref(
    repo_path: &str,
    id: &str,
    kind: CheckpointRefKind,
    commit: &str,
) -> Result<(), String> {
    let ref_name = checkpoint_ref(id, kind);
    git_output(repo_path, &["update-ref", &ref_name, commit], None)?;
    Ok(())
}

fn delete_checkpoint_refs(repo_path: &str, id: &str) {
    for kind in [CheckpointRefKind::Start, CheckpointRefKind::End] {
        let ref_name = checkpoint_ref(id, kind);
        let _ = git_output(repo_path, &["update-ref", "-d", &ref_name], None);
    }
    // Clean up refs created by versions that stored the start commit directly
    // at refs/jean/checkpoints/<id>.
    let legacy_ref = format!("refs/jean/checkpoints/{id}");
    let _ = git_output(repo_path, &["update-ref", "-d", &legacy_ref], None);
}

/// Diff two trees/commits (or a commit vs working tree when `to` is None).
fn diff_commits(repo_path: &str, from: &str, to: Option<&str>) -> Result<GitDiff, String> {
    let mut args = vec!["diff", "--unified=3", from];
    if let Some(to_ref) = to {
        args.push(to_ref);
    }

    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run git diff: {e}"))?;

    // git diff returns exit 1 when there are differences — still success for us.
    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git diff failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (files, raw_patch) = parse_unified_diff(&stdout);

    // When diffing against the working tree, also surface untracked files that
    // are not present in the checkpoint commit. `git diff <commit>` already
    // includes modifications to tracked files and deletions; untracked files
    // need the --no-index treatment used elsewhere only when comparing to WD.
    // For checkpoint→WD we run an extra status pass for untracked-only paths
    // that aren't already in the diff.
    let mut files = files;
    let mut raw_patch = raw_patch;
    if to.is_none() {
        let untracked = list_untracked_relative(repo_path);
        for path in untracked {
            if files.iter().any(|f| f.path == path) {
                continue;
            }
            // Show as fully-added file via no-index diff when possible.
            if let Some(file) = untracked_file_diff(repo_path, &path) {
                if !raw_patch.is_empty() && !raw_patch.ends_with('\n') {
                    raw_patch.push('\n');
                }
                // Reconstruct a minimal raw patch entry for the viewer.
                raw_patch.push_str(&format!(
                    "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
                ));
                files.push(file);
            }
        }
    }

    let total_additions: u32 = files.iter().map(|f| f.additions).sum();
    let total_deletions: u32 = files.iter().map(|f| f.deletions).sum();

    Ok(GitDiff {
        diff_type: "checkpoint".to_string(),
        base_ref: from.to_string(),
        target_ref: to.unwrap_or("working directory").to_string(),
        total_additions,
        total_deletions,
        files,
        raw_patch,
    })
}

fn list_untracked_relative(repo_path: &str) -> Vec<String> {
    let Ok(stdout) = git_output(
        repo_path,
        &["ls-files", "--others", "--exclude-standard"],
        None,
    ) else {
        return Vec::new();
    };
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn untracked_file_diff(repo_path: &str, relative_path: &str) -> Option<DiffFile> {
    let full = Path::new(repo_path).join(relative_path);
    let content = fs::read_to_string(&full).ok()?;
    let lines: Vec<&str> = content.lines().collect();
    let additions = lines.len() as u32;
    let diff_lines = lines
        .into_iter()
        .enumerate()
        .map(|(i, content)| super::git_status::DiffLine {
            line_type: "addition".to_string(),
            content: content.to_string(),
            old_line_number: None,
            new_line_number: Some((i + 1) as u32),
        })
        .collect();
    Some(DiffFile {
        path: relative_path.to_string(),
        old_path: None,
        status: "added".to_string(),
        additions,
        deletions: 0,
        is_binary: false,
        hunks: vec![super::git_status::DiffHunk {
            header: format!("@@ -0,0 +1,{additions} @@"),
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: additions,
            lines: diff_lines,
        }],
    })
}

fn file_summaries_from_diff(diff: &GitDiff) -> Vec<CheckpointFileSummary> {
    diff.files
        .iter()
        .map(|f| CheckpointFileSummary {
            path: f.path.clone(),
            status: f.status.clone(),
            additions: f.additions,
            deletions: f.deletions,
        })
        .collect()
}

// ============================================================================
// Public API
// ============================================================================

pub struct CreateCheckpointArgs {
    pub worktree_id: String,
    pub worktree_path: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub user_message_id: Option<String>,
    pub user_message: String,
}

/// Create a checkpoint snapshot of the current working tree.
pub fn create_checkpoint(
    app: &AppHandle,
    args: CreateCheckpointArgs,
) -> Result<AiCheckpoint, String> {
    let id = Uuid::new_v4().to_string();
    let preview = truncate_preview(&args.user_message);
    let message = format!("jean-checkpoint:{id}");

    let (start_commit, start_index_commit) =
        capture_checkpoint_commits(&args.worktree_path, &message)?;
    update_checkpoint_ref(
        &args.worktree_path,
        &id,
        CheckpointRefKind::Start,
        &start_commit,
    )?;

    let head = head_commit(&args.worktree_path);
    let created_at = now_secs();

    let checkpoint = AiCheckpoint {
        id: id.clone(),
        worktree_id: args.worktree_id.clone(),
        session_id: args.session_id,
        run_id: args.run_id,
        user_message_id: args.user_message_id,
        user_message_preview: preview,
        created_at,
        finalized_at: None,
        start_commit,
        start_index_commit: Some(start_index_commit),
        end_commit: None,
        head_commit: head,
        worktree_path: args.worktree_path,
        status: CheckpointStatus::Open,
        files_changed: Vec::new(),
        total_additions: 0,
        total_deletions: 0,
    };

    let store_lock = checkpoint_store_lock(&args.worktree_id);
    let _store_guard = store_lock.lock().unwrap();
    let mut store = load_store(app, &args.worktree_id)?;
    store.checkpoints.push(checkpoint.clone());

    // Prune oldest beyond retention limit (also drop their refs).
    while store.checkpoints.len() > MAX_CHECKPOINTS_PER_WORKTREE {
        let removed = store.checkpoints.remove(0);
        delete_checkpoint_refs(&removed.worktree_path, &removed.id);
    }

    save_store(app, &args.worktree_id, &store)?;
    log::info!(
        "[Checkpoint] created id={id} worktree={} commit={}",
        args.worktree_id,
        checkpoint.start_commit
    );
    Ok(checkpoint)
}

/// Finalize a checkpoint after the agent turn completes.
///
/// Captures the end tree and records which files changed during the turn.
pub fn finalize_checkpoint(
    app: &AppHandle,
    worktree_id: &str,
    checkpoint_id: &str,
) -> Result<AiCheckpoint, String> {
    let store_lock = checkpoint_store_lock(worktree_id);
    let _store_guard = store_lock.lock().unwrap();
    let mut store = load_store(app, worktree_id)?;
    let checkpoint = store
        .checkpoints
        .iter_mut()
        .find(|c| c.id == checkpoint_id)
        .ok_or_else(|| format!("Checkpoint not found: {checkpoint_id}"))?;

    if checkpoint.status == CheckpointStatus::Finalized {
        return Ok(checkpoint.clone());
    }

    let end_message = format!("jean-checkpoint-end:{checkpoint_id}");
    let end_commit = match capture_working_tree_commit(&checkpoint.worktree_path, &end_message) {
        Ok(sha) => match update_checkpoint_ref(
            &checkpoint.worktree_path,
            checkpoint_id,
            CheckpointRefKind::End,
            &sha,
        ) {
            Ok(()) => Some(sha),
            Err(e) => {
                log::warn!("[Checkpoint] failed to protect end tree for {checkpoint_id}: {e}");
                None
            }
        },
        Err(e) => {
            log::warn!("[Checkpoint] failed to capture end tree for {checkpoint_id}: {e}");
            None
        }
    };

    // Diff start → end (or working tree if end capture failed).
    let diff = diff_commits(
        &checkpoint.worktree_path,
        &checkpoint.start_commit,
        end_commit.as_deref(),
    )
    .unwrap_or_else(|e| {
        log::warn!("[Checkpoint] finalize diff failed for {checkpoint_id}: {e}");
        GitDiff {
            diff_type: "checkpoint".to_string(),
            base_ref: checkpoint.start_commit.clone(),
            target_ref: "working directory".to_string(),
            total_additions: 0,
            total_deletions: 0,
            files: Vec::new(),
            raw_patch: String::new(),
        }
    });

    checkpoint.end_commit = end_commit;
    checkpoint.files_changed = file_summaries_from_diff(&diff);
    checkpoint.total_additions = diff.total_additions;
    checkpoint.total_deletions = diff.total_deletions;
    checkpoint.finalized_at = Some(now_secs());
    checkpoint.status = CheckpointStatus::Finalized;

    let result = checkpoint.clone();
    save_store(app, worktree_id, &store)?;
    log::info!(
        "[Checkpoint] finalized id={checkpoint_id} files={} +{} -{}",
        result.files_changed.len(),
        result.total_additions,
        result.total_deletions
    );
    Ok(result)
}

/// List checkpoints for a worktree (newest first).
pub fn list_checkpoints(app: &AppHandle, worktree_id: &str) -> Result<Vec<AiCheckpoint>, String> {
    let mut store = load_store(app, worktree_id)?;
    store
        .checkpoints
        .sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(store.checkpoints)
}

/// Get a single checkpoint by id.
pub fn get_checkpoint(
    app: &AppHandle,
    worktree_id: &str,
    checkpoint_id: &str,
) -> Result<AiCheckpoint, String> {
    let store = load_store(app, worktree_id)?;
    store
        .checkpoints
        .into_iter()
        .find(|c| c.id == checkpoint_id)
        .ok_or_else(|| format!("Checkpoint not found: {checkpoint_id}"))
}

/// Diff a checkpoint against the current working tree, or against its end
/// state (`scope = "turn"` uses start→end when available).
pub fn get_checkpoint_diff(
    app: &AppHandle,
    worktree_id: &str,
    checkpoint_id: &str,
    scope: Option<&str>,
) -> Result<GitDiff, String> {
    let checkpoint = get_checkpoint(app, worktree_id, checkpoint_id)?;
    let scope = scope.unwrap_or("current");

    match scope {
        "turn" => {
            if let Some(ref end) = checkpoint.end_commit {
                diff_commits(
                    &checkpoint.worktree_path,
                    &checkpoint.start_commit,
                    Some(end),
                )
            } else {
                // Fall back to start → working tree if not yet finalized.
                diff_commits(&checkpoint.worktree_path, &checkpoint.start_commit, None)
            }
        }
        _ => diff_commits(&checkpoint.worktree_path, &checkpoint.start_commit, None),
    }
}

/// Restore the entire worktree to a checkpoint's start state.
///
/// Restores the working tree and index snapshots independently.
/// Untracked files that did not exist in the checkpoint are removed.
pub fn restore_checkpoint(
    app: &AppHandle,
    worktree_id: &str,
    checkpoint_id: &str,
) -> Result<AiCheckpoint, String> {
    let store_lock = checkpoint_store_lock(worktree_id);
    let _store_guard = store_lock.lock().unwrap();
    let mut store = load_store(app, worktree_id)?;
    let checkpoint = store
        .checkpoints
        .iter_mut()
        .find(|c| c.id == checkpoint_id)
        .ok_or_else(|| format!("Checkpoint not found: {checkpoint_id}"))?;

    let commit = checkpoint.start_commit.clone();
    let index_commit = checkpoint.start_index_commit.clone();
    let repo = checkpoint.worktree_path.clone();

    if let Some(index_commit) = index_commit {
        restore_checkpoint_commits(&repo, &commit, &index_commit)?;
    } else {
        // Legacy checkpoints did not capture the original index. Restore the
        // working tree image, then put the current index back rather than
        // incorrectly staging every checkpoint difference.
        let current_index_tree = git_output(&repo, &["write-tree"], None)?;
        git_output(&repo, &["read-tree", "-u", "--reset", &commit], None)?;
        let _ = git_output(&repo, &["clean", "-fd"], None);
        git_output(&repo, &["read-tree", "--reset", &current_index_tree], None)?;
    }

    checkpoint.status = CheckpointStatus::Restored;
    let result = checkpoint.clone();
    save_store(app, worktree_id, &store)?;
    log::info!("[Checkpoint] restored full worktree id={checkpoint_id}");
    Ok(result)
}

fn restore_checkpoint_commits(
    repo_path: &str,
    working_commit: &str,
    index_commit: &str,
) -> Result<(), String> {
    // Populate the worktree from its snapshot, then replace only the index
    // with its own snapshot to retain the original staged/unstaged boundary.
    git_output(
        repo_path,
        &["read-tree", "-u", "--reset", working_commit],
        None,
    )?;
    // At this point snapshot files are all represented by the temporary
    // worktree index, so clean removes only files created after capture.
    let _ = git_output(repo_path, &["clean", "-fd"], None);
    git_output(repo_path, &["read-tree", "--reset", index_commit], None)?;
    Ok(())
}

fn validated_restore_path(repo: &Path, file_path: &Path) -> Result<PathBuf, String> {
    if file_path.as_os_str().is_empty()
        || file_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "Invalid checkpoint file path: {}",
            file_path.display()
        ));
    }

    let canonical_repo = repo
        .canonicalize()
        .map_err(|e| format!("Failed to resolve worktree path: {e}"))?;
    let target = canonical_repo.join(file_path);

    if target.exists() {
        let canonical_target = target
            .canonicalize()
            .map_err(|e| format!("Failed to resolve checkpoint file path: {e}"))?;
        if !canonical_target.starts_with(&canonical_repo) {
            return Err(format!(
                "Checkpoint file path escapes the worktree: {}",
                file_path.display()
            ));
        }
    }

    Ok(target)
}

/// Restore a single file from a checkpoint's start state.
pub fn restore_checkpoint_file(
    app: &AppHandle,
    worktree_id: &str,
    checkpoint_id: &str,
    file_path: &str,
) -> Result<(), String> {
    let checkpoint = get_checkpoint(app, worktree_id, checkpoint_id)?;
    let repo = &checkpoint.worktree_path;
    let commit = &checkpoint.start_commit;
    let full = validated_restore_path(Path::new(repo), Path::new(file_path))?;

    // Check whether the file existed in the checkpoint tree.
    let existed = git_ok(
        repo,
        &["cat-file", "-e", &format!("{commit}:{file_path}")],
        None,
    );

    if existed {
        git_output(repo, &["checkout", commit, "--", file_path], None)?;
    } else {
        // File was created after the checkpoint — remove it.
        if full.exists() {
            if full.is_dir() {
                fs::remove_dir_all(&full)
                    .map_err(|e| format!("Failed to remove directory {file_path}: {e}"))?;
            } else {
                fs::remove_file(&full)
                    .map_err(|e| format!("Failed to remove file {file_path}: {e}"))?;
            }
        }
        // Unstage if staged.
        let _ = git_output(
            repo,
            &["rm", "-f", "--cached", "--ignore-unmatch", file_path],
            None,
        );
    }

    log::info!("[Checkpoint] restored file={file_path} from checkpoint={checkpoint_id}");
    Ok(())
}

/// Delete a checkpoint and its git ref.
pub fn delete_checkpoint(
    app: &AppHandle,
    worktree_id: &str,
    checkpoint_id: &str,
) -> Result<(), String> {
    let store_lock = checkpoint_store_lock(worktree_id);
    let _store_guard = store_lock.lock().unwrap();
    let mut store = load_store(app, worktree_id)?;
    let Some(idx) = store.checkpoints.iter().position(|c| c.id == checkpoint_id) else {
        return Err(format!("Checkpoint not found: {checkpoint_id}"));
    };
    let removed = store.checkpoints.remove(idx);
    delete_checkpoint_refs(&removed.worktree_path, &removed.id);
    save_store(app, worktree_id, &store)?;
    log::info!("[Checkpoint] deleted id={checkpoint_id}");
    Ok(())
}

/// Find the most recent open checkpoint for a session/run (used for auto-finalize).
pub fn find_open_checkpoint_for_run(
    app: &AppHandle,
    worktree_id: &str,
    run_id: &str,
) -> Result<Option<AiCheckpoint>, String> {
    let store = load_store(app, worktree_id)?;
    Ok(store
        .checkpoints
        .into_iter()
        .rev()
        .find(|c| c.run_id.as_deref() == Some(run_id) && c.status == CheckpointStatus::Open))
}

// ============================================================================
// Command wrappers (registered via http_server/dispatch.rs)
// ============================================================================

pub async fn create_ai_checkpoint(
    app: AppHandle,
    worktree_id: String,
    worktree_path: String,
    session_id: String,
    run_id: Option<String>,
    user_message_id: Option<String>,
    user_message: String,
) -> Result<AiCheckpoint, String> {
    create_checkpoint(
        &app,
        CreateCheckpointArgs {
            worktree_id,
            worktree_path,
            session_id,
            run_id,
            user_message_id,
            user_message,
        },
    )
}

pub async fn list_ai_checkpoints(
    app: AppHandle,
    worktree_id: String,
) -> Result<Vec<AiCheckpoint>, String> {
    list_checkpoints(&app, &worktree_id)
}

pub async fn get_ai_checkpoint(
    app: AppHandle,
    worktree_id: String,
    checkpoint_id: String,
) -> Result<AiCheckpoint, String> {
    get_checkpoint(&app, &worktree_id, &checkpoint_id)
}

pub async fn get_ai_checkpoint_diff(
    app: AppHandle,
    worktree_id: String,
    checkpoint_id: String,
    scope: Option<String>,
) -> Result<GitDiff, String> {
    get_checkpoint_diff(&app, &worktree_id, &checkpoint_id, scope.as_deref())
}

pub async fn restore_ai_checkpoint(
    app: AppHandle,
    worktree_id: String,
    checkpoint_id: String,
) -> Result<AiCheckpoint, String> {
    restore_checkpoint(&app, &worktree_id, &checkpoint_id)
}

pub async fn restore_ai_checkpoint_file(
    app: AppHandle,
    worktree_id: String,
    checkpoint_id: String,
    file_path: String,
) -> Result<(), String> {
    restore_checkpoint_file(&app, &worktree_id, &checkpoint_id, &file_path)
}

pub async fn delete_ai_checkpoint(
    app: AppHandle,
    worktree_id: String,
    checkpoint_id: String,
) -> Result<(), String> {
    delete_checkpoint(&app, &worktree_id, &checkpoint_id)
}

pub async fn finalize_ai_checkpoint(
    app: AppHandle,
    worktree_id: String,
    checkpoint_id: String,
) -> Result<AiCheckpoint, String> {
    finalize_checkpoint(&app, &worktree_id, &checkpoint_id)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn run_git(repo: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        run_git(repo, &["init", "--initial-branch", "main"]);
        run_git(repo, &["config", "user.email", "test@example.com"]);
        run_git(repo, &["config", "user.name", "Test"]);
        // Avoid "detected dubious ownership" in some CI sandboxes.
        run_git(repo, &["config", "core.safecrlf", "false"]);
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        run_git(repo, &["add", "."]);
        run_git(repo, &["commit", "-m", "initial"]);
        dir
    }

    #[test]
    fn capture_working_tree_includes_uncommitted_and_untracked() {
        let dir = init_repo();
        let repo = dir.path();
        let repo_str = repo.to_string_lossy().to_string();

        std::fs::write(repo.join("README.md"), "hello world\n").unwrap();
        std::fs::write(repo.join("new.txt"), "brand new\n").unwrap();

        let commit = capture_working_tree_commit(&repo_str, "test-checkpoint").unwrap();
        assert_eq!(commit.len(), 40);

        // Working tree and HEAD must be untouched.
        let head = head_commit(&repo_str).unwrap();
        assert_ne!(head, commit);
        let readme = std::fs::read_to_string(repo.join("README.md")).unwrap();
        assert_eq!(readme, "hello world\n");
        assert!(repo.join("new.txt").exists());

        // Commit tree must contain both changes.
        let tree_readme =
            git_output(&repo_str, &["show", &format!("{commit}:README.md")], None).unwrap();
        assert_eq!(tree_readme, "hello world");
        let tree_new =
            git_output(&repo_str, &["show", &format!("{commit}:new.txt")], None).unwrap();
        assert_eq!(tree_new, "brand new");
    }

    #[test]
    fn restore_file_reverts_modification() {
        let dir = init_repo();
        let repo = dir.path();
        let repo_str = repo.to_string_lossy().to_string();

        let commit = capture_working_tree_commit(&repo_str, "before").unwrap();
        std::fs::write(repo.join("README.md"), "mutated\n").unwrap();

        // Simulate restore via checkout from commit.
        git_output(&repo_str, &["checkout", &commit, "--", "README.md"], None).unwrap();
        let content = std::fs::read_to_string(repo.join("README.md")).unwrap();
        assert_eq!(content, "hello\n");
    }

    #[test]
    fn restore_path_rejects_paths_outside_worktree() {
        let dir = init_repo();
        let repo = dir.path();

        assert!(validated_restore_path(repo, Path::new("../outside.txt")).is_err());
        assert!(validated_restore_path(repo, Path::new("/tmp/outside.txt")).is_err());
        assert!(validated_restore_path(repo, Path::new("./README.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn restore_path_rejects_symlinks_outside_worktree() {
        use std::os::unix::fs::symlink;

        let dir = init_repo();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), dir.path().join("outside-link")).unwrap();

        assert!(
            validated_restore_path(dir.path(), Path::new("outside-link")).is_err(),
            "a symlink resolving outside the worktree must be rejected"
        );
    }

    #[test]
    fn restore_full_tree_removes_new_files() {
        let dir = init_repo();
        let repo = dir.path();
        let repo_str = repo.to_string_lossy().to_string();

        let commit = capture_working_tree_commit(&repo_str, "before").unwrap();
        std::fs::write(repo.join("README.md"), "mutated\n").unwrap();
        std::fs::write(repo.join("extra.rs"), "fn x() {}\n").unwrap();

        git_output(&repo_str, &["read-tree", "-u", "--reset", &commit], None).unwrap();
        let _ = git_output(&repo_str, &["clean", "-fd"], None);

        let content = std::fs::read_to_string(repo.join("README.md")).unwrap();
        assert_eq!(content, "hello\n");
        assert!(!repo.join("extra.rs").exists());
    }

    #[test]
    fn restore_full_tree_preserves_staged_and_unstaged_states() {
        let dir = init_repo();
        let repo = dir.path();
        let repo_str = repo.to_string_lossy().to_string();

        std::fs::write(repo.join("README.md"), "staged\n").unwrap();
        run_git(repo, &["add", "README.md"]);
        std::fs::write(repo.join("README.md"), "unstaged\n").unwrap();

        let (working_commit, index_commit) =
            capture_checkpoint_commits(&repo_str, "before").unwrap();

        std::fs::write(repo.join("README.md"), "mutated\n").unwrap();
        run_git(repo, &["add", "README.md"]);

        restore_checkpoint_commits(&repo_str, &working_commit, &index_commit).unwrap();

        let staged = git_output(&repo_str, &["diff", "--cached", "--", "README.md"], None).unwrap();
        let unstaged = git_output(&repo_str, &["diff", "--", "README.md"], None).unwrap();
        assert!(staged.contains("+staged"));
        assert!(unstaged.contains("-staged"));
        assert!(unstaged.contains("+unstaged"));
        assert_eq!(
            std::fs::read_to_string(repo.join("README.md")).unwrap(),
            "unstaged\n"
        );
    }

    #[test]
    fn diff_detects_turn_changes() {
        let dir = init_repo();
        let repo = dir.path();
        let repo_str = repo.to_string_lossy().to_string();

        let start = capture_working_tree_commit(&repo_str, "start").unwrap();
        std::fs::write(repo.join("README.md"), "changed by ai\n").unwrap();
        std::fs::write(repo.join("ai-new.ts"), "export {}\n").unwrap();
        let end = capture_working_tree_commit(&repo_str, "end").unwrap();

        let diff = diff_commits(&repo_str, &start, Some(&end)).unwrap();
        assert!(diff.total_additions > 0);
        let paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"README.md") || paths.iter().any(|p| p.contains("README")));
        assert!(paths.iter().any(|p| p.contains("ai-new")));
    }

    #[test]
    fn checkpoint_refs_protect_both_commits_and_are_deleted_together() {
        let dir = init_repo();
        let repo_str = dir.path().to_string_lossy().to_string();
        let id = "checkpoint-id";
        let start = capture_working_tree_commit(&repo_str, "start").unwrap();
        let end = capture_working_tree_commit(&repo_str, "end").unwrap();

        update_checkpoint_ref(&repo_str, id, CheckpointRefKind::Start, &start).unwrap();
        update_checkpoint_ref(&repo_str, id, CheckpointRefKind::End, &end).unwrap();

        assert_eq!(
            git_output(
                &repo_str,
                &["rev-parse", &format!("refs/jean/checkpoints/{id}/start")],
                None,
            )
            .unwrap(),
            start
        );
        assert_eq!(
            git_output(
                &repo_str,
                &["rev-parse", &format!("refs/jean/checkpoints/{id}/end")],
                None,
            )
            .unwrap(),
            end
        );

        delete_checkpoint_refs(&repo_str, id);
        assert!(!git_ok(
            &repo_str,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/jean/checkpoints/{id}/start")
            ],
            None,
        ));
        assert!(!git_ok(
            &repo_str,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/jean/checkpoints/{id}/end")
            ],
            None,
        ));
    }

    #[test]
    fn truncate_preview_respects_char_limit() {
        let short = truncate_preview("hello");
        assert_eq!(short, "hello");
        let long = "x".repeat(200);
        let preview = truncate_preview(&long);
        assert!(preview.ends_with('…'));
        assert!(preview.chars().count() <= MESSAGE_PREVIEW_CHARS + 1);
    }

    #[test]
    fn checkpoint_store_lock_is_shared_per_worktree() {
        let first = checkpoint_store_lock("worktree-a");
        let second = checkpoint_store_lock("worktree-a");
        let other = checkpoint_store_lock("worktree-b");

        assert!(std::sync::Arc::ptr_eq(&first, &second));
        assert!(!std::sync::Arc::ptr_eq(&first, &other));
    }
}
