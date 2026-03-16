import { useEffect, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import type { LabelData } from '@/types/chat'
import { isSessionStateHydrating } from '@/lib/session-state-hydration'
import { isBackendPersisting } from '@/lib/backend-persist-guard'

/**
 * Saves reviewing/waiting state immediately when it changes.
 * These states change infrequently, so no debounce needed.
 * Fixes the issue where debounced saves don't complete before app close.
 */
export function useImmediateSessionStateSave() {
  // PERFORMANCE: Track previous references (not spreads) to short-circuit early.
  // Zustand creates new object references on mutation, so referential equality
  // tells us if the specific record changed — no need to iterate entries.
  const prevReviewingRef = useRef<Record<string, boolean>>({})
  const prevWaitingRef = useRef<Record<string, boolean>>({})
  const prevLabelsRef = useRef<Record<string, LabelData>>({})

  useEffect(() => {
    const initialState = useChatStore.getState()
    prevReviewingRef.current = initialState.reviewingSessions
    prevWaitingRef.current = initialState.waitingForInputSessionIds
    prevLabelsRef.current = initialState.sessionLabels

    const unsubscribe = useChatStore.subscribe(state => {
      if (isSessionStateHydrating()) {
        prevReviewingRef.current = state.reviewingSessions
        prevWaitingRef.current = state.waitingForInputSessionIds
        prevLabelsRef.current = state.sessionLabels
        return
      }

      const {
        reviewingSessions,
        waitingForInputSessionIds,
        sessionLabels,
        sessionWorktreeMap,
        worktreePaths,
      } = state

      // Short-circuit: skip all iteration if no relevant record changed
      const reviewingChanged = reviewingSessions !== prevReviewingRef.current
      const waitingChanged =
        waitingForInputSessionIds !== prevWaitingRef.current
      const labelsChanged = sessionLabels !== prevLabelsRef.current

      if (!reviewingChanged && !waitingChanged && !labelsChanged) return

      if (reviewingChanged) {
        for (const [sessionId, isReviewing] of Object.entries(
          reviewingSessions
        )) {
          if (prevReviewingRef.current[sessionId] !== isReviewing) {
            // Skip if backend is persisting completion state for this session
            if (!isBackendPersisting(sessionId)) {
              saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
                isReviewing,
              })
            }
          }
        }
        for (const sessionId of Object.keys(prevReviewingRef.current)) {
          if (!(sessionId in reviewingSessions)) {
            if (!isBackendPersisting(sessionId)) {
              saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
                isReviewing: false,
              })
            }
          }
        }
        prevReviewingRef.current = reviewingSessions
      }

      if (waitingChanged) {
        for (const [sessionId, isWaiting] of Object.entries(
          waitingForInputSessionIds
        )) {
          if (prevWaitingRef.current[sessionId] !== isWaiting) {
            // Skip if backend is persisting completion state for this session
            if (!isBackendPersisting(sessionId)) {
              saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
                waitingForInput: isWaiting,
              })
            }
          }
        }
        for (const sessionId of Object.keys(prevWaitingRef.current)) {
          if (!(sessionId in waitingForInputSessionIds)) {
            if (!isBackendPersisting(sessionId)) {
              saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
                waitingForInput: false,
              })
            }
          }
        }
        prevWaitingRef.current = waitingForInputSessionIds
      }

      if (labelsChanged) {
        for (const [sessionId, label] of Object.entries(sessionLabels)) {
          if (
            JSON.stringify(prevLabelsRef.current[sessionId]) !==
            JSON.stringify(label)
          ) {
            saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
              label,
            })
          }
        }
        for (const sessionId of Object.keys(prevLabelsRef.current)) {
          if (!(sessionId in sessionLabels)) {
            saveSessionStatus(sessionId, sessionWorktreeMap, worktreePaths, {
              label: null,
            })
          }
        }
        prevLabelsRef.current = sessionLabels
      }
    })

    return unsubscribe
  }, [])
}

async function saveSessionStatus(
  sessionId: string,
  sessionWorktreeMap: Record<string, string>,
  worktreePaths: Record<string, string>,
  updates: {
    isReviewing?: boolean
    waitingForInput?: boolean
    label?: LabelData | null
  }
) {
  const worktreeId = sessionWorktreeMap[sessionId]
  const worktreePath = worktreeId ? worktreePaths[worktreeId] : null

  if (!worktreeId || !worktreePath) {
    logger.warn('Cannot save session status: missing worktree info', {
      sessionId,
    })
    return
  }

  try {
    // Send explicit null to remove, or the label object to set
    // Use undefined for label when we want to set/clear to avoid Tauri treating null as missing
    const labelValue = updates.label ?? undefined
    const clearLabel = 'label' in updates && updates.label === null
    await invoke('update_session_state', {
      worktreeId,
      worktreePath,
      sessionId,
      isReviewing: updates.isReviewing,
      waitingForInput: updates.waitingForInput,
      label: labelValue,
      clearLabel,
    })
  } catch (error) {
    logger.error('Failed to save session status', { sessionId, error })
  }
}
