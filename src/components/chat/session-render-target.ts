export interface SessionRenderTarget {
  sessionId: string | null
  worktreeId: string | null
  worktreePath: string | null
}

/**
 * Keep deferred rendering only for tab changes inside one worktree. A worktree
 * change can also change the owning Jean server, so the old session ID must
 * never be combined with the new worktree ID and path.
 */
export function selectSessionRenderTarget(
  active: SessionRenderTarget,
  deferred: SessionRenderTarget
): SessionRenderTarget {
  return active.worktreeId === deferred.worktreeId ? deferred : active
}

export function shouldClearStaleSessionStream(input: {
  isSending: boolean
  lastRunStatus: string | null | undefined
  lastMessageRole: string | undefined
  lastMessageId: string | undefined
}): boolean {
  if (!input.isSending || input.lastMessageRole !== 'assistant') return false
  if (input.lastMessageId?.startsWith('running-')) return false
  return !['running', 'resumable'].includes(input.lastRunStatus ?? '')
}
