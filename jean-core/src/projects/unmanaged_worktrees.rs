//! Discover git worktrees that exist on disk but are not tracked by Jean.
//!
//! Parsing is pure so tests can cover `git worktree list --porcelain` without
//! spawning git. The command in `commands.rs` supplies the project path and
//! the paths Jean already tracks for that project, including archived
//! worktrees (`archived_at` is set).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::platform::wsl_aware_command;

/// One git worktree Jean does not already track for the project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmanagedWorktree {
    pub path: String,
    /// Branch name without `refs/heads/`. Absent for detached and bare checkouts.
    pub branch: Option<String>,
    /// Full HEAD oid from porcelain, or empty when git did not print one.
    pub head: String,
    /// First 7 characters of `head`, matching `git rev-parse --short`'s default width.
    pub head_short: String,
    pub prunable: bool,
    pub locked: bool,
    pub detached: bool,
    pub bare: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitWorktreeListEntry {
    path: String,
    head: String,
    branch: Option<String>,
    prunable: bool,
    locked: bool,
    detached: bool,
    bare: bool,
}

/// Run `git worktree list --porcelain` and return worktrees Jean is not tracking.
pub fn list_unmanaged_from_repo(
    project_path: &str,
    tracked_paths: &[String],
) -> Result<Vec<UnmanagedWorktree>, String> {
    let output = wsl_aware_command("git", Some(Path::new(project_path)))
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|error| format!("Failed to run git worktree list: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list worktrees: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(unmanaged_worktrees_from_porcelain(
        &stdout,
        project_path,
        tracked_paths,
    ))
}

/// Parse porcelain output and drop the main checkout plus already-tracked paths.
pub fn unmanaged_worktrees_from_porcelain(
    porcelain: &str,
    project_path: &str,
    tracked_paths: &[String],
) -> Vec<UnmanagedWorktree> {
    let entries = parse_worktree_list_porcelain(porcelain);
    filter_unmanaged_worktrees(&entries, project_path, tracked_paths)
}

fn parse_worktree_list_porcelain(output: &str) -> Vec<GitWorktreeListEntry> {
    let mut entries = Vec::new();
    let mut current: Option<PartialEntry> = None;

    for line in output.lines() {
        if line.is_empty() {
            flush_entry(&mut current, &mut entries);
            continue;
        }

        if let Some(path) = line.strip_prefix("worktree ") {
            flush_entry(&mut current, &mut entries);
            current = Some(PartialEntry {
                path: path.to_string(),
                ..PartialEntry::default()
            });
            continue;
        }

        let Some(entry) = current.as_mut() else {
            continue;
        };

        if let Some(head) = line.strip_prefix("HEAD ") {
            entry.head = head.trim().to_string();
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            entry.branch_ref = Some(branch_ref.trim().to_string());
        } else if line == "detached" {
            entry.detached = true;
        } else if line == "bare" {
            entry.bare = true;
        } else if line == "locked" || line.starts_with("locked ") {
            entry.locked = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            entry.prunable = true;
        }
    }

    flush_entry(&mut current, &mut entries);
    entries
}

fn filter_unmanaged_worktrees(
    entries: &[GitWorktreeListEntry],
    project_path: &str,
    tracked_paths: &[String],
) -> Vec<UnmanagedWorktree> {
    let project_key = comparable_worktree_path(project_path);
    let tracked: HashSet<String> = tracked_paths
        .iter()
        .map(|path| comparable_worktree_path(path))
        .collect();

    // `git worktree list` prints the main working tree first. That checkout is
    // the repository itself, not a worktree to import.
    entries
        .iter()
        .skip(1)
        .filter(|entry| {
            let key = comparable_worktree_path(&entry.path);
            key != project_key && !tracked.contains(&key)
        })
        .cloned()
        .map(GitWorktreeListEntry::into_unmanaged)
        .collect()
}

#[derive(Default)]
struct PartialEntry {
    path: String,
    head: String,
    branch_ref: Option<String>,
    prunable: bool,
    locked: bool,
    detached: bool,
    bare: bool,
}

fn flush_entry(current: &mut Option<PartialEntry>, entries: &mut Vec<GitWorktreeListEntry>) {
    let Some(entry) = current.take() else {
        return;
    };
    if entry.path.is_empty() {
        return;
    }

    let branch = if entry.detached || entry.bare {
        None
    } else {
        entry.branch_ref.map(|branch_ref| {
            branch_ref
                .strip_prefix("refs/heads/")
                .unwrap_or(&branch_ref)
                .to_string()
        })
    };

    entries.push(GitWorktreeListEntry {
        path: entry.path,
        head: entry.head,
        branch,
        prunable: entry.prunable,
        locked: entry.locked,
        detached: entry.detached,
        bare: entry.bare,
    });
}

impl GitWorktreeListEntry {
    fn into_unmanaged(self) -> UnmanagedWorktree {
        UnmanagedWorktree {
            head_short: short_head(&self.head),
            path: self.path,
            branch: self.branch,
            head: self.head,
            prunable: self.prunable,
            locked: self.locked,
            detached: self.detached,
            bare: self.bare,
        }
    }
}

fn short_head(head: &str) -> String {
    let trimmed = head.trim();
    if trimmed.len() <= 7 {
        trimmed.to_string()
    } else {
        trimmed[..7].to_string()
    }
}

/// Compare worktree paths the way Jean stores them: ignore trailing separators,
/// and resolve the real path when the directory exists.
pub fn comparable_worktree_path(path: &str) -> String {
    let canonical = Path::new(path)
        .canonicalize()
        .ok()
        .map(strip_windows_verbatim_prefix)
        .map(|canonical| canonical.to_string_lossy().into_owned());
    normalize_worktree_path(canonical.as_deref().unwrap_or(path))
}

fn normalize_worktree_path(path: &str) -> String {
    let trimmed = path.trim();
    let stripped = trimmed.trim_end_matches(['/', '\\']);
    let base = if stripped.is_empty() {
        trimmed
    } else {
        stripped
    };
    if cfg!(windows) {
        base.replace('/', "\\").to_ascii_lowercase()
    } else {
        base.to_string()
    }
}

fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::{unmanaged_worktrees_from_porcelain, UnmanagedWorktree};

    fn sample_porcelain() -> &'static str {
        "\
worktree /jean-test/repo
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /jean-test/repo/.worktrees/feature login
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feature/login

worktree /jean-test/already-imported/
HEAD cccccccccccccccccccccccccccccccccccccccc
branch refs/heads/already-imported

worktree /jean-test/archived
HEAD dddddddddddddddddddddddddddddddddddddddd
branch refs/heads/archived-feature

worktree /jean-test/detached
HEAD eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
detached

worktree /jean-test/locked
HEAD ffffffffffffffffffffffff
branch refs/heads/locked-feature
locked reason: index in use

worktree /jean-test/prunable
HEAD 1234abcd
branch refs/heads/gone
prunable gitdir file points to non-existent location

worktree /jean-test/bare-linked
HEAD 9999999999999999999999999999999999999999
bare
locked
"
    }

    fn listed(tracked: &[&str]) -> Vec<UnmanagedWorktree> {
        let tracked_paths: Vec<String> = tracked.iter().map(|path| (*path).to_string()).collect();
        unmanaged_worktrees_from_porcelain(sample_porcelain(), "/jean-test/repo", &tracked_paths)
    }

    #[test]
    fn excludes_main_checkout_active_worktrees_and_archived_paths() {
        let listed = listed(&["/jean-test/already-imported", "/jean-test/archived/"]);

        let paths: Vec<&str> = listed.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "/jean-test/repo/.worktrees/feature login",
                "/jean-test/detached",
                "/jean-test/locked",
                "/jean-test/prunable",
                "/jean-test/bare-linked",
            ]
        );
        assert!(!paths.contains(&"/jean-test/repo"));
        assert!(!paths.contains(&"/jean-test/already-imported/"));
        assert!(!paths.contains(&"/jean-test/archived"));
    }

    #[test]
    fn flags_detached_locked_prunable_and_bare_and_shortens_head() {
        let listed = listed(&[]);
        let by_path = |path: &str| {
            listed
                .iter()
                .find(|entry| entry.path == path)
                .unwrap_or_else(|| panic!("missing {path}"))
        };

        let feature = by_path("/jean-test/repo/.worktrees/feature login");
        assert_eq!(feature.branch.as_deref(), Some("feature/login"));
        assert_eq!(feature.head_short, "bbbbbbb");
        assert!(!feature.detached);
        assert!(!feature.locked);
        assert!(!feature.prunable);
        assert!(!feature.bare);

        let detached = by_path("/jean-test/detached");
        assert_eq!(detached.branch, None);
        assert!(detached.detached);
        assert_eq!(detached.head_short, "eeeeeee");

        let locked = by_path("/jean-test/locked");
        assert!(locked.locked);
        assert_eq!(locked.branch.as_deref(), Some("locked-feature"));
        assert_eq!(locked.head_short, "fffffff");

        let prunable = by_path("/jean-test/prunable");
        assert!(prunable.prunable);
        assert_eq!(prunable.head, "1234abcd");
        assert_eq!(prunable.head_short, "1234abc");

        let bare = by_path("/jean-test/bare-linked");
        assert!(bare.bare);
        assert!(bare.locked);
        assert_eq!(bare.branch, None);
    }

    #[test]
    fn excludes_the_project_checkout_when_it_is_not_the_main_worktree() {
        let porcelain = "\
worktree /jean-test/repo
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /jean-test/linked-project
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/linked

worktree /jean-test/other
HEAD cccccccccccccccccccccccccccccccccccccccc
branch refs/heads/other
";
        let listed =
            unmanaged_worktrees_from_porcelain(porcelain, "/jean-test/linked-project/", &[]);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, "/jean-test/other");
        assert_eq!(listed[0].branch.as_deref(), Some("other"));
    }

    #[test]
    fn empty_and_main_only_porcelain_return_nothing() {
        assert!(unmanaged_worktrees_from_porcelain("", "/jean-test/repo", &[]).is_empty());
        let main_only = "\
worktree /jean-test/repo
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main
";
        assert!(unmanaged_worktrees_from_porcelain(main_only, "/jean-test/repo", &[]).is_empty());
    }
}
