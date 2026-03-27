import { useCallback, type RefObject } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { invoke, listen } from '@/lib/transport'
import {
  chatQueryKeys,
  markPlanApproved as markPlanApprovedService,
  readPlanFile,
  persistEnqueue,
} from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import type {
  ChatMessage,
  EffortLevel,
  ExecutionMode,
  Question,
  QuestionAnswer,
  Session,
  ThinkingLevel,
  WorktreeSessions,
} from '@/types/chat'
import type { ReviewFinding } from '@/types/chat'
import { formatAnswersAsNaturalLanguage } from '@/services/chat'
import { parseReviewFindings, getFindingKey } from '../review-finding-utils'
import { findPlanContent, findPlanFilePath } from '../tool-call-utils'
import { navigateToApprovedWorktree } from '../worktree-approval-navigation'
import { getCodexPermissionApprovalMode } from '../permission-approval-utils'
import { generateId } from '@/lib/uuid'
import { preferencesQueryKeys } from '@/services/preferences'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { AppPreferences } from '@/types/preferences'
import type { Worktree, WorktreeCreatedEvent, WorktreeCreateErrorEvent } from '@/types/projects'

/** Git commands to auto-approve for magic prompts (no permission prompts needed) */
export const GIT_ALLOWED_TOOLS = [
  'Bash(git:*)', // All git commands
  // gh-cli/claude-cli are auto-allowed via --allowedTools in build_claude_args()
]

/** Type for the sendMessage mutation */
interface SendMessageMutation {
  mutate: (
    params: {
      sessionId: string
      worktreeId: string
      worktreePath: string
      message: string
      model?: string
      executionMode?: ExecutionMode
      thinkingLevel?: ThinkingLevel
      effortLevel?: string
      allowedTools?: string[]
      mcpConfig?: string
      customProfileName?: string
      backend?: string
    },
    options?: {
      onSettled?: () => void
    }
  ) => void
}

/** Type for the createSession mutation */
interface CreateSessionMutation {
  mutateAsync: (params: {
    worktreeId: string
    worktreePath: string
    name?: string
  }) => Promise<Session>
}

interface UseMessageHandlersParams {
  // Refs for session/worktree IDs (stable across re-renders)
  activeSessionIdRef: RefObject<string | null | undefined>
  activeWorktreeIdRef: RefObject<string | null | undefined>
  activeWorktreePathRef: RefObject<string | null | undefined>
  // Refs for settings (stable across re-renders)
  selectedModelRef: RefObject<string>
  buildModelRef: RefObject<string | null>
  buildBackendRef: RefObject<string | null>
  buildThinkingLevelRef: RefObject<string | null>
  yoloModelRef: RefObject<string | null>
  yoloBackendRef: RefObject<string | null>
  yoloThinkingLevelRef: RefObject<string | null>
  getCustomProfileName: () => string | undefined
  executionModeRef: RefObject<ExecutionMode>
  selectedThinkingLevelRef: RefObject<ThinkingLevel>
  selectedEffortLevelRef: RefObject<EffortLevel>
  useAdaptiveThinkingRef: RefObject<boolean>
  // MCP config builder (reads current refs internally)
  getMcpConfig: () => string | undefined
  // Actions
  sendMessage: SendMessageMutation
  createSession: CreateSessionMutation
  queryClient: QueryClient
  // Callbacks
  scrollToBottom: (instant?: boolean) => void
  markAtBottom: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  // For pending plan approval callback
  pendingPlanMessage: ChatMessage | null | undefined
  // For worktree approval (null = no project context, buttons won't render)
  projectIdRef: RefObject<string | null>
}

interface MessageHandlers {
  handleQuestionAnswer: (
    toolCallId: string,
    answers: QuestionAnswer[],
    questions: Question[]
  ) => void
  handleSkipQuestion: (toolCallId: string) => void
  handlePlanApproval: (messageId: string, updatedPlan?: string) => void
  handlePlanApprovalYolo: (messageId: string, updatedPlan?: string) => void
  handleStreamingPlanApproval: () => void
  handleStreamingPlanApprovalYolo: () => void
  handleClearContextApproval: (messageId: string) => void
  handleStreamingClearContextApproval: () => void
  handleClearContextApprovalBuild: (messageId: string) => void
  handleStreamingClearContextApprovalBuild: () => void
  handleWorktreeBuildApproval: (messageId: string) => void
  handleStreamingWorktreeBuildApproval: () => void
  handleWorktreeYoloApproval: (messageId: string) => void
  handleStreamingWorktreeYoloApproval: () => void
  handlePendingPlanApprovalCallback: () => void
  handlePermissionApproval: (
    sessionId: string,
    approvedPatterns: string[]
  ) => void
  handlePermissionApprovalYolo: (
    sessionId: string,
    approvedPatterns: string[]
  ) => void
  handlePermissionDeny: (sessionId: string) => void
  handleFixFinding: (
    finding: ReviewFinding,
    customSuggestion?: string
  ) => Promise<void>
  handleFixAllFindings: (
    findingsWithSuggestions: { finding: ReviewFinding; suggestion?: string }[]
  ) => Promise<void>
}

const THINKING_LEVEL_VALUES = new Set<ThinkingLevel>([
  'off',
  'think',
  'megathink',
  'ultrathink',
])

function isThinkingLevel(value: string | null | undefined): value is ThinkingLevel {
  if (!value) return false
  return THINKING_LEVEL_VALUES.has(value as ThinkingLevel)
}

function mapCodexReasoningToEffort(value: string | null | undefined): EffortLevel | undefined {
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
  backend: Session['backend'] | undefined,
  preferences: AppPreferences | undefined
): string {
  if (backend === 'codex') {
    return preferences?.selected_codex_model ?? 'gpt-5.4'
  }
  if (backend === 'opencode') {
    return preferences?.selected_opencode_model ?? 'opencode/gpt-5.3-codex'
  }
  return preferences?.selected_model ?? 'opus'
}

/**
 * Hook that extracts message-related handlers from ChatWindow.
 *
 * PERFORMANCE: Uses refs for session/worktree IDs to keep callbacks stable across session switches.
 */
export function useMessageHandlers({
  activeSessionIdRef,
  activeWorktreeIdRef,
  activeWorktreePathRef,
  selectedModelRef,
  buildModelRef,
  buildBackendRef,
  buildThinkingLevelRef,
  yoloModelRef,
  yoloBackendRef,
  yoloThinkingLevelRef,
  getCustomProfileName,
  executionModeRef,
  selectedThinkingLevelRef,
  selectedEffortLevelRef,
  useAdaptiveThinkingRef,
  getMcpConfig,
  sendMessage,
  createSession,
  queryClient,
  scrollToBottom,
  markAtBottom,
  inputRef,
  pendingPlanMessage,
  projectIdRef,
}: UseMessageHandlersParams): MessageHandlers {
  'use no memo'

  // Handle answer submission for AskUserQuestion
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleQuestionAnswer = useCallback(
    (toolCallId: string, answers: QuestionAnswer[], questions: Question[]) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Mark as answered so it becomes read-only (also stores answers for collapsed view)
      const {
        markQuestionAnswered,
        addSendingSession,
        setSelectedModel,
        setExecutingMode,
        setSessionReviewing,
        setWaitingForInput,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()
      markQuestionAnswered(sessionId, toolCallId, answers)

      // Clear the preserved tool calls and review state since we're sending a response
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)

      // Persist cleared waiting state to backend (for canvas view where session may not be active)
      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: false,
        waitingForInputType: null,
      }).catch(err => {
        console.error(
          '[useMessageHandlers] Failed to clear waiting state:',
          err
        )
      })

      // Mark as at-bottom so Tier 4 / Tier 2 auto-scroll kicks in when
      // streaming starts. Don't physically scroll — let native CSS scroll
      // anchoring handle the question form collapse smoothly.
      markAtBottom()

      // Format answers as natural language
      const message = formatAnswersAsNaturalLanguage(questions, answers)

      // Add to sending state
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, executionModeRef.current)

      // Send the formatted answer
      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: selectedModelRef.current,
          executionMode: executionModeRef.current,
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      executionModeRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      sendMessage,
      markAtBottom,
      inputRef,
    ]
  )

  // Handle skipping questions - cancels the question flow without sending anything to Claude
  // Sets session-level skip state to auto-skip all subsequent questions until next user message
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleSkipQuestion = useCallback(
    (toolCallId: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      const {
        markQuestionAnswered,
        setQuestionsSkipped,
        clearToolCalls,
        clearStreamingContentBlocks,
        removeSendingSession,
        setWaitingForInput,
        setSessionReviewing,
      } = useChatStore.getState()

      // Mark this question as answered (empty answers = skipped)
      markQuestionAnswered(sessionId, toolCallId, [])

      // Set session-level skip state to auto-skip all subsequent questions
      // No message is sent to Claude - the flow is simply cancelled
      setQuestionsSkipped(sessionId, true)

      // Clear the preserved tool calls and sending state since we're done with this interaction
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      removeSendingSession(sessionId)

      // Clear waiting state and mark as reviewing since interaction is complete
      setWaitingForInput(sessionId, false)
      setSessionReviewing(sessionId, true)

      // Persist cleared waiting state to backend (for canvas view where session may not be active)
      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: false,
        waitingForInputType: null,
      }).catch(err => {
        console.error(
          '[useMessageHandlers] Failed to clear waiting state:',
          err
        )
      })

      // Focus input so user can type their next message
      inputRef.current?.focus()
    },
    [activeSessionIdRef, activeWorktreeIdRef, activeWorktreePathRef, inputRef]
  )

  // Handle plan approval for ExitPlanMode
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handlePlanApproval = useCallback(
    (messageId: string, updatedPlan?: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Mark plan as approved in the message (persisted to disk)
      // Optimistically update the UI to hide the approve button
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

      // Explicitly set to build mode (not toggle, to avoid switching back to plan if already in build)
      const {
        setExecutionMode: setMode,
        addSendingSession,
        setSelectedModel,
        setLastSentMessage,
        setError,
        setExecutingMode,
        setSessionReviewing,
        setWaitingForInput,
        setPendingPlanMessageId,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()
      setMode(sessionId, 'build')

      // Clear the preserved tool calls and review state since we're sending a response
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)
      setPendingPlanMessageId(sessionId, null)

      // Mark as at-bottom so Tier 4 / Tier 2 auto-scroll kicks in when
      // streaming starts. Don't physically scroll — let native CSS scroll
      // anchoring handle the plan collapse smoothly.
      markAtBottom()

      // Format approval message - include updated plan if provided
      // For Codex: use explicit execution instruction since it resumes a thread
      const isCodex =
        useChatStore.getState().selectedBackends[sessionId] === 'codex'
      const message = updatedPlan
        ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
        : isCodex
          ? 'Execute the plan you created. Implement all changes described.'
          : 'Plan approved. Begin implementing the changes now. Do not re-explain the plan — start writing code.'
      // Send approval message so the backend continues with execution
      // NOTE: setLastSentMessage is critical for permission denial flow - without it,
      // the denied message context won't be set and approval UI won't work
      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, 'build')
      const markPromise = markPlanApprovedService(
        worktreeId,
        worktreePath,
        sessionId,
        messageId
      ).catch(err => {
        console.error('[useMessageHandlers] markPlanApproved failed:', err)
      })

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
        .catch(err => {
          console.error(
            '[useMessageHandlers] Failed to clear waiting state:',
            err
          )
        })
        .finally(() => {
          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(worktreeId),
          })

          sendMessage.mutate(
            {
              sessionId,
              worktreeId,
              worktreePath,
              message,
              model: selectedModelRef.current,
              executionMode: 'build',
              thinkingLevel: selectedThinkingLevelRef.current,
              effortLevel: useAdaptiveThinkingRef.current
                ? selectedEffortLevelRef.current
                : undefined,
              mcpConfig: getMcpConfig(),
              customProfileName: getCustomProfileName(),
            },
            {
              onSettled: () => {
                inputRef.current?.focus()
              },
            }
          )
        })
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      markAtBottom,
      sendMessage,
      queryClient,
      inputRef,
    ]
  )

  // Handle plan approval with yolo mode (auto-approve all future tools)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handlePlanApprovalYolo = useCallback(
    (messageId: string, updatedPlan?: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Mark plan as approved in the message (persisted to disk)
      // Optimistically update the UI to hide the approve button
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

      // Set to yolo mode for auto-approval of all future tools
      const {
        setExecutionMode: setMode,
        addSendingSession,
        setSelectedModel,
        setLastSentMessage,
        setError,
        setExecutingMode,
        setSessionReviewing,
        setWaitingForInput,
        setPendingPlanMessageId,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()
      setMode(sessionId, 'yolo')

      // Clear the preserved tool calls and review state since we're sending a response
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)
      setPendingPlanMessageId(sessionId, null)

      // Mark as at-bottom so Tier 4 / Tier 2 auto-scroll kicks in when
      // streaming starts. Don't physically scroll — let native CSS scroll
      // anchoring handle the plan collapse smoothly.
      markAtBottom()

      // Format approval message - include updated plan if provided
      const isCodexYolo =
        useChatStore.getState().selectedBackends[sessionId] === 'codex'
      const message = updatedPlan
        ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
        : isCodexYolo
          ? 'Execute the plan you created. Implement all changes described.'
          : 'Plan approved (yolo mode). Begin implementing all changes immediately without asking for confirmation. Do not re-explain the plan — start writing code.'
      // Send approval message so the backend continues with execution
      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, 'yolo')
      const markPromise = markPlanApprovedService(
        worktreeId,
        worktreePath,
        sessionId,
        messageId
      ).catch(err => {
        console.error('[useMessageHandlers] markPlanApproved failed:', err)
      })

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
        .catch(err => {
          console.error(
            '[useMessageHandlers] Failed to clear waiting state:',
            err
          )
        })
        .finally(() => {
          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(worktreeId),
          })

          sendMessage.mutate(
            {
              sessionId,
              worktreeId,
              worktreePath,
              message,
              model: selectedModelRef.current,
              executionMode: 'yolo',
              thinkingLevel: selectedThinkingLevelRef.current,
              effortLevel: useAdaptiveThinkingRef.current
                ? selectedEffortLevelRef.current
                : undefined,
              mcpConfig: getMcpConfig(),
              customProfileName: getCustomProfileName(),
            },
            {
              onSettled: () => {
                inputRef.current?.focus()
              },
            }
          )
        })
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      markAtBottom,
      sendMessage,
      queryClient,
      inputRef,
    ]
  )

  // Callback for floating button pending plan approval
  const handlePendingPlanApprovalCallback = useCallback(() => {
    if (pendingPlanMessage) {
      handlePlanApproval(pendingPlanMessage.id)
    }
  }, [pendingPlanMessage, handlePlanApproval])

  // Handle plan approval during streaming (when message isn't persisted yet)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleStreamingPlanApproval = useCallback(() => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    if (!sessionId || !worktreeId || !worktreePath) return

    // Mark as approved in streaming state (prevents double-approval)
    const {
      setStreamingPlanApproved,
      setExecutionMode: setMode,
      setSelectedModel,
      setLastSentMessage,
      setError,
      addSendingSession,
      setExecutingMode,
      setSessionReviewing,
      setWaitingForInput,
      clearToolCalls,
      clearStreamingContentBlocks,
    } = useChatStore.getState()
    setStreamingPlanApproved(sessionId, true)

    // Clear the preserved tool calls and review state since we're sending a response
    clearToolCalls(sessionId)
    clearStreamingContentBlocks(sessionId)
    setSessionReviewing(sessionId, false)
    setWaitingForInput(sessionId, false)

    // Mark as at-bottom so Tier 4 / Tier 2 auto-scroll kicks in when
    // streaming starts. Don't physically scroll — let native CSS scroll
    // anchoring handle the plan collapse smoothly.
    markAtBottom()

    // Explicitly set to build mode (not toggle, to avoid switching back to plan if already in build)
    setMode(sessionId, 'build')
    setSelectedModel(sessionId, selectedModelRef.current)

    // Send approval message to Claude so it continues with execution
    // NOTE: setLastSentMessage is critical for permission denial flow - without it,
    // the denied message context won't be set and approval UI won't work
    const buildApprovalMsg = 'Plan approved. Begin implementing the changes now. Do not re-explain the plan — start writing code.'
    setLastSentMessage(sessionId, buildApprovalMsg)
    setError(sessionId, null)
    addSendingSession(sessionId)
    setExecutingMode(sessionId, 'build')

    sendMessage.mutate(
      {
        sessionId,
        worktreeId,
        worktreePath,
        message: buildApprovalMsg,
        model: selectedModelRef.current,
        executionMode: 'build',
        thinkingLevel: selectedThinkingLevelRef.current,
        effortLevel: useAdaptiveThinkingRef.current
          ? selectedEffortLevelRef.current
          : undefined,
        mcpConfig: getMcpConfig(),
        customProfileName: getCustomProfileName(),
      },
      {
        onSettled: () => {
          inputRef.current?.focus()
        },
      }
    )
  }, [
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    selectedModelRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    getMcpConfig,
    getCustomProfileName,
    markAtBottom,
    sendMessage,
    inputRef,
  ])

  // Handle plan approval during streaming with yolo mode (auto-approve all future tools)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleStreamingPlanApprovalYolo = useCallback(() => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    if (!sessionId || !worktreeId || !worktreePath) return

    // Mark as approved in streaming state (prevents double-approval)
    const {
      setStreamingPlanApproved,
      setExecutionMode: setMode,
      setSelectedModel,
      setLastSentMessage,
      setError,
      addSendingSession,
      setExecutingMode,
      setSessionReviewing,
      setWaitingForInput,
      clearToolCalls,
      clearStreamingContentBlocks,
    } = useChatStore.getState()
    setStreamingPlanApproved(sessionId, true)

    // Clear the preserved tool calls and review state since we're sending a response
    clearToolCalls(sessionId)
    clearStreamingContentBlocks(sessionId)
    setSessionReviewing(sessionId, false)
    setWaitingForInput(sessionId, false)

    // Mark as at-bottom so Tier 4 / Tier 2 auto-scroll kicks in when
    // streaming starts. Don't physically scroll — let native CSS scroll
    // anchoring handle the plan collapse smoothly.
    markAtBottom()

    // Set to yolo mode for auto-approval of all future tools
    setMode(sessionId, 'yolo')
    setSelectedModel(sessionId, selectedModelRef.current)

    // Send approval message to Claude so it continues with execution
    const yoloApprovalMsg = 'Plan approved (yolo mode). Begin implementing all changes immediately without asking for confirmation. Do not re-explain the plan — start writing code.'
    setLastSentMessage(sessionId, yoloApprovalMsg)
    setError(sessionId, null)
    addSendingSession(sessionId)
    setExecutingMode(sessionId, 'yolo')

    sendMessage.mutate(
      {
        sessionId,
        worktreeId,
        worktreePath,
        message: yoloApprovalMsg,
        model: selectedModelRef.current,
        executionMode: 'yolo',
        thinkingLevel: selectedThinkingLevelRef.current,
        effortLevel: useAdaptiveThinkingRef.current
          ? selectedEffortLevelRef.current
          : undefined,
        mcpConfig: getMcpConfig(),
        customProfileName: getCustomProfileName(),
      },
      {
        onSettled: () => {
          inputRef.current?.focus()
        },
      }
    )
  }, [
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    selectedModelRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    getMcpConfig,
    getCustomProfileName,
    markAtBottom,
    sendMessage,
    inputRef,
  ])

  // Handle clear context approval for persisted messages
  // Resolves plan content from message tool calls, marks approved, creates new session, sends plan
  const handleClearContextApproval = useCallback(
    async (messageId: string, mode: 'yolo' | 'build' = 'yolo') => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Get the message to extract plan content
      const sessionData = queryClient.getQueryData<Session>(
        chatQueryKeys.session(sessionId)
      )
      const message = sessionData?.messages.find(m => m.id === messageId)
      if (!message?.tool_calls) {
        toast.error('No plan content available')
        return
      }

      // Resolve plan content from tool calls
      let planContent = findPlanContent(message.tool_calls)
      if (!planContent) {
        const planFilePath = findPlanFilePath(message.tool_calls)
        if (planFilePath) {
          try {
            planContent = await readPlanFile(planFilePath)
          } catch (err) {
            toast.error(`Failed to read plan file: ${err}`)
            return
          }
        }
      }
      if (!planContent) {
        toast.error('No plan content available')
        return
      }

      // Mark plan approved on original session
      markPlanApprovedService(worktreeId, worktreePath, sessionId, messageId)
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
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      const store = useChatStore.getState()
      store.clearToolCalls(sessionId)
      store.clearStreamingContentBlocks(sessionId)
      store.setSessionReviewing(sessionId, false)
      store.setWaitingForInput(sessionId, false)

      // Create new session
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

      // Switch to new session
      store.setActiveSession(worktreeId, newSession.id)

      // Resolve model/backend/thinking based on mode
      const isYolo = mode === 'yolo'
      const modeModelRef = isYolo ? yoloModelRef : buildModelRef
      const modeBackendRef = isYolo ? yoloBackendRef : buildBackendRef
      const modeThinkingRef = isYolo ? yoloThinkingLevelRef : buildThinkingLevelRef
      const modeLabel = isYolo ? 'Yolo' : 'Build'

      const currentSessionBackend = queryClient.getQueryData<Session>(
        chatQueryKeys.session(sessionId)
      )?.backend
      const prefs = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      const modeBackendOverride = (modeBackendRef.current as Session['backend']) ?? null
      const resolvedBackend = modeBackendOverride ?? undefined
      const modelBackend = resolvedBackend ?? currentSessionBackend
      const resolvedModel =
        modeModelRef.current ??
        (modeBackendOverride
          ? getDefaultModelForBackend(modelBackend, prefs)
          : selectedModelRef.current)
      const modeOverride = (modeModelRef.current || modeBackendOverride)
        ? [resolvedBackend, resolvedModel].filter(Boolean).join(' / ')
        : ''
      if (modeOverride) toast.info(`${modeLabel}: ${modeOverride}`)
      const planMessage = modeOverride
        ? `[${modeLabel}: ${modeOverride}]\nExecute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
        : `Execute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
      store.setExecutionMode(newSession.id, mode)
      store.setLastSentMessage(newSession.id, planMessage)
      store.setError(newSession.id, null)
      store.addSendingSession(newSession.id)
      store.setSelectedModel(newSession.id, resolvedModel)
      store.setExecutingMode(newSession.id, mode)
      if (resolvedBackend) {
        store.setSelectedBackend(
          newSession.id,
          resolvedBackend as 'claude' | 'codex' | 'opencode'
        )
      }
      // Optimistically update TanStack Query cache so UI shows correct backend/model
      // immediately. Without this, session?.backend (from query cache) defaults to 'claude'
      // and overrides the Zustand value in the backend resolution chain.
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(newSession.id),
        old => old ? { ...old, backend: resolvedBackend ?? old.backend, selected_model: resolvedModel } : old
      )

      // Persist model and backend to Rust session BEFORE sending so send_chat_message
      // reads the updated session state (both use with_sessions_mut, so ordering matters)
      await invoke('set_session_model', {
        worktreeId, worktreePath, sessionId: newSession.id, model: resolvedModel,
      }).catch(err => console.error('[clearContext] Failed to persist model:', err))
      if (resolvedBackend) {
        await invoke('set_session_backend', {
          worktreeId, worktreePath, sessionId: newSession.id, backend: resolvedBackend,
        }).catch(err => console.error('[clearContext] Failed to persist backend:', err))
      }

      const effectiveBackend = resolvedBackend ?? currentSessionBackend
      let resolvedThinkingLevel: ThinkingLevel = selectedThinkingLevelRef.current
      let resolvedEffortLevel: EffortLevel | undefined = useAdaptiveThinkingRef.current
        ? selectedEffortLevelRef.current
        : undefined
      if (effectiveBackend === 'codex') {
        resolvedThinkingLevel = 'off'
        resolvedEffortLevel =
          mapCodexReasoningToEffort(modeThinkingRef.current) ?? selectedEffortLevelRef.current
      } else if (isThinkingLevel(modeThinkingRef.current)) {
        resolvedThinkingLevel = modeThinkingRef.current
      }
      sendMessage.mutate({
        sessionId: newSession.id,
        worktreeId,
        worktreePath,
        message: planMessage,
        model: resolvedModel,
        executionMode: mode,
        thinkingLevel: resolvedThinkingLevel,
        effortLevel: resolvedEffortLevel,
        mcpConfig: getMcpConfig(),
        customProfileName: getCustomProfileName(),
        backend: resolvedBackend,
      })

      // Optionally close the original session immediately.
      // cancel_process_if_running (used by close/archive) safely skips idle sessions,
      // and with_sessions_mut uses a per-worktree mutex so there's no file-level race.
      if (prefs?.close_original_on_clear_context) {
        const command =
          prefs.removal_behavior === 'archive'
            ? 'archive_session'
            : 'close_session'

        // Optimistically remove from UI immediately
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

        invoke(command, { worktreeId, worktreePath, sessionId })
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions(worktreeId),
            })
          )
          .catch(err =>
            console.error(
              '[useMessageHandlers] Failed to close original session:',
              err
            )
          )
      }
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      buildModelRef,
      buildBackendRef,
      buildThinkingLevelRef,
      yoloModelRef,
      yoloBackendRef,
      yoloThinkingLevelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      createSession,
      sendMessage,
      queryClient,
    ]
  )

  // Handle clear context approval during streaming
  const handleStreamingClearContextApproval = useCallback(async (mode: 'yolo' | 'build' = 'yolo') => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    if (!sessionId || !worktreeId || !worktreePath) return

    // Get streaming content blocks to extract plan content
    const store = useChatStore.getState()
    const contentBlocks = store.streamingContentBlocks[sessionId]
    const toolCalls = store.activeToolCalls[sessionId]

    // Try to get plan content from tool calls first, then from streaming blocks
    let planContent: string | null = null
    if (toolCalls) {
      planContent = findPlanContent(toolCalls)
      if (!planContent) {
        const planFilePath = findPlanFilePath(toolCalls)
        if (planFilePath) {
          try {
            planContent = await readPlanFile(planFilePath)
          } catch {
            // Fall through to content blocks
          }
        }
      }
    }

    if (!planContent && contentBlocks) {
      // Try to extract from streaming content blocks (text content)
      for (const block of contentBlocks) {
        if ('text' in block && block.text) {
          planContent = block.text
          break
        }
      }
    }

    if (!planContent) {
      toast.error('No plan content available')
      return
    }

    // Mark as approved in streaming state
    store.setStreamingPlanApproved(sessionId, true)
    store.clearToolCalls(sessionId)
    store.clearStreamingContentBlocks(sessionId)
    store.setSessionReviewing(sessionId, false)
    store.setWaitingForInput(sessionId, false)

    // Create new session
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

    // Switch to new session
    store.setActiveSession(worktreeId, newSession.id)

    // Resolve model/backend/thinking based on mode
    const isYolo = mode === 'yolo'
    const modeModelRef = isYolo ? yoloModelRef : buildModelRef
    const modeBackendRef = isYolo ? yoloBackendRef : buildBackendRef
    const modeThinkingRef = isYolo ? yoloThinkingLevelRef : buildThinkingLevelRef
    const modeLabel = isYolo ? 'Yolo' : 'Build'

    const currentSessionBackend = queryClient.getQueryData<Session>(
      chatQueryKeys.session(sessionId)
    )?.backend
    const prefs = queryClient.getQueryData<AppPreferences>(
      preferencesQueryKeys.preferences()
    )
    const modeBackendOverride = (modeBackendRef.current as Session['backend']) ?? null
    const resolvedBackend = modeBackendOverride ?? undefined
    const modelBackend = resolvedBackend ?? currentSessionBackend
    const resolvedModel =
      modeModelRef.current ??
      (modeBackendOverride
        ? getDefaultModelForBackend(modelBackend, prefs)
        : selectedModelRef.current)
    const modeOverride = (modeModelRef.current || modeBackendOverride)
      ? [resolvedBackend, resolvedModel].filter(Boolean).join(' / ')
      : ''
    if (modeOverride) toast.info(`${modeLabel}: ${modeOverride}`)
    const planMessage = modeOverride
      ? `[${modeLabel}: ${modeOverride}]\nExecute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
      : `Execute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
    store.setExecutionMode(newSession.id, mode)
    store.setLastSentMessage(newSession.id, planMessage)
    store.setError(newSession.id, null)
    store.addSendingSession(newSession.id)
    store.setSelectedModel(newSession.id, resolvedModel)
    store.setExecutingMode(newSession.id, mode)
    if (resolvedBackend) {
      store.setSelectedBackend(
        newSession.id,
        resolvedBackend as 'claude' | 'codex' | 'opencode'
      )
    }
    // Optimistically update TanStack Query cache so UI shows correct backend/model immediately.
    queryClient.setQueryData<Session>(
      chatQueryKeys.session(newSession.id),
      old => old ? { ...old, backend: resolvedBackend ?? old.backend, selected_model: resolvedModel } : old
    )

    // Persist model and backend to Rust session BEFORE sending so send_chat_message
    // reads the updated session state (both use with_sessions_mut, so ordering matters)
    await invoke('set_session_model', {
      worktreeId, worktreePath, sessionId: newSession.id, model: resolvedModel,
    }).catch(err => console.error('[streamingClearContext] Failed to persist model:', err))
    if (resolvedBackend) {
      await invoke('set_session_backend', {
        worktreeId, worktreePath, sessionId: newSession.id, backend: resolvedBackend,
      }).catch(err => console.error('[streamingClearContext] Failed to persist backend:', err))
    }

    const effectiveBackend = resolvedBackend ?? currentSessionBackend
    let resolvedThinkingLevel: ThinkingLevel = selectedThinkingLevelRef.current
    let resolvedEffortLevel: EffortLevel | undefined = useAdaptiveThinkingRef.current
      ? selectedEffortLevelRef.current
      : undefined
    if (effectiveBackend === 'codex') {
      resolvedThinkingLevel = 'off'
      resolvedEffortLevel =
        mapCodexReasoningToEffort(modeThinkingRef.current) ?? selectedEffortLevelRef.current
    } else if (isThinkingLevel(modeThinkingRef.current)) {
      resolvedThinkingLevel = modeThinkingRef.current
    }
    sendMessage.mutate({
      sessionId: newSession.id,
      worktreeId,
      worktreePath,
      message: planMessage,
      model: resolvedModel,
      executionMode: mode,
      thinkingLevel: resolvedThinkingLevel,
      effortLevel: resolvedEffortLevel,
      mcpConfig: getMcpConfig(),
      customProfileName: getCustomProfileName(),
      backend: resolvedBackend,
    })

    // Optionally close the original session immediately.
    // cancel_process_if_running (used by close/archive) safely skips idle sessions,
    // and with_sessions_mut uses a per-worktree mutex so there's no file-level race.
    if (prefs?.close_original_on_clear_context) {
      const command =
        prefs.removal_behavior === 'archive'
          ? 'archive_session'
          : 'close_session'

      // Optimistically remove from UI immediately
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

      invoke(command, { worktreeId, worktreePath, sessionId })
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(worktreeId),
          })
        )
        .catch(err =>
          console.error(
            '[useMessageHandlers] Failed to close original session:',
            err
          )
        )
    }
  }, [
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    selectedModelRef,
    buildModelRef,
    buildBackendRef,
    buildThinkingLevelRef,
    yoloModelRef,
    yoloBackendRef,
    yoloThinkingLevelRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    getMcpConfig,
    getCustomProfileName,
    createSession,
    sendMessage,
    queryClient,
  ])

  const handleClearContextApprovalBuild = useCallback(
    (messageId: string) => handleClearContextApproval(messageId, 'build'),
    [handleClearContextApproval]
  )

  const handleStreamingClearContextApprovalBuild = useCallback(
    () => handleStreamingClearContextApproval('build'),
    [handleStreamingClearContextApproval]
  )

  // Handle worktree approval (create new worktree + send plan)
  const handleWorktreeApproval = useCallback(
    async (messageId: string, mode: 'yolo' | 'build' = 'build') => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      const projectId = projectIdRef.current
      if (!sessionId || !worktreeId || !worktreePath || !projectId) return

      // Get the message to extract plan content
      const sessionData = queryClient.getQueryData<Session>(
        chatQueryKeys.session(sessionId)
      )
      const message = sessionData?.messages.find(m => m.id === messageId)
      if (!message?.tool_calls) {
        toast.error('No plan content available')
        return
      }

      // Resolve plan content from tool calls
      let planContent = findPlanContent(message.tool_calls)
      if (!planContent) {
        const planFilePath = findPlanFilePath(message.tool_calls)
        if (planFilePath) {
          try {
            planContent = await readPlanFile(planFilePath)
          } catch (err) {
            toast.error(`Failed to read plan file: ${err}`)
            return
          }
        }
      }
      if (!planContent) {
        toast.error('No plan content available')
        return
      }

      const toastId = toast.loading('Creating worktree...')

      // Mark plan approved on original session
      markPlanApprovedService(worktreeId, worktreePath, sessionId, messageId)
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
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      const store = useChatStore.getState()
      store.clearToolCalls(sessionId)
      store.clearStreamingContentBlocks(sessionId)
      store.setSessionReviewing(sessionId, false)
      store.setWaitingForInput(sessionId, false)

      // Create new worktree
      let pendingWorktree: Worktree
      try {
        pendingWorktree = await invoke<Worktree>('create_worktree', { projectId })
      } catch (err) {
        toast.error(`Failed to create worktree: ${err}`, { id: toastId })
        return
      }

      // Wait for worktree to be ready
      let readyWorktree: Worktree
      try {
        readyWorktree = await new Promise<Worktree>((resolve, reject) => {
          const timeout = setTimeout(() => {
            void unlistenCreated.then(fn => fn())
            void unlistenError.then(fn => fn())
            reject(new Error('Worktree creation timed out'))
          }, 120_000)

          const unlistenCreated = listen<WorktreeCreatedEvent>('worktree:created', event => {
            if (event.payload.worktree.id === pendingWorktree.id) {
              clearTimeout(timeout)
              void unlistenCreated.then(fn => fn())
              void unlistenError.then(fn => fn())
              resolve(event.payload.worktree)
            }
          })

          const unlistenError = listen<WorktreeCreateErrorEvent>('worktree:error', event => {
            if (event.payload.id === pendingWorktree.id) {
              clearTimeout(timeout)
              void unlistenCreated.then(fn => fn())
              void unlistenError.then(fn => fn())
              reject(new Error(event.payload.error))
            }
          })
        })
      } catch (err) {
        toast.error(`Worktree creation failed: ${err}`, { id: toastId })
        return
      }

      toast.loading('Sending plan...', { id: toastId })

      // Use the default session auto-created by the backend, or create one if none exists
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

      store.setActiveSession(readyWorktree.id, newSession.id)
      store.addUserInitiatedSession(newSession.id)
      const projectsStore = useProjectsStore.getState()
      const uiStore = useUIStore.getState()
      navigateToApprovedWorktree(
        readyWorktree,
        {
          activeWorktreePath: store.activeWorktreePath,
          sessionChatModalOpen: uiStore.sessionChatModalOpen,
        },
        {
          expandProject: projectsStore.expandProject,
          selectWorktree: projectsStore.selectWorktree,
          registerWorktreePath: store.registerWorktreePath,
          setActiveWorktree: store.setActiveWorktree,
          openWorktreeModal: (worktreeId, worktreePath) => {
            window.dispatchEvent(
              new CustomEvent('open-worktree-modal', {
                detail: { worktreeId, worktreePath },
              })
            )
          },
        }
      )

      // Resolve model/backend/thinking based on mode
      const isYolo = mode === 'yolo'
      const modeModelRef = isYolo ? yoloModelRef : buildModelRef
      const modeBackendRef = isYolo ? yoloBackendRef : buildBackendRef
      const modeThinkingRef = isYolo ? yoloThinkingLevelRef : buildThinkingLevelRef
      const modeLabel = isYolo ? 'Yolo' : 'Build'

      const currentSessionBackend = queryClient.getQueryData<Session>(
        chatQueryKeys.session(sessionId)
      )?.backend
      const prefs = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      const modeBackendOverride = (modeBackendRef.current as Session['backend']) ?? null
      const resolvedBackend = modeBackendOverride ?? undefined
      const modelBackend = resolvedBackend ?? currentSessionBackend
      const resolvedModel =
        modeModelRef.current ??
        (modeBackendOverride
          ? getDefaultModelForBackend(modelBackend, prefs)
          : selectedModelRef.current)
      const modeOverride = (modeModelRef.current || modeBackendOverride)
        ? [resolvedBackend, resolvedModel].filter(Boolean).join(' / ')
        : ''
      if (modeOverride) toast.info(`${modeLabel}: ${modeOverride}`)
      const planMessage = modeOverride
        ? `[${modeLabel}: ${modeOverride}]\nExecute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
        : `Execute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
      store.setExecutionMode(newSession.id, mode)
      store.setLastSentMessage(newSession.id, planMessage)
      store.setError(newSession.id, null)
      store.addSendingSession(newSession.id)
      store.setSelectedModel(newSession.id, resolvedModel)
      store.setExecutingMode(newSession.id, mode)
      if (resolvedBackend) {
        store.setSelectedBackend(
          newSession.id,
          resolvedBackend as 'claude' | 'codex' | 'opencode'
        )
      }
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(newSession.id),
        old => old ? { ...old, backend: resolvedBackend ?? old.backend, selected_model: resolvedModel } : old
      )

      await invoke('set_session_model', {
        worktreeId: readyWorktree.id, worktreePath: readyWorktree.path,
        sessionId: newSession.id, model: resolvedModel,
      }).catch(err => console.error('[worktreeApproval] Failed to persist model:', err))
      if (resolvedBackend) {
        await invoke('set_session_backend', {
          worktreeId: readyWorktree.id, worktreePath: readyWorktree.path,
          sessionId: newSession.id, backend: resolvedBackend,
        }).catch(err => console.error('[worktreeApproval] Failed to persist backend:', err))
      }

      const effectiveBackend = resolvedBackend ?? currentSessionBackend
      let resolvedThinkingLevel: ThinkingLevel = selectedThinkingLevelRef.current
      let resolvedEffortLevel: EffortLevel | undefined = useAdaptiveThinkingRef.current
        ? selectedEffortLevelRef.current
        : undefined
      if (effectiveBackend === 'codex') {
        resolvedThinkingLevel = 'off'
        resolvedEffortLevel =
          mapCodexReasoningToEffort(modeThinkingRef.current) ?? selectedEffortLevelRef.current
      } else if (isThinkingLevel(modeThinkingRef.current)) {
        resolvedThinkingLevel = modeThinkingRef.current
      }
      sendMessage.mutate({
        sessionId: newSession.id,
        worktreeId: readyWorktree.id,
        worktreePath: readyWorktree.path,
        message: planMessage,
        model: resolvedModel,
        executionMode: mode,
        thinkingLevel: resolvedThinkingLevel,
        effortLevel: resolvedEffortLevel,
        mcpConfig: getMcpConfig(),
        customProfileName: getCustomProfileName(),
        backend: resolvedBackend,
      })

      toast.success(`Plan sent to new worktree (${modeLabel})`, { id: toastId })

      // Optionally close the original session
      if (prefs?.close_original_on_clear_context) {
        const closeCommand =
          prefs.removal_behavior === 'archive'
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

        invoke(closeCommand, { worktreeId, worktreePath, sessionId })
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: chatQueryKeys.sessions(worktreeId),
            })
          )
          .catch(err =>
            console.error('[worktreeApproval] Failed to close original session:', err)
          )
      }
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      projectIdRef,
      selectedModelRef,
      buildModelRef,
      buildBackendRef,
      buildThinkingLevelRef,
      yoloModelRef,
      yoloBackendRef,
      yoloThinkingLevelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      sendMessage,
      queryClient,
    ]
  )

  // Handle streaming worktree approval
  const handleStreamingWorktreeApproval = useCallback(async (mode: 'yolo' | 'build' = 'build') => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    const projectId = projectIdRef.current
    if (!sessionId || !worktreeId || !worktreePath || !projectId) return

    // Get streaming content blocks to extract plan content
    const store = useChatStore.getState()
    const contentBlocks = store.streamingContentBlocks[sessionId]
    const toolCalls = store.activeToolCalls[sessionId]

    let planContent: string | null = null
    if (toolCalls) {
      planContent = findPlanContent(toolCalls)
      if (!planContent) {
        const planFilePath = findPlanFilePath(toolCalls)
        if (planFilePath) {
          try {
            planContent = await readPlanFile(planFilePath)
          } catch {
            // Fall through to content blocks
          }
        }
      }
    }

    if (!planContent && contentBlocks) {
      for (const block of contentBlocks) {
        if ('text' in block && block.text) {
          planContent = block.text
          break
        }
      }
    }

    if (!planContent) {
      toast.error('No plan content available')
      return
    }

    const toastId = toast.loading('Creating worktree...')

    // Mark as approved in streaming state
    store.setStreamingPlanApproved(sessionId, true)
    store.clearToolCalls(sessionId)
    store.clearStreamingContentBlocks(sessionId)
    store.setSessionReviewing(sessionId, false)
    store.setWaitingForInput(sessionId, false)

    // Create new worktree
    let pendingWorktree: Worktree
    try {
      pendingWorktree = await invoke<Worktree>('create_worktree', { projectId })
    } catch (err) {
      toast.error(`Failed to create worktree: ${err}`, { id: toastId })
      return
    }

    // Wait for worktree to be ready
    let readyWorktree: Worktree
    try {
      readyWorktree = await new Promise<Worktree>((resolve, reject) => {
        const timeout = setTimeout(() => {
          void unlistenCreated.then(fn => fn())
          void unlistenError.then(fn => fn())
          reject(new Error('Worktree creation timed out'))
        }, 120_000)

        const unlistenCreated = listen<WorktreeCreatedEvent>('worktree:created', event => {
          if (event.payload.worktree.id === pendingWorktree.id) {
            clearTimeout(timeout)
            void unlistenCreated.then(fn => fn())
            void unlistenError.then(fn => fn())
            resolve(event.payload.worktree)
          }
        })

        const unlistenError = listen<WorktreeCreateErrorEvent>('worktree:error', event => {
          if (event.payload.id === pendingWorktree.id) {
            clearTimeout(timeout)
            void unlistenCreated.then(fn => fn())
            void unlistenError.then(fn => fn())
            reject(new Error(event.payload.error))
          }
        })
      })
    } catch (err) {
      toast.error(`Worktree creation failed: ${err}`, { id: toastId })
      return
    }

    toast.loading('Sending plan...', { id: toastId })

    // Use the default session auto-created by the backend, or create one if none exists
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

    store.setActiveSession(readyWorktree.id, newSession.id)
    store.addUserInitiatedSession(newSession.id)
    const projectsStore = useProjectsStore.getState()
    const uiStore = useUIStore.getState()
    navigateToApprovedWorktree(
      readyWorktree,
      {
        activeWorktreePath: store.activeWorktreePath,
        sessionChatModalOpen: uiStore.sessionChatModalOpen,
      },
      {
        expandProject: projectsStore.expandProject,
        selectWorktree: projectsStore.selectWorktree,
        registerWorktreePath: store.registerWorktreePath,
        setActiveWorktree: store.setActiveWorktree,
        openWorktreeModal: (worktreeId, worktreePath) => {
          window.dispatchEvent(
            new CustomEvent('open-worktree-modal', {
              detail: { worktreeId, worktreePath },
            })
          )
        },
      }
    )

    // Resolve model/backend/thinking based on mode
    const isYolo = mode === 'yolo'
    const modeModelRef = isYolo ? yoloModelRef : buildModelRef
    const modeBackendRef = isYolo ? yoloBackendRef : buildBackendRef
    const modeThinkingRef = isYolo ? yoloThinkingLevelRef : buildThinkingLevelRef
    const modeLabel = isYolo ? 'Yolo' : 'Build'

    const currentSessionBackend = queryClient.getQueryData<Session>(
      chatQueryKeys.session(sessionId)
    )?.backend
    const prefs = queryClient.getQueryData<AppPreferences>(
      preferencesQueryKeys.preferences()
    )
    const modeBackendOverride = (modeBackendRef.current as Session['backend']) ?? null
    const resolvedBackend = modeBackendOverride ?? undefined
    const modelBackend = resolvedBackend ?? currentSessionBackend
    const resolvedModel =
      modeModelRef.current ??
      (modeBackendOverride
        ? getDefaultModelForBackend(modelBackend, prefs)
        : selectedModelRef.current)
    const modeOverride = (modeModelRef.current || modeBackendOverride)
      ? [resolvedBackend, resolvedModel].filter(Boolean).join(' / ')
      : ''
    if (modeOverride) toast.info(`${modeLabel}: ${modeOverride}`)
    const planMessage = modeOverride
      ? `[${modeLabel}: ${modeOverride}]\nExecute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
      : `Execute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
    store.setExecutionMode(newSession.id, mode)
    store.setLastSentMessage(newSession.id, planMessage)
    store.setError(newSession.id, null)
    store.addSendingSession(newSession.id)
    store.setSelectedModel(newSession.id, resolvedModel)
    store.setExecutingMode(newSession.id, mode)
    if (resolvedBackend) {
      store.setSelectedBackend(
        newSession.id,
        resolvedBackend as 'claude' | 'codex' | 'opencode'
      )
    }
    queryClient.setQueryData<Session>(
      chatQueryKeys.session(newSession.id),
      old => old ? { ...old, backend: resolvedBackend ?? old.backend, selected_model: resolvedModel } : old
    )

    await invoke('set_session_model', {
      worktreeId: readyWorktree.id, worktreePath: readyWorktree.path,
      sessionId: newSession.id, model: resolvedModel,
    }).catch(err => console.error('[streamingWorktreeApproval] Failed to persist model:', err))
    if (resolvedBackend) {
      await invoke('set_session_backend', {
        worktreeId: readyWorktree.id, worktreePath: readyWorktree.path,
        sessionId: newSession.id, backend: resolvedBackend,
      }).catch(err => console.error('[streamingWorktreeApproval] Failed to persist backend:', err))
    }

    const effectiveBackend = resolvedBackend ?? currentSessionBackend
    let resolvedThinkingLevel: ThinkingLevel = selectedThinkingLevelRef.current
    let resolvedEffortLevel: EffortLevel | undefined = useAdaptiveThinkingRef.current
      ? selectedEffortLevelRef.current
      : undefined
    if (effectiveBackend === 'codex') {
      resolvedThinkingLevel = 'off'
      resolvedEffortLevel =
        mapCodexReasoningToEffort(modeThinkingRef.current) ?? selectedEffortLevelRef.current
    } else if (isThinkingLevel(modeThinkingRef.current)) {
      resolvedThinkingLevel = modeThinkingRef.current
    }
    sendMessage.mutate({
      sessionId: newSession.id,
      worktreeId: readyWorktree.id,
      worktreePath: readyWorktree.path,
      message: planMessage,
      model: resolvedModel,
      executionMode: mode,
      thinkingLevel: resolvedThinkingLevel,
      effortLevel: resolvedEffortLevel,
      mcpConfig: getMcpConfig(),
      customProfileName: getCustomProfileName(),
      backend: resolvedBackend,
    })

    toast.success(`Plan sent to new worktree (${modeLabel})`, { id: toastId })

    // Optionally close the original session
    if (prefs?.close_original_on_clear_context) {
      const closeCommand =
        prefs.removal_behavior === 'archive'
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

      invoke(closeCommand, { worktreeId, worktreePath, sessionId })
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: chatQueryKeys.sessions(worktreeId),
          })
        )
        .catch(err =>
          console.error('[streamingWorktreeApproval] Failed to close original session:', err)
        )
    }
  }, [
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    projectIdRef,
    selectedModelRef,
    buildModelRef,
    buildBackendRef,
    buildThinkingLevelRef,
    yoloModelRef,
    yoloBackendRef,
    yoloThinkingLevelRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    getMcpConfig,
    getCustomProfileName,
    sendMessage,
    queryClient,
  ])

  const handleWorktreeBuildApproval = useCallback(
    (messageId: string) => handleWorktreeApproval(messageId, 'build'),
    [handleWorktreeApproval]
  )

  const handleWorktreeYoloApproval = useCallback(
    (messageId: string) => handleWorktreeApproval(messageId, 'yolo'),
    [handleWorktreeApproval]
  )

  const handleStreamingWorktreeBuildApproval = useCallback(
    () => handleStreamingWorktreeApproval('build'),
    [handleStreamingWorktreeApproval]
  )

  const handleStreamingWorktreeYoloApproval = useCallback(
    () => handleStreamingWorktreeApproval('yolo'),
    [handleStreamingWorktreeApproval]
  )

  // Handle permission approval (when tools require user approval)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handlePermissionApproval = useCallback(
    (sessionId: string, approvedPatterns: string[]) => {
      console.warn('[useMessageHandlers] handlePermissionApproval CALLED', sessionId, approvedPatterns)
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!worktreeId || !worktreePath) return

      const {
        addApprovedTool,
        clearPendingDenials,
        getDeniedMessageContext,
        clearDeniedMessageContext,
        getApprovedTools,
        getPendingDenials,
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        setExecutionMode,
        setWaitingForInput,
        selectedBackends,
      } = useChatStore.getState()

      const backend = selectedBackends[sessionId] ?? 'claude'

      // Codex path: send approval response via JSON-RPC (process is still running)
      if (backend === 'codex') {
        const denials = getPendingDenials(sessionId)
        const currentMode =
          useChatStore.getState().executionModes[sessionId] ??
          executionModeRef.current
        const nextMode = getCodexPermissionApprovalMode(currentMode, false)
        clearPendingDenials(sessionId)
        clearDeniedMessageContext(sessionId)
        setWaitingForInput(sessionId, false)
        if (nextMode !== currentMode) {
          setExecutionMode(sessionId, nextMode)
          console.log(
            '[useMessageHandlers] Codex path: Broadcasting executionMode for session',
            sessionId,
            nextMode
          )
          invoke('broadcast_session_setting', {
            sessionId,
            key: 'executionMode',
            value: nextMode,
          })
            .then(() => {
              console.log(
                '[useMessageHandlers] Codex broadcast executionMode succeeded'
              )
            })
            .catch(err => {
              console.error(
                '[useMessageHandlers] Codex broadcast executionMode failed:',
                err
              )
            })
          invoke('update_session_state', {
            worktreeId,
            worktreePath,
            sessionId,
            selectedExecutionMode: nextMode,
          }).catch(() => undefined)
        }

        requestAnimationFrame(() => {
          scrollToBottom(true)
        })

        // Send accept for each denial that has an rpc_id
        for (const denial of denials) {
          if (denial.rpc_id != null) {
            invoke('approve_codex_command', {
              sessionId,
              rpcId: denial.rpc_id,
              decision: 'accept',
            }).catch(err => {
              console.error(
                '[ChatWindow] Failed to approve Codex command:',
                err
              )
              toast.error(`Failed to approve command: ${err}`)
            })
          }
        }
        return
      }

      // Claude path: re-send message with approved tools
      for (const pattern of approvedPatterns) {
        addApprovedTool(sessionId, pattern)
      }

      const allApprovedTools = getApprovedTools(sessionId)

      const context = getDeniedMessageContext(sessionId)
      if (!context) {
        console.error(
          '[ChatWindow] No denied message context found for re-send'
        )
        clearPendingDenials(sessionId)
        return
      }

      clearPendingDenials(sessionId)
      clearDeniedMessageContext(sessionId)
      setWaitingForInput(sessionId, false)
      setExecutionMode(sessionId, 'build')
      console.log('[useMessageHandlers] Claude path: Broadcasting executionMode=build for session', sessionId)
      invoke('broadcast_session_setting', {
        sessionId,
        key: 'executionMode',
        value: 'build',
      }).then(() => {
        console.log('[useMessageHandlers] Claude broadcast executionMode=build succeeded')
      }).catch(err => {
        console.error('[useMessageHandlers] Claude broadcast executionMode=build failed:', err)
      })
      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        selectedExecutionMode: 'build',
      }).catch(() => undefined)

      requestAnimationFrame(() => {
        scrollToBottom(true)
      })

      const bashCommands: string[] = []
      const otherPatterns: string[] = []
      for (const pattern of approvedPatterns) {
        const bashMatch = pattern.match(/^Bash\((.+)\)$/)
        if (bashMatch?.[1]) {
          bashCommands.push(bashMatch[1])
        } else {
          otherPatterns.push(pattern)
        }
      }

      let continuationMessage: string
      if (bashCommands.length > 0 && otherPatterns.length === 0) {
        if (bashCommands.length === 1) {
          continuationMessage = `I approved the command. Run it now: \`${bashCommands[0]}\``
        } else {
          continuationMessage = `I approved these commands. Run them now:\n${bashCommands.map(cmd => `- \`${cmd}\``).join('\n')}`
        }
      } else if (bashCommands.length > 0) {
        continuationMessage = `I approved: ${approvedPatterns.join(', ')}. Execute them now.`
      } else {
        continuationMessage = `I approved ${approvedPatterns.join(', ')}. Continue with the task.`
      }

      const modelToUse = context.model ?? selectedModelRef.current
      const modeToUse = context.executionMode ?? executionModeRef.current
      setLastSentMessage(sessionId, continuationMessage)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, modelToUse)
      setExecutingMode(sessionId, modeToUse)

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message: continuationMessage,
          model: modelToUse,
          executionMode: modeToUse,
          thinkingLevel:
            context.thinkingLevel ?? selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          allowedTools: [...GIT_ALLOWED_TOOLS, ...allApprovedTools],
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      executionModeRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      scrollToBottom,
      sendMessage,
      inputRef,
    ]
  )

  // Handle permission approval with yolo mode (auto-approve all future tools)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handlePermissionApprovalYolo = useCallback(
    (sessionId: string, approvedPatterns: string[]) => {
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!worktreeId || !worktreePath) return

      const {
        addApprovedTool,
        clearPendingDenials,
        getDeniedMessageContext,
        clearDeniedMessageContext,
        getPendingDenials,
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        setExecutionMode: setMode,
        setWaitingForInput,
        selectedBackends,
      } = useChatStore.getState()

      const backend = selectedBackends[sessionId] ?? 'claude'

      // Codex path: accept current denial and switch to yolo for future messages
      if (backend === 'codex') {
        const denials = getPendingDenials(sessionId)
        const currentMode =
          useChatStore.getState().executionModes[sessionId] ??
          executionModeRef.current
        const nextMode = getCodexPermissionApprovalMode(currentMode, true)
        clearPendingDenials(sessionId)
        clearDeniedMessageContext(sessionId)
        setWaitingForInput(sessionId, false)
        setMode(sessionId, nextMode)
        invoke('broadcast_session_setting', {
          sessionId,
          key: 'executionMode',
          value: nextMode,
        }).catch(err => {
          console.error(
            '[useMessageHandlers] Codex broadcast executionMode=yolo failed:',
            err
          )
        })
        invoke('update_session_state', {
          worktreeId,
          worktreePath,
          sessionId,
          selectedExecutionMode: nextMode,
        }).catch(() => undefined)

        requestAnimationFrame(() => {
          scrollToBottom(true)
        })

        for (const denial of denials) {
          if (denial.rpc_id != null) {
            invoke('approve_codex_command', {
              sessionId,
              rpcId: denial.rpc_id,
              decision: 'accept',
            }).catch(err => {
              console.error(
                '[ChatWindow] Failed to approve Codex command:',
                err
              )
            })
          }
        }
        return
      }

      // Claude path
      for (const pattern of approvedPatterns) {
        addApprovedTool(sessionId, pattern)
      }

      const context = getDeniedMessageContext(sessionId)
      if (!context) {
        console.error(
          '[ChatWindow] No denied message context found for re-send'
        )
        clearPendingDenials(sessionId)
        return
      }

      clearPendingDenials(sessionId)
      clearDeniedMessageContext(sessionId)
      setWaitingForInput(sessionId, false)

      // Scroll to bottom after DOM updates from collapsing the permission approval UI
      requestAnimationFrame(() => {
        scrollToBottom(true)
      })

      // Build explicit continuation message that tells Claude exactly what to run
      // Extract commands from Bash(command) patterns for a more direct instruction
      const bashCommands: string[] = []
      const otherPatterns: string[] = []
      for (const pattern of approvedPatterns) {
        const bashMatch = pattern.match(/^Bash\((.+)\)$/)
        if (bashMatch?.[1]) {
          bashCommands.push(bashMatch[1])
        } else {
          otherPatterns.push(pattern)
        }
      }

      // Build a message that explicitly asks Claude to run the commands
      let continuationMessage: string
      if (bashCommands.length > 0 && otherPatterns.length === 0) {
        // Only Bash commands - be very explicit
        if (bashCommands.length === 1) {
          continuationMessage = `I approved the command. Run it now: \`${bashCommands[0]}\``
        } else {
          continuationMessage = `I approved these commands. Run them now:\n${bashCommands.map(cmd => `- \`${cmd}\``).join('\n')}`
        }
      } else if (bashCommands.length > 0) {
        // Mix of Bash and other tools
        continuationMessage = `I approved: ${approvedPatterns.join(', ')}. Execute them now.`
      } else {
        // Only non-Bash tools
        continuationMessage = `I approved ${approvedPatterns.join(', ')}. Continue with the task.`
      }

      // Set to yolo mode for auto-approval of all future tools
      setMode(sessionId, 'yolo')

      // Send continuation with yolo mode (no need for allowedTools in yolo mode)
      const modelToUse = context.model ?? selectedModelRef.current
      setLastSentMessage(sessionId, continuationMessage)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, modelToUse)
      setExecutingMode(sessionId, 'yolo')

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message: continuationMessage,
          model: modelToUse,
          executionMode: 'yolo',
          thinkingLevel:
            context.thinkingLevel ?? selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      scrollToBottom,
      sendMessage,
      inputRef,
    ]
  )

  // Handle permission denial (user cancels approval request)
  const handlePermissionDeny = useCallback((sessionId: string) => {
    const {
      clearPendingDenials,
      clearDeniedMessageContext,
      getPendingDenials,
      setWaitingForInput,
      removeSendingSession,
      selectedBackends,
    } = useChatStore.getState()

    const backend = selectedBackends[sessionId] ?? 'claude'

    // For Codex: send decline response to unblock the attached process
    if (backend === 'codex') {
      const denials = getPendingDenials(sessionId)
      for (const denial of denials) {
        if (denial.rpc_id != null) {
          invoke('approve_codex_command', {
            sessionId,
            rpcId: denial.rpc_id,
            decision: 'decline',
          }).catch(err => {
            console.error('[ChatWindow] Failed to decline Codex command:', err)
          })
        }
      }
      clearPendingDenials(sessionId)
      clearDeniedMessageContext(sessionId)
      setWaitingForInput(sessionId, false)
      toast.info('Request cancelled')
      return
    }

    clearPendingDenials(sessionId)
    clearDeniedMessageContext(sessionId)
    setWaitingForInput(sessionId, false)
    removeSendingSession(sessionId)
    toast.info('Request cancelled')
  }, [])

  // Handle fixing a review finding
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleFixFinding = useCallback(
    async (finding: ReviewFinding, customSuggestion?: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Use custom suggestion if provided, otherwise use first suggestion
      const suggestionToApply =
        customSuggestion ?? finding.suggestions[0]?.code ?? ''

      const message = `Fix the following code review finding:

**File:** ${finding.file}
**Line:** ${finding.line}
**Issue:** ${finding.title}

${finding.description}

**Current code:**
\`\`\`
${finding.code}
\`\`\`

**Suggested fix:**
${suggestionToApply}

Please apply this fix to the file.`

      const {
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        markFindingFixed,
        isSending,
        enqueueMessage,
      } = useChatStore.getState()

      // Mark this finding as fixed (we don't have the index here, so we generate a key based on file+line)
      // The finding key format is: file:line:index - we'll match on file:line prefix
      // Get sessions data from query cache instead of closure for stable callback
      const cachedSessionsData = queryClient.getQueryData<WorktreeSessions>(
        chatQueryKeys.sessions(worktreeId)
      )
      const allContent =
        cachedSessionsData?.sessions
          ?.find((s: Session) => s.id === sessionId)
          ?.messages?.filter((m: { role: string }) => m.role === 'assistant')
          ?.map((m: { content: string }) => m.content)
          ?.join('\n') ?? ''
      const findings = parseReviewFindings(allContent)
      const findingIndex = findings.findIndex(
        f =>
          f.file === finding.file &&
          f.line === finding.line &&
          f.title === finding.title
      )
      if (findingIndex >= 0) {
        markFindingFixed(sessionId, getFindingKey(finding, findingIndex))
      }

      // If session is already busy, queue the fix message
      if (isSending(sessionId)) {
        const queuedMsg = {
          id: generateId(),
          message,
          pendingImages: [] as never[],
          pendingFiles: [] as never[],
          pendingSkills: [] as never[],
          pendingTextFiles: [] as never[],
          model: selectedModelRef.current,
          provider: getCustomProfileName() ?? null,
          executionMode: 'build' as const,
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          queuedAt: Date.now(),
        }
        enqueueMessage(sessionId, queuedMsg)
        persistEnqueue(worktreeId, worktreePath, sessionId, queuedMsg)
        toast.info('Fix queued — will start when current task completes')
        return
      }

      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, 'build') // Fixes are always in build mode

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: selectedModelRef.current,
          executionMode: 'build',
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      sendMessage,
      queryClient,
      inputRef,
    ]
  )

  // Handle fixing all review findings at once
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleFixAllFindings = useCallback(
    async (
      findingsWithSuggestions: { finding: ReviewFinding; suggestion?: string }[]
    ) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      const message = `Fix the following ${findingsWithSuggestions.length} code review findings:

${findingsWithSuggestions
  .map(
    ({ finding, suggestion }, i) => `
### ${i + 1}. ${finding.title}
**File:** ${finding.file}
**Line:** ${finding.line}

${finding.description}

**Current code:**
\`\`\`
${finding.code}
\`\`\`

**Suggested fix:**
${suggestion ?? finding.suggestions[0]?.code ?? '(no suggestion)'}
`
  )
  .join('\n---\n')}

Please apply all these fixes to the respective files.`

      const {
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        markFindingFixed,
        isSending,
        enqueueMessage,
      } = useChatStore.getState()

      // Mark all findings as fixed
      // Get sessions data from query cache instead of closure for stable callback
      const cachedSessionsData = queryClient.getQueryData<WorktreeSessions>(
        chatQueryKeys.sessions(worktreeId)
      )
      const allContent =
        cachedSessionsData?.sessions
          ?.find((s: Session) => s.id === sessionId)
          ?.messages?.filter((m: { role: string }) => m.role === 'assistant')
          ?.map((m: { content: string }) => m.content)
          ?.join('\n') ?? ''
      const allFindings = parseReviewFindings(allContent)

      for (const { finding } of findingsWithSuggestions) {
        const findingIndex = allFindings.findIndex(
          f =>
            f.file === finding.file &&
            f.line === finding.line &&
            f.title === finding.title
        )
        if (findingIndex >= 0) {
          markFindingFixed(sessionId, getFindingKey(finding, findingIndex))
        }
      }

      // If session is already busy, queue the fix message
      if (isSending(sessionId)) {
        const queuedMsg = {
          id: generateId(),
          message,
          pendingImages: [] as never[],
          pendingFiles: [] as never[],
          pendingSkills: [] as never[],
          pendingTextFiles: [] as never[],
          model: selectedModelRef.current,
          provider: getCustomProfileName() ?? null,
          executionMode: 'build' as const,
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          queuedAt: Date.now(),
        }
        enqueueMessage(sessionId, queuedMsg)
        persistEnqueue(worktreeId, worktreePath, sessionId, queuedMsg)
        toast.info('Fix queued — will start when current task completes')
        return
      }

      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, 'build') // Fixes are always in build mode

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: selectedModelRef.current,
          executionMode: 'build',
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      sendMessage,
      queryClient,
      inputRef,
    ]
  )

  return {
    handleQuestionAnswer,
    handleSkipQuestion,
    handlePlanApproval,
    handlePlanApprovalYolo,
    handleStreamingPlanApproval,
    handleStreamingPlanApprovalYolo,
    handleClearContextApproval,
    handleStreamingClearContextApproval,
    handleClearContextApprovalBuild,
    handleStreamingClearContextApprovalBuild,
    handleWorktreeBuildApproval,
    handleStreamingWorktreeBuildApproval,
    handleWorktreeYoloApproval,
    handleStreamingWorktreeYoloApproval,
    handlePendingPlanApprovalCallback,
    handlePermissionApproval,
    handlePermissionApprovalYolo,
    handlePermissionDeny,
    handleFixFinding,
    handleFixAllFindings,
  }
}
