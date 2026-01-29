/**
 * GitLab types for issues and merge requests
 */

export interface GitLabAuthor {
  username: string
  name?: string
}

export interface GitLabIssue {
  iid: number
  title: string
  description?: string
  state: string
  labels: string[]
  createdAt: string
  author: GitLabAuthor
  webUrl: string
}

export interface GitLabNote {
  body: string
  author: GitLabAuthor
  createdAt: string
}

export interface GitLabIssueDetail extends GitLabIssue {
  notes: GitLabNote[]
}

/**
 * Issue context to pass when creating a worktree
 */
export interface GitLabIssueContext {
  iid: number
  title: string
  description?: string
  notes: GitLabNote[]
}

/**
 * Loaded issue context info (from backend)
 */
export interface LoadedGitLabIssueContext {
  iid: number
  title: string
  noteCount: number
  projectPath: string
}

// =============================================================================
// GitLab Merge Request Types
// =============================================================================

export interface GitLabMergeRequest {
  iid: number
  title: string
  description?: string
  state: string
  sourceBranch: string
  targetBranch: string
  draft: boolean
  createdAt: string
  author: GitLabAuthor
  labels: string[]
  webUrl: string
}

export interface GitLabMergeRequestDetail extends GitLabMergeRequest {
  notes: GitLabNote[]
}

/**
 * MR context to pass when creating a worktree
 */
export interface GitLabMergeRequestContext {
  iid: number
  title: string
  description?: string
  sourceBranch: string
  targetBranch: string
  notes: GitLabNote[]
  diff?: string
}

/**
 * Loaded MR context info (from backend)
 */
export interface LoadedGitLabMergeRequestContext {
  iid: number
  title: string
  noteCount: number
  projectPath: string
}
