import type { LinearIssue, LinearIssueDetail } from './linear'

/**
 * Plane work item. The backend sends the same shape as a Linear issue
 * (`state.type` holds the Plane state group), so the issue list UI is shared.
 */
export type PlaneWorkItem = LinearIssue

export type PlaneWorkItemDetail = LinearIssueDetail

/** Loaded Plane work item context info (from backend) */
export interface LoadedPlaneWorkItemContext {
  /** e.g., "PROJ-123" */
  identifier: string
  title: string
  commentCount: number
  projectName: string
  url?: string
}

/** Plane project of the configured workspace */
export interface PlaneProject {
  id: string
  name: string
  /** Key used in work item identifiers, e.g. "PROJ" */
  identifier: string
}
