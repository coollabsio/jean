import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useChatStore } from '@/store/chat-store'
import type { QueuedMessage, Session } from '@/types/chat'
import type { Worktree } from '@/types/projects'
import { finishNewSessionFlow, startNewSessionPrompt } from './new-session-flow'

function isMissingWorktreeError(error: unknown): boolean {
  return String(error).toLowerCase().includes('worktree not found')
}

export async function sendRecoveredSetupMessage(
  worktree: Worktree,
  message: QueuedMessage
): Promise<Session> {
  const { session } = await finishNewSessionFlow({
    pendingWorktree: worktree,
    waitForWorktree: async () => worktree,
    invoke,
    queuedMessage: message,
  })
  const store = useChatStore.getState()
  store.registerWorktreePath(worktree.id, worktree.path)
  store.addUserInitiatedSession(session.id)
  store.setSelectedBackend(session.id, message.backend ?? 'claude')
  store.setSelectedModel(session.id, message.model)
  store.setExecutionMode(session.id, message.executionMode)
  store.setLastSentMessage(session.id, message.message)
  store.addSendingSession(session.id)
  try {
    await startNewSessionPrompt(invoke, worktree, session, message)
    return session
  } finally {
    store.removeSendingSession(session.id)
  }
}

/** Resumes only messages restored from disk; live creation flows send themselves. */
export function usePendingSetupMessageRecovery() {
  const recoverableSetupMessageIds = useChatStore(
    state => state.recoverableSetupMessageIds
  )
  const recoverableIds = useMemo(
    () => Object.keys(recoverableSetupMessageIds),
    [recoverableSetupMessageIds]
  )
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (recoverableIds.length === 0) return
    let cancelled = false
    let needsRetry = false
    let retryTimer: number | undefined

    void Promise.all(
      recoverableIds.map(async worktreeId => {
        let claimed = false
        try {
          const worktree = await invoke<Worktree>('get_worktree', {
            worktreeId,
          })
          if (worktree.setup_script && worktree.setup_success == null) {
            needsRetry = true
            return
          }
          const message = useChatStore
            .getState()
            .claimPendingSetupRecovery(worktreeId)
          if (!message || cancelled) return
          claimed = true
          await sendRecoveredSetupMessage(worktree, message)
          useChatStore.getState().clearPendingSetupPrompt(worktreeId)
          toast.success('Recovered session — prompt started')
        } catch (error) {
          if (cancelled) return
          if (!claimed && isMissingWorktreeError(error)) {
            useChatStore.getState().clearPendingSetupPrompt(worktreeId)
            return
          }
          if (!claimed) needsRetry = true
          toast.error('Could not resume the pending prompt', {
            description: String(error),
          })
        }
      })
    ).finally(() => {
      if (!cancelled && needsRetry) {
        retryTimer = window.setTimeout(
          () => setRetryTick(value => value + 1),
          1_000
        )
      }
    })

    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [recoverableIds.join('|'), retryTick])
}
