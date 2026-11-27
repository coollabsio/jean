import type { ExternalToast } from 'sonner'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { toastActionLabel } from '@/lib/toast-action-label'

export interface CloseSessionTarget {
  worktreeId: string
  worktreePath: string
  sessionId: string
}

/** Close and restore mutations, from `useCloseSession` and `useRestoreSession`. */
export interface CloseSessionActions {
  close: (
    target: CloseSessionTarget,
    options?: { onSuccess?: () => void }
  ) => void
  restore: (target: CloseSessionTarget) => void
}

/** Keep the toast up long enough to tap its action on mobile. */
export const CLOSE_SESSION_TOAST_DURATION_MS = 10_000

/** A running session or one that waits for an answer must stay open. */
export function isSessionBusyForClose(sessionId: string): boolean {
  const { sendingSessionIds, waitingForInputSessionIds } =
    useChatStore.getState()
  return Boolean(
    sendingSessionIds[sessionId] || waitingForInputSessionIds[sessionId]
  )
}

function completeTarget(
  target: Partial<CloseSessionTarget> | null | undefined
): CloseSessionTarget | null {
  const { worktreeId, worktreePath, sessionId } = target ?? {}
  if (!worktreeId || !worktreePath || !sessionId) return null
  return { worktreeId, worktreePath, sessionId }
}

/** Close the session, then show a toast that offers Undo. */
export function closeSessionWithUndo(
  target: CloseSessionTarget,
  actions: CloseSessionActions
): void {
  if (isSessionBusyForClose(target.sessionId)) {
    toast.error('Session is busy. It stays open.')
    return
  }
  actions.close(target, {
    onSuccess: () =>
      toast.success('Session closed', {
        duration: CLOSE_SESSION_TOAST_DURATION_MS,
        action: {
          label: toastActionLabel('Undo'),
          onClick: () => actions.restore(target),
        },
      }),
  })
}

/**
 * Toast options that offer "Close session" after a magic action succeeds.
 * Returns no action when there is no session or the session is busy. The
 * busy check runs again on tap, because the session can start work later.
 * After the close, a second toast offers Undo.
 */
export function closeSessionToastOptions(
  target: Partial<CloseSessionTarget> | null | undefined,
  actions: CloseSessionActions
): ExternalToast {
  const closeTarget = completeTarget(target)
  if (!closeTarget || isSessionBusyForClose(closeTarget.sessionId)) return {}
  return {
    duration: CLOSE_SESSION_TOAST_DURATION_MS,
    action: {
      label: toastActionLabel('Close session'),
      onClick: () => closeSessionWithUndo(closeTarget, actions),
    },
  }
}

/**
 * After a magic action succeeds: close the session now when the user asked
 * for it (Shift or long-press) and it is safe, else offer "Close session" on
 * the success toast. Returns the options for the success toast.
 */
export function afterSuccessCloseOptions(
  target: Partial<CloseSessionTarget> | null | undefined,
  actions: CloseSessionActions,
  closeNow: boolean
): ExternalToast {
  const closeTarget = completeTarget(target)
  if (closeNow && closeTarget) {
    // Reports "Session is busy" itself when it cannot close.
    closeSessionWithUndo(closeTarget, actions)
    return {}
  }
  return closeSessionToastOptions(target, actions)
}

/** Magic options that can close the session after they succeed. */
export const CLOSE_AFTER_OPTIONS: ReadonlySet<string> = new Set([
  'commit',
  'commit-and-push',
  'commit-in-session',
])
