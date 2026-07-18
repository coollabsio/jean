use crate::platform::silent_command;
use crate::platform::wsl_aware_command;
use once_cell::sync::Lazy;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::types::{JeanConfig, MergeType};

fn gh_command(gh: &Path, repo_path: &str) -> std::process::Command {
    crate::platform::resolved_cli_command(gh, Some(Path::new(repo_path)))
}

static WORKTREE_CREATE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
const WORKTREE_CREATE_ATTEMPTS: usize = 4;

/// Resolve the git metadata directories for a working directory.
///
/// Returns `(git_dir, git_common_dir)` as absolute, canonicalized paths.
/// - `git_dir`: worktree-specific metadata (e.g., `/repo/.git/worktrees/feat-x`)
/// - `git_common_dir`: shared metadata (e.g., `/repo/.git`)
///
/// For non-worktree repos, both point to the same `.git` directory.
/// Returns `None` if the path is not a git repo or the command fails.
pub fn resolve_git_dirs(working_dir: &Path) -> Option<(String, String)> {
    let output = silent_command("git")
        .args(["rev-parse", "--git-dir", "--git-common-dir"])
        .current_dir(working_dir)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let git_dir_raw = lines.next()?.trim();
    let git_common_dir_raw = lines.next()?.trim();

    let resolve = |p: &str| -> Option<String> {
        let path = Path::new(p);
        let abs = if path.is_absolute() {
            path.to_path_buf()
        } else {
            working_dir.join(path)
        };
        std::fs::canonicalize(&abs)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    };

    Some((resolve(git_dir_raw)?, resolve(git_common_dir_raw)?))
}

/// Repository identifier extracted from GitHub remote URL
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoIdentifier {
    pub owner: String,
    pub repo: String,
}

impl RepoIdentifier {
    /// Create a key string for use in file naming: "{owner}-{repo}"
    pub fn to_key(&self) -> String {
        format!("{}-{}", self.owner, self.repo)
    }
}

/// Extract repository owner and name from a git repository's GitHub remote
///
/// Returns an error if:
/// - The repository has no origin remote
/// - The remote URL is not a GitHub URL
pub fn get_repo_identifier(repo_path: &str) -> Result<RepoIdentifier, String> {
    let github_url = get_github_url(repo_path)?;

    // Parse owner/repo from URL: https://github.com/owner/repo
    let url_without_prefix = github_url
        .strip_prefix("https://github.com/")
        .ok_or_else(|| format!("Invalid GitHub URL format: {github_url}"))?;

    let parts: Vec<&str> = url_without_prefix.split('/').collect();
    if parts.len() < 2 {
        return Err(format!(
            "Could not parse owner/repo from GitHub URL: {github_url}"
        ));
    }

    Ok(RepoIdentifier {
        owner: parts[0].to_string(),
        repo: parts[1].to_string(),
    })
}

/// Detect user's default shell and determine if it supports login mode.
///
/// On macOS/Linux, GUI apps don't inherit the user's shell PATH. Using a login shell
/// (`-l` flag) sources the user's shell profile (.zshrc, .bashrc, etc.) which
/// includes PATH modifications for tools like bun, nvm, homebrew, etc.
///
/// On Windows, PowerShell doesn't have a login mode concept.
#[cfg(unix)]
fn get_user_shell() -> (String, bool) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

    // Check if shell supports -l (login) flag
    let supports_login = shell.ends_with("bash")
        || shell.ends_with("zsh")
        || shell.ends_with("fish")
        || shell.ends_with("ksh")
        || shell.ends_with("tcsh");

    (shell, supports_login)
}

#[cfg(windows)]
fn get_user_shell() -> (String, bool) {
    // Windows PowerShell doesn't have a login mode concept
    ("powershell.exe".to_string(), false)
}

/// Check if a path is a valid git repository
pub fn validate_git_repo(path: &str) -> Result<bool, String> {
    let path = Path::new(path);

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    // Check for .git directory or file (could be a worktree)
    let git_path = path.join(".git");
    Ok(git_path.exists())
}

/// Initialize a new git repository at the given path
///
/// Creates the directory if it doesn't exist, runs `git init`, and creates an initial commit
pub fn init_repo(path: &str) -> Result<(), String> {
    let path_obj = Path::new(path);

    // Create directory if it doesn't exist
    if !path_obj.exists() {
        std::fs::create_dir_all(path_obj)
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }

    // Check if directory already has .git
    let git_path = path_obj.join(".git");
    if git_path.exists() {
        // Check if it has any commits
        let has_commits = wsl_aware_command("git", Some(Path::new(path)))
            .args(["rev-parse", "HEAD"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if has_commits {
            return Err("Directory is already a git repository".to_string());
        }
        // No commits yet, skip git init and just create the initial commit
        log::trace!("Git repo exists but has no commits, will create initial commit");
    } else {
        // Run git init
        let output = wsl_aware_command("git", Some(Path::new(path)))
            .args(["init"])
            .output()
            .map_err(|e| format!("Failed to run git init: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git init failed: {stderr}"));
        }
    }

    // Create .gitkeep file so we have something to commit
    let gitkeep_path = path_obj.join(".gitkeep");
    std::fs::write(&gitkeep_path, "").map_err(|e| format!("Failed to create .gitkeep: {e}"))?;

    // Stage the file
    let add_output = wsl_aware_command("git", Some(Path::new(path)))
        .args(["add", ".gitkeep"])
        .output()
        .map_err(|e| format!("Failed to run git add: {e}"))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("git add failed: {stderr}"));
    }

    // Create initial commit
    let commit_output = wsl_aware_command("git", Some(Path::new(path)))
        .args(["commit", "-m", "jean's init vibe commit"])
        .output()
        .map_err(|e| format!("Failed to run git commit: {e}"))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {stderr}"));
    }

    log::trace!("Successfully initialized git repository at {path} with initial commit");
    Ok(())
}

/// Extract a repository name from a git URL
///
/// Handles HTTPS (`https://github.com/user/repo.git`) and SSH (`git@github.com:user/repo.git`) formats.
/// Strips `.git` suffix if present.
pub fn extract_repo_name_from_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');

    // Get the last path segment
    let name = trimmed
        .rsplit('/')
        .next()
        // SSH format: git@host:user/repo.git — split on ':'  then take last
        .or_else(|| trimmed.rsplit(':').next())
        .ok_or_else(|| format!("Could not extract repository name from URL: {url}"))?;

    // Strip .git suffix
    let name = name.strip_suffix(".git").unwrap_or(name);

    if name.is_empty() {
        return Err(format!("Could not extract repository name from URL: {url}"));
    }

    Ok(name.to_string())
}

/// Clone a git repository from a remote URL to a local destination
pub fn clone_repo(url: &str, destination: &str) -> Result<(), String> {
    let url = url.trim();

    // Basic URL format validation
    let valid_prefix = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("git@")
        || url.starts_with("ssh://");

    if !valid_prefix {
        return Err(
            "Invalid git URL. Use HTTPS (https://...) or SSH (git@...) format.".to_string(),
        );
    }

    // Check destination doesn't already exist
    let dest_path = Path::new(destination);
    if dest_path.exists() {
        return Err(format!("Destination already exists: {destination}"));
    }

    // Ensure parent directory exists
    if let Some(parent) = dest_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
    }

    log::info!("Cloning {url} into {destination}");

    let output = wsl_aware_command("git", None)
        .args(["clone", url, destination])
        .output()
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git clone failed: {stderr}"));
    }

    log::info!("Successfully cloned repository to {destination}");
    Ok(())
}

/// Get the repository name from a path (last component of the path)
pub fn get_repo_name(path: &str) -> Result<String, String> {
    let path = Path::new(path);

    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "Could not extract repository name from path: {}",
                path.display()
            )
        })
}

/// A git remote name
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRemote {
    pub name: String,
}

/// A GitHub remote with its name and resolved HTTPS URL
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRemote {
    pub name: String,
    pub url: String,
}

/// Convert a raw git remote URL to a GitHub HTTPS URL, if possible
fn normalize_github_url(remote_url: &str) -> Option<String> {
    if remote_url.starts_with("git@github.com:") {
        Some(
            remote_url
                .replace("git@github.com:", "https://github.com/")
                .trim_end_matches(".git")
                .to_string(),
        )
    } else if remote_url.starts_with("https://github.com/") {
        Some(remote_url.trim_end_matches(".git").to_string())
    } else {
        None
    }
}

/// Get the GitHub URL for a specific remote
pub fn get_github_url_for_remote(repo_path: &str, remote: &str) -> Result<String, String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["remote", "get-url", remote])
        .output()
        .map_err(|e| format!("Failed to get remote URL: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get remote URL: {stderr}"));
    }

    let remote_url = String::from_utf8_lossy(&output.stdout).trim().to_string();

    normalize_github_url(&remote_url)
        .ok_or_else(|| format!("Remote URL is not a GitHub repository: {remote_url}"))
}

/// Get the GitHub URL for a repository (uses "origin" remote)
pub fn get_github_url(repo_path: &str) -> Result<String, String> {
    get_github_url_for_remote(repo_path, "origin")
}

/// Get all GitHub remotes for a repository
pub fn get_github_remotes(repo_path: &str) -> Result<Vec<GitHubRemote>, String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["remote"])
        .output()
        .map_err(|e| format!("Failed to list remotes: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list remotes: {stderr}"));
    }

    let remote_names: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let mut result = Vec::new();

    for name in remote_names {
        if let Ok(url_out) = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["remote", "get-url", &name])
            .output()
        {
            if url_out.status.success() {
                let raw = String::from_utf8_lossy(&url_out.stdout).trim().to_string();
                if let Some(url) = normalize_github_url(&raw) {
                    result.push(GitHubRemote { name, url });
                }
            }
        }
    }

    result.sort_by_key(|r| if r.name == "origin" { 0 } else { 1 });

    Ok(result)
}

/// Remove a git remote from a repository
pub fn remove_git_remote(repo_path: &str, remote_name: &str) -> Result<(), String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["remote", "remove", remote_name])
        .output()
        .map_err(|e| format!("Failed to remove remote: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to remove remote: {stderr}"));
    }

    Ok(())
}

/// Get all git remotes for a repository (not filtered to GitHub)
pub fn get_git_remotes(repo_path: &str) -> Result<Vec<GitRemote>, String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["remote"])
        .output()
        .map_err(|e| format!("Failed to list remotes: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list remotes: {stderr}"));
    }

    let remotes = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .map(|name| GitRemote { name })
        .collect();

    Ok(remotes)
}

/// Get the current branch name (HEAD) for a repository
/// Uses symbolic-ref first (works on repos with no commits), falls back to rev-parse
pub fn get_current_branch(repo_path: &str) -> Result<String, String> {
    // Try symbolic-ref first — works even on empty repos (no commits yet)
    let sym_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["symbolic-ref", "--short", "HEAD"])
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
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to run git command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get current branch: {stderr}"));
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(branch)
}

/// Check if a branch exists in a repository
pub fn branch_exists(repo_path: &str, branch_name: &str) -> bool {
    wsl_aware_command("git", Some(Path::new(repo_path)))
        .args([
            "rev-parse",
            "--verify",
            &format!("refs/heads/{branch_name}"),
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if a remote-tracking branch exists (refs/remotes/origin/<branch>)
pub fn remote_branch_exists(repo_path: &str, branch_name: &str) -> bool {
    wsl_aware_command("git", Some(Path::new(repo_path)))
        .args([
            "rev-parse",
            "--verify",
            &format!("refs/remotes/origin/{branch_name}"),
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if a repository has any commits
pub fn has_commits(repo_path: &str) -> bool {
    wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["rev-parse", "HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Get a valid base branch for creating worktrees
///
/// Tries the provided branch first, then falls back to common defaults (main, master)
/// or the current branch if none of those exist.
/// Returns an error if the repository has no commits yet.
pub fn get_valid_base_branch(repo_path: &str, preferred_branch: &str) -> Result<String, String> {
    // First check if repo has any commits - worktrees require at least one commit
    if !has_commits(repo_path) {
        return Err("Cannot create worktree: repository has no commits yet. \
             Please make an initial commit first."
            .to_string());
    }

    // Try preferred branch first (local or remote-tracking)
    if branch_exists(repo_path, preferred_branch)
        || remote_branch_exists(repo_path, preferred_branch)
    {
        return Ok(preferred_branch.to_string());
    }

    log::warn!("Preferred branch '{preferred_branch}' not found, trying fallbacks");

    // Try common defaults
    for fallback in &["main", "master"] {
        if branch_exists(repo_path, fallback) {
            log::trace!("Using fallback branch: {fallback}");
            return Ok(fallback.to_string());
        }
    }

    // Last resort: use current branch
    let current = get_current_branch(repo_path)?;
    log::trace!("Using current branch as fallback: {current}");
    Ok(current)
}

/// Rename the current branch to a new name
///
/// # Arguments
/// * `repo_path` - Path to the repository (can be a worktree)
/// * `new_name` - The new name for the branch
///
/// Returns the old branch name on success
pub fn rename_branch(repo_path: &str, new_name: &str) -> Result<String, String> {
    log::trace!("Renaming current branch to {new_name} in {repo_path}");

    // First check if we're in detached HEAD state
    let head_check = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["symbolic-ref", "--short", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to check HEAD state: {e}"))?;

    if !head_check.status.success() {
        return Err("Cannot rename branch: HEAD is detached".to_string());
    }

    let old_name = String::from_utf8_lossy(&head_check.stdout)
        .trim()
        .to_string();

    // Skip if already named the same
    if old_name == new_name {
        log::trace!("Branch already named {new_name}, skipping rename");
        return Ok(old_name);
    }

    // Check if target branch name already exists
    let branch_exists = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["rev-parse", "--verify", &format!("refs/heads/{}", new_name)])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let final_name = if branch_exists {
        // Append suffix to make unique
        find_unique_branch_name(repo_path, new_name)?
    } else {
        new_name.to_string()
    };

    // Perform the rename
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["branch", "-m", &final_name])
        .output()
        .map_err(|e| format!("Failed to rename branch: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git branch rename failed: {stderr}"));
    }

    log::trace!("Successfully renamed branch from {old_name} to {final_name}");
    Ok(final_name)
}

/// Find a unique branch name by appending a random 4-char suffix
fn find_unique_branch_name(repo_path: &str, base_name: &str) -> Result<String, String> {
    use rand::Rng;

    for _ in 0..10 {
        let suffix: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(4)
            .map(char::from)
            .map(|c| c.to_ascii_lowercase())
            .collect();

        let candidate = format!("{base_name}-{suffix}");
        let exists = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["rev-parse", "--verify", &format!("refs/heads/{candidate}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !exists {
            log::trace!("Using unique branch name: {candidate}");
            return Ok(candidate);
        }
    }
    Err("Could not find unique branch name after 10 attempts".to_string())
}

/// Get list of local branches for a repository
pub fn get_branches(repo_path: &str) -> Result<Vec<String>, String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["branch", "--format=%(refname:short)"])
        .output()
        .map_err(|e| format!("Failed to run git command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list branches: {stderr}"));
    }

    let branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(branches)
}

/// Fetch a branch from remote without merging (safe, no conflict risk)
pub fn git_fetch(repo_path: &str, branch: &str, remote: Option<&str>) -> Result<(), String> {
    let remote = remote.unwrap_or("origin");
    log::trace!("Fetching {remote}/{branch} in {repo_path}");

    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["fetch", remote, branch])
        .output()
        .map_err(|e| format!("Failed to run git fetch: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        log::error!("Failed to fetch {remote}/{branch}: {stderr}");
        return Err(stderr);
    }

    log::trace!("Successfully fetched {remote}/{branch}");
    Ok(())
}

/// Pull changes from remote origin for the specified base branch
pub fn git_pull(
    repo_path: &str,
    base_branch: &str,
    remote: Option<&str>,
) -> Result<String, String> {
    let remote = remote.unwrap_or("origin");
    log::trace!("Pulling from {remote}/{base_branch} in {repo_path}");

    // Use explicit fetch + merge instead of `git pull` to avoid
    // "Cannot rebase onto multiple branches" when pull.rebase=true
    // is set in git config (common in worktree contexts)
    let fetch = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["fetch", remote, base_branch])
        .output()
        .map_err(|e| format!("Failed to run git fetch: {e}"))?;

    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr).to_string();
        log::error!("Failed to fetch {remote}/{base_branch}: {stderr}");
        return Err(stderr);
    }

    let merge = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["merge", &format!("{remote}/{base_branch}")])
        .output()
        .map_err(|e| format!("Failed to run git merge: {e}"))?;

    if merge.status.success() {
        let stdout = String::from_utf8_lossy(&merge.stdout).to_string();
        log::trace!("Successfully merged origin/{base_branch}");
        Ok(stdout)
    } else {
        let stdout_str = String::from_utf8_lossy(&merge.stdout);
        let stderr_str = String::from_utf8_lossy(&merge.stderr);

        // Check for merge conflicts (git reports these on stdout)
        if stdout_str.contains("CONFLICT") || stdout_str.contains("Automatic merge failed") {
            let conflicts = wsl_aware_command("git", Some(Path::new(repo_path)))
                .args(["diff", "--name-only", "--diff-filter=U"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();

            let msg = format!(
                "Merge conflicts in: {conflicts}. Resolve manually or run 'git merge --abort'"
            );
            log::warn!("Merge conflicts during pull: {conflicts}");
            return Err(msg);
        }

        // Fallback: prefer stderr, else stdout
        let error = if stderr_str.trim().is_empty() {
            stdout_str.trim().to_string()
        } else {
            stderr_str.trim().to_string()
        };
        log::error!("Failed to merge origin/{base_branch}: {error}");
        Err(error)
    }
}

/// Stash all local changes including untracked files
pub fn git_stash(repo_path: &str) -> Result<String, String> {
    log::trace!("Stashing changes in {repo_path}");

    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["stash", "--include-untracked"])
        .output()
        .map_err(|e| format!("Failed to run git stash: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        log::trace!("Stash result: {stdout}");
        Ok(stdout)
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{stdout}\n{stderr}").trim().to_string();
        log::error!("Failed to stash: {combined}");
        Err(combined)
    }
}

/// Pop the most recent stash
pub fn git_stash_pop(repo_path: &str) -> Result<String, String> {
    log::trace!("Popping stash in {repo_path}");

    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["stash", "pop"])
        .output()
        .map_err(|e| format!("Failed to run git stash pop: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        log::trace!("Stash pop result: {stdout}");
        Ok(stdout)
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let combined = format!("{stdout}\n{stderr}").trim().to_string();
        log::error!("Failed to pop stash: {combined}");
        Err(combined)
    }
}

fn push_output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    // Git push often outputs to stderr even on success
    if stdout.is_empty() {
        stderr
    } else {
        stdout
    }
}

fn git_push_needs_upstream_retry(stderr: &str) -> bool {
    stderr.contains("has no upstream branch")
        || stderr.contains("upstream branch of your current branch does not match")
        || stderr.contains("push.default is set to simple")
}

fn current_upstream(repo_path: &str) -> Option<(String, String)> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let upstream = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let (remote, branch) = upstream.split_once('/')?;
    if remote.is_empty() || branch.is_empty() {
        return None;
    }

    Some((remote.to_string(), branch.to_string()))
}

fn git_push_set_upstream(repo_path: &str, remote: &str) -> Result<String, String> {
    log::trace!("Publishing branch with upstream: git push -u {remote} HEAD");
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["push", "-u", remote, "HEAD"])
        .output()
        .map_err(|e| format!("Failed to run git push -u: {e}"))?;

    if output.status.success() {
        log::trace!("Successfully pushed with upstream set");
        Ok(push_output_text(&output))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        log::error!("Failed to push with -u: {stderr}");
        Err(stderr)
    }
}

/// Push current branch to remote.
///
/// New Jean worktrees are created from `origin/<base>`, which can make the new
/// local branch track `origin/main`. A plain `git push origin` then fails when
/// `push.default=simple` because the upstream branch name differs. Publish with
/// `-u <remote> HEAD` whenever upstream is missing or not the same-named branch
/// on the selected remote.
pub fn git_push(repo_path: &str, remote: Option<&str>) -> Result<String, String> {
    let remote = remote.unwrap_or("origin");
    log::trace!("Pushing to {remote} in {repo_path}");

    let current_branch = get_current_branch(repo_path)?;
    let upstream_matches = current_upstream(repo_path)
        .map(|(upstream_remote, upstream_branch)| {
            upstream_remote == remote && upstream_branch == current_branch
        })
        .unwrap_or(false);

    if !upstream_matches {
        log::trace!("Upstream is missing or mismatched; publishing {current_branch} to {remote}");
        return git_push_set_upstream(repo_path, remote);
    }

    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["push", remote])
        .output()
        .map_err(|e| format!("Failed to run git push: {e}"))?;

    if output.status.success() {
        let result = push_output_text(&output);
        log::trace!("Successfully pushed to {remote}");
        Ok(result)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if git_push_needs_upstream_retry(&stderr) {
            log::trace!("Push failed due to upstream config, retrying with -u {remote} HEAD");
            return git_push_set_upstream(repo_path, remote);
        }

        log::error!("Failed to push to {remote}: {stderr}");
        Err(stderr)
    }
}

/// Result of a PR-aware push operation
pub struct PushResult {
    pub output: String,
    /// true when we tried to push to the PR branch but failed and fell back to a regular push
    pub fell_back: bool,
    /// true when push failed due to permission/authentication errors (e.g. fork PR without write access)
    pub permission_denied: bool,
    /// Remote actually pushed to (e.g., "origin" or a fork owner). None on fallback/denied.
    pub pushed_remote: Option<String>,
    /// Branch on pushed_remote that was updated. None on fallback/denied.
    pub pushed_branch: Option<String>,
}

/// Check if a git push stderr indicates a permission/authentication error
fn is_permission_error(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("permission")
        || lower.contains("denied")
        || lower.contains("403")
        || lower.contains("could not read username")
        || lower.contains("write access")
        || lower.contains("authentication failed")
        || lower.contains("not allowed")
}

/// Push to a PR's remote branch, handling fork PRs by adding the fork remote if needed.
/// Uses --force-with-lease for safety. Falls back to regular push (new branch) on failure.
///
/// Flow:
/// 1. Query gh pr view for fork info
/// 2. Same-repo PR: push to origin
/// 3. Fork PR: add fork remote if needed, fetch, push
/// 4. On failure: fall back to regular push (git push -u origin HEAD)
pub fn git_push_to_pr(
    repo_path: &str,
    pr_number: u32,
    gh_binary: &std::path::Path,
) -> Result<PushResult, String> {
    log::trace!("Pushing to PR #{pr_number} remote branch in {repo_path}");

    // 1. Query PR info from GitHub
    let gh_output = gh_command(gh_binary, repo_path)
        .args([
            "pr",
            "view",
            &pr_number.to_string(),
            "--json",
            "headRefName,isCrossRepository,headRepositoryOwner,headRepository",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr view: {e}"))?;

    if !gh_output.status.success() {
        let stderr = String::from_utf8_lossy(&gh_output.stderr).to_string();
        log::warn!("gh pr view failed, falling back to regular push: {stderr}");
        let output = git_push(repo_path, None)?;
        return Ok(PushResult {
            output,
            fell_back: true,
            permission_denied: false,
            pushed_remote: None,
            pushed_branch: None,
        });
    }

    let pr_info: serde_json::Value = serde_json::from_slice(&gh_output.stdout)
        .map_err(|e| format!("Failed to parse gh pr view output: {e}"))?;

    let head_ref_name = pr_info["headRefName"]
        .as_str()
        .ok_or_else(|| "Missing headRefName in PR info".to_string())?;
    let is_cross_repository = pr_info["isCrossRepository"].as_bool().unwrap_or(false);

    if !is_cross_repository {
        // Same-repo PR: push HEAD to origin/{head_ref_name} with --force-with-lease
        let refspec = format!("HEAD:{head_ref_name}");
        log::trace!("Same-repo PR, pushing {refspec} to origin");
        let output = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["push", "--force-with-lease", "origin", &refspec])
            .output()
            .map_err(|e| format!("Failed to run git push: {e}"))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let result = if stdout.is_empty() { stderr } else { stdout };
            log::trace!("Successfully pushed to origin/{head_ref_name}");
            return Ok(PushResult {
                output: result,
                fell_back: false,
                permission_denied: false,
                pushed_remote: Some("origin".to_string()),
                pushed_branch: Some(head_ref_name.to_string()),
            });
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if is_permission_error(&stderr) {
                log::warn!("Permission denied pushing to origin/{head_ref_name}: {stderr}");
                return Ok(PushResult {
                    output: stderr,
                    fell_back: false,
                    permission_denied: true,
                    pushed_remote: None,
                    pushed_branch: None,
                });
            }
            log::warn!(
                "Failed to push to origin/{head_ref_name}, falling back to regular push: {stderr}"
            );
            let fallback_output = git_push(repo_path, None)?;
            return Ok(PushResult {
                output: fallback_output,
                fell_back: true,
                permission_denied: false,
                pushed_remote: None,
                pushed_branch: None,
            });
        }
    }

    // Fork PR: need to add fork remote and push there
    let fork_owner = pr_info["headRepositoryOwner"]["login"]
        .as_str()
        .ok_or_else(|| "Missing headRepositoryOwner.login in PR info".to_string())?;
    let fork_repo_name = pr_info["headRepository"]["name"]
        .as_str()
        .ok_or_else(|| "Missing headRepository.name in PR info".to_string())?;

    log::trace!("Fork PR from {fork_owner}/{fork_repo_name}, branch {head_ref_name}");

    // Determine URL scheme from origin
    let origin_url_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["remote", "get-url", "origin"])
        .output()
        .map_err(|e| format!("Failed to get origin URL: {e}"))?;

    let origin_url = String::from_utf8_lossy(&origin_url_output.stdout)
        .trim()
        .to_string();
    let fork_url = if origin_url.starts_with("git@") || origin_url.starts_with("ssh://") {
        format!("git@github.com:{fork_owner}/{fork_repo_name}.git")
    } else {
        format!("https://github.com/{fork_owner}/{fork_repo_name}.git")
    };

    log::trace!("Fork URL: {fork_url}");

    // Check if a remote for this fork already exists
    let remotes_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["remote", "-v"])
        .output()
        .map_err(|e| format!("Failed to list remotes: {e}"))?;

    let remotes_str = String::from_utf8_lossy(&remotes_output.stdout);
    let remote_name = remotes_str
        .lines()
        .find(|line| {
            line.contains(&fork_url) || line.contains(&format!("{fork_owner}/{fork_repo_name}"))
        })
        .and_then(|line| line.split_whitespace().next())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            // Add the fork remote
            log::trace!("Adding fork remote: {fork_owner} -> {fork_url}");
            let add_output = wsl_aware_command("git", Some(Path::new(repo_path)))
                .args(["remote", "add", fork_owner, &fork_url])
                .output();

            if let Err(e) = &add_output {
                log::warn!("Failed to add fork remote: {e}");
            } else if let Ok(out) = &add_output {
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    log::warn!("git remote add failed: {stderr}");
                }
            }

            fork_owner.to_string()
        });

    // Fetch the branch from the fork remote
    log::trace!("Fetching {head_ref_name} from {remote_name}");
    let fetch_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["fetch", &remote_name, head_ref_name])
        .output()
        .map_err(|e| format!("Failed to fetch from fork: {e}"))?;

    if !fetch_output.status.success() {
        let stderr = String::from_utf8_lossy(&fetch_output.stderr).to_string();
        log::warn!("Fetch from fork failed (continuing with push): {stderr}");
    }

    // Push HEAD to the fork remote with --force-with-lease
    let refspec = format!("HEAD:{head_ref_name}");
    log::trace!("Pushing {refspec} to {remote_name} --force-with-lease");
    let push_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["push", "--force-with-lease", &remote_name, &refspec])
        .output()
        .map_err(|e| format!("Failed to push to fork: {e}"))?;

    if push_output.status.success() {
        let stdout = String::from_utf8_lossy(&push_output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&push_output.stderr).to_string();
        let result = if stdout.is_empty() { stderr } else { stdout };
        log::trace!("Successfully pushed to {remote_name}/{head_ref_name}");
        Ok(PushResult {
            output: result,
            fell_back: false,
            permission_denied: false,
            pushed_remote: Some(remote_name.clone()),
            pushed_branch: Some(head_ref_name.to_string()),
        })
    } else {
        let stderr = String::from_utf8_lossy(&push_output.stderr).to_string();
        if is_permission_error(&stderr) {
            log::warn!("Permission denied pushing to {remote_name}/{head_ref_name}: {stderr}");
            return Ok(PushResult {
                output: stderr,
                fell_back: false,
                permission_denied: true,
                pushed_remote: None,
                pushed_branch: None,
            });
        }
        log::warn!("Failed to push to {remote_name}/{head_ref_name}, falling back to regular push: {stderr}");
        let fallback_output = git_push(repo_path, None)?;
        Ok(PushResult {
            output: fallback_output,
            fell_back: true,
            permission_denied: false,
            pushed_remote: None,
            pushed_branch: None,
        })
    }
}

/// Set upstream tracking for a local branch to a remote branch.
/// Uses git config directly (more robust than --set-upstream-to when the
/// remote-tracking ref may not exist after fetch_pr_to_branch).
pub fn set_upstream_tracking(
    repo_path: &str,
    local_branch: &str,
    remote_branch: &str,
) -> Result<(), String> {
    log::trace!("Setting upstream for {local_branch} to origin/{remote_branch} in {repo_path}");

    let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["config", &format!("branch.{local_branch}.remote"), "origin"])
        .output();

    let merge_ref = format!("refs/heads/{remote_branch}");
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args([
            "config",
            &format!("branch.{local_branch}.merge"),
            &merge_ref,
        ])
        .output()
        .map_err(|e| format!("Failed to set upstream config: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!("Failed to set upstream config for {local_branch}: {stderr}");
    }
    Ok(())
}

/// Fetch from remote origin (best effort, ignores errors if no remote)
pub fn fetch_origin(repo_path: &str) -> Result<(), String> {
    log::trace!("Fetching from origin in {repo_path}");

    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["fetch", "origin"])
        .output()
        .map_err(|e| format!("Failed to run git fetch: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Don't fail if no remote - just log and continue
        if stderr.contains("does not appear to be a git repository")
            || stderr.contains("Could not read from remote")
            || stderr.contains("'origin' does not appear to be a git repository")
        {
            log::trace!("No remote origin available: {stderr}");
            return Ok(());
        }
        log::warn!("Failed to fetch from origin: {stderr}");
    } else {
        log::trace!("Successfully fetched from origin");
    }

    Ok(())
}

/// Get list of remote branches for a repository (strips origin/ prefix)
pub fn get_remote_branches(repo_path: &str) -> Result<Vec<String>, String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["branch", "-r", "--format=%(refname:short)"])
        .output()
        .map_err(|e| format!("Failed to run git command: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list remote branches: {stderr}"));
    }

    let branches: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        // Strip "origin/" prefix and filter out HEAD and bare "origin"
        .filter_map(|s| {
            // Skip HEAD references and bare remote name (origin/HEAD -> origin)
            if s.contains("HEAD") || s == "origin" {
                None
            } else if let Some(stripped) = s.strip_prefix("origin/") {
                Some(stripped.to_string())
            } else {
                // For other remotes, keep as-is but could strip their prefix too
                Some(s)
            }
        })
        .collect();

    Ok(branches)
}

/// Create a new git worktree
///
/// # Arguments
/// * `repo_path` - Path to the main repository
/// * `worktree_path` - Path where the worktree will be created
/// * `new_branch_name` - Name for the new branch to create
/// * `base_branch` - Branch to base the new branch on (e.g., "main")
pub fn create_worktree(
    repo_path: &str,
    worktree_path: &str,
    new_branch_name: &str,
    base_branch: &str,
) -> Result<(), String> {
    log::trace!(
        "Creating worktree at {worktree_path} with branch {new_branch_name} from {base_branch}"
    );

    // Ensure parent directory exists
    let worktree_path_obj = Path::new(worktree_path);
    if let Some(parent) = worktree_path_obj.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }

    run_git_worktree_add_with_retry(
        repo_path,
        &[
            "worktree",
            "add",
            "-b",
            new_branch_name,
            worktree_path,
            base_branch,
        ],
    )?;

    log::trace!("Successfully created worktree at {worktree_path}");
    Ok(())
}

/// Create a worktree using an existing branch (no new branch created)
///
/// # Arguments
/// * `repo_path` - Path to the main repository
/// * `worktree_path` - Path where the worktree will be created
/// * `existing_branch` - Name of the existing branch to checkout
pub fn create_worktree_from_existing_branch(
    repo_path: &str,
    worktree_path: &str,
    existing_branch: &str,
) -> Result<(), String> {
    log::trace!("Creating worktree at {worktree_path} using existing branch {existing_branch}");

    // Ensure parent directory exists
    let worktree_path_obj = Path::new(worktree_path);
    if let Some(parent) = worktree_path_obj.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }

    run_git_worktree_add_with_retry(
        repo_path,
        &["worktree", "add", worktree_path, existing_branch],
    )?;

    log::trace!(
        "Successfully created worktree at {worktree_path} using existing branch {existing_branch}"
    );
    Ok(())
}

pub fn is_retryable_worktree_create_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("could not lock config file")
        || lower.contains("config.lock")
        || (lower.contains(".git/config") && lower.contains("file exists"))
        || lower.contains("unable to write upstream branch configuration")
}

fn run_git_worktree_add_with_retry(repo_path: &str, args: &[&str]) -> Result<(), String> {
    let _guard = WORKTREE_CREATE_LOCK
        .lock()
        .expect("worktree create mutex poisoned");

    for attempt in 1..=WORKTREE_CREATE_ATTEMPTS {
        // Prune stale worktree entries (folders deleted outside the app)
        let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["worktree", "prune"])
            .output();

        let output = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(args)
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {e}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if attempt < WORKTREE_CREATE_ATTEMPTS && is_retryable_worktree_create_error(&stderr) {
            log::warn!(
                "Retrying git worktree add after retryable config-lock error (attempt {attempt}/{WORKTREE_CREATE_ATTEMPTS}): {stderr}"
            );
            std::thread::sleep(Duration::from_millis(150 * attempt as u64));
            continue;
        }

        return Err(format!("Failed to create worktree: {stderr}"));
    }

    Err("Failed to create worktree: retry attempts exhausted".to_string())
}

/// Checkout a PR using gh CLI in the specified directory
///
/// Uses `gh pr checkout <number>` which properly handles:
/// - Fetching the PR branch from forks
/// - Setting up proper tracking
/// - Checking out the actual PR branch
///
/// Fetch a PR ref into a local branch name, bypassing gh cli.
/// Used when the PR's head branch name collides with a locally checked-out branch.
pub fn fetch_pr_to_branch(
    repo_path: &str,
    pr_number: u32,
    local_branch: &str,
) -> Result<(), String> {
    let refspec = format!("pull/{pr_number}/head:{local_branch}");
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["fetch", "origin", &refspec])
        .output()
        .map_err(|e| format!("Failed to fetch PR #{pr_number}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to fetch PR #{pr_number} into {local_branch}: {stderr}"
        ));
    }
    Ok(())
}

/// Checkout an existing branch in a worktree
pub fn checkout_branch(worktree_path: &str, branch: &str) -> Result<(), String> {
    let output = wsl_aware_command("git", Some(Path::new(worktree_path)))
        .args(["checkout", branch])
        .output()
        .map_err(|e| format!("Failed to checkout branch {branch}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to checkout branch {branch}: {stderr}"));
    }
    Ok(())
}

/// # Arguments
/// * `worktree_path` - Path to the worktree where to checkout the PR
/// * `pr_number` - The PR number to checkout
/// * `branch_name` - Optional local branch name to use (ensures local matches remote)
pub fn gh_pr_checkout(
    worktree_path: &str,
    pr_number: u32,
    branch_name: Option<&str>,
    gh_binary: &std::path::Path,
) -> Result<String, String> {
    log::trace!("Running gh pr checkout {pr_number} in {worktree_path}");

    let pr_num_str = pr_number.to_string();
    let mut args = vec!["pr", "checkout", &pr_num_str];
    if let Some(name) = branch_name {
        args.extend(["-b", name]);
    }

    let output = gh_command(gh_binary, worktree_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run gh pr checkout: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to checkout PR #{pr_number}: {stderr}"));
    }

    // Get the current branch name after checkout
    let branch_output = wsl_aware_command("git", Some(Path::new(worktree_path)))
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get branch name: {e}"))?;

    let branch_name = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();

    log::trace!("Successfully checked out PR #{pr_number} to branch {branch_name}");
    Ok(branch_name)
}

/// Number of attempts when removing a worktree directory tree.
const WORKTREE_RM_ATTEMPTS: u32 = 5;

/// Whether a directory-removal error is a transient race worth retrying.
///
/// A dev server, file watcher, or backend process can keep writing into the
/// tree while `remove_dir_all` walks it, so the final `rmdir` fails even though
/// no handle stays open.
fn is_transient_dir_removal_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    // `ENOTEMPTY` (39 on Linux, 66 on macOS/BSD) and Windows `ERROR_DIR_NOT_EMPTY`
    // both surface as `DirectoryNotEmpty`; `EACCES` / Windows `ERROR_ACCESS_DENIED`
    // as `PermissionDenied`. Using `ErrorKind` keeps the mapping correct across
    // platforms without hard-coded errno values.
    if matches!(
        e.kind(),
        ErrorKind::DirectoryNotEmpty | ErrorKind::PermissionDenied
    ) {
        return true;
    }
    // Windows `ERROR_SHARING_VIOLATION` (a lingering file lock) has no dedicated
    // `ErrorKind`, so match its raw code explicitly.
    #[cfg(windows)]
    {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        if e.raw_os_error() == Some(ERROR_SHARING_VIOLATION) {
            return true;
        }
    }
    false
}

/// Recursively remove a directory, retrying briefly on transient races.
///
/// Removing a worktree can race with a process still writing inside it (e.g.
/// `node_modules`, `elm-stuff`), making removal fail with `ENOTEMPTY`
/// (os error 39) even though nothing holds an open handle. A few short retries
/// let the writer settle so the removal can finish. Treats an already-absent
/// path as success.
fn remove_dir_all_with_retry(path: &Path) -> std::io::Result<()> {
    let mut attempt = 1;
    loop {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                if attempt >= WORKTREE_RM_ATTEMPTS || !is_transient_dir_removal_error(&e) {
                    return Err(e);
                }
                log::debug!(
                    "Retrying directory removal of {} after transient error (attempt {attempt}/{WORKTREE_RM_ATTEMPTS}): {e}",
                    path.display()
                );
                std::thread::sleep(Duration::from_millis(150 * attempt as u64));
                attempt += 1;
            }
        }
    }
}

/// Remove a git worktree
///
/// # Arguments
/// * `repo_path` - Path to the main repository
/// * `worktree_path` - Path to the worktree to remove
pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    log::trace!("Removing worktree at {worktree_path}");

    // SAFETY: Never remove the main working tree — this would delete the entire repo
    if is_main_worktree(repo_path, worktree_path) {
        return Err(format!(
            "Refusing to remove main working tree at {worktree_path}"
        ));
    }

    // Prune stale worktree entries (folders deleted outside the app)
    let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["worktree", "prune"])
        .output();

    log::trace!("git worktree remove {worktree_path} --force (in {repo_path})");

    // git worktree remove <path>
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["worktree", "remove", worktree_path, "--force"])
        .output()
        .map_err(|e| format!("Failed to run git worktree remove: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    log::trace!(
        "git worktree remove result: status={}, stdout={}, stderr={}",
        output.status,
        stdout.trim(),
        stderr.trim()
    );

    if !output.status.success() {
        // Don't fail if worktree doesn't exist or is not a working tree
        // This allows cleanup of stale worktree entries
        if stderr.contains("is not a working tree")
            || stderr.contains("does not exist")
            || stderr.contains("No such file or directory")
        {
            log::warn!(
                "Worktree at {worktree_path} not found or not a working tree, proceeding with cleanup"
            );
            // Try to prune stale worktrees
            let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
                .args(["worktree", "prune"])
                .output();
        } else {
            // git worktree remove failed (e.g. file locks on Windows)
            // Try manual directory removal as fallback, but NEVER on the repo root
            let is_repo_root = {
                let wt = Path::new(worktree_path).canonicalize().ok();
                let rp = Path::new(repo_path).canonicalize().ok();
                wt.is_some() && wt == rp
            };
            if is_repo_root {
                return Err(format!(
                    "Refusing to remove directory: path matches repository root ({repo_path})"
                ));
            }
            if Path::new(worktree_path).exists() {
                log::warn!(
                    "git worktree remove failed ({stderr}), attempting manual directory removal"
                );
                if let Err(rm_err) = remove_dir_all_with_retry(Path::new(worktree_path)) {
                    return Err(format!("Failed to remove worktree: {stderr} (manual cleanup also failed: {rm_err})"));
                }
                log::info!("Manually removed worktree directory at {worktree_path}");
                // Prune the now-stale git worktree entry
                let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
                    .args(["worktree", "prune"])
                    .output();
            } else {
                return Err(format!("Failed to remove worktree: {stderr}"));
            }
        }
    }

    // Safety net: if git reported success but directory still exists, clean it up
    // But NEVER remove the repo root directory
    let is_repo_root = {
        let wt = Path::new(worktree_path).canonicalize().ok();
        let rp = Path::new(repo_path).canonicalize().ok();
        wt.is_some() && wt == rp
    };
    if Path::new(worktree_path).exists() && !is_repo_root {
        log::warn!(
            "Worktree directory still exists after git worktree remove, cleaning up manually"
        );
        // Best-effort: `git worktree remove` already reported success, so a
        // leftover directory is unexpected. Log the final outcome rather than
        // swallowing it silently.
        if let Err(e) = remove_dir_all_with_retry(Path::new(worktree_path)) {
            log::warn!("Best-effort cleanup of {worktree_path} failed: {e}");
        }
    }

    log::trace!("Successfully removed worktree at {worktree_path}");
    Ok(())
}

/// Delete the branch associated with a worktree
///
/// # Arguments
/// * `repo_path` - Path to the main repository
/// * `branch_name` - Name of the branch to delete
pub fn delete_branch(repo_path: &str, branch_name: &str) -> Result<(), String> {
    log::trace!("Deleting branch {branch_name}");
    log::trace!("git branch -D {branch_name} (in {repo_path})");

    // git branch -D <branch>
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["branch", "-D", branch_name])
        .output()
        .map_err(|e| format!("Failed to run git branch -D: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    log::trace!(
        "git branch -D result: status={}, stdout={}, stderr={}",
        output.status,
        stdout.trim(),
        stderr.trim()
    );

    if !output.status.success() {
        // Don't fail if branch doesn't exist
        if !stderr.contains("not found") {
            return Err(format!("Failed to delete branch: {stderr}"));
        }
        log::trace!("Branch {branch_name} not found, skipping delete");
    }

    log::trace!("Successfully deleted branch {branch_name}");
    Ok(())
}

/// Find which worktree (if any) has a given branch checked out.
/// Parses `git worktree list --porcelain` output. Returns the worktree path or None.
pub fn find_worktree_for_branch(repo_path: &str, branch: &str) -> Option<String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["worktree", "list", "--porcelain"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let target_ref = format!("refs/heads/{branch}");
    let mut current_path: Option<String> = None;

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            if branch_ref == target_ref {
                return current_path;
            }
        } else if line.is_empty() {
            current_path = None;
        }
    }

    None
}

/// Clean up a stale branch that may be checked out in a defunct worktree.
/// Used before PR checkout to handle archived/deleted worktrees whose branch still exists.
pub fn cleanup_stale_branch(repo_path: &str, branch: &str) {
    log::trace!("Cleaning up stale branch '{branch}' in {repo_path}");

    // Prune worktrees whose directories no longer exist
    let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["worktree", "prune"])
        .output();

    // If branch is checked out in a worktree, remove that worktree first
    if let Some(wt_path) = find_worktree_for_branch(repo_path, branch) {
        log::trace!("Branch '{branch}' is checked out at '{wt_path}', removing worktree");
        let _ = remove_worktree(repo_path, &wt_path);
    }

    // Delete the branch
    if branch_exists(repo_path, branch) {
        log::trace!("Deleting stale branch '{branch}'");
        let _ = delete_branch(repo_path, branch);
    }
}

/// Check if a path is the main working tree (not a linked worktree).
/// Uses `git worktree list --porcelain` — the first entry is always the main worktree.
pub fn is_main_worktree(repo_path: &str, worktree_path: &str) -> bool {
    let output = silent_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .ok();

    let Some(output) = output else { return false };
    if !output.status.success() {
        return false;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // First "worktree <path>" line is always the main worktree
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            // Canonicalize both paths for reliable comparison (handles symlinks, trailing slashes, ..)
            let main = Path::new(path).canonicalize().ok();
            let target = Path::new(worktree_path).canonicalize().ok();
            return match (main, target) {
                (Some(m), Some(t)) => m == t,
                _ => path == worktree_path,
            };
        }
    }
    false
}

/// List existing worktrees for a repository
#[allow(dead_code)]
pub fn list_worktrees(repo_path: &str) -> Result<Vec<String>, String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git worktree list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list worktrees: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let worktrees = stdout
        .lines()
        .filter(|line| line.starts_with("worktree "))
        .map(|line| line.strip_prefix("worktree ").unwrap_or("").to_string())
        .collect();

    Ok(worktrees)
}

/// Commit staged changes with a message
///
/// # Arguments
/// * `repo_path` - Path to the repository
/// * `message` - Commit message
/// * `stage_all` - Whether to stage all changes before committing (git add -A)
///
/// Returns the commit hash on success
pub fn commit_changes(repo_path: &str, message: &str, stage_all: bool) -> Result<String, String> {
    log::trace!("Committing changes in {repo_path}");

    // Optionally stage all changes
    if stage_all {
        let add_output = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["add", "-A"])
            .output()
            .map_err(|e| format!("Failed to run git add: {e}"))?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("Failed to stage changes: {stderr}"));
        }
    }

    // Check if there are any changes in the working tree
    let status_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to check git status: {e}"))?;

    let status = String::from_utf8_lossy(&status_output.stdout);
    if status.trim().is_empty() {
        return Err("Nothing to commit, working tree clean".to_string());
    }

    // Check if there are staged changes
    let diff_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["diff", "--cached", "--quiet"])
        .output()
        .map_err(|e| format!("Failed to check staged changes: {e}"))?;

    // Exit code 0 means no staged changes, 1 means there are staged changes
    if diff_output.status.success() {
        return Err(
            "No staged changes to commit. Stage your changes first or enable 'Stage all changes'."
                .to_string(),
        );
    }

    // Commit
    let commit_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["commit", "-m", message])
        .output()
        .map_err(|e| format!("Failed to run git commit: {e}"))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr)
            .trim()
            .to_string();
        let stdout = String::from_utf8_lossy(&commit_output.stdout)
            .trim()
            .to_string();
        // Git sometimes outputs to stdout for certain messages
        let error_msg = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "Unknown git error".to_string()
        };
        return Err(error_msg);
    }

    // Get the commit hash
    let hash_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get commit hash: {e}"))?;

    let hash = String::from_utf8_lossy(&hash_output.stdout)
        .trim()
        .to_string();
    log::trace!("Successfully committed changes: {hash}");

    Ok(hash)
}

/// Open a pull request using the GitHub CLI (gh)
///
/// * `repo_path` - Path to the repository
/// * `title` - Optional PR title (if None, gh will prompt or use default)
/// * `body` - Optional PR body
/// * `draft` - Whether to create as draft PR
///
/// Returns the PR URL on success
pub fn open_pull_request(
    repo_path: &str,
    title: Option<&str>,
    body: Option<&str>,
    draft: bool,
    gh_binary: &std::path::Path,
) -> Result<String, String> {
    log::trace!("Opening pull request from {repo_path}");

    // Push current branch to remote first
    log::trace!("Pushing current branch to remote...");
    let push_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["push", "-u", "origin", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to push to remote: {e}"))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Don't fail if the branch is already up to date or already pushed
        if !stderr.contains("Everything up-to-date") && !stderr.contains("set up to track") {
            log::warn!("Push warning: {stderr}");
        }
    }
    log::trace!("Push completed");

    // Build the gh pr create command
    let mut args = vec!["pr", "create", "--fill"];

    if let Some(t) = title {
        args.push("--title");
        args.push(t);
    }

    if let Some(b) = body {
        args.push("--body");
        args.push(b);
    }

    if draft {
        args.push("--draft");
    }

    // Add --web to open in browser after creation
    args.push("--web");

    log::trace!("Running gh command with args: {:?}", args);

    let output = gh_command(gh_binary, repo_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run gh pr create: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Check for common errors
        if stderr.contains("already exists") {
            return Err("A pull request for this branch already exists".to_string());
        }
        if stderr.contains("no commits") || stderr.contains("nothing to compare") {
            return Err("No commits to create a pull request. Make sure you have commits that differ from the base branch.".to_string());
        }
        return Err(format!("Failed to create pull request: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::trace!("Successfully created pull request: {stdout}");

    Ok(stdout)
}

// =============================================================================
// PR Context Generation
// =============================================================================

/// Information needed to generate a PR prompt
#[derive(Debug, Clone, Serialize)]
pub struct PrContext {
    pub uncommitted_count: u32,
    pub current_branch: String,
    pub target_branch: String,
    pub has_upstream: bool,
    pub pr_template: Option<String>,
}

/// Get the number of uncommitted changes (staged + unstaged)
pub fn get_uncommitted_count(repo_path: &str) -> Result<u32, String> {
    let output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to get git status: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let count = stdout.lines().filter(|l| !l.is_empty()).count() as u32;
    Ok(count)
}

/// Check if current branch has an upstream tracking branch
pub fn has_upstream_branch(repo_path: &str) -> bool {
    wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Read PR template if it exists
pub fn get_pr_template(repo_path: &str) -> Option<String> {
    let template_path = Path::new(repo_path).join(".github/pull_request_template.md");
    std::fs::read_to_string(template_path).ok()
}

/// Generate the full PR context for the prompt
pub fn generate_pr_context(repo_path: &str, target_branch: &str) -> Result<PrContext, String> {
    Ok(PrContext {
        uncommitted_count: get_uncommitted_count(repo_path)?,
        current_branch: get_current_branch(repo_path)?,
        target_branch: target_branch.to_string(),
        has_upstream: has_upstream_branch(repo_path),
        pr_template: get_pr_template(repo_path),
    })
}

/// Read jean.json configuration from a worktree path
///
/// Returns None if the file doesn't exist or can't be parsed
pub fn read_jean_config(worktree_path: &str) -> Option<JeanConfig> {
    let config_path = Path::new(worktree_path).join("jean.json");
    if !config_path.exists() {
        log::trace!("No jean.json found at {}", config_path.display());
        return None;
    }

    match std::fs::read_to_string(&config_path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(config) => {
                log::trace!("Successfully parsed jean.json from {worktree_path}");
                Some(config)
            }
            Err(e) => {
                log::warn!("Failed to parse jean.json: {e}");
                None
            }
        },
        Err(e) => {
            log::warn!("Failed to read jean.json: {e}");
            None
        }
    }
}

/// Run a setup script in a worktree directory
///
/// Executes the script using sh -c and captures output.
/// Sets environment variables for use in the script:
/// - JEAN_WORKSPACE_PATH: Path to the newly created worktree
/// - JEAN_ROOT_PATH: Path to the repository root directory
/// - JEAN_BRANCH: Current branch name
pub fn run_setup_script(
    worktree_path: &str,
    root_path: &str,
    branch: &str,
    script: &str,
) -> Result<String, String> {
    run_jean_script("setup", worktree_path, root_path, branch, script)
}

/// Run a teardown script in a worktree directory before deletion
///
/// Executes the script using sh -c and captures output.
/// Sets environment variables for use in the script:
/// - JEAN_WORKSPACE_PATH: Path to the worktree being deleted
/// - JEAN_ROOT_PATH: Path to the repository root directory
/// - JEAN_BRANCH: Branch name of the worktree
pub fn run_teardown_script(
    worktree_path: &str,
    root_path: &str,
    branch: &str,
    script: &str,
) -> Result<String, String> {
    run_jean_script("teardown", worktree_path, root_path, branch, script)
}

/// Validate that environment variables passed to jean.json scripts are safe.
///
/// Rejects empty strings and non-absolute paths to prevent destructive commands
/// when scripts reference `$JEAN_WORKSPACE_PATH` or `$JEAN_ROOT_PATH`.
/// For example, `rm -rf $JEAN_WORKSPACE_PATH/node_modules` with an empty var
/// would expand to `rm -rf /node_modules`.
fn validate_script_env(worktree_path: &str, root_path: &str, branch: &str) -> Result<(), String> {
    if worktree_path.is_empty() {
        return Err("JEAN_WORKSPACE_PATH is empty — refusing to run script".to_string());
    }
    if root_path.is_empty() {
        return Err("JEAN_ROOT_PATH is empty — refusing to run script".to_string());
    }
    if branch.is_empty() {
        return Err("JEAN_BRANCH is empty — refusing to run script".to_string());
    }
    if !std::path::Path::new(worktree_path).is_absolute() {
        return Err(format!(
            "JEAN_WORKSPACE_PATH is not an absolute path: {worktree_path}"
        ));
    }
    if !std::path::Path::new(root_path).is_absolute() {
        return Err(format!(
            "JEAN_ROOT_PATH is not an absolute path: {root_path}"
        ));
    }
    Ok(())
}

/// Shared implementation for running jean.json setup/teardown scripts.
///
/// Validates environment variables, then executes the script in the user's
/// login shell with JEAN_WORKSPACE_PATH, JEAN_ROOT_PATH, and JEAN_BRANCH set.
fn run_jean_script(
    kind: &str,
    worktree_path: &str,
    root_path: &str,
    branch: &str,
    script: &str,
) -> Result<String, String> {
    log::trace!("Running {kind} script in {worktree_path}: {script}");

    validate_script_env(worktree_path, root_path, branch)?;

    let (shell, supports_login) = get_user_shell();
    log::trace!("Using shell: {shell} (login mode: {supports_login})");

    let mut cmd = silent_command(&shell);
    if supports_login {
        cmd.args(["-l", "-i", "-c", script]);
    } else {
        cmd.args(["-c", script]);
    }

    let output = cmd
        .current_dir(worktree_path)
        .env("JEAN_WORKSPACE_PATH", worktree_path)
        .env("JEAN_ROOT_PATH", root_path)
        .env("JEAN_BRANCH", branch)
        .output()
        .map_err(|e| format!("Failed to run {kind} script: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let combined = format!("{stdout}{stderr}").trim().to_string();
        return Err(format!("{kind} script failed:\n{combined}"));
    }

    let combined = format!("{stdout}{stderr}").trim().to_string();
    log::trace!("{kind} script completed successfully");
    Ok(combined)
}

/// Check if there are uncommitted changes (staged or unstaged)
pub fn has_uncommitted_changes(repo_path: &str) -> bool {
    wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["status", "--porcelain"])
        .output()
        .map(|o| {
            if o.status.success() {
                !String::from_utf8_lossy(&o.stdout).trim().is_empty()
            } else {
                false
            }
        })
        .unwrap_or(false)
}

/// Rebase the current branch onto a base branch from origin
///
/// This performs:
/// 1. Commits any uncommitted changes with the provided message
/// 2. Fetches from origin
/// 3. Rebases onto origin/{base_branch}
/// 4. Force pushes with lease
///
/// Returns an error message if any step fails
pub fn rebase_onto_base(
    repo_path: &str,
    base_branch: &str,
    commit_message: Option<&str>,
) -> Result<String, String> {
    log::trace!("Starting rebase onto {base_branch} in {repo_path}");

    // Step 1: Check for uncommitted changes and commit if needed
    if has_uncommitted_changes(repo_path) {
        let message = commit_message.unwrap_or("WIP: Committing changes before rebase");
        log::trace!("Committing uncommitted changes: {message}");

        // Stage all changes
        let add_output = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["add", "-A"])
            .output()
            .map_err(|e| format!("Failed to stage changes: {e}"))?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("Failed to stage changes: {stderr}"));
        }

        // Commit
        let commit_output = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["commit", "-m", message])
            .output()
            .map_err(|e| format!("Failed to commit changes: {e}"))?;

        if !commit_output.status.success() {
            let stderr = String::from_utf8_lossy(&commit_output.stderr);
            // Not an error if nothing to commit
            if !stderr.contains("nothing to commit") {
                return Err(format!("Failed to commit changes: {stderr}"));
            }
        }
    }

    // Step 2: Fetch from origin
    log::trace!("Fetching from origin...");
    let fetch_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["fetch", "origin", base_branch])
        .output()
        .map_err(|e| format!("Failed to fetch from origin: {e}"))?;

    if !fetch_output.status.success() {
        let stderr = String::from_utf8_lossy(&fetch_output.stderr);
        return Err(format!("Failed to fetch from origin: {stderr}"));
    }

    // Step 3: Rebase onto origin/{base_branch}
    log::trace!("Rebasing onto origin/{base_branch}...");
    let rebase_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["rebase", &format!("origin/{base_branch}")])
        .output()
        .map_err(|e| format!("Failed to rebase: {e}"))?;

    if !rebase_output.status.success() {
        let stderr = String::from_utf8_lossy(&rebase_output.stderr);
        // Abort the rebase if it fails
        let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["rebase", "--abort"])
            .output();
        return Err(format!(
            "Rebase failed (conflicts likely). Rebase has been aborted.\n{stderr}"
        ));
    }

    // Step 4: Force push with lease
    log::trace!("Force pushing with lease...");
    let push_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["push", "--force-with-lease"])
        .output()
        .map_err(|e| format!("Failed to push: {e}"))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Check if branch doesn't have upstream yet, or upstream points at a
        // differently named branch (common for worktrees created from origin/main)
        if git_push_needs_upstream_retry(&stderr) {
            // Try regular push with -u
            let push_u_output = wsl_aware_command("git", Some(Path::new(repo_path)))
                .args(["push", "-u", "origin", "HEAD"])
                .output()
                .map_err(|e| format!("Failed to push: {e}"))?;

            if !push_u_output.status.success() {
                let stderr = String::from_utf8_lossy(&push_u_output.stderr);
                return Err(format!("Failed to push: {stderr}"));
            }
        } else {
            return Err(format!("Failed to push: {stderr}"));
        }
    }

    log::trace!("Rebase completed successfully");
    Ok("Rebase completed successfully".to_string())
}

// =============================================================================
// Local Merge Operations
// =============================================================================

/// Result of a merge operation
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum MergeResult {
    /// Merge completed successfully
    Success { commit_hash: String },
    /// Merge has conflicts that need resolution
    Conflict {
        conflicting_files: Vec<String>,
        /// Diff between base and feature branch for conflicting files
        conflict_diff: String,
    },
    /// Merge failed for another reason
    Error { message: String },
}

/// Merge a feature branch into the base branch locally
///
/// This performs:
/// 1. Checks for uncommitted changes in main repo (fails if any)
/// 2. Checks out the base branch
/// 3. Pulls latest from origin (best effort)
/// 4. Merges the feature branch based on merge_type:
///    - Merge: --no-ff, creates merge commit
///    - Squash: --squash, combines all commits into one
///    - Rebase: rebases feature onto base in worktree, then fast-forward merges
///
/// On conflict, aborts the operation and returns the list of conflicting files.
///
/// # Arguments
/// * `repo_path` - Path to the main repository (NOT a worktree)
/// * `worktree_path` - Path to the worktree (for rebase - feature branch is checked out here)
/// * `feature_branch` - Name of the feature branch to merge
/// * `base_branch` - Name of the base branch to merge into
/// * `merge_type` - Type of merge operation to perform
pub fn merge_branch_to_base(
    repo_path: &str,
    worktree_path: &str,
    feature_branch: &str,
    base_branch: &str,
    merge_type: MergeType,
) -> MergeResult {
    log::trace!(
        "Merging {feature_branch} into {base_branch} in {repo_path} (type: {merge_type:?})"
    );

    // Step 1: Check for uncommitted changes in main repo - refuse to merge if any
    if has_uncommitted_changes(repo_path) {
        return MergeResult::Error {
            message: "Cannot merge: there are uncommitted changes in the base branch. Please commit or stash them first.".to_string(),
        };
    }

    // Step 2: Checkout base branch
    log::trace!("Checking out {base_branch}...");
    let checkout_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["checkout", base_branch])
        .output();

    match checkout_output {
        Ok(output) if !output.status.success() => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return MergeResult::Error {
                message: format!("Failed to checkout {base_branch}: {stderr}"),
            };
        }
        Err(e) => {
            return MergeResult::Error {
                message: format!("Failed to run git checkout: {e}"),
            };
        }
        _ => {}
    }

    // Step 3: Pull from origin (best effort - don't fail if no remote)
    log::trace!("Pulling latest from origin...");
    let pull_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["pull", "origin", base_branch])
        .output();

    if let Ok(output) = &pull_output {
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Don't fail if no remote or already up to date
            if !stderr.contains("does not appear to be a git repository")
                && !stderr.contains("Could not read from remote")
                && !stderr.contains("couldn't find remote ref")
            {
                log::warn!("Pull warning (continuing anyway): {stderr}");
            }
        }
    }

    // Step 4: Handle based on merge type
    match merge_type {
        MergeType::Rebase => {
            // Rebase workflow: rebase in worktree, then fast-forward merge in main repo
            rebase_and_merge(repo_path, worktree_path, feature_branch, base_branch)
        }
        MergeType::Merge | MergeType::Squash => {
            // Standard merge or squash workflow
            let squash = merge_type == MergeType::Squash;
            perform_merge(repo_path, feature_branch, squash)
        }
    }
}

/// Helper function to perform a standard merge or squash merge
fn perform_merge(repo_path: &str, feature_branch: &str, squash: bool) -> MergeResult {
    log::trace!(
        "Performing {} merge...",
        if squash { "squash" } else { "standard" }
    );

    let merge_message = if squash {
        format!("Squashed commit from '{feature_branch}'")
    } else {
        format!("Merge branch '{feature_branch}'")
    };

    let merge_output = if squash {
        // --squash stages all changes but doesn't commit
        wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["merge", "--squash", feature_branch])
            .output()
    } else {
        // --no-ff creates a merge commit preserving history
        wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["merge", "--no-ff", feature_branch, "-m", &merge_message])
            .output()
    };

    match merge_output {
        Ok(output) => {
            if output.status.success() {
                // For squash merges, we need to commit the staged changes
                if squash {
                    let commit_output = wsl_aware_command("git", Some(Path::new(repo_path)))
                        .args(["commit", "-m", &merge_message])
                        .output();

                    match commit_output {
                        Ok(co) if !co.status.success() => {
                            let stderr = String::from_utf8_lossy(&co.stderr);
                            // If nothing to commit, the squash had no changes
                            if stderr.contains("nothing to commit") {
                                return MergeResult::Error {
                                    message: "No changes to merge".to_string(),
                                };
                            }
                            return MergeResult::Error {
                                message: format!("Failed to commit squashed changes: {stderr}"),
                            };
                        }
                        Err(e) => {
                            return MergeResult::Error {
                                message: format!("Failed to run git commit: {e}"),
                            };
                        }
                        _ => {}
                    }
                }

                get_head_commit_hash(repo_path)
            } else {
                handle_merge_failure(repo_path, &output.stdout, &output.stderr)
            }
        }
        Err(e) => MergeResult::Error {
            message: format!("Failed to run git merge: {e}"),
        },
    }
}

/// Helper function to perform rebase and fast-forward merge
///
/// Rebase is performed in the worktree (where feature branch is already checked out),
/// then fast-forward merge is done in the main repo.
fn rebase_and_merge(
    repo_path: &str,
    worktree_path: &str,
    feature_branch: &str,
    base_branch: &str,
) -> MergeResult {
    log::trace!("Rebasing {feature_branch} onto {base_branch} in worktree {worktree_path}...");

    // Step 1: Rebase in worktree (feature branch is already checked out there)
    let rebase_output = wsl_aware_command("git", Some(Path::new(worktree_path)))
        .args(["rebase", base_branch])
        .output();

    match rebase_output {
        Ok(output) => {
            if !output.status.success() {
                // Check for rebase conflicts
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let combined = format!("{stdout}\n{stderr}");

                if combined.contains("CONFLICT")
                    || combined.contains("could not apply")
                    || combined.contains("fix conflicts")
                {
                    // Get list of conflicting files during rebase
                    let conflict_output = wsl_aware_command("git", Some(Path::new(worktree_path)))
                        .args(["diff", "--name-only", "--diff-filter=U"])
                        .output();

                    let conflicting_files: Vec<String> = conflict_output
                        .map(|o| {
                            String::from_utf8_lossy(&o.stdout)
                                .lines()
                                .map(|s| s.to_string())
                                .filter(|s| !s.is_empty())
                                .collect()
                        })
                        .unwrap_or_default();

                    // Get the diff with conflict markers
                    let diff_output = wsl_aware_command("git", Some(Path::new(worktree_path)))
                        .args(["diff"])
                        .output();

                    let conflict_diff = diff_output
                        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                        .unwrap_or_default();

                    // Abort the rebase
                    log::trace!(
                        "Rebase has conflicts in {} files, aborting...",
                        conflicting_files.len()
                    );
                    let _ = wsl_aware_command("git", Some(Path::new(worktree_path)))
                        .args(["rebase", "--abort"])
                        .output();

                    return MergeResult::Conflict {
                        conflicting_files,
                        conflict_diff,
                    };
                } else {
                    // Abort any partial rebase state
                    let _ = wsl_aware_command("git", Some(Path::new(worktree_path)))
                        .args(["rebase", "--abort"])
                        .output();

                    let error_detail = if !stderr.trim().is_empty() {
                        stderr.trim().to_string()
                    } else if !stdout.trim().is_empty() {
                        stdout.trim().to_string()
                    } else {
                        "Unknown rebase error".to_string()
                    };

                    return MergeResult::Error {
                        message: error_detail,
                    };
                }
            }
        }
        Err(e) => {
            return MergeResult::Error {
                message: format!("Failed to run git rebase: {e}"),
            };
        }
    }

    // Step 2: Fast-forward merge in main repo (base branch already checked out by caller)
    log::trace!("Rebase successful, fast-forward merging into {base_branch}...");

    let ff_merge = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["merge", "--ff-only", feature_branch])
        .output();

    match ff_merge {
        Ok(output) => {
            if output.status.success() {
                get_head_commit_hash(repo_path)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                MergeResult::Error {
                    message: format!("Fast-forward merge failed: {stderr}"),
                }
            }
        }
        Err(e) => MergeResult::Error {
            message: format!("Failed to run git merge --ff-only: {e}"),
        },
    }
}

/// Helper function to get the current HEAD commit hash
fn get_head_commit_hash(repo_path: &str) -> MergeResult {
    let hash_output = wsl_aware_command("git", Some(Path::new(repo_path)))
        .args(["rev-parse", "HEAD"])
        .output();

    let commit_hash = hash_output
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    log::trace!("Operation successful: {commit_hash}");
    MergeResult::Success { commit_hash }
}

/// Helper function to handle merge failures and extract conflict info
fn handle_merge_failure(repo_path: &str, stdout: &[u8], stderr: &[u8]) -> MergeResult {
    let stdout_str = String::from_utf8_lossy(stdout);
    let stderr_str = String::from_utf8_lossy(stderr);
    let combined = format!("{stdout_str}\n{stderr_str}");

    // Check for merge conflicts in both stdout and stderr
    if combined.contains("CONFLICT")
        || combined.contains("Automatic merge failed")
        || combined.contains("fix conflicts")
    {
        // Get list of conflicting files
        let conflict_output = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["diff", "--name-only", "--diff-filter=U"])
            .output();

        let conflicting_files: Vec<String> = conflict_output
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // Get the diff with conflict markers BEFORE aborting
        let diff_output = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["diff"])
            .output();

        let conflict_diff = diff_output
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        // Abort the merge
        log::trace!(
            "Merge has conflicts in {} files, aborting...",
            conflicting_files.len()
        );
        let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["merge", "--abort"])
            .output();

        MergeResult::Conflict {
            conflicting_files,
            conflict_diff,
        }
    } else {
        // Abort any partial merge state
        let _ = wsl_aware_command("git", Some(Path::new(repo_path)))
            .args(["merge", "--abort"])
            .output();

        // Create a human-friendly error message
        let error_detail = if !stderr_str.trim().is_empty() {
            stderr_str.trim().to_string()
        } else if !stdout_str.trim().is_empty() {
            stdout_str.trim().to_string()
        } else {
            "Unknown error".to_string()
        };

        MergeResult::Error {
            message: error_detail,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // remove_dir_all_with_retry tests
    // ========================================================================

    #[test]
    fn test_remove_dir_all_with_retry_removes_populated_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("worktree");
        std::fs::create_dir_all(root.join("nested/deeper")).unwrap();
        std::fs::write(root.join("nested/file.txt"), b"data").unwrap();

        remove_dir_all_with_retry(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn test_remove_dir_all_with_retry_absent_path_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        // An already-absent path must be treated as success, not an error.
        remove_dir_all_with_retry(&missing).unwrap();
    }

    #[test]
    fn test_is_transient_dir_removal_error_classifies_transient_kinds() {
        use std::io::ErrorKind;
        // The "directory not empty" race (ENOTEMPTY / ERROR_DIR_NOT_EMPTY) and a
        // lingering lock surfacing as PermissionDenied are what we retry on.
        let dir_not_empty = std::io::Error::from(ErrorKind::DirectoryNotEmpty);
        assert!(is_transient_dir_removal_error(&dir_not_empty));
        let permission = std::io::Error::from(ErrorKind::PermissionDenied);
        assert!(is_transient_dir_removal_error(&permission));

        // A non-transient error (e.g. ENOENT/NotFound) must not be retried here.
        let not_found = std::io::Error::from(ErrorKind::NotFound);
        assert!(!is_transient_dir_removal_error(&not_found));
    }

    // ========================================================================
    // get_repo_name tests
    // ========================================================================

    #[test]
    fn test_get_repo_name() {
        assert_eq!(
            get_repo_name("/Users/test/projects/my-repo").unwrap(),
            "my-repo"
        );
        assert_eq!(
            get_repo_name("/Users/test/my_project").unwrap(),
            "my_project"
        );
    }

    #[test]
    fn test_get_repo_name_with_trailing_slash() {
        // Path::file_name handles trailing slashes by ignoring them
        // "/Users/test/my-repo/" -> file_name is None for trailing slash
        let result = get_repo_name("/");
        assert!(result.is_err());
    }

    #[test]
    fn test_get_repo_name_single_component() {
        assert_eq!(get_repo_name("my-repo").unwrap(), "my-repo");
    }

    // ========================================================================
    // get_user_shell tests (testing the pure logic)
    // ========================================================================

    #[test]
    fn test_shell_login_support_detection() {
        // Test the login support detection logic
        let supports_login = |shell: &str| -> bool {
            shell.ends_with("bash")
                || shell.ends_with("zsh")
                || shell.ends_with("fish")
                || shell.ends_with("ksh")
                || shell.ends_with("tcsh")
        };

        assert!(supports_login("/bin/bash"));
        assert!(supports_login("/bin/zsh"));
        assert!(supports_login("/usr/local/bin/fish"));
        assert!(supports_login("/bin/ksh"));
        assert!(supports_login("/bin/tcsh"));
        assert!(!supports_login("/bin/sh"));
        assert!(!supports_login("/bin/dash"));
    }

    // ========================================================================
    // git push upstream retry tests
    // ========================================================================

    #[test]
    fn test_git_push_needs_upstream_retry_for_no_upstream() {
        let stderr = "fatal: The current branch feature has no upstream branch.";
        assert!(git_push_needs_upstream_retry(stderr));
    }

    #[test]
    fn test_git_push_needs_upstream_retry_for_simple_mismatch() {
        let stderr = "fatal: The upstream branch of your current branch does not match\n\
                      the name of your current branch.  To push to the upstream branch\n\
                      on the remote, use\n\n\
                      git push origin HEAD:main\n\n\
                      To push to the branch of the same name on the remote, use\n\n\
                      git push origin HEAD\n\n\
                      To choose either option permanently, see push.default in git-config.\n\
                      fatal: push.default is set to simple";
        assert!(git_push_needs_upstream_retry(stderr));
    }

    #[test]
    fn retryable_worktree_create_error_detects_git_config_lock() {
        let stderr = "Preparing worktree (new branch 'issue-10593')\n\
                      error: could not lock config file .git/config: File exists\n\
                      error: unable to write upstream branch configuration";

        assert!(is_retryable_worktree_create_error(stderr));
    }

    #[test]
    fn retryable_worktree_create_error_rejects_real_conflicts() {
        assert!(!is_retryable_worktree_create_error(
            "fatal: a branch named 'issue-10593' already exists"
        ));
        assert!(!is_retryable_worktree_create_error(
            "fatal: '/tmp/project/issue-10593' already exists"
        ));
    }

    #[test]
    fn test_git_push_needs_upstream_retry_ignores_permission_errors() {
        let stderr = "remote: Permission to owner/repo.git denied to user.\n\
                      fatal: unable to access 'https://github.com/owner/repo.git/': \
                      The requested URL returned error: 403";
        assert!(!git_push_needs_upstream_retry(stderr));
    }

    // ========================================================================
    // RepoIdentifier tests
    // ========================================================================

    #[test]
    fn test_repo_identifier_to_key() {
        let id = RepoIdentifier {
            owner: "heyandras".to_string(),
            repo: "jean".to_string(),
        };
        assert_eq!(id.to_key(), "heyandras-jean");
    }

    #[test]
    fn test_repo_identifier_to_key_with_hyphen_in_name() {
        let id = RepoIdentifier {
            owner: "my-org".to_string(),
            repo: "my-project".to_string(),
        };
        assert_eq!(id.to_key(), "my-org-my-project");
    }
}
