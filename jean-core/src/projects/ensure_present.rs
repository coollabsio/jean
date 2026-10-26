//! Ensure a project checkout exists on this Jean host before a worktree or
//! session starts here.
//!
//! This is a one-shot bootstrap: clone when the checkout is missing, then
//! stop. It does not watch or sync files afterwards. Env files are listed,
//! read, and written only when a command asks for that exact step.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::commands::{add_project, register_cloned_project};
use super::git::{self, GitCloneProgress};
use super::storage::{get_worktrees_base_dir, sanitize_directory_name};
use super::types::Project;
use crate::http_server::EmitExt;

/// Env files Jean will offer to copy. Names outside this list are refused.
pub const ENV_FILE_NAMES: &[&str] = &[
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
];

const MAX_ENV_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvFileContents {
    pub name: String,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureProjectPresentResult {
    /// `"present"` when a matching checkout was reused, `"cloned"` when this
    /// call created one.
    pub status: String,
    pub project: Project,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownCheckout {
    pub path: String,
    pub is_folder: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsurePlan {
    Present { path: String },
    Clone { url: String, destination: String },
}

/// Identity key for a git remote URL.
///
/// SSH, HTTPS, and `git@` forms of the same repository compare equal.
/// Local paths and `file://` URLs compare as paths.
pub fn normalize_clone_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix("file://") {
        let path = rest.trim_end_matches('/');
        if path.is_empty() {
            return None;
        }
        return Some(path.to_string());
    }

    if trimmed.starts_with('/') || trimmed.starts_with(r"\\") {
        return Some(trimmed.to_string());
    }

    if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return host_path_identity(host, path);
    }

    for prefix in ["ssh://", "https://", "http://", "git://"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return url_identity(rest);
        }
    }

    None
}

fn url_identity(rest: &str) -> Option<String> {
    let without_user = match rest.rsplit_once('@') {
        Some((_, host_and_path)) => host_and_path,
        None => rest,
    };
    let (host_port, path) = without_user.split_once('/')?;
    let host = host_port.split(':').next().unwrap_or(host_port);
    host_path_identity(host, path)
}

fn host_path_identity(host: &str, path: &str) -> Option<String> {
    let host = host.trim().to_ascii_lowercase();
    let path = path.trim().trim_matches('/').trim_end_matches(".git");
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{}", path.to_ascii_lowercase()))
}

fn identity_set(urls: &[String]) -> HashSet<String> {
    urls.iter()
        .filter_map(|url| normalize_clone_url(url))
        .collect()
}

fn remotes_match(wanted: &HashSet<String>, remote_urls: &[String]) -> bool {
    if wanted.is_empty() {
        return false;
    }
    remote_urls
        .iter()
        .filter_map(|url| normalize_clone_url(url))
        .any(|url| wanted.contains(&url))
}

/// Decide whether this host already has the checkout or must clone it.
///
/// `read_remotes` returns the fetch URLs configured in that checkout. The
/// already-present path never asks to clone.
pub fn plan_ensure_present(
    clone_urls: &[String],
    checkouts: &[KnownCheckout],
    destination: &Path,
    read_remotes: impl Fn(&str) -> Vec<String>,
) -> Result<EnsurePlan, String> {
    let wanted = identity_set(clone_urls);
    if wanted.is_empty() {
        return Err(
            "This project has no git remote to clone from. Add a remote, then start again."
                .to_string(),
        );
    }

    for checkout in checkouts {
        if checkout.is_folder || checkout.path.is_empty() {
            continue;
        }
        if remotes_match(&wanted, &read_remotes(&checkout.path)) {
            return Ok(EnsurePlan::Present {
                path: checkout.path.clone(),
            });
        }
    }

    if destination.exists() {
        if remotes_match(&wanted, &read_remotes(&destination.display().to_string())) {
            return Ok(EnsurePlan::Present {
                path: destination.display().to_string(),
            });
        }
        return Err(format!(
            "Checkout path already exists and is not this project: {}",
            destination.display()
        ));
    }

    let url = clone_urls
        .iter()
        .find(|url| normalize_clone_url(url).is_some())
        .cloned()
        .ok_or_else(|| "This project has no git remote to clone from.".to_string())?;

    Ok(EnsurePlan::Clone {
        url,
        destination: destination.display().to_string(),
    })
}

pub fn default_checkout_dir(name: &str) -> Result<PathBuf, String> {
    let sanitized = sanitize_directory_name(name);
    let folder = if sanitized.is_empty() {
        "project".to_string()
    } else {
        sanitized
    };
    Ok(get_worktrees_base_dir()?.join("checkouts").join(folder))
}

pub async fn list_clone_urls(repo_path: String) -> Result<Vec<String>, String> {
    Ok(git::list_remote_urls(&repo_path))
}

pub async fn ensure_project_present(
    app: AppHandle,
    clone_urls: Vec<String>,
    name: String,
    operation_id: String,
) -> Result<EnsureProjectPresentResult, String> {
    let data = super::storage::load_projects_data(&app)?;
    let checkouts = data
        .projects
        .iter()
        .map(|project| KnownCheckout {
            path: project.path.clone(),
            is_folder: project.is_folder,
        })
        .collect::<Vec<_>>();
    let destination = default_checkout_dir(&name)?;
    let plan = plan_ensure_present(&clone_urls, &checkouts, &destination, |path| {
        git::list_remote_urls(path)
    })?;

    match plan {
        EnsurePlan::Present { path } => {
            if let Some(project) = data
                .projects
                .into_iter()
                .find(|project| project.path == path)
            {
                return Ok(EnsureProjectPresentResult {
                    status: "present".to_string(),
                    project,
                });
            }
            let project = add_project(app, path, None).await?;
            Ok(EnsureProjectPresentResult {
                status: "present".to_string(),
                project,
            })
        }
        EnsurePlan::Clone { url, destination } => {
            emit_ensure_progress(&app, &operation_id, None, "Cloning…");
            let app_for_progress = app.clone();
            let operation_id_for_progress = operation_id.clone();
            let url_for_clone = url;
            let destination_for_clone = destination.clone();
            let cloned = tokio::task::spawn_blocking(move || {
                let mut gate = CloneProgressGate::new();
                let result = git::clone_repo_with_progress(
                    &url_for_clone,
                    &destination_for_clone,
                    |progress| {
                        if gate.accept(&progress) {
                            emit_ensure_progress(
                                &app_for_progress,
                                &operation_id_for_progress,
                                progress.overall_percent,
                                &progress.line,
                            );
                        }
                    },
                );
                if let Some(progress) = gate.held.take() {
                    emit_ensure_progress(
                        &app_for_progress,
                        &operation_id_for_progress,
                        progress.overall_percent,
                        &progress.line,
                    );
                }
                result
            })
            .await
            .map_err(|error| format!("Clone task failed: {error}"))?;
            cloned?;
            let project = register_cloned_project(app, destination, None)?;
            Ok(EnsureProjectPresentResult {
                status: "cloned".to_string(),
                project,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnsureProgressEvent {
    operation_id: String,
    phase: &'static str,
    percent: Option<u8>,
    message: String,
}

fn emit_ensure_progress(app: &AppHandle, operation_id: &str, percent: Option<u8>, message: &str) {
    if operation_id.is_empty() {
        return;
    }
    let _ = app.emit_all(
        "project:ensure-progress",
        &EnsureProgressEvent {
            operation_id: operation_id.to_string(),
            phase: "clone",
            percent,
            message: message.to_string(),
        },
    );
}

/// Keep git status lines from flooding the websocket. Percent changes emit
/// immediately. Repeated lines at the same percent wait 100ms, and the newest
/// held line is emitted when the clone returns.
struct CloneProgressGate {
    last_emit: Instant,
    last_percent: Option<Option<u8>>,
    held: Option<GitCloneProgress>,
}

impl CloneProgressGate {
    fn new() -> Self {
        Self {
            last_emit: Instant::now() - Duration::from_secs(1),
            last_percent: None,
            held: None,
        }
    }

    fn accept(&mut self, progress: &GitCloneProgress) -> bool {
        let percent_changed = self.last_percent != Some(progress.overall_percent);
        let due = self.last_emit.elapsed() >= Duration::from_millis(100);
        if percent_changed || due {
            self.last_emit = Instant::now();
            self.last_percent = Some(progress.overall_percent);
            self.held = None;
            true
        } else {
            self.held = Some(progress.clone());
            false
        }
    }
}

pub fn is_allowed_env_file_name(name: &str) -> bool {
    ENV_FILE_NAMES.contains(&name)
}

pub fn list_project_env_files(project_path: String) -> Result<Vec<String>, String> {
    let root = Path::new(&project_path);
    if !root.is_dir() {
        return Err(format!("Project directory not found: {project_path}"));
    }
    Ok(ENV_FILE_NAMES
        .iter()
        .filter(|name| {
            let path = root.join(name);
            path.is_file() && !path.is_symlink()
        })
        .map(|name| (*name).to_string())
        .collect())
}

fn env_file_path(project_path: &str, name: &str) -> Result<PathBuf, String> {
    if !is_allowed_env_file_name(name) {
        return Err(format!(
            "Refusing to copy \"{name}\". Jean only copies project env files such as .env and .env.local."
        ));
    }
    let root = Path::new(project_path);
    if !root.is_dir() {
        return Err(format!("Project directory not found: {project_path}"));
    }
    let path = root.join(name);
    if path.is_symlink() {
        return Err(format!("Refusing to follow a symlink for {name}."));
    }
    Ok(path)
}

pub fn read_project_env_files(
    project_path: String,
    names: Vec<String>,
) -> Result<Vec<EnvFileContents>, String> {
    let mut files = Vec::with_capacity(names.len());
    for name in names {
        let path = env_file_path(&project_path, &name)?;
        let metadata =
            fs::metadata(&path).map_err(|error| format!("Failed to read {name}: {error}"))?;
        if !metadata.is_file() {
            return Err(format!("{name} is not a file in the project root."));
        }
        if metadata.len() > MAX_ENV_FILE_BYTES {
            return Err(format!("{name} is larger than 1MB. Copy it manually."));
        }
        let contents =
            fs::read_to_string(&path).map_err(|error| format!("Failed to read {name}: {error}"))?;
        files.push(EnvFileContents { name, contents });
    }
    Ok(files)
}

pub fn write_project_env_files(
    project_path: String,
    files: Vec<EnvFileContents>,
) -> Result<(), String> {
    for file in files {
        if file.contents.len() > MAX_ENV_FILE_BYTES as usize {
            return Err(format!("{} is larger than 1MB.", file.name));
        }
        let path = env_file_path(&project_path, &file.name)?;
        write_private_file(&path, file.contents.as_bytes())
            .map_err(|error| format!("Failed to write {}: {error}", file.name))?;
    }
    Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Jean")
            .env("GIT_AUTHOR_EMAIL", "jean@example.com")
            .env("GIT_COMMITTER_NAME", "Jean")
            .env("GIT_COMMITTER_EMAIL", "jean@example.com")
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]);
        git(dir, &["config", "user.email", "jean@example.com"]);
        git(dir, &["config", "user.name", "Jean"]);
        fs::write(dir.join("README.md"), "hello").unwrap();
        git(dir, &["add", "README.md"]);
        git(dir, &["commit", "-m", "init"]);
    }

    #[test]
    fn progress_gate_emits_percent_changes_and_holds_repeats() {
        let mut gate = CloneProgressGate::new();
        let first = GitCloneProgress {
            percent: Some(10),
            overall_percent: Some(25),
            line: "Receiving objects: 10%".to_string(),
        };
        let repeat = GitCloneProgress {
            percent: Some(10),
            overall_percent: Some(25),
            line: "Receiving objects: 10%, 2 MiB".to_string(),
        };
        let next = GitCloneProgress {
            percent: Some(11),
            overall_percent: Some(26),
            line: "Receiving objects: 11%".to_string(),
        };
        assert!(gate.accept(&first));
        assert!(!gate.accept(&repeat));
        assert!(gate.held.as_ref().unwrap().line.contains("2 MiB"));
        assert!(gate.accept(&next));
        assert!(gate.held.is_none());
    }

    #[test]
    fn normalize_treats_ssh_and_https_as_the_same_repo() {
        let https = normalize_clone_url("https://github.com/coollabsio/jean.git").unwrap();
        let ssh = normalize_clone_url("git@github.com:coollabsio/jean.git").unwrap();
        let port = normalize_clone_url("ssh://git@github.com:22/coollabsio/jean").unwrap();
        assert_eq!(https, "github.com/coollabsio/jean");
        assert_eq!(ssh, https);
        assert_eq!(port, https);
    }

    #[test]
    fn missing_checkout_clones_and_a_second_plan_skips_clone() {
        let source = tempfile::tempdir().unwrap();
        init_repo(source.path());
        let remote = "https://github.com/coollabsio/jean.git";
        git(source.path(), &["remote", "add", "origin", remote]);

        let parent = tempfile::tempdir().unwrap();
        let destination = parent.path().join("jean");
        let urls = vec![remote.to_string()];

        let plan = plan_ensure_present(&urls, &[], &destination, |_| Vec::new()).unwrap();
        assert_eq!(
            plan,
            EnsurePlan::Clone {
                url: remote.to_string(),
                destination: destination.display().to_string(),
            }
        );

        let file_url = format!("file://{}", source.path().display());
        let status = Command::new("git")
            .args(["clone", &file_url, destination.to_str().unwrap()])
            .status()
            .expect("git clone");
        assert!(status.success(), "git clone failed");
        // The cloned checkout's origin is the local source path. Point origin
        // at the same URL the planner was given, matching a real remote clone.
        git(&destination, &["remote", "set-url", "origin", remote]);

        let checkouts = vec![KnownCheckout {
            path: destination.display().to_string(),
            is_folder: false,
        }];
        let again =
            plan_ensure_present(&urls, &checkouts, &destination, git::list_remote_urls).unwrap();
        assert_eq!(
            again,
            EnsurePlan::Present {
                path: destination.display().to_string(),
            }
        );
    }

    #[test]
    fn already_present_checkout_is_reused_without_a_clone_plan() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path());
        let remote = "git@github.com:acme/demo.git";
        git(repo.path(), &["remote", "add", "origin", remote]);

        let plan = plan_ensure_present(
            &["https://github.com/acme/demo.git".to_string()],
            &[KnownCheckout {
                path: repo.path().display().to_string(),
                is_folder: false,
            }],
            Path::new("/unused/does-not-exist"),
            git::list_remote_urls,
        )
        .unwrap();

        assert_eq!(
            plan,
            EnsurePlan::Present {
                path: repo.path().display().to_string(),
            }
        );
    }

    #[test]
    fn env_copy_lists_allowlisted_files_and_rejects_other_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".env"), "TOKEN=1").unwrap();
        fs::write(dir.path().join(".env.local"), "LOCAL=1").unwrap();
        fs::write(dir.path().join(".env.backup"), "nope").unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("nested").join(".env"), "nested").unwrap();

        let listed = list_project_env_files(dir.path().display().to_string()).unwrap();
        assert_eq!(listed, vec![".env".to_string(), ".env.local".to_string()]);

        let error = read_project_env_files(
            dir.path().display().to_string(),
            vec!["../.env".to_string()],
        )
        .unwrap_err();
        assert!(error.contains("Refusing"));

        let dest = tempfile::tempdir().unwrap();
        let files = read_project_env_files(dir.path().display().to_string(), listed).unwrap();
        write_project_env_files(dest.path().display().to_string(), files).unwrap();
        assert_eq!(
            fs::read_to_string(dest.path().join(".env")).unwrap(),
            "TOKEN=1"
        );
        assert_eq!(
            fs::read_to_string(dest.path().join(".env.local")).unwrap(),
            "LOCAL=1"
        );
    }
}
