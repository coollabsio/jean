use serde::{Deserialize, Serialize};

/// Type of session (base branch or worktree)
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionType {
    /// Standard worktree session (git worktree)
    #[default]
    Worktree,
    /// Base branch session (uses project's base directory directly)
    Base,
}

/// Type of merge operation for merging worktree to base
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MergeType {
    /// Standard merge with --no-ff, creates merge commit
    Merge,
    /// Squash merge, combines all commits into one
    Squash,
    /// Rebase then fast-forward, creates linear history
    Rebase,
}

/// Jean configuration from jean.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JeanConfig {
    #[serde(default)]
    pub scripts: JeanScripts,
}

/// Scripts section of jean.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct JeanScripts {
    /// Script to run after worktree creation
    pub setup: Option<String>,
    /// Script to run the dev environment
    pub run: Option<String>,
}

/// A git project that has been added to Jean, or a folder for organizing projects
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Unique identifier (UUID v4)
    pub id: String,
    /// Display name (derived from repo directory name, or folder name)
    pub name: String,
    /// Absolute path to the original git repository (empty for folders)
    pub path: String,
    /// Branch to create worktrees from (empty for folders)
    pub default_branch: String,
    /// Unix timestamp when project was added
    pub added_at: u64,
    /// Display order in sidebar (lower = higher in list)
    #[serde(default)]
    pub order: u32,
    /// Parent folder ID (None = root level)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// True if this is a folder (not a real project)
    #[serde(default)]
    pub is_folder: bool,
    /// Path to custom avatar image (relative to app data dir, e.g., "avatars/abc123.png")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_path: Option<String>,
    /// Git provider detected from remote URL ("github", "gitlab", or "other")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_provider: Option<String>,
}

/// A git worktree created for a project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    /// Unique identifier (UUID v4)
    pub id: String,
    /// Foreign key to Project
    pub project_id: String,
    /// Random workspace name (e.g., "fuzzy-tiger")
    pub name: String,
    /// Absolute path to worktree (~/jean/<project>/<name>)
    pub path: String,
    /// Git branch name (same as workspace name)
    pub branch: String,
    /// Unix timestamp when worktree was created
    pub created_at: u64,
    /// Output from setup script (if any)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_output: Option<String>,
    /// The setup script that was executed (if any)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_script: Option<String>,
    /// Type of session (defaults to Worktree for backward compatibility)
    #[serde(default)]
    pub session_type: SessionType,
    /// GitHub PR number (if a PR has been created)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u32>,
    /// GitHub PR URL (if a PR has been created)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    /// Cached PR display status (draft, open, review, merged, closed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_pr_status: Option<String>,
    /// Cached CI check status (success, failure, pending, error)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_check_status: Option<String>,
    /// Cached git behind count (commits behind base branch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_behind_count: Option<u32>,
    /// Cached git ahead count (commits ahead of base branch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_ahead_count: Option<u32>,
    /// Unix timestamp when status was last checked
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_status_at: Option<u64>,
    /// Cached uncommitted additions (lines added in working directory)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_uncommitted_added: Option<u32>,
    /// Cached uncommitted deletions (lines removed in working directory)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_uncommitted_removed: Option<u32>,
    /// Cached branch diff additions (lines added vs base branch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_branch_diff_added: Option<u32>,
    /// Cached branch diff deletions (lines removed vs base branch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_branch_diff_removed: Option<u32>,
    /// Cached base branch ahead count (unpushed commits on base branch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_base_branch_ahead_count: Option<u32>,
    /// Cached base branch behind count (commits behind on base branch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_base_branch_behind_count: Option<u32>,
    /// Cached worktree ahead count (commits unique to worktree, ahead of local base)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_worktree_ahead_count: Option<u32>,
    /// Cached unpushed count (commits in HEAD not yet pushed to origin/current_branch)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_unpushed_count: Option<u32>,
    /// Display order within project (lower = higher in list, base sessions ignore this)
    #[serde(default)]
    pub order: u32,
    /// Unix timestamp when worktree was archived (None = not archived)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<u64>,
    /// Override AI CLI provider for this worktree (None = use global default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_provider: Option<String>,
    /// Override AI model for this worktree (None = use global default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_model: Option<String>,
}

/// Container for all persisted project data
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectsData {
    pub projects: Vec<Project>,
    pub worktrees: Vec<Worktree>,
}

impl ProjectsData {
    /// Get all worktrees for a specific project
    pub fn worktrees_for_project(&self, project_id: &str) -> Vec<&Worktree> {
        self.worktrees
            .iter()
            .filter(|w| w.project_id == project_id)
            .collect()
    }

    /// Find a project by ID
    pub fn find_project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    /// Find a project by ID (mutable)
    #[allow(dead_code)]
    pub fn find_project_mut(&mut self, id: &str) -> Option<&mut Project> {
        self.projects.iter_mut().find(|p| p.id == id)
    }

    /// Find a worktree by ID
    pub fn find_worktree(&self, id: &str) -> Option<&Worktree> {
        self.worktrees.iter().find(|w| w.id == id)
    }

    /// Find a worktree by ID (mutable)
    pub fn find_worktree_mut(&mut self, id: &str) -> Option<&mut Worktree> {
        self.worktrees.iter_mut().find(|w| w.id == id)
    }

    /// Add a project
    pub fn add_project(&mut self, project: Project) {
        self.projects.push(project);
    }

    /// Remove a project by ID
    pub fn remove_project(&mut self, id: &str) -> Option<Project> {
        if let Some(pos) = self.projects.iter().position(|p| p.id == id) {
            Some(self.projects.remove(pos))
        } else {
            None
        }
    }

    /// Add a worktree
    pub fn add_worktree(&mut self, worktree: Worktree) {
        self.worktrees.push(worktree);
    }

    /// Remove a worktree by ID
    pub fn remove_worktree(&mut self, id: &str) -> Option<Worktree> {
        if let Some(pos) = self.worktrees.iter().position(|w| w.id == id) {
            Some(self.worktrees.remove(pos))
        } else {
            None
        }
    }

    /// Check if a worktree name already exists for a project
    pub fn worktree_name_exists(&self, project_id: &str, name: &str) -> bool {
        self.worktrees
            .iter()
            .any(|w| w.project_id == project_id && w.name == name)
    }

    /// Check if a project already has a base session
    #[allow(dead_code)]
    pub fn has_base_session(&self, project_id: &str) -> bool {
        self.worktrees
            .iter()
            .any(|w| w.project_id == project_id && w.session_type == SessionType::Base)
    }

    /// Find the base session for a project
    pub fn find_base_session(&self, project_id: &str) -> Option<&Worktree> {
        self.worktrees
            .iter()
            .find(|w| w.project_id == project_id && w.session_type == SessionType::Base)
    }

    // =========================================================================
    // Folder-related methods
    // =========================================================================

    /// Get children (projects/folders) of a parent (None = root level)
    pub fn get_children(&self, parent_id: Option<&str>) -> Vec<&Project> {
        self.projects
            .iter()
            .filter(|p| p.parent_id.as_deref() == parent_id)
            .collect()
    }

    /// Get nesting level of an item (0 = root)
    pub fn get_nesting_level(&self, project_id: &str) -> u32 {
        let mut level = 0;
        let mut current_id = Some(project_id.to_string());
        while let Some(id) = current_id {
            if let Some(p) = self.find_project(&id) {
                current_id = p.parent_id.clone();
                if current_id.is_some() {
                    level += 1;
                }
            } else {
                break;
            }
        }
        level
    }

    /// Check if folder is empty (no children)
    pub fn folder_is_empty(&self, folder_id: &str) -> bool {
        !self
            .projects
            .iter()
            .any(|p| p.parent_id.as_deref() == Some(folder_id))
    }

    /// Check if an item is a descendant of another
    pub fn is_descendant_of(&self, item_id: &str, potential_ancestor_id: &str) -> bool {
        let mut current_id = Some(item_id.to_string());
        while let Some(id) = current_id {
            if id == potential_ancestor_id {
                return true;
            }
            if let Some(p) = self.find_project(&id) {
                current_id = p.parent_id.clone();
            } else {
                break;
            }
        }
        false
    }

    /// Get max subtree depth from an item (how deep its descendants go)
    pub fn get_max_subtree_depth(&self, item_id: &str) -> u32 {
        let children: Vec<&Project> = self
            .projects
            .iter()
            .filter(|p| p.parent_id.as_deref() == Some(item_id))
            .collect();

        if children.is_empty() {
            return 0;
        }

        children
            .iter()
            .map(|child| 1 + self.get_max_subtree_depth(&child.id))
            .max()
            .unwrap_or(0)
    }

    /// Check if moving would exceed max depth (3 levels of folders, items allowed at depth 3)
    pub fn would_exceed_max_depth(&self, item_id: &str, new_parent_id: Option<&str>) -> bool {
        let parent_depth = new_parent_id
            .map(|pid| self.get_nesting_level(pid) + 1)
            .unwrap_or(0);
        let item_subtree_depth = self.get_max_subtree_depth(item_id);
        parent_depth + item_subtree_depth > 3
    }

    /// Get the next order value for items at a given level
    pub fn get_next_order(&self, parent_id: Option<&str>) -> u32 {
        self.get_children(parent_id)
            .iter()
            .map(|p| p.order)
            .max()
            .map(|max| max + 1)
            .unwrap_or(0)
    }

    /// Check if a folder name already exists at the given level (excluding a specific item)
    pub fn folder_name_exists(
        &self,
        name: &str,
        parent_id: Option<&str>,
        exclude_id: Option<&str>,
    ) -> bool {
        self.get_children(parent_id).iter().any(|p| {
            p.is_folder
                && p.name.eq_ignore_ascii_case(name)
                && exclude_id.is_none_or(|id| p.id != id)
        })
    }
}

// =============================================================================
// Worktree Creation Events (for background worktree creation)
// =============================================================================

/// Event emitted when worktree creation starts (background operation)
#[derive(Clone, Serialize)]
pub struct WorktreeCreatingEvent {
    /// The worktree ID (generated upfront)
    pub id: String,
    /// The project ID
    pub project_id: String,
    /// The worktree name
    pub name: String,
    /// The worktree path
    pub path: String,
    /// The branch name
    pub branch: String,
}

/// Event emitted when worktree creation completes successfully
#[derive(Clone, Serialize)]
pub struct WorktreeCreatedEvent {
    /// The fully created worktree
    pub worktree: Worktree,
}

/// Event emitted when worktree creation fails
#[derive(Clone, Serialize)]
pub struct WorktreeCreateErrorEvent {
    /// The worktree ID that failed
    pub id: String,
    /// The project ID
    pub project_id: String,
    /// The error message
    pub error: String,
}

// =============================================================================
// Worktree Deletion Events (for background worktree deletion)
// =============================================================================

/// Event emitted when worktree deletion starts (background operation)
#[derive(Clone, Serialize)]
pub struct WorktreeDeletingEvent {
    /// The worktree ID being deleted
    pub id: String,
    /// The project ID
    pub project_id: String,
}

/// Event emitted when worktree deletion completes successfully
#[derive(Clone, Serialize)]
pub struct WorktreeDeletedEvent {
    /// The worktree ID that was deleted
    pub id: String,
    /// The project ID
    pub project_id: String,
}

/// Event emitted when worktree deletion fails
#[derive(Clone, Serialize)]
pub struct WorktreeDeleteErrorEvent {
    /// The worktree ID that failed to delete
    pub id: String,
    /// The project ID
    pub project_id: String,
    /// The error message
    pub error: String,
}

// =============================================================================
// Worktree Archive Events (for archive/unarchive operations)
// =============================================================================

/// Event emitted when worktree is archived
#[derive(Clone, Serialize)]
pub struct WorktreeArchivedEvent {
    /// The worktree ID that was archived
    pub id: String,
    /// The project ID
    pub project_id: String,
}

/// Event emitted when worktree is unarchived (restored)
#[derive(Clone, Serialize)]
pub struct WorktreeUnarchivedEvent {
    /// The restored worktree
    pub worktree: Worktree,
}

/// Event emitted when worktree is permanently deleted
#[derive(Clone, Serialize)]
pub struct WorktreePermanentlyDeletedEvent {
    /// The worktree ID that was permanently deleted
    pub id: String,
    /// The project ID
    pub project_id: String,
}

/// Event emitted when worktree path already exists
#[derive(Clone, Serialize)]
pub struct WorktreePathExistsEvent {
    /// The pending worktree ID that failed
    pub id: String,
    /// The project ID
    pub project_id: String,
    /// The conflicting path
    pub path: String,
    /// Suggested alternative name (with incremented suffix)
    pub suggested_name: String,
    /// If the path matches an archived worktree, its ID (for restore option)
    pub archived_worktree_id: Option<String>,
    /// Name of the archived worktree (for display)
    pub archived_worktree_name: Option<String>,
    /// Issue context to use when creating a new worktree with the suggested name
    pub issue_context: Option<super::github_issues::IssueContext>,
}

/// Event emitted when worktree creation fails because the branch already exists
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeBranchExistsEvent {
    /// The pending worktree ID that failed
    pub id: String,
    /// The project ID
    pub project_id: String,
    /// The conflicting branch name
    pub branch: String,
    /// Suggested alternative name (with incremented suffix)
    pub suggested_name: String,
    /// Issue context to use when creating a new worktree with the suggested name
    pub issue_context: Option<super::github_issues::IssueContext>,
    /// PR context to use when creating a new worktree with the suggested name
    pub pr_context: Option<super::github_issues::PullRequestContext>,
}
