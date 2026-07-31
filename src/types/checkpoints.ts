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

/** Classification of a path when restoring one agent turn. */
export type RestorePathStatus =
  | 'clean'
  | 'conflictedLaterActivity'
  | 'conflictedWorkingTree'
  | 'binaryOrUnreadable'

export type RestoreTurnMode = 'cleanOnly' | 'allTurnFiles'

export interface RestorePathInfo {
  path: string
  status: RestorePathStatus
  turnStatus?: string | null
  laterSessionIds: string[]
  reason?: string | null
}

export interface CheckpointRestoreAnalysis {
  checkpointId: string
  sessionId: string
  worktreeId: string
  turnPaths: string[]
  paths: RestorePathInfo[]
  cleanCount: number
  conflictCount: number
  overlappingSessionIds: string[]
  openCheckpoint: boolean
}

export interface RestoreTurnResult {
  checkpointId: string
  mode: RestoreTurnMode
  restoredPaths: string[]
  skippedPaths: string[]
  analysis: CheckpointRestoreAnalysis
}

export type RestoreFileAction = 'write' | 'delete' | 'skip'

export interface RestoreFileProposal {
  path: string
  action: RestoreFileAction
  content?: string | null
  reason?: string | null
}

export interface CheckpointRestoreProposal {
  checkpointId: string
  summary: string
  files: RestoreFileProposal[]
  cleanPaths: string[]
  analysis: CheckpointRestoreAnalysis
}

export interface ApplyRestoreProposalResult {
  checkpointId: string
  appliedPaths: string[]
  skippedPaths: string[]
  errors: string[]
}
