import { invoke } from '@/lib/transport'
import type {
  AiCheckpoint,
  ApplyRestoreProposalResult,
  CheckpointDiffScope,
  CheckpointRestoreAnalysis,
  CheckpointRestoreProposal,
  RestoreFileProposal,
  RestoreTurnMode,
  RestoreTurnResult,
} from '@/types/checkpoints'
import type { GitDiff } from '@/types/git-diff'

export const checkpointQueryKeys = {
  all: ['ai-checkpoints'] as const,
  worktree: (worktreeId: string) =>
    [...checkpointQueryKeys.all, worktreeId] as const,
  detail: (worktreeId: string, checkpointId: string) =>
    [...checkpointQueryKeys.worktree(worktreeId), checkpointId] as const,
  diff: (
    worktreeId: string,
    checkpointId: string,
    scope: CheckpointDiffScope = 'current'
  ) =>
    [
      ...checkpointQueryKeys.detail(worktreeId, checkpointId),
      'diff',
      scope,
    ] as const,
  analysis: (worktreeId: string, checkpointId: string) =>
    [
      ...checkpointQueryKeys.detail(worktreeId, checkpointId),
      'analysis',
    ] as const,
}

export async function listAiCheckpoints(
  worktreeId: string
): Promise<AiCheckpoint[]> {
  return invoke<AiCheckpoint[]>('list_ai_checkpoints', { worktreeId })
}

export async function getAiCheckpoint(
  worktreeId: string,
  checkpointId: string
): Promise<AiCheckpoint> {
  return invoke<AiCheckpoint>('get_ai_checkpoint', {
    worktreeId,
    checkpointId,
  })
}

export async function getAiCheckpointDiff(
  worktreeId: string,
  checkpointId: string,
  scope: CheckpointDiffScope = 'current'
): Promise<GitDiff> {
  return invoke<GitDiff>('get_ai_checkpoint_diff', {
    worktreeId,
    checkpointId,
    scope,
  })
}

export async function restoreAiCheckpoint(
  worktreeId: string,
  checkpointId: string
): Promise<AiCheckpoint> {
  return invoke<AiCheckpoint>('restore_ai_checkpoint', {
    worktreeId,
    checkpointId,
  })
}

export async function restoreAiCheckpointFile(
  worktreeId: string,
  checkpointId: string,
  filePath: string
): Promise<void> {
  return invoke('restore_ai_checkpoint_file', {
    worktreeId,
    checkpointId,
    filePath,
  })
}

export async function analyzeAiCheckpointRestore(
  worktreeId: string,
  checkpointId: string
): Promise<CheckpointRestoreAnalysis> {
  return invoke<CheckpointRestoreAnalysis>('analyze_ai_checkpoint_restore', {
    worktreeId,
    checkpointId,
  })
}

export async function restoreAiCheckpointTurn(
  worktreeId: string,
  checkpointId: string,
  mode: RestoreTurnMode = 'cleanOnly'
): Promise<RestoreTurnResult> {
  return invoke<RestoreTurnResult>('restore_ai_checkpoint_turn', {
    worktreeId,
    checkpointId,
    mode,
  })
}

export async function proposeAiCheckpointRestore(
  worktreeId: string,
  checkpointId: string,
  model?: string | null,
  reasoningEffort?: string | null
): Promise<CheckpointRestoreProposal> {
  return invoke<CheckpointRestoreProposal>('propose_ai_checkpoint_restore', {
    worktreeId,
    checkpointId,
    model: model ?? undefined,
    reasoningEffort: reasoningEffort ?? undefined,
  })
}

export async function applyAiCheckpointRestoreProposal(
  worktreeId: string,
  checkpointId: string,
  files: RestoreFileProposal[],
  alsoRestoreCleanPaths?: string[]
): Promise<ApplyRestoreProposalResult> {
  return invoke<ApplyRestoreProposalResult>(
    'apply_ai_checkpoint_restore_proposal',
    {
      worktreeId,
      checkpointId,
      files,
      alsoRestoreCleanPaths: alsoRestoreCleanPaths ?? [],
    }
  )
}

export async function deleteAiCheckpoint(
  worktreeId: string,
  checkpointId: string
): Promise<void> {
  return invoke('delete_ai_checkpoint', { worktreeId, checkpointId })
}

export async function finalizeAiCheckpoint(
  worktreeId: string,
  checkpointId: string
): Promise<AiCheckpoint> {
  return invoke<AiCheckpoint>('finalize_ai_checkpoint', {
    worktreeId,
    checkpointId,
  })
}
