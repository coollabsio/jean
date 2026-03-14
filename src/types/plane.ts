/**
 * Plane issue types for the New Worktree modal and Load Context modal
 */

export interface PlaneState {
  id: string
  name: string
  color: string
  /** "backlog" | "unstarted" | "started" | "completed" | "cancelled" | "triage" */
  group: string
}

export interface PlaneLabel {
  id: string
  name: string
  color: string
}

export interface PlaneUser {
  id: string
  name: string
  email: string
}

export interface PlaneIssue {
  id: string
  /** e.g., "PROJ-123" */
  sequenceId: string
  name: string
  description?: string
  descriptionHtml?: string
  state: PlaneState
  labels: PlaneLabel[]
  assignee?: PlaneUser
  createdAt: string
  updatedAt: string
  url: string
  priority: number
  priorityLabel: string
}

export interface PlaneComment {
  id: string
  comment: string
  createdAt: string
  updatedAt: string
  actor?: PlaneUser
}

export interface PlaneIssueDetail extends PlaneIssue {
  comments: PlaneComment[]
}

export interface PlaneIssueListResult {
  issues: PlaneIssue[]
}

/**
 * Loaded Plane issue context info (from backend)
 */
export interface LoadedPlaneIssueContext {
  identifier: string
  title: string
  commentCount: number
  projectName: string
}

/**
 * Plane workspace info
 */
export interface PlaneWorkspace {
  id: string
  name: string
  slug: string
  logo?: string
}

/**
 * Plane project info
 */
export interface PlaneProject {
  id: string
  name: string
  identifier: string
  description?: string
  workspace: PlaneWorkspace
}
