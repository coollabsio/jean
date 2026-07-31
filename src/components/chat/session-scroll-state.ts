/**
 * In-memory per-session scroll snapshots for the active Jean process.
 *
 * Issue #594: when switching sessions (or worktrees), restore the user's
 * previous scroll position instead of always jumping to the bottom. Snapshots
 * live only for the app lifetime — no disk persistence.
 */

export interface SessionScrollSnapshot {
  /** Viewport scrollTop when the user last left this session. */
  scrollTop: number
  /**
   * Whether the user was following the live tail (at bottom). When true on
   * restore we pin to the bottom so new content is visible; when false we
   * re-apply scrollTop.
   */
  isFollowingTail: boolean
  /**
   * VirtualizedMessageList window size (messages rendered from the end).
   * Restoring this is required so a user who scrolled far up still has the
   * older messages mounted when they return.
   */
  visibleCount: number
}

const DEFAULT_VISIBLE_COUNT = 10

const snapshots = new Map<string, SessionScrollSnapshot>()

export function getDefaultVisibleCount(): number {
  return DEFAULT_VISIBLE_COUNT
}

export function getSessionScrollState(
  sessionId: string
): SessionScrollSnapshot | undefined {
  return snapshots.get(sessionId)
}

export function saveSessionScrollState(
  sessionId: string,
  snapshot: SessionScrollSnapshot
): void {
  if (!sessionId) return
  snapshots.set(sessionId, {
    scrollTop: Math.max(0, snapshot.scrollTop),
    isFollowingTail: snapshot.isFollowingTail,
    visibleCount: Math.max(DEFAULT_VISIBLE_COUNT, snapshot.visibleCount),
  })
}

/** Merge partial fields into an existing snapshot (or create one). */
export function updateSessionScrollState(
  sessionId: string,
  partial: Partial<SessionScrollSnapshot>
): void {
  if (!sessionId) return
  const prev = snapshots.get(sessionId)
  snapshots.set(sessionId, {
    scrollTop: Math.max(0, partial.scrollTop ?? prev?.scrollTop ?? 0),
    isFollowingTail:
      partial.isFollowingTail ?? prev?.isFollowingTail ?? true,
    visibleCount: Math.max(
      DEFAULT_VISIBLE_COUNT,
      partial.visibleCount ?? prev?.visibleCount ?? DEFAULT_VISIBLE_COUNT
    ),
  })
}

export function clearSessionScrollState(sessionId: string): void {
  snapshots.delete(sessionId)
}

/** Test-only helper to clear all snapshots between cases. */
export function __resetSessionScrollStateForTests(): void {
  snapshots.clear()
}
