import { useCallback, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import {
  chatQueryKeys,
  markPlanApproved as markPlanApprovedService,
  persistEnqueue,
} from '@/services/chat'
import { invoke } from '@/lib/transport'
import { buildMcpConfigJson } from '@/services/mcp'
import { generateId } from '@/lib/uuid'
import type {
  ChatMessage,
  QueuedMessage,
  ThinkingLevel,
  EffortLevel,
  WorktreeSessions,
} from '@/types/chat'
import type { Session } from '@/types/chat'
import type { McpServerInfo } from '@/types/chat'

interface UsePlanDialogApprovalParams {
  activeSessionId: string | null | undefined
  activeWorktreeId: string | null | undefined
  activeWorktreePath: string | null | undefined
  pendingPlanMessage: ChatMessage | null | undefined
  selectedModelRef: RefObject<string>
  buildModelRef: RefObject<string | null>
  buildBackendRef: RefObject<string | null>
  yoloModelRef: RefObject<string | null>
  yoloBackendRef: RefObject<string | null>
  selectedProviderRef: RefObject<string | null>
  selectedThinkingLevelRef: RefObject<ThinkingLevel>
  selectedEffortLevelRef: RefObject<EffortLevel>
  useAdaptiveThinkingRef: RefObject<boolean>
  isCodexBackendRef: RefObject<boolean>
  mcpServersDataRef: RefObject<McpServerInfo[] | undefined>
  enabledMcpServersRef: RefObject<string[]>
  selectedBackendRef: RefObject<'claude' | 'codex' | 'opencode'>
  markAtBottom: () => void
}

/**
 * Provides plan dialog approval handlers (build + yolo).
 * Deduplicates the 4x-repeated approval callback logic in ChatWindow.
 */
export function usePlanDialogApproval({
  activeSessionId,
  activeWorktreeId,
  activeWorktreePath,
  pendingPlanMessage,
  selectedModelRef,
  buildModelRef,
  buildBackendRef,
  yoloModelRef,
  yoloBackendRef,
  selectedProviderRef,
  selectedThinkingLevelRef,
  selectedEffortLevelRef,
  useAdaptiveThinkingRef,
  isCodexBackendRef,
  mcpServersDataRef,
  enabledMcpServersRef,
  selectedBackendRef,
  markAtBottom,
}: UsePlanDialogApprovalParams) {
  const queryClient = useQueryClient()

  const approve = useCallback(
    (updatedPlan: string | undefined, mode: 'build' | 'yolo') => {
      console.warn('[usePlanDialogApproval] approve CALLED', {
        mode,
        activeSessionId,
      })
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      // Optimistic updates: apply immediately so the approving client's UI updates
      if (pendingPlanMessage) {
        queryClient.setQueryData<Session>(
          chatQueryKeys.session(activeSessionId),
          old => {
            if (!old) return old
            return {
              ...old,
              approved_plan_message_ids: [
                ...(old.approved_plan_message_ids ?? []),
                pendingPlanMessage.id,
              ],
              messages: old.messages.map(msg =>
                msg.id === pendingPlanMessage.id
                  ? { ...msg, plan_approved: true }
                  : msg
              ),
            }
          }
        )

        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(activeWorktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === activeSessionId
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

      // Clear Zustand waiting state so the queue processor can process the message
      const {
        enqueueMessage,
        setExecutionMode,
        setWaitingForInput,
        setPendingPlanMessageId,
        clearToolCalls,
        clearStreamingContentBlocks,
        setSessionReviewing,
      } = useChatStore.getState()

      setWaitingForInput(activeSessionId, false)
      setPendingPlanMessageId(activeSessionId, null)
      clearToolCalls(activeSessionId)
      clearStreamingContentBlocks(activeSessionId)
      setSessionReviewing(activeSessionId, false)

      // Mark as at-bottom so Tier 4 / Tier 2 auto-scroll kicks in when
      // streaming starts. Don't physically scroll — let native CSS scroll
      // anchoring handle the plan collapse layout shift smoothly.
      markAtBottom()

      // Chain: mark_plan_approved → update_session_state → broadcast
      // On WebSocket, commands dispatch concurrently. update_session_state emits
      // cache:invalidate which triggers refetch on other clients. mark_plan_approved
      // must complete first so the refetch includes plan_approved=true.
      // Broadcasts are sequenced AFTER update_session_state so that any
      // refetch triggered by the self-received session:setting-changed event
      // returns the already-updated backend data (prevents stale overwrites
      // of optimistic TanStack cache on web access).
      const markPromise = pendingPlanMessage
        ? markPlanApprovedService(
            activeWorktreeId,
            activeWorktreePath,
            activeSessionId,
            pendingPlanMessage.id
          ).catch(err => {
            console.error(
              '[usePlanDialogApproval] markPlanApproved failed:',
              err
            )
          })
        : Promise.resolve()

      markPromise
        .then(() =>
          invoke('update_session_state', {
            worktreeId: activeWorktreeId,
            worktreePath: activeWorktreePath,
            sessionId: activeSessionId,
            waitingForInput: false,
            waitingForInputType: null,
            selectedExecutionMode: mode,
          })
        )
        .then(() => {
          invoke('broadcast_session_setting', {
            sessionId: activeSessionId,
            key: 'executionMode',
            value: mode,
          }).catch(err => {
            console.error(
              '[usePlanDialogApproval] Broadcast executionMode=' +
                mode +
                ' failed:',
              err
            )
          })
          invoke('broadcast_session_setting', {
            sessionId: activeSessionId,
            key: 'waitingForInput',
            value: 'false',
          }).catch(err => {
            console.error(
              '[usePlanDialogApproval] Broadcast waitingForInput=false failed:',
              err
            )
          })
        })
        .catch(err => {
          console.error(
            '[usePlanDialogApproval] Failed to clear waiting state:',
            err
          )
        })

      // Build approval message
      const defaultText =
        mode === 'yolo'
          ? 'Plan approved (yolo mode). Begin implementing all changes immediately without asking for confirmation. Do not re-explain the plan — start writing code.'
          : 'Plan approved. Begin implementing the changes now. Do not re-explain the plan — start writing code.'
      const message = updatedPlan
        ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
        : defaultText

      setExecutionMode(activeSessionId, mode)

      const modelOverride =
        mode === 'yolo' ? yoloModelRef.current : buildModelRef.current
      const backendOverride =
        mode === 'yolo' ? yoloBackendRef.current : buildBackendRef.current
      const model = modelOverride ?? selectedModelRef.current
      const modeLabel = mode === 'yolo' ? 'Yolo' : 'Build'
      const overrideStr =
        modelOverride || backendOverride
          ? [backendOverride, model].filter(Boolean).join(' / ')
          : ''
      if (overrideStr) toast.info(`${modeLabel}: ${overrideStr}`)
      const displayMessage = overrideStr
        ? `[${modeLabel}: ${overrideStr}]\n${message}`
        : message

      const queuedMessage: QueuedMessage = {
        id: generateId(),
        message: displayMessage,
        pendingImages: [],
        pendingFiles: [],
        pendingSkills: [],
        pendingTextFiles: [],
        model,
        provider: selectedProviderRef.current,
        executionMode: mode,
        thinkingLevel: selectedThinkingLevelRef.current,
        effortLevel:
          useAdaptiveThinkingRef.current || isCodexBackendRef.current
            ? selectedEffortLevelRef.current
            : undefined,
        mcpConfig: buildMcpConfigJson(
          mcpServersDataRef.current ?? [],
          enabledMcpServersRef.current,
          (backendOverride as string) ?? selectedBackendRef.current
        ),
        queuedAt: Date.now(),
      }

      enqueueMessage(activeSessionId, queuedMessage)
      persistEnqueue(
        activeWorktreeId,
        activeWorktreePath,
        activeSessionId,
        queuedMessage
      )
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      pendingPlanMessage,
      queryClient,
      selectedModelRef,
      buildModelRef,
      yoloModelRef,
      selectedProviderRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      isCodexBackendRef,
      mcpServersDataRef,
      enabledMcpServersRef,
      markAtBottom,
    ]
  )

  const handlePlanDialogApprove = useCallback(
    (updatedPlan?: string) => approve(updatedPlan, 'build'),
    [approve]
  )

  const handlePlanDialogApproveYolo = useCallback(
    (updatedPlan?: string) => approve(updatedPlan, 'yolo'),
    [approve]
  )

  return { handlePlanDialogApprove, handlePlanDialogApproveYolo }
}
