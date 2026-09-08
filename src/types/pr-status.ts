/**
 * PR state from GitHub API
 */
export type PrState = 'open' | 'closed' | 'merged'

/**
 * Review decision from GitHub API
 */
export type ReviewDecision =
  | 'approved'
  | 'changes_requested'
  | 'review_required'

/**
 * CI check status rollup
 */
export type CheckStatus = 'success' | 'failure' | 'pending' | 'error'

/**
 * High-level display status for UI
 */
export type PrDisplayStatus = 'draft' | 'open' | 'review' | 'merged' | 'closed'

/**
 * PR merge conflict status from GitHub API
 */
export type MergeableStatus = 'mergeable' | 'conflicting' | 'unknown'

/**
 * PR status event from the backend
 */
export interface PrStatusEvent {
  worktree_id: string
  pr_number: number
  pr_url: string
  /** Current GitHub target branch (omitted by older Jean servers). */
  base_branch?: string
  state: PrState
  is_draft: boolean
  review_decision: ReviewDecision | null
  check_status: CheckStatus | null
  display_status: PrDisplayStatus
  mergeable: MergeableStatus | null
  checked_at: number
}
