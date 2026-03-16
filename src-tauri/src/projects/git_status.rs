use crate::platform::silent_command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Information about a worktree for polling
#[derive(Debug, Clone)]
pub struct ActiveWorktreeInfo {
    pub worktree_id: String,
    pub worktree_path: String,
    pub base_branch: String,
    /// GitHub PR number (if a PR has been created)
    pub pr_number: Option<u32>,
    /// GitHub PR URL (if a PR has been created)
    pub pr_url: Option<String>,
}

/// Git branch status relative to a base branch
#[derive(Debug, Clone, Serialize)]
pub struct GitBranchStatus {
    pub worktree_id: String,
    pub current_branch: String,
    pub base_branch: String,
    pub behind_count: u32,
    pub ahead_count: u32,
    pub has_updates: bool,
    pub checked_at: u64,
    /// Lines added in uncommitted changes (working directory)
    pub uncommitted_added: u32,
    /// Lines removed in uncommitted changes (working directory)
    pub uncommitted_removed: u32,
    /// Lines added compared to base branch (origin/main)
    pub branch_diff_added: u32,
    /// Lines removed compared to base branch (origin/main)
    pub branch_diff_removed: u32,
    /// Commits the local base branch is ahead of origin (unpushed on base)
    pub base_branch_ahead_count: u32,
    /// Commits the local base branch is behind origin
    pub base_branch_behind_count: u32,
    /// Commits unique to this worktree (ahead of local base branch, not origin)
    pub worktree_ahead_count: u32,
    /// Commits in HEAD not yet pushed to origin/{current_branch}
    pub unpushed_count: u32,
}

/// Fetch the latest changes from origin for a specific branch
fn fetch_origin_branch(repo_path: &str, branch: &str) -> Result<(), String> {
    log::trace!("Fetching origin/{branch} in {repo_path}");

    let output = silent_command("git")
        .args(["fetch", "origin", branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git fetch: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Don't fail if no remote - just log and continue
        if stderr.contains("does not appear to be a git repository")
            || stderr.contains("Could not read from remote")
            || stderr.contains("'origin' does not appear to be a git repository")
            || stderr.contains("couldn't find remote ref")
        {
            log::trace!("No remote origin/{branch} available: {stderr}");
            return Ok(());
        }
        log::warn!("Failed to fetch origin/{branch}: {stderr}");
    }

    Ok(())
}

/// Fetch a branch from a specific remote (not necessarily origin)
fn fetch_origin_branch_from_remote(
    repo_path: &str,
    remote: &str,
    branch: &str,
) -> Result<(), String> {
    log::trace!("Fetching {remote}/{branch} in {repo_path}");

    let output = silent_command("git")
        .args(["fetch", remote, branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git fetch: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not appear to be a git repository")
            || stderr.contains("Could not read from remote")
            || stderr.contains("couldn't find remote ref")
        {
            log::trace!("No remote {remote}/{branch} available: {stderr}");
            return Ok(());
        }
        log::warn!("Failed to fetch {remote}/{branch}: {stderr}");
    }

    Ok(())
}

/// Get the upstream tracking ref for the current branch (e.g., "origin/main", "fork/feature")
/// Returns None if no upstream is configured.
fn get_upstream_ref(repo_path: &str) -> Option<String> {
    let output = silent_command("git")
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .current_dir(repo_path)
        .output()
        .ok()?;

    if output.status.success() {
        let upstream = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if upstream.is_empty() {
            None
        } else {
            Some(upstream)
        }
    } else {
        None
    }
}

/// Get the current branch name
/// Uses symbolic-ref first (works on repos with no commits), falls back to rev-parse
fn get_current_branch(repo_path: &str) -> Result<String, String> {
    // Try symbolic-ref first — works even on empty repos (no commits yet)
    let sym_output = silent_command("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(repo_path)
        .output();

    if let Ok(ref o) = sym_output {
        if o.status.success() {
            let branch = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !branch.is_empty() {
                return Ok(branch);
            }
        }
    }

    // Fall back to rev-parse (works when HEAD is detached)
    let output = silent_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get current branch: {stderr}"));
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(branch)
}

/// Get the number of lines added and removed in uncommitted changes (working directory)
/// This includes tracked file modifications (staged + unstaged) AND untracked (new) files
fn get_uncommitted_diff_stats(repo_path: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;

    // 1. Get diff stats for unstaged changes (working directory vs index)
    // git diff --numstat outputs: "added<tab>removed<tab>filename" per line
    let unstaged_output = silent_command("git")
        .args(["diff", "--numstat"])
        .current_dir(repo_path)
        .output();

    if let Ok(o) = unstaged_output {
        if o.status.success() {
            let stdout = String::from_utf8_lossy(&o.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    // Binary files show "-" instead of numbers
                    added += parts[0].parse().unwrap_or(0);
                    removed += parts[1].parse().unwrap_or(0);
                }
            }
        }
    }

    // 2. Get diff stats for staged changes (index vs HEAD)
    // git diff --cached --numstat shows changes that have been `git add`ed
    let staged_output = silent_command("git")
        .args(["diff", "--cached", "--numstat"])
        .current_dir(repo_path)
        .output();

    if let Ok(o) = staged_output {
        if o.status.success() {
            let stdout = String::from_utf8_lossy(&o.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    // Binary files show "-" instead of numbers
                    added += parts[0].parse().unwrap_or(0);
                    removed += parts[1].parse().unwrap_or(0);
                }
            }
        }
    }

    // 3. Get stats for untracked (new) files
    // List all untracked files
    let untracked_output = silent_command("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(repo_path)
        .output();

    if let Ok(o) = untracked_output {
        if o.status.success() {
            let stdout = String::from_utf8_lossy(&o.stdout);
            for file_path in stdout.lines() {
                if file_path.is_empty() {
                    continue;
                }
                // Count lines in each untracked file (all lines are "added")
                let full_path = std::path::Path::new(repo_path).join(file_path);
                if let Ok(content) = std::fs::read_to_string(&full_path) {
                    // Count lines, but minimum 1 for file existence (even if empty)
                    let line_count = content.lines().count() as u32;
                    added += line_count.max(1);
                } else {
                    // Binary file or read error - count as 1 addition
                    added += 1;
                }
            }
        }
    }

    (added, removed)
}

/// Generate raw patch format for untracked files
/// Returns a string in unified diff format
fn get_untracked_files_raw_patch(repo_path: &str) -> String {
    let mut raw_patch = String::new();

    // List all untracked files
    let output = silent_command("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(repo_path)
        .output();

    let Ok(o) = output else {
        return raw_patch;
    };

    if !o.status.success() {
        return raw_patch;
    }

    let stdout = String::from_utf8_lossy(&o.stdout);
    for file_path in stdout.lines() {
        if file_path.is_empty() {
            continue;
        }

        let full_path = std::path::Path::new(repo_path).join(file_path);

        // Try to read file content
        if let Ok(content) = std::fs::read_to_string(&full_path) {
            let lines: Vec<&str> = content.lines().collect();
            let line_count = lines.len();

            // Generate unified diff format for new file
            raw_patch.push_str(&format!("diff --git a/{file_path} b/{file_path}\n"));
            raw_patch.push_str("new file mode 100644\n");
            raw_patch.push_str("--- /dev/null\n");
            raw_patch.push_str(&format!("+++ b/{file_path}\n"));
            raw_patch.push_str(&format!("@@ -0,0 +1,{line_count} @@\n"));

            for line in &lines {
                raw_patch.push('+');
                raw_patch.push_str(line);
                raw_patch.push('\n');
            }
        }
    }

    raw_patch
}

/// Get detailed diff information for untracked (new) files
/// Returns a Vec of DiffFile entries for each untracked file
fn get_untracked_files_diff(repo_path: &str) -> Vec<DiffFile> {
    let mut untracked_files: Vec<DiffFile> = Vec::new();

    // List all untracked files
    let output = silent_command("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(repo_path)
        .output();

    let Ok(o) = output else {
        return untracked_files;
    };

    if !o.status.success() {
        return untracked_files;
    }

    let stdout = String::from_utf8_lossy(&o.stdout);
    for file_path in stdout.lines() {
        if file_path.is_empty() {
            continue;
        }

        let full_path = std::path::Path::new(repo_path).join(file_path);

        // Try to read file content
        match std::fs::read_to_string(&full_path) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let line_count = lines.len() as u32;

                // Create diff lines (all additions)
                let diff_lines: Vec<DiffLine> = lines
                    .iter()
                    .enumerate()
                    .map(|(i, line)| DiffLine {
                        line_type: "addition".to_string(),
                        content: (*line).to_string(),
                        old_line_number: None,
                        new_line_number: Some((i + 1) as u32),
                    })
                    .collect();

                // Create a single hunk containing all lines
                let hunk = DiffHunk {
                    header: format!("@@ -0,0 +1,{line_count} @@"),
                    old_start: 0,
                    old_lines: 0,
                    new_start: 1,
                    new_lines: line_count,
                    lines: diff_lines,
                };

                untracked_files.push(DiffFile {
                    path: file_path.to_string(),
                    old_path: None,
                    status: "untracked".to_string(),
                    additions: line_count,
                    deletions: 0,
                    is_binary: false,
                    hunks: vec![hunk],
                });
            }
            Err(_) => {
                // Binary file or read error - mark as binary untracked
                untracked_files.push(DiffFile {
                    path: file_path.to_string(),
                    old_path: None,
                    status: "untracked".to_string(),
                    additions: 0,
                    deletions: 0,
                    is_binary: true,
                    hunks: Vec::new(),
                });
            }
        }
    }

    untracked_files
}

/// Get the number of lines added and removed compared to base branch (origin/main)
fn get_branch_diff_stats(repo_path: &str, base_branch: &str) -> (u32, u32) {
    // git diff --numstat origin/main...HEAD shows changes in current branch vs base
    let origin_ref = format!("origin/{base_branch}");
    let output = silent_command("git")
        .args(["diff", "--numstat", &format!("{origin_ref}...HEAD")])
        .current_dir(repo_path)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let mut added = 0u32;
            let mut removed = 0u32;
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    // Binary files show "-" instead of numbers
                    added += parts[0].parse().unwrap_or(0);
                    removed += parts[1].parse().unwrap_or(0);
                }
            }
            (added, removed)
        }
        _ => (0, 0),
    }
}

/// Check if a git ref exists
fn ref_exists(repo_path: &str, git_ref: &str) -> bool {
    silent_command("git")
        .args(["rev-parse", "--verify", "--quiet", git_ref])
        .current_dir(repo_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Count commits between two refs
/// Returns 0 if either ref doesn't exist
fn count_commits_between(repo_path: &str, from_ref: &str, to_ref: &str) -> u32 {
    let output = silent_command("git")
        .args(["rev-list", "--count", &format!("{from_ref}..{to_ref}")])
        .current_dir(repo_path)
        .output();

    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse()
            .unwrap_or(0),
        _ => 0,
    }
}

// ============================================================================
// Git Diff Types and Parsing
// ============================================================================

/// A single line in a diff hunk
#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    /// Line type: "context", "addition", "deletion"
    pub line_type: String,
    /// The actual content (without +/- prefix)
    pub content: String,
    /// Old line number (None for additions)
    pub old_line_number: Option<u32>,
    /// New line number (None for deletions)
    pub new_line_number: Option<u32>,
}

/// A single hunk in a diff
#[derive(Debug, Clone, Serialize)]
pub struct DiffHunk {
    /// Header line (e.g., "@@ -1,5 +1,7 @@")
    pub header: String,
    /// Old file starting line
    pub old_start: u32,
    /// Old file line count
    pub old_lines: u32,
    /// New file starting line
    pub new_start: u32,
    /// New file line count
    pub new_lines: u32,
    /// Lines in this hunk
    pub lines: Vec<DiffLine>,
}

/// A single file in a diff
#[derive(Debug, Clone, Serialize)]
pub struct DiffFile {
    /// File path relative to repo root
    pub path: String,
    /// Previous file path (for renames)
    pub old_path: Option<String>,
    /// File status: "added", "modified", "deleted", "renamed"
    pub status: String,
    /// Lines added
    pub additions: u32,
    /// Lines removed
    pub deletions: u32,
    /// Whether this is a binary file
    pub is_binary: bool,
    /// The actual diff hunks
    pub hunks: Vec<DiffHunk>,
}

/// Complete diff response
#[derive(Debug, Clone, Serialize)]
pub struct GitDiff {
    /// Type of diff: "uncommitted" or "branch"
    pub diff_type: String,
    /// Base ref (e.g., "origin/main" or "HEAD")
    pub base_ref: String,
    /// Target ref (e.g., "HEAD" or "working directory")
    pub target_ref: String,
    /// Total lines added
    pub total_additions: u32,
    /// Total lines removed
    pub total_deletions: u32,
    /// Files changed
    pub files: Vec<DiffFile>,
    /// Raw unified diff patch output (for rendering with external libraries)
    pub raw_patch: String,
}

/// Parse a hunk header like "@@ -1,5 +1,7 @@" or "@@ -0,0 +1,10 @@"
fn parse_hunk_header(header: &str) -> Option<(u32, u32, u32, u32)> {
    // Format: @@ -old_start,old_lines +new_start,new_lines @@
    let parts: Vec<&str> = header.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }

    let old_part = parts[1].trim_start_matches('-');
    let new_part = parts[2].trim_start_matches('+');

    let parse_range = |s: &str| -> (u32, u32) {
        if let Some((start, count)) = s.split_once(',') {
            (start.parse().unwrap_or(0), count.parse().unwrap_or(0))
        } else {
            (s.parse().unwrap_or(0), 1)
        }
    };

    let (old_start, old_lines) = parse_range(old_part);
    let (new_start, new_lines) = parse_range(new_part);

    Some((old_start, old_lines, new_start, new_lines))
}

/// Parse raw unified diff output into structured DiffFile entries and the raw patch string.
///
/// Shared by `get_git_diff` and `get_commit_diff` so the 150-line parser isn't duplicated.
pub fn parse_unified_diff(raw_output: &str) -> (Vec<DiffFile>, String) {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut current_file: Option<DiffFile> = None;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_line_num: u32 = 0;
    let mut new_line_num: u32 = 0;

    for line in raw_output.lines() {
        if line.starts_with("diff --git") {
            // Save previous hunk and file
            if let Some(hunk) = current_hunk.take() {
                if let Some(ref mut file) = current_file {
                    file.hunks.push(hunk);
                }
            }
            if let Some(file) = current_file.take() {
                files.push(file);
            }

            // Parse file paths from "diff --git a/path b/path"
            let parts: Vec<&str> = line.split_whitespace().collect();
            let path = if parts.len() >= 4 {
                parts[3].trim_start_matches("b/").to_string()
            } else {
                "unknown".to_string()
            };

            current_file = Some(DiffFile {
                path,
                old_path: None,
                status: "modified".to_string(),
                additions: 0,
                deletions: 0,
                is_binary: false,
                hunks: Vec::new(),
            });
        } else if line.starts_with("new file mode") {
            if let Some(ref mut file) = current_file {
                file.status = "added".to_string();
            }
        } else if line.starts_with("deleted file mode") {
            if let Some(ref mut file) = current_file {
                file.status = "deleted".to_string();
            }
        } else if line.starts_with("rename from ") {
            if let Some(ref mut file) = current_file {
                file.old_path = Some(line.trim_start_matches("rename from ").to_string());
                file.status = "renamed".to_string();
            }
        } else if line.starts_with("rename to ") {
            if let Some(ref mut file) = current_file {
                file.path = line.trim_start_matches("rename to ").to_string();
            }
        } else if line.starts_with("Binary files") {
            if let Some(ref mut file) = current_file {
                file.is_binary = true;
            }
        } else if line.starts_with("@@") {
            // Save previous hunk
            if let Some(hunk) = current_hunk.take() {
                if let Some(ref mut file) = current_file {
                    file.hunks.push(hunk);
                }
            }

            // Parse hunk header
            if let Some((old_start, old_lines, new_start, new_lines)) = parse_hunk_header(line) {
                old_line_num = old_start;
                new_line_num = new_start;
                current_hunk = Some(DiffHunk {
                    header: line.to_string(),
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    lines: Vec::new(),
                });
            }
        } else if line.starts_with('+') && !line.starts_with("+++") {
            if let Some(ref mut hunk) = current_hunk {
                hunk.lines.push(DiffLine {
                    line_type: "addition".to_string(),
                    content: line[1..].to_string(),
                    old_line_number: None,
                    new_line_number: Some(new_line_num),
                });
                new_line_num += 1;
                if let Some(ref mut file) = current_file {
                    file.additions += 1;
                }
            }
        } else if line.starts_with('-') && !line.starts_with("---") {
            if let Some(ref mut hunk) = current_hunk {
                hunk.lines.push(DiffLine {
                    line_type: "deletion".to_string(),
                    content: line[1..].to_string(),
                    old_line_number: Some(old_line_num),
                    new_line_number: None,
                });
                old_line_num += 1;
                if let Some(ref mut file) = current_file {
                    file.deletions += 1;
                }
            }
        } else if let Some(stripped) = line.strip_prefix(' ') {
            if let Some(ref mut hunk) = current_hunk {
                hunk.lines.push(DiffLine {
                    line_type: "context".to_string(),
                    content: stripped.to_string(),
                    old_line_number: Some(old_line_num),
                    new_line_number: Some(new_line_num),
                });
                old_line_num += 1;
                new_line_num += 1;
            }
        }
        // Skip other lines (---, +++, index, etc.)
    }

    // Save final hunk and file
    if let Some(hunk) = current_hunk.take() {
        if let Some(ref mut file) = current_file {
            file.hunks.push(hunk);
        }
    }
    if let Some(file) = current_file.take() {
        files.push(file);
    }

    (files, raw_output.to_string())
}

/// Get detailed diff content for a repository
///
/// `diff_type` can be "uncommitted" (working directory vs HEAD) or "branch" (HEAD vs base branch)
pub fn get_git_diff(
    repo_path: &str,
    diff_type: &str,
    base_branch: Option<&str>,
) -> Result<GitDiff, String> {
    let base = base_branch.unwrap_or("main");
    let range = format!("origin/{base}...HEAD");

    let (base_ref, target_ref, args): (String, String, Vec<&str>) = match diff_type {
        "uncommitted" => (
            "HEAD".to_string(),
            "working directory".to_string(),
            vec!["diff", "HEAD", "--unified=3"],
        ),
        "branch" => {
            let origin_ref = format!("origin/{base}");
            (
                origin_ref,
                "HEAD".to_string(),
                vec!["diff", "--unified=3", &range],
            )
        }
        _ => return Err(format!("Invalid diff_type: {diff_type}")),
    };

    let output = silent_command("git")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git diff: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git diff failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (mut files, raw_patch_base) = parse_unified_diff(&stdout);

    // Build raw patch - start with git diff output
    let mut raw_patch = raw_patch_base;

    // For uncommitted diffs, also include untracked (new) files
    if diff_type == "uncommitted" {
        let untracked_files = get_untracked_files_diff(repo_path);
        files.extend(untracked_files);

        // Add raw patch for untracked files
        let untracked_patch = get_untracked_files_raw_patch(repo_path);
        if !untracked_patch.is_empty() {
            raw_patch.push_str(&untracked_patch);
        }
    }

    // Calculate totals
    let total_additions: u32 = files.iter().map(|f| f.additions).sum();
    let total_deletions: u32 = files.iter().map(|f| f.deletions).sum();

    Ok(GitDiff {
        diff_type: diff_type.to_string(),
        base_ref,
        target_ref,
        total_additions,
        total_deletions,
        files,
        raw_patch,
    })
}

// ============================================================================
// Branch Status
// ============================================================================

/// Get the branch status for a worktree compared to its base branch
///
/// This fetches the latest from origin and compares the current HEAD
/// to origin/{base_branch} to determine ahead/behind counts.
pub fn get_branch_status(info: &ActiveWorktreeInfo) -> Result<GitBranchStatus, String> {
    let repo_path = &info.worktree_path;
    let base_branch = &info.base_branch;

    // Fetch latest from origin for the base branch
    // This is best-effort; if it fails, we'll compare with stale data
    let _ = fetch_origin_branch(repo_path, base_branch);

    // Get current branch name
    let current_branch = get_current_branch(repo_path)?;

    // Compare HEAD to origin/{base_branch}
    let origin_ref = format!("origin/{base_branch}");

    // Commits we're behind (commits in origin/base that aren't in HEAD)
    let behind_count = count_commits_between(repo_path, "HEAD", &origin_ref);

    // Commits we're ahead (commits in HEAD that aren't in origin/base)
    let ahead_count = count_commits_between(repo_path, &origin_ref, "HEAD");

    // Get uncommitted diff stats (working directory changes)
    let (uncommitted_added, uncommitted_removed) = get_uncommitted_diff_stats(repo_path);

    // Get branch diff stats (changes compared to base branch)
    let (branch_diff_added, branch_diff_removed) = get_branch_diff_stats(repo_path, base_branch);

    // Base branch's own remote sync status
    // Compare local base branch to origin/base_branch
    let base_branch_ahead_count = count_commits_between(repo_path, &origin_ref, base_branch);
    let base_branch_behind_count = count_commits_between(repo_path, base_branch, &origin_ref);

    // Commits unique to this worktree (ahead of local base branch)
    let worktree_ahead_count = count_commits_between(repo_path, base_branch, "HEAD");

    // Commits not yet pushed to the upstream tracking ref
    // Uses @{upstream} to support non-origin remotes (e.g., fork/branch)
    // Falls back to origin/{current_branch} if no upstream is configured
    let unpushed_count = if current_branch != *base_branch {
        let upstream_ref = get_upstream_ref(repo_path);

        if let Some(ref upstream) = upstream_ref {
            // Fetch the remote for the upstream ref (e.g., "fork" from "fork/branch")
            if let Some(remote) = upstream.split('/').next() {
                if remote != "origin" {
                    let _ = fetch_origin_branch_from_remote(repo_path, remote, &current_branch);
                } else {
                    let _ = fetch_origin_branch(repo_path, &current_branch);
                }
            }
            count_commits_between(repo_path, upstream, "HEAD")
        } else {
            // No upstream configured — try origin/{current_branch}
            let _ = fetch_origin_branch(repo_path, &current_branch);
            let origin_current_ref = format!("origin/{current_branch}");
            if ref_exists(repo_path, &origin_current_ref) {
                count_commits_between(repo_path, &origin_current_ref, "HEAD")
            } else {
                // Never pushed — all worktree-unique commits are unpushed
                worktree_ahead_count
            }
        }
    } else {
        // On the base branch itself, unpushed = base_branch_ahead_count
        base_branch_ahead_count
    };

    // Get current timestamp
    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(GitBranchStatus {
        worktree_id: info.worktree_id.clone(),
        current_branch,
        base_branch: base_branch.clone(),
        behind_count,
        ahead_count,
        has_updates: behind_count > 0,
        checked_at,
        uncommitted_added,
        uncommitted_removed,
        branch_diff_added,
        branch_diff_removed,
        base_branch_ahead_count,
        base_branch_behind_count,
        worktree_ahead_count,
        unpushed_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_git_branch_status_serialization() {
        let status = GitBranchStatus {
            worktree_id: "test-id".to_string(),
            current_branch: "feature/test".to_string(),
            base_branch: "main".to_string(),
            behind_count: 5,
            ahead_count: 3,
            has_updates: true,
            checked_at: 1234567890,
            uncommitted_added: 10,
            uncommitted_removed: 5,
            branch_diff_added: 150,
            branch_diff_removed: 42,
            base_branch_ahead_count: 2,
            base_branch_behind_count: 0,
            worktree_ahead_count: 3,
            unpushed_count: 1,
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"has_updates\":true"));
        assert!(json.contains("\"behind_count\":5"));
        assert!(json.contains("\"uncommitted_added\":10"));
        assert!(json.contains("\"branch_diff_added\":150"));
    }

    #[test]
    fn test_parse_hunk_header_standard() {
        // Standard hunk header
        let result = parse_hunk_header("@@ -1,5 +1,7 @@");
        assert_eq!(result, Some((1, 5, 1, 7)));
    }

    #[test]
    fn test_parse_hunk_header_new_file() {
        // New file (starts at 0,0)
        let result = parse_hunk_header("@@ -0,0 +1,10 @@");
        assert_eq!(result, Some((0, 0, 1, 10)));
    }

    #[test]
    fn test_parse_hunk_header_single_line() {
        // Single line (no comma, implicit count of 1)
        let result = parse_hunk_header("@@ -1 +1 @@");
        assert_eq!(result, Some((1, 1, 1, 1)));
    }

    #[test]
    fn test_parse_hunk_header_with_function_context() {
        // Header with function context
        let result = parse_hunk_header("@@ -10,5 +10,7 @@ fn main() {");
        assert_eq!(result, Some((10, 5, 10, 7)));
    }

    #[test]
    fn test_parse_hunk_header_large_numbers() {
        // Large line numbers
        let result = parse_hunk_header("@@ -1000,50 +1005,55 @@");
        assert_eq!(result, Some((1000, 50, 1005, 55)));
    }

    #[test]
    fn test_parse_hunk_header_delete_file() {
        // Deleted file (ends at 0,0)
        let result = parse_hunk_header("@@ -1,10 +0,0 @@");
        assert_eq!(result, Some((1, 10, 0, 0)));
    }

    #[test]
    fn test_parse_hunk_header_too_few_parts() {
        // Invalid format - fewer than 3 whitespace-separated parts
        assert_eq!(parse_hunk_header(""), None);
        assert_eq!(parse_hunk_header("@@"), None);
        assert_eq!(parse_hunk_header("@@ -1,5"), None);
    }

    #[test]
    fn test_parse_hunk_header_mixed_single_and_range() {
        // Mixed: one side single line, other side range
        let result = parse_hunk_header("@@ -5 +5,3 @@");
        assert_eq!(result, Some((5, 1, 5, 3)));

        let result = parse_hunk_header("@@ -5,3 +5 @@");
        assert_eq!(result, Some((5, 3, 5, 1)));
    }

    #[test]
    fn test_diff_file_serialization() {
        let file = DiffFile {
            path: "src/main.rs".to_string(),
            old_path: None,
            status: "modified".to_string(),
            additions: 10,
            deletions: 5,
            is_binary: false,
            hunks: Vec::new(),
        };

        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains("\"path\":\"src/main.rs\""));
        assert!(json.contains("\"status\":\"modified\""));
        assert!(json.contains("\"additions\":10"));
        assert!(json.contains("\"deletions\":5"));
    }

    #[test]
    fn test_diff_file_with_rename() {
        let file = DiffFile {
            path: "src/new_name.rs".to_string(),
            old_path: Some("src/old_name.rs".to_string()),
            status: "renamed".to_string(),
            additions: 0,
            deletions: 0,
            is_binary: false,
            hunks: Vec::new(),
        };

        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains("\"old_path\":\"src/old_name.rs\""));
        assert!(json.contains("\"status\":\"renamed\""));
    }

    #[test]
    fn test_diff_line_serialization() {
        let line = DiffLine {
            line_type: "addition".to_string(),
            content: "let x = 42;".to_string(),
            old_line_number: None,
            new_line_number: Some(10),
        };

        let json = serde_json::to_string(&line).unwrap();
        assert!(json.contains("\"line_type\":\"addition\""));
        assert!(json.contains("\"new_line_number\":10"));
        assert!(json.contains("\"old_line_number\":null"));
    }

    #[test]
    fn test_diff_hunk_serialization() {
        let hunk = DiffHunk {
            header: "@@ -1,5 +1,7 @@".to_string(),
            old_start: 1,
            old_lines: 5,
            new_start: 1,
            new_lines: 7,
            lines: vec![
                DiffLine {
                    line_type: "context".to_string(),
                    content: "fn main() {".to_string(),
                    old_line_number: Some(1),
                    new_line_number: Some(1),
                },
                DiffLine {
                    line_type: "addition".to_string(),
                    content: "    let x = 42;".to_string(),
                    old_line_number: None,
                    new_line_number: Some(2),
                },
            ],
        };

        let json = serde_json::to_string(&hunk).unwrap();
        assert!(json.contains("\"old_start\":1"));
        assert!(json.contains("\"new_lines\":7"));
    }
}
