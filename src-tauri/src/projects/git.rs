use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::types::{JeanConfig, MergeType};

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

    // Check if directory is not empty and already has .git
    let git_path = path_obj.join(".git");
    if git_path.exists() {
        return Err("Directory is already a git repository".to_string());
    }

    // Run git init
    let output = Command::new("git")
        .args(["init"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git init: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git init failed: {stderr}"));
    }

    // Create .gitkeep file so we have something to commit
    let gitkeep_path = path_obj.join(".gitkeep");
    std::fs::write(&gitkeep_path, "").map_err(|e| format!("Failed to create .gitkeep: {e}"))?;

    // Stage the file
    let add_output = Command::new("git")
        .args(["add", ".gitkeep"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git add: {e}"))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("git add failed: {stderr}"));
    }

    // Create initial commit
    let commit_output = Command::new("git")
        .args(["commit", "-m", "jean's init vibe commit"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git commit: {e}"))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        return Err(format!("git commit failed: {stderr}"));
    }

    log::trace!("Successfully initialized git repository at {path} with initial commit");
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

/// Get the GitHub URL for a repository
///
/// Converts git remote URLs to HTTPS GitHub URLs
pub fn get_github_url(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get remote URL: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get remote URL: {stderr}"));
    }

    let remote_url = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Convert SSH URL to HTTPS URL if needed
    // git@github.com:user/repo.git -> https://github.com/user/repo
    // https://github.com/user/repo.git -> https://github.com/user/repo
    let github_url = if remote_url.starts_with("git@github.com:") {
        remote_url
            .replace("git@github.com:", "https://github.com/")
            .trim_end_matches(".git")
            .to_string()
    } else if remote_url.starts_with("https://github.com/") {
        remote_url.trim_end_matches(".git").to_string()
    } else {
        return Err(format!(
            "Remote URL is not a GitHub repository: {remote_url}"
        ));
    };

    Ok(github_url)
}

/// Git hosting provider
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitProvider {
    GitHub,
    GitLab,
    Unknown,
}

/// Get the remote URL for a repository
pub fn get_remote_url(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get remote URL: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get remote URL: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Detect the git hosting provider from the remote URL
pub fn detect_git_provider(repo_path: &str) -> Result<GitProvider, String> {
    let remote_url = get_remote_url(repo_path)?;

    if remote_url.contains("github.com") {
        Ok(GitProvider::GitHub)
    } else if remote_url.contains("gitlab.com") || remote_url.contains("gitlab.") {
        Ok(GitProvider::GitLab)
    } else {
        // Check for .gitlab-ci.yml as a fallback for self-hosted GitLab
        let gitlab_ci_path = Path::new(repo_path).join(".gitlab-ci.yml");
        if gitlab_ci_path.exists() {
            return Ok(GitProvider::GitLab);
        }
        Ok(GitProvider::Unknown)
    }
}

/// Get the GitLab URL for a repository's remote
///
/// Supports both SSH and HTTPS URLs.
/// - git@gitlab.com:user/repo.git -> https://gitlab.com/user/repo
/// - https://gitlab.com/user/repo.git -> https://gitlab.com/user/repo
pub fn get_gitlab_url(repo_path: &str) -> Result<String, String> {
    let remote_url = get_remote_url(repo_path)?;

    // Convert SSH URL to HTTPS URL if needed
    let gitlab_url = if remote_url.starts_with("git@gitlab.com:") {
        remote_url
            .replace("git@gitlab.com:", "https://gitlab.com/")
            .trim_end_matches(".git")
            .to_string()
    } else if remote_url.starts_with("https://gitlab.com/") {
        remote_url.trim_end_matches(".git").to_string()
    } else if remote_url.contains("gitlab") {
        // Handle self-hosted GitLab instances
        // Pattern: git@gitlab.example.com:user/repo.git or https://gitlab.example.com/user/repo.git
        if remote_url.starts_with("git@") {
            // git@gitlab.example.com:user/repo.git -> https://gitlab.example.com/user/repo
            let without_git = remote_url.trim_start_matches("git@");
            let parts: Vec<&str> = without_git.splitn(2, ':').collect();
            if parts.len() == 2 {
                format!(
                    "https://{}/{}",
                    parts[0],
                    parts[1].trim_end_matches(".git")
                )
            } else {
                return Err(format!("Invalid GitLab SSH URL format: {remote_url}"));
            }
        } else if remote_url.starts_with("https://") {
            remote_url.trim_end_matches(".git").to_string()
        } else {
            return Err(format!(
                "Remote URL is not a GitLab repository: {remote_url}"
            ));
        }
    } else {
        return Err(format!(
            "Remote URL is not a GitLab repository: {remote_url}"
        ));
    };

    Ok(gitlab_url)
}

/// Extract repository path from a GitLab repository's remote
///
/// Returns the project path (e.g., "user/repo" or "group/subgroup/repo")
pub fn get_gitlab_repo_identifier(repo_path: &str) -> Result<RepoIdentifier, String> {
    let gitlab_url = get_gitlab_url(repo_path)?;

    // Parse project path from URL: https://gitlab.com/owner/repo or https://gitlab.com/group/subgroup/repo
    // We treat it as owner/repo for simplicity (owner = first part, repo = rest joined)
    let url_without_prefix = if gitlab_url.starts_with("https://gitlab.com/") {
        gitlab_url.strip_prefix("https://gitlab.com/").unwrap()
    } else {
        // Self-hosted: https://gitlab.example.com/owner/repo
        // Find the path after the host
        gitlab_url
            .split("//")
            .nth(1)
            .and_then(|s| s.split_once('/'))
            .map(|(_, path)| path)
            .ok_or_else(|| format!("Could not parse GitLab URL: {gitlab_url}"))?
    };

    let parts: Vec<&str> = url_without_prefix.split('/').collect();
    if parts.len() < 2 {
        return Err(format!(
            "Could not parse owner/repo from GitLab URL: {gitlab_url}"
        ));
    }

    // For nested groups, combine all parts except the last as "owner"
    let owner = if parts.len() > 2 {
        parts[..parts.len() - 1].join("-")
    } else {
        parts[0].to_string()
    };
    let repo = parts.last().unwrap().to_string();

    Ok(RepoIdentifier { owner, repo })
}

/// Get the current branch name (HEAD) for a repository
pub fn get_current_branch(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
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

/// Check if a branch exists in a repository
pub fn branch_exists(repo_path: &str, branch_name: &str) -> bool {
    Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            &format!("refs/heads/{branch_name}"),
        ])
        .current_dir(repo_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if a repository has any commits
pub fn has_commits(repo_path: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
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

    // Try preferred branch first
    if branch_exists(repo_path, preferred_branch) {
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
    let head_check = Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(repo_path)
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
    let branch_exists = Command::new("git")
        .args(["rev-parse", "--verify", &format!("refs/heads/{}", new_name)])
        .current_dir(repo_path)
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
    let output = Command::new("git")
        .args(["branch", "-m", &final_name])
        .current_dir(repo_path)
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
        let exists = Command::new("git")
            .args(["rev-parse", "--verify", &format!("refs/heads/{candidate}")])
            .current_dir(repo_path)
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
    let output = Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(repo_path)
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

/// Pull changes from remote origin for the specified base branch
pub fn git_pull(repo_path: &str, base_branch: &str) -> Result<String, String> {
    log::trace!("Pulling from origin/{base_branch} in {repo_path}");

    // Use explicit fetch + merge instead of `git pull` to avoid
    // "Cannot rebase onto multiple branches" when pull.rebase=true
    // is set in git config (common in worktree contexts)
    let fetch = Command::new("git")
        .args(["fetch", "origin", base_branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git fetch: {e}"))?;

    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr).to_string();
        log::error!("Failed to fetch origin/{base_branch}: {stderr}");
        return Err(stderr);
    }

    let merge = Command::new("git")
        .args(["merge", &format!("origin/{base_branch}")])
        .current_dir(repo_path)
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
            let conflicts = Command::new("git")
                .args(["diff", "--name-only", "--diff-filter=U"])
                .current_dir(repo_path)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();

            let msg = format!("Merge conflicts in: {conflicts}. Resolve manually or run 'git merge --abort'");
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

/// Push current branch to remote origin
pub fn git_push(repo_path: &str) -> Result<String, String> {
    log::trace!("Pushing to origin in {repo_path}");

    let output = Command::new("git")
        .args(["push"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git push: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // Git push often outputs to stderr even on success
        let result = if stdout.is_empty() { stderr } else { stdout };
        log::trace!("Successfully pushed to origin");
        Ok(result)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        // Check if branch doesn't have upstream yet (same pattern as rebase_feature_branch)
        if stderr.contains("has no upstream branch") {
            log::trace!("No upstream branch, retrying with -u origin HEAD");
            let push_u_output = Command::new("git")
                .args(["push", "-u", "origin", "HEAD"])
                .current_dir(repo_path)
                .output()
                .map_err(|e| format!("Failed to run git push -u: {e}"))?;

            if push_u_output.status.success() {
                let stdout = String::from_utf8_lossy(&push_u_output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&push_u_output.stderr).to_string();
                let result = if stdout.is_empty() { stderr } else { stdout };
                log::trace!("Successfully pushed with upstream set");
                return Ok(result);
            } else {
                let stderr = String::from_utf8_lossy(&push_u_output.stderr).to_string();
                log::error!("Failed to push with -u: {stderr}");
                return Err(stderr);
            }
        }

        log::error!("Failed to push to origin: {stderr}");
        Err(stderr)
    }
}

/// Fetch from remote origin (best effort, ignores errors if no remote)
pub fn fetch_origin(repo_path: &str) -> Result<(), String> {
    log::trace!("Fetching from origin in {repo_path}");

    let output = Command::new("git")
        .args(["fetch", "origin"])
        .current_dir(repo_path)
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
    let output = Command::new("git")
        .args(["branch", "-r", "--format=%(refname:short)"])
        .current_dir(repo_path)
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

    // git worktree add -b <new_branch> <path> <base_branch>
    let output = Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            new_branch_name,
            worktree_path,
            base_branch,
        ])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree add: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to create worktree: {stderr}"));
    }

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

    // git worktree add <path> <existing_branch> (no -b flag)
    let output = Command::new("git")
        .args(["worktree", "add", worktree_path, existing_branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree add: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to create worktree: {stderr}"));
    }

    log::trace!(
        "Successfully created worktree at {worktree_path} using existing branch {existing_branch}"
    );
    Ok(())
}

/// Checkout a PR using gh CLI in the specified directory
///
/// Uses `gh pr checkout <number>` which properly handles:
/// - Fetching the PR branch from forks
/// - Setting up proper tracking
/// - Checking out the actual PR branch
///
/// # Arguments
/// * `worktree_path` - Path to the worktree where to checkout the PR
/// * `pr_number` - The PR number to checkout
/// * `branch_name` - Optional local branch name to use (ensures local matches remote)
pub fn gh_pr_checkout(
    worktree_path: &str,
    pr_number: u32,
    branch_name: Option<&str>,
) -> Result<String, String> {
    log::trace!("Running gh pr checkout {pr_number} in {worktree_path}");

    let pr_num_str = pr_number.to_string();
    let mut args = vec!["pr", "checkout", &pr_num_str];
    if let Some(name) = branch_name {
        args.extend(["-b", name]);
    }

    let output = Command::new("gh")
        .args(&args)
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to run gh pr checkout: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to checkout PR #{pr_number}: {stderr}"));
    }

    // Get the current branch name after checkout
    let branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to get branch name: {e}"))?;

    let branch_name = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();

    log::trace!("Successfully checked out PR #{pr_number} to branch {branch_name}");
    Ok(branch_name)
}

/// Remove a git worktree
///
/// # Arguments
/// * `repo_path` - Path to the main repository
/// * `worktree_path` - Path to the worktree to remove
pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    log::trace!("Removing worktree at {worktree_path}");
    log::trace!("git worktree remove {worktree_path} --force (in {repo_path})");

    // git worktree remove <path>
    let output = Command::new("git")
        .args(["worktree", "remove", worktree_path, "--force"])
        .current_dir(repo_path)
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
            let _ = Command::new("git")
                .args(["worktree", "prune"])
                .current_dir(repo_path)
                .output();
        } else {
            return Err(format!("Failed to remove worktree: {stderr}"));
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
    let output = Command::new("git")
        .args(["branch", "-D", branch_name])
        .current_dir(repo_path)
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

/// List existing worktrees for a repository
#[allow(dead_code)]
pub fn list_worktrees(repo_path: &str) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
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
        let add_output = Command::new("git")
            .args(["add", "-A"])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to run git add: {e}"))?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("Failed to stage changes: {stderr}"));
        }
    }

    // Check if there are any changes in the working tree
    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to check git status: {e}"))?;

    let status = String::from_utf8_lossy(&status_output.stdout);
    if status.trim().is_empty() {
        return Err("Nothing to commit, working tree clean".to_string());
    }

    // Check if there are staged changes
    let diff_output = Command::new("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(repo_path)
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
    let commit_output = Command::new("git")
        .args(["commit", "-m", message])
        .current_dir(repo_path)
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
    let hash_output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
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
/// # Arguments
/// Returns platform-specific installation instructions for GitHub CLI
fn get_gh_install_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Install it with: brew install gh"
    }
    #[cfg(target_os = "windows")]
    {
        "Install it with: winget install GitHub.cli"
    }
    #[cfg(target_os = "linux")]
    {
        "Install it from: https://github.com/cli/cli/releases"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "Install GitHub CLI from: https://cli.github.com"
    }
}

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
) -> Result<String, String> {
    log::trace!("Opening pull request from {repo_path}");

    // First check if gh is installed
    let gh_check = Command::new("gh")
        .args(["--version"])
        .output()
        .map_err(|_| {
            format!(
                "GitHub CLI (gh) is not installed. {}",
                get_gh_install_hint()
            )
        })?;

    if !gh_check.status.success() {
        return Err(format!(
            "GitHub CLI (gh) is not installed. {}",
            get_gh_install_hint()
        ));
    }

    // Check if user is authenticated
    let auth_check = Command::new("gh")
        .args(["auth", "status"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to check gh auth status: {e}"))?;

    if !auth_check.status.success() {
        return Err("Not authenticated with GitHub. Run: gh auth login".to_string());
    }

    // Push current branch to remote first
    log::trace!("Pushing current branch to remote...");
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(repo_path)
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

    let output = Command::new("gh")
        .args(&args)
        .current_dir(repo_path)
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
// GitLab Merge Request Operations
// =============================================================================

/// Returns platform-specific installation instructions for GitLab CLI
fn get_glab_install_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Install it with: brew install glab"
    }
    #[cfg(target_os = "windows")]
    {
        "Install it with: winget install GitLab.GLab"
    }
    #[cfg(target_os = "linux")]
    {
        "Install it from: https://gitlab.com/gitlab-org/cli/-/releases"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "Install GitLab CLI from: https://gitlab.com/gitlab-org/cli"
    }
}

/// Open a merge request using the GitLab CLI (glab)
///
/// # Arguments
/// * `repo_path` - Path to the repository
/// * `title` - Optional MR title (if None, glab will use default)
/// * `body` - Optional MR body/description
/// * `draft` - Whether to create as draft MR
///
/// Returns the MR URL on success
pub fn open_merge_request(
    repo_path: &str,
    title: Option<&str>,
    body: Option<&str>,
    draft: bool,
) -> Result<String, String> {
    log::trace!("Opening merge request from {repo_path}");

    // First check if glab is installed
    let glab_check = Command::new("glab")
        .args(["--version"])
        .output()
        .map_err(|_| {
            format!(
                "GitLab CLI (glab) is not installed. {}",
                get_glab_install_hint()
            )
        })?;

    if !glab_check.status.success() {
        return Err(format!(
            "GitLab CLI (glab) is not installed. {}",
            get_glab_install_hint()
        ));
    }

    // Check if user is authenticated
    let auth_check = Command::new("glab")
        .args(["auth", "status"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to check glab auth status: {e}"))?;

    if !auth_check.status.success() {
        return Err("Not authenticated with GitLab. Run: glab auth login".to_string());
    }

    // Push current branch to remote first
    log::trace!("Pushing current branch to remote...");
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(repo_path)
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

    // Build the glab mr create command
    let mut args = vec!["mr", "create", "--fill"];

    if let Some(t) = title {
        args.push("--title");
        args.push(t);
    }

    if let Some(b) = body {
        args.push("--description");
        args.push(b);
    }

    if draft {
        args.push("--draft");
    }

    // Add --web to open in browser after creation
    args.push("--web");

    log::trace!("Running glab command with args: {:?}", args);

    let output = Command::new("glab")
        .args(&args)
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run glab mr create: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Check for common errors
        if stderr.contains("already exists") {
            return Err("A merge request for this branch already exists".to_string());
        }
        if stderr.contains("no commits") || stderr.contains("nothing to compare") {
            return Err("No commits to create a merge request. Make sure you have commits that differ from the target branch.".to_string());
        }
        return Err(format!("Failed to create merge request: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    log::trace!("Successfully created merge request: {stdout}");

    Ok(stdout)
}

/// Checkout a MR using glab CLI in the specified directory
///
/// Uses `glab mr checkout <number>` which properly handles:
/// - Fetching the MR branch from forks
/// - Setting up proper tracking
/// - Checking out the actual MR branch
///
/// # Arguments
/// * `worktree_path` - Path to the worktree where to checkout the MR
/// * `mr_iid` - The MR IID (internal ID) to checkout
pub fn glab_mr_checkout(worktree_path: &str, mr_iid: u32) -> Result<String, String> {
    log::trace!("Running glab mr checkout {mr_iid} in {worktree_path}");

    let output = Command::new("glab")
        .args(["mr", "checkout", &mr_iid.to_string()])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to run glab mr checkout: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to checkout MR !{mr_iid}: {stderr}"));
    }

    // Get the current branch name after checkout
    let branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to get branch name: {e}"))?;

    let branch_name = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();

    log::trace!("Successfully checked out MR !{mr_iid} to branch {branch_name}");
    Ok(branch_name)
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
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get git status: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let count = stdout.lines().filter(|l| !l.is_empty()).count() as u32;
    Ok(count)
}

/// Check if current branch has an upstream tracking branch
pub fn has_upstream_branch(repo_path: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "@{upstream}"])
        .current_dir(repo_path)
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
    log::trace!("Running setup script in {worktree_path}: {script}");

    // Use user's shell with login mode for proper PATH
    let (shell, supports_login) = get_user_shell();
    log::trace!("Using shell: {shell} (login mode: {supports_login})");

    let mut cmd = Command::new(&shell);
    if supports_login {
        cmd.args(["-l", "-c", script]);
    } else {
        cmd.args(["-c", script]);
    }

    let output = cmd
        .current_dir(worktree_path)
        .env("JEAN_WORKSPACE_PATH", worktree_path)
        .env("JEAN_ROOT_PATH", root_path)
        .env("JEAN_BRANCH", branch)
        .output()
        .map_err(|e| format!("Failed to run setup script: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let combined = format!("{stdout}{stderr}").trim().to_string();
        return Err(format!("Setup script failed:\n{combined}"));
    }

    let combined = format!("{stdout}{stderr}").trim().to_string();
    log::trace!("Setup script completed successfully");
    Ok(combined)
}

/// Check if there are uncommitted changes (staged or unstaged)
pub fn has_uncommitted_changes(repo_path: &str) -> bool {
    Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_path)
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
        let add_output = Command::new("git")
            .args(["add", "-A"])
            .current_dir(repo_path)
            .output()
            .map_err(|e| format!("Failed to stage changes: {e}"))?;

        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            return Err(format!("Failed to stage changes: {stderr}"));
        }

        // Commit
        let commit_output = Command::new("git")
            .args(["commit", "-m", message])
            .current_dir(repo_path)
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
    let fetch_output = Command::new("git")
        .args(["fetch", "origin", base_branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to fetch from origin: {e}"))?;

    if !fetch_output.status.success() {
        let stderr = String::from_utf8_lossy(&fetch_output.stderr);
        return Err(format!("Failed to fetch from origin: {stderr}"));
    }

    // Step 3: Rebase onto origin/{base_branch}
    log::trace!("Rebasing onto origin/{base_branch}...");
    let rebase_output = Command::new("git")
        .args(["rebase", &format!("origin/{base_branch}")])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to rebase: {e}"))?;

    if !rebase_output.status.success() {
        let stderr = String::from_utf8_lossy(&rebase_output.stderr);
        // Abort the rebase if it fails
        let _ = Command::new("git")
            .args(["rebase", "--abort"])
            .current_dir(repo_path)
            .output();
        return Err(format!(
            "Rebase failed (conflicts likely). Rebase has been aborted.\n{stderr}"
        ));
    }

    // Step 4: Force push with lease
    log::trace!("Force pushing with lease...");
    let push_output = Command::new("git")
        .args(["push", "--force-with-lease"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to push: {e}"))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        // Check if branch doesn't have upstream yet
        if stderr.contains("has no upstream branch") {
            // Try regular push with -u
            let push_u_output = Command::new("git")
                .args(["push", "-u", "origin", "HEAD"])
                .current_dir(repo_path)
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
    let checkout_output = Command::new("git")
        .args(["checkout", base_branch])
        .current_dir(repo_path)
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
    let pull_output = Command::new("git")
        .args(["pull", "origin", base_branch])
        .current_dir(repo_path)
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
        Command::new("git")
            .args(["merge", "--squash", feature_branch])
            .current_dir(repo_path)
            .output()
    } else {
        // --no-ff creates a merge commit preserving history
        Command::new("git")
            .args(["merge", "--no-ff", feature_branch, "-m", &merge_message])
            .current_dir(repo_path)
            .output()
    };

    match merge_output {
        Ok(output) => {
            if output.status.success() {
                // For squash merges, we need to commit the staged changes
                if squash {
                    let commit_output = Command::new("git")
                        .args(["commit", "-m", &merge_message])
                        .current_dir(repo_path)
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
    let rebase_output = Command::new("git")
        .args(["rebase", base_branch])
        .current_dir(worktree_path)
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
                    let conflict_output = Command::new("git")
                        .args(["diff", "--name-only", "--diff-filter=U"])
                        .current_dir(worktree_path)
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
                    let diff_output = Command::new("git")
                        .args(["diff"])
                        .current_dir(worktree_path)
                        .output();

                    let conflict_diff = diff_output
                        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                        .unwrap_or_default();

                    // Abort the rebase
                    log::trace!(
                        "Rebase has conflicts in {} files, aborting...",
                        conflicting_files.len()
                    );
                    let _ = Command::new("git")
                        .args(["rebase", "--abort"])
                        .current_dir(worktree_path)
                        .output();

                    return MergeResult::Conflict {
                        conflicting_files,
                        conflict_diff,
                    };
                } else {
                    // Abort any partial rebase state
                    let _ = Command::new("git")
                        .args(["rebase", "--abort"])
                        .current_dir(worktree_path)
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

    let ff_merge = Command::new("git")
        .args(["merge", "--ff-only", feature_branch])
        .current_dir(repo_path)
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
    let hash_output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
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
        let conflict_output = Command::new("git")
            .args(["diff", "--name-only", "--diff-filter=U"])
            .current_dir(repo_path)
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
        let diff_output = Command::new("git")
            .args(["diff"])
            .current_dir(repo_path)
            .output();

        let conflict_diff = diff_output
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        // Abort the merge
        log::trace!(
            "Merge has conflicts in {} files, aborting...",
            conflicting_files.len()
        );
        let _ = Command::new("git")
            .args(["merge", "--abort"])
            .current_dir(repo_path)
            .output();

        MergeResult::Conflict {
            conflicting_files,
            conflict_diff,
        }
    } else {
        // Abort any partial merge state
        let _ = Command::new("git")
            .args(["merge", "--abort"])
            .current_dir(repo_path)
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
