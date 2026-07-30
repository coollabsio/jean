/**
 * AI change checkpoints — snapshots of the worktree taken before each agent turn.
 */

export type CheckpointStatus = 'open' | 'finalized' | 'restored'

export interface CheckpointFileSummary {
  path: string
  /** "added" | "modified" | "deleted" | "renamed" */
  status: string
  additions: number
  deletions: number
}

export interface AiCheckpoint {
  id: string
  worktreeId: string
  sessionId: string
  runId?: string | null
  userMessageId?: string | null
  userMessagePreview: string
  createdAt: number
  finalizedAt?: number | null
  startCommit: string
  endCommit?: string | null
  headCommit?: string | null
  worktreePath: string
  status: CheckpointStatus
  filesChanged: CheckpointFileSummary[]
  totalAdditions: number
  totalDeletions: number
}

/** Diff scope for get_ai_checkpoint_diff */
export type CheckpointDiffScope = 'current' | 'turn'
