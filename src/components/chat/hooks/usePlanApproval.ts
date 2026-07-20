import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { usePreferences } from '@/services/preferences'
import {
  useSendMessage,
  markPlanApproved,
  chatQueryKeys,
} from '@/services/chat'
import { invoke } from '@/lib/transport'
import { useClaudeCliStatus } from '@/services/claude-cli'
import { supportsAdaptiveThinking } from '@/lib/model-utils'
import type {
  EffortLevel,
  Session,
  ThinkingLevel,
  WorktreeSessions,
} from '@/types/chat'
import type { SessionCardData } from '../session-card-utils'

const THINKING_LEVEL_VALUES = new Set<ThinkingLevel>([
  'off',
  'think',
  'megathink',
  'ultrathink',
])

function isThinkingLevel(
  value: string | null | undefined
): value is ThinkingLevel {
  if (!value) return false
  return THINKING_LEVEL_VALUES.has(value as ThinkingLevel)
}

const EFFORT_LEVEL_VALUES = new Set<EffortLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'ultracode',
])

function isEffortLevel(value: string | null | undefined): value is EffortLevel {
  if (!value) return false
  return EFFORT_LEVEL_VALUES.has(value as EffortLevel)
}

interface UsePlanApprovalParams {
  worktreeId: string
  worktreePath: string
}

/**
 * Formats the approval message, including updated plan if content was changed.
 */
function formatApprovalMessage(
  baseMessage: string,
  updatedPlan?: string,
  originalPlan?: string | null
): string {
  // No updated plan provided, or plan unchanged
  if (!updatedPlan || updatedPlan === originalPlan) {
    return baseMessage
  }

  return `I've updated the plan. Please review and execute:

<updated-plan>
${updatedPlan}
</updated-plan>`
}

/**
 * Provides plan approval handlers for canvas session cards.
 */
export function usePlanApproval({
  worktreeId,
  worktreePath,
}: UsePlanApprovalParams) {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const sendMessage = useSendMessage()
  const { data: cliStatus } = useClaudeCliStatus()

  const {
    setExecutionMode,
    addSendingSession,
    setSelectedModel,
    setLastSentMessage,
    setError,
    setExecutingMode,
    setSessionReviewing,
    setWaitingForInput,
    clearToolCalls,
    clearStreamingContentBlocks,
    setPendingPlanMessageId,
  } = useChatStore.getState()

  const handlePlanApproval = useCallback(
    (card: SessionCardData, updatedPlan?: string) => {
      console.warn(
        '[usePlanApproval] handlePlanApproval (BUILD) CALLED',
        card.session.id
      )
      const sessionId = card.session.id
      const messageId = card.pendingPlanMessageId
      const originalPlan = card.planContent

      // Optimistic updates: apply immediately so the approving client's UI updates
      if (messageId) {
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(sessionId),
          old => {
            if (!old) return old
            return {
              ...old,
              approved_plan_message_ids: [
                ...(old.approved_plan_message_ids ?? []),
                messageId,
              ],
              messages: old.messages.map(msg =>
                msg.id === messageId ? { ...msg, plan_approved: true } : msg
              ),
            }
          }
        )

        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === sessionId
                  ? {
                      ...s,
                      waiting_for_input: false,
                      pending_plan_message_id: undefined,
                      waiting_for_input_type: undefined,
                    }
                  : s
              ),
            }
          }
        )
      }

      setExecutionMode(sessionId, 'build')
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)
      setPendingPlanMessageId(sessionId, null)

      const sessionBackend =
        card.session.backend ??
        useChatStore.getState().selectedBackends[card.session.id] ??
        preferences?.default_backend ??
        'claude'
      const buildBackendOverride = preferences?.build_backend
      const overridesApply =
        !buildBackendOverride || buildBackendOverride === sessionBackend
      const model = overridesApply
        ? (preferences?.build_model ??
          preferences?.selected_model ??
          'claude-opus-4-8[1m]')
        : (preferences?.selected_model ?? 'claude-opus-4-8[1m]')
      const buildThinkingOverride = overridesApply
        ? preferences?.build_thinking_level
        : null
      const thinkingLevel: ThinkingLevel = isThinkingLevel(
        buildThinkingOverride
      )
        ? buildThinkingOverride
        : isThinkingLevel(preferences?.thinking_level)
          ? preferences.thinking_level
          : 'off'

      const isCodex = sessionBackend === 'codex'
      const isPi = sessionBackend === 'pi'
      const isGrok = sessionBackend === 'grok'
      const buildEffortOverride = overridesApply
        ? preferences?.build_effort_level
        : null
      const effortAppliesBuild =
        isCodex ||
        isPi ||
        isGrok ||
        supportsAdaptiveThinking(model, cliStatus?.version ?? null)
      const defaultGrokEffort = isEffortLevel(
        preferences?.default_grok_reasoning_effort
      )
        ? preferences.default_grok_reasoning_effort
        : 'high'
      const effortLevel: EffortLevel | undefined = effortAppliesBuild
        ? isEffortLevel(buildEffortOverride)
          ? buildEffortOverride
          : isGrok
            ? defaultGrokEffort
            : isEffortLevel(preferences?.default_effort_level)
              ? preferences?.default_effort_level
              : undefined
        : undefined
      const baseMsg = isCodex
        ? 'Execute the plan you created. Implement all changes described.'
        : 'Plan approved. Begin implementing the changes now. Do not re-explain the plan — start writing code.'
      const rawMessage = messageId
        ? formatApprovalMessage(baseMsg, updatedPlan, originalPlan)
        : `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
      const buildInfo = [sessionBackend, model].filter(Boolean).join(' / ')
      const message = buildInfo
        ? `[Build: ${buildInfo}]\n${rawMessage}`
        : rawMessage

      // Chain: mark_plan_approved → update_session_state → broadcast → sendMessage
      // On WebSocket, commands dispatch concurrently via tokio::spawn.
      // update_session_state emits cache:invalidate which triggers refetch on
      // other clients. mark_plan_approved must complete first so the refetch
      // includes plan_approved=true (from approved_plan_message_ids).
      // Broadcasts are sequenced AFTER update_session_state so that any
      // refetch triggered by the self-received session:setting-changed event
      // returns the already-updated backend data (prevents stale overwrites
      // of optimistic TanStack cache on web access).
      const markPromise = messageId
        ? markPlanApproved(
            worktreeId,
            worktreePath,
            sessionId,
            messageId
          ).catch(err => {
            console.error('[usePlanApproval] markPlanApproved failed:', err)
          })
        : Promise.resolve()

      markPromise
        .then(() =>
          invoke('update_session_state', {
            worktreeId,
            worktreePath,
            sessionId,
            waitingForInput: false,
            waitingForInputType: null,
            selectedExecutionMode: 'build',
          })
        )
        .then(() => {
          invoke('broadcast_session_setting', {
            sessionId,
            key: 'executionMode',
            value: 'build',
          }).catch(err => {
            console.error(
              '[usePlanApproval] Broadcast executionMode=build failed:',
              err
            )
          })
          invoke('broadcast_session_setting', {
            sessionId,
            key: 'waitingForInput',
            value: 'false',
          }).catch(err => {
            console.error(
              '[usePlanApproval] Broadcast waitingForInput=false failed:',
              err
            )
          })
        })
        .catch(err => {
          console.error('[usePlanApproval] Failed to clear waiting state:', err)
        })
        .finally(() => {
          setLastSentMessage(sessionId, message)
          setError(sessionId, null)
          addSendingSession(sessionId)
          setSelectedModel(sessionId, model)
          setExecutingMode(sessionId, 'build')

          sendMessage.mutate({
            sessionId,
            worktreeId,
            worktreePath,
            message,
            model,
            executionMode: 'build',
            thinkingLevel,
            effortLevel,
            backend: sessionBackend,
            customProfileName: card.session.selected_provider ?? undefined,
          })
        })
    },
    [
      worktreeId,
      worktreePath,
      queryClient,
      preferences,
      sendMessage,
      cliStatus?.version,
      setExecutionMode,
      clearToolCalls,
      clearStreamingContentBlocks,
      setSessionReviewing,
      setWaitingForInput,
      setPendingPlanMessageId,
      setLastSentMessage,
      setError,
      addSendingSession,
      setSelectedModel,
      setExecutingMode,
    ]
  )

  const handlePlanApprovalYolo = useCallback(
    (card: SessionCardData, updatedPlan?: string) => {
      console.warn(
        '[usePlanApproval] handlePlanApprovalYolo (YOLO) CALLED',
        card.session.id
      )
      const sessionId = card.session.id
      const messageId = card.pendingPlanMessageId
      const originalPlan = card.planContent

      // Optimistic updates: apply immediately so the approving client's UI updates
      if (messageId) {
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(sessionId),
          old => {
            if (!old) return old
            return {
              ...old,
              approved_plan_message_ids: [
                ...(old.approved_plan_message_ids ?? []),
                messageId,
              ],
              messages: old.messages.map(msg =>
                msg.id === messageId ? { ...msg, plan_approved: true } : msg
              ),
            }
          }
        )

        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === sessionId
                  ? {
                      ...s,
                      waiting_for_input: false,
                      pending_plan_message_id: undefined,
                      waiting_for_input_type: undefined,
                    }
                  : s
              ),
            }
          }
        )
      }

      setExecutionMode(sessionId, 'yolo')
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)
      setPendingPlanMessageId(sessionId, null)

      const sessionBackend =
        card.session.backend ??
        useChatStore.getState().selectedBackends[card.session.id] ??
        preferences?.default_backend ??
        'claude'
      const yoloBackendOverride = preferences?.yolo_backend
      const overridesApplyYolo =
        !yoloBackendOverride || yoloBackendOverride === sessionBackend
      const model = overridesApplyYolo
        ? (preferences?.yolo_model ??
          preferences?.selected_model ??
          'claude-opus-4-8[1m]')
        : (preferences?.selected_model ?? 'claude-opus-4-8[1m]')
      const yoloThinkingOverride = overridesApplyYolo
        ? preferences?.yolo_thinking_level
        : null
      const thinkingLevel: ThinkingLevel = isThinkingLevel(yoloThinkingOverride)
        ? yoloThinkingOverride
        : isThinkingLevel(preferences?.thinking_level)
          ? preferences.thinking_level
          : 'off'

      const isCodexYolo = sessionBackend === 'codex'
      const isPiYolo = sessionBackend === 'pi'
      const isGrokYolo = sessionBackend === 'grok'
      const yoloEffortOverride = overridesApplyYolo
        ? preferences?.yolo_effort_level
        : null
      const effortAppliesYolo =
        isCodexYolo ||
        isPiYolo ||
        isGrokYolo ||
        supportsAdaptiveThinking(model, cliStatus?.version ?? null)
      const defaultGrokEffortYolo = isEffortLevel(
        preferences?.default_grok_reasoning_effort
      )
        ? preferences.default_grok_reasoning_effort
        : 'high'
      const effortLevel: EffortLevel | undefined = effortAppliesYolo
        ? isEffortLevel(yoloEffortOverride)
          ? yoloEffortOverride
          : isGrokYolo
            ? defaultGrokEffortYolo
            : isEffortLevel(preferences?.default_effort_level)
              ? preferences?.default_effort_level
              : undefined
        : undefined
      const baseMsgYolo = isCodexYolo
        ? 'Execute the plan you created. Implement all changes described.'
        : 'Plan approved (yolo mode). Begin implementing all changes immediately without asking for confirmation. Do not re-explain the plan — start writing code.'
      const rawMessage = messageId
        ? formatApprovalMessage(baseMsgYolo, updatedPlan, originalPlan)
        : `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
      const yoloInfo = [sessionBackend, model].filter(Boolean).join(' / ')
      const message = yoloInfo
        ? `[Yolo: ${yoloInfo}]\n${rawMessage}`
        : rawMessage

      // Chain: mark_plan_approved → update_session_state → broadcast → sendMessage
      // See handlePlanApproval comment for why sequencing matters.
      const markPromise = messageId
        ? markPlanApproved(
            worktreeId,
            worktreePath,
            sessionId,
            messageId
          ).catch(err => {
            console.error('[usePlanApproval] markPlanApproved failed:', err)
          })
        : Promise.resolve()

      markPromise
        .then(() =>
          invoke('update_session_state', {
            worktreeId,
            worktreePath,
            sessionId,
            waitingForInput: false,
            waitingForInputType: null,
            selectedExecutionMode: 'yolo',
          })
        )
        .then(() => {
          invoke('broadcast_session_setting', {
            sessionId,
            key: 'executionMode',
            value: 'yolo',
          }).catch(err => {
            console.error(
              '[usePlanApproval] Broadcast executionMode=yolo failed:',
              err
            )
          })
          invoke('broadcast_session_setting', {
            sessionId,
            key: 'waitingForInput',
            value: 'false',
          }).catch(err => {
            console.error(
              '[usePlanApproval] Broadcast waitingForInput=false failed:',
              err
            )
          })
        })
        .catch(err => {
          console.error('[usePlanApproval] Failed to clear waiting state:', err)
        })
        .finally(() => {
          setLastSentMessage(sessionId, message)
          setError(sessionId, null)
          addSendingSession(sessionId)
          setSelectedModel(sessionId, model)
          setExecutingMode(sessionId, 'yolo')

          sendMessage.mutate({
            sessionId,
            worktreeId,
            worktreePath,
            message,
            model,
            executionMode: 'yolo',
            thinkingLevel,
            effortLevel,
            backend: sessionBackend,
            customProfileName: card.session.selected_provider ?? undefined,
          })
        })
    },
    [
      worktreeId,
      worktreePath,
      queryClient,
      preferences,
      sendMessage,
      cliStatus?.version,
      setExecutionMode,
      clearToolCalls,
      clearStreamingContentBlocks,
      setSessionReviewing,
      setWaitingForInput,
      setPendingPlanMessageId,
      setLastSentMessage,
      setError,
      addSendingSession,
      setSelectedModel,
      setExecutingMode,
    ]
  )

  return { handlePlanApproval, handlePlanApprovalYolo }
}
