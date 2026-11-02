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
