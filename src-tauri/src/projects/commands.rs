use ignore::WalkBuilder;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

use rand::Rng;

use super::git;
use super::git::get_repo_identifier;
use super::github_issues::{
    add_issue_reference, add_pr_reference, format_issue_context_markdown,
    format_pr_context_markdown, generate_branch_name_from_issue, generate_branch_name_from_pr,
    get_github_contexts_dir, get_github_pr, get_pr_diff, get_session_context_content,
    get_session_context_numbers, IssueContext, PullRequestContext,
};
use super::names::generate_unique_workspace_name;
use super::storage::{get_project_worktrees_dir, load_projects_data, save_projects_data};
use super::types::{
    JeanConfig, MergeType, Project, SessionType, Worktree, WorktreeArchivedEvent,
    WorktreeBranchExistsEvent, WorktreeCreateErrorEvent, WorktreeCreatedEvent,
    WorktreeCreatingEvent, WorktreeDeleteErrorEvent, WorktreeDeletedEvent, WorktreeDeletingEvent,
    WorktreePathExistsEvent, WorktreePermanentlyDeletedEvent, WorktreeUnarchivedEvent,
};
use crate::claude_cli::resolve_cli_binary;
use crate::codex_cli::resolve_cli_binary as resolve_codex_cli_binary;
use crate::gh_cli::config::resolve_gh_binary;
use crate::http_server::EmitExt;
use crate::platform::silent_command;

/// Generate a unique name by appending 4 random alphanumeric chars,
/// checking against both storage and git branches.
fn generate_unique_suffix_name(
    name: &str,
    project_path: &str,
    project_id: &str,
    data: Option<&super::types::ProjectsData>,
) -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::thread_rng();
    loop {
        let suffix: String = (0..4)
            .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
            .collect();
        let candidate = format!("{name}-{suffix}");
        let name_in_storage = data
            .map(|d| d.worktree_name_exists(project_id, &candidate))
            .unwrap_or(false);
        let branch_in_git = git::branch_exists(project_path, &candidate);
        if !name_in_storage && !branch_in_git {
            break candidate;
        }
    }
}

/// Get current Unix timestamp
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Registry of in-flight AI review process PIDs keyed by review_run_id.
static REVIEW_PROCESS_REGISTRY: Lazy<Mutex<HashMap<String, u32>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn register_review_process(review_run_id: &str, pid: u32) {
    REVIEW_PROCESS_REGISTRY
        .lock()
        .unwrap()
        .insert(review_run_id.to_string(), pid);
}

fn take_review_process_pid(review_run_id: &str) -> Option<u32> {
    REVIEW_PROCESS_REGISTRY
        .lock()
        .unwrap()
        .remove(review_run_id)
}

/// List all projects
/// Check if git global user identity is configured
#[tauri::command]
pub async fn check_git_identity() -> Result<GitIdentity, String> {
    let name = silent_command("git")
        .args(["config", "--global", "user.name"])
        .current_dir(std::env::temp_dir())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let email = silent_command("git")
        .args(["config", "--global", "user.email"])
        .current_dir(std::env::temp_dir())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    Ok(GitIdentity { name, email })
}

/// Set git global user identity
#[tauri::command]
pub async fn set_git_identity(name: String, email: String) -> Result<(), String> {
    let name_output = silent_command("git")
        .args(["config", "--global", "user.name", &name])
        .current_dir(std::env::temp_dir())
        .output()
        .map_err(|e| format!("Failed to set git user.name: {e}"))?;

    if !name_output.status.success() {
        let stderr = String::from_utf8_lossy(&name_output.stderr);
        return Err(format!("Failed to set git user.name: {stderr}"));
    }

    let email_output = silent_command("git")
        .args(["config", "--global", "user.email", &email])
        .current_dir(std::env::temp_dir())
        .output()
        .map_err(|e| format!("Failed to set git user.email: {e}"))?;

    if !email_output.status.success() {
        let stderr = String::from_utf8_lossy(&email_output.stderr);
        return Err(format!("Failed to set git user.email: {stderr}"));
    }

    log::trace!("Git identity set: {name} <{email}>");
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[tauri::command]
pub async fn list_projects(app: AppHandle) -> Result<Vec<Project>, String> {
    log::trace!("Listing all projects");
    let data = load_projects_data(&app)?;
    Ok(data.projects)
}

/// Add a new project from a git repository path
#[tauri::command]
pub async fn add_project(
    app: AppHandle,
    path: String,
    parent_id: Option<String>,
) -> Result<Project, String> {
    log::trace!("Adding project from path: {path}, parent_id: {parent_id:?}");

    // Validate it's a git repository
    if !git::validate_git_repo(&path)? {
        return Err(format!(
            "The selected folder is not a git repository.\n\n\
            To add this project, first initialize it as a git repository by running:\n\
            cd \"{path}\" && git init"
        ));
    }

    // Get repository name and current branch
    let name = git::get_repo_name(&path)?;
    // Fall back to "main" if HEAD doesn't exist yet (no commits)
    let default_branch = git::get_current_branch(&path).unwrap_or_else(|_| "main".to_string());

    // Check if project already exists
    let mut data = load_projects_data(&app)?;
    if data.projects.iter().any(|p| p.path == path) {
        return Err(format!("Project already exists: {path}"));
    }

    // Create project with order at the end of the specified parent level
    let max_order = data.get_next_order(parent_id.as_deref());
    let project = Project {
        id: Uuid::new_v4().to_string(),
        name,
        path,
        default_branch,
        added_at: now(),
        order: max_order,
        parent_id,
        is_folder: false,
        avatar_path: None,
        enabled_mcp_servers: None,
        known_mcp_servers: Vec::new(),
        custom_system_prompt: None,
        default_provider: None,
        default_backend: None,
    };

    data.add_project(project.clone());
    save_projects_data(&app, &data)?;

    log::trace!("Successfully added project: {}", project.name);
    Ok(project)
}

/// Initialize git in an existing folder (without adding to project list)
///
/// This command:
/// 1. Validates the path exists and is a directory
/// 2. Checks it's not already a git repository
/// 3. Runs `git init`
/// 4. Stages all files with `git add .`
/// 5. Creates initial commit with "Initial commit"
///
/// Returns the path on success, allowing caller to then add_project
#[tauri::command]
pub async fn init_git_in_folder(path: String) -> Result<String, String> {
    log::trace!("Initializing git in existing folder: {path}");

    // Create directory if it doesn't exist (new project flow)
    let path_obj = std::path::Path::new(&path);
    if !path_obj.exists() {
        std::fs::create_dir_all(path_obj)
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }
    if !path_obj.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }

    // Check if already a git repo
    let git_path = path_obj.join(".git");
    let already_git_repo = git_path.exists();

    if already_git_repo {
        // Check if it has any commits (HEAD exists)
        let has_commits = silent_command("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if has_commits {
            return Err("Directory is already a git repository with commits".to_string());
        }
        // If no commits, we'll skip git init and just make the initial commit
        log::trace!("Git repo exists but has no commits, will create initial commit");
    }

    // Run git init (skip if already a git repo)
    if !already_git_repo {
        let output = silent_command("git")
            .args(["init"])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to run git init: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git init failed: {stderr}"));
        }
    }

    // Stage all files
    let add_output = silent_command("git")
        .args(["add", "."])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git add: {e}"))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("git add failed: {stderr}"));
    }

    // Create initial commit
    let commit_output = silent_command("git")
        .args(["commit", "-m", "Initial commit"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git commit: {e}"))?;

    if !commit_output.status.success() {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        let stdout = String::from_utf8_lossy(&commit_output.stdout);
        // Handle case where there are no files to commit
        // Git outputs "nothing to commit" to stdout, not stderr
        if stderr.contains("nothing to commit") || stdout.contains("nothing to commit") {
            log::warn!("No files to commit, creating empty initial commit");
            // Create an empty commit with --allow-empty
            let empty_commit = silent_command("git")
                .args(["commit", "--allow-empty", "-m", "Initial commit"])
                .current_dir(&path)
                .output()
                .map_err(|e| format!("Failed to create empty commit: {e}"))?;

            if !empty_commit.status.success() {
                let empty_stderr = String::from_utf8_lossy(&empty_commit.stderr);
                return Err(format!("git commit failed: {empty_stderr}"));
            }
        } else {
            return Err(format!("git commit failed: {stderr}"));
        }
    }

    log::trace!("Successfully initialized git in {path}");
    Ok(path)
}

/// Initialize a new project by creating directory and running git init
#[tauri::command]
pub async fn init_project(
    app: AppHandle,
    path: String,
    parent_id: Option<String>,
) -> Result<Project, String> {
    log::trace!("Initializing new project at path: {path}, parent_id: {parent_id:?}");

    // Initialize git repository (creates dir if needed)
    git::init_repo(&path)?;

    // Get repository name (directory name)
    let name = git::get_repo_name(&path)?;

    // For new repos, the default branch is typically "main" or "master"
    // Get it from git to be sure
    let default_branch = git::get_current_branch(&path).unwrap_or_else(|_| "main".to_string());

    // Check if project already exists
    let mut data = load_projects_data(&app)?;
    if data.projects.iter().any(|p| p.path == path) {
        return Err(format!("Project already exists: {path}"));
    }

    // Create project with order at the end of the specified parent level
    let max_order = data.get_next_order(parent_id.as_deref());
    let project = Project {
        id: Uuid::new_v4().to_string(),
        name,
        path,
        default_branch,
        added_at: now(),
        order: max_order,
        parent_id,
        is_folder: false,
        avatar_path: None,
        enabled_mcp_servers: None,
        known_mcp_servers: Vec::new(),
        custom_system_prompt: None,
        default_provider: None,
        default_backend: None,
    };

    data.add_project(project.clone());
    save_projects_data(&app, &data)?;

    log::trace!("Successfully initialized project: {}", project.name);
    Ok(project)
}

/// Remove a project
/// Only blocks if there are active (non-archived) worktrees.
/// Automatically cleans up archived worktrees and their sessions.
#[tauri::command]
pub async fn remove_project(app: AppHandle, project_id: String) -> Result<(), String> {
    log::trace!("Removing project: {project_id}");

    let mut data = load_projects_data(&app)?;

    // Check if project has active (non-archived) worktrees
    let has_active_worktrees = data
        .worktrees
        .iter()
        .any(|w| w.project_id == project_id && w.archived_at.is_none());

    if has_active_worktrees {
        return Err(
            "Cannot remove project with existing worktrees. Delete worktrees first.".to_string(),
        );
    }

    // Collect archived worktrees for this project to clean up
    let archived_worktree_ids: Vec<String> = data
        .worktrees
        .iter()
        .filter(|w| w.project_id == project_id && w.archived_at.is_some())
        .map(|w| w.id.clone())
        .collect();

    // Remove archived worktrees from data
    for worktree_id in &archived_worktree_ids {
        data.remove_worktree(worktree_id);
        log::trace!("Removed archived worktree: {worktree_id}");
    }

    // Remove project
    data.remove_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    save_projects_data(&app, &data)?;

    // Clean up sessions files for archived worktrees (in background, non-blocking)
    for worktree_id in archived_worktree_ids {
        if let Ok(sessions_file) = crate::chat::storage::get_sessions_path(&app, &worktree_id) {
            if sessions_file.exists() {
                if let Err(e) = std::fs::remove_file(&sessions_file) {
                    log::warn!("Failed to delete sessions file for {worktree_id}: {e}");
                } else {
                    log::trace!("Deleted sessions file for archived worktree: {worktree_id}");
                }
            }
        }
    }

    // Also clean up preserved base sessions file for this project
    if let Ok(base_sessions_file) =
        crate::chat::storage::get_closed_base_sessions_path(&app, &project_id)
    {
        if base_sessions_file.exists() {
            if let Err(e) = std::fs::remove_file(&base_sessions_file) {
                log::warn!("Failed to delete base sessions file for project {project_id}: {e}");
            } else {
                log::trace!("Deleted base sessions file for project: {project_id}");
            }
        }
    }

    log::trace!("Successfully removed project: {project_id}");
    Ok(())
}

/// List all worktrees for a project
#[tauri::command]
pub async fn list_worktrees(app: AppHandle, project_id: String) -> Result<Vec<Worktree>, String> {
    log::trace!("Listing worktrees for project: {project_id}");

    let data = load_projects_data(&app)?;
    let worktrees = data
        .worktrees_for_project(&project_id)
        .into_iter()
        .filter(|w| w.archived_at.is_none()) // Filter out archived worktrees
        .cloned()
        .collect();

    Ok(worktrees)
}

/// Get a single worktree by ID
#[tauri::command]
pub async fn get_worktree(app: AppHandle, worktree_id: String) -> Result<Worktree, String> {
    log::trace!("Getting worktree: {worktree_id}");

    let data = load_projects_data(&app)?;
    data.find_worktree(&worktree_id)
        .cloned()
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))
}

/// Create a new worktree for a project (runs in background)
///
/// This command returns immediately with a "pending" worktree.
/// The actual git worktree creation happens in a background thread.
/// Events are emitted to notify the frontend of progress:
/// - `worktree:creating` - Emitted immediately when creation starts
/// - `worktree:created` - Emitted when creation completes successfully
/// - `worktree:error` - Emitted if creation fails
#[tauri::command]
pub async fn create_worktree(
    app: AppHandle,
    project_id: String,
    base_branch: Option<String>,
    issue_context: Option<IssueContext>,
    pr_context: Option<PullRequestContext>,
    custom_name: Option<String>,
) -> Result<Worktree, String> {
    log::trace!("Creating worktree for project: {project_id}");

    let data = load_projects_data(&app)?;

    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();

    // Use provided base branch or project's default branch, with validation
    let preferred_base = base_branch.unwrap_or_else(|| project.default_branch.clone());
    let base = git::get_valid_base_branch(&project.path, &preferred_base)?;

    // Resolve auto-pull preference now (async), but defer the actual pull to background thread
    let should_auto_pull = if pr_context.is_none() {
        crate::load_preferences(app.clone())
            .await
            .map(|prefs| prefs.auto_pull_base_branch)
            .unwrap_or(false)
    } else {
        false
    };

    // Generate workspace name - use custom name, PR-based name, issue-based name, or random name
    let name = if let Some(custom) = custom_name {
        // Use the provided custom name directly (already validated as unique by caller)
        custom
    } else if let Some(ref ctx) = pr_context {
        let pr_branch = generate_branch_name_from_pr(ctx.number, &ctx.title);
        // Check if this branch name already exists, if so, add a suffix
        if data.worktree_name_exists(&project_id, &pr_branch) {
            let mut counter = 2;
            loop {
                let candidate = format!("{pr_branch}-{counter}");
                if !data.worktree_name_exists(&project_id, &candidate) {
                    break candidate;
                }
                counter += 1;
            }
        } else {
            pr_branch
        }
    } else if let Some(ref ctx) = issue_context {
        let issue_branch = generate_branch_name_from_issue(ctx.number, &ctx.title);
        // Check if this branch name already exists, if so, add a suffix
        if data.worktree_name_exists(&project_id, &issue_branch) {
            let mut counter = 2;
            loop {
                let candidate = format!("{issue_branch}-{counter}");
                if !data.worktree_name_exists(&project_id, &candidate) {
                    break candidate;
                }
                counter += 1;
            }
        } else {
            issue_branch
        }
    } else {
        generate_unique_workspace_name(|n| {
            data.worktree_name_exists(&project_id, n) || git::branch_exists(&project.path, n)
        })
    };

    // Build worktree path: ~/jean/<project-name>/<workspace-name>
    let project_worktrees_dir = get_project_worktrees_dir(&project.name)?;
    let worktree_path = project_worktrees_dir.join(&name);
    let worktree_path_str = worktree_path
        .to_str()
        .ok_or_else(|| "Invalid worktree path".to_string())?
        .to_string();

    // Generate ID upfront so we can track this worktree
    let worktree_id = Uuid::new_v4().to_string();
    let created_at = now();

    // Emit creating event immediately
    let creating_event = WorktreeCreatingEvent {
        id: worktree_id.clone(),
        project_id: project_id.clone(),
        name: name.clone(),
        path: worktree_path_str.clone(),
        branch: name.clone(),
        pr_number: pr_context.as_ref().map(|ctx| ctx.number as u64),
        issue_number: issue_context.as_ref().map(|ctx| ctx.number as u64),
    };
    if let Err(e) = app.emit_all("worktree:creating", &creating_event) {
        log::error!("Failed to emit worktree:creating event: {e}");
    }

    // Create a pending worktree record to return immediately
    let pending_worktree = Worktree {
        id: worktree_id.clone(),
        project_id: project_id.clone(),
        name: name.clone(),
        path: worktree_path_str.clone(),
        branch: name.clone(),
        created_at,
        setup_output: None,
        setup_script: None,
        session_type: SessionType::Worktree,
        pr_number: pr_context.as_ref().map(|ctx| ctx.number),
        pr_url: None,
        issue_number: issue_context.as_ref().map(|ctx| ctx.number),
        cached_pr_status: None,
        cached_check_status: None,
        cached_behind_count: None,
        cached_ahead_count: None,
        cached_status_at: None,
        cached_uncommitted_added: None,
        cached_uncommitted_removed: None,
        cached_branch_diff_added: None,
        cached_branch_diff_removed: None,
        cached_base_branch_ahead_count: None,
        cached_base_branch_behind_count: None,
        cached_worktree_ahead_count: None,
        cached_unpushed_count: None,
        order: 0, // Placeholder, actual order is set in background thread
        archived_at: None,
    };

    // Clone values for the background thread
    let app_clone = app.clone();
    let project_path = project.path.clone();
    let worktree_id_clone = worktree_id.clone();
    let project_id_clone = project_id.clone();
    let name_clone = name.clone();
    let worktree_path_clone = worktree_path_str.clone();
    let base_clone = base.clone();
    let issue_context_clone = issue_context.clone();
    let pr_context_clone = pr_context.clone();

    // Spawn background thread for git operations
    thread::spawn(move || {
        // Clone IDs for panic handler (before they're moved into the inner closure)
        let panic_wt_id = worktree_id_clone.clone();
        let panic_proj_id = project_id_clone.clone();
        let panic_app = app_clone.clone();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            log::trace!("Background: Creating git worktree {name_clone} at {worktree_path_clone}");

            // Auto-pull base branch if enabled (non-blocking on failure)
            if should_auto_pull {
                log::trace!("Auto-pulling base branch {base_clone} before worktree creation");
                match git::git_pull(&project_path, &base_clone, None) {
                    Ok(_) => log::trace!("Successfully pulled base branch {base_clone}"),
                    Err(e) => log::warn!("Failed to auto-pull base branch {base_clone}: {e}"),
                }
            }

            // Check if path already exists
            let worktree_path = std::path::Path::new(&worktree_path_clone);
            if worktree_path.exists() {
                log::trace!("Background: Path already exists: {worktree_path_clone}");

                // Check if this path matches an archived worktree
                let archived_info = load_projects_data(&app_clone).ok().and_then(|data| {
                    data.worktrees
                        .iter()
                        .find(|w| w.path == worktree_path_clone && w.archived_at.is_some())
                        .map(|w| (w.id.clone(), w.name.clone()))
                });

                // Generate a suggested alternative name with random suffix
                // Must check both storage AND git branches (branch may exist from previously deleted worktree)
                let suggested_name = {
                    let data = load_projects_data(&app_clone).ok();
                    generate_unique_suffix_name(
                        &name_clone,
                        &project_path,
                        &project_id_clone,
                        data.as_ref(),
                    )
                };

                // Emit path_exists event with archived worktree info if available
                let path_exists_event = WorktreePathExistsEvent {
                    id: worktree_id_clone.clone(),
                    project_id: project_id_clone.clone(),
                    path: worktree_path_clone.clone(),
                    suggested_name,
                    archived_worktree_id: archived_info.as_ref().map(|(id, _)| id.clone()),
                    archived_worktree_name: archived_info.map(|(_, name)| name),
                    issue_context: issue_context_clone.clone(),
                };
                if let Err(e) = app_clone.emit_all("worktree:path_exists", &path_exists_event) {
                    log::error!("Failed to emit worktree:path_exists event: {e}");
                }

                // Also emit error event to remove the pending worktree from UI
                let error_event = WorktreeCreateErrorEvent {
                    id: worktree_id_clone,
                    project_id: project_id_clone,
                    error: format!("Directory already exists: {worktree_path_clone}"),
                };
                if let Err(e) = app_clone.emit_all("worktree:error", &error_event) {
                    log::error!("Failed to emit worktree:error event: {e}");
                }
                return;
            }

            // For PR context, we use a temp branch + gh pr checkout pattern
            // For other cases, check if branch already exists
            let (branch_for_worktree, temp_branch_to_delete, actual_branch_name) =
                if let Some(ref ctx) = pr_context_clone {
                    // Use temp branch for PR checkout pattern
                    let temp_branch = format!(
                        "pr-{}-temp-{}",
                        ctx.number,
                        uuid::Uuid::new_v4()
                            .to_string()
                            .split('-')
                            .next()
                            .unwrap_or("xxxx")
                    );
                    (
                        temp_branch.clone(),
                        Some(temp_branch),
                        ctx.head_ref_name.clone(),
                    )
                } else {
                    // Check if branch already exists for non-PR cases
                    if git::branch_exists(&project_path, &name_clone) {
                        log::trace!("Background: Branch already exists: {name_clone}");

                        // Generate a suggested alternative name with random suffix
                        let suggested_name = {
                            let data = load_projects_data(&app_clone).ok();
                            generate_unique_suffix_name(
                                &name_clone,
                                &project_path,
                                &project_id_clone,
                                data.as_ref(),
                            )
                        };

                        // Emit branch_exists event
                        let branch_exists_event = WorktreeBranchExistsEvent {
                            id: worktree_id_clone.clone(),
                            project_id: project_id_clone.clone(),
                            branch: name_clone.clone(),
                            suggested_name,
                            issue_context: issue_context_clone.clone(),
                            pr_context: pr_context_clone.clone(),
                        };
                        if let Err(e) =
                            app_clone.emit_all("worktree:branch_exists", &branch_exists_event)
                        {
                            log::error!("Failed to emit worktree:branch_exists event: {e}");
                        }

                        // Also emit error event to remove the pending worktree from UI
                        let error_event = WorktreeCreateErrorEvent {
                            id: worktree_id_clone,
                            project_id: project_id_clone,
                            error: format!("Branch already exists: {name_clone}"),
                        };
                        if let Err(e) = app_clone.emit_all("worktree:error", &error_event) {
                            log::error!("Failed to emit worktree:error event: {e}");
                        }
                        return;
                    }
                    (name_clone.clone(), None, name_clone.clone())
                };

            // Create the git worktree (this is the slow operation)
            if let Err(e) = git::create_worktree(
                &project_path,
                &worktree_path_clone,
                &branch_for_worktree,
                &base_clone,
            ) {
                log::error!("Background: Failed to create worktree: {e}");
                let error_event = WorktreeCreateErrorEvent {
                    id: worktree_id_clone,
                    project_id: project_id_clone,
                    error: e,
                };
                if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                    log::error!("Failed to emit worktree:error event: {emit_err}");
                }
                return;
            }

            log::trace!("Background: Git worktree created successfully");

            // For PR context, run gh pr checkout to get the actual PR branch
            let final_branch = if let Some(ref ctx) = pr_context_clone {
                log::trace!(
                    "Background: Running gh pr checkout {} for PR branch",
                    ctx.number
                );

                // Check if PR head branch name collides with a locally checked-out branch
                // (e.g. PR from fork with head "main" when local "main" is already checked out)
                let branch_collision = git::branch_exists(&project_path, &ctx.head_ref_name);
                let local_branch_name = if branch_collision {
                    let alt = format!("pr-{}-{}", ctx.number, ctx.head_ref_name);
                    log::trace!(
                        "Branch '{}' already exists, using '{alt}' instead",
                        ctx.head_ref_name
                    );
                    alt
                } else {
                    ctx.head_ref_name.clone()
                };

                // Clean up stale branch from a previous checkout of this PR
                git::cleanup_stale_branch(&project_path, &local_branch_name);

                let checkout_result = if branch_collision {
                    // Bypass gh pr checkout which internally fetches into the conflicting ref.
                    // Manually fetch the PR into the alt branch name and switch to it.
                    log::trace!(
                    "Background: Branch collision, manual fetch PR #{} into {local_branch_name}",
                    ctx.number
                );
                    git::fetch_pr_to_branch(&project_path, ctx.number, &local_branch_name).and_then(
                        |_| {
                            git::checkout_branch(&worktree_path_clone, &local_branch_name)?;
                            Ok(local_branch_name)
                        },
                    )
                } else {
                    git::gh_pr_checkout(
                        &worktree_path_clone,
                        ctx.number,
                        Some(&local_branch_name),
                        &resolve_gh_binary(&app_clone),
                    )
                };

                match checkout_result {
                    Ok(branch) => {
                        log::trace!("Background: PR checkout succeeded, branch: {branch}");

                        // Delete the temporary branch
                        if let Some(ref temp_branch) = temp_branch_to_delete {
                            if let Err(e) = git::delete_branch(&project_path, temp_branch) {
                                log::warn!(
                                    "Background: Failed to delete temp branch {temp_branch}: {e}"
                                );
                                // Not fatal, continue anyway
                            }
                        }

                        branch
                    }
                    Err(e) => {
                        log::error!("Background: Failed to checkout PR: {e}");
                        // Clean up the worktree we created
                        let _ = git::remove_worktree(&project_path, &worktree_path_clone);
                        if let Some(ref temp_branch) = temp_branch_to_delete {
                            let _ = git::delete_branch(&project_path, temp_branch);
                        }
                        let error_event = WorktreeCreateErrorEvent {
                            id: worktree_id_clone,
                            project_id: project_id_clone,
                            error: e,
                        };
                        if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                            log::error!("Failed to emit worktree:error event: {emit_err}");
                        }
                        return;
                    }
                }
            } else {
                actual_branch_name
            };

            // Write issue context file if provided (to shared git-context directory)
            if let Some(ctx) = &issue_context_clone {
                log::trace!(
                    "Background: Writing issue context file for issue #{}",
                    ctx.number
                );
                if let Ok(repo_id) = get_repo_identifier(&project_path) {
                    let repo_key = repo_id.to_key();
                    if let Ok(contexts_dir) = get_github_contexts_dir(&app_clone) {
                        if let Err(e) = std::fs::create_dir_all(&contexts_dir) {
                            log::warn!("Background: Failed to create git-context directory: {e}");
                        } else {
                            let context_file =
                                contexts_dir.join(format!("{repo_key}-issue-{}.md", ctx.number));
                            let context_content = format_issue_context_markdown(ctx);
                            if let Err(e) = std::fs::write(&context_file, context_content) {
                                log::warn!("Background: Failed to write issue context file: {e}");
                            } else {
                                // Add reference for this worktree
                                if let Err(e) = add_issue_reference(
                                    &app_clone,
                                    &repo_key,
                                    ctx.number,
                                    &worktree_id_clone,
                                ) {
                                    log::warn!("Background: Failed to add issue reference: {e}");
                                }
                                log::trace!(
                                    "Background: Issue context file written to {:?}",
                                    context_file
                                );
                            }
                        }
                    }
                } else {
                    log::warn!("Background: Could not get repo identifier for issue context");
                }
            }

            // Write PR context file if provided (to shared git-context directory)
            if let Some(ctx) = &pr_context_clone {
                log::trace!("Background: Writing PR context file for PR #{}", ctx.number);
                if let Ok(repo_id) = get_repo_identifier(&project_path) {
                    let repo_key = repo_id.to_key();
                    if let Ok(contexts_dir) = get_github_contexts_dir(&app_clone) {
                        if let Err(e) = std::fs::create_dir_all(&contexts_dir) {
                            log::warn!("Background: Failed to create git-context directory: {e}");
                        } else {
                            // Fetch the diff if not already present
                            let gh = resolve_gh_binary(&app_clone);
                            let ctx_with_diff = if ctx.diff.is_none() {
                                log::debug!("Background: Fetching diff for PR #{}", ctx.number);
                                let diff = get_pr_diff(&project_path, ctx.number, &gh).ok();
                                PullRequestContext {
                                    number: ctx.number,
                                    title: ctx.title.clone(),
                                    body: ctx.body.clone(),
                                    head_ref_name: ctx.head_ref_name.clone(),
                                    base_ref_name: ctx.base_ref_name.clone(),
                                    comments: ctx.comments.clone(),
                                    reviews: ctx.reviews.clone(),
                                    diff,
                                }
                            } else {
                                ctx.clone()
                            };

                            let context_file =
                                contexts_dir.join(format!("{repo_key}-pr-{}.md", ctx.number));
                            let context_content = format_pr_context_markdown(&ctx_with_diff);
                            if let Err(e) = std::fs::write(&context_file, context_content) {
                                log::warn!("Background: Failed to write PR context file: {e}");
                            } else {
                                // Add reference for this worktree
                                if let Err(e) = add_pr_reference(
                                    &app_clone,
                                    &repo_key,
                                    ctx.number,
                                    &worktree_id_clone,
                                ) {
                                    log::warn!("Background: Failed to add PR reference: {e}");
                                }
                                log::trace!(
                                    "Background: PR context file written to {:?}",
                                    context_file
                                );
                            }
                        }
                    }
                } else {
                    log::warn!("Background: Could not get repo identifier for PR context");
                }
            }

            // Check for jean.json and run setup script
            let (setup_output, setup_script) =
                if let Some(config) = git::read_jean_config(&project_path) {
                    if let Some(script) = config.scripts.setup {
                        log::trace!("Background: Found jean.json with setup script, executing...");
                        match git::run_setup_script(
                            &worktree_path_clone,
                            &project_path,
                            &final_branch,
                            &script,
                        ) {
                            Ok(output) => (Some(output), Some(script)),
                            Err(e) => {
                                log::error!("Background: Setup script failed: {e}");
                                // Clean up: remove the worktree since setup failed
                                let _ = git::remove_worktree(&project_path, &worktree_path_clone);
                                let _ = git::delete_branch(&project_path, &final_branch);
                                let error_event = WorktreeCreateErrorEvent {
                                    id: worktree_id_clone,
                                    project_id: project_id_clone,
                                    error: format!("Setup script failed: {e}"),
                                };
                                if let Err(emit_err) =
                                    app_clone.emit_all("worktree:error", &error_event)
                                {
                                    log::error!("Failed to emit worktree:error event: {emit_err}");
                                }
                                return;
                            }
                        }
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

            // Save to storage
            if let Ok(mut data) = load_projects_data(&app_clone) {
                // Get max order for worktrees in this project
                let max_order = data
                    .worktrees
                    .iter()
                    .filter(|w| w.project_id == project_id_clone)
                    .map(|w| w.order)
                    .max()
                    .unwrap_or(0);

                // Create the final worktree record
                let worktree = Worktree {
                    id: worktree_id_clone.clone(),
                    project_id: project_id_clone.clone(),
                    name: name_clone.clone(),
                    path: worktree_path_clone.clone(),
                    branch: final_branch,
                    created_at,
                    setup_output,
                    setup_script,
                    session_type: SessionType::Worktree,
                    pr_number: pr_context_clone.as_ref().map(|ctx| ctx.number),
                    pr_url: None,
                    issue_number: issue_context_clone.as_ref().map(|ctx| ctx.number),
                    cached_pr_status: None,
                    cached_check_status: None,
                    cached_behind_count: None,
                    cached_ahead_count: None,
                    cached_status_at: None,
                    cached_uncommitted_added: None,
                    cached_uncommitted_removed: None,
                    cached_branch_diff_added: None,
                    cached_branch_diff_removed: None,
                    cached_base_branch_ahead_count: None,
                    cached_base_branch_behind_count: None,
                    cached_worktree_ahead_count: None,
                    cached_unpushed_count: None,
                    order: max_order + 1,
                    archived_at: None,
                };

                data.add_worktree(worktree.clone());
                if let Err(e) = save_projects_data(&app_clone, &data) {
                    log::error!("Background: Failed to save worktree data: {e}");
                    let error_event = WorktreeCreateErrorEvent {
                        id: worktree_id_clone,
                        project_id: project_id_clone,
                        error: format!("Failed to save worktree: {e}"),
                    };
                    if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                        log::error!("Failed to emit worktree:error event: {emit_err}");
                    }
                    return;
                }

                // Emit success event
                log::trace!(
                    "Background: Worktree created successfully: {}",
                    worktree.name
                );
                let created_event = WorktreeCreatedEvent { worktree };
                if let Err(e) = app_clone.emit_all("worktree:created", &created_event) {
                    log::error!("Failed to emit worktree:created event: {e}");
                }
            } else {
                log::error!("Background: Failed to load projects data for saving");
                let error_event = WorktreeCreateErrorEvent {
                    id: worktree_id_clone,
                    project_id: project_id_clone,
                    error: "Failed to load projects data".to_string(),
                };
                if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                    log::error!("Failed to emit worktree:error event: {emit_err}");
                }
            }
        })); // end catch_unwind

        if let Err(panic_info) = result {
            log::error!("Background thread panicked during worktree creation: {panic_info:?}");
            let error_event = WorktreeCreateErrorEvent {
                id: panic_wt_id,
                project_id: panic_proj_id,
                error: "Internal error: worktree creation failed unexpectedly".to_string(),
            };
            let _ = panic_app.emit_all("worktree:error", &error_event);
        }
    });

    log::trace!("Returning pending worktree: {}", pending_worktree.name);
    Ok(pending_worktree)
}

/// Create a worktree from an existing branch (runs in background)
///
/// This command is used when a branch already exists and the user wants to
/// create a worktree for it instead of creating a new branch.
/// The actual git worktree creation happens in a background thread.
/// Events are emitted to notify the frontend of progress.
#[tauri::command]
pub async fn create_worktree_from_existing_branch(
    app: AppHandle,
    project_id: String,
    branch_name: String,
    issue_context: Option<IssueContext>,
    pr_context: Option<PullRequestContext>,
) -> Result<Worktree, String> {
    log::trace!("Creating worktree from existing branch {branch_name} for project: {project_id}");

    let data = load_projects_data(&app)?;

    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();

    // Use the branch name as the worktree name
    let name = branch_name.clone();

    // Build worktree path: ~/jean/<project-name>/<workspace-name>
    let project_worktrees_dir = get_project_worktrees_dir(&project.name)?;
    let worktree_path = project_worktrees_dir.join(&name);
    let worktree_path_str = worktree_path
        .to_str()
        .ok_or_else(|| "Invalid worktree path".to_string())?
        .to_string();

    // Generate ID upfront so we can track this worktree
    let worktree_id = Uuid::new_v4().to_string();
    let created_at = now();

    // Emit creating event immediately
    let creating_event = WorktreeCreatingEvent {
        id: worktree_id.clone(),
        project_id: project_id.clone(),
        name: name.clone(),
        path: worktree_path_str.clone(),
        branch: name.clone(),
        pr_number: pr_context.as_ref().map(|ctx| ctx.number as u64),
        issue_number: issue_context.as_ref().map(|ctx| ctx.number as u64),
    };
    if let Err(e) = app.emit_all("worktree:creating", &creating_event) {
        log::error!("Failed to emit worktree:creating event: {e}");
    }

    // Create a pending worktree record to return immediately
    let pending_worktree = Worktree {
        id: worktree_id.clone(),
        project_id: project_id.clone(),
        name: name.clone(),
        path: worktree_path_str.clone(),
        branch: name.clone(),
        created_at,
        setup_output: None,
        setup_script: None,
        session_type: SessionType::Worktree,
        pr_number: pr_context.as_ref().map(|ctx| ctx.number),
        pr_url: None,
        issue_number: issue_context.as_ref().map(|ctx| ctx.number),
        cached_pr_status: None,
        cached_check_status: None,
        cached_behind_count: None,
        cached_ahead_count: None,
        cached_status_at: None,
        cached_uncommitted_added: None,
        cached_uncommitted_removed: None,
        cached_branch_diff_added: None,
        cached_branch_diff_removed: None,
        cached_base_branch_ahead_count: None,
        cached_base_branch_behind_count: None,
        cached_worktree_ahead_count: None,
        cached_unpushed_count: None,
        order: 0, // Placeholder, actual order is set in background thread
        archived_at: None,
    };

    // Clone values for the background thread
    let app_clone = app.clone();
    let project_path = project.path.clone();
    let worktree_id_clone = worktree_id.clone();
    let project_id_clone = project_id.clone();
    let name_clone = name.clone();
    let worktree_path_clone = worktree_path_str.clone();
    let branch_name_clone = branch_name.clone();
    let issue_context_clone = issue_context.clone();
    let pr_context_clone = pr_context.clone();

    // Spawn background thread for git operations
    thread::spawn(move || {
        // Clone IDs for panic handler (before they're moved into the inner closure)
        let panic_wt_id = worktree_id_clone.clone();
        let panic_proj_id = project_id_clone.clone();
        let panic_app = app_clone.clone();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            log::trace!("Background: Creating git worktree {name_clone} at {worktree_path_clone} using existing branch {branch_name_clone}");

            // Check if path already exists
            let worktree_path = std::path::Path::new(&worktree_path_clone);
            if worktree_path.exists() {
                log::error!("Background: Path already exists: {worktree_path_clone}");
                let error_event = WorktreeCreateErrorEvent {
                    id: worktree_id_clone,
                    project_id: project_id_clone,
                    error: format!("Directory already exists: {worktree_path_clone}"),
                };
                if let Err(e) = app_clone.emit_all("worktree:error", &error_event) {
                    log::error!("Failed to emit worktree:error event: {e}");
                }
                return;
            }

            // Create the git worktree from existing branch
            if let Err(e) = git::create_worktree_from_existing_branch(
                &project_path,
                &worktree_path_clone,
                &branch_name_clone,
            ) {
                log::error!("Background: Failed to create worktree: {e}");
                let error_event = WorktreeCreateErrorEvent {
                    id: worktree_id_clone,
                    project_id: project_id_clone,
                    error: e,
                };
                if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                    log::error!("Failed to emit worktree:error event: {emit_err}");
                }
                return;
            }

            log::trace!("Background: Git worktree created successfully from existing branch");

            // Write issue context file if provided
            if let Some(ctx) = &issue_context_clone {
                log::trace!(
                    "Background: Writing issue context file for issue #{}",
                    ctx.number
                );
                if let Ok(repo_id) = get_repo_identifier(&project_path) {
                    let repo_key = repo_id.to_key();
                    if let Ok(contexts_dir) = get_github_contexts_dir(&app_clone) {
                        if let Err(e) = std::fs::create_dir_all(&contexts_dir) {
                            log::warn!("Background: Failed to create git-context directory: {e}");
                        } else {
                            let context_file =
                                contexts_dir.join(format!("{repo_key}-issue-{}.md", ctx.number));
                            let context_content = format_issue_context_markdown(ctx);
                            if let Err(e) = std::fs::write(&context_file, context_content) {
                                log::warn!("Background: Failed to write issue context file: {e}");
                            } else {
                                if let Err(e) = add_issue_reference(
                                    &app_clone,
                                    &repo_key,
                                    ctx.number,
                                    &worktree_id_clone,
                                ) {
                                    log::warn!("Background: Failed to add issue reference: {e}");
                                }
                                log::trace!(
                                    "Background: Issue context file written to {:?}",
                                    context_file
                                );
                            }
                        }
                    }
                }
            }

            // Write PR context file if provided
            if let Some(ctx) = &pr_context_clone {
                log::trace!("Background: Writing PR context file for PR #{}", ctx.number);
                if let Ok(repo_id) = get_repo_identifier(&project_path) {
                    let repo_key = repo_id.to_key();
                    if let Ok(contexts_dir) = get_github_contexts_dir(&app_clone) {
                        if let Err(e) = std::fs::create_dir_all(&contexts_dir) {
                            log::warn!("Background: Failed to create git-context directory: {e}");
                        } else {
                            // Fetch the diff if not already present
                            let gh = resolve_gh_binary(&app_clone);
                            let ctx_with_diff = if ctx.diff.is_none() {
                                log::debug!("Background: Fetching diff for PR #{}", ctx.number);
                                let diff = get_pr_diff(&project_path, ctx.number, &gh).ok();
                                PullRequestContext {
                                    number: ctx.number,
                                    title: ctx.title.clone(),
                                    body: ctx.body.clone(),
                                    head_ref_name: ctx.head_ref_name.clone(),
                                    base_ref_name: ctx.base_ref_name.clone(),
                                    comments: ctx.comments.clone(),
                                    reviews: ctx.reviews.clone(),
                                    diff,
                                }
                            } else {
                                ctx.clone()
                            };

                            let context_file =
                                contexts_dir.join(format!("{repo_key}-pr-{}.md", ctx.number));
                            let context_content = format_pr_context_markdown(&ctx_with_diff);
                            if let Err(e) = std::fs::write(&context_file, context_content) {
                                log::warn!("Background: Failed to write PR context file: {e}");
                            } else {
                                if let Err(e) = add_pr_reference(
                                    &app_clone,
                                    &repo_key,
                                    ctx.number,
                                    &worktree_id_clone,
                                ) {
                                    log::warn!("Background: Failed to add PR reference: {e}");
                                }
                                log::trace!(
                                    "Background: PR context file written to {:?}",
                                    context_file
                                );
                            }
                        }
                    }
                }
            }

            // Check for jean.json and run setup script
            let (setup_output, setup_script) =
                if let Some(config) = git::read_jean_config(&project_path) {
                    if let Some(script) = config.scripts.setup {
                        log::trace!("Background: Found jean.json with setup script, executing...");
                        match git::run_setup_script(
                            &worktree_path_clone,
                            &project_path,
                            &name_clone,
                            &script,
                        ) {
                            Ok(output) => (Some(output), Some(script)),
                            Err(e) => {
                                log::error!("Background: Setup script failed: {e}");
                                // Clean up: remove the worktree since setup failed
                                // Note: Don't delete the branch since it's an existing branch
                                let _ = git::remove_worktree(&project_path, &worktree_path_clone);
                                let error_event = WorktreeCreateErrorEvent {
                                    id: worktree_id_clone,
                                    project_id: project_id_clone,
                                    error: format!("Setup script failed: {e}"),
                                };
                                if let Err(emit_err) =
                                    app_clone.emit_all("worktree:error", &error_event)
                                {
                                    log::error!("Failed to emit worktree:error event: {emit_err}");
                                }
                                return;
                            }
                        }
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

            // Save to storage
            if let Ok(mut data) = load_projects_data(&app_clone) {
                // Get max order for worktrees in this project
                let max_order = data
                    .worktrees
                    .iter()
                    .filter(|w| w.project_id == project_id_clone)
                    .map(|w| w.order)
                    .max()
                    .unwrap_or(0);

                // Create the final worktree record
                let worktree = Worktree {
                    id: worktree_id_clone.clone(),
                    project_id: project_id_clone.clone(),
                    name: name_clone.clone(),
                    path: worktree_path_clone.clone(),
                    branch: branch_name_clone,
                    created_at,
                    setup_output,
                    setup_script,
                    session_type: SessionType::Worktree,
                    pr_number: None,
                    pr_url: None,
                    issue_number: issue_context_clone.as_ref().map(|ctx| ctx.number),
                    cached_pr_status: None,
                    cached_check_status: None,
                    cached_behind_count: None,
                    cached_ahead_count: None,
                    cached_status_at: None,
                    cached_uncommitted_added: None,
                    cached_uncommitted_removed: None,
                    cached_branch_diff_added: None,
                    cached_branch_diff_removed: None,
                    cached_base_branch_ahead_count: None,
                    cached_base_branch_behind_count: None,
                    cached_worktree_ahead_count: None,
                    cached_unpushed_count: None,
                    order: max_order + 1,
                    archived_at: None,
                };

                data.add_worktree(worktree.clone());
                if let Err(e) = save_projects_data(&app_clone, &data) {
                    log::error!("Background: Failed to save worktree data: {e}");
                    let error_event = WorktreeCreateErrorEvent {
                        id: worktree_id_clone,
                        project_id: project_id_clone,
                        error: format!("Failed to save worktree: {e}"),
                    };
                    if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                        log::error!("Failed to emit worktree:error event: {emit_err}");
                    }
                    return;
                }

                // Emit success event
                log::trace!(
                    "Background: Worktree created successfully from existing branch: {}",
                    worktree.name
                );
                let created_event = WorktreeCreatedEvent { worktree };
                if let Err(e) = app_clone.emit_all("worktree:created", &created_event) {
                    log::error!("Failed to emit worktree:created event: {e}");
                }
            } else {
                log::error!("Background: Failed to load projects data for saving");
                let error_event = WorktreeCreateErrorEvent {
                    id: worktree_id_clone,
                    project_id: project_id_clone,
                    error: "Failed to load projects data".to_string(),
                };
                if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                    log::error!("Failed to emit worktree:error event: {emit_err}");
                }
            }
        })); // end catch_unwind

        if let Err(panic_info) = result {
            log::error!("Background thread panicked during worktree creation from existing branch: {panic_info:?}");
            let error_event = WorktreeCreateErrorEvent {
                id: panic_wt_id,
                project_id: panic_proj_id,
                error: "Internal error: worktree creation failed unexpectedly".to_string(),
            };
            let _ = panic_app.emit_all("worktree:error", &error_event);
        }
    });

    log::trace!("Returning pending worktree: {}", pending_worktree.name);
    Ok(pending_worktree)
}

/// Checkout a GitHub PR to a new worktree
///
/// This command:
/// 1. Fetches PR details from GitHub
/// 2. Fetches the PR branch using GitHub's magic refs (works for forks)
/// 3. Creates a worktree using the fetched branch
/// 4. Writes PR context file for reference
///
/// Events emitted:
/// - `worktree:creating` - Emitted immediately with worktree ID and info
/// - `worktree:created` - Emitted when worktree is ready
/// - `worktree:error` - Emitted if any step fails
#[tauri::command]
pub async fn checkout_pr(
    app: AppHandle,
    project_id: String,
    pr_number: u32,
) -> Result<Worktree, String> {
    log::trace!("Checking out PR #{pr_number} for project: {project_id}");

    let mut data = load_projects_data(&app)?;

    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();

    // Check if there's an archived worktree for this PR — restore it instead of creating a new one
    if let Some(archived_wt) = data.worktrees.iter().find(|w| {
        w.project_id == project_id && w.pr_number == Some(pr_number) && w.archived_at.is_some()
    }) {
        let worktree_id = archived_wt.id.clone();
        log::info!("[checkout_pr] Found archived worktree {worktree_id} for PR #{pr_number}, attempting unarchive");
        return unarchive_worktree(app, worktree_id).await;
    }
    log::info!("[checkout_pr] No archived worktree found for PR #{pr_number}, creating new");

    // Fetch PR details from GitHub (for context and worktree naming)
    let pr_detail = get_github_pr(app.clone(), project.path.clone(), pr_number).await?;

    // Get valid base branch for creating the worktree
    let base_branch = git::get_valid_base_branch(&project.path, &project.default_branch)?;

    // Generate worktree name from PR (for the directory/worktree name, not the branch)
    let worktree_name = generate_branch_name_from_pr(pr_number, &pr_detail.title);
    log::info!("[checkout_pr] Generated base worktree name: '{worktree_name}'");

    // Remove any archived worktree records for this PR from data so they don't
    // interfere with name dedup. The background thread will clean up leftover
    // git worktrees/branches/directories.
    let project_worktrees_dir = get_project_worktrees_dir(&project.name)?;
    let had_archived = data.worktrees.iter().any(|w| {
        w.project_id == project_id && w.pr_number == Some(pr_number) && w.archived_at.is_some()
    });
    if had_archived {
        log::info!(
            "[checkout_pr] Removing archived worktree records for PR #{pr_number} from data"
        );
        data.worktrees.retain(|w| {
            !(w.project_id == project_id
                && w.pr_number == Some(pr_number)
                && w.archived_at.is_some())
        });
        save_projects_data(&app, &data)?;
    }

    // Log all worktrees for this project to understand name collision state
    let existing_names: Vec<String> = data
        .worktrees
        .iter()
        .filter(|w| w.project_id == project_id)
        .map(|w| format!("'{}' (archived={})", w.name, w.archived_at.is_some()))
        .collect();
    log::info!("[checkout_pr] Existing worktrees for project: [{existing_names:?}]");
    let dir_exists = project_worktrees_dir.join(&worktree_name).exists();
    let name_in_data = data.worktree_name_exists(&project_id, &worktree_name);
    log::info!(
        "[checkout_pr] Name '{worktree_name}' — in_data={name_in_data}, dir_exists={dir_exists}"
    );

    // Check if worktree name already exists among active worktrees, add suffix if needed.
    // Don't check filesystem here — the background thread will clean up leftover dirs.
    let final_worktree_name = if name_in_data {
        let mut counter = 2;
        loop {
            let candidate = format!("{worktree_name}-{counter}");
            if !data.worktree_name_exists(&project_id, &candidate) {
                log::info!("[checkout_pr] Name collision, using '{candidate}'");
                break candidate;
            }
            counter += 1;
        }
    } else {
        log::info!("[checkout_pr] Using base name '{worktree_name}'");
        worktree_name
    };

    // Generate a temporary branch name for worktree creation
    // This will be replaced by the actual PR branch after gh pr checkout
    let temp_branch_name = format!(
        "pr-{pr_number}-temp-{}",
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("xxxx")
    );

    // Build worktree path: ~/jean/<project-name>/<workspace-name>
    let worktree_path = project_worktrees_dir.join(&final_worktree_name);
    let worktree_path_str = worktree_path
        .to_str()
        .ok_or_else(|| "Invalid worktree path".to_string())?
        .to_string();

    // Generate ID upfront so we can track this worktree
    let worktree_id = Uuid::new_v4().to_string();
    let created_at = now();

    // Emit creating event immediately (branch will be updated after gh pr checkout)
    let creating_event = WorktreeCreatingEvent {
        id: worktree_id.clone(),
        project_id: project_id.clone(),
        name: final_worktree_name.clone(),
        path: worktree_path_str.clone(),
        branch: pr_detail.head_ref_name.clone(), // Use PR's actual branch name
        pr_number: Some(pr_number as u64),
        issue_number: None,
    };
    if let Err(e) = app.emit_all("worktree:creating", &creating_event) {
        log::error!("Failed to emit worktree:creating event: {e}");
    }

    // Create a pending worktree record to return immediately
    // Note: branch will be updated to actual PR branch after gh pr checkout
    let pending_worktree = Worktree {
        id: worktree_id.clone(),
        project_id: project_id.clone(),
        name: final_worktree_name.clone(),
        path: worktree_path_str.clone(),
        branch: pr_detail.head_ref_name.clone(), // Use PR's actual branch name
        created_at,
        setup_output: None,
        setup_script: None,
        session_type: SessionType::Worktree,
        pr_number: Some(pr_number),
        pr_url: None,
        issue_number: None,
        cached_pr_status: None,
        cached_check_status: None,
        cached_behind_count: None,
        cached_ahead_count: None,
        cached_status_at: None,
        cached_uncommitted_added: None,
        cached_uncommitted_removed: None,
        cached_branch_diff_added: None,
        cached_branch_diff_removed: None,
        cached_base_branch_ahead_count: None,
        cached_base_branch_behind_count: None,
        cached_worktree_ahead_count: None,
        cached_unpushed_count: None,
        order: 0, // Will be updated in background thread
        archived_at: None,
    };

    // Clone values for background thread
    let app_clone = app.clone();
    let project_path = project.path.clone();
    let worktree_id_clone = worktree_id.clone();
    let project_id_clone = project_id.clone();
    let worktree_path_clone = worktree_path_str.clone();
    let worktree_name_clone = final_worktree_name.clone();
    let temp_branch_clone = temp_branch_name.clone();
    let base_branch_clone = base_branch.clone();
    let pr_title = pr_detail.title.clone();
    let pr_body = pr_detail.body.clone();
    let pr_head_ref = pr_detail.head_ref_name.clone();
    let pr_base_ref = pr_detail.base_ref_name.clone();
    let pr_comments = pr_detail.comments.clone();
    let pr_reviews = pr_detail.reviews.clone();

    // Do the heavy lifting in a background thread
    thread::spawn(move || {
        // Clone IDs for panic handler (before they're moved into the inner closure)
        let panic_wt_id = worktree_id_clone.clone();
        let panic_proj_id = project_id_clone.clone();
        let panic_app = app_clone.clone();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            log::trace!("Background: Creating worktree for PR #{pr_number}");

            // Clean up leftover directory from a previous checkout of this PR
            // (e.g. permanently_delete_worktree's background cleanup hasn't finished yet)
            let dir_exists_before = std::path::Path::new(&worktree_path_clone).exists();
            log::info!("[checkout_pr bg] worktree_path={worktree_path_clone}, dir_exists={dir_exists_before}");
            if dir_exists_before {
                log::info!("[checkout_pr bg] Removing leftover directory at {worktree_path_clone}");
                let remove_result = git::remove_worktree(&project_path, &worktree_path_clone);
                log::info!("[checkout_pr bg] remove_worktree result: {remove_result:?}");
                if std::path::Path::new(&worktree_path_clone).exists() {
                    log::info!(
                        "[checkout_pr bg] Dir still exists after remove_worktree, force removing"
                    );
                    let _ = std::fs::remove_dir_all(&worktree_path_clone);
                }
                log::info!(
                    "[checkout_pr bg] Dir exists after cleanup: {}",
                    std::path::Path::new(&worktree_path_clone).exists()
                );
            }

            // Step 1: Create worktree with a temporary branch based on base branch
            // This gives us a working directory where we can run gh pr checkout
            if let Err(e) = git::create_worktree(
                &project_path,
                &worktree_path_clone,
                &temp_branch_clone,
                &base_branch_clone,
            ) {
                log::error!("Background: Failed to create worktree: {e}");
                let error_event = WorktreeCreateErrorEvent {
                    id: worktree_id_clone,
                    project_id: project_id_clone,
                    error: e,
                };
                if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                    log::error!("Failed to emit worktree:error event: {emit_err}");
                }
                return;
            }

            log::trace!("Background: Worktree created, now running gh pr checkout {pr_number}");

            // Determine safe local branch name for gh pr checkout -b
            // If pr_head_ref (e.g. "main") already exists locally, use an alternative
            // to avoid "refusing to fetch into branch" errors when the branch is checked out
            let branch_collision = git::branch_exists(&project_path, &pr_head_ref);
            let local_branch_name = if branch_collision {
                let alt = format!("pr-{pr_number}-{pr_head_ref}");
                log::trace!("Branch '{pr_head_ref}' already exists, using '{alt}' instead");
                alt
            } else {
                pr_head_ref.clone()
            };

            // Clean up stale branch from a previous checkout of this PR
            // Handles: archived worktree still has branch checked out, or
            // permanently-deleted worktree whose background cleanup didn't finish
            git::cleanup_stale_branch(&project_path, &local_branch_name);

            // Step 2: Checkout the PR branch into the worktree
            // If branch name collides (e.g. PR head is "main" and "main" is checked out),
            // bypass `gh pr checkout` which internally fetches into the conflicting ref.
            // Instead, manually fetch the PR into the alt branch name and switch to it.
            let actual_branch = if branch_collision {
                log::trace!("Background: Branch collision detected, using manual fetch for PR #{pr_number} into {local_branch_name}");
                match git::fetch_pr_to_branch(&project_path, pr_number, &local_branch_name)
                    .and_then(|_| {
                        git::checkout_branch(&worktree_path_clone, &local_branch_name)?;
                        Ok(local_branch_name.clone())
                    }) {
                    Ok(branch) => {
                        log::trace!(
                            "Background: Manual PR fetch+checkout succeeded, branch: {branch}"
                        );
                        branch
                    }
                    Err(e) => {
                        log::error!("Background: Failed to checkout PR: {e}");
                        let _ = git::remove_worktree(&project_path, &worktree_path_clone);
                        let _ = git::delete_branch(&project_path, &temp_branch_clone);
                        let error_event = WorktreeCreateErrorEvent {
                            id: worktree_id_clone,
                            project_id: project_id_clone,
                            error: e,
                        };
                        if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                            log::error!("Failed to emit worktree:error event: {emit_err}");
                        }
                        return;
                    }
                }
            } else {
                // No collision - use gh pr checkout which sets up tracking nicely
                match git::gh_pr_checkout(
                    &worktree_path_clone,
                    pr_number,
                    Some(&local_branch_name),
                    &resolve_gh_binary(&app_clone),
                ) {
                    Ok(branch) => {
                        log::trace!("Background: gh pr checkout succeeded, branch: {branch}");
                        branch
                    }
                    Err(e) => {
                        log::error!("Background: Failed to checkout PR: {e}");
                        let _ = git::remove_worktree(&project_path, &worktree_path_clone);
                        let _ = git::delete_branch(&project_path, &temp_branch_clone);
                        let error_event = WorktreeCreateErrorEvent {
                            id: worktree_id_clone,
                            project_id: project_id_clone,
                            error: e,
                        };
                        if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                            log::error!("Failed to emit worktree:error event: {emit_err}");
                        }
                        return;
                    }
                }
            };

            // Step 3: Delete the temporary branch (it's no longer needed)
            // The worktree is now on the actual PR branch
            if let Err(e) = git::delete_branch(&project_path, &temp_branch_clone) {
                log::warn!("Background: Failed to delete temp branch {temp_branch_clone}: {e}");
                // Not fatal, continue anyway
            }

            log::trace!(
                "Background: Git worktree ready with PR #{pr_number} on branch {actual_branch}"
            );

            // Check for jean.json and run setup script
            let (setup_output, setup_script) =
                if let Some(config) = git::read_jean_config(&worktree_path_clone) {
                    if let Some(script) = config.scripts.setup {
                        log::trace!("Background: Found jean.json with setup script, executing...");
                        match git::run_setup_script(
                            &worktree_path_clone,
                            &project_path,
                            &actual_branch,
                            &script,
                        ) {
                            Ok(output) => (Some(output), Some(script)),
                            Err(e) => {
                                log::error!("Background: Setup script failed: {e}");
                                // Clean up: remove the worktree since setup failed
                                let _ = git::remove_worktree(&project_path, &worktree_path_clone);
                                let _ = git::delete_branch(&project_path, &actual_branch);
                                let error_event = WorktreeCreateErrorEvent {
                                    id: worktree_id_clone,
                                    project_id: project_id_clone,
                                    error: format!("Setup script failed: {e}"),
                                };
                                if let Err(emit_err) =
                                    app_clone.emit_all("worktree:error", &error_event)
                                {
                                    log::error!("Failed to emit worktree:error event: {emit_err}");
                                }
                                return;
                            }
                        }
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

            // Write PR context file to shared git-context directory
            if let Ok(repo_id) = get_repo_identifier(&project_path) {
                let repo_key = repo_id.to_key();
                if let Ok(contexts_dir) = get_github_contexts_dir(&app_clone) {
                    if let Err(e) = std::fs::create_dir_all(&contexts_dir) {
                        log::warn!("Background: Failed to create git-context directory: {e}");
                    } else {
                        // Create PR context
                        let pr_context = PullRequestContext {
                            number: pr_number,
                            title: pr_title.clone(),
                            body: pr_body,
                            head_ref_name: pr_head_ref,
                            base_ref_name: pr_base_ref,
                            comments: pr_comments
                                .into_iter()
                                .map(|c| super::github_issues::GitHubComment {
                                    body: c.body,
                                    author: super::github_issues::GitHubAuthor {
                                        login: c.author.login,
                                    },
                                    created_at: c.created_at,
                                })
                                .collect(),
                            reviews: pr_reviews
                                .into_iter()
                                .map(|r| super::github_issues::GitHubReview {
                                    body: r.body,
                                    state: r.state,
                                    author: super::github_issues::GitHubAuthor {
                                        login: r.author.login,
                                    },
                                    submitted_at: r.submitted_at,
                                })
                                .collect(),
                            diff: get_pr_diff(
                                &project_path,
                                pr_number,
                                &resolve_gh_binary(&app_clone),
                            )
                            .ok(),
                        };

                        let context_file =
                            contexts_dir.join(format!("{repo_key}-pr-{pr_number}.md"));
                        let context_content = format_pr_context_markdown(&pr_context);
                        if let Err(e) = std::fs::write(&context_file, context_content) {
                            log::warn!("Background: Failed to write PR context file: {e}");
                        } else {
                            // Add reference for this worktree
                            if let Err(e) = add_pr_reference(
                                &app_clone,
                                &repo_key,
                                pr_number,
                                &worktree_id_clone,
                            ) {
                                log::warn!("Background: Failed to add PR reference: {e}");
                            }
                            log::trace!(
                                "Background: PR context file written to {:?}",
                                context_file
                            );
                        }
                    }
                }
            }

            // Save to storage
            if let Ok(mut data) = load_projects_data(&app_clone) {
                // Get max order for worktrees in this project
                let max_order = data
                    .worktrees
                    .iter()
                    .filter(|w| w.project_id == project_id_clone)
                    .map(|w| w.order)
                    .max()
                    .unwrap_or(0);

                // Create the final worktree record with the actual PR branch name
                let worktree = Worktree {
                    id: worktree_id_clone.clone(),
                    project_id: project_id_clone.clone(),
                    name: worktree_name_clone.clone(),
                    path: worktree_path_clone.clone(),
                    branch: actual_branch.clone(),
                    created_at,
                    setup_output,
                    setup_script,
                    session_type: SessionType::Worktree,
                    pr_number: Some(pr_number),
                    pr_url: None,
                    issue_number: None,
                    cached_pr_status: None,
                    cached_check_status: None,
                    cached_behind_count: None,
                    cached_ahead_count: None,
                    cached_status_at: None,
                    cached_uncommitted_added: None,
                    cached_uncommitted_removed: None,
                    cached_branch_diff_added: None,
                    cached_branch_diff_removed: None,
                    cached_base_branch_ahead_count: None,
                    cached_base_branch_behind_count: None,
                    cached_worktree_ahead_count: None,
                    cached_unpushed_count: None,
                    order: max_order + 1,
                    archived_at: None,
                };

                data.add_worktree(worktree.clone());
                if let Err(e) = save_projects_data(&app_clone, &data) {
                    log::error!("Background: Failed to save worktree data: {e}");
                    let error_event = WorktreeCreateErrorEvent {
                        id: worktree_id_clone,
                        project_id: project_id_clone,
                        error: format!("Failed to save worktree: {e}"),
                    };
                    if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                        log::error!("Failed to emit worktree:error event: {emit_err}");
                    }
                    return;
                }

                // Emit success event
                log::trace!(
                    "Background: Worktree created successfully for PR #{}: {}",
                    pr_number,
                    worktree.name
                );
                let created_event = WorktreeCreatedEvent { worktree };
                if let Err(e) = app_clone.emit_all("worktree:created", &created_event) {
                    log::error!("Failed to emit worktree:created event: {e}");
                }
            } else {
                log::error!("Background: Failed to load projects data for saving");
                let error_event = WorktreeCreateErrorEvent {
                    id: worktree_id_clone,
                    project_id: project_id_clone,
                    error: "Failed to load projects data".to_string(),
                };
                if let Err(emit_err) = app_clone.emit_all("worktree:error", &error_event) {
                    log::error!("Failed to emit worktree:error event: {emit_err}");
                }
            }
        })); // end catch_unwind

        if let Err(panic_info) = result {
            log::error!("Background thread panicked during PR checkout: {panic_info:?}");
            let error_event = WorktreeCreateErrorEvent {
                id: panic_wt_id,
                project_id: panic_proj_id,
                error: "Internal error: PR checkout failed unexpectedly".to_string(),
            };
            let _ = panic_app.emit_all("worktree:error", &error_event);
        }
    });

    log::trace!(
        "Returning pending worktree for PR #{}: {}",
        pr_number,
        pending_worktree.name
    );
    Ok(pending_worktree)
}

/// Delete a worktree (runs in background)
///
/// This command returns immediately after emitting a deleting event.
/// The actual git worktree removal happens in a background thread.
/// Events are emitted to notify the frontend of progress:
/// - `worktree:deleting` - Emitted immediately when deletion starts
/// - `worktree:deleted` - Emitted when deletion completes successfully
/// - `worktree:delete_error` - Emitted if deletion fails
#[tauri::command]
pub async fn delete_worktree(app: AppHandle, worktree_id: String) -> Result<(), String> {
    log::trace!("Deleting worktree: {worktree_id}");

    // Cancel any running Claude processes for this worktree FIRST
    crate::chat::registry::cancel_processes_for_worktree(&app, &worktree_id);

    let data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?
        .clone();

    log::trace!(
        "Found worktree: id={}, name={}, branch={}, path={}",
        worktree.id,
        worktree.name,
        worktree.branch,
        worktree.path
    );

    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?
        .clone();

    log::trace!("Found project: id={}, path={}", project.id, project.path);

    // Remove from storage SYNCHRONOUSLY to avoid race conditions with other operations
    // (e.g., archive/unarchive could be overwritten if we save in background thread)
    let mut data = load_projects_data(&app)?;
    data.remove_worktree(&worktree_id);
    save_projects_data(&app, &data)?;
    log::trace!("Worktree removed from storage: {worktree_id}");

    // Emit deleting event immediately
    let deleting_event = WorktreeDeletingEvent {
        id: worktree_id.clone(),
        project_id: worktree.project_id.clone(),
    };
    if let Err(e) = app.emit_all("worktree:deleting", &deleting_event) {
        log::error!("Failed to emit worktree:deleting event: {e}");
    }

    // Clone values for the background thread
    let app_clone = app.clone();
    let worktree_id_clone = worktree_id.clone();
    let project_id_clone = worktree.project_id.clone();
    let project_path = project.path.clone();
    let worktree_path = worktree.path.clone();
    let worktree_branch = worktree.branch.clone();
    let worktree_name = worktree.name.clone();

    // Spawn background thread for git operations only
    // Storage is already updated, so git failures won't corrupt other data
    thread::spawn(move || {
        log::trace!("Background: Removing git worktree at {worktree_path}");

        // Remove the git worktree (this can be slow for large repos)
        if let Err(e) = git::remove_worktree(&project_path, &worktree_path) {
            log::error!("Background: Failed to remove worktree: {e}");
            let error_event = WorktreeDeleteErrorEvent {
                id: worktree_id_clone,
                project_id: project_id_clone,
                error: e,
            };
            if let Err(emit_err) = app_clone.emit_all("worktree:delete_error", &error_event) {
                log::error!("Failed to emit worktree:delete_error event: {emit_err}");
            }
            return;
        }

        log::trace!("Background: Git worktree removed, deleting branch {worktree_branch}");

        // Delete the branch
        if let Err(e) = git::delete_branch(&project_path, &worktree_branch) {
            log::error!("Background: Failed to delete branch: {e}");
            let error_event = WorktreeDeleteErrorEvent {
                id: worktree_id_clone,
                project_id: project_id_clone,
                error: e,
            };
            if let Err(emit_err) = app_clone.emit_all("worktree:delete_error", &error_event) {
                log::error!("Failed to emit worktree:delete_error event: {emit_err}");
            }
            return;
        }

        // Emit success event
        log::trace!("Background: Worktree deleted successfully: {worktree_name}");
        let deleted_event = WorktreeDeletedEvent {
            id: worktree_id_clone,
            project_id: project_id_clone,
        };
        if let Err(e) = app_clone.emit_all("worktree:deleted", &deleted_event) {
            log::error!("Failed to emit worktree:deleted event: {e}");
        }
    });

    log::trace!(
        "Delete started in background for worktree: {}",
        worktree.name
    );
    Ok(())
}

/// Create or reopen a base branch session for a project
/// Base sessions use the project's base directory directly (no git worktree creation)
/// If a preserved sessions file exists from a previous close, it will be restored
#[tauri::command]
pub async fn create_base_session(app: AppHandle, project_id: String) -> Result<Worktree, String> {
    log::trace!("Creating base session for project: {project_id}");

    let mut data = load_projects_data(&app)?;

    // Check if base session already exists - return existing for reopening
    if let Some(existing) = data.find_base_session(&project_id) {
        log::trace!("Returning existing base session: {}", existing.name);
        return Ok(existing.clone());
    }

    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();

    // Create base session record (NO git worktree creation)
    // Base sessions always have order 0 (first in list)
    let session = Worktree {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.clone(),
        name: project.default_branch.clone(),
        path: project.path.clone(), // Uses project's base directory directly
        branch: project.default_branch.clone(),
        created_at: now(),
        setup_output: None,
        setup_script: None,
        session_type: SessionType::Base,
        pr_number: None,
        pr_url: None,
        issue_number: None,
        cached_pr_status: None,
        cached_check_status: None,
        cached_behind_count: None,
        cached_ahead_count: None,
        cached_status_at: None,
        cached_uncommitted_added: None,
        cached_uncommitted_removed: None,
        cached_branch_diff_added: None,
        cached_branch_diff_removed: None,
        cached_base_branch_ahead_count: None,
        cached_base_branch_behind_count: None,
        cached_worktree_ahead_count: None,
        cached_unpushed_count: None,
        order: 0, // Base sessions are always first
        archived_at: None,
    };

    data.add_worktree(session.clone());
    save_projects_data(&app, &data)?;

    // Try to restore preserved sessions from a previous close
    // This migrates base-{project_id}.json to {new_worktree_id}.json
    match crate::chat::restore_base_sessions(&app, &project_id, &session.id) {
        Ok(Some(_)) => {
            log::trace!("Restored preserved sessions for base session");
            // Unarchive all sessions — they were archived by close_base_session_archive
            // but the user is reopening the base session, so they should be active again
            let wt_path = session.path.clone();
            let wt_id = session.id.clone();
            if let Err(e) = crate::chat::with_sessions_mut(&app, &wt_path, &wt_id, |sessions| {
                for s in &mut sessions.sessions {
                    if s.archived_at.is_some() {
                        s.archived_at = None;
                    }
                }
                Ok(())
            }) {
                log::warn!("Failed to unarchive restored sessions: {e}");
            }
        }
        Ok(None) => {
            log::trace!("No preserved sessions to restore");
        }
        Err(e) => {
            // Log error but don't fail - a fresh session will be created instead
            log::warn!("Failed to restore preserved sessions: {e}");
        }
    }

    log::trace!(
        "Successfully created base session for project: {}",
        project.name
    );
    Ok(session)
}

/// Close a base branch session (removes record only, no git operations)
/// Preserves the sessions file so it can be restored when the base session is reopened
#[tauri::command]
pub async fn close_base_session(app: AppHandle, worktree_id: String) -> Result<(), String> {
    log::info!("[BASE_CLOSE] close_base_session (preserve, no archive) called for {worktree_id}");
    close_base_session_internal(&app, &worktree_id, true, false).await
}

/// Close a base branch session without preserving sessions (clean close)
/// Deletes the sessions file entirely so the base session starts fresh on reopen
#[tauri::command]
pub async fn close_base_session_clean(app: AppHandle, worktree_id: String) -> Result<(), String> {
    log::info!("[BASE_CLOSE] close_base_session_clean called for {worktree_id}");
    close_base_session_internal(&app, &worktree_id, false, false).await
}

/// Close a base branch session, archiving all non-archived sessions first.
/// Sets archived_at on each session and preserves the sessions file so they
/// appear in the Archive modal.
#[tauri::command]
pub async fn close_base_session_archive(app: AppHandle, worktree_id: String) -> Result<(), String> {
    log::info!("[BASE_CLOSE] close_base_session_archive called for {worktree_id}");
    close_base_session_internal(&app, &worktree_id, true, true).await
}

/// Internal implementation for closing a base session
async fn close_base_session_internal(
    app: &AppHandle,
    worktree_id: &str,
    preserve_sessions: bool,
    archive_sessions: bool,
) -> Result<(), String> {
    log::info!("[BASE_CLOSE] Closing base session: {worktree_id} (preserve_sessions: {preserve_sessions}, archive_sessions: {archive_sessions})");

    let mut data = load_projects_data(app)?;

    let worktree = data
        .find_worktree(worktree_id)
        .ok_or_else(|| format!("Session not found: {worktree_id}"))?
        .clone();

    // Verify it's a base session
    if worktree.session_type != SessionType::Base {
        return Err("Not a base session. Use delete_worktree instead.".to_string());
    }

    log::info!(
        "[BASE_CLOSE] Found base session, session_type={:?}, path={}",
        worktree.session_type,
        worktree.path
    );

    // Archive all non-archived sessions before closing
    if archive_sessions {
        let worktree_path = worktree.path.clone();
        let wt_id = worktree_id.to_string();
        log::info!("[BASE_CLOSE] Archiving sessions for worktree_id={wt_id}, path={worktree_path}");
        let archive_result = crate::chat::with_sessions_mut(
            app,
            &worktree_path,
            &wt_id,
            |sessions| {
                let ts = now();
                let mut archived_count = 0u32;
                let total = sessions.sessions.len();
                for session in &mut sessions.sessions {
                    log::info!(
                        "[BASE_CLOSE] Session '{}' (id={}): archived_at={:?}",
                        session.name,
                        session.id,
                        session.archived_at
                    );
                    if session.archived_at.is_none() {
                        session.archived_at = Some(ts);
                        archived_count += 1;
                        log::info!("[BASE_CLOSE] -> Archived session '{}'", session.name);
                    }
                }
                log::info!("[BASE_CLOSE] Archived {archived_count}/{total} sessions in base session {wt_id}");
                Ok(archived_count)
            },
        );
        match &archive_result {
            Ok(count) => log::info!("[BASE_CLOSE] Archive result: Ok({count})"),
            Err(e) => log::warn!("[BASE_CLOSE] Failed to archive sessions: {e}"),
        }
    } else {
        log::info!("[BASE_CLOSE] Skipping session archival (archive_sessions=false)");
    }

    if preserve_sessions || archive_sessions {
        // Preserve the sessions file before removing the worktree
        // This renames {worktree_id}.json to base-{project_id}.json
        log::info!(
            "[BASE_CLOSE] Preserving sessions file for worktree_id={worktree_id}, project_id={}",
            worktree.project_id
        );
        crate::chat::preserve_base_sessions(app, worktree_id, &worktree.project_id)?;
    } else {
        // Delete the sessions file entirely for a clean close
        if let Ok(sessions_file) = crate::chat::storage::get_sessions_path(app, worktree_id) {
            if sessions_file.exists() {
                if let Err(e) = std::fs::remove_file(&sessions_file) {
                    log::warn!("Failed to delete sessions file for {worktree_id}: {e}");
                } else {
                    log::trace!(
                        "Deleted sessions file for clean base session close: {worktree_id}"
                    );
                }
            }
        }
    }

    let project_id = worktree.project_id.clone();

    // Remove from data (NO git operations - we don't delete the project directory!)
    data.remove_worktree(worktree_id);
    save_projects_data(app, &data)?;

    // Emit deleted event so other clients clear their ChatWindow state
    let deleted_event = WorktreeDeletedEvent {
        id: worktree_id.to_string(),
        project_id,
    };
    if let Err(e) = app.emit_all("worktree:deleted", &deleted_event) {
        log::error!("Failed to emit worktree:deleted event for base session close: {e}");
    }

    log::trace!("Successfully closed base session: {}", worktree.name);
    Ok(())
}

// =============================================================================
// Archive Commands
// =============================================================================

/// Archive a worktree (keeps git worktree/branch on disk, just hides from UI)
///
/// Unlike delete_worktree, this does NOT remove the git worktree or branch.
/// It only marks the worktree as archived by setting archived_at timestamp.
///
/// Note: Base sessions cannot be archived - use close_base_session instead.
#[tauri::command]
pub async fn archive_worktree(app: AppHandle, worktree_id: String) -> Result<(), String> {
    log::trace!("Archiving worktree: {worktree_id}");

    // Cancel any running Claude processes for this worktree
    crate::chat::registry::cancel_processes_for_worktree(&app, &worktree_id);

    let mut data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree_mut(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    // Base sessions cannot be archived - they should be closed instead
    if worktree.session_type == SessionType::Base {
        return Err(
            "Base sessions cannot be archived. Use close_base_session instead.".to_string(),
        );
    }

    // Check if already archived
    if worktree.archived_at.is_some() {
        return Err("Worktree is already archived".to_string());
    }

    let project_id = worktree.project_id.clone();

    // Set archived timestamp
    worktree.archived_at = Some(now());

    // Save the updated data
    save_projects_data(&app, &data)?;

    // Emit archived event
    let event = WorktreeArchivedEvent {
        id: worktree_id.clone(),
        project_id,
    };
    if let Err(e) = app.emit_all("worktree:archived", &event) {
        log::error!("Failed to emit worktree:archived event: {e}");
    }

    log::trace!("Successfully archived worktree: {worktree_id}");
    Ok(())
}

/// Unarchive a worktree (restore to UI)
///
/// Validates that the git worktree and branch still exist on disk.
#[tauri::command]
pub async fn unarchive_worktree(app: AppHandle, worktree_id: String) -> Result<Worktree, String> {
    log::trace!("Unarchiving worktree: {worktree_id}");

    let mut data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree_mut(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    // Verify it's archived
    if worktree.archived_at.is_none() {
        return Err("Worktree is not archived".to_string());
    }

    // For non-base sessions, validate git worktree still exists
    if worktree.session_type != SessionType::Base {
        let path = std::path::Path::new(&worktree.path);
        if !path.exists() {
            return Err(format!(
                "Git worktree directory no longer exists: {}. The worktree may need to be permanently deleted.",
                worktree.path
            ));
        }
    }

    // Clear archived timestamp
    worktree.archived_at = None;

    let restored_worktree = worktree.clone();

    // Save the updated data
    save_projects_data(&app, &data)?;

    // Emit unarchived event
    let event = WorktreeUnarchivedEvent {
        worktree: restored_worktree.clone(),
    };
    if let Err(e) = app.emit_all("worktree:unarchived", &event) {
        log::error!("Failed to emit worktree:unarchived event: {e}");
    }

    log::trace!("Successfully unarchived worktree: {worktree_id}");
    Ok(restored_worktree)
}

/// List all archived worktrees across all projects
#[tauri::command]
pub async fn list_archived_worktrees(app: AppHandle) -> Result<Vec<Worktree>, String> {
    log::trace!("Listing all archived worktrees");

    let data = load_projects_data(&app)?;
    let archived = data
        .worktrees
        .iter()
        .filter(|w| w.archived_at.is_some())
        .cloned()
        .collect();

    Ok(archived)
}

/// Import an existing git worktree directory into Jean
///
/// Used when a directory exists at the worktree path but isn't tracked by Jean.
/// Validates that the path is a valid git worktree and extracts the branch name.
#[tauri::command]
pub async fn import_worktree(
    app: AppHandle,
    project_id: String,
    path: String,
) -> Result<Worktree, String> {
    log::trace!("Importing worktree: path={path}, project_id={project_id}");

    let worktree_path = Path::new(&path);

    // Verify the path exists
    if !worktree_path.exists() {
        return Err(format!("Path does not exist: {path}"));
    }

    // Verify it's a directory
    if !worktree_path.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }

    // Check if this is a git directory (has .git file or directory)
    let git_indicator = worktree_path.join(".git");
    if !git_indicator.exists() {
        return Err(format!("Path is not a git worktree or repository: {path}"));
    }

    // Get the current branch name from git
    let branch = git::get_current_branch(&path)?;

    // Extract the worktree name from the path (last component)
    let name = worktree_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Invalid path: {path}"))?
        .to_string();

    let mut data = load_projects_data(&app)?;

    // Verify project exists
    let _ = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    // Check if a worktree with this path already exists
    if data.worktrees.iter().any(|w| w.path == path) {
        return Err(format!(
            "A worktree with this path is already tracked: {path}"
        ));
    }

    // Get max order for worktrees in this project
    let max_order = data
        .worktrees
        .iter()
        .filter(|w| w.project_id == project_id)
        .map(|w| w.order)
        .max()
        .unwrap_or(0);

    // Create the worktree record
    let worktree = Worktree {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.clone(),
        name,
        path: path.clone(),
        branch,
        created_at: now(),
        setup_output: None,
        setup_script: None,
        session_type: SessionType::Worktree,
        pr_number: None,
        pr_url: None,
        issue_number: None,
        cached_pr_status: None,
        cached_check_status: None,
        cached_behind_count: None,
        cached_ahead_count: None,
        cached_status_at: None,
        cached_uncommitted_added: None,
        cached_uncommitted_removed: None,
        cached_branch_diff_added: None,
        cached_branch_diff_removed: None,
        cached_base_branch_ahead_count: None,
        cached_base_branch_behind_count: None,
        cached_worktree_ahead_count: None,
        cached_unpushed_count: None,
        order: max_order + 1,
        archived_at: None,
    };

    data.add_worktree(worktree.clone());
    save_projects_data(&app, &data)?;

    // Emit created event
    let event = WorktreeCreatedEvent {
        worktree: worktree.clone(),
    };
    if let Err(e) = app.emit_all("worktree:created", &event) {
        log::error!("Failed to emit worktree:created event: {e}");
    }

    log::trace!("Successfully imported worktree: {}", worktree.id);
    Ok(worktree)
}

/// Permanently delete an archived worktree (removes git worktree/branch from disk)
///
/// This is the "true delete" that removes the worktree from disk.
/// Only works on archived worktrees to prevent accidental deletion.
#[tauri::command]
pub async fn permanently_delete_worktree(
    app: AppHandle,
    worktree_id: String,
) -> Result<(), String> {
    log::trace!("Permanently deleting archived worktree: {worktree_id}");

    let data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?
        .clone();

    // Verify it's archived
    if worktree.archived_at.is_none() {
        return Err(
            "Only archived worktrees can be permanently deleted. Archive it first.".to_string(),
        );
    }

    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?
        .clone();

    // Remove from storage SYNCHRONOUSLY to avoid race conditions with other operations
    // (e.g., archive/unarchive could be overwritten if we save in background thread)
    let mut data = load_projects_data(&app)?;
    data.remove_worktree(&worktree_id);
    save_projects_data(&app, &data)?;
    log::trace!("Worktree removed from storage: {worktree_id}");

    // Clone values for background thread
    let app_clone = app.clone();
    let worktree_id_clone = worktree_id.clone();
    let project_id_clone = worktree.project_id.clone();
    let project_path = project.path.clone();
    let worktree_path = worktree.path.clone();
    let worktree_branch = worktree.branch.clone();
    let worktree_name = worktree.name.clone();
    let is_base_session = worktree.session_type == SessionType::Base;

    // Spawn background thread for git operations and cleanup only
    // Storage is already updated, so git failures won't corrupt other data
    thread::spawn(move || {
        // Only remove git worktree/branch for non-base sessions
        if !is_base_session {
            log::trace!("Background: Removing git worktree at {worktree_path}");

            // Remove the git worktree (ignore errors if already gone)
            if let Err(e) = git::remove_worktree(&project_path, &worktree_path) {
                log::warn!("Background: Failed to remove worktree (may already be deleted): {e}");
            }

            log::trace!("Background: Deleting branch {worktree_branch}");

            // Delete the branch (ignore errors if already gone)
            if let Err(e) = git::delete_branch(&project_path, &worktree_branch) {
                log::warn!("Background: Failed to delete branch (may already be deleted): {e}");
            }
        }

        // Delete the sessions file for this worktree
        if let Ok(app_data_dir) = app_clone.path().app_data_dir() {
            let sessions_file = app_data_dir
                .join("sessions")
                .join(format!("{worktree_id_clone}.json"));
            if sessions_file.exists() {
                if let Err(e) = std::fs::remove_file(&sessions_file) {
                    log::warn!("Failed to delete sessions file: {e}");
                } else {
                    log::trace!("Deleted sessions file for worktree: {worktree_id_clone}");
                }
            }
        }

        // Emit success event
        log::trace!("Background: Worktree permanently deleted: {worktree_name}");
        let event = WorktreePermanentlyDeletedEvent {
            id: worktree_id_clone,
            project_id: project_id_clone,
        };
        if let Err(e) = app_clone.emit_all("worktree:permanently_deleted", &event) {
            log::error!("Failed to emit worktree:permanently_deleted event: {e}");
        }
    });

    log::trace!(
        "Permanent deletion started in background for worktree: {}",
        worktree.name
    );
    Ok(())
}

/// Open a project's worktrees folder in the system file explorer (~/jean/<project-name>)
#[tauri::command]
pub async fn open_project_worktrees_folder(project_name: String) -> Result<(), String> {
    log::trace!("Opening project worktrees folder: {project_name}");

    let worktrees_dir = get_project_worktrees_dir(&project_name)?;
    let path_str = worktrees_dir
        .to_str()
        .ok_or_else(|| "Invalid worktrees directory path".to_string())?
        .to_string();

    open_worktree_in_finder(path_str).await
}

/// Open a worktree path in the system file explorer
#[tauri::command]
pub async fn open_worktree_in_finder(worktree_path: String) -> Result<(), String> {
    log::trace!("Opening worktree in file explorer: {worktree_path}");

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&worktree_path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&worktree_path)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&worktree_path)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        log::warn!("File explorer not supported on this platform");
        return Err("File explorer not supported on this platform".to_string());
    }

    Ok(())
}

/// Format a spawn error with a user-friendly message when the executable is not found
fn format_open_error(app_name: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!("'{app_name}' not found. Make sure it is installed and available in your PATH.")
    } else {
        format!("Failed to open {app_name}: {error}")
    }
}

/// Open a worktree path in the configured terminal app
#[tauri::command]
pub async fn open_worktree_in_terminal(
    worktree_path: String,
    terminal: Option<String>,
) -> Result<(), String> {
    let terminal_app = terminal.unwrap_or_else(|| "terminal".to_string());
    log::trace!("Opening worktree in {terminal_app}: {worktree_path}");

    #[cfg(target_os = "macos")]
    {
        let escaped_path = worktree_path.replace("'", "'\\''");

        let script = match terminal_app.as_str() {
            "warp" => {
                // Warp uses a different AppleScript approach
                format!(
                    r#"tell application "Warp"
                        activate
                        tell application "System Events"
                            keystroke "t" using command down
                            delay 0.3
                            keystroke "cd '{}' && clear"
                            keystroke return
                        end tell
                    end tell"#,
                    escaped_path
                )
            }
            "ghostty" => {
                // Opening a directory path with Ghostty creates a new tab
                // in an existing instance with that directory as the working directory
                let output = std::process::Command::new("open")
                    .args(["-a", "Ghostty", &worktree_path])
                    .spawn();

                match output {
                    Ok(_) => return Ok(()),
                    Err(e) => return Err(format_open_error("Ghostty", &e)),
                }
            }
            _ => {
                // Default to Terminal.app
                format!(
                    r#"tell application "Terminal"
                        activate
                        do script "cd '{}'"
                    end tell"#,
                    escaped_path
                )
            }
        };

        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format_open_error(&terminal_app, &e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common Linux terminal emulators in order of preference
        // Use owned Strings to avoid borrowing temporaries.
        let terminals: Vec<(&str, Vec<String>)> = vec![
            (
                "gnome-terminal",
                vec!["--working-directory".into(), worktree_path.clone()],
            ),
            ("konsole", vec!["--workdir".into(), worktree_path.clone()]),
            (
                "alacritty",
                vec!["--working-directory".into(), worktree_path.clone()],
            ),
            ("kitty", vec!["--directory".into(), worktree_path.clone()]),
            (
                "xterm",
                vec![
                    "-e".into(),
                    "bash".into(),
                    "-c".into(),
                    format!("cd '{}'; exec bash", worktree_path),
                ],
            ),
        ];

        let mut opened = false;
        for (term, args) in terminals {
            if crate::platform::executable_exists(term) {
                match std::process::Command::new(term).args(args).spawn() {
                    Ok(_) => {
                        log::trace!("Opened terminal with {term}");
                        opened = true;
                        break;
                    }
                    Err(e) => {
                        log::trace!("Failed to open {term}: {e}");
                    }
                }
            }
        }

        if !opened {
            return Err("No supported terminal emulator found. Install gnome-terminal, konsole, alacritty, kitty, or xterm.".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        match terminal_app.as_str() {
            "powershell" => {
                std::process::Command::new("powershell")
                    .args([
                        "-NoExit",
                        "-Command",
                        &format!("Set-Location '{worktree_path}'"),
                    ])
                    .spawn()
                    .map_err(|e| format_open_error("PowerShell", &e))?;
            }
            "cmd" => {
                std::process::Command::new("cmd")
                    .args(["/k", &format!("cd /d \"{worktree_path}\"")])
                    .spawn()
                    .map_err(|e| format_open_error("CMD", &e))?;
            }
            _ => {
                // Default: Windows Terminal (wt.exe) — opens new tab in existing window
                let result = std::process::Command::new("wt")
                    .args(["-w", "0", "nt", "-d", &worktree_path])
                    .spawn();

                match result {
                    Ok(_) => {}
                    Err(_) => {
                        // Fallback to PowerShell if wt.exe not available
                        std::process::Command::new("powershell")
                            .args([
                                "-NoExit",
                                "-Command",
                                &format!("Set-Location '{worktree_path}'"),
                            ])
                            .spawn()
                            .map_err(|e| format_open_error("PowerShell", &e))?;
                    }
                }
            }
        }
        log::trace!("Opened terminal in {worktree_path}");
    }

    Ok(())
}

/// Open a worktree path in the configured editor app (macOS)
#[tauri::command]
pub async fn open_worktree_in_editor(
    worktree_path: String,
    editor: Option<String>,
) -> Result<(), String> {
    let editor_app = editor.unwrap_or_else(|| "zed".to_string());
    log::trace!("Opening worktree in {editor_app}: {worktree_path}");

    // If opening jean.json and it doesn't exist, create template
    if worktree_path.ends_with("jean.json") {
        let path = std::path::Path::new(&worktree_path);
        if !path.exists() {
            let template = r#"{
  "scripts": {
    "setup": null,
    "run": null
  }
}
"#;
            if let Err(e) = std::fs::write(path, template) {
                log::warn!("Failed to create jean.json template: {e}");
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let result = match editor_app.as_str() {
            "zed" => match std::process::Command::new("zed")
                .arg(&worktree_path)
                .spawn()
            {
                Ok(child) => Ok(child),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // zed CLI not installed, fall back to macOS open
                    std::process::Command::new("open")
                        .args(["-a", "Zed", &worktree_path])
                        .spawn()
                }
                Err(e) => Err(e),
            },
            "cursor" => {
                // Cursor uses the same CLI pattern as VS Code
                std::process::Command::new("cursor")
                    .arg(&worktree_path)
                    .spawn()
            }
            "xcode" => {
                // Use xed (Xcode Editor) to open in Xcode
                std::process::Command::new("xed")
                    .arg(&worktree_path)
                    .spawn()
            }
            _ => {
                // Default to VS Code
                std::process::Command::new("code")
                    .arg(&worktree_path)
                    .spawn()
            }
        };

        match result {
            Ok(_) => {
                log::trace!("Successfully opened {editor_app}");
            }
            Err(e) => {
                return Err(format_open_error(&editor_app, &e));
            }
        }
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        // VS Code and Cursor CLI work the same on all platforms
        let result = match editor_app.as_str() {
            "zed" => std::process::Command::new("zed")
                .arg(&worktree_path)
                .spawn(),
            "cursor" => std::process::Command::new("cursor")
                .arg(&worktree_path)
                .spawn(),
            "xcode" => {
                return Err("Xcode is only available on macOS".to_string());
            }
            _ => {
                // Default to VS Code
                std::process::Command::new("code")
                    .arg(&worktree_path)
                    .spawn()
            }
        };

        match result {
            Ok(_) => {
                log::trace!("Successfully opened {editor_app}");
            }
            Err(e) => {
                return Err(format_open_error(&editor_app, &e));
            }
        }
    }

    Ok(())
}

/// Get all git remotes for a repository
#[tauri::command]
pub async fn get_git_remotes(repo_path: String) -> Result<Vec<git::GitRemote>, String> {
    log::trace!("Getting git remotes for: {repo_path}");
    git::get_git_remotes(&repo_path)
}

/// Get all GitHub remotes for a repository
#[tauri::command]
pub async fn get_github_remotes(repo_path: String) -> Result<Vec<git::GitHubRemote>, String> {
    log::trace!("Getting GitHub remotes for: {repo_path}");
    git::get_github_remotes(&repo_path)
}

/// Get the GitHub URL for a branch (for frontend to open)
#[tauri::command]
pub async fn get_github_branch_url(repo_path: String, branch: String) -> Result<String, String> {
    log::trace!("Getting GitHub branch URL: {branch} in {repo_path}");
    let github_url = git::get_github_url(&repo_path)?;
    Ok(format!("{github_url}/tree/{branch}"))
}

/// Get the GitHub URL for a repository (for frontend to open)
#[tauri::command]
pub async fn get_github_repo_url(repo_path: String) -> Result<String, String> {
    log::trace!("Getting GitHub repo URL for: {repo_path}");
    git::get_github_url(&repo_path)
}

/// Open a branch on GitHub in the browser (native only)
#[tauri::command]
pub async fn open_branch_on_github(repo_path: String, branch: String) -> Result<(), String> {
    log::trace!("Opening branch on GitHub: {branch} in {repo_path}");

    let github_url = git::get_github_url(&repo_path)?;
    let url = format!("{github_url}/tree/{branch}");

    log::trace!("Opening GitHub branch URL: {url}");

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    Ok(())
}

/// Open the project's GitHub page in the browser
#[tauri::command]
pub async fn open_project_on_github(app: AppHandle, project_id: String) -> Result<(), String> {
    log::trace!("Opening project on GitHub: {project_id}");

    let data = load_projects_data(&app)?;
    let project = data
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    let github_url = git::get_github_url(&project.path)?;

    log::trace!("Opening GitHub URL: {github_url}");

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&github_url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&github_url)
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &github_url])
            .spawn()
            .map_err(|e| format!("Failed to open browser: {e}"))?;
    }

    Ok(())
}

/// Rename a worktree (display name only, doesn't affect git branch)
#[tauri::command]
pub async fn rename_worktree(
    app: AppHandle,
    worktree_id: String,
    new_name: String,
) -> Result<Worktree, String> {
    log::trace!("Renaming worktree: {worktree_id} to {new_name}");

    let mut data = load_projects_data(&app)?;

    // Find the worktree first to check session type
    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    let project_id = worktree.project_id.clone();

    // Display name only - just trim whitespace, no branch sanitization needed
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    log::trace!("Worktree display name: {new_name}");

    // Check if name already exists for this project (excluding current worktree)
    let name_exists = data
        .worktrees
        .iter()
        .any(|w| w.project_id == project_id && w.name == new_name && w.id != worktree_id);

    if name_exists {
        return Err(format!(
            "A worktree named '{new_name}' already exists in this project"
        ));
    }

    // Update the worktree name
    let worktree = data
        .find_worktree_mut(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    worktree.name = new_name.clone();
    let updated_worktree = worktree.clone();

    save_projects_data(&app, &data)?;

    log::trace!("Successfully renamed worktree to: {new_name}");
    Ok(updated_worktree)
}

/// Commit changes in a worktree
#[tauri::command]
pub async fn commit_changes(
    app: AppHandle,
    worktree_id: String,
    message: String,
    stage_all: Option<bool>,
) -> Result<String, String> {
    log::trace!("Committing changes in worktree: {worktree_id}");

    let data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    let result = git::commit_changes(&worktree.path, &message, stage_all.unwrap_or(false))?;

    log::trace!(
        "Successfully committed changes in worktree: {} ({})",
        worktree.name,
        result
    );
    Ok(result)
}

/// Open a pull request for a worktree using the GitHub CLI
#[tauri::command]
pub async fn open_pull_request(
    app: AppHandle,
    worktree_id: String,
    title: Option<String>,
    body: Option<String>,
    draft: Option<bool>,
) -> Result<String, String> {
    log::trace!("Opening pull request for worktree: {worktree_id}");

    let data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    // Use the worktree path for the PR creation
    let gh = resolve_gh_binary(&app);
    let result = git::open_pull_request(
        &worktree.path,
        title.as_deref(),
        body.as_deref(),
        draft.unwrap_or(false),
        &gh,
    )?;

    log::trace!(
        "Successfully opened pull request for worktree: {}",
        worktree.name
    );
    Ok(result)
}

/// Response structure for file listing
#[derive(Debug, Clone, Serialize)]
pub struct WorktreeFile {
    /// Relative path from worktree root (e.g., "src/components/Button.tsx")
    pub relative_path: String,
    /// File extension (e.g., "tsx", "rs") or empty for no extension
    pub extension: String,
}

/// List files in a worktree, respecting .gitignore
/// Returns files sorted alphabetically, limited to prevent performance issues
#[tauri::command]
pub async fn list_worktree_files(
    worktree_path: String,
    max_files: Option<usize>,
) -> Result<Vec<WorktreeFile>, String> {
    log::trace!("Listing files in worktree: {worktree_path}");

    let max = max_files.unwrap_or(5000);
    let mut files = Vec::new();

    // Use ignore crate's WalkBuilder which respects .gitignore by default
    let walker = WalkBuilder::new(&worktree_path)
        .hidden(false) // Include hidden files (user may want .env.example etc)
        .git_ignore(true) // Respect .gitignore
        .git_global(true) // Respect global gitignore
        .git_exclude(true) // Respect .git/info/exclude
        .require_git(false) // Work even if not a git repo
        .build();

    let worktree_path_ref = Path::new(&worktree_path);

    for entry in walker {
        if files.len() >= max {
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("Failed to read entry: {e}");
                continue;
            }
        };

        let path = entry.path();

        // Skip the root directory itself
        if path == worktree_path_ref {
            continue;
        }

        // Skip .git directory and its contents
        if path.components().any(|c| c.as_os_str() == ".git") {
            continue;
        }

        // Skip directories - only include files
        if path.is_dir() {
            continue;
        }

        // Get relative path
        let relative = match path.strip_prefix(worktree_path_ref) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let relative_str = relative.to_string_lossy().to_string();

        // Skip empty paths
        if relative_str.is_empty() {
            continue;
        }

        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();

        files.push(WorktreeFile {
            relative_path: relative_str,
            extension,
        });
    }

    // Sort alphabetically for consistent ordering
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    log::trace!("Found {} files in worktree", files.len());
    Ok(files)
}

/// Get available branches for a project (prefers remote branches if available)
///
/// This command fetches from origin first to get the latest branches,
/// then returns remote branches if available, otherwise local branches.
#[tauri::command]
pub async fn get_project_branches(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<String>, String> {
    log::trace!("Getting branches for project: {project_id}");

    let data = load_projects_data(&app)?;
    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    // Fetch from origin to get latest branches (best effort)
    let _ = git::fetch_origin(&project.path);

    // Try to get remote branches first
    let remote_branches = git::get_remote_branches(&project.path)?;

    if !remote_branches.is_empty() {
        log::trace!(
            "Found {} remote branches for project {}",
            remote_branches.len(),
            project.name
        );
        let mut branches = remote_branches;
        branches.sort();
        branches.dedup();
        return Ok(branches);
    }

    // Fall back to local branches
    let local_branches = git::get_branches(&project.path)?;
    log::trace!(
        "Found {} local branches for project {} (no remote)",
        local_branches.len(),
        project.name
    );

    let mut branches = local_branches;
    branches.sort();
    Ok(branches)
}

/// Update project settings
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_project_settings(
    app: AppHandle,
    project_id: String,
    default_branch: Option<String>,
    enabled_mcp_servers: Option<Vec<String>>,
    known_mcp_servers: Option<Vec<String>>,
    custom_system_prompt: Option<String>,
    default_provider: Option<Option<String>>,
    default_backend: Option<Option<String>>,
) -> Result<Project, String> {
    log::trace!("Updating settings for project: {project_id}");

    let mut data = load_projects_data(&app)?;

    let project = data
        .find_project_mut(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    if let Some(branch) = default_branch {
        log::trace!(
            "Updating default branch from '{}' to '{}'",
            project.default_branch,
            branch
        );
        project.default_branch = branch;
    }

    if let Some(servers) = enabled_mcp_servers {
        log::trace!("Updating enabled MCP servers: {servers:?}");
        project.enabled_mcp_servers = Some(servers);
    }

    if let Some(servers) = known_mcp_servers {
        log::trace!("Updating known MCP servers: {servers:?}");
        project.known_mcp_servers = servers;
    }

    if let Some(prompt) = custom_system_prompt {
        let prompt = prompt.trim().to_string();
        log::trace!("Updating custom system prompt ({} chars)", prompt.len());
        project.custom_system_prompt = if prompt.is_empty() {
            None
        } else {
            Some(prompt)
        };
    }

    if let Some(provider) = default_provider {
        log::trace!("Updating default provider: {provider:?}");
        project.default_provider = provider.filter(|p| p != "__none__");
    }

    if let Some(backend) = default_backend {
        log::trace!("Updating default backend: {backend:?}");
        project.default_backend = backend.filter(|b| b != "__none__");
    }

    let updated_project = project.clone();
    save_projects_data(&app, &data)?;

    log::trace!("Successfully updated project settings");
    Ok(updated_project)
}

/// Rebase a worktree's branch onto the base branch
///
/// This command:
/// 1. Commits any uncommitted changes (if commit_message provided)
/// 2. Fetches from origin
/// 3. Rebases onto origin/{base_branch}
/// 4. Force pushes with lease
#[tauri::command]
pub async fn rebase_worktree(
    app: AppHandle,
    worktree_id: String,
    commit_message: Option<String>,
) -> Result<String, String> {
    log::trace!("Rebasing worktree: {worktree_id}");

    let data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?;

    let result = git::rebase_onto_base(
        &worktree.path,
        &project.default_branch,
        commit_message.as_deref(),
    )?;

    log::trace!("Successfully rebased worktree: {}", worktree.name);
    Ok(result)
}

/// Check if a worktree has uncommitted changes
#[tauri::command]
pub async fn has_uncommitted_changes(app: AppHandle, worktree_id: String) -> Result<bool, String> {
    log::trace!("Checking uncommitted changes for worktree: {worktree_id}");

    let data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    Ok(git::has_uncommitted_changes(&worktree.path))
}

/// Generate a PR prompt with dynamic context for the AI assistant
///
/// Gathers git state (uncommitted changes, current branch, upstream status)
/// and includes the PR template if available.
#[tauri::command]
pub async fn get_pr_prompt(app: AppHandle, worktree_path: String) -> Result<String, String> {
    log::trace!("Generating PR prompt for worktree: {worktree_path}");

    // Load projects data to find the target branch
    let data = load_projects_data(&app)?;

    // Find the worktree by path
    let worktree = data
        .worktrees
        .iter()
        .find(|w| w.path == worktree_path)
        .ok_or_else(|| format!("Worktree not found: {worktree_path}"))?;

    // Find the project to get default_branch
    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?;

    let target_branch = &project.default_branch;
    let context = git::generate_pr_context(&worktree_path, target_branch)?;

    let mut prompt = format!(
        r#"The user likes the state of the code and wants to open a PR.

## Context
- Worktree ID: {}
- Uncommitted changes: {}
- Current branch: {}
- Target branch: origin/{}
- Upstream: {}

## Instructions

Follow these **exact steps** in order. Do NOT ask any questions - just execute each step:

1. If there are uncommitted changes, stage ALL changes with `git add -A` and commit with a proper Conventional Commits message
2. Push the branch to remote (use `git push -u origin {}` if no upstream exists, otherwise `git push`)
3. Review the diff with `git diff origin/{}...HEAD`
4. Create the PR with `gh pr create --base {}` - keep the title under 80 characters and the description concise
5. After the PR is created, output the PR info in this EXACT format on its own line:
   `PR_CREATED: #<number> <url>`
   For example: `PR_CREATED: #123 https://github.com/owner/repo/pull/123`

If any step fails, ask the user for help."#,
        worktree.id,
        context.uncommitted_count,
        context.current_branch,
        context.target_branch,
        if context.has_upstream {
            "exists"
        } else {
            "none"
        },
        context.current_branch,
        context.target_branch,
        context.target_branch,
    );

    if let Some(template) = context.pr_template {
        prompt.push_str(&format!(
            r#"

## PR Description Template

This workspace has a PR template, which is provided below. Use it for writing the PR description, filling it in based on the changes made.

```markdown
{}
```"#,
            template
        ));
    }

    log::trace!("Generated PR prompt for branch: {}", context.current_branch);
    Ok(prompt)
}

/// Response from creating a review prompt
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReviewPromptResponse {
    /// The full review prompt to send to Claude (includes instructions + diff + commits)
    pub prompt: String,
}

/// Generate a review prompt with git diff and commit history
///
/// Returns the full prompt with instructions, diff, and commits inline.
/// No file is saved - the content is returned directly for sending to Claude.
#[tauri::command]
pub async fn get_review_prompt(
    app: AppHandle,
    worktree_path: String,
) -> Result<ReviewPromptResponse, String> {
    log::trace!("Generating review prompt for worktree: {worktree_path}");

    // Load projects data to find the target branch
    let data = load_projects_data(&app)?;

    // Find the worktree by path
    let worktree = data
        .worktrees
        .iter()
        .find(|w| w.path == worktree_path)
        .ok_or_else(|| format!("Worktree not found: {worktree_path}"))?;

    // Find the project to get default_branch
    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?;

    let target_branch = &project.default_branch;
    let current_branch = git::get_current_branch(&worktree_path)?;

    // Get the full git diff (origin/target...HEAD)
    let diff_output = silent_command("git")
        .args(["diff", &format!("origin/{target_branch}...HEAD")])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run git diff: {e}"))?;

    let full_diff = if diff_output.status.success() {
        String::from_utf8_lossy(&diff_output.stdout).to_string()
    } else {
        let stderr = String::from_utf8_lossy(&diff_output.stderr);
        return Err(format!("Git diff failed: {stderr}"));
    };

    // Get the commit history (origin/target..HEAD)
    let log_output = silent_command("git")
        .args([
            "log",
            &format!("origin/{target_branch}..HEAD"),
            "--pretty=format:%h %s",
        ])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run git log: {e}"))?;

    let commit_history = if log_output.status.success() {
        String::from_utf8_lossy(&log_output.stdout).to_string()
    } else {
        let stderr = String::from_utf8_lossy(&log_output.stderr);
        return Err(format!("Git log failed: {stderr}"));
    };

    // Get uncommitted changes (staged + unstaged for tracked files)
    let uncommitted_output = silent_command("git")
        .args(["diff", "HEAD"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run git diff HEAD: {e}"))?;

    let uncommitted_diff = if uncommitted_output.status.success() {
        String::from_utf8_lossy(&uncommitted_output.stdout).to_string()
    } else {
        String::new() // Not an error if no uncommitted changes
    };

    // Get list of untracked files
    let untracked_output = silent_command("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to list untracked files: {e}"))?;

    let untracked_files: Vec<String> = if untracked_output.status.success() {
        String::from_utf8_lossy(&untracked_output.stdout)
            .lines()
            .map(|s| s.to_string())
            .collect()
    } else {
        Vec::new()
    };

    // Read content of untracked files (skip binary and large files)
    let mut untracked_content = String::new();
    for file in &untracked_files {
        let file_path = std::path::Path::new(&worktree_path).join(file);
        if let Ok(metadata) = std::fs::metadata(&file_path) {
            // Skip files larger than 100KB
            if metadata.len() > 100_000 {
                untracked_content.push_str(&format!(
                    "\n--- New file: {file} (skipped: file too large)\n"
                ));
                continue;
            }
        }
        if let Ok(content) = std::fs::read_to_string(&file_path) {
            untracked_content.push_str(&format!("\n--- New file: {file}\n"));
            untracked_content.push_str(&content);
            untracked_content.push('\n');
        } else {
            // Binary file or read error
            untracked_content.push_str(&format!("\n--- New file: {file} (binary or unreadable)\n"));
        }
    }

    // Check if there's anything to review
    if full_diff.trim().is_empty()
        && commit_history.trim().is_empty()
        && uncommitted_diff.trim().is_empty()
        && untracked_content.trim().is_empty()
    {
        return Err("No changes to review. The branch is identical to the target branch and there are no uncommitted changes.".to_string());
    }

    // Build uncommitted section if there are uncommitted changes
    let has_uncommitted =
        !uncommitted_diff.trim().is_empty() || !untracked_content.trim().is_empty();
    let uncommitted_section = if has_uncommitted {
        let mut section = String::from("\n## Uncommitted Changes\n\n");

        if !uncommitted_diff.trim().is_empty() {
            section.push_str("### Modified Files\n\n```diff\n");
            section.push_str(&uncommitted_diff);
            section.push_str("\n```\n");
        }

        if !untracked_content.trim().is_empty() {
            section.push_str("\n### New Untracked Files\n\n```\n");
            section.push_str(&untracked_content);
            section.push_str("\n```\n");
        }

        section
    } else {
        String::new()
    };

    // Build commit history section only if there are commits
    let commit_section = if !commit_history.trim().is_empty() {
        format!("## Commit History\n\n{commit_history}\n")
    } else {
        String::new()
    };

    // Build full diff section only if there's a diff
    let diff_section = if !full_diff.trim().is_empty() {
        format!("## Full Diff\n\n```diff\n{full_diff}\n```\n")
    } else {
        String::new()
    };

    // Create the review prompt content (includes instructions + diff + commits)
    let prompt = format!(
        r#"# Code Review: {current_branch}

Target branch: origin/{target_branch}

## Code Review Instructions

You are performing a code review on the changes in the current branch.

CRITICAL: EVERYTHING YOU NEED IS ALREADY PROVIDED. The complete git diff, full commit history, and any uncommitted changes are included below.

DO NOT run git diff, git log, git status, or ANY other git commands. All the information you need to perform this review is already here.

When reviewing the diff:

- Security & supply-chain risks:
  - Malicious or obfuscated code (eval, encoded strings, hidden network calls, data exfiltration)
  - Suspicious dependency additions or version changes (typosquatting, hijacked packages)
  - Hardcoded secrets, tokens, API keys, or credentials
  - Backdoors, reverse shells, or unauthorized remote access
  - Unsafe deserialization, command injection, SQL injection, XSS
  - Weakened auth/permissions (removed checks, broadened access, disabled validation)
  - Suspicious file system or environment variable access
- Focus on logic and correctness - Check for bugs, edge cases, and potential issues.
- Consider readability - Is the code clear and maintainable? Does it follow best practices in this repository?
- Evaluate performance - Are there obvious performance concerns or optimizations that could be made?
- Assess test coverage - Does the repository have testing patterns? If so, are there adequate tests for these changes?
- Ask clarifying questions - Ask the user for clarification if you are unsure about the changes or need more context.
- Don't be overly pedantic - Nitpicks are fine, but only if they are relevant issues within reason.

## Output Format

Start with a brief summary (2-3 sentences) of the overall code quality.

Then output each finding in the following EXACT machine-parseable format:

<<<FINDING>>>
severity: error | warning | info
file: <relative file path>
line: <line number or range, e.g., "42" or "42-45">
title: <short title, max 80 chars>
description: <detailed explanation of the issue>
code: <the problematic code snippet>
suggestions:
- Option label: suggested fix or code
- Another option: alternative approach
<<<END_FINDING>>>

IMPORTANT: The suggestions field supports multiple options. If there are multiple valid ways to fix an issue, list them all as separate options with descriptive labels. The user will be able to choose which approach to implement. For simple fixes with only one obvious solution, just provide a single option.

Example with multiple suggestions:
suggestions:
- Add null check: if (value != null) {{ doSomething(value) }}
- Use optional chaining: value?.doSomething()
- Provide default: const safeValue = value ?? defaultValue

Example with single suggestion:
suggestions:
- Fix typo: rename 'recieve' to 'receive'

Severity levels:
- `error`: Bugs, security issues, logic errors that will cause problems
- `warning`: Code smells, potential issues, suboptimal patterns
- `info`: Style suggestions, minor improvements, nitpicks

If no issues are found, output:

<<<NO_FINDINGS>>>
The code meets best practices and no issues were identified.
<<<END_NO_FINDINGS>>>

---
{uncommitted_section}{commit_section}{diff_section}"#
    );

    log::trace!(
        "Generated review prompt for branch {} (diff: {} bytes, uncommitted: {} bytes, untracked: {} files, commits: {} lines)",
        current_branch,
        full_diff.len(),
        uncommitted_diff.len(),
        untracked_files.len(),
        commit_history.lines().count()
    );

    Ok(ReviewPromptResponse { prompt })
}

/// Save PR information to a worktree
///
/// Called after a PR is created to store the PR number and URL for display in the UI.
#[tauri::command]
pub async fn save_worktree_pr(
    app: AppHandle,
    worktree_id: String,
    pr_number: u32,
    pr_url: String,
) -> Result<(), String> {
    log::trace!("Saving PR info for worktree {worktree_id}: #{pr_number}");

    let mut data = load_projects_data(&app)?;

    let worktree = data
        .worktrees
        .iter_mut()
        .find(|w| w.id == worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    worktree.pr_number = Some(pr_number);
    worktree.pr_url = Some(pr_url);

    save_projects_data(&app, &data)?;

    log::trace!("Successfully saved PR #{pr_number} for worktree {worktree_id}");
    Ok(())
}

/// Clear PR information from a worktree
///
/// Called when a PR is closed or merged and the user wants to create a new one.
#[tauri::command]
pub async fn clear_worktree_pr(app: AppHandle, worktree_id: String) -> Result<(), String> {
    log::trace!("Clearing PR info for worktree {worktree_id}");

    let mut data = load_projects_data(&app)?;

    let worktree = data
        .worktrees
        .iter_mut()
        .find(|w| w.id == worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    worktree.pr_number = None;
    worktree.pr_url = None;

    save_projects_data(&app, &data)?;

    log::trace!("Successfully cleared PR info for worktree {worktree_id}");
    Ok(())
}

/// Update cached status for a worktree
///
/// Called by the background task manager after polling git/PR status.
/// This persists the status so it's available immediately on next app launch.
/// Only updates fields that are provided (Some), preserves existing values for None.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_worktree_cached_status(
    app: AppHandle,
    worktree_id: String,
    branch: Option<String>,
    pr_status: Option<String>,
    check_status: Option<String>,
    behind_count: Option<u32>,
    ahead_count: Option<u32>,
    uncommitted_added: Option<u32>,
    uncommitted_removed: Option<u32>,
    branch_diff_added: Option<u32>,
    branch_diff_removed: Option<u32>,
    base_branch_ahead_count: Option<u32>,
    base_branch_behind_count: Option<u32>,
    worktree_ahead_count: Option<u32>,
    unpushed_count: Option<u32>,
) -> Result<(), String> {
    log::trace!("Updating cached status for worktree {worktree_id}");

    let mut data = load_projects_data(&app)?;

    let worktree = data
        .worktrees
        .iter_mut()
        .find(|w| w.id == worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    // Only update fields that are provided, preserve existing values for None
    if let Some(ref b) = branch {
        worktree.branch = b.clone();
        // For base sessions, also update the display name to match the branch
        if worktree.session_type == crate::projects::types::SessionType::Base {
            worktree.name = b.clone();
        }
    }
    if pr_status.is_some() {
        worktree.cached_pr_status = pr_status;
    }
    if check_status.is_some() {
        worktree.cached_check_status = check_status;
    }
    if behind_count.is_some() {
        worktree.cached_behind_count = behind_count;
    }
    if ahead_count.is_some() {
        worktree.cached_ahead_count = ahead_count;
    }
    if uncommitted_added.is_some() {
        worktree.cached_uncommitted_added = uncommitted_added;
    }
    if uncommitted_removed.is_some() {
        worktree.cached_uncommitted_removed = uncommitted_removed;
    }
    if branch_diff_added.is_some() {
        worktree.cached_branch_diff_added = branch_diff_added;
    }
    if branch_diff_removed.is_some() {
        worktree.cached_branch_diff_removed = branch_diff_removed;
    }
    if base_branch_ahead_count.is_some() {
        worktree.cached_base_branch_ahead_count = base_branch_ahead_count;
    }
    if base_branch_behind_count.is_some() {
        worktree.cached_base_branch_behind_count = base_branch_behind_count;
    }
    if worktree_ahead_count.is_some() {
        worktree.cached_worktree_ahead_count = worktree_ahead_count;
    }
    if unpushed_count.is_some() {
        worktree.cached_unpushed_count = unpushed_count;
    }
    worktree.cached_status_at = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    );

    save_projects_data(&app, &data)?;

    Ok(())
}

/// Get detailed git diff for a worktree
///
/// `diff_type` can be:
/// - "uncommitted": Working directory changes vs HEAD
/// - "branch": All changes in current branch vs base branch
#[tauri::command]
pub async fn get_git_diff(
    worktree_path: String,
    diff_type: String,
    base_branch: Option<String>,
) -> Result<super::git_status::GitDiff, String> {
    log::trace!("Getting {diff_type} diff for {worktree_path}");

    super::git_status::get_git_diff(&worktree_path, &diff_type, base_branch.as_deref())
}

/// Reorder projects in the sidebar
#[tauri::command]
pub async fn reorder_projects(app: AppHandle, project_ids: Vec<String>) -> Result<(), String> {
    log::trace!("Reordering projects: {:?}", project_ids);

    let mut data = load_projects_data(&app)?;

    // Update order based on position in the provided array
    for (index, project_id) in project_ids.iter().enumerate() {
        if let Some(project) = data.projects.iter_mut().find(|p| p.id == *project_id) {
            project.order = index as u32;
        }
    }

    // Sort projects by new order
    data.projects.sort_by_key(|p| p.order);

    save_projects_data(&app, &data)?;
    log::trace!("Projects reordered successfully");
    Ok(())
}

/// Reorder worktrees within a project
/// Note: Base sessions cannot be reordered - they always stay first
#[tauri::command]
pub async fn reorder_worktrees(
    app: AppHandle,
    project_id: String,
    worktree_ids: Vec<String>,
) -> Result<(), String> {
    log::trace!(
        "Reordering worktrees for project {}: {:?}",
        project_id,
        worktree_ids
    );

    let mut data = load_projects_data(&app)?;

    // Update order based on position in the provided array
    // Start from 1 since base sessions always have order 0
    for (index, worktree_id) in worktree_ids.iter().enumerate() {
        if let Some(worktree) = data.worktrees.iter_mut().find(|w| w.id == *worktree_id) {
            // Skip base sessions - they always stay at order 0
            if worktree.session_type != SessionType::Base {
                worktree.order = (index + 1) as u32;
            }
        }
    }

    save_projects_data(&app, &data)?;
    log::trace!(
        "Worktrees reordered successfully for project {}",
        project_id
    );
    Ok(())
}

// =============================================================================
// AI-Powered PR Creation
// =============================================================================

/// JSON schema for structured PR content generation
/// Format requirements are specified in the schema descriptions
const PR_CONTENT_SCHEMA: &str = r#"{"type":"object","properties":{"title":{"type":"string","description":"PR title under 72 chars using conventional commit format: type(scope): description. Types: feat, fix, docs, style, refactor, perf, test, chore. Example: 'feat(auth): add OAuth2 login flow'"},"body":{"type":"string","description":"PR description in markdown. Start with ## Summary containing bullet points of key changes. Add ## Breaking Changes section if any. Keep concise but informative."}},"required":["title","body"],"additionalProperties":false}"#;

/// Prompt template for PR content generation
/// Focuses on context - format requirements are in the JSON schema
const PR_CONTENT_PROMPT: &str = r#"<task>Generate a pull request title and description</task>

<context>
<source_branch>{current_branch}</source_branch>
<target_branch>{target_branch}</target_branch>
<commit_count>{commit_count}</commit_count>
</context>

<related_context>
{context}
</related_context>

<commits>
{commits}
</commits>

<diff>
{diff}
</diff>"#;

/// Structured response from PR content generation
#[derive(Debug, Deserialize, Serialize)]
pub struct PrContentResponse {
    pub title: String,
    pub body: String,
}

/// Response from creating a PR with AI-generated content
#[derive(Debug, Clone, Serialize)]
pub struct CreatePrResponse {
    pub pr_number: u32,
    pub pr_url: String,
    pub title: String,
    /// Whether this PR already existed (was linked, not newly created)
    pub existing: bool,
}

/// Extract structured output from Claude CLI stream-json response
/// Handles the StructuredOutput tool call pattern used with --json-schema
fn extract_structured_output(output: &str) -> Result<String, String> {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
            if let Some(message) = parsed.get("message") {
                if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
                    for block in content {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                            && block.get("name").and_then(|n| n.as_str())
                                == Some("StructuredOutput")
                        {
                            if let Some(input) = block.get("input") {
                                return Ok(input.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    Err("No structured output found in Claude response".to_string())
}

/// Get git diff between current branch and target branch
fn get_branch_diff(repo_path: &str, target_branch: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["diff", &format!("origin/{target_branch}...HEAD")])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get git diff: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get diff: {stderr}"));
    }

    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    // Truncate very long diffs to avoid context overflow
    if diff.len() > 50000 {
        Ok(format!(
            "{}...\n\n[Diff truncated - {} chars total]",
            &diff[..50000],
            diff.len()
        ))
    } else {
        Ok(diff)
    }
}

/// Get commit messages between current branch and target branch
fn get_branch_commits(repo_path: &str, target_branch: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["log", "--oneline", &format!("origin/{target_branch}..HEAD")])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get git log: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to get commits: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Count commits between current branch and target branch
fn count_branch_commits(repo_path: &str, target_branch: &str) -> Result<u32, String> {
    let output = silent_command("git")
        .args([
            "rev-list",
            "--count",
            &format!("origin/{target_branch}..HEAD"),
        ])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to count commits: {e}"))?;

    if !output.status.success() {
        return Ok(0);
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| "Failed to parse commit count".to_string())
}

/// Generate PR content using Claude CLI with JSON schema
#[allow(clippy::too_many_arguments)]
fn generate_pr_content(
    app: &AppHandle,
    repo_path: &str,
    current_branch: &str,
    target_branch: &str,
    custom_prompt: Option<&str>,
    model: Option<&str>,
    context: &str,
    custom_profile_name: Option<&str>,
) -> Result<PrContentResponse, String> {
    // Get diff and commits
    let diff = get_branch_diff(repo_path, target_branch)?;
    if diff.trim().is_empty() {
        return Err("No changes to create PR for".to_string());
    }

    let commits = get_branch_commits(repo_path, target_branch)?;
    let commit_count = count_branch_commits(repo_path, target_branch)?;

    // Build prompt - use custom if provided and non-empty, otherwise use default
    let prompt_template = custom_prompt
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(PR_CONTENT_PROMPT);

    let prompt = prompt_template
        .replace("{current_branch}", current_branch)
        .replace("{target_branch}", target_branch)
        .replace("{commit_count}", &commit_count.to_string())
        .replace("{context}", context)
        .replace("{commits}", &commits)
        .replace("{diff}", &diff);

    let model_str = model.unwrap_or("haiku");

    // Route to OpenCode if model is an OpenCode model
    if crate::is_opencode_model(model_str) {
        log::trace!("Generating PR content with OpenCode");
        let json_str = crate::chat::opencode::execute_one_shot_opencode(
            app,
            &prompt,
            model_str,
            Some(PR_CONTENT_SCHEMA),
            Some(std::path::Path::new(repo_path)),
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse OpenCode PR content JSON: {e}, content: {json_str}");
            format!("Failed to parse PR content: {e}")
        });
    }

    // Route to Codex CLI if model is a Codex model
    if crate::is_codex_model(model_str) {
        log::trace!("Generating PR content with Codex CLI (output-schema)");
        let json_str = crate::chat::codex::execute_one_shot_codex(
            app,
            &prompt,
            model_str,
            PR_CONTENT_SCHEMA,
            Some(std::path::Path::new(repo_path)),
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Codex PR content JSON: {e}, content: {json_str}");
            format!("Failed to parse PR content: {e}")
        });
    }

    log::trace!("Generating PR content with Claude CLI (JSON schema)");

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    let mut cmd = silent_command(&cli_path);
    crate::chat::claude::apply_custom_profile_settings(&mut cmd, custom_profile_name);
    cmd.args([
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model_str,
        "--no-session-persistence",
        "--tools",
        "",
        "--max-turns",
        "1",
        "--json-schema",
        PR_CONTENT_SCHEMA,
    ]);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

    // Write prompt to stdin
    {
        let input_message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });

        let write_result = if let Some(stdin) = child.stdin.as_mut() {
            writeln!(stdin, "{input_message}")
        } else {
            Err(std::io::Error::other("Failed to open stdin"))
        };

        if let Err(e) = write_result {
            return Err(format!("Failed to write to stdin: {e}"));
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Claude CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Claude CLI failed: stderr={}, stdout={}",
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    log::trace!("Claude CLI PR generation stdout: {stdout}");

    let json_content = extract_structured_output(&stdout)?;
    log::trace!("Extracted PR content JSON: {json_content}");

    serde_json::from_str(&json_content).map_err(|e| {
        log::error!("Failed to parse PR content JSON: {e}, content: {json_content}");
        format!("Failed to parse PR content: {e}")
    })
}

/// Parse PR number and URL from gh pr create output
fn parse_pr_output(output: &str) -> Result<(u32, String), String> {
    // gh pr create outputs the URL like: https://github.com/owner/repo/pull/123
    let url = output.trim().to_string();

    // Extract PR number from URL
    let pr_number = url
        .split('/')
        .next_back()
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(|| format!("Failed to parse PR number from: {url}"))?;

    Ok((pr_number, url))
}

/// Create a PR with AI-generated title and body
///
/// This command:
/// 1. Stages and commits any uncommitted changes (if any)
/// 2. Pushes the branch to remote
/// 3. Generates PR title and body using Claude CLI with JSON schema
/// 4. Creates the PR using gh CLI
#[tauri::command]
pub async fn create_pr_with_ai_content(
    app: AppHandle,
    worktree_path: String,
    session_id: Option<String>,
    custom_prompt: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
) -> Result<CreatePrResponse, String> {
    log::trace!("Creating PR for: {worktree_path}");

    // Load project data to get target branch
    let data = load_projects_data(&app)?;
    let worktree = data
        .worktrees
        .iter()
        .find(|w| w.path == worktree_path)
        .ok_or_else(|| format!("Worktree not found: {worktree_path}"))?;

    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?;

    let target_branch = &project.default_branch;
    let current_branch = git::get_current_branch(&worktree_path)?;

    // Check if we're on the target branch (can't create PR to same branch)
    if current_branch == *target_branch {
        return Err(format!(
            "Cannot create PR: current branch '{current_branch}' is the same as target branch"
        ));
    }

    // Stage and commit uncommitted changes if any
    let uncommitted = git::get_uncommitted_count(&worktree_path)?;
    if uncommitted > 0 {
        log::trace!("Staging and committing {uncommitted} uncommitted changes");

        // Stage all changes
        let stage_output = silent_command("git")
            .args(["add", "-A"])
            .current_dir(&worktree_path)
            .output()
            .map_err(|e| format!("Failed to stage changes: {e}"))?;

        if !stage_output.status.success() {
            let stderr = String::from_utf8_lossy(&stage_output.stderr);
            return Err(format!("Failed to stage changes: {stderr}"));
        }

        // Commit with a generic message (the PR will have the real description)
        let commit_output = silent_command("git")
            .args(["commit", "-m", "chore: prepare for PR"])
            .current_dir(&worktree_path)
            .output()
            .map_err(|e| format!("Failed to commit: {e}"))?;

        if !commit_output.status.success() {
            let stderr = String::from_utf8_lossy(&commit_output.stderr);
            // Ignore "nothing to commit" errors
            if !stderr.contains("nothing to commit") {
                return Err(format!("Failed to commit: {stderr}"));
            }
        }
    }

    // Push the branch
    log::trace!("Pushing branch to remote");
    let push_output = silent_command("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to push: {e}"))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        if !stderr.contains("Everything up-to-date") {
            log::warn!("Push warning: {stderr}");
        }
    }

    // Gather issue/PR context for this session AND worktree.
    // References may be stored under the session ID (manually loaded issues) or
    // the worktree ID (issues attached at worktree creation time), so we look up both.
    let effective_session_id = session_id.as_deref().unwrap_or("");
    let worktree_id = &worktree.id;

    let (mut issue_nums, mut pr_nums) =
        get_session_context_numbers(&app, effective_session_id).unwrap_or_default();
    let mut context_content =
        get_session_context_content(&app, effective_session_id, &project.path).unwrap_or_default();

    if worktree_id != effective_session_id {
        let (wt_issue_nums, wt_pr_nums) =
            get_session_context_numbers(&app, worktree_id).unwrap_or_default();
        for n in wt_issue_nums {
            if !issue_nums.contains(&n) {
                issue_nums.push(n);
            }
        }
        for n in wt_pr_nums {
            if !pr_nums.contains(&n) {
                pr_nums.push(n);
            }
        }
        let wt_content =
            get_session_context_content(&app, worktree_id, &project.path).unwrap_or_default();
        if !wt_content.is_empty() {
            if context_content.is_empty() {
                context_content = wt_content;
            } else {
                context_content = format!("{context_content}\n\n{wt_content}");
            }
        }
    }

    // Generate PR content using Claude CLI
    log::trace!("Generating PR content with AI");
    let mut pr_content = generate_pr_content(
        &app,
        &worktree_path,
        &current_branch,
        target_branch,
        custom_prompt.as_deref(),
        model.as_deref(),
        &context_content,
        custom_profile_name.as_deref(),
    )?;

    // Append unconditional issue/PR references to the body
    let mut refs: Vec<String> = Vec::new();
    for num in &issue_nums {
        refs.push(format!("Fixes #{num}"));
    }
    for num in &pr_nums {
        refs.push(format!("Related to #{num}"));
    }
    if !refs.is_empty() {
        pr_content.body = format!("{}\n\n---\n\n{}", pr_content.body, refs.join("\n"));
    }

    log::trace!("Generated PR title: {}", pr_content.title);

    // Create the PR using gh CLI
    log::trace!("Creating PR with gh CLI");
    let gh = resolve_gh_binary(&app);
    let output = silent_command(&gh)
        .args([
            "pr",
            "create",
            "--base",
            target_branch,
            "--title",
            &pr_content.title,
            "--body",
            &pr_content.body,
        ])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run gh pr create: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("already exists") {
            // Try to look up the existing PR and link it to the worktree
            let view_output = silent_command(&gh)
                .args(["pr", "view", "--json", "number,url,title"])
                .current_dir(&worktree_path)
                .output();

            if let Ok(view_out) = view_output {
                if view_out.status.success() {
                    if let Ok(view_json) =
                        serde_json::from_slice::<serde_json::Value>(&view_out.stdout)
                    {
                        let pr_number = view_json["number"].as_u64().unwrap_or(0) as u32;
                        let pr_url = view_json["url"].as_str().unwrap_or("").to_string();
                        let title = view_json["title"].as_str().unwrap_or("").to_string();

                        if pr_number > 0 && !pr_url.is_empty() {
                            // Save PR info to worktree
                            if let Ok(mut data) = load_projects_data(&app) {
                                if let Some(wt) =
                                    data.worktrees.iter_mut().find(|w| w.path == worktree_path)
                                {
                                    wt.pr_number = Some(pr_number);
                                    wt.pr_url = Some(pr_url.clone());
                                    let _ = save_projects_data(&app, &data);
                                }
                            }

                            return Ok(CreatePrResponse {
                                pr_number,
                                pr_url,
                                title,
                                existing: true,
                            });
                        }
                    }
                }
            }

            return Err("A pull request for this branch already exists".to_string());
        }
        return Err(format!("Failed to create PR: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (pr_number, pr_url) = parse_pr_output(&stdout)?;

    log::trace!("Successfully created PR #{pr_number}: {pr_url}");

    Ok(CreatePrResponse {
        pr_number,
        pr_url,
        title: pr_content.title,
        existing: false,
    })
}

// =============================================================================
// AI-Powered PR Update
// =============================================================================

/// Response from updating a PR with AI-generated content
#[derive(Debug, Clone, Serialize)]
pub struct UpdatePrResponse {
    pub title: String,
    pub body: String,
}

/// Generate AI content for updating a PR (does not apply changes)
///
/// Returns the generated title and body for the frontend to display/edit.
#[tauri::command]
pub async fn generate_pr_update_content(
    app: AppHandle,
    worktree_path: String,
    session_id: Option<String>,
    custom_prompt: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
) -> Result<UpdatePrResponse, String> {
    log::trace!("Generating PR update content for: {worktree_path}");

    let data = load_projects_data(&app)?;
    let worktree = data
        .worktrees
        .iter()
        .find(|w| w.path == worktree_path)
        .ok_or_else(|| format!("Worktree not found: {worktree_path}"))?;

    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?;

    let target_branch = &project.default_branch;
    let current_branch = git::get_current_branch(&worktree_path)?;

    // Gather issue/PR context for this session AND worktree (same logic as create_pr_with_ai_content)
    let effective_session_id = session_id.as_deref().unwrap_or("");
    let worktree_id = &worktree.id;

    let (mut issue_nums, mut pr_nums) =
        get_session_context_numbers(&app, effective_session_id).unwrap_or_default();
    let mut context_content =
        get_session_context_content(&app, effective_session_id, &project.path).unwrap_or_default();

    if worktree_id != effective_session_id {
        let (wt_issue_nums, wt_pr_nums) =
            get_session_context_numbers(&app, worktree_id).unwrap_or_default();
        for n in wt_issue_nums {
            if !issue_nums.contains(&n) {
                issue_nums.push(n);
            }
        }
        for n in wt_pr_nums {
            if !pr_nums.contains(&n) {
                pr_nums.push(n);
            }
        }
        let wt_content =
            get_session_context_content(&app, worktree_id, &project.path).unwrap_or_default();
        if !wt_content.is_empty() {
            if context_content.is_empty() {
                context_content = wt_content;
            } else {
                context_content = format!("{context_content}\n\n{wt_content}");
            }
        }
    }

    // Generate PR content using Claude CLI
    let mut pr_content = generate_pr_content(
        &app,
        &worktree_path,
        &current_branch,
        target_branch,
        custom_prompt.as_deref(),
        model.as_deref(),
        &context_content,
        custom_profile_name.as_deref(),
    )?;

    // Append unconditional issue/PR references to the body
    let mut refs: Vec<String> = Vec::new();
    for num in &issue_nums {
        refs.push(format!("Fixes #{num}"));
    }
    for num in &pr_nums {
        refs.push(format!("Related to #{num}"));
    }
    if !refs.is_empty() {
        pr_content.body = format!("{}\n\n---\n\n{}", pr_content.body, refs.join("\n"));
    }

    Ok(UpdatePrResponse {
        title: pr_content.title,
        body: pr_content.body,
    })
}

/// Update a PR's title and body on GitHub
#[tauri::command]
pub async fn update_pr_description(
    app: AppHandle,
    worktree_path: String,
    pr_number: u32,
    title: String,
    body: String,
) -> Result<(), String> {
    log::trace!("Updating PR #{pr_number} description");

    let gh = resolve_gh_binary(&app);
    let output = silent_command(&gh)
        .args([
            "pr",
            "edit",
            &pr_number.to_string(),
            "--title",
            &title,
            "--body",
            &body,
        ])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run gh pr edit: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to update PR: {stderr}"));
    }

    log::trace!("Successfully updated PR #{pr_number}");
    Ok(())
}

// =============================================================================
// AI-Powered Commit Creation
// =============================================================================

/// JSON schema for structured commit message generation
const COMMIT_MESSAGE_SCHEMA: &str = r#"{"type":"object","properties":{"message":{"type":"string","description":"Commit message using Conventional Commits format. First line: type(scope): description (max 72 chars). Types: feat, fix, docs, style, refactor, perf, test, chore. Followed by blank line and optional body explaining what and why."}},"required":["message"],"additionalProperties":false}"#;

/// Prompt template for commit message generation
const COMMIT_MESSAGE_PROMPT: &str = r#"<task>Generate a commit message for the following changes</task>

<git_status>
{status}
</git_status>

<staged_diff>
{diff}
</staged_diff>

<recent_commits>
{recent_commits}
</recent_commits>

<remote_info>
{remote_info}
</remote_info>"#;

/// Structured response from commit message generation
#[derive(Debug, Deserialize)]
struct CommitMessageResponse {
    message: String,
}

/// Response from creating a commit with AI-generated message
#[derive(Debug, Clone, Serialize)]
pub struct CreateCommitResponse {
    pub commit_hash: String,
    pub message: String,
    pub pushed: bool,
}

/// Get git status output
fn get_git_status(repo_path: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["status", "--short"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get git status: {e}"))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Get staged diff
fn get_staged_diff(repo_path: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["diff", "--cached"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get staged diff: {e}"))?;

    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    // Truncate very long diffs
    if diff.len() > 50000 {
        Ok(format!(
            "{}...\n\n[Diff truncated - {} chars total]",
            &diff[..50000],
            diff.len()
        ))
    } else {
        Ok(diff)
    }
}

/// Get recent commit messages for style reference
fn get_recent_commits(repo_path: &str, count: u32) -> Result<String, String> {
    let output = silent_command("git")
        .args(["log", "--oneline", &format!("-{count}")])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get recent commits: {e}"))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Get remote info
fn get_remote_info(repo_path: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["remote", "-v"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get remote info: {e}"))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Stage all changes
fn stage_all_changes(repo_path: &str) -> Result<(), String> {
    let output = silent_command("git")
        .args(["add", "-A"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to stage changes: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to stage changes: {stderr}"));
    }

    Ok(())
}

/// Create a git commit with the given message
fn create_git_commit(repo_path: &str, message: &str) -> Result<String, String> {
    let output = silent_command("git")
        .args(["commit", "-m", message])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to create commit: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to commit: {stderr}"));
    }

    // Get the commit hash
    let hash_output = silent_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to get commit hash: {e}"))?;

    Ok(String::from_utf8_lossy(&hash_output.stdout)
        .trim()
        .to_string())
}

/// Push to remote
fn push_to_remote(repo_path: &str, remote: Option<&str>) -> Result<(), String> {
    let remote = remote.unwrap_or("origin");
    let output = silent_command("git")
        .args(["push", "-u", remote, "HEAD"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to push: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to push: {stderr}"));
    }

    Ok(())
}

/// Generate commit message using Claude CLI with JSON schema
fn generate_commit_message(
    app: &AppHandle,
    prompt: &str,
    model: Option<&str>,
    custom_profile_name: Option<&str>,
    working_dir: Option<&std::path::Path>,
) -> Result<CommitMessageResponse, String> {
    let model_str = model.unwrap_or("haiku");

    // Route to OpenCode if model is an OpenCode model
    if crate::is_opencode_model(model_str) {
        log::trace!("Generating commit message with OpenCode");
        let json_str = crate::chat::opencode::execute_one_shot_opencode(
            app,
            prompt,
            model_str,
            Some(COMMIT_MESSAGE_SCHEMA),
            working_dir,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse OpenCode commit message JSON: {e}, content: {json_str}");
            format!("Failed to parse commit message: {e}")
        });
    }

    // Route to Codex CLI if model is a Codex model
    if crate::is_codex_model(model_str) {
        log::trace!("Generating commit message with Codex CLI (output-schema)");
        let json_str = crate::chat::codex::execute_one_shot_codex(
            app,
            prompt,
            model_str,
            COMMIT_MESSAGE_SCHEMA,
            working_dir,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Codex commit message JSON: {e}, content: {json_str}");
            format!("Failed to parse commit message: {e}")
        });
    }

    log::trace!("Generating commit message with Claude CLI (JSON schema)");

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    let mut cmd = silent_command(&cli_path);
    crate::chat::claude::apply_custom_profile_settings(&mut cmd, custom_profile_name);
    cmd.args([
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model_str,
        "--no-session-persistence",
        "--tools",
        "",
        "--max-turns",
        "1",
        "--json-schema",
        COMMIT_MESSAGE_SCHEMA,
    ]);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

    // Write prompt to stdin
    {
        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let input_message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });
        writeln!(stdin, "{input_message}").map_err(|e| format!("Failed to write to stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Claude CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Claude CLI failed: stderr={}, stdout={}",
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    log::trace!("Claude CLI commit generation stdout: {stdout}");

    let json_content = extract_structured_output(&stdout)?;
    log::trace!("Extracted commit message JSON: {json_content}");

    serde_json::from_str::<CommitMessageResponse>(&json_content)
        .map_err(|e| format!("Failed to parse commit message response: {e}"))
}

/// Create a commit with AI-generated message
#[tauri::command]
pub async fn create_commit_with_ai(
    app: AppHandle,
    worktree_path: String,
    custom_prompt: Option<String>,
    push: bool,
    remote: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
) -> Result<CreateCommitResponse, String> {
    log::trace!("Creating commit for: {worktree_path}");

    // 1. Check for uncommitted changes
    let status = get_git_status(&worktree_path)?;
    if status.trim().is_empty() {
        if push {
            // No changes to commit, but user wants to push — push existing commits
            push_to_remote(&worktree_path, remote.as_deref())?;
            log::trace!("No changes to commit, pushed existing commits");
            return Ok(CreateCommitResponse {
                commit_hash: String::new(),
                message: String::new(),
                pushed: true,
            });
        }
        return Err("No changes to commit".to_string());
    }

    // 2. Stage all changes
    stage_all_changes(&worktree_path)?;

    // 3. Get staged diff
    let diff = get_staged_diff(&worktree_path)?;
    if diff.trim().is_empty() {
        return Err("No staged changes to commit".to_string());
    }

    // 4. Get context for commit message generation
    let recent_commits = get_recent_commits(&worktree_path, 10)?;
    let remote_info = get_remote_info(&worktree_path)?;

    // 5. Build prompt - use custom if provided and non-empty, otherwise use default
    let prompt_template = custom_prompt
        .as_ref()
        .filter(|p| !p.trim().is_empty())
        .map(|s| s.as_str())
        .unwrap_or(COMMIT_MESSAGE_PROMPT);

    let prompt = prompt_template
        .replace("{status}", &status)
        .replace("{diff}", &diff)
        .replace("{recent_commits}", &recent_commits)
        .replace("{remote_info}", &remote_info);

    // 6. Generate commit message with Claude CLI
    let response = generate_commit_message(
        &app,
        &prompt,
        model.as_deref(),
        custom_profile_name.as_deref(),
        Some(std::path::Path::new(&worktree_path)),
    )?;

    log::trace!(
        "Generated commit message: {}",
        response.message.lines().next().unwrap_or("")
    );

    // 7. Create the commit
    let commit_hash = create_git_commit(&worktree_path, &response.message)?;

    log::trace!("Created commit: {commit_hash}");

    // 8. Push if requested
    let pushed = if push {
        push_to_remote(&worktree_path, remote.as_deref())?;
        log::trace!("Pushed to remote");
        true
    } else {
        false
    };

    Ok(CreateCommitResponse {
        commit_hash,
        message: response.message,
        pushed,
    })
}

// =============================================================================
// AI-Powered Code Review
// =============================================================================

/// JSON schema for structured code review output
const REVIEW_SCHEMA: &str = r#"{"type":"object","properties":{"summary":{"type":"string","description":"Brief 1-2 sentence summary of the overall changes"},"findings":{"type":"array","items":{"type":"object","properties":{"severity":{"type":"string","enum":["critical","warning","suggestion","praise"],"description":"Severity level of the finding"},"file":{"type":"string","description":"File path where the finding applies"},"line":{"type":"integer","description":"Line number if applicable, 0 if not specific"},"title":{"type":"string","description":"Short title for the finding (max 80 chars)"},"description":{"type":"string","description":"Detailed explanation of the finding"},"suggestion":{"type":"string","description":"Optional code suggestion or fix"}},"required":["severity","file","line","title","description","suggestion"],"additionalProperties":false},"description":"List of review findings"},"approval_status":{"type":"string","enum":["approved","changes_requested","needs_discussion"],"description":"Overall review verdict"}},"required":["summary","findings","approval_status"],"additionalProperties":false}"#;

/// Prompt template for code review
const REVIEW_PROMPT: &str = r#"<task>Review the following code changes and provide structured feedback</task>

<branch_info>{branch_info}</branch_info>

<commits>
{commits}
</commits>

<diff>
{diff}
</diff>

{uncommitted_section}

<instructions>
Focus on:
- Security & supply-chain risks:
  - Malicious or obfuscated code (eval, encoded strings, hidden network calls, data exfiltration)
  - Suspicious dependency additions or version changes (typosquatting, hijacked packages)
  - Hardcoded secrets, tokens, API keys, or credentials
  - Backdoors, reverse shells, or unauthorized remote access
  - Unsafe deserialization, command injection, SQL injection, XSS
  - Weakened auth/permissions (removed checks, broadened access, disabled validation)
  - Suspicious file system or environment variable access
- Performance issues
- Code quality and maintainability (use /check skill if available to run linters/tests)
- Potential bugs
- Best practices violations

If there are uncommitted changes, review those as well.

Be constructive and specific. Include praise for good patterns.
Provide actionable suggestions when possible.
</instructions>"#;

/// A single finding from the AI code review
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReviewFinding {
    pub severity: String,
    pub file: String,
    pub line: Option<u32>,
    pub title: String,
    pub description: String,
    pub suggestion: Option<String>,
}

/// Structured response from AI code review
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReviewResponse {
    pub summary: String,
    pub findings: Vec<ReviewFinding>,
    pub approval_status: String,
}

fn extract_codex_review_structured_output(output: &str) -> Result<String, String> {
    let mut last_agent_message = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            "item.completed" => {
                if let Some(item) = parsed.get("item") {
                    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if item_type == "agent_message" {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            last_agent_message = Some(text.to_string());
                        }
                        if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                            for block in content {
                                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        last_agent_message = Some(text.to_string());
                                    }
                                }
                                if block.get("type").and_then(|t| t.as_str()) == Some("output_text")
                                {
                                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                        if serde_json::from_str::<serde_json::Value>(text).is_ok() {
                                            return Ok(text.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "turn.completed" => {
                if let Some(output_val) = parsed.get("output") {
                    if !output_val.is_null() {
                        return Ok(output_val.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(msg) = last_agent_message {
        if serde_json::from_str::<serde_json::Value>(&msg).is_ok() {
            return Ok(msg);
        }
    }

    Err("No structured output found in Codex response".to_string())
}

fn execute_codex_review(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    working_dir: Option<&std::path::Path>,
    review_run_id: Option<&str>,
) -> Result<String, String> {
    let cli_path = resolve_codex_cli_binary(app);
    if !cli_path.exists() {
        return Err("Codex CLI not installed".to_string());
    }

    let schema_file = std::env::temp_dir().join(format!(
        "jean-codex-review-schema-{}.json",
        std::process::id()
    ));
    std::fs::write(&schema_file, REVIEW_SCHEMA)
        .map_err(|e| format!("Failed to write schema file: {e}"))?;

    let mut cmd = crate::platform::silent_command(&cli_path);
    cmd.args([
        "exec",
        "--json",
        "--model",
        model,
        "--full-auto",
        "--output-schema",
    ]);
    cmd.arg(&schema_file);
    if let Some(dir) = working_dir {
        cmd.arg("--cd");
        cmd.arg(dir);
        cmd.current_dir(dir);
    } else {
        cmd.arg("--skip-git-repo-check");
    }
    cmd.arg("-");
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Codex CLI: {e}"))?;

    if let Some(run_id) = review_run_id {
        register_review_process(run_id, child.id());
    }

    let write_result = if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())
    } else {
        Err(std::io::Error::other("Failed to open stdin"))
    };
    if let Err(e) = write_result {
        if let Some(run_id) = review_run_id {
            let _ = take_review_process_pid(run_id);
        }
        let _ = std::fs::remove_file(&schema_file);
        return Err(format!("Failed to write to stdin: {e}"));
    }

    let output_result = child.wait_with_output();
    let cancelled = review_run_id
        .map(|run_id| take_review_process_pid(run_id).is_none())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&schema_file);

    let output = match output_result {
        Ok(output) => output,
        Err(e) => {
            if cancelled {
                return Err("Review cancelled".to_string());
            }
            return Err(format!("Failed to wait for Codex CLI: {e}"));
        }
    };

    if !output.status.success() {
        if cancelled {
            return Err("Review cancelled".to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Codex CLI failed (exit {}): stderr={}, stdout={}",
            output.status,
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_codex_review_structured_output(&stdout)
}

/// Execute Claude CLI to generate a code review
fn generate_review(
    app: &AppHandle,
    prompt: &str,
    model: Option<&str>,
    custom_profile_name: Option<&str>,
    working_dir: Option<&std::path::Path>,
    review_run_id: Option<&str>,
) -> Result<ReviewResponse, String> {
    let model_str = model.unwrap_or("haiku");

    // Route to OpenCode if model is an OpenCode model
    if crate::is_opencode_model(model_str) {
        log::trace!("Running code review with OpenCode");
        let json_str = crate::chat::opencode::execute_one_shot_opencode(
            app,
            prompt,
            model_str,
            Some(REVIEW_SCHEMA),
            working_dir,
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse OpenCode review JSON: {e}, content: {json_str}");
            format!("Failed to parse review: {e}")
        });
    }

    // Route to Codex CLI if model is a Codex model
    if crate::is_codex_model(model_str) {
        log::trace!("Running code review with Codex CLI (output-schema)");
        let json_str = execute_codex_review(app, prompt, model_str, working_dir, review_run_id)?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Codex review JSON: {e}, content: {json_str}");
            format!("Failed to parse review: {e}")
        });
    }

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::trace!("Running code review with Claude CLI (JSON schema)");

    let mut cmd = silent_command(&cli_path);
    crate::chat::claude::apply_custom_profile_settings(&mut cmd, custom_profile_name);
    cmd.args([
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model_str,
        "--no-session-persistence",
        "--tools",
        "none",
        "--max-turns",
        "1",
        "--json-schema",
        REVIEW_SCHEMA,
    ]);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;
    if let Some(run_id) = review_run_id {
        register_review_process(run_id, child.id());
    }

    // Write prompt to stdin
    {
        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let input_message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });
        writeln!(stdin, "{input_message}").map_err(|e| format!("Failed to write to stdin: {e}"))?;
    }

    let output_result = child.wait_with_output();
    let cancelled = review_run_id
        .map(|run_id| take_review_process_pid(run_id).is_none())
        .unwrap_or(false);
    let output = match output_result {
        Ok(output) => output,
        Err(e) => {
            if cancelled {
                return Err("Review cancelled".to_string());
            }
            return Err(format!("Failed to wait for Claude CLI: {e}"));
        }
    };

    if !output.status.success() {
        if cancelled {
            return Err("Review cancelled".to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Claude CLI failed: stderr={}, stdout={}",
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    log::trace!("Claude CLI review stdout: {stdout}");

    let json_content = extract_structured_output(&stdout)?;
    log::trace!("Extracted review JSON: {json_content}");

    serde_json::from_str::<ReviewResponse>(&json_content)
        .map_err(|e| format!("Failed to parse review response: {e}"))
}

/// Run AI code review on the current branch
#[tauri::command]
pub async fn run_review_with_ai(
    app: AppHandle,
    worktree_path: String,
    custom_prompt: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
    review_run_id: Option<String>,
) -> Result<ReviewResponse, String> {
    log::trace!("Running AI code review for: {worktree_path}");

    // Load projects data to find the target branch
    let data = load_projects_data(&app)?;

    // Find the worktree by path
    let worktree = data
        .worktrees
        .iter()
        .find(|w| w.path == worktree_path)
        .ok_or_else(|| format!("Worktree not found: {worktree_path}"))?;

    // Find the project to get default_branch
    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?;

    let target_branch = &project.default_branch;
    let current_branch = git::get_current_branch(&worktree_path)?;

    // Get branch diff (non-fatal — may fail if origin ref doesn't exist)
    let diff = get_branch_diff(&worktree_path, target_branch).unwrap_or_default();

    // Get commit history (non-fatal — same reason)
    let commits = get_branch_commits(&worktree_path, target_branch).unwrap_or_default();

    // Get uncommitted changes (staged + unstaged for tracked files)
    let uncommitted_output = silent_command("git")
        .args(["diff", "HEAD"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to get uncommitted diff: {e}"))?;

    let uncommitted_diff = if uncommitted_output.status.success() {
        String::from_utf8_lossy(&uncommitted_output.stdout).to_string()
    } else {
        String::new()
    };

    // Get untracked files
    let untracked_output = silent_command("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to list untracked files: {e}"))?;

    let untracked_files: Vec<String> = if untracked_output.status.success() {
        String::from_utf8_lossy(&untracked_output.stdout)
            .lines()
            .map(|s| s.to_string())
            .collect()
    } else {
        Vec::new()
    };

    // Read content of untracked files (skip binary and large files)
    let mut untracked_content = String::new();
    for file in &untracked_files {
        let file_path = std::path::Path::new(&worktree_path).join(file);
        if let Ok(metadata) = std::fs::metadata(&file_path) {
            if metadata.len() > 100_000 {
                untracked_content.push_str(&format!(
                    "\n--- New file: {file} (skipped: file too large)\n"
                ));
                continue;
            }
        }
        if let Ok(content) = std::fs::read_to_string(&file_path) {
            untracked_content.push_str(&format!("\n--- New file: {file}\n"));
            untracked_content.push_str(&content);
            untracked_content.push('\n');
        } else {
            untracked_content.push_str(&format!("\n--- New file: {file} (binary or unreadable)\n"));
        }
    }

    // Check if there's anything to review
    if diff.trim().is_empty()
        && commits.trim().is_empty()
        && uncommitted_diff.trim().is_empty()
        && untracked_content.trim().is_empty()
    {
        return Err("No changes to review".to_string());
    }

    // Build uncommitted section if there are uncommitted changes
    let has_uncommitted =
        !uncommitted_diff.trim().is_empty() || !untracked_content.trim().is_empty();
    let uncommitted_section = if has_uncommitted {
        let mut section = String::from("## Uncommitted Changes\n\n");
        if !uncommitted_diff.trim().is_empty() {
            section.push_str(&format!("```diff\n{}\n```\n", uncommitted_diff.trim()));
        }
        if !untracked_content.trim().is_empty() {
            section.push_str(&format!(
                "### New Untracked Files\n\n{}\n",
                untracked_content.trim()
            ));
        }
        section
    } else {
        String::new()
    };

    // Build prompt - use custom if provided and non-empty, otherwise use default
    let branch_info = format!("{current_branch} → {target_branch}");
    let prompt_template = custom_prompt
        .as_ref()
        .filter(|p| !p.trim().is_empty())
        .map(|s| s.as_str())
        .unwrap_or(REVIEW_PROMPT);

    let prompt = prompt_template
        .replace("{branch_info}", &branch_info)
        .replace("{commits}", &commits)
        .replace("{diff}", &diff)
        .replace("{uncommitted_section}", &uncommitted_section);

    // Run review with Claude CLI
    let response = generate_review(
        &app,
        &prompt,
        model.as_deref(),
        custom_profile_name.as_deref(),
        Some(std::path::Path::new(&worktree_path)),
        review_run_id.as_deref(),
    )?;

    log::trace!(
        "Review complete: {} findings, status: {}",
        response.findings.len(),
        response.approval_status
    );

    Ok(response)
}

/// Cancel a running AI review request by review_run_id.
/// Returns true if a process was found and cancelled, false otherwise.
#[tauri::command]
pub async fn cancel_review_with_ai(review_run_id: String) -> Result<bool, String> {
    let Some(pid) = take_review_process_pid(&review_run_id) else {
        return Ok(false);
    };

    if pid == 0 || pid == 1 {
        return Err(format!("Invalid PID: {pid}"));
    }

    if let Err(e) = crate::platform::kill_process(pid) {
        return Err(format!("Failed to cancel review process {pid}: {e}"));
    }

    Ok(true)
}

/// Pull changes from remote origin for the specified base branch
#[tauri::command]
pub async fn git_pull(
    worktree_path: String,
    base_branch: String,
    remote: Option<String>,
) -> Result<String, String> {
    log::trace!("Pulling changes for worktree: {worktree_path}, base branch: {base_branch}, remote: {remote:?}");
    git::git_pull(&worktree_path, &base_branch, remote.as_deref())
}

/// Stash all local changes including untracked files
#[tauri::command]
pub async fn git_stash(worktree_path: String) -> Result<String, String> {
    log::trace!("Stashing changes for worktree: {worktree_path}");
    git::git_stash(&worktree_path)
}

/// Pop the most recent stash
#[tauri::command]
pub async fn git_stash_pop(worktree_path: String) -> Result<String, String> {
    log::trace!("Popping stash for worktree: {worktree_path}");
    git::git_stash_pop(&worktree_path)
}

/// Push current branch to remote. If pr_number is provided, uses PR-aware push
/// that handles fork remotes and uses --force-with-lease.
#[tauri::command]
pub async fn git_push(
    app: tauri::AppHandle,
    worktree_path: String,
    pr_number: Option<u32>,
    remote: Option<String>,
) -> Result<String, String> {
    log::trace!("Pushing changes for worktree: {worktree_path}, pr_number: {pr_number:?}, remote: {remote:?}");
    match pr_number {
        Some(pr) => git::git_push_to_pr(&worktree_path, pr, &resolve_gh_binary(&app)),
        None => git::git_push(&worktree_path, remote.as_deref()),
    }
}

// =============================================================================
// Release Notes
// =============================================================================

/// A GitHub release returned by `gh release list`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRelease {
    pub tag_name: String,
    pub name: String,
    pub published_at: String,
    pub is_latest: bool,
    pub is_draft: bool,
    pub is_prerelease: bool,
}

/// List GitHub releases for a project
#[tauri::command]
pub async fn list_github_releases(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<GitHubRelease>, String> {
    log::trace!("Listing GitHub releases for: {project_path}");

    let gh = resolve_gh_binary(&app);
    let output = silent_command(&gh)
        .args([
            "release",
            "list",
            "--json",
            "tagName,name,publishedAt,isLatest,isDraft,isPrerelease",
            "--limit",
            "30",
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to run gh CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list releases: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Vec<GitHubRelease>>(&stdout)
        .map_err(|e| format!("Failed to parse releases: {e}"))
}

/// Response from generate_release_notes command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseNotesResponse {
    pub title: String,
    pub body: String,
}

const RELEASE_NOTES_SCHEMA: &str = r#"{
    "type": "object",
    "properties": {
        "title": {
            "type": "string",
            "description": "A concise release title (e.g. 'v1.2.0 - Dark Mode & Performance')"
        },
        "body": {
            "type": "string",
            "description": "Release notes in markdown format, grouped by category"
        }
    },
    "required": ["title", "body"],
    "additionalProperties": false
}"#;

const RELEASE_NOTES_PROMPT: &str = r#"Generate release notes for changes since the `{tag}` release ({previous_release_name}).

## Commits since {tag}

{commits}

## Instructions

- Write a concise release title
- Group changes into categories: Features, Fixes, Improvements, Breaking Changes (only include categories that have entries)
- Use bullet points with brief descriptions
- Reference PR numbers if visible in commit messages
- Skip merge commits and trivial changes (typos, formatting)
- Write in past tense ("Added", "Fixed", "Improved")
- Keep it concise and user-facing (skip internal implementation details)"#;

/// Generate release notes content using Claude CLI
fn generate_release_notes_content(
    app: &AppHandle,
    project_path: &str,
    tag: &str,
    release_name: &str,
    custom_prompt: Option<&str>,
    model: Option<&str>,
    custom_profile_name: Option<&str>,
) -> Result<ReleaseNotesResponse, String> {
    // Fetch tags to ensure we have the tag locally
    let fetch_output = silent_command("git")
        .args(["fetch", "--tags"])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to fetch tags: {e}"))?;

    if !fetch_output.status.success() {
        let stderr = String::from_utf8_lossy(&fetch_output.stderr);
        log::warn!("git fetch --tags warning: {stderr}");
    }

    // Get commits since the tag
    let commits_output = silent_command("git")
        .args([
            "log",
            &format!("{tag}..HEAD"),
            "--format=%h %s%n%b---",
            "--no-merges",
        ])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("Failed to get commits: {e}"))?;

    if !commits_output.status.success() {
        let stderr = String::from_utf8_lossy(&commits_output.stderr);
        return Err(format!("Failed to get commits since {tag}: {stderr}"));
    }

    let commits = String::from_utf8_lossy(&commits_output.stdout).to_string();

    if commits.trim().is_empty() {
        return Err(format!("No changes found since {tag}"));
    }

    // Truncate commits if too large (50K chars)
    let commits = if commits.len() > 50_000 {
        format!(
            "{}\n\n[... truncated, {} total characters]",
            &commits[..50_000],
            commits.len()
        )
    } else {
        commits
    };

    // Build prompt
    let prompt_template = custom_prompt
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(RELEASE_NOTES_PROMPT);

    let prompt = prompt_template
        .replace("{tag}", tag)
        .replace("{previous_release_name}", release_name)
        .replace("{commits}", &commits);

    let model_str = model.unwrap_or("haiku");

    // Route to OpenCode if model is an OpenCode model
    if crate::is_opencode_model(model_str) {
        log::trace!("Generating release notes with OpenCode");
        let json_str = crate::chat::opencode::execute_one_shot_opencode(
            app,
            &prompt,
            model_str,
            Some(RELEASE_NOTES_SCHEMA),
            Some(std::path::Path::new(project_path)),
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse OpenCode release notes JSON: {e}, content: {json_str}");
            format!("Failed to parse release notes: {e}")
        });
    }

    // Route to Codex CLI if model is a Codex model
    if crate::is_codex_model(model_str) {
        log::trace!("Generating release notes with Codex CLI (output-schema)");
        let json_str = crate::chat::codex::execute_one_shot_codex(
            app,
            &prompt,
            model_str,
            RELEASE_NOTES_SCHEMA,
            Some(std::path::Path::new(project_path)),
        )?;
        return serde_json::from_str(&json_str).map_err(|e| {
            log::error!("Failed to parse Codex release notes JSON: {e}, content: {json_str}");
            format!("Failed to parse release notes: {e}")
        });
    }

    let cli_path = resolve_cli_binary(app);
    if !cli_path.exists() {
        return Err("Claude CLI not installed".to_string());
    }

    log::trace!("Generating release notes with Claude CLI (JSON schema)");

    let mut cmd = silent_command(&cli_path);
    crate::chat::claude::apply_custom_profile_settings(&mut cmd, custom_profile_name);
    cmd.args([
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model_str,
        "--no-session-persistence",
        "--tools",
        "",
        "--max-turns",
        "1",
        "--json-schema",
        RELEASE_NOTES_SCHEMA,
    ]);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {e}"))?;

    // Write prompt to stdin
    {
        let stdin = child.stdin.as_mut().ok_or("Failed to open stdin")?;
        let input_message = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });
        writeln!(stdin, "{input_message}").map_err(|e| format!("Failed to write to stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for Claude CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Claude CLI failed: stderr={}, stdout={}",
            stderr.trim(),
            stdout.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    log::trace!("Claude CLI release notes stdout: {stdout}");

    let json_content = extract_structured_output(&stdout)?;
    log::trace!("Extracted release notes JSON: {json_content}");

    serde_json::from_str::<ReleaseNotesResponse>(&json_content)
        .map_err(|e| format!("Failed to parse release notes response: {e}"))
}

/// Generate release notes comparing a tag to HEAD
#[tauri::command]
pub async fn generate_release_notes(
    app: AppHandle,
    project_path: String,
    tag: String,
    release_name: String,
    custom_prompt: Option<String>,
    model: Option<String>,
    custom_profile_name: Option<String>,
) -> Result<ReleaseNotesResponse, String> {
    log::trace!("Generating release notes for {project_path} since {tag}");

    generate_release_notes_content(
        &app,
        &project_path,
        &tag,
        &release_name,
        custom_prompt.as_deref(),
        model.as_deref(),
        custom_profile_name.as_deref(),
    )
}

// =============================================================================
// Local Merge
// =============================================================================

/// Response from merge_worktree_to_base command
#[derive(Debug, Clone, Serialize)]
pub struct MergeWorktreeResponse {
    /// Whether the merge completed successfully
    pub success: bool,
    /// Commit hash if successful
    pub commit_hash: Option<String>,
    /// List of conflicting files if merge had conflicts
    pub conflicts: Option<Vec<String>>,
    /// Diff showing the conflict details
    pub conflict_diff: Option<String>,
    /// Whether worktree was cleaned up
    pub cleaned_up: bool,
}

/// Merge worktree branch into base branch locally and clean up
///
/// This command:
/// 1. Validates the worktree is not a base session
/// 2. Validates there is no open PR
/// 3. Auto-commits any uncommitted changes in the worktree
/// 4. Merges the feature branch into base in the main repo
/// 5. On success: deletes the worktree and branch
/// 6. On conflict: leaves worktree intact for user resolution
///
/// Emits `worktree:deleted` event on successful merge and cleanup.
#[tauri::command]
pub async fn merge_worktree_to_base(
    app: AppHandle,
    worktree_id: String,
    merge_type: MergeType,
) -> Result<MergeWorktreeResponse, String> {
    log::trace!("Merging worktree to base: {worktree_id} (type: {merge_type:?})");

    // Load projects data
    let data = load_projects_data(&app)?;

    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?
        .clone();

    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?
        .clone();

    // Validate: not a base session
    if worktree.session_type == SessionType::Base {
        return Err("Cannot merge base branch into itself".to_string());
    }

    // Validate: no open PR
    if worktree.pr_url.is_some() {
        return Err(
            "Cannot merge locally while a PR is open. Close or merge the PR on GitHub first."
                .to_string(),
        );
    }

    // Auto-commit uncommitted changes in worktree using AI-generated message
    if git::has_uncommitted_changes(&worktree.path) {
        log::trace!("Auto-committing uncommitted changes before merge with AI message");

        // Stage all changes
        stage_all_changes(&worktree.path)?;

        // Get context for commit message generation
        let status = get_git_status(&worktree.path).unwrap_or_default();
        let diff = get_staged_diff(&worktree.path).unwrap_or_default();
        let recent_commits = get_recent_commits(&worktree.path, 10).unwrap_or_default();
        let remote_info = get_remote_info(&worktree.path).unwrap_or_default();

        // Build prompt and generate commit message
        let prompt = COMMIT_MESSAGE_PROMPT
            .replace("{status}", &status)
            .replace("{diff}", &diff)
            .replace("{recent_commits}", &recent_commits)
            .replace("{remote_info}", &remote_info);

        match generate_commit_message(
            &app,
            &prompt,
            None,
            None,
            Some(std::path::Path::new(&worktree.path)),
        ) {
            Ok(response) => {
                // Create the commit with AI-generated message
                match create_git_commit(&worktree.path, &response.message) {
                    Ok(hash) => log::trace!("Auto-committed with AI message: {hash}"),
                    Err(e) => {
                        if !e.contains("Nothing to commit") && !e.contains("nothing to commit") {
                            return Err(format!("Failed to auto-commit changes: {e}"));
                        }
                    }
                }
            }
            Err(e) => {
                // Fallback to simple commit message if AI fails
                log::warn!("AI commit message generation failed, using fallback: {e}");
                match create_git_commit(&worktree.path, "Auto-commit before merge") {
                    Ok(hash) => log::trace!("Auto-committed with fallback message: {hash}"),
                    Err(e) => {
                        if !e.contains("Nothing to commit") && !e.contains("nothing to commit") {
                            return Err(format!("Failed to auto-commit changes: {e}"));
                        }
                    }
                }
            }
        }
    }

    // Perform the merge in main repo
    let merge_result = git::merge_branch_to_base(
        &project.path,
        &worktree.path,
        &worktree.branch,
        &project.default_branch,
        merge_type,
    );

    match merge_result {
        git::MergeResult::Success { commit_hash } => {
            log::trace!("Merge successful, cleaning up worktree");

            // Cancel any running Claude processes for this worktree
            crate::chat::registry::cancel_processes_for_worktree(&app, &worktree_id);

            // Emit deleting event
            let deleting_event = WorktreeDeletingEvent {
                id: worktree_id.clone(),
                project_id: worktree.project_id.clone(),
            };
            if let Err(e) = app.emit_all("worktree:deleting", &deleting_event) {
                log::error!("Failed to emit worktree:deleting event: {e}");
            }

            // Remove the worktree
            if let Err(e) = git::remove_worktree(&project.path, &worktree.path) {
                log::error!("Failed to remove worktree after merge: {e}");
                // Continue anyway - merge succeeded
            }

            // Delete the branch
            if let Err(e) = git::delete_branch(&project.path, &worktree.branch) {
                log::error!("Failed to delete branch after merge: {e}");
                // Continue anyway - merge succeeded
            }

            // Remove from storage
            let mut data = load_projects_data(&app)?;
            data.remove_worktree(&worktree_id);
            save_projects_data(&app, &data)?;

            // Emit deleted event
            let deleted_event = WorktreeDeletedEvent {
                id: worktree_id.clone(),
                project_id: worktree.project_id.clone(),
            };
            if let Err(e) = app.emit_all("worktree:deleted", &deleted_event) {
                log::error!("Failed to emit worktree:deleted event: {e}");
            }

            log::trace!("Worktree merged and cleaned up: {}", worktree.name);

            Ok(MergeWorktreeResponse {
                success: true,
                commit_hash: Some(commit_hash),
                conflicts: None,
                conflict_diff: None,
                cleaned_up: true,
            })
        }
        git::MergeResult::Conflict {
            conflicting_files,
            conflict_diff,
        } => {
            log::warn!(
                "Merge has conflicts in {} files: {:?}",
                conflicting_files.len(),
                conflicting_files
            );

            Ok(MergeWorktreeResponse {
                success: false,
                commit_hash: None,
                conflicts: Some(conflicting_files),
                conflict_diff: Some(conflict_diff),
                cleaned_up: false,
            })
        }
        git::MergeResult::Error { message } => {
            log::error!("Merge failed: {message}");
            Err(message)
        }
    }
}

/// Response from get_merge_conflicts command
#[derive(Debug, Clone, Serialize)]
pub struct MergeConflictsResponse {
    /// Whether there are unresolved merge conflicts
    pub has_conflicts: bool,
    /// List of files with conflicts
    pub conflicts: Vec<String>,
    /// Diff showing conflict markers
    pub conflict_diff: String,
}

/// Detect existing merge/rebase conflicts in a worktree
///
/// Use this when the user has manually started a merge/rebase
/// and wants the app to help resolve conflicts.
#[tauri::command]
pub async fn get_merge_conflicts(
    app: AppHandle,
    worktree_id: String,
) -> Result<MergeConflictsResponse, String> {
    log::trace!("Checking for merge conflicts in worktree: {worktree_id}");

    let data = load_projects_data(&app)?;
    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;

    // Get list of files with unresolved conflicts (unmerged paths)
    let conflict_output = silent_command("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(&worktree.path)
        .output()
        .map_err(|e| format!("Failed to check conflicts: {e}"))?;

    let conflicts: Vec<String> = String::from_utf8_lossy(&conflict_output.stdout)
        .lines()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if conflicts.is_empty() {
        return Ok(MergeConflictsResponse {
            has_conflicts: false,
            conflicts: vec![],
            conflict_diff: String::new(),
        });
    }

    // Get the diff with conflict markers
    let diff_output = silent_command("git")
        .args(["diff"])
        .current_dir(&worktree.path)
        .output()
        .map_err(|e| format!("Failed to get conflict diff: {e}"))?;

    let conflict_diff = String::from_utf8_lossy(&diff_output.stdout).to_string();

    Ok(MergeConflictsResponse {
        has_conflicts: true,
        conflicts,
        conflict_diff,
    })
}

/// Fetch the base branch and merge it into the current worktree branch.
///
/// Used when a PR has merge conflicts on GitHub. This creates the conflict
/// state locally so the user can resolve conflicts with AI assistance.
/// If the merge is clean (no conflicts), the merge commit is kept.
#[tauri::command]
pub async fn fetch_and_merge_base(
    app: AppHandle,
    worktree_id: String,
) -> Result<MergeConflictsResponse, String> {
    log::trace!("Fetching base branch and merging into worktree: {worktree_id}");

    let data = load_projects_data(&app)?;
    let worktree = data
        .find_worktree(&worktree_id)
        .ok_or_else(|| format!("Worktree not found: {worktree_id}"))?;
    let project = data
        .find_project(&worktree.project_id)
        .ok_or_else(|| format!("Project not found: {}", worktree.project_id))?;

    let base_branch = &project.default_branch;
    let worktree_path = &worktree.path;

    // Fetch the latest base branch from origin
    let fetch_output = silent_command("git")
        .args(["fetch", "origin", base_branch])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to fetch origin: {e}"))?;

    if !fetch_output.status.success() {
        let stderr = String::from_utf8_lossy(&fetch_output.stderr);
        return Err(format!("Failed to fetch origin/{base_branch}: {stderr}"));
    }

    // Merge origin/<base_branch> into current branch
    let merge_output = silent_command("git")
        .args(["merge", &format!("origin/{base_branch}")])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to merge: {e}"))?;

    // Check if merge succeeded cleanly
    if merge_output.status.success() {
        return Ok(MergeConflictsResponse {
            has_conflicts: false,
            conflicts: vec![],
            conflict_diff: String::new(),
        });
    }

    // Merge failed — check for conflict files
    let conflict_output = silent_command("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to check conflicts: {e}"))?;

    let conflicts: Vec<String> = String::from_utf8_lossy(&conflict_output.stdout)
        .lines()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if conflicts.is_empty() {
        // Merge failed but no conflict markers — unexpected error
        let stderr = String::from_utf8_lossy(&merge_output.stderr);
        return Err(format!("Merge failed: {stderr}"));
    }

    // Get the diff with conflict markers
    let diff_output = silent_command("git")
        .args(["diff"])
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to get conflict diff: {e}"))?;

    let conflict_diff = String::from_utf8_lossy(&diff_output.stdout).to_string();

    Ok(MergeConflictsResponse {
        has_conflicts: true,
        conflicts,
        conflict_diff,
    })
}

/// Result of the archive cleanup operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupResult {
    pub deleted_worktrees: u32,
    pub deleted_sessions: u32,
    pub deleted_contexts: u32,
}

/// Cleanup archived worktrees and sessions older than the specified retention period
///
/// This command runs on app startup to automatically clean up old archives.
/// Set retention_days to 0 to disable cleanup.
#[tauri::command]
pub async fn cleanup_old_archives(
    app: AppHandle,
    retention_days: u32,
) -> Result<CleanupResult, String> {
    // If retention is 0, cleanup is disabled
    if retention_days == 0 {
        log::trace!("Archive cleanup is disabled (retention_days = 0)");
        return Ok(CleanupResult {
            deleted_worktrees: 0,
            deleted_sessions: 0,
            deleted_contexts: 0,
        });
    }

    log::trace!("Running archive cleanup with {retention_days} day retention");

    let cutoff = now() - (retention_days as u64 * 86400);
    let mut deleted_worktrees = 0u32;
    let mut deleted_sessions = 0u32;

    // --- Clean up old archived worktrees ---
    let data = load_projects_data(&app)?;

    // Find worktrees to delete
    let worktrees_to_delete: Vec<_> = data
        .worktrees
        .iter()
        .filter(|w| {
            if let Some(archived_at) = w.archived_at {
                archived_at < cutoff
            } else {
                false
            }
        })
        .cloned()
        .collect();

    for worktree in worktrees_to_delete {
        log::trace!(
            "Deleting old archived worktree: {} (archived {} days ago)",
            worktree.name,
            (now() - worktree.archived_at.unwrap_or(0)) / 86400
        );

        // Find the project for this worktree
        let project = data.find_project(&worktree.project_id);

        // Remove from storage
        let mut current_data = load_projects_data(&app)?;
        current_data.remove_worktree(&worktree.id);
        save_projects_data(&app, &current_data)?;

        // Perform git cleanup if we have project info and it's not a base session
        if let Some(proj) = project {
            if worktree.session_type != SessionType::Base {
                // Remove git worktree (ignore errors if already gone)
                if let Err(e) = git::remove_worktree(&proj.path, &worktree.path) {
                    log::warn!("Failed to remove worktree (may be gone): {e}");
                }

                // Delete branch (ignore errors if already gone)
                if let Err(e) = git::delete_branch(&proj.path, &worktree.branch) {
                    log::warn!("Failed to delete branch (may be gone): {e}");
                }
            }
        }

        // Collect session IDs before deleting the index so we can clean up data dirs
        let session_ids: Vec<String> =
            crate::chat::storage::load_sessions(&app, &worktree.path, &worktree.id)
                .map(|ws| ws.sessions.iter().map(|s| s.id.clone()).collect())
                .unwrap_or_default();

        // Delete session data directories
        for sid in &session_ids {
            if let Err(e) = crate::chat::storage::delete_session_data(&app, sid) {
                log::warn!("Failed to delete session data for {sid}: {e}");
            }
        }

        // Delete the sessions index file
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            let sessions_file = app_data_dir
                .join("sessions")
                .join(format!("{}.json", worktree.id));
            if sessions_file.exists() {
                if let Err(e) = std::fs::remove_file(&sessions_file) {
                    log::warn!("Failed to delete sessions file: {e}");
                }
            }
        }

        deleted_worktrees += 1;
    }

    // --- Clean up old archived sessions (in non-archived worktrees) ---
    // We need to iterate through all worktrees and check their sessions
    let data = load_projects_data(&app)?;

    for worktree in &data.worktrees {
        // Skip archived worktrees - they were handled above (or will be deleted entirely)
        if worktree.archived_at.is_some() {
            continue;
        }

        // Atomically clean up old archived sessions, collecting removed IDs
        let worktree_path = worktree.path.clone();
        let worktree_id = worktree.id.clone();
        let removed_ids = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let removed_ids_clone = removed_ids.clone();
        let result =
            crate::chat::with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
                let original_count = sessions.sessions.len();
                let mut removed_count = 0;

                // Remove sessions that are archived and older than cutoff
                sessions.sessions.retain(|s| {
                    if let Some(archived_at) = s.archived_at {
                        if archived_at < cutoff {
                            log::trace!(
                                "Deleting old archived session: {} (archived {} days ago)",
                                s.name,
                                (now() - archived_at) / 86400
                            );
                            removed_ids_clone.lock().unwrap().push(s.id.clone());
                            removed_count += 1;
                            return false; // Remove this session
                        }
                    }
                    true // Keep this session
                });

                if sessions.sessions.len() < original_count {
                    Ok(removed_count)
                } else {
                    Ok(0)
                }
            });

        // Delete session data directories for removed sessions
        if let Ok(ids) = removed_ids.lock() {
            for sid in ids.iter() {
                if let Err(e) = crate::chat::storage::delete_session_data(&app, sid) {
                    log::warn!("Failed to delete session data for {sid}: {e}");
                }
            }
        }

        if let Ok(count) = result {
            deleted_sessions += count;
        }
    }

    // --- Clean up orphaned session data directories ---
    let orphaned = crate::chat::storage::cleanup_orphaned_session_data(&app).unwrap_or(0);
    deleted_sessions += orphaned;

    // --- Clean up orphaned context files ---
    let deleted_contexts =
        super::github_issues::cleanup_orphaned_contexts(&app, retention_days as u64).unwrap_or(0);

    log::trace!(
        "Archive cleanup complete: deleted {} worktrees, {} sessions, and {} contexts",
        deleted_worktrees,
        deleted_sessions,
        deleted_contexts
    );

    Ok(CleanupResult {
        deleted_worktrees,
        deleted_sessions,
        deleted_contexts,
    })
}

/// Delete ALL archived worktrees and sessions (manual cleanup)
///
/// This permanently deletes all archived items including:
/// - Archived worktrees (including git worktrees and branches)
/// - Archived sessions in non-archived worktrees
#[tauri::command]
pub async fn delete_all_archives(app: AppHandle) -> Result<CleanupResult, String> {
    log::trace!("Deleting all archived items");

    let mut deleted_worktrees = 0u32;
    let mut deleted_sessions = 0u32;

    // --- Delete all archived worktrees ---
    let data = load_projects_data(&app)?;

    // Find all archived worktrees
    let worktrees_to_delete: Vec<_> = data
        .worktrees
        .iter()
        .filter(|w| w.archived_at.is_some())
        .cloned()
        .collect();

    for worktree in worktrees_to_delete {
        log::trace!("Deleting archived worktree: {}", worktree.name);

        // Find the project for this worktree
        let project = data.find_project(&worktree.project_id);

        // Remove from storage
        let mut current_data = load_projects_data(&app)?;
        current_data.remove_worktree(&worktree.id);
        save_projects_data(&app, &current_data)?;

        // Perform git cleanup if we have project info and it's not a base session
        if let Some(proj) = project {
            if worktree.session_type != SessionType::Base {
                // Remove git worktree (ignore errors if already gone)
                if let Err(e) = git::remove_worktree(&proj.path, &worktree.path) {
                    log::warn!("Failed to remove worktree (may be gone): {e}");
                }

                // Delete branch (ignore errors if already gone)
                if let Err(e) = git::delete_branch(&proj.path, &worktree.branch) {
                    log::warn!("Failed to delete branch (may be gone): {e}");
                }
            }
        }

        // Collect session IDs before deleting the index so we can clean up data dirs
        let session_ids: Vec<String> =
            crate::chat::storage::load_sessions(&app, &worktree.path, &worktree.id)
                .map(|ws| ws.sessions.iter().map(|s| s.id.clone()).collect())
                .unwrap_or_default();

        // Delete session data directories
        for sid in &session_ids {
            if let Err(e) = crate::chat::storage::delete_session_data(&app, sid) {
                log::warn!("Failed to delete session data for {sid}: {e}");
            }
        }

        // Delete the sessions index file
        if let Ok(app_data_dir) = app.path().app_data_dir() {
            let sessions_file = app_data_dir
                .join("sessions")
                .join(format!("{}.json", worktree.id));
            if sessions_file.exists() {
                if let Err(e) = std::fs::remove_file(&sessions_file) {
                    log::warn!("Failed to delete sessions file: {e}");
                }
            }
        }

        deleted_worktrees += 1;
    }

    // --- Delete all archived sessions (in non-archived worktrees) ---
    let data = load_projects_data(&app)?;

    for worktree in &data.worktrees {
        // Skip archived worktrees - they were handled above
        if worktree.archived_at.is_some() {
            continue;
        }

        // Atomically delete all archived sessions, collecting removed IDs
        let worktree_path = worktree.path.clone();
        let worktree_id = worktree.id.clone();
        let removed_ids = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let removed_ids_clone = removed_ids.clone();
        let result =
            crate::chat::with_sessions_mut(&app, &worktree_path, &worktree_id, |sessions| {
                let original_count = sessions.sessions.len();
                let mut removed_count = 0;

                // Remove all archived sessions
                sessions.sessions.retain(|s| {
                    if s.archived_at.is_some() {
                        log::trace!("Deleting archived session: {}", s.name);
                        removed_ids_clone.lock().unwrap().push(s.id.clone());
                        removed_count += 1;
                        return false; // Remove this session
                    }
                    true // Keep this session
                });

                if sessions.sessions.len() < original_count {
                    Ok(removed_count)
                } else {
                    Ok(0)
                }
            });

        // Delete session data directories for removed sessions
        if let Ok(ids) = removed_ids.lock() {
            for sid in ids.iter() {
                if let Err(e) = crate::chat::storage::delete_session_data(&app, sid) {
                    log::warn!("Failed to delete session data for {sid}: {e}");
                }
            }
        }

        if let Ok(count) = result {
            deleted_sessions += count;
        }
    }

    // Also clean up orphaned contexts (pass 0 for retention_days to clean all orphans)
    let deleted_contexts = super::github_issues::cleanup_orphaned_contexts(&app, 0).unwrap_or(0);

    log::trace!(
        "Deleted all archives: {} worktrees, {} sessions, and {} contexts",
        deleted_worktrees,
        deleted_sessions,
        deleted_contexts
    );

    Ok(CleanupResult {
        deleted_worktrees,
        deleted_sessions,
        deleted_contexts,
    })
}

// =============================================================================
// Folder Operations
// =============================================================================

/// Create a new folder for organizing projects
#[tauri::command]
pub async fn create_folder(
    app: AppHandle,
    name: String,
    parent_id: Option<String>,
) -> Result<Project, String> {
    log::trace!("Creating folder: {name}, parent: {parent_id:?}");

    let mut data = load_projects_data(&app)?;

    // Validate nesting level if parent_id provided
    if let Some(ref pid) = parent_id {
        let parent = data
            .find_project(pid)
            .ok_or_else(|| format!("Parent folder not found: {pid}"))?;

        if !parent.is_folder {
            return Err("Cannot create folder inside a project".to_string());
        }

        let level = data.get_nesting_level(pid);
        if level >= 2 {
            return Err("Maximum folder nesting depth (3) exceeded".to_string());
        }
    }

    // Generate unique folder name if needed
    let unique_name = if data.folder_name_exists(&name, parent_id.as_deref(), None) {
        // Find a unique name like "New Folder (2)", "New Folder (3)", etc.
        let mut counter = 2;
        loop {
            let candidate = format!("{name} ({counter})");
            if !data.folder_name_exists(&candidate, parent_id.as_deref(), None) {
                break candidate;
            }
            counter += 1;
        }
    } else {
        name.clone()
    };

    let order = data.get_next_order(parent_id.as_deref());

    let folder = Project {
        id: Uuid::new_v4().to_string(),
        name: unique_name.clone(),
        path: String::new(),
        default_branch: String::new(),
        added_at: now(),
        order,
        parent_id,
        is_folder: true,
        avatar_path: None,
        enabled_mcp_servers: None,
        known_mcp_servers: Vec::new(),
        custom_system_prompt: None,
        default_provider: None,
        default_backend: None,
    };

    data.add_project(folder.clone());
    save_projects_data(&app, &data)?;

    log::trace!("Successfully created folder: {unique_name}");
    Ok(folder)
}

/// Rename a folder
#[tauri::command]
pub async fn rename_folder(
    app: AppHandle,
    folder_id: String,
    name: String,
) -> Result<Project, String> {
    log::trace!("Renaming folder {folder_id} to: {name}");

    let mut data = load_projects_data(&app)?;

    // Get folder info first (immutable borrow)
    let (parent_id, is_folder) = {
        let folder = data
            .find_project(&folder_id)
            .ok_or_else(|| format!("Folder not found: {folder_id}"))?;
        (folder.parent_id.clone(), folder.is_folder)
    };

    if !is_folder {
        return Err("Cannot rename: not a folder".to_string());
    }

    // Check for duplicate folder name at the same level (excluding self)
    if data.folder_name_exists(&name, parent_id.as_deref(), Some(&folder_id)) {
        return Err(format!(
            "A folder named '{name}' already exists at this level"
        ));
    }

    // Now do the mutable borrow
    let folder = data
        .find_project_mut(&folder_id)
        .ok_or_else(|| format!("Folder not found: {folder_id}"))?;

    folder.name = name.clone();
    let updated = folder.clone();

    save_projects_data(&app, &data)?;

    log::trace!("Successfully renamed folder to: {name}");
    Ok(updated)
}

/// Delete an empty folder
#[tauri::command]
pub async fn delete_folder(app: AppHandle, folder_id: String) -> Result<(), String> {
    log::trace!("Deleting folder: {folder_id}");

    let mut data = load_projects_data(&app)?;

    // Verify it's a folder
    let folder = data
        .find_project(&folder_id)
        .ok_or_else(|| format!("Folder not found: {folder_id}"))?;

    if !folder.is_folder {
        return Err("Cannot delete: not a folder".to_string());
    }

    // Verify empty
    if !data.folder_is_empty(&folder_id) {
        return Err(
            "Cannot delete folder: it is not empty. Move or remove all items first.".to_string(),
        );
    }

    data.remove_project(&folder_id);
    save_projects_data(&app, &data)?;

    log::trace!("Successfully deleted folder: {folder_id}");
    Ok(())
}

/// Move a project or folder to a new parent (or root)
#[tauri::command]
pub async fn move_item(
    app: AppHandle,
    item_id: String,
    new_parent_id: Option<String>,
    target_index: Option<u32>,
) -> Result<Project, String> {
    log::trace!("Moving item {item_id} to parent: {new_parent_id:?}, index: {target_index:?}");

    let mut data = load_projects_data(&app)?;

    // Validate target is a folder (if provided)
    if let Some(ref pid) = new_parent_id {
        let parent = data
            .find_project(pid)
            .ok_or_else(|| format!("Parent not found: {pid}"))?;

        if !parent.is_folder {
            return Err("Cannot move into a project, only into folders".to_string());
        }
    }

    // Check max depth
    if data.would_exceed_max_depth(&item_id, new_parent_id.as_deref()) {
        return Err("Move would exceed maximum nesting depth (3)".to_string());
    }

    // Prevent moving folder into itself or descendants
    if let Some(ref pid) = new_parent_id {
        if item_id == *pid {
            return Err("Cannot move folder into itself".to_string());
        }
        if data.is_descendant_of(pid, &item_id) {
            return Err("Cannot move folder into its own descendant".to_string());
        }
    }

    // Verify item exists
    if data.find_project(&item_id).is_none() {
        return Err(format!("Item not found: {item_id}"));
    }

    // Get siblings in the target parent (excluding the item being moved)
    let mut siblings: Vec<_> = data
        .get_children(new_parent_id.as_deref())
        .into_iter()
        .filter(|p| p.id != item_id)
        .cloned()
        .collect();

    // Sort siblings: folders first, then by order
    siblings.sort_by(|a, b| {
        if a.is_folder && !b.is_folder {
            std::cmp::Ordering::Less
        } else if !a.is_folder && b.is_folder {
            std::cmp::Ordering::Greater
        } else {
            a.order.cmp(&b.order)
        }
    });

    // Insert the item at the target index
    let insert_idx = target_index
        .map(|i| i as usize)
        .unwrap_or(siblings.len())
        .min(siblings.len());

    // Update the item's parent_id first
    let item = data
        .find_project_mut(&item_id)
        .ok_or_else(|| format!("Item not found: {item_id}"))?;
    item.parent_id = new_parent_id.clone();
    let moved_item = item.clone();

    // Build the new order: insert moved item at target_index
    let mut new_order_ids: Vec<String> = siblings.iter().map(|p| p.id.clone()).collect();
    new_order_ids.insert(insert_idx, item_id.clone());

    // Update all orders
    for (order, id) in new_order_ids.iter().enumerate() {
        if let Some(p) = data.find_project_mut(id) {
            p.order = order as u32;
        }
    }

    save_projects_data(&app, &data)?;

    // Return the updated item
    let updated = data.find_project(&item_id).cloned().unwrap_or(moved_item);

    log::trace!("Successfully moved item: {item_id}");
    Ok(updated)
}

/// Reorder projects/folders within a specific parent level
#[tauri::command]
pub async fn reorder_items(
    app: AppHandle,
    item_ids: Vec<String>,
    parent_id: Option<String>,
) -> Result<(), String> {
    log::trace!(
        "Reordering {} items in parent {:?}",
        item_ids.len(),
        parent_id
    );

    let mut data = load_projects_data(&app)?;

    // Update order for each item
    for (index, item_id) in item_ids.iter().enumerate() {
        if let Some(project) = data.find_project_mut(item_id) {
            // Only update items that belong to this parent level
            if project.parent_id == parent_id {
                project.order = index as u32;
            }
        }
    }

    save_projects_data(&app, &data)?;

    log::trace!("Successfully reordered items");
    Ok(())
}

/// Fetch git status for all worktrees in a project
///
/// This is used to populate status indicators in the sidebar without requiring
/// each worktree to be selected first. Status is fetched in parallel and emitted
/// via the existing `git:status-update` event channel.
#[tauri::command]
pub async fn fetch_worktrees_status(app: AppHandle, project_id: String) -> Result<(), String> {
    use super::git_status::{get_branch_status, ActiveWorktreeInfo};

    log::trace!(
        "[fetch_worktrees_status] Fetching status for all worktrees in project: {project_id}"
    );

    let data = load_projects_data(&app)?;

    // Get the project to find default branch
    let project = data
        .find_project(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?
        .clone();

    // Get all non-archived worktrees for this project
    let worktrees: Vec<_> = data
        .worktrees_for_project(&project_id)
        .into_iter()
        .filter(|w| w.archived_at.is_none())
        .cloned()
        .collect();

    if worktrees.is_empty() {
        log::trace!(
            "[fetch_worktrees_status] No worktrees to fetch status for in project: {project_id}"
        );
        return Ok(());
    }

    log::trace!(
        "[fetch_worktrees_status] Fetching status for {} worktrees in project: {}",
        worktrees.len(),
        project_id
    );

    // Spawn threads to fetch status for each worktree in parallel
    // Using std::thread since get_branch_status is synchronous (uses Command)
    let base_branch = project.default_branch.clone();

    for worktree in worktrees {
        let app_clone = app.clone();
        let base_branch_clone = base_branch.clone();

        thread::spawn(move || {
            let info = ActiveWorktreeInfo {
                worktree_id: worktree.id.clone(),
                worktree_path: worktree.path.clone(),
                base_branch: base_branch_clone,
                pr_number: worktree.pr_number,
                pr_url: worktree.pr_url.clone(),
            };

            // Fetch git status (this may take a moment as it runs git commands)
            match get_branch_status(&info) {
                Ok(status) => {
                    log::trace!(
                        "[fetch_worktrees_status] Got status for {}: behind={}, ahead={}",
                        worktree.name,
                        status.behind_count,
                        status.ahead_count
                    );

                    // Emit status update event
                    if let Err(e) = app_clone.emit_all("git:status-update", &status) {
                        log::warn!(
                            "Failed to emit git status for worktree {}: {e}",
                            worktree.id
                        );
                    } else {
                        log::trace!(
                            "[fetch_worktrees_status] Emitted git:status-update for {}",
                            worktree.name
                        );
                    }

                    // Update cached values in storage
                    if let Ok(mut data) = load_projects_data(&app_clone) {
                        if let Some(w) = data.worktrees.iter_mut().find(|w| w.id == worktree.id) {
                            w.cached_behind_count = Some(status.behind_count);
                            w.cached_ahead_count = Some(status.ahead_count);
                            w.cached_uncommitted_added = Some(status.uncommitted_added);
                            w.cached_uncommitted_removed = Some(status.uncommitted_removed);
                            w.cached_branch_diff_added = Some(status.branch_diff_added);
                            w.cached_branch_diff_removed = Some(status.branch_diff_removed);
                            w.cached_unpushed_count = Some(status.unpushed_count);
                            w.cached_status_at = Some(status.checked_at);

                            if let Err(e) = save_projects_data(&app_clone, &data) {
                                log::warn!(
                                    "Failed to save cached status for worktree {}: {e}",
                                    worktree.id
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to get git status for worktree {}: {e}", worktree.id);
                }
            }
        });
    }

    // Don't wait for threads - fire and forget
    // Status updates will be emitted via events as they complete
    log::trace!("[fetch_worktrees_status] Spawned status fetch threads for project: {project_id}");
    Ok(())
}

// =============================================================================
// Claude CLI Skills & Commands
// =============================================================================

/// A Claude CLI skill from ~/.claude/skills/
/// Skills are directories containing a SKILL.md file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSkill {
    /// Skill name (directory name)
    pub name: String,
    /// Full path to the SKILL.md file
    pub path: String,
    /// Optional description (first line of SKILL.md, if it starts with #)
    pub description: Option<String>,
}

/// A Claude CLI custom command from ~/.claude/commands/
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCommand {
    /// Command name (filename without .md extension)
    pub name: String,
    /// Full path to the command file
    pub path: String,
    /// Optional description (first line of file, if it starts with #)
    pub description: Option<String>,
}

/// List Claude CLI skills from ~/.claude/skills/
/// Skills are directories containing a SKILL.md file
#[tauri::command]
pub async fn list_claude_skills() -> Result<Vec<ClaudeSkill>, String> {
    log::trace!("Listing Claude CLI skills");

    let home = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
    let skills_dir = home.join(".claude").join("skills");

    if !skills_dir.exists() {
        log::trace!("Skills directory does not exist: {:?}", skills_dir);
        return Ok(Vec::new());
    }

    let mut skills = Vec::new();

    let entries = std::fs::read_dir(&skills_dir)
        .map_err(|e| format!("Failed to read skills directory: {e}"))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("Failed to read directory entry: {e}");
                continue;
            }
        };

        let path = entry.path();

        // Only process directories
        if !path.is_dir() {
            continue;
        }

        // Check for SKILL.md inside the directory
        let skill_file = path.join("SKILL.md");
        if !skill_file.exists() {
            continue;
        }

        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_default();

        if name.is_empty() {
            continue;
        }

        // Try to extract description from first line of SKILL.md (if starts with #)
        let description = std::fs::read_to_string(&skill_file)
            .ok()
            .and_then(|content| {
                content
                    .lines()
                    .next()
                    .and_then(|line| line.strip_prefix("# ").map(|s| s.to_string()))
            });

        skills.push(ClaudeSkill {
            name,
            path: skill_file.to_string_lossy().to_string(),
            description,
        });
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    log::trace!("Found {} Claude CLI skills", skills.len());
    Ok(skills)
}

/// List Claude CLI custom commands from ~/.claude/commands/
#[tauri::command]
pub async fn list_claude_commands() -> Result<Vec<ClaudeCommand>, String> {
    log::trace!("Listing Claude CLI custom commands");

    let home = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
    let commands_dir = home.join(".claude").join("commands");

    if !commands_dir.exists() {
        log::trace!("Commands directory does not exist: {:?}", commands_dir);
        return Ok(Vec::new());
    }

    let mut commands = Vec::new();

    let entries = std::fs::read_dir(&commands_dir)
        .map_err(|e| format!("Failed to read commands directory: {e}"))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("Failed to read directory entry: {e}");
                continue;
            }
        };

        let path = entry.path();

        // Only process .md files
        if path.extension().is_none_or(|ext| ext != "md") {
            continue;
        }

        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_default();

        if name.is_empty() {
            continue;
        }

        // Try to extract description from first line (if starts with #)
        let description = std::fs::read_to_string(&path).ok().and_then(|content| {
            content
                .lines()
                .next()
                .and_then(|line| line.strip_prefix("# ").map(|s| s.to_string()))
        });

        commands.push(ClaudeCommand {
            name,
            path: path.to_string_lossy().to_string(),
            description,
        });
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    log::trace!("Found {} Claude CLI custom commands", commands.len());
    Ok(commands)
}

// =============================================================================
// Avatar Commands
// =============================================================================

/// Get the avatars directory, creating it if needed
fn get_avatars_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    let avatars_dir = app_data_dir.join("avatars");
    std::fs::create_dir_all(&avatars_dir)
        .map_err(|e| format!("Failed to create avatars directory: {e}"))?;

    Ok(avatars_dir)
}

/// Set a custom avatar image for a project
/// Opens a file dialog to pick an image, copies it to the avatars directory,
/// and updates the project's avatar_path field.
#[tauri::command]
pub async fn set_project_avatar(app: AppHandle, project_id: String) -> Result<Project, String> {
    log::trace!("Setting avatar for project: {project_id}");

    // Open file dialog for image selection
    let file_path = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
        .set_title("Select Project Avatar")
        .blocking_pick_file()
        .ok_or_else(|| "No file selected".to_string())?;

    let source_path = file_path
        .into_path()
        .map_err(|e| format!("Invalid file path: {e}"))?;

    // Determine file extension
    let extension = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    // Create destination path: avatars/{project_id}.{ext}
    let avatars_dir = get_avatars_dir(&app)?;
    let dest_filename = format!("{project_id}.{extension}");
    let dest_path = avatars_dir.join(&dest_filename);

    // Remove any existing avatar files for this project (might have different extension)
    for ext in ["png", "jpg", "jpeg", "webp", "gif"] {
        let old_file = avatars_dir.join(format!("{project_id}.{ext}"));
        if old_file.exists() {
            let _ = std::fs::remove_file(&old_file);
        }
    }

    // Copy the file
    std::fs::copy(&source_path, &dest_path)
        .map_err(|e| format!("Failed to copy avatar file: {e}"))?;

    // Update project with relative path
    let relative_path = format!("avatars/{dest_filename}");

    let mut data = load_projects_data(&app)?;
    let project = data
        .find_project_mut(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    project.avatar_path = Some(relative_path);
    let updated_project = project.clone();

    save_projects_data(&app, &data)?;

    log::trace!(
        "Successfully set avatar for project: {}",
        updated_project.name
    );
    Ok(updated_project)
}

/// Remove the custom avatar from a project
/// Deletes the avatar file and clears the project's avatar_path field.
#[tauri::command]
pub async fn remove_project_avatar(app: AppHandle, project_id: String) -> Result<Project, String> {
    log::trace!("Removing avatar for project: {project_id}");

    let mut data = load_projects_data(&app)?;
    let project = data
        .find_project_mut(&project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    // Delete avatar file if it exists
    if let Some(ref avatar_path) = project.avatar_path {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {e}"))?;

        let full_path = app_data_dir.join(avatar_path);
        if full_path.exists() {
            let _ = std::fs::remove_file(&full_path);
            log::trace!("Deleted avatar file: {full_path:?}");
        }
    }

    project.avatar_path = None;
    let updated_project = project.clone();

    save_projects_data(&app, &data)?;

    log::trace!(
        "Successfully removed avatar for project: {}",
        updated_project.name
    );
    Ok(updated_project)
}

/// Get the app data directory path
/// Used by frontend to resolve relative avatar paths to absolute file:// URLs
#[tauri::command]
pub async fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    Ok(app_data_dir.to_string_lossy().to_string())
}

/// Get full jean.json config for a project
#[tauri::command]
pub async fn get_jean_config(project_path: String) -> Option<JeanConfig> {
    git::read_jean_config(&project_path)
}

/// Save jean.json config to disk
#[tauri::command]
pub async fn save_jean_config(project_path: String, config: JeanConfig) -> Result<(), String> {
    let config_path = Path::new(&project_path).join("jean.json");
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&config_path, format!("{json}\n"))
        .map_err(|e| format!("Failed to write jean.json: {e}"))?;
    log::trace!("Saved jean.json to {}", config_path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_structured_output_valid() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I'll create a PR"},{"type":"tool_use","id":"toolu_123","name":"StructuredOutput","input":{"title":"Add feature","body":"This PR adds..."}}]}}"#;

        let result = extract_structured_output(output);
        assert!(result.is_ok());
        let json = result.unwrap();
        assert!(json.contains("\"title\""));
        assert!(json.contains("Add feature"));
    }

    #[test]
    fn test_extract_structured_output_multiline() {
        let output = r#"{"type":"system","message":"processing"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_123","name":"StructuredOutput","input":{"title":"Fix bug","body":"Fixed the issue"}}]}}"#;

        let result = extract_structured_output(output);
        assert!(result.is_ok());
        let json = result.unwrap();
        assert!(json.contains("Fix bug"));
    }

    #[test]
    fn test_extract_structured_output_no_tool_call() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Here is some text"}]}}"#;

        let result = extract_structured_output(output);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No structured output"));
    }

    #[test]
    fn test_extract_structured_output_wrong_tool_name() {
        let output = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_123","name":"OtherTool","input":{"data":"value"}}]}}"#;

        let result = extract_structured_output(output);
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_structured_output_empty() {
        let result = extract_structured_output("");
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_structured_output_malformed_json() {
        let output = "not json at all\n{\"type\":\"assistant\",\"message\":";

        let result = extract_structured_output(output);
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_structured_output_skips_invalid_lines() {
        let output = r#"invalid line
{"type":"system"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"title":"Test"}}]}}"#;

        let result = extract_structured_output(output);
        assert!(result.is_ok());
    }
}
