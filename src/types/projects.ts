/**
 * Type of session (base branch or worktree)
 */
export type SessionType = 'worktree' | 'base'

/**
 * Status of a worktree (for tracking background operations)
 */
export type WorktreeStatus = 'pending' | 'ready' | 'error' | 'deleting'

/**
 * Check if a worktree is a base session
 */
export function isBaseSession(worktree: Worktree): boolean {
  return worktree.session_type === 'base'
}

/**
 * A git project that has been added to Jean, or a folder for organizing projects
 */
export interface Project {
  /** Unique identifier (UUID v4) */
  id: string
  /** Display name (derived from repo directory name, or folder name) */
  name: string
  /** Absolute path to the original git repository (empty for folders) */
  path: string
  /** Branch to create worktrees from (empty for folders) */
  default_branch: string
  /** Unix timestamp when project was added */
  added_at: number
  /** Display order in sidebar (lower = higher in list) */
  order: number
  /** Parent folder ID (undefined = root level) */
  parent_id?: string
  /** True if this is a folder (not a real project) */
  is_folder?: boolean
  /** Path to custom avatar image (relative to app data dir, e.g., "avatars/abc123.png") */
  avatar_path?: string
  /** Git provider detected from remote URL ("github", "gitlab", or "other") */
  git_provider?: 'github' | 'gitlab' | 'other'
}

/**
 * Check if a project entry is a folder
 */
export function isFolder(project: Project): boolean {
  return project.is_folder === true
}

/**
 * A git worktree created for a project
 */
export interface Worktree {
  /** Unique identifier (UUID v4) */
  id: string
  /** Foreign key to Project */
  project_id: string
  /** Random workspace name (e.g., "fuzzy-tiger") */
  name: string
  /** Absolute path to worktree (~/jean/<project>/<name>) */
  path: string
  /** Git branch name (same as workspace name) */
  branch: string
  /** Unix timestamp when worktree was created */
  created_at: number
  /** Output from setup script (if any) */
  setup_output?: string
  /** The setup script that was executed (if any) */
  setup_script?: string
  /** Type of session (defaults to 'worktree' for backward compatibility) */
  session_type?: SessionType
  /** Status of worktree creation (pending while being created in background) */
  status?: WorktreeStatus
  /** GitHub PR number (if a PR has been created) */
  pr_number?: number
  /** GitHub PR URL (if a PR has been created) */
  pr_url?: string
  /** Cached PR display status (draft, open, review, merged, closed) */
  cached_pr_status?: string
  /** Cached CI check status (success, failure, pending, error) */
  cached_check_status?: string
  /** Cached git behind count (commits behind base branch) */
  cached_behind_count?: number
  /** Cached git ahead count (commits ahead of base branch) */
  cached_ahead_count?: number
  /** Unix timestamp when status was last checked */
  cached_status_at?: number
  /** Cached uncommitted additions (lines added in working directory) */
  cached_uncommitted_added?: number
  /** Cached uncommitted deletions (lines removed in working directory) */
  cached_uncommitted_removed?: number
  /** Cached branch diff additions (lines added vs base branch) */
  cached_branch_diff_added?: number
  /** Cached branch diff deletions (lines removed vs base branch) */
  cached_branch_diff_removed?: number
  /** Cached base branch ahead count (unpushed commits on base branch) */
  cached_base_branch_ahead_count?: number
  /** Cached base branch behind count (commits behind on base branch) */
  cached_base_branch_behind_count?: number
  /** Cached worktree ahead count (commits unique to worktree, ahead of local base) */
  cached_worktree_ahead_count?: number
  /** Cached unpushed count (commits not yet pushed to origin/current_branch) */
  cached_unpushed_count?: number
  /** Display order within project (lower = higher in list, base sessions ignore this) */
  order: number
  /** Unix timestamp when worktree was archived (undefined = not archived) */
  archived_at?: number
  /** Override AI CLI provider for this worktree (undefined = use global default) */
  ai_provider?: string
  /** Override AI model for this worktree (undefined = use global default) */
  ai_model?: string
}

// =============================================================================
// Worktree Creation Events (from Rust backend)
// =============================================================================

/** Event payload when worktree creation starts */
export interface WorktreeCreatingEvent {
  id: string
  project_id: string
  name: string
  path: string
  branch: string
}

/** Event payload when worktree creation completes */
export interface WorktreeCreatedEvent {
  worktree: Worktree
}

/** Event payload when worktree creation fails */
export interface WorktreeCreateErrorEvent {
  id: string
  project_id: string
  error: string
}

// =============================================================================
// Worktree Deletion Events (from Rust backend)
// =============================================================================

/** Event payload when worktree deletion starts */
export interface WorktreeDeletingEvent {
  id: string
  project_id: string
}

/** Event payload when worktree deletion completes */
export interface WorktreeDeletedEvent {
  id: string
  project_id: string
}

/** Event payload when worktree deletion fails */
export interface WorktreeDeleteErrorEvent {
  id: string
  project_id: string
  error: string
}

// =============================================================================
// Worktree Archive Events (from Rust backend)
// =============================================================================

/** Event payload when worktree is archived */
export interface WorktreeArchivedEvent {
  id: string
  project_id: string
}

/** Event payload when worktree is unarchived (restored) */
export interface WorktreeUnarchivedEvent {
  worktree: Worktree
}

/** Event payload when worktree is permanently deleted */
export interface WorktreePermanentlyDeletedEvent {
  id: string
  project_id: string
}

/** Event payload when worktree path already exists */
export interface WorktreePathExistsEvent {
  /** The pending worktree ID that failed */
  id: string
  /** The project ID */
  project_id: string
  /** The conflicting path */
  path: string
  /** Suggested alternative name (with incremented suffix) */
  suggested_name: string
  /** If the path matches an archived worktree, its ID (for restore option) */
  archived_worktree_id?: string
  /** Name of the archived worktree (for display) */
  archived_worktree_name?: string
  /** Issue context to use when creating a new worktree with the suggested name */
  issue_context?: {
    number: number
    title: string
    body?: string
    comments: Array<{
      author: { login: string }
      body: string
      createdAt: string
    }>
  }
}

/** Event emitted when worktree creation fails because branch already exists */
export interface WorktreeBranchExistsEvent {
  /** The pending worktree ID that failed */
  id: string
  /** The project ID */
  project_id: string
  /** The conflicting branch name */
  branch: string
  /** Suggested alternative name (with incremented suffix) */
  suggested_name: string
  /** Issue context to use when creating a new worktree with the suggested name */
  issue_context?: {
    number: number
    title: string
    body?: string
    comments: Array<{
      author: { login: string }
      body: string
      createdAt: string
    }>
  }
  /** PR context to use when creating a new worktree with the suggested name */
  pr_context?: {
    number: number
    title: string
    body?: string
    headRefName: string
    baseRefName: string
    comments: Array<{
      author: { login: string }
      body: string
      createdAt: string
    }>
    reviews: Array<{
      author: { login: string }
      body: string
      state: string
      submittedAt: string
    }>
    diff?: string
  }
}

// =============================================================================
// AI-Powered PR Creation
// =============================================================================

/** Response from creating a PR with AI-generated content */
export interface CreatePrResponse {
  /** PR number on GitHub */
  pr_number: number
  /** Full URL to the PR */
  pr_url: string
  /** AI-generated PR title */
  title: string
}

// =============================================================================
// AI-Powered Commit Creation
// =============================================================================

/** Response from creating a commit with AI-generated message */
export interface CreateCommitResponse {
  /** Git commit hash */
  commit_hash: string
  /** AI-generated commit message */
  message: string
  /** Whether the commit was pushed to remote */
  pushed: boolean
}

// =============================================================================
// AI-Powered Code Review
// =============================================================================

/** A single finding from an AI code review */
export interface ReviewFinding {
  /** Severity level of the finding */
  severity: 'critical' | 'warning' | 'suggestion' | 'praise'
  /** File path where the finding applies */
  file: string
  /** Line number if applicable */
  line?: number
  /** Short title for the finding */
  title: string
  /** Detailed explanation of the finding */
  description: string
  /** Optional code suggestion or fix */
  suggestion?: string
}

/** Response from running an AI code review */
export interface ReviewResponse {
  /** Brief summary of the overall changes */
  summary: string
  /** List of review findings */
  findings: ReviewFinding[]
  /** Overall review verdict */
  approval_status: 'approved' | 'changes_requested' | 'needs_discussion'
}

// =============================================================================
// Local Merge
// =============================================================================

/** Type of merge operation */
export type MergeType = 'merge' | 'squash' | 'rebase'

/** Response from merge_worktree_to_base command */
export interface MergeWorktreeResponse {
  /** Whether the merge completed successfully */
  success: boolean
  /** Commit hash if successful */
  commit_hash?: string
  /** List of conflicting files if merge had conflicts */
  conflicts?: string[]
  /** Diff showing the conflict details */
  conflict_diff?: string
  /** Whether worktree was cleaned up */
  cleaned_up: boolean
}

/** Response from get_merge_conflicts command */
export interface MergeConflictsResponse {
  /** Whether there are unresolved merge conflicts */
  has_conflicts: boolean
  /** List of files with conflicts */
  conflicts: string[]
  /** Diff showing conflict markers */
  conflict_diff: string
}
