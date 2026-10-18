export interface SessionRenderTarget {
  sessionId: string | null
  worktreeId: string | null
  worktreePath: string | null
}

/** Always render the selected session. Never keep the previous tab visible. */
export function selectSessionRenderTarget(
  active: SessionRenderTarget,
  _deferred: SessionRenderTarget
): SessionRenderTarget {
  return active
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
