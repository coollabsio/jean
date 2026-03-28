import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  isAskUserQuestion,
  type ToolCall,
  type QuestionAnswer,
  type SetupScriptResult,
  type ThinkingLevel,
  type EffortLevel,
  type PendingImage,
  type PendingFile,
  type PendingSkill,
  type PendingTextFile,
  type ContentBlock,
  type Todo,
  type QueuedMessage,
  type PermissionDenial,
  type ExecutionMode,
  type SessionDigest,
  type LabelData,
  EXECUTION_MODE_CYCLE,
  isExitPlanMode,
} from '@/types/chat'
import type { ReviewResponse } from '@/types/projects'
import { invoke } from '@/lib/transport'
import type { ClaudeModel, CodexModel } from '@/types/preferences'
export type { ClaudeModel, CodexModel }

/** Default model to use when none is selected (fallback only - preferences take priority) */
export const DEFAULT_MODEL: ClaudeModel = 'opus'

/** Default Codex model */
export const DEFAULT_CODEX_MODEL: CodexModel = 'gpt-5.4'

/** Default thinking level */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'off'

function hasActiveStreamingState(
  state: Pick<
    ChatUIState,
    'streamingContents' | 'streamingContentBlocks' | 'activeToolCalls'
  >,
  sessionId: string
): boolean {
  return (
    !!state.streamingContents[sessionId] ||
    (state.streamingContentBlocks[sessionId]?.length ?? 0) > 0 ||
    (state.activeToolCalls[sessionId]?.length ?? 0) > 0
  )
}

interface ChatUIState {
  // Currently active worktree for chat
  activeWorktreeId: string | null
  activeWorktreePath: string | null
  // Last active worktree (survives clearActiveWorktree, used by dashboard to restore selection)
  lastActiveWorktreeId: string | null

  // Last opened worktree+session per project (for restoring on project switch)
  lastOpenedPerProject: Record<
    string,
    { worktreeId: string; sessionId: string }
  >

  // Active session ID per worktree (for tab selection)
  activeSessionIds: Record<string, string>

  // AI review results per session (sessionId → results)
  reviewResults: Record<string, ReviewResponse>

  // Whether the review sidebar is visible (global toggle)
  reviewSidebarVisible: boolean

  // Fixed AI review findings per session (sessionId → fixed finding keys)
  fixedReviewFindings: Record<string, Set<string>>

  // Mapping of worktree IDs to paths (for looking up paths by ID)
  worktreePaths: Record<string, string>

  // Set of session IDs currently sending (supports multiple concurrent sessions)
  sendingSessionIds: Record<string, boolean>

  // Timestamp of last addSendingSession call per session — used to protect new sends
  // from stale completion events arriving from a previous cancelled run
  sendStartedAt: Record<string, number>

  // Duration (ms) of the last completed run per session — set by completeSession
  completedDurations: Record<string, number>

  // Session IDs initiated by the user (e.g. Clear Context & YOLO) — auto-mark as opened on completion
  userInitiatedSessionIds: Record<string, true>

  // Set of session IDs waiting for user input (AskUserQuestion/ExitPlanMode)
  // Separate from sendingSessionIds to allow user to send messages while waiting
  waitingForInputSessionIds: Record<string, boolean>

  // Mapping of session IDs to worktree IDs (for checking all sessions in a worktree)
  sessionWorktreeMap: Record<string, string>

  // Streaming response content per session
  streamingContents: Record<string, string>

  // Tool calls being executed during streaming per session
  activeToolCalls: Record<string, ToolCall[]>

  // Streaming content blocks per session (preserves text/tool order)
  streamingContentBlocks: Record<string, ContentBlock[]>

  // Streaming thinking content per session (extended thinking)
  streamingThinkingContent: Record<string, string>

  // Draft input per session (preserves text when switching tabs)
  inputDrafts: Record<string, string>

  // Execution mode per session (defaults to 'plan' for new sessions)
  executionModes: Record<string, ExecutionMode>

  // Thinking level per session (defaults to 'off')
  thinkingLevels: Record<string, ThinkingLevel>

  // Effort level per session (for Opus 4.6 adaptive thinking)
  effortLevels: Record<string, EffortLevel>

  // Selected backend per session (claude, codex, or opencode)
  selectedBackends: Record<string, 'claude' | 'codex' | 'opencode'>

  // Selected model per session (for tracking what model was used)
  selectedModels: Record<string, string>

  // Selected provider per session (null = default Anthropic, or custom profile name)
  selectedProviders: Record<string, string | null>

  // Enabled MCP servers per session (server names that are active)
  enabledMcpServers: Record<string, string[]>

  // Answered questions per session (to make them read-only after answering)
  answeredQuestions: Record<string, Set<string>>

  // Submitted answers per session, keyed by toolCallId
  submittedAnswers: Record<string, Record<string, QuestionAnswer[]>>

  // Error state per session (for inline error display)
  errors: Record<string, string | null>

  // Last sent message per session (for restoring on error)
  lastSentMessages: Record<string, string>

  // Last sent attachments per session (for restoring on cancellation)
  lastSentAttachments: Record<
    string,
    {
      images: PendingImage[]
      files: PendingFile[]
      textFiles: PendingTextFile[]
      skills: PendingSkill[]
    }
  >

  // Setup script results per worktree (from jean.json) - stays at worktree level
  setupScriptResults: Record<string, SetupScriptResult>

  // Pending images per session (before sending)
  pendingImages: Record<string, PendingImage[]>

  // Pending files per session (from @ mentions)
  pendingFiles: Record<string, PendingFile[]>

  // Pending skills per session (from / mentions)
  pendingSkills: Record<string, PendingSkill[]>

  // Pending text files per session (large text pastes saved as files)
  pendingTextFiles: Record<string, PendingTextFile[]>

  // Active todos per session (from TodoWrite tool, latest call replaces previous)
  activeTodos: Record<string, Todo[]>

  // Streaming plan approvals per session (tracks approvals given during streaming)
  streamingPlanApprovals: Record<string, boolean>

  // Message queues per session (FIFO - messages waiting to be sent)
  messageQueues: Record<string, QueuedMessage[]>

  // Execution mode the currently-executing prompt was sent with (per session)
  executingModes: Record<string, ExecutionMode>

  // Session-scoped approved tools (tool patterns approved via permission UI)
  // These are added to allowedTools when sending messages
  // Reset when session is cleared
  approvedTools: Record<string, string[]>

  // Pending permission denials per session (waiting for user approval)
  pendingPermissionDenials: Record<string, PermissionDenial[]>

  // The original message context that triggered the denial (for re-send)
  deniedMessageContext: Record<
    string,
    {
      message: string
      model?: string
      executionMode?: ExecutionMode
      thinkingLevel?: ThinkingLevel
    }
  >

  // Last compaction timestamp and trigger per session
  lastCompaction: Record<string, { timestamp: number; trigger: string }>

  // Sessions currently compacting context
  compactingSessions: Record<string, boolean>

  // Sessions marked as "reviewing" (persisted)
  reviewingSessions: Record<string, boolean>

  // Plan file paths per session (persisted)
  planFilePaths: Record<string, string | null>

  // Pending plan message IDs per session (persisted)
  pendingPlanMessageIds: Record<string, string | null>

  // Sessions currently generating context in the background
  savingContext: Record<string, boolean>

  // Sessions where user skipped questions (auto-skip all subsequent questions)
  skippedQuestionSessions: Record<string, boolean>

  // Sessions that completed while out of focus, need digest on open (persisted)
  pendingDigestSessionIds: Record<string, boolean>

  // Generated session digests (cached until dismissed)
  sessionDigests: Record<string, SessionDigest>

  // Worktree loading operations (commit, pr, review, merge, pull)
  worktreeLoadingOperations: Record<string, string | null>

  // User-assigned labels per session (e.g. "Needs testing")
  sessionLabels: Record<string, LabelData>

  // Pending magic command to execute when ChatWindow mounts (from canvas navigation)
  pendingMagicCommand: { command: string; prompt?: string } | null
  setPendingMagicCommand: (
    cmd: { command: string; prompt?: string } | null
  ) => void

  // Actions - Session management
  setActiveSession: (
    worktreeId: string,
    sessionId: string,
    options?: { markOpened?: boolean }
  ) => void
  getActiveSession: (worktreeId: string) => string | undefined

  // Actions - AI Review results management (session-scoped)
  setReviewResults: (sessionId: string, results: ReviewResponse) => void
  clearReviewResults: (sessionId: string) => void
  setReviewSidebarVisible: (visible: boolean) => void
  toggleReviewSidebar: () => void

  // Actions - AI Review fixed findings (session-scoped)
  markReviewFindingFixed: (sessionId: string, findingKey: string) => void
  isReviewFindingFixed: (sessionId: string, findingKey: string) => boolean
  clearFixedReviewFindings: (sessionId: string) => void

  // Actions - Reviewing status management (persisted)
  setSessionReviewing: (sessionId: string, reviewing: boolean) => void
  isSessionReviewing: (sessionId: string) => boolean

  // Actions - Session label management (persisted)
  setSessionLabel: (sessionId: string, label: LabelData | null) => void

  // Actions - Plan file path management (persisted)
  setPlanFilePath: (sessionId: string, path: string | null) => void
  getPlanFilePath: (sessionId: string) => string | null

  // Actions - Pending plan message ID management (persisted)
  setPendingPlanMessageId: (sessionId: string, messageId: string | null) => void
  getPendingPlanMessageId: (sessionId: string) => string | null

  // Actions - Worktree management
  setActiveWorktree: (id: string | null, path: string | null) => void
  clearActiveWorktree: () => void
  setLastActiveWorktreeId: (id: string) => void
  setLastOpenedForProject: (
    projectId: string,
    worktreeId: string,
    sessionId: string
  ) => void
  registerWorktreePath: (worktreeId: string, path: string) => void
  getWorktreePath: (worktreeId: string) => string | undefined

  // Actions - Session-based sending state
  addSendingSession: (sessionId: string, startTime?: number) => void
  removeSendingSession: (sessionId: string) => void
  isSending: (sessionId: string) => boolean

  // Actions - User-initiated sessions (auto-mark as opened on completion)
  addUserInitiatedSession: (sessionId: string) => void
  removeUserInitiatedSession: (sessionId: string) => void

  // Actions - Session-based waiting for input state
  setWaitingForInput: (sessionId: string, isWaiting: boolean) => void
  isWaitingForInput: (sessionId: string) => boolean

  // Actions - Worktree-level state checks (checks all sessions in a worktree)
  isWorktreeRunning: (worktreeId: string) => boolean
  isWorktreeRunningNonPlan: (worktreeId: string) => boolean
  isWorktreeWaiting: (worktreeId: string) => boolean

  // Actions - Streaming content (session-based)
  appendStreamingContent: (sessionId: string, chunk: string) => void
  setStreamingContent: (sessionId: string, content: string) => void
  clearStreamingContent: (sessionId: string) => void

  // Actions - Tool calls (session-based)
  addToolCall: (sessionId: string, toolCall: ToolCall) => void
  updateToolCallOutput: (
    sessionId: string,
    toolUseId: string,
    output: string
  ) => void
  clearToolCalls: (sessionId: string) => void

  // Actions - Content blocks (session-based, for inline tool rendering)
  addTextBlock: (sessionId: string, text: string) => void
  addToolBlock: (sessionId: string, toolCallId: string) => void
  addThinkingBlock: (sessionId: string, thinking: string) => void
  clearStreamingContentBlocks: (sessionId: string) => void
  getStreamingContentBlocks: (sessionId: string) => ContentBlock[]

  // Actions - Thinking content (session-based, for extended thinking)
  appendThinkingContent: (sessionId: string, content: string) => void
  clearThinkingContent: (sessionId: string) => void
  getThinkingContent: (sessionId: string) => string

  // Actions - Input drafts (session-based)
  setInputDraft: (sessionId: string, value: string) => void
  clearInputDraft: (sessionId: string) => void

  // Actions - Execution mode (session-based)
  cycleExecutionMode: (sessionId: string) => void
  setExecutionMode: (sessionId: string, mode: ExecutionMode) => void
  getExecutionMode: (sessionId: string) => ExecutionMode

  // Actions - Thinking level (session-based)
  setThinkingLevel: (sessionId: string, level: ThinkingLevel) => void
  getThinkingLevel: (sessionId: string) => ThinkingLevel
  // Actions - Effort level (session-based, for Opus 4.6 adaptive thinking)
  setEffortLevel: (sessionId: string, level: EffortLevel) => void
  getEffortLevel: (sessionId: string) => EffortLevel

  // Actions - Selected backend (session-based)
  setSelectedBackend: (
    sessionId: string,
    backend: 'claude' | 'codex' | 'opencode'
  ) => void

  // Actions - Selected model (session-based)
  setSelectedModel: (sessionId: string, model: string) => void

  // Actions - Selected provider (session-based)
  setSelectedProvider: (sessionId: string, provider: string | null) => void

  // Actions - Copy all per-session settings from one session to another
  copySessionSettings: (fromSessionId: string, toSessionId: string) => void

  // Actions - MCP servers (session-based)
  setEnabledMcpServers: (sessionId: string, servers: string[]) => void
  toggleMcpServer: (
    sessionId: string,
    serverName: string,
    currentDefaults?: string[]
  ) => void

  // Actions - Question answering (session-based)
  markQuestionAnswered: (
    sessionId: string,
    toolCallId: string,
    answers: QuestionAnswer[]
  ) => void
  isQuestionAnswered: (sessionId: string, toolCallId: string) => boolean
  getSubmittedAnswers: (
    sessionId: string,
    toolCallId: string
  ) => QuestionAnswer[] | undefined

  // Actions - Question skipping (session-based, auto-skips all subsequent questions)
  setQuestionsSkipped: (sessionId: string, skipped: boolean) => void
  areQuestionsSkipped: (sessionId: string) => boolean

  // Actions - Error handling (session-based)
  setError: (sessionId: string, error: string | null) => void
  setLastSentMessage: (sessionId: string, message: string) => void
  clearLastSentMessage: (sessionId: string) => void
  setLastSentAttachments: (
    sessionId: string,
    attachments: {
      images: PendingImage[]
      files: PendingFile[]
      textFiles: PendingTextFile[]
      skills: PendingSkill[]
    }
  ) => void
  clearLastSentAttachments: (sessionId: string) => void
  restoreAttachments: (sessionId: string) => void

  // Actions - Setup script results (worktree-based)
  addSetupScriptResult: (worktreeId: string, result: SetupScriptResult) => void
  clearSetupScriptResult: (worktreeId: string) => void

  // Actions - Pending images (session-based)
  addPendingImage: (sessionId: string, image: PendingImage) => void
  updatePendingImage: (
    sessionId: string,
    imageId: string,
    updates: Partial<PendingImage>
  ) => void
  removePendingImage: (sessionId: string, imageId: string) => void
  clearPendingImages: (sessionId: string) => void
  getPendingImages: (sessionId: string) => PendingImage[]

  // Actions - Pending files (session-based, for @ mentions)
  addPendingFile: (sessionId: string, file: PendingFile) => void
  removePendingFile: (sessionId: string, fileId: string) => void
  clearPendingFiles: (sessionId: string) => void
  getPendingFiles: (sessionId: string) => PendingFile[]

  // Actions - Pending skills (session-based, for / mentions)
  addPendingSkill: (sessionId: string, skill: PendingSkill) => void
  removePendingSkill: (sessionId: string, skillId: string) => void
  clearPendingSkills: (sessionId: string) => void
  getPendingSkills: (sessionId: string) => PendingSkill[]

  // Actions - Pending text files (session-based)
  addPendingTextFile: (sessionId: string, textFile: PendingTextFile) => void
  updatePendingTextFile: (
    sessionId: string,
    textFileId: string,
    content: string,
    size: number
  ) => void
  removePendingTextFile: (sessionId: string, textFileId: string) => void
  clearPendingTextFiles: (sessionId: string) => void
  getPendingTextFiles: (sessionId: string) => PendingTextFile[]

  // Actions - Active todos (session-based)
  setActiveTodos: (sessionId: string, todos: Todo[]) => void
  clearActiveTodos: (sessionId: string) => void
  getActiveTodos: (sessionId: string) => Todo[]

  // Fixed review findings per session (keyed by finding identifier)
  fixedFindings: Record<string, Set<string>>

  // Actions - Fixed findings (session-based)
  markFindingFixed: (sessionId: string, findingKey: string) => void
  isFindingFixed: (sessionId: string, findingKey: string) => boolean
  clearFixedFindings: (sessionId: string) => void

  // Actions - Streaming plan approvals (session-based)
  setStreamingPlanApproved: (sessionId: string, approved: boolean) => void
  isStreamingPlanApproved: (sessionId: string) => boolean
  clearStreamingPlanApproval: (sessionId: string) => void

  // Actions - Message queue (session-based)
  enqueueMessage: (sessionId: string, message: QueuedMessage) => void
  dequeueMessage: (sessionId: string) => QueuedMessage | undefined
  removeQueuedMessage: (sessionId: string, messageId: string) => void
  clearQueue: (sessionId: string) => void
  getQueueLength: (sessionId: string) => number
  getQueuedMessages: (sessionId: string) => QueuedMessage[]
  forceProcessQueue: (sessionId: string) => void

  // Actions - Executing mode (tracks mode prompt was sent with)
  setExecutingMode: (sessionId: string, mode: ExecutionMode) => void
  clearExecutingMode: (sessionId: string) => void
  getExecutingMode: (sessionId: string) => ExecutionMode | undefined

  // Actions - Permission approvals (session-scoped)
  addApprovedTool: (sessionId: string, toolPattern: string) => void
  getApprovedTools: (sessionId: string) => string[]
  clearApprovedTools: (sessionId: string) => void

  // Actions - Pending permission denials
  setPendingDenials: (sessionId: string, denials: PermissionDenial[]) => void
  clearPendingDenials: (sessionId: string) => void
  getPendingDenials: (sessionId: string) => PermissionDenial[]

  // Actions - Denied message context (for re-send)
  setDeniedMessageContext: (
    sessionId: string,
    context: {
      message: string
      model?: string
      executionMode?: ExecutionMode
      thinkingLevel?: ThinkingLevel
    }
  ) => void
  clearDeniedMessageContext: (sessionId: string) => void
  getDeniedMessageContext: (sessionId: string) =>
    | {
        message: string
        model?: string
        executionMode?: ExecutionMode
        thinkingLevel?: ThinkingLevel
      }
    | undefined

  // Actions - Batch state transitions (single set() to avoid render cascades)
  /** Atomically clear all streaming state and mark session as reviewing */
  completeSession: (sessionId: string) => void
  /** Atomically clear all streaming state for a user cancellation */
  cancelSession: (sessionId: string) => void
  /** Atomically clear streaming state and mark session as waiting for input */
  pauseSession: (sessionId: string) => void
  /** Atomically clear streaming state after an error, mark as reviewing */
  failSession: (sessionId: string) => void

  // Actions - Unified session state cleanup (for close/archive)
  clearSessionState: (sessionId: string) => void

  // Actions - Compaction tracking
  setCompacting: (sessionId: string, compacting: boolean) => void
  setLastCompaction: (sessionId: string, trigger: string) => void
  getLastCompaction: (
    sessionId: string
  ) => { timestamp: number; trigger: string } | undefined
  clearLastCompaction: (sessionId: string) => void

  // Actions - Save context tracking
  setSavingContext: (sessionId: string, saving: boolean) => void
  isSavingContext: (sessionId: string) => boolean

  // Actions - Session digest (context recall after switching)
  markSessionNeedsDigest: (sessionId: string) => void
  clearPendingDigest: (sessionId: string) => void
  setSessionDigest: (sessionId: string, digest: SessionDigest) => void
  hasPendingDigest: (sessionId: string) => boolean
  getSessionDigest: (sessionId: string) => SessionDigest | undefined

  // Actions - Worktree loading operations (commit, pr, review, merge, pull)
  setWorktreeLoading: (worktreeId: string, operation: string) => void
  clearWorktreeLoading: (worktreeId: string) => void
  getWorktreeLoadingOperation: (worktreeId: string) => string | null

  // Actions - Canvas-selected session (for magic menu targeting)
  // Legacy actions (deprecated - for backward compatibility)
  /** @deprecated Use addSendingSession instead */
  addSendingWorktree: (worktreeId: string) => void
  /** @deprecated Use removeSendingSession instead */
  removeSendingWorktree: (worktreeId: string) => void
}

export const useChatStore = create<ChatUIState>()(
  devtools(
    (set, get) => ({
      // Initial state
      activeWorktreeId: null,
      activeWorktreePath: null,
      lastActiveWorktreeId: null,
      lastOpenedPerProject: {},
      activeSessionIds: {},
      reviewResults: {},
      reviewSidebarVisible: false,
      fixedReviewFindings: {},
      worktreePaths: {},
      sendingSessionIds: {},
      sendStartedAt: {},
      completedDurations: {},
      userInitiatedSessionIds: {},
      waitingForInputSessionIds: {},
      sessionWorktreeMap: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      inputDrafts: {},
      executionModes: {},
      thinkingLevels: {},
      effortLevels: {},
      selectedBackends: {},
      selectedModels: {},
      selectedProviders: {},
      enabledMcpServers: {},
      answeredQuestions: {},
      submittedAnswers: {},
      errors: {},
      lastSentMessages: {},
      lastSentAttachments: {},
      setupScriptResults: {},
      pendingImages: {},
      pendingFiles: {},
      pendingSkills: {},
      pendingTextFiles: {},
      activeTodos: {},
      fixedFindings: {},
      streamingPlanApprovals: {},
      messageQueues: {},
      executingModes: {},
      approvedTools: {},
      pendingPermissionDenials: {},
      deniedMessageContext: {},
      lastCompaction: {},
      compactingSessions: {},
      reviewingSessions: {},
      planFilePaths: {},
      pendingPlanMessageIds: {},
      savingContext: {},
      skippedQuestionSessions: {},
      pendingDigestSessionIds: {},
      sessionDigests: {},
      worktreeLoadingOperations: {},
      sessionLabels: {},
      pendingMagicCommand: null,

      // Session management
      setActiveSession: (worktreeId, sessionId, options) => {
        set(
          state => ({
            activeSessionIds: {
              ...state.activeSessionIds,
              [worktreeId]: sessionId,
            },
            // Also track which worktree this session belongs to
            sessionWorktreeMap: {
              ...state.sessionWorktreeMap,
              [sessionId]: worktreeId,
            },
          }),
          undefined,
          'setActiveSession'
        )

        if (options?.markOpened !== false) {
          // Fire-and-forget: update last_opened_at on the backend
          invoke('set_session_last_opened', { sessionId })
            .then(() => window.dispatchEvent(new CustomEvent('session-opened')))
            .catch(() => undefined)
        }
      },

      getActiveSession: worktreeId => get().activeSessionIds[worktreeId],

      // AI Review results management (session-scoped)
      setReviewResults: (sessionId, results) =>
        set(
          state => ({
            reviewResults: { ...state.reviewResults, [sessionId]: results },
            reviewSidebarVisible: true,
          }),
          undefined,
          'setReviewResults'
        ),

      clearReviewResults: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...restResults } = state.reviewResults
            const { [sessionId]: __, ...restFixed } = state.fixedReviewFindings
            return {
              reviewResults: restResults,
              fixedReviewFindings: restFixed,
            }
          },
          undefined,
          'clearReviewResults'
        ),

      setReviewSidebarVisible: visible =>
        set(
          { reviewSidebarVisible: visible },
          undefined,
          'setReviewSidebarVisible'
        ),

      toggleReviewSidebar: () =>
        set(
          state => ({ reviewSidebarVisible: !state.reviewSidebarVisible }),
          undefined,
          'toggleReviewSidebar'
        ),

      // AI Review fixed findings (session-scoped)
      markReviewFindingFixed: (sessionId, findingKey) =>
        set(
          state => {
            const existing = state.fixedReviewFindings[sessionId] ?? new Set()
            const updated = new Set(existing)
            updated.add(findingKey)
            return {
              fixedReviewFindings: {
                ...state.fixedReviewFindings,
                [sessionId]: updated,
              },
            }
          },
          undefined,
          'markReviewFindingFixed'
        ),

      isReviewFindingFixed: (sessionId, findingKey) =>
        get().fixedReviewFindings[sessionId]?.has(findingKey) ?? false,

      clearFixedReviewFindings: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.fixedReviewFindings
            return { fixedReviewFindings: rest }
          },
          undefined,
          'clearFixedReviewFindings'
        ),

      // Reviewing status management (persisted)
      setSessionReviewing: (sessionId, reviewing) =>
        set(
          state => {
            if (reviewing) {
              if (state.reviewingSessions[sessionId]) return state
              // Clear waiting state so review status takes visual priority
              const { [sessionId]: _w, ...waitingForInputSessionIds } =
                state.waitingForInputSessionIds
              const { [sessionId]: _p, ...pendingPlanMessageIds } =
                state.pendingPlanMessageIds
              return {
                reviewingSessions: {
                  ...state.reviewingSessions,
                  [sessionId]: true,
                },
                waitingForInputSessionIds,
                pendingPlanMessageIds,
              }
            } else {
              if (!(sessionId in state.reviewingSessions)) return state
              const { [sessionId]: _, ...rest } = state.reviewingSessions
              return { reviewingSessions: rest }
            }
          },
          undefined,
          'setSessionReviewing'
        ),

      isSessionReviewing: sessionId =>
        get().reviewingSessions[sessionId] ?? false,

      // Session label management (persisted)
      setSessionLabel: (sessionId, label) =>
        set(
          state => {
            if (label) {
              return {
                sessionLabels: {
                  ...state.sessionLabels,
                  [sessionId]: label,
                },
              }
            } else {
              const { [sessionId]: _, ...rest } = state.sessionLabels
              return { sessionLabels: rest }
            }
          },
          undefined,
          'setSessionLabel'
        ),

      // Plan file path management
      setPlanFilePath: (sessionId, path) =>
        set(
          state => {
            if (path) {
              return {
                planFilePaths: {
                  ...state.planFilePaths,
                  [sessionId]: path,
                },
              }
            } else {
              const { [sessionId]: _, ...rest } = state.planFilePaths
              return { planFilePaths: rest }
            }
          },
          undefined,
          'setPlanFilePath'
        ),

      getPlanFilePath: sessionId => get().planFilePaths[sessionId] ?? null,

      // Pending plan message ID management
      setPendingPlanMessageId: (sessionId, messageId) =>
        set(
          state => {
            if (messageId) {
              return {
                pendingPlanMessageIds: {
                  ...state.pendingPlanMessageIds,
                  [sessionId]: messageId,
                },
              }
            } else {
              const { [sessionId]: _, ...rest } = state.pendingPlanMessageIds
              return { pendingPlanMessageIds: rest }
            }
          },
          undefined,
          'setPendingPlanMessageId'
        ),

      getPendingPlanMessageId: sessionId =>
        get().pendingPlanMessageIds[sessionId] ?? null,

      // Worktree management
      setActiveWorktree: (id, path) => {
        set(
          state => ({
            activeWorktreeId: id,
            activeWorktreePath: path,
            // Remember last active worktree for dashboard restoration
            lastActiveWorktreeId: id ?? state.lastActiveWorktreeId,
            // Also register the path mapping when setting active worktree
            worktreePaths:
              id && path
                ? { ...state.worktreePaths, [id]: path }
                : state.worktreePaths,
          }),
          undefined,
          'setActiveWorktree'
        )

        // Fire-and-forget: update last_opened_at on the backend
        if (id) {
          invoke('set_worktree_last_opened', { worktreeId: id }).catch(
            () => undefined
          )
        }
      },

      clearActiveWorktree: () =>
        set(
          { activeWorktreeId: null, activeWorktreePath: null },
          undefined,
          'clearActiveWorktree'
        ),

      setLastActiveWorktreeId: id =>
        set({ lastActiveWorktreeId: id }, undefined, 'setLastActiveWorktreeId'),

      setLastOpenedForProject: (projectId, worktreeId, sessionId) =>
        set(
          state => {
            const existing = state.lastOpenedPerProject[projectId]
            if (
              existing?.worktreeId === worktreeId &&
              existing?.sessionId === sessionId
            )
              return state
            return {
              lastOpenedPerProject: {
                ...state.lastOpenedPerProject,
                [projectId]: { worktreeId, sessionId },
              },
            }
          },
          undefined,
          'setLastOpenedForProject'
        ),

      registerWorktreePath: (worktreeId, path) =>
        set(
          state => ({
            worktreePaths: { ...state.worktreePaths, [worktreeId]: path },
          }),
          undefined,
          'registerWorktreePath'
        ),

      getWorktreePath: worktreeId => get().worktreePaths[worktreeId],

      // Sending state (session-based)
      addSendingSession: (sessionId, startTime) =>
        set(
          state => {
            // Guard: skip no-op updates to avoid re-renders on every streaming chunk
            if (state.sendingSessionIds[sessionId]) return state
            const now = startTime ?? Date.now()
            const { [sessionId]: _, ...restDurations } =
              state.completedDurations
            return {
              sendingSessionIds: {
                ...state.sendingSessionIds,
                [sessionId]: true,
              },
              sendStartedAt: { ...state.sendStartedAt, [sessionId]: now },
              completedDurations: restDurations,
            }
          },
          undefined,
          'addSendingSession'
        ),

      removeSendingSession: sessionId =>
        set(
          state => {
            console.log(`[Store] removeSendingSession id=${sessionId}`, {
              wasSending: !!state.sendingSessionIds[sessionId],
              currentSending: Object.keys(state.sendingSessionIds),
            })
            const { [sessionId]: _, ...rest } = state.sendingSessionIds
            return { sendingSessionIds: rest }
          },
          undefined,
          'removeSendingSession'
        ),

      isSending: sessionId => get().sendingSessionIds[sessionId] ?? false,

      // User-initiated sessions (auto-mark as opened on completion)
      addUserInitiatedSession: sessionId =>
        set(
          state => {
            if (state.userInitiatedSessionIds[sessionId]) return state
            return {
              userInitiatedSessionIds: {
                ...state.userInitiatedSessionIds,
                [sessionId]: true as const,
              },
            }
          },
          undefined,
          'addUserInitiatedSession'
        ),

      removeUserInitiatedSession: sessionId =>
        set(
          state => {
            if (!(sessionId in state.userInitiatedSessionIds)) return state
            const { [sessionId]: _, ...rest } = state.userInitiatedSessionIds
            return { userInitiatedSessionIds: rest }
          },
          undefined,
          'removeUserInitiatedSession'
        ),

      // Waiting for input state (session-based)
      setWaitingForInput: (sessionId, isWaiting) =>
        set(
          state => {
            if (isWaiting) {
              if (state.waitingForInputSessionIds[sessionId]) return state
              return {
                waitingForInputSessionIds: {
                  ...state.waitingForInputSessionIds,
                  [sessionId]: true,
                },
              }
            } else {
              if (!(sessionId in state.waitingForInputSessionIds)) return state
              const { [sessionId]: _, ...rest } =
                state.waitingForInputSessionIds
              return { waitingForInputSessionIds: rest }
            }
          },
          undefined,
          'setWaitingForInput'
        ),

      isWaitingForInput: sessionId =>
        get().waitingForInputSessionIds[sessionId] ?? false,

      // Worktree-level state checks (checks all sessions in a worktree)
      isWorktreeRunning: worktreeId => {
        const state = get()
        for (const [sessionId, isSending] of Object.entries(
          state.sendingSessionIds
        )) {
          if (isSending && state.sessionWorktreeMap[sessionId] === worktreeId) {
            return true
          }
        }
        return false
      },

      isWorktreeRunningNonPlan: worktreeId => {
        const state = get()
        for (const [sessionId, isSending] of Object.entries(
          state.sendingSessionIds
        )) {
          if (isSending && state.sessionWorktreeMap[sessionId] === worktreeId) {
            const mode = state.executingModes[sessionId]
            if (mode === 'build' || mode === 'yolo') {
              return true
            }
          }
        }
        return false
      },

      isWorktreeWaiting: worktreeId => {
        const state = get()
        for (const [sessionId, toolCalls] of Object.entries(
          state.activeToolCalls
        )) {
          if (
            state.sessionWorktreeMap[sessionId] === worktreeId &&
            toolCalls.some(tc => isAskUserQuestion(tc) || isExitPlanMode(tc))
          ) {
            return true
          }
        }
        return false
      },

      // Streaming content (session-based)
      appendStreamingContent: (sessionId, chunk) =>
        set(
          state => ({
            streamingContents: {
              ...state.streamingContents,
              [sessionId]: (state.streamingContents[sessionId] ?? '') + chunk,
            },
          }),
          undefined,
          'appendStreamingContent'
        ),

      setStreamingContent: (sessionId, content) =>
        set(
          state => {
            if (state.streamingContents[sessionId] === content) return state
            return {
              streamingContents: {
                ...state.streamingContents,
                [sessionId]: content,
              },
            }
          },
          undefined,
          'setStreamingContent'
        ),

      clearStreamingContent: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.streamingContents
            return { streamingContents: rest }
          },
          undefined,
          'clearStreamingContent'
        ),

      // Tool calls (session-based)
      addToolCall: (sessionId, toolCall) =>
        set(
          state => {
            const existing = state.activeToolCalls[sessionId] ?? []
            // Deduplicate by tool ID - NDJSON sync can emit same event multiple times
            if (existing.some(tc => tc.id === toolCall.id)) {
              return state
            }
            return {
              activeToolCalls: {
                ...state.activeToolCalls,
                [sessionId]: [...existing, toolCall],
              },
            }
          },
          undefined,
          'addToolCall'
        ),

      updateToolCallOutput: (sessionId, toolUseId, output) =>
        set(
          state => {
            const toolCalls = state.activeToolCalls[sessionId] ?? []
            const existing = toolCalls.find(tc => tc.id === toolUseId)
            if (!existing || existing.output === output) return state
            const updatedToolCalls = toolCalls.map(tc =>
              tc.id === toolUseId ? { ...tc, output } : tc
            )
            return {
              activeToolCalls: {
                ...state.activeToolCalls,
                [sessionId]: updatedToolCalls,
              },
            }
          },
          undefined,
          'updateToolCallOutput'
        ),

      clearToolCalls: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.activeToolCalls
            return { activeToolCalls: rest }
          },
          undefined,
          'clearToolCalls'
        ),

      // Content blocks (session-based, for inline tool rendering)
      addTextBlock: (sessionId, text) =>
        set(
          state => {
            const blocks = state.streamingContentBlocks[sessionId] ?? []
            const lastBlock = blocks[blocks.length - 1]

            // If last block is text, append to it; otherwise create new text block
            if (lastBlock && lastBlock.type === 'text') {
              const newBlocks = [...blocks]
              newBlocks[newBlocks.length - 1] = {
                type: 'text',
                text: lastBlock.text + text,
              }
              return {
                streamingContentBlocks: {
                  ...state.streamingContentBlocks,
                  [sessionId]: newBlocks,
                },
              }
            } else {
              return {
                streamingContentBlocks: {
                  ...state.streamingContentBlocks,
                  [sessionId]: [...blocks, { type: 'text', text }],
                },
              }
            }
          },
          undefined,
          'addTextBlock'
        ),

      addToolBlock: (sessionId, toolCallId) =>
        set(
          state => ({
            streamingContentBlocks: {
              ...state.streamingContentBlocks,
              [sessionId]: [
                ...(state.streamingContentBlocks[sessionId] ?? []),
                { type: 'tool_use', tool_call_id: toolCallId },
              ],
            },
          }),
          undefined,
          'addToolBlock'
        ),

      addThinkingBlock: (sessionId, thinking) =>
        set(
          state => {
            const blocks = state.streamingContentBlocks[sessionId] ?? []
            const lastBlock = blocks[blocks.length - 1]

            // If last block is thinking, append to it; otherwise create new
            if (lastBlock && lastBlock.type === 'thinking') {
              const newBlocks = [...blocks]
              newBlocks[newBlocks.length - 1] = {
                type: 'thinking',
                thinking: lastBlock.thinking + thinking,
              }
              return {
                streamingContentBlocks: {
                  ...state.streamingContentBlocks,
                  [sessionId]: newBlocks,
                },
              }
            } else {
              return {
                streamingContentBlocks: {
                  ...state.streamingContentBlocks,
                  [sessionId]: [...blocks, { type: 'thinking', thinking }],
                },
              }
            }
          },
          undefined,
          'addThinkingBlock'
        ),

      clearStreamingContentBlocks: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.streamingContentBlocks
            return { streamingContentBlocks: rest }
          },
          undefined,
          'clearStreamingContentBlocks'
        ),

      getStreamingContentBlocks: sessionId =>
        get().streamingContentBlocks[sessionId] ?? [],

      // Thinking content (session-based, for extended thinking)
      appendThinkingContent: (sessionId, content) =>
        set(
          state => ({
            streamingThinkingContent: {
              ...state.streamingThinkingContent,
              [sessionId]:
                (state.streamingThinkingContent[sessionId] ?? '') + content,
            },
          }),
          undefined,
          'appendThinkingContent'
        ),

      clearThinkingContent: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.streamingThinkingContent
            return { streamingThinkingContent: rest }
          },
          undefined,
          'clearThinkingContent'
        ),

      getThinkingContent: sessionId =>
        get().streamingThinkingContent[sessionId] ?? '',

      // Input drafts (session-based)
      setInputDraft: (sessionId, value) =>
        set(
          state => ({
            inputDrafts: { ...state.inputDrafts, [sessionId]: value },
          }),
          undefined,
          'setInputDraft'
        ),

      clearInputDraft: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.inputDrafts
            return { inputDrafts: rest }
          },
          undefined,
          'clearInputDraft'
        ),

      // Execution mode (session-based)
      cycleExecutionMode: sessionId =>
        set(
          state => {
            const current = state.executionModes[sessionId] ?? 'plan'
            const currentIndex = EXECUTION_MODE_CYCLE.indexOf(current)
            const nextIndex = (currentIndex + 1) % EXECUTION_MODE_CYCLE.length
            // EXECUTION_MODE_CYCLE[nextIndex] is always defined due to modulo
            const next = EXECUTION_MODE_CYCLE[nextIndex] as ExecutionMode
            return {
              executionModes: {
                ...state.executionModes,
                [sessionId]: next,
              },
            }
          },
          undefined,
          'cycleExecutionMode'
        ),

      setExecutionMode: (sessionId, mode) =>
        set(
          state => {
            const newState: Partial<ChatUIState> = {
              executionModes: {
                ...state.executionModes,
                [sessionId]: mode,
              },
            }
            // Clear pending denials when switching to yolo mode (no approvals needed)
            if (
              mode === 'yolo' &&
              state.pendingPermissionDenials[sessionId]?.length
            ) {
              const { [sessionId]: _, ...restDenials } =
                state.pendingPermissionDenials
              newState.pendingPermissionDenials = restDenials
              const { [sessionId]: __, ...restContext } =
                state.deniedMessageContext
              newState.deniedMessageContext = restContext
            }
            return newState
          },
          undefined,
          'setExecutionMode'
        ),

      getExecutionMode: sessionId => get().executionModes[sessionId] ?? 'plan',

      // Thinking level (session-based)
      setThinkingLevel: (sessionId, level) =>
        set(
          state => ({
            thinkingLevels: {
              ...state.thinkingLevels,
              [sessionId]: level,
            },
          }),
          undefined,
          'setThinkingLevel'
        ),

      getThinkingLevel: sessionId => get().thinkingLevels[sessionId] ?? 'off',

      // Effort level (session-based, for Opus 4.6 adaptive thinking)
      setEffortLevel: (sessionId, level) =>
        set(
          state => ({
            effortLevels: {
              ...state.effortLevels,
              [sessionId]: level,
            },
          }),
          undefined,
          'setEffortLevel'
        ),

      getEffortLevel: sessionId => get().effortLevels[sessionId] ?? 'high',

      // Selected backend (session-based)
      setSelectedBackend: (sessionId, backend) =>
        set(
          state => ({
            selectedBackends: {
              ...state.selectedBackends,
              [sessionId]: backend,
            },
          }),
          undefined,
          'setSelectedBackend'
        ),

      // Selected model (session-based)
      setSelectedModel: (sessionId, model) =>
        set(
          state => ({
            selectedModels: {
              ...state.selectedModels,
              [sessionId]: model,
            },
          }),
          undefined,
          'setSelectedModel'
        ),

      // Selected provider (session-based)
      setSelectedProvider: (sessionId: string, provider: string | null) =>
        set(
          state => {
            if (provider === undefined) {
              const { [sessionId]: _, ...rest } = state.selectedProviders
              return { selectedProviders: rest }
            }
            return {
              selectedProviders: {
                ...state.selectedProviders,
                [sessionId]: provider,
              },
            }
          },
          undefined,
          'setSelectedProvider'
        ),

      // Copy all per-session settings from one session to another
      copySessionSettings: (fromId, toId) =>
        set(
          state => {
            const updates: Partial<ChatUIState> = {}
            const em = state.executionModes[fromId]
            if (em !== undefined) {
              updates.executionModes = { ...state.executionModes, [toId]: em }
            }
            const sm = state.selectedModels[fromId]
            if (sm !== undefined) {
              updates.selectedModels = { ...state.selectedModels, [toId]: sm }
            }
            const tl = state.thinkingLevels[fromId]
            if (tl !== undefined) {
              updates.thinkingLevels = { ...state.thinkingLevels, [toId]: tl }
            }
            const el = state.effortLevels[fromId]
            if (el !== undefined) {
              updates.effortLevels = { ...state.effortLevels, [toId]: el }
            }
            const sb = state.selectedBackends[fromId]
            if (sb !== undefined) {
              updates.selectedBackends = {
                ...state.selectedBackends,
                [toId]: sb,
              }
            }
            const sp = state.selectedProviders[fromId]
            if (sp !== undefined) {
              updates.selectedProviders = {
                ...state.selectedProviders,
                [toId]: sp,
              }
            }
            const ms = state.enabledMcpServers[fromId]
            if (ms !== undefined) {
              updates.enabledMcpServers = {
                ...state.enabledMcpServers,
                [toId]: ms,
              }
            }
            if (Object.keys(updates).length === 0) return state
            return updates
          },
          undefined,
          'copySessionSettings'
        ),

      // MCP servers (session-based)
      setEnabledMcpServers: (sessionId, servers) =>
        set(
          state => ({
            enabledMcpServers: {
              ...state.enabledMcpServers,
              [sessionId]: servers,
            },
          }),
          undefined,
          'setEnabledMcpServers'
        ),

      toggleMcpServer: (sessionId, serverName, currentDefaults) =>
        set(
          state => {
            const current =
              state.enabledMcpServers[sessionId] ?? currentDefaults ?? []
            const updated = current.includes(serverName)
              ? current.filter(n => n !== serverName)
              : [...current, serverName]
            return {
              enabledMcpServers: {
                ...state.enabledMcpServers,
                [sessionId]: updated,
              },
            }
          },
          undefined,
          'toggleMcpServer'
        ),

      // Question answering (session-based)
      markQuestionAnswered: (sessionId, toolCallId, answers) =>
        set(
          state => {
            const existingAnswered =
              state.answeredQuestions[sessionId] ?? new Set()
            if (existingAnswered.has(toolCallId)) return state
            const existingSubmitted = state.submittedAnswers[sessionId] ?? {}
            return {
              answeredQuestions: {
                ...state.answeredQuestions,
                [sessionId]: new Set([...existingAnswered, toolCallId]),
              },
              submittedAnswers: {
                ...state.submittedAnswers,
                [sessionId]: {
                  ...existingSubmitted,
                  [toolCallId]: answers,
                },
              },
            }
          },
          undefined,
          'markQuestionAnswered'
        ),

      isQuestionAnswered: (sessionId, toolCallId) => {
        const answered = get().answeredQuestions[sessionId]
        return answered ? answered.has(toolCallId) : false
      },

      getSubmittedAnswers: (sessionId, toolCallId) => {
        return get().submittedAnswers[sessionId]?.[toolCallId]
      },

      // Question skipping (session-based, auto-skips all subsequent questions)
      setQuestionsSkipped: (sessionId, skipped) =>
        set(
          state => {
            if (skipped) {
              return {
                skippedQuestionSessions: {
                  ...state.skippedQuestionSessions,
                  [sessionId]: true,
                },
              }
            } else {
              const { [sessionId]: _, ...rest } = state.skippedQuestionSessions
              return { skippedQuestionSessions: rest }
            }
          },
          undefined,
          'setQuestionsSkipped'
        ),

      areQuestionsSkipped: sessionId =>
        get().skippedQuestionSessions[sessionId] ?? false,

      // Error handling (session-based)
      setError: (sessionId, error) =>
        set(
          state => ({
            errors: { ...state.errors, [sessionId]: error },
          }),
          undefined,
          'setError'
        ),

      setLastSentMessage: (sessionId, message) =>
        set(
          state => ({
            lastSentMessages: {
              ...state.lastSentMessages,
              [sessionId]: message,
            },
          }),
          undefined,
          'setLastSentMessage'
        ),

      clearLastSentMessage: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.lastSentMessages
            return { lastSentMessages: rest }
          },
          undefined,
          'clearLastSentMessage'
        ),

      setLastSentAttachments: (sessionId, attachments) =>
        set(
          state => ({
            lastSentAttachments: {
              ...state.lastSentAttachments,
              [sessionId]: attachments,
            },
          }),
          undefined,
          'setLastSentAttachments'
        ),

      clearLastSentAttachments: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.lastSentAttachments
            return { lastSentAttachments: rest }
          },
          undefined,
          'clearLastSentAttachments'
        ),

      restoreAttachments: sessionId =>
        set(
          state => {
            const saved = state.lastSentAttachments[sessionId]
            if (!saved) return state
            const { [sessionId]: _, ...restAttachments } =
              state.lastSentAttachments
            return {
              pendingImages: {
                ...state.pendingImages,
                [sessionId]: [
                  ...(state.pendingImages[sessionId] ?? []),
                  ...saved.images,
                ],
              },
              pendingFiles: {
                ...state.pendingFiles,
                [sessionId]: [
                  ...(state.pendingFiles[sessionId] ?? []),
                  ...saved.files,
                ],
              },
              pendingTextFiles: {
                ...state.pendingTextFiles,
                [sessionId]: [
                  ...(state.pendingTextFiles[sessionId] ?? []),
                  ...saved.textFiles,
                ],
              },
              pendingSkills: {
                ...state.pendingSkills,
                [sessionId]: [
                  ...(state.pendingSkills[sessionId] ?? []),
                  ...saved.skills,
                ],
              },
              lastSentAttachments: restAttachments,
            }
          },
          undefined,
          'restoreAttachments'
        ),

      // Setup script results (worktree-based)
      addSetupScriptResult: (worktreeId, result) =>
        set(
          state => ({
            setupScriptResults: {
              ...state.setupScriptResults,
              [worktreeId]: result,
            },
          }),
          undefined,
          'addSetupScriptResult'
        ),

      clearSetupScriptResult: worktreeId =>
        set(
          state => {
            const { [worktreeId]: _, ...rest } = state.setupScriptResults
            return { setupScriptResults: rest }
          },
          undefined,
          'clearSetupScriptResult'
        ),

      // Pending images (session-based)
      addPendingImage: (sessionId, image) =>
        set(
          state => ({
            pendingImages: {
              ...state.pendingImages,
              [sessionId]: [...(state.pendingImages[sessionId] ?? []), image],
            },
          }),
          undefined,
          'addPendingImage'
        ),

      updatePendingImage: (sessionId, imageId, updates) =>
        set(
          state => ({
            pendingImages: {
              ...state.pendingImages,
              [sessionId]: (state.pendingImages[sessionId] ?? []).map(img =>
                img.id === imageId ? { ...img, ...updates } : img
              ),
            },
          }),
          undefined,
          'updatePendingImage'
        ),

      removePendingImage: (sessionId, imageId) =>
        set(
          state => ({
            pendingImages: {
              ...state.pendingImages,
              [sessionId]: (state.pendingImages[sessionId] ?? []).filter(
                img => img.id !== imageId
              ),
            },
          }),
          undefined,
          'removePendingImage'
        ),

      clearPendingImages: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.pendingImages
            return { pendingImages: rest }
          },
          undefined,
          'clearPendingImages'
        ),

      getPendingImages: sessionId => get().pendingImages[sessionId] ?? [],

      // Pending files (session-based, for @ mentions)
      addPendingFile: (sessionId, file) =>
        set(
          state => {
            const existing = state.pendingFiles[sessionId] ?? []
            // Deduplicate by relativePath - don't add if already present
            if (existing.some(f => f.relativePath === file.relativePath)) {
              return state
            }
            return {
              pendingFiles: {
                ...state.pendingFiles,
                [sessionId]: [...existing, file],
              },
            }
          },
          undefined,
          'addPendingFile'
        ),

      removePendingFile: (sessionId, fileId) =>
        set(
          state => ({
            pendingFiles: {
              ...state.pendingFiles,
              [sessionId]: (state.pendingFiles[sessionId] ?? []).filter(
                f => f.id !== fileId
              ),
            },
          }),
          undefined,
          'removePendingFile'
        ),

      clearPendingFiles: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.pendingFiles
            return { pendingFiles: rest }
          },
          undefined,
          'clearPendingFiles'
        ),

      getPendingFiles: sessionId => get().pendingFiles[sessionId] ?? [],

      // Pending skills (session-based, for / mentions)
      addPendingSkill: (sessionId, skill) =>
        set(
          state => ({
            pendingSkills: {
              ...state.pendingSkills,
              [sessionId]: [...(state.pendingSkills[sessionId] ?? []), skill],
            },
          }),
          undefined,
          'addPendingSkill'
        ),

      removePendingSkill: (sessionId, skillId) =>
        set(
          state => ({
            pendingSkills: {
              ...state.pendingSkills,
              [sessionId]: (state.pendingSkills[sessionId] ?? []).filter(
                s => s.id !== skillId
              ),
            },
          }),
          undefined,
          'removePendingSkill'
        ),

      clearPendingSkills: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.pendingSkills
            return { pendingSkills: rest }
          },
          undefined,
          'clearPendingSkills'
        ),

      getPendingSkills: sessionId => get().pendingSkills[sessionId] ?? [],

      // Pending text files (session-based)
      addPendingTextFile: (sessionId, textFile) =>
        set(
          state => ({
            pendingTextFiles: {
              ...state.pendingTextFiles,
              [sessionId]: [
                ...(state.pendingTextFiles[sessionId] ?? []),
                textFile,
              ],
            },
          }),
          undefined,
          'addPendingTextFile'
        ),

      updatePendingTextFile: (sessionId, textFileId, content, size) =>
        set(
          state => ({
            pendingTextFiles: {
              ...state.pendingTextFiles,
              [sessionId]: (state.pendingTextFiles[sessionId] ?? []).map(tf =>
                tf.id === textFileId ? { ...tf, content, size } : tf
              ),
            },
          }),
          undefined,
          'updatePendingTextFile'
        ),

      removePendingTextFile: (sessionId, textFileId) =>
        set(
          state => ({
            pendingTextFiles: {
              ...state.pendingTextFiles,
              [sessionId]: (state.pendingTextFiles[sessionId] ?? []).filter(
                tf => tf.id !== textFileId
              ),
            },
          }),
          undefined,
          'removePendingTextFile'
        ),

      clearPendingTextFiles: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.pendingTextFiles
            return { pendingTextFiles: rest }
          },
          undefined,
          'clearPendingTextFiles'
        ),

      getPendingTextFiles: sessionId => get().pendingTextFiles[sessionId] ?? [],

      // Active todos (session-based)
      setActiveTodos: (sessionId, todos) =>
        set(
          state => ({
            activeTodos: {
              ...state.activeTodos,
              [sessionId]: todos,
            },
          }),
          undefined,
          'setActiveTodos'
        ),

      clearActiveTodos: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.activeTodos
            return { activeTodos: rest }
          },
          undefined,
          'clearActiveTodos'
        ),

      getActiveTodos: sessionId => get().activeTodos[sessionId] ?? [],

      // Fixed findings (session-based)
      markFindingFixed: (sessionId, findingKey) =>
        set(
          state => {
            const existing = state.fixedFindings[sessionId] ?? new Set()
            const updated = new Set(existing)
            updated.add(findingKey)
            return {
              fixedFindings: {
                ...state.fixedFindings,
                [sessionId]: updated,
              },
            }
          },
          undefined,
          'markFindingFixed'
        ),

      isFindingFixed: (sessionId, findingKey) =>
        get().fixedFindings[sessionId]?.has(findingKey) ?? false,

      clearFixedFindings: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.fixedFindings
            return { fixedFindings: rest }
          },
          undefined,
          'clearFixedFindings'
        ),

      // Streaming plan approvals (session-based)
      setStreamingPlanApproved: (sessionId, approved) =>
        set(
          state => ({
            streamingPlanApprovals: {
              ...state.streamingPlanApprovals,
              [sessionId]: approved,
            },
          }),
          undefined,
          'setStreamingPlanApproved'
        ),

      isStreamingPlanApproved: sessionId =>
        get().streamingPlanApprovals[sessionId] ?? false,

      clearStreamingPlanApproval: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.streamingPlanApprovals
            return { streamingPlanApprovals: rest }
          },
          undefined,
          'clearStreamingPlanApproval'
        ),

      // Message queue (session-based)
      enqueueMessage: (sessionId, message) =>
        set(
          state => ({
            messageQueues: {
              ...state.messageQueues,
              [sessionId]: [...(state.messageQueues[sessionId] ?? []), message],
            },
          }),
          undefined,
          'enqueueMessage'
        ),

      dequeueMessage: sessionId => {
        const queue = get().messageQueues[sessionId] ?? []
        if (queue.length === 0) return undefined

        const [first, ...rest] = queue
        set(
          state => ({
            messageQueues: {
              ...state.messageQueues,
              [sessionId]: rest,
            },
          }),
          undefined,
          'dequeueMessage'
        )
        return first
      },

      removeQueuedMessage: (sessionId, messageId) =>
        set(
          state => ({
            messageQueues: {
              ...state.messageQueues,
              [sessionId]: (state.messageQueues[sessionId] ?? []).filter(
                m => m.id !== messageId
              ),
            },
          }),
          undefined,
          'removeQueuedMessage'
        ),

      clearQueue: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.messageQueues
            return { messageQueues: rest }
          },
          undefined,
          'clearQueue'
        ),

      getQueueLength: sessionId =>
        (get().messageQueues[sessionId] ?? []).length,

      getQueuedMessages: sessionId => get().messageQueues[sessionId] ?? [],

      forceProcessQueue: sessionId =>
        set(
          state => {
            // Clear stale sending/waiting flags so queue processor picks up the message
            const { [sessionId]: _s, ...restSending } = state.sendingSessionIds
            const { [sessionId]: _w, ...restWaiting } =
              state.waitingForInputSessionIds
            return {
              sendingSessionIds: restSending,
              waitingForInputSessionIds: restWaiting,
            }
          },
          undefined,
          'forceProcessQueue'
        ),

      // Executing mode actions (tracks mode prompt was sent with)
      setExecutingMode: (sessionId, mode) =>
        set(
          state => {
            if (state.executingModes[sessionId] === mode) return state
            return {
              executingModes: {
                ...state.executingModes,
                [sessionId]: mode,
              },
            }
          },
          undefined,
          'setExecutingMode'
        ),

      clearExecutingMode: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.executingModes
            return { executingModes: rest }
          },
          undefined,
          'clearExecutingMode'
        ),

      getExecutingMode: sessionId => get().executingModes[sessionId],

      // Permission approvals (session-scoped)
      addApprovedTool: (sessionId, toolPattern) =>
        set(
          state => ({
            approvedTools: {
              ...state.approvedTools,
              [sessionId]: [
                ...(state.approvedTools[sessionId] ?? []),
                toolPattern,
              ],
            },
          }),
          undefined,
          'addApprovedTool'
        ),

      getApprovedTools: sessionId => get().approvedTools[sessionId] ?? [],

      clearApprovedTools: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.approvedTools
            return { approvedTools: rest }
          },
          undefined,
          'clearApprovedTools'
        ),

      // Pending permission denials
      setPendingDenials: (sessionId, denials) => {
        return set(
          state => {
            const current = state.pendingPermissionDenials[sessionId]
            if (!current && denials.length === 0) return state
            return {
              pendingPermissionDenials: {
                ...state.pendingPermissionDenials,
                [sessionId]: denials,
              },
            }
          },
          undefined,
          'setPendingDenials'
        )
      },

      clearPendingDenials: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.pendingPermissionDenials
            return { pendingPermissionDenials: rest }
          },
          undefined,
          'clearPendingDenials'
        ),

      getPendingDenials: sessionId =>
        get().pendingPermissionDenials[sessionId] ?? [],

      // Denied message context (for re-send)
      setDeniedMessageContext: (sessionId, context) =>
        set(
          state => ({
            deniedMessageContext: {
              ...state.deniedMessageContext,
              [sessionId]: context,
            },
          }),
          undefined,
          'setDeniedMessageContext'
        ),

      clearDeniedMessageContext: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.deniedMessageContext
            return { deniedMessageContext: rest }
          },
          undefined,
          'clearDeniedMessageContext'
        ),

      getDeniedMessageContext: sessionId =>
        get().deniedMessageContext[sessionId],

      // Batch state transitions — single set() to avoid render cascades
      // Used by useStreamingEvents to atomically transition session state
      completeSession: sessionId =>
        set(
          state => {
            // Protection window: if this session just started sending (within 500ms)
            // and the NEW run has not emitted any streaming state yet, this is
            // likely a stale completion from a previous cancelled run. Skip it.
            const sendStarted = state.sendStartedAt[sessionId] ?? 0
            const elapsed = Date.now() - sendStarted
            const hasStreamingState = hasActiveStreamingState(state, sessionId)
            if (sendStarted > 0 && elapsed < 500 && !hasStreamingState) {
              console.warn(
                `[Store] completeSession BLOCKED for session=${sessionId} — send started ${elapsed}ms ago with no current streaming state (stale event from previous run)`
              )
              return state
            }
            console.log(`[Store] completeSession id=${sessionId}`, {
              wasSending: !!state.sendingSessionIds[sessionId],
              elapsed: sendStarted > 0 ? elapsed : 'n/a',
              hasStreamingState,
            })
            const { [sessionId]: _sc, ...streamingContents } =
              state.streamingContents
            const { [sessionId]: _sb, ...streamingContentBlocks } =
              state.streamingContentBlocks
            const { [sessionId]: _tc, ...activeToolCalls } =
              state.activeToolCalls
            const { [sessionId]: _ss, ...sendingSessionIds } =
              state.sendingSessionIds
            const { [sessionId]: _wi, ...waitingForInputSessionIds } =
              state.waitingForInputSessionIds
            const { [sessionId]: _sp, ...streamingPlanApprovals } =
              state.streamingPlanApprovals
            const { [sessionId]: _em, ...executingModes } = state.executingModes
            const { [sessionId]: _sa, ...sendStartedAtRest } =
              state.sendStartedAt
            return {
              streamingContents,
              streamingContentBlocks,
              activeToolCalls,
              sendingSessionIds,
              waitingForInputSessionIds,
              streamingPlanApprovals,
              executingModes,
              sendStartedAt: sendStartedAtRest,
              completedDurations:
                sendStarted > 0
                  ? { ...state.completedDurations, [sessionId]: elapsed }
                  : state.completedDurations,
              reviewingSessions: {
                ...state.reviewingSessions,
                [sessionId]: true,
              },
            }
          },
          undefined,
          'completeSession'
        ),

      cancelSession: sessionId =>
        set(
          state => {
            const sendStarted = state.sendStartedAt[sessionId] ?? 0
            const elapsed = Date.now() - sendStarted
            const { [sessionId]: _sc, ...streamingContents } =
              state.streamingContents
            const { [sessionId]: _sb, ...streamingContentBlocks } =
              state.streamingContentBlocks
            const { [sessionId]: _tc, ...activeToolCalls } =
              state.activeToolCalls
            const { [sessionId]: _ss, ...sendingSessionIds } =
              state.sendingSessionIds
            const { [sessionId]: _wi, ...waitingForInputSessionIds } =
              state.waitingForInputSessionIds
            const { [sessionId]: _sp, ...streamingPlanApprovals } =
              state.streamingPlanApprovals
            const { [sessionId]: _em, ...executingModes } = state.executingModes
            const { [sessionId]: _pd, ...pendingPermissionDenials } =
              state.pendingPermissionDenials
            const { [sessionId]: _dc, ...deniedMessageContext } =
              state.deniedMessageContext
            const { [sessionId]: _sa, ...sendStartedAtRest } =
              state.sendStartedAt
            return {
              streamingContents,
              streamingContentBlocks,
              activeToolCalls,
              sendingSessionIds,
              waitingForInputSessionIds,
              streamingPlanApprovals,
              executingModes,
              pendingPermissionDenials,
              deniedMessageContext,
              sendStartedAt: sendStartedAtRest,
              completedDurations:
                sendStarted > 0
                  ? { ...state.completedDurations, [sessionId]: elapsed }
                  : state.completedDurations,
              reviewingSessions: {
                ...state.reviewingSessions,
                [sessionId]: true,
              },
            }
          },
          undefined,
          'cancelSession'
        ),

      pauseSession: sessionId =>
        set(
          state => {
            // Same stale-event protection as completeSession: only block if the
            // new run has not emitted any streaming state yet.
            const sendStarted = state.sendStartedAt[sessionId] ?? 0
            const elapsed = Date.now() - sendStarted
            const hasStreamingState = hasActiveStreamingState(state, sessionId)
            if (sendStarted > 0 && elapsed < 500 && !hasStreamingState) {
              console.warn(
                `[Store] pauseSession BLOCKED for session=${sessionId} — send started ${elapsed}ms ago with no current streaming state`
              )
              return state
            }
            const { [sessionId]: _sc, ...streamingContents } =
              state.streamingContents
            const { [sessionId]: _ss, ...sendingSessionIds } =
              state.sendingSessionIds
            const { [sessionId]: _em, ...executingModes } = state.executingModes
            const { [sessionId]: _sa, ...sendStartedAtRest } =
              state.sendStartedAt
            return {
              streamingContents,
              sendingSessionIds,
              executingModes,
              sendStartedAt: sendStartedAtRest,
              waitingForInputSessionIds: {
                ...state.waitingForInputSessionIds,
                [sessionId]: true,
              },
            }
          },
          undefined,
          'pauseSession'
        ),

      failSession: sessionId =>
        set(
          state => {
            const sendStarted = state.sendStartedAt[sessionId] ?? 0
            const elapsed = Date.now() - sendStarted
            if (sendStarted > 0 && elapsed < 500) {
              console.warn(
                `[Store] failSession BLOCKED for session=${sessionId} — send started ${elapsed}ms ago (stale event from previous run)`
              )
              return state
            }
            const { [sessionId]: _sc, ...streamingContents } =
              state.streamingContents
            const { [sessionId]: _sb, ...streamingContentBlocks } =
              state.streamingContentBlocks
            const { [sessionId]: _tc, ...activeToolCalls } =
              state.activeToolCalls
            const { [sessionId]: _ss, ...sendingSessionIds } =
              state.sendingSessionIds
            const { [sessionId]: _wi, ...waitingForInputSessionIds } =
              state.waitingForInputSessionIds
            const { [sessionId]: _sa, ...sendStartedAtRest } =
              state.sendStartedAt
            return {
              streamingContents,
              streamingContentBlocks,
              activeToolCalls,
              sendingSessionIds,
              waitingForInputSessionIds,
              sendStartedAt: sendStartedAtRest,
              reviewingSessions: {
                ...state.reviewingSessions,
                [sessionId]: true,
              },
            }
          },
          undefined,
          'failSession'
        ),

      // Unified session state cleanup (for close/archive)
      clearSessionState: sessionId =>
        set(
          state => {
            const { [sessionId]: _approved, ...restApproved } =
              state.approvedTools
            const { [sessionId]: _denials, ...restDenials } =
              state.pendingPermissionDenials
            const { [sessionId]: _denied, ...restDenied } =
              state.deniedMessageContext
            const { [sessionId]: _reviewing, ...restReviewing } =
              state.reviewingSessions
            const { [sessionId]: _waiting, ...restWaiting } =
              state.waitingForInputSessionIds
            const { [sessionId]: _answered, ...restAnswered } =
              state.answeredQuestions
            const { [sessionId]: _submitted, ...restSubmitted } =
              state.submittedAnswers
            const { [sessionId]: _fixed, ...restFixed } = state.fixedFindings
            const { [sessionId]: _effort, ...restEffort } = state.effortLevels
            const { [sessionId]: _mcp, ...restMcp } = state.enabledMcpServers
            const { [sessionId]: _label, ...restLabels } = state.sessionLabels

            return {
              approvedTools: restApproved,
              pendingPermissionDenials: restDenials,
              deniedMessageContext: restDenied,
              reviewingSessions: restReviewing,
              waitingForInputSessionIds: restWaiting,
              answeredQuestions: restAnswered,
              submittedAnswers: restSubmitted,
              fixedFindings: restFixed,
              effortLevels: restEffort,
              enabledMcpServers: restMcp,
              sessionLabels: restLabels,
            }
          },
          undefined,
          'clearSessionState'
        ),

      // Compaction tracking
      setCompacting: (sessionId, compacting) =>
        set(
          state => ({
            compactingSessions: {
              ...state.compactingSessions,
              ...(compacting
                ? { [sessionId]: true }
                : (() => {
                    const { [sessionId]: _, ...rest } = state.compactingSessions
                    return rest
                  })()),
            },
          }),
          undefined,
          'setCompacting'
        ),

      setLastCompaction: (sessionId, trigger) =>
        set(
          state => ({
            lastCompaction: {
              ...state.lastCompaction,
              [sessionId]: {
                timestamp: Date.now(),
                trigger,
              },
            },
          }),
          undefined,
          'setLastCompaction'
        ),

      getLastCompaction: sessionId => get().lastCompaction[sessionId],

      clearLastCompaction: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...rest } = state.lastCompaction
            return { lastCompaction: rest }
          },
          undefined,
          'clearLastCompaction'
        ),

      // Save context tracking
      setSavingContext: (sessionId, saving) =>
        set(
          state => ({
            savingContext: saving
              ? { ...state.savingContext, [sessionId]: true }
              : (() => {
                  const { [sessionId]: _, ...rest } = state.savingContext
                  return rest
                })(),
          }),
          undefined,
          'setSavingContext'
        ),

      isSavingContext: sessionId => get().savingContext[sessionId] ?? false,

      // Session digest actions (context recall after switching)
      markSessionNeedsDigest: sessionId =>
        set(
          state => ({
            pendingDigestSessionIds: {
              ...state.pendingDigestSessionIds,
              [sessionId]: true,
            },
          }),
          undefined,
          'markSessionNeedsDigest'
        ),

      clearPendingDigest: sessionId =>
        set(
          state => {
            const { [sessionId]: _, ...restPending } =
              state.pendingDigestSessionIds
            const { [sessionId]: __, ...restDigests } = state.sessionDigests
            return {
              pendingDigestSessionIds: restPending,
              sessionDigests: restDigests,
            }
          },
          undefined,
          'clearPendingDigest'
        ),

      setSessionDigest: (sessionId, digest) =>
        set(
          state => ({
            sessionDigests: {
              ...state.sessionDigests,
              [sessionId]: digest,
            },
          }),
          undefined,
          'setSessionDigest'
        ),

      hasPendingDigest: sessionId =>
        get().pendingDigestSessionIds[sessionId] ?? false,

      getSessionDigest: sessionId => get().sessionDigests[sessionId],

      // Worktree loading operations (commit, pr, review, merge, pull)
      setWorktreeLoading: (worktreeId, operation) =>
        set(
          state => ({
            worktreeLoadingOperations: {
              ...state.worktreeLoadingOperations,
              [worktreeId]: operation,
            },
          }),
          undefined,
          'setWorktreeLoading'
        ),

      clearWorktreeLoading: worktreeId =>
        set(
          state => {
            const { [worktreeId]: _, ...rest } = state.worktreeLoadingOperations
            return { worktreeLoadingOperations: rest }
          },
          undefined,
          'clearWorktreeLoading'
        ),

      getWorktreeLoadingOperation: worktreeId =>
        get().worktreeLoadingOperations[worktreeId] ?? null,

      // Pending magic command (set when navigating from canvas, consumed by ChatWindow on mount)
      setPendingMagicCommand: cmd =>
        set({ pendingMagicCommand: cmd }, undefined, 'setPendingMagicCommand'),

      // Legacy actions (deprecated - for backward compatibility)
      addSendingWorktree: worktreeId => {
        // Legacy: use worktreeId as sessionId for backward compatibility
        get().addSendingSession(worktreeId)
      },

      removeSendingWorktree: worktreeId => {
        // Legacy: use worktreeId as sessionId for backward compatibility
        get().removeSendingSession(worktreeId)
      },
    }),
    {
      name: 'chat-store',
    }
  )
)
