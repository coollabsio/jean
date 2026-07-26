import type { LabelData } from '@/types/chat'
import type { AdvisoryContext, SecurityAlertContext } from '@/types/github'

/**
 * Type of session (base branch or worktree)
 */
export type SessionType = 'worktree' | 'base'

export type WorktreeSortMode = 'created' | 'last_activity' | 'manual'

export type WorktreeOrigin = 'manual' | 'auto_fix'

export interface ProjectAutoFixSettings {
  enabled: boolean
  interval_minutes: number
  issue_limit: number
  max_parallel_worktrees: number
  included_labels?: string[]
  excluded_labels?: string[]
  planning_backend: string
  planning_model?: string | null
  auto_yolo_enabled?: boolean
  yolo_backend: string
  yolo_model?: string | null
  active_hours_enabled?: boolean
  active_hours_start?: number
  active_hours_end?: number
}

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
  /** Auto-detected project icon path (absolute path in project dir) */
  default_avatar_path?: string | null
  /** MCP server names enabled by default for this project (null/undefined = inherit from global) */
  enabled_mcp_servers?: string[] | null
  /** All MCP server names ever seen for this project (prevents re-enabling user-disabled servers) */
  known_mcp_servers?: string[]
  /** Custom system prompt appended to every session execution */
  custom_system_prompt?: string
  /** Default provider profile name for sessions in this project (undefined = use global default) */
  default_provider?: string | null
  /** Default CLI backend for sessions in this project (undefined = use global default) */
  default_backend?: string | null
  /** Custom base directory for worktrees (undefined = use default ~/jean) */
  worktrees_dir?: string | null
  /** Linear personal API key for fetching issues (per-project) */
  linear_api_key?: string | null
  /** Linear team ID to filter issues (undefined/null = show all teams) */
  linear_team_id?: string | null
  /** Sentry auth token override for this project */
  sentry_auth_token?: string | null
  /** Sentry organization slug */
  sentry_organization_slug?: string | null
  /** Sentry project slug */
  sentry_project_slug?: string | null
  /** IDs of linked projects for cross-project context sharing */
  linked_project_ids?: string[]
  /** Per-project automated issue fixing settings */
  auto_fix_settings?: ProjectAutoFixSettings | null
}

export interface DirEntry {
  name: string
  path: string
  is_dir: boolean
  is_git_repo: boolean
  is_hidden: boolean
}

export interface BrowseDirectoryResult {
  current_path: string
  parent_path?: string
  entries: DirEntry[]
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
  /** Absolute path to worktree (configurable base dir, defaults to ~/jean/<project>/<name>) */
  path: string
  /** Git branch name (same as workspace name) */
  branch: string
  /** Base branch this worktree was created from (undefined for legacy worktrees or base sessions) */
  base_branch?: string
  /** Remote the base branch was taken from when explicitly picked (e.g. "fork" for fork/main) */
  base_remote?: string
  /** Unix timestamp when worktree was created */
  created_at: number
  /** Output from setup script (if any) */
  setup_output?: string
  /** The setup script that was executed (if any) */
  setup_script?: string
  /** Whether the setup script succeeded (undefined = no script, true = success, false = failed) */
  setup_success?: boolean
  /** Type of session (defaults to 'worktree' for backward compatibility) */
  session_type?: SessionType
  /** Status of worktree creation (pending while being created in background) */
  status?: WorktreeStatus
  /** GitHub PR number (if a PR has been created) */
  pr_number?: number
  /** GitHub PR URL (if a PR has been created) */
  pr_url?: string
  /** GitHub issue number (if created from an issue) */
  issue_number?: number
  /** Linear issue identifier (e.g. "ENG-123", if created from a Linear issue) */
  linear_issue_identifier?: string
  /** Dependabot security alert number (if created from a security alert) */
  security_alert_number?: number
  /** Dependabot security alert URL on GitHub */
  security_alert_url?: string
  /** Repository security advisory GHSA ID (if created from an advisory) */
  advisory_ghsa_id?: string
  /** Repository security advisory URL on GitHub */
  advisory_url?: string
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
  /** Remote most recently pushed to for the PR (e.g. "origin" or a fork owner) */
  pr_push_remote?: string
  /** Branch on pr_push_remote most recently pushed to */
  pr_push_branch?: string
  /** User-assigned labels with colors (e.g. "In Progress") */
  labels?: LabelData[]
  /** Deprecated legacy single worktree label; use labels instead. */
  label?: LabelData
  /** Display order within project (lower = higher in list, base sessions ignore this) */
  order: number
  /** Origin/category for this worktree */
  origin?: WorktreeOrigin
  /** Unix timestamp when worktree was archived (undefined = not archived) */
  archived_at?: number
  /** Unix timestamp when worktree was last opened/viewed by the user */
  last_opened_at?: number
}

// =============================================================================
// Worktree Creation Events (from Rust backend)
// =============================================================================

/** Event payload when worktree creation starts */
export interface WorktreeCreatingEvent {
  id: string
  projectId: string
  name: string
  path: string
  branch: string
  prNumber?: number
  issueNumber?: number
  securityAlertNumber?: number
  advisoryGhsaId?: string
  origin?: WorktreeOrigin
  autoOpenInJean: boolean
}

/** Event payload when worktree creation completes */
export interface WorktreeCreatedEvent {
  worktree: Worktree
  autoOpenInJean: boolean
}

/** Event payload when worktree setup script completes (after worktree:created) */
export interface WorktreeSetupCompleteEvent {
  id: string
  project_id: string
  setup_output: string
  setup_script: string
  setup_success: boolean
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
  teardown_output?: string
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
    comments: {
      author: { login: string }
      body: string
      createdAt: string
    }[]
  }
  /** PR context to use when creating a new worktree with the suggested name */
  pr_context?: {
    number: number
    title: string
    body?: string
    headRefName: string
    baseRefName: string
    comments: {
      author: { login: string }
      body: string
      createdAt: string
    }[]
    reviews: {
      author: { login: string }
      body: string
      state: string
      submittedAt: string
    }[]
    diff?: string
  }
  /** Security alert context to use when creating a new worktree with the suggested name */
  security_context?: SecurityAlertContext
  /** Advisory context to use when creating a new worktree with the suggested name */
  advisory_context?: AdvisoryContext
  /** Origin of the worktree request */
  origin?: WorktreeOrigin | null
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
    comments: {
      author: { login: string }
      body: string
      createdAt: string
    }[]
  }
  /** PR context to use when creating a new worktree with the suggested name */
  pr_context?: {
    number: number
    title: string
    body?: string
    headRefName: string
    baseRefName: string
    comments: {
      author: { login: string }
      body: string
      createdAt: string
    }[]
    reviews: {
      author: { login: string }
      body: string
      state: string
      submittedAt: string
    }[]
    diff?: string
  }
  /** Security alert context to use when creating a new worktree with the suggested name */
  security_context?: SecurityAlertContext
  /** Advisory context to use when creating a new worktree with the suggested name */
  advisory_context?: AdvisoryContext
  /** Origin of the worktree request */
  origin?: WorktreeOrigin | null
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
  /** Whether this PR already existed (was linked, not newly created) */
  existing: boolean
}

/** Response from detecting an existing PR for the current branch */
export interface DetectPrResponse {
  pr_number: number
  pr_url: string
  title: string
}

/** Response from manually linking a PR to a worktree */
export interface LinkWorktreePrResponse {
  pr_number: number
  pr_url: string
  title: string
}

// =============================================================================
// GitHub PR Merge
// =============================================================================

/** Response from merging a GitHub PR */
export interface MergePrResponse {
  merged: boolean
  message: string
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
  /** Whether the push fell back to creating a new branch (couldn't push to PR branch) */
  push_fell_back: boolean
  /** Whether the push failed due to permission/authentication errors */
  push_permission_denied: boolean
}

export type CommitJobStatus = 'running' | 'completed' | 'failed'

export interface CommitJob {
  id: string
  worktreePath: string
  status: CommitJobStatus
  response?: CreateCommitResponse
  error?: string
  createdAt: number
  updatedAt: number
}

export interface StartCommitJobResponse {
  job: CommitJob
}

/** Response from reverting the last local commit */
export interface RevertCommitResponse {
  /** Hash of the reverted commit */
  commit_hash: string
  /** Subject line of the reverted commit */
  commit_message: string
}

/** Response from git push */
export interface GitPushResponse {
  output: string
  /** Whether the push fell back to creating a new branch (couldn't push to PR branch) */
  fellBack: boolean
  /** Whether the push failed due to permission/authentication errors */
  permissionDenied: boolean
}

// =============================================================================
// AI-Powered Code Review
// =============================================================================

/** A single finding from an AI code review */
export interface ReviewFinding {
  /** Severity level of the finding */
  severity: 'critical' | 'warning' | 'suggestion'
  /** Primary category for the issue */
  category?:
    | 'security'
    | 'correctness'
    | 'data_loss'
    | 'race_condition'
    | 'api_contract'
    | 'serialization'
    | 'migration'
    | 'testing'
    | 'performance'
    | 'maintainability'
    | 'repo_standard'
  /** Model confidence in the finding */
  confidence?: 'high' | 'medium'
  /** Whether this finding should block approval */
  blocking?: boolean
  /** Whether the issue was introduced or materially worsened by the diff */
  introduced_by_diff?: boolean
  /** File path where the finding applies */
  file: string
  /** Line number if applicable */
  line?: number
  /** Short title for the finding */
  title: string
  /** Detailed explanation of the finding */
  description: string
  /** Concrete scenario where the issue manifests */
  failure_scenario?: string
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

export interface ReviewResultEntry {
  backend: string
  model: string
  status?: ReviewJobStatus
  result?: ReviewResponse
  error?: string
}

export interface GroupedReviewResults {
  reviews: ReviewResultEntry[]
}

export type StoredReviewResults = ReviewResponse | GroupedReviewResults

export type ReviewJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface ReviewJob {
  id: string
  reviewRunId: string
  worktreeId: string
  worktreePath: string
  sessionId?: string
  source: 'ai' | 'coderabbit-cli' | string
  backend?: string
  model?: string
  status: ReviewJobStatus
  findingCount?: number
  error?: string
  createdAt: number
  updatedAt: number
}

export interface StartReviewJobResponse {
  job: ReviewJob
}

// =============================================================================
// Release Notes
// =============================================================================

/** A GitHub release from gh release list */
export interface GitHubRelease {
  tagName: string
  name: string
  publishedAt: string
  isLatest: boolean
  isDraft: boolean
  isPrerelease: boolean
}

/** Response from generate_release_notes command */
export interface ReleaseNotesResponse {
  title: string
  body: string
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
