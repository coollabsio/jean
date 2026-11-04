import { useCallback } from 'react'
import { FolderGit2 } from '@/components/icons/reicon'
import { useWorktree } from '@/services/projects'
import type { SessionDelegator } from '@/types/chat'
import { openSessionInWorktree } from './open-session'
import { describeSessionUpdates, type SessionUpdate } from './session-update'

/** Opens the session once its worktree is known, or null while loading. */
function useOpenSession(
  worktreeId: string,
  sessionId: string
): (() => void) | null {
  const { data: worktree } = useWorktree(worktreeId)
  const open = useCallback(() => {
    if (worktree) openSessionInWorktree(worktree, sessionId)
  }, [worktree, sessionId])
  return worktree ? open : null
}

/**
 * One muted line in place of the update a lead receives when sub-sessions
 * finish. The details live in the lead's sub-session panel.
 */
export function SessionUpdateLine({ updates }: { updates: SessionUpdate[] }) {
  return (
    <div
      className="flex justify-center py-1 text-center text-xs text-muted-foreground"
      data-testid="session-update-line"
    >
      <span className="truncate">{describeSessionUpdates(updates)}</span>
    </div>
  )
}

/** "Started by <session>" at the top of a session another session started. */
export function DelegatedByRow({ delegator }: { delegator: SessionDelegator }) {
  const open = useOpenSession(
    delegator.origin_worktree_id,
    delegator.origin_session_id
  )
  const name = delegator.origin_name || 'another session'
  return (
    <div className="flex justify-center py-1">
      <button
        type="button"
        aria-label={`Started by ${name}`}
        disabled={!open}
        onClick={() => open?.()}
        className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"
      >
        <span className="shrink-0">Started by</span>
        <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{name}</span>
      </button>
    </div>
  )
}
