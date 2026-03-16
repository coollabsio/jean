/**
 * Linear issue types for the New Worktree modal and Load Context modal
 */

export interface LinearIssueState {
  name: string
  /** "started" | "unstarted" | "backlog" | "completed" | "cancelled" | "triage" */
  type: string
  color: string
}

export interface LinearLabel {
  name: string
  color: string
}

export interface LinearUser {
  name: string
  displayName: string
}

export interface LinearIssue {
  id: string
  /** e.g., "ENG-123" */
  identifier: string
  title: string
  description?: string
  state: LinearIssueState
  labels: LinearLabel[]
  assignee?: LinearUser
  createdAt: string
  url: string
  priority: number
  priorityLabel: string
}

export interface LinearComment {
  body: string
  user?: LinearUser
  createdAt: string
}

export interface LinearIssueDetail extends LinearIssue {
  comments: LinearComment[]
}

export interface LinearIssueListResult {
  issues: LinearIssue[]
}

/**
 * Loaded Linear issue context info (from backend)
 */
export interface LoadedLinearIssueContext {
  identifier: string
  title: string
  commentCount: number
  projectName: string
  url?: string
}

/**
 * Linear team info
 */
export interface LinearTeam {
  id: string
  name: string
  key: string
}
