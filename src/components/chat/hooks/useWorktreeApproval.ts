import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { usePreferences } from '@/services/preferences'
import {
  useSendMessage,
  markPlanApproved,
  readPlanFile,
  chatQueryKeys,
} from '@/services/chat'
import { invoke, listen } from '@/lib/transport'
import type {
  EffortLevel,
  Session,
  ThinkingLevel,
  WorktreeSessions,
} from '@/types/chat'
import type {
  Worktree,
  WorktreeCreatedEvent,
  WorktreeCreateErrorEvent,
} from '@/types/projects'
import type { SessionCardData } from '../session-card-utils'
import {
  extractImagePaths,
  extractSkillPaths,
  extractTextFilePaths,
} from '../message-content-utils'
import { navigateToApprovedWorktree } from '../worktree-approval-navigation'

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

interface UseWorktreeApprovalParams {
  worktreeId: string
  worktreePath: string
  projectId: string | null
}

/**
 * Provides "Worktree Build" and "Worktree YOLO" handlers for canvas session cards.
 * Marks the plan approved on the original session, creates a new worktree,
 * waits for it to be ready, creates a session, and sends the plan.
 */
export function useWorktreeApproval({
  worktreeId,
  worktreePath,
  projectId,
}: UseWorktreeApprovalParams) {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const sendMessage = useSendMessage()

  const handleWorktreeApproval = useCallback(
    async (
      card: SessionCardData,
      updatedPlan?: string,
      mode: 'yolo' | 'build' = 'build'
    ) => {
      if (!projectId) {
        toast.error('No project context available')
        return
      }

      const sessionId = card.session.id
      const messageId = card.pendingPlanMessageId
      const toastId = toast.loading('Creating worktree...')

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
          '[useWorktreeApproval] Failed to clear waiting state:',
          err
        )
      })

      // Step 2: Resolve plan content
      let planContent = updatedPlan || card.planContent
      if (!planContent && card.planFilePath) {
        try {
          planContent = await readPlanFile(card.planFilePath)
        } catch (err) {
          toast.error(`Failed to read plan file: ${err}`, { id: toastId })
          return
        }
      }
      if (!planContent) {
        toast.error('No plan content available', { id: toastId })
        return
      }

      // Step 3: Create new worktree
      let pendingWorktree: Worktree
      try {
        pendingWorktree = await invoke<Worktree>('create_worktree', {
          projectId,
        })
      } catch (err) {
        toast.error(`Failed to create worktree: ${err}`, { id: toastId })
        return
      }

      // Step 4: Wait for worktree to be ready
      let readyWorktree: Worktree
      try {
        readyWorktree = await new Promise<Worktree>((resolve, reject) => {
          const timeout = setTimeout(() => {
            void unlistenCreated.then(fn => fn())
            void unlistenError.then(fn => fn())
            reject(new Error('Worktree creation timed out'))
          }, 120_000)

          const unlistenCreated = listen<WorktreeCreatedEvent>(
            'worktree:created',
            event => {
              if (event.payload.worktree.id === pendingWorktree.id) {
                clearTimeout(timeout)
                void unlistenCreated.then(fn => fn())
                void unlistenError.then(fn => fn())
                resolve(event.payload.worktree)
              }
            }
          )

          const unlistenError = listen<WorktreeCreateErrorEvent>(
            'worktree:error',
            event => {
              if (event.payload.id === pendingWorktree.id) {
                clearTimeout(timeout)
                void unlistenCreated.then(fn => fn())
                void unlistenError.then(fn => fn())
                reject(new Error(event.payload.error))
              }
            }
          )
        })
      } catch (err) {
        toast.error(`Worktree creation failed: ${err}`, { id: toastId })
        return
      }

      toast.loading('Sending plan...', { id: toastId })

      // Step 5: Use the default session auto-created by the backend, or create one if none exists
      let newSession: Session
      try {
        const sessionsData = await invoke<WorktreeSessions>('get_sessions', {
          worktreeId: readyWorktree.id,
          worktreePath: readyWorktree.path,
        })
        if (sessionsData.sessions.length > 0 && sessionsData.sessions[0]) {
          newSession = sessionsData.sessions[0]
        } else {
          newSession = await invoke<Session>('create_session', {
            worktreeId: readyWorktree.id,
            worktreePath: readyWorktree.path,
          })
        }
      } catch (err) {
        toast.error(`Failed to get session: ${err}`, { id: toastId })
        return
      }

      // Step 6: Switch to new session and preserve the current presentation mode
      const chatStore = useChatStore.getState()
      chatStore.setActiveSession(readyWorktree.id, newSession.id)
      chatStore.addUserInitiatedSession(newSession.id)
      const projectsStore = useProjectsStore.getState()
      const uiStore = useUIStore.getState()
      navigateToApprovedWorktree(
        readyWorktree,
        {
          activeWorktreePath: chatStore.activeWorktreePath,
          sessionChatModalOpen: uiStore.sessionChatModalOpen,
        },
        {
          expandProject: projectsStore.expandProject,
          selectWorktree: projectsStore.selectWorktree,
          registerWorktreePath: chatStore.registerWorktreePath,
          setActiveWorktree: chatStore.setActiveWorktree,
          openWorktreeModal: (worktreeId, worktreePath) => {
            window.dispatchEvent(
              new CustomEvent('open-worktree-modal', {
                detail: { worktreeId, worktreePath },
              })
            )
          },
        }
      )

      // Step 7: Extract attachment references from original session
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
      } catch (err) {
        console.error('[useWorktreeApproval] Failed to fetch session:', err)
      }

      const imagePaths = extractImagePaths(allUserContent)
      const skillPaths = extractSkillPaths(allUserContent)
      const textFilePaths = extractTextFilePaths(allUserContent)

      // Step 8: Send plan as first message with mode-specific overrides
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

      chatStore.setExecutionMode(newSession.id, mode)
      chatStore.setLastSentMessage(newSession.id, message)
      chatStore.setError(newSession.id, null)
      chatStore.addSendingSession(newSession.id)
      chatStore.setSelectedModel(newSession.id, model)
      chatStore.setExecutingMode(newSession.id, mode)
      if (backend) {
        chatStore.setSelectedBackend(
          newSession.id,
          backend as 'claude' | 'codex' | 'opencode'
        )
      }

      queryClient.setQueryData<Session>(
        chatQueryKeys.session(newSession.id),
        old =>
          old
            ? { ...old, backend: backend ?? old.backend, selected_model: model }
            : old
      )

      // Persist model and backend before sending
      await invoke('set_session_model', {
        worktreeId: readyWorktree.id,
        worktreePath: readyWorktree.path,
        sessionId: newSession.id,
        model,
      }).catch(err =>
        console.error('[useWorktreeApproval] Failed to persist model:', err)
      )
      if (backend) {
        await invoke('set_session_backend', {
          worktreeId: readyWorktree.id,
          worktreePath: readyWorktree.path,
          sessionId: newSession.id,
          backend,
        }).catch(err =>
          console.error('[useWorktreeApproval] Failed to persist backend:', err)
        )
      }

      sendMessage.mutate({
        sessionId: newSession.id,
        worktreeId: readyWorktree.id,
        worktreePath: readyWorktree.path,
        message,
        model,
        executionMode: mode,
        thinkingLevel,
        effortLevel,
        customProfileName: card.session.selected_provider ?? undefined,
        backend,
      })

      toast.success(`Plan sent to new worktree (${modeLabel})`, { id: toastId })

      // Optionally close the original session
      if (preferences?.close_original_on_clear_context) {
        const command =
          preferences.removal_behavior === 'archive'
            ? 'archive_session'
            : 'close_session'

        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.filter(s => s.id !== sessionId),
            }
          }
        )

        invoke(command, { worktreeId, worktreePath, sessionId })
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions(worktreeId),
            })
          )
          .catch(err =>
            console.error(
              '[useWorktreeApproval] Failed to close original session:',
              err
            )
          )
      }
    },
    [worktreeId, worktreePath, projectId, queryClient, preferences, sendMessage]
  )

  const handleWorktreeApprovalYolo = useCallback(
    (card: SessionCardData, updatedPlan?: string) =>
      handleWorktreeApproval(card, updatedPlan, 'yolo'),
    [handleWorktreeApproval]
  )

  // Return null handlers if no project context (buttons won't render)
  if (!projectId) {
    return { handleWorktreeApproval: null, handleWorktreeApprovalYolo: null }
  }

  return { handleWorktreeApproval, handleWorktreeApprovalYolo }
}
