import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { usePreferences } from '@/services/preferences'
import {
  useCreateSession,
  useSendMessage,
  markPlanApproved,
  readPlanFile,
  chatQueryKeys,
} from '@/services/chat'
import { invoke } from '@/lib/transport'
import type {
  EffortLevel,
  Session,
  ThinkingLevel,
  WorktreeSessions,
} from '@/types/chat'
import type { SessionCardData } from '../session-card-utils'
import {
  extractImagePaths,
  extractSkillPaths,
  extractTextFilePaths,
} from '../message-content-utils'

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

function mapCodexReasoningToEffort(
  value: string | null | undefined
): EffortLevel | undefined {
  switch (value) {
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'max'
    default:
      return undefined
  }
}

function getDefaultModelForBackend(
  backend: 'claude' | 'codex' | 'opencode' | undefined,
  preferences:
    | {
        selected_model?: string | null
        selected_codex_model?: string | null
        selected_opencode_model?: string | null
      }
    | undefined
): string {
  if (backend === 'codex') {
    return preferences?.selected_codex_model ?? 'gpt-5.4'
  }
  if (backend === 'opencode') {
    return preferences?.selected_opencode_model ?? 'opencode/gpt-5.3-codex'
  }
  return preferences?.selected_model ?? 'opus'
}

interface UseClearContextApprovalParams {
  worktreeId: string
  worktreePath: string
}

/**
 * Provides a "Clear Context & Approve" handler for canvas session cards.
 * Marks the plan approved on the original session, creates a new session,
 * switches to it, and sends the plan as the first message in YOLO mode.
 */
export function useClearContextApproval({
  worktreeId,
  worktreePath,
}: UseClearContextApprovalParams) {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const createSession = useCreateSession()
  const sendMessage = useSendMessage()

  const handleClearContextApproval = useCallback(
    async (
      card: SessionCardData,
      updatedPlan?: string,
      mode: 'yolo' | 'build' = 'yolo'
    ) => {
      const sessionId = card.session.id
      const messageId = card.pendingPlanMessageId

      // Step 1: Mark plan approved on original session
      if (messageId) {
        markPlanApproved(worktreeId, worktreePath, sessionId, messageId)

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

        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(worktreeId),
        })
      }

      // Clear waiting state on original session
      const store = useChatStore.getState()
      store.clearToolCalls(sessionId)
      store.clearStreamingContentBlocks(sessionId)
      store.setSessionReviewing(sessionId, false)
      store.setWaitingForInput(sessionId, false)
      store.setPendingPlanMessageId(sessionId, null)

      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: false,
        waitingForInputType: null,
      }).catch(err => {
        console.error(
          '[useClearContextApproval] Failed to clear waiting state:',
          err
        )
      })

      // Step 2: Resolve plan content
      let planContent = updatedPlan || card.planContent
      if (!planContent && card.planFilePath) {
        try {
          planContent = await readPlanFile(card.planFilePath)
        } catch (err) {
          toast.error(`Failed to read plan file: ${err}`)
          return
        }
      }
      if (!planContent) {
        toast.error('No plan content available')
        return
      }

      // Step 3: Create new session
      let newSession: Session
      try {
        newSession = await createSession.mutateAsync({
          worktreeId,
          worktreePath,
        })
      } catch (err) {
        toast.error(`Failed to create session: ${err}`)
        return
      }

      // Step 4: Switch to new session
      store.setActiveSession(worktreeId, newSession.id)
      store.addUserInitiatedSession(newSession.id)

      // Extract attachment references from all user messages in the original session.
      // Pending attachments are already cleared by handleSubmit, so we scan the
      // actual sent messages to find image/skill/text-file references.
      // The canvas view only uses the sessions list query (no messages), so we
      // must fetch the full session from the backend.
      let allUserContent = ''
      try {
        const fullSession = await invoke<Session>('get_session', {
          worktreeId,
          worktreePath,
          sessionId,
        })
        allUserContent = fullSession.messages
          .filter(m => m.role === 'user')
          .map(m => m.content)
          .join('\n')
        console.log('[useClearContextApproval] Fetched session messages:', {
          sessionId,
          messageCount: fullSession.messages.length,
          userMessages: fullSession.messages.filter(m => m.role === 'user')
            .length,
          contentLength: allUserContent.length,
          contentPreview: allUserContent.slice(0, 200),
        })
      } catch (err) {
        console.error('[useClearContextApproval] Failed to fetch session:', err)
      }

      const imagePaths = extractImagePaths(allUserContent)
      const skillPaths = extractSkillPaths(allUserContent)
      const textFilePaths = extractTextFilePaths(allUserContent)
      console.log('[useClearContextApproval] Extracted attachment paths:', {
        imagePaths,
        skillPaths,
        textFilePaths,
      })

      // Step 5: Send plan as first message using mode-specific overrides
      // Fallback chain: mode override → original session → global default
      const isYolo = mode === 'yolo'
      const modeLabel = isYolo ? 'Yolo' : 'Build'
      const originalBackend = card.session.backend as
        | 'claude'
        | 'codex'
        | 'opencode'
        | undefined
      const modeBackendPref = isYolo
        ? preferences?.yolo_backend
        : preferences?.build_backend
      const modeModelPref = isYolo
        ? preferences?.yolo_model
        : preferences?.build_model
      const modeThinkingPref = isYolo
        ? preferences?.yolo_thinking_level
        : preferences?.build_thinking_level
      const modeBackendOverride = modeBackendPref as
        | 'claude'
        | 'codex'
        | 'opencode'
        | null
      const backend = (modeBackendOverride ?? originalBackend ?? undefined) as
        | 'claude'
        | 'codex'
        | 'opencode'
        | undefined
      const model =
        modeModelPref ??
        (modeBackendOverride
          ? getDefaultModelForBackend(backend, preferences)
          : (card.session.selected_model ??
            getDefaultModelForBackend(backend, preferences)))
      const modeOverride =
        modeModelPref || modeBackendOverride
          ? [backend, model].filter(Boolean).join(' / ')
          : ''
      if (modeOverride) toast.info(`${modeLabel}: ${modeOverride}`)
      let thinkingLevel: ThinkingLevel = 'off'
      let effortLevel: EffortLevel | undefined
      if (backend === 'codex') {
        const defaultCodexEffort =
          mapCodexReasoningToEffort(
            preferences?.default_codex_reasoning_effort
          ) ?? 'high'
        effortLevel =
          mapCodexReasoningToEffort(modeThinkingPref) ?? defaultCodexEffort
      } else {
        const fallbackThinking = isThinkingLevel(preferences?.thinking_level)
          ? preferences.thinking_level
          : 'off'
        thinkingLevel = isThinkingLevel(modeThinkingPref)
          ? modeThinkingPref
          : fallbackThinking
      }
      const resolvedPlanFilePath =
        card.planFilePath || store.getPlanFilePath(sessionId)
      const planFileLine = resolvedPlanFilePath
        ? `\nPlan file: ${resolvedPlanFilePath}\n`
        : ''
      const configPrefix = modeOverride
        ? `[${modeLabel}: ${modeOverride}]\n`
        : ''
      let message = `${configPrefix}Execute this plan. Implement all changes described.${planFileLine}\n\n<plan>\n${planContent}\n</plan>`

      // Re-attach references from the original session so Claude can read them
      if (skillPaths.length > 0) {
        const skillRefs = skillPaths
          .map(
            p =>
              `[Skill: ${p} - Read and use this skill to guide your response]`
          )
          .join('\n')
        message = `${message}\n\n${skillRefs}`
      }
      if (imagePaths.length > 0) {
        const imageRefs = imagePaths
          .map(
            p => `[Image attached: ${p} - Use the Read tool to view this image]`
          )
          .join('\n')
        message = `${message}\n\n${imageRefs}`
      }
      if (textFilePaths.length > 0) {
        const textFileRefs = textFilePaths
          .map(
            p =>
              `[Text file attached: ${p} - Use the Read tool to view this file]`
          )
          .join('\n')
        message = `${message}\n\n${textFileRefs}`
      }

      store.setExecutionMode(newSession.id, mode)
      store.setLastSentMessage(newSession.id, message)
      store.setError(newSession.id, null)
      store.addSendingSession(newSession.id)
      store.setSelectedModel(newSession.id, model)
      store.setExecutingMode(newSession.id, mode)
      if (backend) {
        store.setSelectedBackend(
          newSession.id,
          backend as 'claude' | 'codex' | 'opencode'
        )
      }
      // Optimistically update TanStack Query cache so UI shows correct backend/model
      // immediately. Without this, session?.backend (from query cache) defaults to 'claude'
      // and overrides the Zustand value in the backend resolution chain.
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(newSession.id),
        old =>
          old
            ? { ...old, backend: backend ?? old.backend, selected_model: model }
            : old
      )

      // Persist model and backend to Rust session BEFORE sending so send_chat_message
      // reads the updated session state (both use with_sessions_mut, so ordering matters)
      await invoke('set_session_model', {
        worktreeId,
        worktreePath,
        sessionId: newSession.id,
        model,
      }).catch(err =>
        console.error('[useClearContextApproval] Failed to persist model:', err)
      )
      if (backend) {
        await invoke('set_session_backend', {
          worktreeId,
          worktreePath,
          sessionId: newSession.id,
          backend,
        }).catch(err =>
          console.error(
            '[useClearContextApproval] Failed to persist backend:',
            err
          )
        )
      }

      sendMessage.mutate({
        sessionId: newSession.id,
        worktreeId,
        worktreePath,
        message,
        model,
        executionMode: mode,
        thinkingLevel,
        effortLevel,
        customProfileName: card.session.selected_provider ?? undefined,
        backend,
      })

      // Optionally close the original session immediately.
      // cancel_process_if_running (used by close/archive commands) safely skips
      // idle sessions, so no spurious chat:cancelled events are emitted.
      // The with_sessions_mut mutex in storage.rs serializes concurrent writes,
      // so there's no file-level race with send_chat_message.
      if (preferences?.close_original_on_clear_context) {
        const command =
          preferences.removal_behavior === 'archive'
            ? 'archive_session'
            : 'close_session'

        // Optimistically remove from UI immediately so the user sees it gone at once
        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.filter(s => s.id !== sessionId),
              active_session_id:
                old.active_session_id === sessionId
                  ? newSession.id
                  : old.active_session_id,
            }
          }
        )

        // Close in background, then sync with backend
        invoke(command, { worktreeId, worktreePath, sessionId })
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions(worktreeId),
            })
          )
          .catch(err =>
            console.error(
              '[useClearContextApproval] Failed to close original session:',
              err
            )
          )
      }
    },
    [
      worktreeId,
      worktreePath,
      queryClient,
      preferences,
      createSession,
      sendMessage,
    ]
  )

  const handleClearContextApprovalBuild = useCallback(
    (card: SessionCardData, updatedPlan?: string) =>
      handleClearContextApproval(card, updatedPlan, 'build'),
    [handleClearContextApproval]
  )

  return { handleClearContextApproval, handleClearContextApprovalBuild }
}
