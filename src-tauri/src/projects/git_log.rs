use crate::platform::silent_command;
use serde::Serialize;

use super::git_status::{parse_unified_diff, GitDiff};

/// Metadata for a single commit
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    /// Full 40-char SHA
    pub sha: String,
    /// Abbreviated 7-char SHA
    pub short_sha: String,
    /// Subject line of the commit message
    pub message: String,
    /// Author name
    pub author_name: String,
    /// Author date in ISO 8601 format
    pub author_date: String,
    /// Total lines added
    pub additions: u32,
    /// Total lines removed
    pub deletions: u32,
}

/// Paginated commit history result
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitHistoryResult {
    pub commits: Vec<CommitInfo>,
    pub total_count: u32,
    pub has_more: bool,
}

/// Marker prefix for commit metadata lines in structured git log output.
/// Using NUL byte as field delimiter (safe — git guarantees NUL-free metadata).
const COMMIT_MARKER: &str = "COMMIT\x00";

/// Get paginated commit history for a branch.
///
/// `branch` defaults to HEAD if None. Uses `git log` with `--numstat`
/// for +/- stats. No checkout is performed — branch name is passed directly.
///
/// Parsing uses a line-by-line approach: metadata lines start with `COMMIT_MARKER`,
/// and subsequent non-empty lines containing tabs are numstat entries for that commit.
pub fn get_commit_history(
    repo_path: &str,
    branch: Option<&str>,
    limit: u32,
    skip: u32,
) -> Result<CommitHistoryResult, String> {
    let branch_ref = branch.unwrap_or("HEAD");

    // Get total count
    let count_output = silent_command("git")
        .args(["rev-list", "--count", branch_ref, "--"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to count commits: {e}"))?;

    let total_count: u32 = if count_output.status.success() {
        String::from_utf8_lossy(&count_output.stdout)
            .trim()
            .parse()
            .unwrap_or(0)
    } else {
        0
    };

    // Fetch limit+1 to detect has_more
    let fetch_limit = limit + 1;
    let skip_str = format!("--skip={skip}");
    let limit_str = format!("-{fetch_limit}");
    // Format: COMMIT\0SHA\0short\0subject\0author\0date
    // Each metadata line starts with the literal COMMIT prefix + NUL-delimited fields.
    // --numstat lines follow each commit (tab-separated: add\tdel\tfile).
    let format_str = String::from("--format=COMMIT%x00%H%x00%h%x00%s%x00%an%x00%aI");

    let output = silent_command("git")
        .args([
            "log",
            &limit_str,
            &skip_str,
            &format_str,
            "--numstat",
            "-m",
            "--first-parent",
            branch_ref,
            "--",
        ])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git log: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git log failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits: Vec<CommitInfo> = Vec::new();
    let mut current: Option<CommitInfo> = None;

    // Line-by-line parsing: COMMIT\0 lines start a new commit,
    // tab-separated lines are numstat for the current commit.
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix(COMMIT_MARKER) {
            // Flush previous commit
            if let Some(commit) = current.take() {
                commits.push(commit);
            }
            // Parse: SHA\0short\0subject\0author\0date
            let fields: Vec<&str> = rest.split('\x00').collect();
            if fields.len() >= 5 {
                current = Some(CommitInfo {
                    sha: fields[0].to_string(),
                    short_sha: fields[1].to_string(),
                    message: fields[2].to_string(),
                    author_name: fields[3].to_string(),
                    author_date: fields[4].to_string(),
                    additions: 0,
                    deletions: 0,
                });
            }
        } else if let Some(ref mut commit) = current {
            // numstat line: "additions\tdeletions\tfilename"
            // Binary files show "-\t-\tfilename" — skip those.
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 && parts[0] != "-" {
                commit.additions += parts[0].parse::<u32>().unwrap_or(0);
                commit.deletions += parts[1].parse::<u32>().unwrap_or(0);
            }
        }
    }

    // Flush last commit
    if let Some(commit) = current {
        commits.push(commit);
    }

    let has_more = commits.len() > limit as usize;
    commits.truncate(limit as usize);

    Ok(CommitHistoryResult {
        commits,
        total_count,
        has_more,
    })
}

/// Get the unified diff for a single commit.
///
/// Uses `git diff <sha>^..<sha>` for normal commits,
/// `git diff-tree -p <sha>` for root commits (no parent).
pub fn get_commit_diff(repo_path: &str, commit_sha: &str) -> Result<GitDiff, String> {
    // Try normal diff first (sha^..sha)
    let parent_ref = format!("{commit_sha}^");
    let range = format!("{parent_ref}..{commit_sha}");

    let output = silent_command("git")
        .args(["diff", "--unified=3", &range])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git diff: {e}"))?;

    let stdout = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        // Might be root commit — try diff-tree
        let fallback = silent_command("git")
            .args(["diff-tree", "-p", "--unified=3", "--root", commit_sha])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to run git diff-tree: {e}"))?;

        if !fallback.status.success() {
            let stderr = String::from_utf8_lossy(&fallback.stderr);
            return Err(format!("Git diff failed for commit {commit_sha}: {stderr}"));
        }
        String::from_utf8_lossy(&fallback.stdout).to_string()
    };

    let (files, raw_patch) = parse_unified_diff(&stdout);

    let total_additions: u32 = files.iter().map(|f| f.additions).sum();
    let total_deletions: u32 = files.iter().map(|f| f.deletions).sum();

    Ok(GitDiff {
        diff_type: "commit".to_string(),
        base_ref: parent_ref,
        target_ref: commit_sha.to_string(),
        total_additions,
        total_deletions,
        files,
        raw_patch,
    })
}
