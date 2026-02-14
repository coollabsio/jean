import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { generateId } from '@/lib/uuid'
import { toast } from 'sonner'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { GitBranch, GitMerge, Layers } from 'lucide-react'
import {
  useSession,
  useSessions,
  useSendMessage,
  useSetSessionModel,
  useSetSessionThinkingLevel,
  useSetSessionProvider,
  useCreateSession,
  cancelChatMessage,
  chatQueryKeys,
  markPlanApproved as markPlanApprovedService,
} from '@/services/chat'
import {
  useWorktree,
  useProjects,
  useRunScript,
  projectsQueryKeys,
} from '@/services/projects'
import {
  useLoadedIssueContexts,
  useLoadedPRContexts,
  useAttachedSavedContexts,
} from '@/services/github'
import {
  useChatStore,
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
  type ClaudeModel,
} from '@/store/chat-store'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import {
  DEFAULT_INVESTIGATE_ISSUE_PROMPT,
  DEFAULT_INVESTIGATE_PR_PROMPT,
  DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT,
  DEFAULT_PARALLEL_EXECUTION_PROMPT,
  PREDEFINED_CLI_PROFILES,
  resolveMagicPromptProvider,
} from '@/types/preferences'
import type { Project, Worktree } from '@/types/projects'
import type {
  ChatMessage,
  ToolCall,
  ThinkingLevel,
  EffortLevel,
  ContentBlock,
  PendingImage,
  PendingTextFile,
  PendingSkill,
  PermissionDenial,
  PendingFile,
} from '@/types/chat'
import { isAskUserQuestion, isExitPlanMode, isTodoWrite } from '@/types/chat'
import { getFilename, normalizePath } from '@/lib/path-utils'
import { cn } from '@/lib/utils'
import { PermissionApproval } from './PermissionApproval'
import { SetupScriptOutput } from './SetupScriptOutput'
import { SessionTabBar } from './SessionTabBar'
import { TodoWidget } from './TodoWidget'
import {
  normalizeTodosForDisplay,
  findPlanFilePath,
  findPlanContent,
} from './tool-call-utils'
import { ImagePreview } from './ImagePreview'
import { TextFilePreview } from './TextFilePreview'
import { SkillBadge } from './SkillBadge'
import { FileContentModal } from './FileContentModal'
import { FilePreview } from './FilePreview'
import { ChatInput } from './ChatInput'
import { SessionDebugPanel } from './SessionDebugPanel'
import { ChatToolbar } from './ChatToolbar'
import { ReviewResultsPanel } from './ReviewResultsPanel'
import { SessionCanvasView } from './SessionCanvasView'
import { QueuedMessagesList } from './QueuedMessageItem'
import { FloatingButtons } from './FloatingButtons'
import { PlanDialog } from './PlanDialog'
import { StreamingMessage } from './StreamingMessage'
import { ChatErrorFallback } from './ChatErrorFallback'
import { logger } from '@/lib/logger'
import { saveCrashState } from '@/lib/recovery'
import { ErrorBanner } from './ErrorBanner'
import { SessionDigestReminder } from './SessionDigestReminder'
import {
  VirtualizedMessageList,
  type VirtualizedMessageListHandle,
} from './VirtualizedMessageList'
import {
  extractImagePaths,
  extractTextFilePaths,
  extractFileMentionPaths,
  extractSkillPaths,
  stripAllMarkers,
} from './message-content-utils'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import {
  useMcpServers,
  buildMcpConfigJson,
  invalidateMcpServers,
  getNewServersToAutoEnable,
} from '@/services/mcp'
import type { McpServerInfo } from '@/types/chat'
import { useGitStatus } from '@/services/git-status'
import { isServerApp } from '@/lib/environment'
import { supportsAdaptiveThinking } from '@/lib/model-utils'
import { useClaudeCliStatus } from '@/services/claude-cli'
import { usePrStatus, usePrStatusEvents } from '@/services/pr-status'
import type { PrDisplayStatus, CheckStatus } from '@/types/pr-status'
import type { QueuedMessage, ExecutionMode, Session } from '@/types/chat'
import type { DiffRequest } from '@/types/git-diff'
import { GitDiffModal } from './GitDiffModal'
import { FileDiffModal } from './FileDiffModal'
import { LoadContextModal } from '../magic/LoadContextModal'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  type ImperativePanelHandle,
} from '@/components/ui/resizable'
import { TerminalPanel } from './TerminalPanel'
import { useTerminalStore } from '@/store/terminal-store'

// Extracted hooks (useStreamingEvents is now in App.tsx for global persistence)
import { useScrollManagement } from './hooks/useScrollManagement'
import { useGitOperations } from './hooks/useGitOperations'
import { useContextOperations } from './hooks/useContextOperations'
import {
  useMessageHandlers,
  GIT_ALLOWED_TOOLS,
} from './hooks/useMessageHandlers'
import {
  useMagicCommands,
  type WorkflowRunDetail,
} from './hooks/useMagicCommands'
import { useDragAndDropImages } from './hooks/useDragAndDropImages'

// PERFORMANCE: Stable empty array references to prevent infinite render loops
// When Zustand selectors return [], a new reference is created each time
// Using these constants ensures referential equality for empty states
const EMPTY_TOOL_CALLS: ToolCall[] = []
const EMPTY_CONTENT_BLOCKS: ContentBlock[] = []
const EMPTY_PENDING_IMAGES: PendingImage[] = []
const EMPTY_PENDING_TEXT_FILES: PendingTextFile[] = []
const EMPTY_PENDING_FILES: PendingFile[] = []
const EMPTY_PENDING_SKILLS: PendingSkill[] = []
const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = []
const EMPTY_PERMISSION_DENIALS: PermissionDenial[] = []

interface ChatWindowProps {
  /** When true, hides SessionTabBar, terminal panel, and other elements not needed in modal */
  isModal?: boolean
  /** Override worktree ID (used in modal mode to avoid setting global state) */
  worktreeId?: string
  /** Override worktree path (used in modal mode to avoid setting global state) */
  worktreePath?: string
}

export function ChatWindow({
  isModal = false,
  worktreeId: propWorktreeId,
  worktreePath: propWorktreePath,
}: ChatWindowProps = {}) {
  // PERFORMANCE: Use focused selectors instead of whole-store destructuring
  // This prevents re-renders when other sessions' state changes (e.g., streaming chunks)

  // Stable values that don't change per-session
  // Use props if provided (modal mode), otherwise fall back to store
  const storeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const storeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const activeWorktreeId = propWorktreeId ?? storeWorktreeId
  const activeWorktreePath = propWorktreePath ?? storeWorktreePath

  // PERFORMANCE: Proper selector for activeSessionId - subscribes to changes
  // This triggers re-render when tabs are clicked (setActiveSession updates activeSessionIds)
  // Without this, ChatWindow wouldn't know when to re-render on tab switch
  let activeSessionId = useChatStore(state =>
    activeWorktreeId ? state.activeSessionIds[activeWorktreeId] : undefined
  )

  // PERF: Direct data subscription for isSending - triggers re-render when sendingSessionIds changes
  // (Previously used function selector which was a stable ref that never triggered re-renders)
  const isSendingForSession = useChatStore(state =>
    activeSessionId
      ? (state.sendingSessionIds[activeSessionId] ?? false)
      : false
  )
  // Function selectors - these return stable function references
  const isQuestionAnswered = useChatStore(state => state.isQuestionAnswered)
  const getSubmittedAnswers = useChatStore(state => state.getSubmittedAnswers)
  const areQuestionsSkipped = useChatStore(state => state.areQuestionsSkipped)
  const isFindingFixed = useChatStore(state => state.isFindingFixed)
  // DATA subscription for answered questions - triggers re-render when persisted state is restored
  // Without this, the function selectors above are stable refs that don't cause re-renders
  // when answeredQuestions is updated by useUIStatePersistence (submittedAnswers updates together)
  // PERFORMANCE: Focus on current session only to avoid re-renders from other sessions
  const answeredQuestions = useChatStore(state =>
    activeSessionId ? state.answeredQuestions[activeSessionId] : undefined
  )
  // Review sidebar state
  const reviewSidebarVisible = useChatStore(state => state.reviewSidebarVisible)
  const hasReviewResults = useChatStore(state =>
    activeSessionId ? !!state.reviewResults[activeSessionId] : false
  )
  // PERFORMANCE: Proper selector for isViewingCanvasTab - subscribes to actual data
  // Default to true so Canvas is the initial view when opening a worktree
  const isViewingCanvasTabRaw = useChatStore(state =>
    state.activeWorktreeId
      ? (state.viewingCanvasTab[state.activeWorktreeId] ?? true)
      : false
  )


  const isStreamingPlanApproved = useChatStore(
    state => state.isStreamingPlanApproved
  )
  // Manual thinking override per session (user changed thinking while in build/yolo)
  const hasManualThinkingOverride = useChatStore(state =>
    activeSessionId
      ? (state.manualThinkingOverrides[activeSessionId] ?? false)
      : false
  )

  // Terminal panel visibility (per-worktree)
  const terminalVisible = useTerminalStore(state => state.terminalVisible)
  const terminalPanelOpen = useTerminalStore(state =>
    activeWorktreeId
      ? (state.terminalPanelOpen[activeWorktreeId] ?? false)
      : false
  )
  const { setTerminalVisible } = useTerminalStore.getState()

  // Sync terminal panel with terminalVisible state
  useEffect(() => {
    const panel = terminalPanelRef.current
    if (!panel) return

    if (terminalVisible) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [terminalVisible])

  // Terminal panel collapse/expand handlers
  const handleTerminalCollapse = useCallback(() => {
    setTerminalVisible(false)
  }, [setTerminalVisible])

  const handleTerminalExpand = useCallback(() => {
    setTerminalVisible(true)
  }, [setTerminalVisible])

  // Sync review sidebar panel with reviewSidebarVisible state
  useEffect(() => {
    const panel = reviewPanelRef.current
    if (!panel) return

    if (reviewSidebarVisible) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [reviewSidebarVisible])

  // Review sidebar collapse/expand handlers
  const handleReviewSidebarCollapse = useCallback(() => {
    useChatStore.getState().setReviewSidebarVisible(false)
  }, [])

  const handleReviewSidebarExpand = useCallback(() => {
    useChatStore.getState().setReviewSidebarVisible(true)
  }, [])


  // Actions - get via getState() for stable references (no subscriptions needed)
  const {
    setInputDraft,
    clearInputDraft,
    setExecutionMode,
    setError,
    clearSetupScriptResult,
  } = useChatStore.getState()

  const queryClient = useQueryClient()

  // Load sessions to ensure we have a valid active session
  const {
    data: sessionsData,
    isLoading: isSessionsLoading,
    isFetching: isSessionsFetching,
  } = useSessions(activeWorktreeId, activeWorktreePath)

  const uiStateInitialized = useUIStore(state => state.uiStateInitialized)

  // Sync active session from backend if store doesn't have one
  useEffect(() => {
    // Wait for UI state to be restored from persisted storage first,
    // otherwise we'd overwrite the restored activeSessionIds with the first session
    if (!uiStateInitialized) return
    // Skip while refetching - stale cached data could overwrite a valid selection
    // (e.g., when creating a new session, the cache doesn't include it yet)
    if (!activeWorktreeId || !sessionsData || isSessionsFetching) return

    const store = useChatStore.getState()
    const currentActive = store.activeSessionIds[activeWorktreeId]
    const sessions = sessionsData.sessions
    const firstSession = sessions[0]

    // If no active session in store, or it doesn't exist in loaded sessions
    if (sessions.length > 0 && firstSession) {
      const sessionExists = sessions.some(s => s.id === currentActive)
      if (!currentActive || !sessionExists) {
        const targetSession = sessionsData.active_session_id ?? firstSession.id
        store.setActiveSession(activeWorktreeId, targetSession)
      }
    }
  }, [sessionsData, activeWorktreeId, isSessionsFetching, uiStateInitialized])

  // Use backend's active session if store doesn't have one yet
  if (!activeSessionId && sessionsData?.sessions.length) {
    activeSessionId =
      sessionsData.active_session_id ?? sessionsData.sessions[0]?.id
  }

  // PERFORMANCE: Defer the session ID used for content rendering
  // This allows React to show old session content while rendering new session in background
  // The activeSessionId is used for immediate feedback (tab highlighting, sending messages)
  // The deferredSessionId is used for content that can be rendered concurrently
  const deferredSessionId = useDeferredValue(activeSessionId)
  const isSessionSwitching = deferredSessionId !== activeSessionId

  // Load the active session's messages (uses deferred ID for concurrent rendering)
  const { data: session, isLoading } = useSession(
    deferredSessionId ?? null,
    activeWorktreeId,
    activeWorktreePath
  )

  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()
  // Apply canvas preferences: if canvas disabled, never show; if canvas-only, always show
  const canvasEnabled = preferences?.canvas_enabled ?? true
  const canvasOnlyMode = preferences?.canvas_only_mode ?? false
  const isViewingCanvasTab = canvasEnabled
    ? canvasOnlyMode || isViewingCanvasTabRaw
    : false
  const sessionModalOpen = useUIStore(state => state.sessionChatModalOpen)
  const focusChatShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.focus_chat_input ??
      DEFAULT_KEYBINDINGS.focus_chat_input) as string
  )
  const magicModalShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_magic_modal ??
      DEFAULT_KEYBINDINGS.open_magic_modal) as string
  )
  const approveShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.approve_plan ??
      DEFAULT_KEYBINDINGS.approve_plan) as string
  )
  const approveShortcutYolo = formatShortcutDisplay(
    (preferences?.keybindings?.approve_plan_yolo ??
      DEFAULT_KEYBINDINGS.approve_plan_yolo) as string
  )
  const sendMessage = useSendMessage()
  const createSession = useCreateSession()
  const setSessionModel = useSetSessionModel()
  const setSessionThinkingLevel = useSetSessionThinkingLevel()
  const setSessionProvider = useSetSessionProvider()

  // Fetch worktree data for PR link display
  const { data: worktree } = useWorktree(activeWorktreeId ?? null)

  // Fetch projects to get project path for run toggle
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null

  // Git status for pull indicator
  const { data: gitStatus } = useGitStatus(activeWorktreeId ?? null)

  // Loaded issue contexts for indicator
  const { data: loadedIssueContexts } = useLoadedIssueContexts(
    activeSessionId ?? null,
    activeWorktreeId
  )

  // Loaded PR contexts for indicator and investigate PR functionality
  const { data: loadedPRContexts } = useLoadedPRContexts(
    activeSessionId ?? null,
    activeWorktreeId
  )

  // Attached saved contexts for indicator
  const { data: attachedSavedContexts } = useAttachedSavedContexts(
    activeSessionId ?? null
  )
  // Diff stats with cached fallback
  const uncommittedAdded =
    gitStatus?.uncommitted_added ?? worktree?.cached_uncommitted_added ?? 0
  const uncommittedRemoved =
    gitStatus?.uncommitted_removed ?? worktree?.cached_uncommitted_removed ?? 0
  const branchDiffAdded =
    gitStatus?.branch_diff_added ?? worktree?.cached_branch_diff_added ?? 0
  const branchDiffRemoved =
    gitStatus?.branch_diff_removed ?? worktree?.cached_branch_diff_removed ?? 0

  // PR status for dynamic PR button
  usePrStatusEvents() // Listen for PR status updates
  const { data: prStatus } = usePrStatus(activeWorktreeId ?? null)
  // Use live status if available, otherwise fall back to cached
  const displayStatus =
    prStatus?.display_status ??
    (worktree?.cached_pr_status as PrDisplayStatus | undefined)
  const checkStatus =
    prStatus?.check_status ??
    (worktree?.cached_check_status as CheckStatus | undefined)
  const mergeableStatus = prStatus?.mergeable ?? undefined

  // Run script for this worktree (used by CMD+R keybinding)
  const { data: runScript } = useRunScript(activeWorktreePath ?? null)

  // Per-session model selection, falls back to preferences default
  const defaultModel: ClaudeModel =
    (preferences?.selected_model as ClaudeModel) ?? DEFAULT_MODEL
  const selectedModel: ClaudeModel =
    (session?.selected_model as ClaudeModel) ?? defaultModel

  // Per-session provider selection: persisted session → zustand → project default → global default
  const projectDefaultProvider = project?.default_provider ?? null
  const globalDefaultProvider = preferences?.default_provider ?? null
  const defaultProvider = projectDefaultProvider ?? globalDefaultProvider
  const zustandProvider = useChatStore(state =>
    deferredSessionId ? state.selectedProviders[deferredSessionId] : undefined
  )
  const sessionProvider = session?.selected_provider ?? zustandProvider
  const selectedProvider = sessionProvider !== undefined ? sessionProvider : defaultProvider
  // __anthropic__ is the sentinel for "use default Anthropic" — treat as non-custom for feature detection
  const isCustomProvider = Boolean(selectedProvider && selectedProvider !== '__anthropic__')

  // Per-session thinking level, falls back to preferences default
  const defaultThinkingLevel =
    (preferences?.thinking_level as ThinkingLevel) ?? DEFAULT_THINKING_LEVEL
  // PERFORMANCE: Use deferredSessionId for content selectors to prevent sync cascade on tab switch
  const sessionThinkingLevel = useChatStore(state =>
    deferredSessionId ? state.thinkingLevels[deferredSessionId] : undefined
  )
  const selectedThinkingLevel =
    (session?.selected_thinking_level as ThinkingLevel) ??
    sessionThinkingLevel ??
    defaultThinkingLevel

  // Per-session effort level, falls back to preferences default
  const defaultEffortLevel =
    (preferences?.default_effort_level as EffortLevel) ?? 'high'
  const sessionEffortLevel = useChatStore(state =>
    deferredSessionId ? state.effortLevels[deferredSessionId] : undefined
  )
  const selectedEffortLevel: EffortLevel =
    sessionEffortLevel ?? defaultEffortLevel

  // MCP servers: fetch available servers and get per-session enabled state
  const { data: mcpServersData } = useMcpServers(activeWorktreePath)
  const availableMcpServers = useMemo(
    () => mcpServersData ?? [],
    [mcpServersData]
  )

  // Re-read MCP config when switching worktrees
  useEffect(() => {
    if (activeWorktreePath) invalidateMcpServers(activeWorktreePath)
  }, [activeWorktreePath])
  const sessionEnabledMcpServers = useChatStore(state =>
    deferredSessionId ? state.enabledMcpServers[deferredSessionId] : undefined
  )
  // Resolve enabled servers from session → project → global defaults,
  // then auto-include any newly discovered (non-disabled) servers
  const baseEnabledMcpServers = useMemo(
    () =>
      sessionEnabledMcpServers ??
      project?.enabled_mcp_servers ??
      preferences?.default_enabled_mcp_servers ??
      [],
    [
      sessionEnabledMcpServers,
      project?.enabled_mcp_servers,
      preferences?.default_enabled_mcp_servers,
    ]
  )
  const newAutoEnabled = useMemo(
    () => getNewServersToAutoEnable(availableMcpServers, baseEnabledMcpServers),
    [availableMcpServers, baseEnabledMcpServers]
  )
  const enabledMcpServers = useMemo(
    () =>
      newAutoEnabled.length > 0
        ? [...baseEnabledMcpServers, ...newAutoEnabled]
        : baseEnabledMcpServers,
    [baseEnabledMcpServers, newAutoEnabled]
  )

  // CLI version for adaptive thinking feature detection
  const { data: cliStatus } = useClaudeCliStatus()
  // Custom providers don't support Opus 4.6 adaptive thinking — use thinking levels instead
  const useAdaptiveThinkingFlag = !isCustomProvider && supportsAdaptiveThinking(
    selectedModel,
    cliStatus?.version ?? null
  )

  // Hide thinking level UI entirely for providers that don't support it
  const customCliProfiles = preferences?.custom_cli_profiles ?? []
  const activeProfile = isCustomProvider
    ? customCliProfiles.find(p => p.name === selectedProvider)
    : null
  // Fall back to predefined template's supports_thinking for profiles saved before this field existed
  const activeSupportsThinking = activeProfile?.supports_thinking
    ?? PREDEFINED_CLI_PROFILES.find(p => p.name === selectedProvider)?.supports_thinking
  const hideThinkingLevel = activeSupportsThinking === false

  const isSending = isSendingForSession

  // PERFORMANCE: Content selectors use deferredSessionId to prevent sync re-render cascade
  // When switching tabs, these selectors return stable values until React catches up
  // This prevents the ~1 second freeze from 15+ selectors re-evaluating simultaneously
  // IMPORTANT: Use stable empty array constants to prevent infinite render loops
  const streamingContent = useChatStore(state =>
    deferredSessionId ? (state.streamingContents[deferredSessionId] ?? '') : ''
  )
  const currentToolCalls = useChatStore(state =>
    deferredSessionId
      ? (state.activeToolCalls[deferredSessionId] ?? EMPTY_TOOL_CALLS)
      : EMPTY_TOOL_CALLS
  )
  const currentStreamingContentBlocks = useChatStore(state =>
    deferredSessionId
      ? (state.streamingContentBlocks[deferredSessionId] ??
        EMPTY_CONTENT_BLOCKS)
      : EMPTY_CONTENT_BLOCKS
  )
  // Per-session input - check if there's any input for submit button state
  // PERFORMANCE: Track hasValue via callback from ChatInput instead of store subscription
  // ChatInput notifies on mount, session change, and empty/non-empty boundary changes
  const [hasInputValue, setHasInputValue] = useState(false)
  // Per-session execution mode (defaults to 'plan' for new sessions)
  // Uses deferredSessionId for display consistency with other content
  const executionMode = useChatStore(state =>
    deferredSessionId
      ? (state.executionModes[deferredSessionId] ?? 'plan')
      : 'plan'
  )
  // Executing mode - the mode the currently-running prompt was sent with
  // Uses activeSessionId for immediate status feedback (not deferred)
  const executingMode = useChatStore(state =>
    activeSessionId ? state.executingModes[activeSessionId] : undefined
  )
  // Streaming execution mode - uses executing mode when sending, otherwise selected mode
  const streamingExecutionMode = executingMode ?? executionMode
  // Per-session error state (uses deferredSessionId for content consistency)
  const currentError = useChatStore(state =>
    deferredSessionId ? (state.errors[deferredSessionId] ?? null) : null
  )
  // Per-worktree setup script result (stays at worktree level)
  const setupScriptResult = useChatStore(state =>
    activeWorktreeId ? state.setupScriptResults[activeWorktreeId] : undefined
  )
  // PERFORMANCE: Input-related selectors use activeSessionId for immediate feedback
  // When user switches tabs, attachments should reflect the NEW session immediately
  const currentPendingImages = useChatStore(state =>
    activeSessionId
      ? (state.pendingImages[activeSessionId] ?? EMPTY_PENDING_IMAGES)
      : EMPTY_PENDING_IMAGES
  )
  const currentPendingTextFiles = useChatStore(state =>
    activeSessionId
      ? (state.pendingTextFiles[activeSessionId] ?? EMPTY_PENDING_TEXT_FILES)
      : EMPTY_PENDING_TEXT_FILES
  )
  const currentPendingFiles = useChatStore(state =>
    activeSessionId
      ? (state.pendingFiles[activeSessionId] ?? EMPTY_PENDING_FILES)
      : EMPTY_PENDING_FILES
  )
  const currentPendingSkills = useChatStore(state =>
    activeSessionId
      ? (state.pendingSkills[activeSessionId] ?? EMPTY_PENDING_SKILLS)
      : EMPTY_PENDING_SKILLS
  )
  // PERFORMANCE: Only subscribe to existence/count for toolbar button state
  // This prevents toolbar re-renders when file contents change
  const hasPendingAttachments = useChatStore(state => {
    if (!activeSessionId) return false
    const images = state.pendingImages[activeSessionId]
    const textFiles = state.pendingTextFiles[activeSessionId]
    const files = state.pendingFiles[activeSessionId]
    const skills = state.pendingSkills[activeSessionId]
    return (
      (images?.length ?? 0) > 0 ||
      (textFiles?.length ?? 0) > 0 ||
      (files?.length ?? 0) > 0 ||
      (skills?.length ?? 0) > 0
    )
  })
  // Per-session message queue (uses deferredSessionId for content consistency)
  const currentQueuedMessages = useChatStore(state =>
    deferredSessionId
      ? (state.messageQueues[deferredSessionId] ?? EMPTY_QUEUED_MESSAGES)
      : EMPTY_QUEUED_MESSAGES
  )
  // Per-session pending permission denials (uses deferredSessionId for content consistency)
  const pendingDenials = useChatStore(state =>
    deferredSessionId
      ? (state.pendingPermissionDenials[deferredSessionId] ??
        EMPTY_PERMISSION_DENIALS)
      : EMPTY_PERMISSION_DENIALS
  )

  // PERFORMANCE: Pre-compute last assistant message to avoid rescanning in multiple memos
  // This reference only changes when the actual last assistant message changes
  const lastAssistantMessage = useMemo(() => {
    const messages = session?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        return messages[i]
      }
    }
    return undefined
  }, [session?.messages])

  // Check if there are pending (unanswered) questions
  // Look at the last assistant message's tool_calls since streaming tool calls
  // are cleared when the response completes (chat:done calls clearToolCalls)
  // Note: Uses answeredQuestions data directly (not the getter function) to ensure
  // re-render when persisted state is restored by useUIStatePersistence
  const hasPendingQuestions = useMemo(() => {
    if (!activeSessionId || isSending) return false
    if (!lastAssistantMessage?.tool_calls) return false

    return lastAssistantMessage.tool_calls.some(
      tc => isAskUserQuestion(tc) && !answeredQuestions?.has(tc.id)
    )
  }, [activeSessionId, lastAssistantMessage, isSending, answeredQuestions])

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const virtualizedListRef = useRef<VirtualizedMessageListHandle>(null)

  // PERFORMANCE: Refs for session/worktree IDs and settings to avoid recreating callbacks when session changes
  // This enables stable callback references that read current values from refs
  const activeSessionIdRef = useRef(activeSessionId)
  const activeWorktreeIdRef = useRef(activeWorktreeId)
  const activeWorktreePathRef = useRef(activeWorktreePath)
  const selectedModelRef = useRef(selectedModel)
  const selectedProviderRef = useRef(selectedProvider)
  const selectedThinkingLevelRef = useRef(selectedThinkingLevel)
  const selectedEffortLevelRef = useRef(selectedEffortLevel)
  const useAdaptiveThinkingRef = useRef(useAdaptiveThinkingFlag)
  const executionModeRef = useRef(executionMode)
  const enabledMcpServersRef = useRef(enabledMcpServers)
  const mcpServersDataRef = useRef<McpServerInfo[]>(availableMcpServers)

  // Keep refs in sync with current values (runs on every render, but cheap)
  activeSessionIdRef.current = activeSessionId
  activeWorktreeIdRef.current = activeWorktreeId
  activeWorktreePathRef.current = activeWorktreePath
  selectedModelRef.current = selectedModel
  selectedProviderRef.current = selectedProvider
  selectedThinkingLevelRef.current = selectedThinkingLevel
  selectedEffortLevelRef.current = selectedEffortLevel
  useAdaptiveThinkingRef.current = useAdaptiveThinkingFlag
  executionModeRef.current = executionMode
  enabledMcpServersRef.current = enabledMcpServers
  mcpServersDataRef.current = availableMcpServers

  // Stable callback for useMessageHandlers to build MCP config from current refs
  const getMcpConfig = useCallback(
    () =>
      buildMcpConfigJson(
        mcpServersDataRef.current,
        enabledMcpServersRef.current
      ),
    []
  )

  // Ref for approve button (passed to VirtualizedMessageList)
  const approveButtonRef = useRef<HTMLButtonElement>(null)

  // Terminal panel ref for imperative collapse/expand
  const terminalPanelRef = useRef<ImperativePanelHandle>(null)
  // Review sidebar panel ref for imperative collapse/expand
  const reviewPanelRef = useRef<ImperativePanelHandle>(null)

  // Scroll management hook - handles scroll state and callbacks
  const {
    scrollViewportRef,
    isAtBottom,
    areFindingsVisible,
    scrollToBottom,
    scrollToFindings,
    handleScroll,
    handleScrollToBottomHandled,
  } = useScrollManagement({
    messages: session?.messages,
    virtualizedListRef,
  })

  // Drag and drop images into chat input
  const { isDragging } = useDragAndDropImages(activeSessionId)

  // State for file content modal (opened by clicking filenames in tool calls)
  const [viewingFilePath, setViewingFilePath] = useState<string | null>(null)

  // State for git diff modal (opened by clicking diff stats)
  const [diffRequest, setDiffRequest] = useState<DiffRequest | null>(null)

  // State for single file diff modal (opened by clicking edited file badges)
  const [editedFilePath, setEditedFilePath] = useState<string | null>(null)

  // Track which message's todos were dismissed (by message ID)
  // Special value '__streaming__' means dismissed during streaming (before message ID assigned)
  const [dismissedTodoMessageId, setDismissedTodoMessageId] = useState<
    string | null
  >(null)

  // Get active todos - from streaming tool calls OR last assistant message
  // Returns todos, source message ID for tracking dismissals, and whether from active streaming
  // isFromStreaming distinguishes actual streaming todos from historical fallback during the gap
  // when isSending=true but currentToolCalls is empty (after clearToolCalls, before first TodoWrite)
  const {
    todos: activeTodos,
    sourceMessageId: todoSourceMessageId,
    isFromStreaming,
  } = useMemo(() => {
    if (!activeSessionId)
      return { todos: [], sourceMessageId: null, isFromStreaming: false }

    // During streaming: extract from currentToolCalls (no message ID yet)
    // Iterate backwards without copying array
    if (isSending && currentToolCalls.length > 0) {
      for (let i = currentToolCalls.length - 1; i >= 0; i--) {
        const tc = currentToolCalls[i]
        if (tc && isTodoWrite(tc)) {
          return {
            todos: tc.input.todos,
            sourceMessageId: null,
            isFromStreaming: true,
          }
        }
      }
    }

    // After streaming OR during gap: use pre-computed lastAssistantMessage
    // isFromStreaming=false ensures normalization even when isSending=true
    if (lastAssistantMessage?.tool_calls) {
      // Find last TodoWrite call (iterate backwards, no array copy)
      for (let i = lastAssistantMessage.tool_calls.length - 1; i >= 0; i--) {
        const tc = lastAssistantMessage.tool_calls[i]
        if (tc && isTodoWrite(tc)) {
          return {
            todos: tc.input.todos,
            sourceMessageId: lastAssistantMessage.id,
            isFromStreaming: false,
          }
        }
      }
    }

    return { todos: [], sourceMessageId: null, isFromStreaming: false }
  }, [activeSessionId, isSending, currentToolCalls, lastAssistantMessage])

  // Compute pending plan info for floating approve button
  // Returns the message that has an unapproved plan awaiting action, if any
  const pendingPlanMessage = useMemo(() => {
    const messages = session?.messages ?? []
    // Find the last message with ExitPlanMode
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (
        m &&
        m.role === 'assistant' &&
        m.tool_calls?.some(tc => isExitPlanMode(tc))
      ) {
        // Check if it's not approved and no follow-up user message
        // PERFORMANCE: Iterate directly instead of creating array slice
        let hasFollowUp = false
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j]?.role === 'user') {
            hasFollowUp = true
            break
          }
        }
        if (!m.plan_approved && !hasFollowUp) {
          return m
        }
        break // Only check the latest plan message
      }
    }
    return null
  }, [session?.messages])

  // Check if there's a streaming plan awaiting approval
  const hasStreamingPlan = useMemo(() => {
    if (!isSending || !activeSessionId) return false
    const hasExitPlanModeTool = currentToolCalls.some(isExitPlanMode)
    return hasExitPlanModeTool && !isStreamingPlanApproved(activeSessionId)
  }, [isSending, activeSessionId, currentToolCalls, isStreamingPlanApproved])

  // Find latest plan content from ExitPlanMode tool calls (primary source)
  const latestPlanContent = useMemo(() => {
    // Check streaming tool calls first
    const streamingPlan = findPlanContent(currentToolCalls)
    if (streamingPlan) return streamingPlan
    // Check persisted messages
    const msgs = session?.messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.tool_calls) {
        const content = findPlanContent(m.tool_calls)
        if (content) return content
      }
    }
    return null
  }, [session?.messages, currentToolCalls])

  // Find latest plan file path across all messages (fallback for old-style file-based plans)
  const latestPlanFilePath = useMemo(() => {
    const msgs = session?.messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.tool_calls) {
        const path = findPlanFilePath(m.tool_calls)
        if (path) return path
      }
    }
    return null
  }, [session?.messages])

  // Whether a plan is available (content preferred over file)
  const hasPlan = !!latestPlanContent || !!latestPlanFilePath

  // State for plan dialog
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false)
  const [planDialogContent, setPlanDialogContent] = useState<string | null>(
    null
  )

  // Manage dismissal state based on streaming and message ID changes
  useEffect(() => {
    // When streaming produces NEW todos, clear any previous dismissal
    if (isSending && activeTodos.length > 0 && todoSourceMessageId === null) {
      if (dismissedTodoMessageId !== '__streaming__') {
        queueMicrotask(() => setDismissedTodoMessageId(null))
      }
    }
    // When streaming ends and todos are dismissed, upgrade '__streaming__' to actual message ID
    if (
      !isSending &&
      todoSourceMessageId !== null &&
      dismissedTodoMessageId === '__streaming__'
    ) {
      queueMicrotask(() => setDismissedTodoMessageId(todoSourceMessageId))
    }
  }, [
    isSending,
    activeTodos.length,
    todoSourceMessageId,
    dismissedTodoMessageId,
  ])

  // Focus input on mount, when session changes, or when worktree changes
  useEffect(() => {
    inputRef.current?.focus()
  }, [activeSessionId, activeWorktreeId])

  // Scroll to bottom when switching worktrees (sidebar click doesn't change session, so auto-scroll doesn't trigger)
  useEffect(() => {
    scrollToBottom()
  }, [activeWorktreeId, scrollToBottom])

  // Auto-scroll to bottom when new messages arrive, streaming content updates, or sending starts
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom()
    }
  }, [
    session?.messages.length,
    streamingContent,
    currentStreamingContentBlocks.length,
    isSending,
    isAtBottom,
    scrollToBottom,
  ])

  // Listen for global focus request from keybinding (CMD+L by default)
  useEffect(() => {
    const handleFocusRequest = () => {
      inputRef.current?.focus()
    }

    window.addEventListener('focus-chat-input', handleFocusRequest)
    return () =>
      window.removeEventListener('focus-chat-input', handleFocusRequest)
  }, [])

  // Listen for global open-plan request from keybinding (p key)
  // Skip when on canvas view - CanvasGrid handles it there
  useEffect(() => {
    if (isViewingCanvasTab) return

    const handleOpenPlan = () => {
      if (latestPlanContent) {
        setPlanDialogContent(latestPlanContent)
        setIsPlanDialogOpen(true)
      } else if (latestPlanFilePath) {
        setIsPlanDialogOpen(true)
      }
    }

    window.addEventListener('open-plan', handleOpenPlan)
    return () => window.removeEventListener('open-plan', handleOpenPlan)
  }, [latestPlanContent, latestPlanFilePath, isViewingCanvasTab])

  // Listen for global create-new-session event from keybinding (CMD+T)
  // This needs to be in ChatWindow (not SessionTabBar) because SessionTabBar
  // may be hidden in canvas-only mode
  useEffect(() => {
    const handleCreateNewSession = () => {
      if (!activeWorktreeId || !activeWorktreePath) return
      createSession.mutate(
        { worktreeId: activeWorktreeId, worktreePath: activeWorktreePath },
        {
          onSuccess: session => {
            useChatStore
              .getState()
              .setActiveSession(activeWorktreeId, session.id)
            // When in a modal or canvas-only mode, notify parent to update modal session
            if (isModal || canvasOnlyMode) {
              window.dispatchEvent(
                new CustomEvent('open-session-modal', {
                  detail: { sessionId: session.id },
                })
              )
            }
          },
        }
      )
    }

    window.addEventListener('create-new-session', handleCreateNewSession)
    return () =>
      window.removeEventListener('create-new-session', handleCreateNewSession)
  }, [
    activeWorktreeId,
    activeWorktreePath,
    createSession,
    isModal,
    canvasOnlyMode,
  ])

  // Listen for cycle-execution-mode event from keybinding (SHIFT+TAB)
  useEffect(() => {
    if (!activeSessionId) return

    const handleCycleExecutionMode = () => {
      useChatStore.getState().cycleExecutionMode(activeSessionId)
    }

    window.addEventListener('cycle-execution-mode', handleCycleExecutionMode)
    return () =>
      window.removeEventListener(
        'cycle-execution-mode',
        handleCycleExecutionMode
      )
  }, [activeSessionId])

  // Listen for global git diff request from keybinding (CMD+G by default)
  useEffect(() => {
    const handleOpenGitDiff = () => {
      if (!activeWorktreePath) return

      setDiffRequest({
        type: 'uncommitted',
        worktreePath: activeWorktreePath,
        baseBranch: gitStatus?.base_branch ?? 'main',
      })
    }

    window.addEventListener('open-git-diff', handleOpenGitDiff)
    return () => window.removeEventListener('open-git-diff', handleOpenGitDiff)
  }, [activeWorktreePath, gitStatus?.base_branch])

  // Global Cmd+Option+Backspace (Mac) / Ctrl+Alt+Backspace (Windows/Linux) listener for cancellation
  // (works even when textarea is disabled)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key !== 'Backspace' ||
        !(e.metaKey || e.ctrlKey) ||
        !e.altKey
      ) return

      // Read all state fresh via getState() to avoid stale closures
      const state = useChatStore.getState()
      const wtId = state.activeWorktreeId
      if (!wtId) return

      const isCanvas = state.viewingCanvasTab[wtId] ?? true
      const canvasSession = state.canvasSelectedSessionIds[wtId] ?? null
      const activeSession = state.activeSessionIds[wtId] ?? null

      const sessionToCancel = isCanvas && canvasSession
        ? canvasSession
        : activeSession

      if (!sessionToCancel) return

      const isSendingTarget = state.sendingSessionIds[sessionToCancel] ?? false
      if (!isSendingTarget) return

      e.preventDefault()
      cancelChatMessage(sessionToCancel, wtId)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Note: Streaming event listeners are in App.tsx, not here
  // This ensures they stay active even when ChatWindow is unmounted (e.g., session board view)

  // Helper to resolve custom CLI profile name for the active provider
  const resolveCustomProfile = useCallback(
    (model: string, provider: string | null) => {
      if (!provider || provider === '__anthropic__')
        return { model, customProfileName: undefined }
      // Verify the provider exists in profiles
      const profile = preferences?.custom_cli_profiles?.find(
        p => p.name === provider
      )
      return {
        model,
        customProfileName: profile?.name,
      }
    },
    [preferences?.custom_cli_profiles]
  )

  // Helper to build full message with attachment references for backend
  const buildMessageWithRefs = useCallback(
    (queuedMsg: QueuedMessage): string => {
      let message = queuedMsg.message

      // Add file references (from @ mentions)
      if (queuedMsg.pendingFiles.length > 0) {
        const fileRefs = queuedMsg.pendingFiles
          .map(
            f =>
              `[File: ${f.relativePath} - Use the Read tool to view this file]`
          )
          .join('\n')
        message = message ? `${message}\n\n${fileRefs}` : fileRefs
      }

      // Add skill references (from / mentions)
      if (queuedMsg.pendingSkills.length > 0) {
        const skillRefs = queuedMsg.pendingSkills
          .map(
            s =>
              `[Skill: ${s.path} - Read and use this skill to guide your response]`
          )
          .join('\n')
        message = message ? `${message}\n\n${skillRefs}` : skillRefs
      }

      // Add image references
      if (queuedMsg.pendingImages.length > 0) {
        const imageRefs = queuedMsg.pendingImages
          .map(
            img =>
              `[Image attached: ${img.path} - Use the Read tool to view this image]`
          )
          .join('\n')
        message = message ? `${message}\n\n${imageRefs}` : imageRefs
      }

      // Add text file references
      if (queuedMsg.pendingTextFiles.length > 0) {
        const textFileRefs = queuedMsg.pendingTextFiles
          .map(
            tf =>
              `[Text file attached: ${tf.path} - Use the Read tool to view this file]`
          )
          .join('\n')
        message = message ? `${message}\n\n${textFileRefs}` : textFileRefs
      }

      return message
    },
    []
  )

  // Helper to send a queued message immediately
  const sendMessageNow = useCallback(
    (queuedMsg: QueuedMessage) => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      const {
        addSendingSession,
        setLastSentMessage,
        setError,
        setExecutingMode,
        setSelectedModel,
        getApprovedTools,
        clearStreamingContent,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()

      // Clear any stale streaming state from previous message before starting new one
      // This prevents content from previous messages appearing in the new streaming response
      // when queued messages execute (React may batch state updates causing StreamingMessage
      // to never unmount between messages)
      clearStreamingContent(activeSessionId)
      clearToolCalls(activeSessionId)
      clearStreamingContentBlocks(activeSessionId)

      // Display only the user's text (without refs) in the chat
      setLastSentMessage(activeSessionId, queuedMsg.message)
      setError(activeSessionId, null)
      addSendingSession(activeSessionId)
      // Invalidate sessions list so canvas cards pick up running state
      // even if Zustand re-render is deferred during dialog close
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(activeWorktreeId),
      })
      // Capture the execution mode this message is being sent with
      setExecutingMode(activeSessionId, queuedMsg.executionMode)
      // Track the model being used for this session (needed for permission approval flow)
      setSelectedModel(activeSessionId, queuedMsg.model)

      // Get session-approved tools to include
      const sessionApprovedTools = getApprovedTools(activeSessionId)

      // Build allowed tools (git always; WebFetch/WebSearch injected by backend based on prefs + mode)
      const allowedTools =
        sessionApprovedTools.length > 0
          ? [...GIT_ALLOWED_TOOLS, ...sessionApprovedTools]
          : undefined

      // Build full message with attachment refs for backend
      const fullMessage = buildMessageWithRefs(queuedMsg)

      // Resolve custom CLI profile if provider is set
      const resolved = resolveCustomProfile(queuedMsg.model, queuedMsg.provider)

      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message: fullMessage,
          model: resolved.model,
          executionMode: queuedMsg.executionMode,
          thinkingLevel: queuedMsg.thinkingLevel,
          disableThinkingForMode: queuedMsg.disableThinkingForMode,
          effortLevel: queuedMsg.effortLevel,
          mcpConfig: queuedMsg.mcpConfig,
          customProfileName: resolved.customProfileName,
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
          allowedTools,
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      buildMessageWithRefs,
      sendMessage,
      queryClient,
      preferences?.parallel_execution_prompt_enabled,
      preferences?.chrome_enabled,
      preferences?.ai_language,
      preferences?.allow_web_tools_in_plan_mode,
    ]
  )

  // GitDiffModal handlers - extracted for performance (prevents child re-renders)
  const handleGitDiffAddToPrompt = useCallback(
    (reference: string) => {
      if (activeSessionId) {
        const { inputDrafts } = useChatStore.getState()
        const currentInput = inputDrafts[activeSessionId] ?? ''
        const separator = currentInput.length > 0 ? '\n' : ''
        setInputDraft(
          activeSessionId,
          `${currentInput}${separator}${reference}`
        )
      }
    },
    [activeSessionId, setInputDraft]
  )

  const handleGitDiffExecutePrompt = useCallback(
    (reference: string) => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      const {
        inputDrafts,
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        clearInputDraft,
      } = useChatStore.getState()
      const currentInput = inputDrafts[activeSessionId] ?? ''
      const separator = currentInput.length > 0 ? '\n' : ''
      const message = `${currentInput}${separator}${reference}`

      // Use refs for model/thinking level to get current values and avoid stale closures
      const model = selectedModelRef.current
      const thinkingLevel = selectedThinkingLevelRef.current

      // Clear input and send immediately
      setLastSentMessage(activeSessionId, message)
      setError(activeSessionId, null)
      clearInputDraft(activeSessionId)
      addSendingSession(activeSessionId)
      setSelectedModel(activeSessionId, model)
      setExecutingMode(activeSessionId, 'build')

      const hasManualOverride = useChatStore
        .getState()
        .hasManualThinkingOverride(activeSessionId)
      const diffResolved = resolveCustomProfile(model, selectedProviderRef.current)
      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message,
          model: diffResolved.model,
          customProfileName: diffResolved.customProfileName,
          executionMode: 'build',
          thinkingLevel,
          disableThinkingForMode: thinkingLevel !== 'off' && !hasManualOverride,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: buildMcpConfigJson(
            mcpServersDataRef.current,
            enabledMcpServersRef.current
          ),
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
        },
        { onSettled: () => inputRef.current?.focus() }
      )
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      preferences,
      sendMessage,
    ]
  )

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()

      // Get input value from store state to avoid stale closure
      const {
        inputDrafts,
        getPendingImages,
        clearPendingImages,
        getPendingFiles,
        clearPendingFiles,
        getPendingTextFiles,
        clearPendingTextFiles,
        getPendingSkills,
        clearPendingSkills,
        enqueueMessage,
        isSending: checkIsSendingNow,
        setSessionReviewing,
      } = useChatStore.getState()
      const textMessage = (inputDrafts[activeSessionId ?? ''] ?? '').trim()
      const images = getPendingImages(activeSessionId ?? '')
      const files = getPendingFiles(activeSessionId ?? '')
      const skills = getPendingSkills(activeSessionId ?? '')
      const textFiles = getPendingTextFiles(activeSessionId ?? '')

      // Need either text, images, files, text files, or skills to send
      if (
        !textMessage &&
        images.length === 0 &&
        files.length === 0 &&
        textFiles.length === 0 &&
        skills.length === 0
      )
        return
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      // Verify session exists in loaded data before sending
      if (
        sessionsData &&
        !sessionsData.sessions.some(s => s.id === activeSessionId)
      ) {
        toast.error(
          'Session not found. Please refresh or create a new session.'
        )
        return
      }

      // Build message with image, file, and text file references
      // Store just the user's text - attachment refs are added when sending to backend
      const message = textMessage

      // Clear input and pending attachments immediately
      clearInputDraft(activeSessionId)
      clearPendingImages(activeSessionId)
      clearPendingFiles(activeSessionId)
      clearPendingSkills(activeSessionId)
      clearPendingTextFiles(activeSessionId)
      setSessionReviewing(activeSessionId, false)
      useChatStore.getState().clearPendingDigest(activeSessionId)

      // Clear question skip state so new questions can be shown
      // Clear waiting state so tab shows "planning" instead of "waiting" when extending a plan
      const { setQuestionsSkipped, setWaitingForInput } =
        useChatStore.getState()
      setQuestionsSkipped(activeSessionId, false)
      setWaitingForInput(activeSessionId, false)

      // Create queued message object with current settings
      // Use refs to avoid recreating callback when these settings change
      const mode = executionModeRef.current
      const thinkingLvl = selectedThinkingLevelRef.current
      const hasManualOverride = useChatStore
        .getState()
        .hasManualThinkingOverride(activeSessionId)
      const queuedMessage: QueuedMessage = {
        id: generateId(),
        message,
        pendingImages: images,
        pendingFiles: files,
        pendingSkills: skills,
        pendingTextFiles: textFiles,
        model: selectedModelRef.current,
        provider: selectedProviderRef.current,
        executionMode: mode,
        thinkingLevel: thinkingLvl,
        disableThinkingForMode:
          mode !== 'plan' && thinkingLvl !== 'off' && !hasManualOverride,
        effortLevel: useAdaptiveThinkingRef.current
          ? selectedEffortLevelRef.current
          : undefined,
        mcpConfig: buildMcpConfigJson(
          mcpServersDataRef.current,
          enabledMcpServersRef.current
        ),
        queuedAt: Date.now(),
      }

      // If currently sending, add to queue instead
      if (checkIsSendingNow(activeSessionId)) {
        enqueueMessage(activeSessionId, queuedMessage)
        return
      }

      // Otherwise, send immediately
      sendMessageNow(queuedMessage)
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      clearInputDraft,
      sendMessageNow,
      sessionsData,
    ]
  )

  // Note: Queue processing moved to useQueueProcessor hook in App.tsx
  // This ensures queued messages execute even when the worktree is unfocused

  // Git operations hook - handles commit, PR, review, merge operations
  const {
    handleCommit,
    handleCommitAndPush,
    handlePull,
    handlePush,
    handleOpenPr,
    handleReview,
    handleMerge,
    handleResolveConflicts,
    handleResolvePrConflicts,
    executeMerge,
    showMergeDialog,
    setShowMergeDialog,
  } = useGitOperations({
    activeWorktreeId,
    activeSessionId,
    activeWorktreePath,
    worktree,
    project,
    queryClient,
    inputRef,
    preferences,
  })

  // Keyboard shortcuts for merge dialog
  useEffect(() => {
    if (!showMergeDialog) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (key === 'p') {
        e.preventDefault()
        executeMerge('merge')
      } else if (key === 's') {
        e.preventDefault()
        executeMerge('squash')
      } else if (key === 'r') {
        e.preventDefault()
        executeMerge('rebase')
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showMergeDialog, executeMerge])

  // Context operations hook - handles save/load context
  const {
    handleLoadContext,
    handleSaveContext,
    loadContextModalOpen,
    setLoadContextModalOpen,
  } = useContextOperations({
    activeSessionId,
    activeWorktreeId,
    activeWorktreePath,
    worktree,
    queryClient,
    preferences,
  })

  // PERFORMANCE: Stable callbacks for ChatToolbar to prevent re-renders
  const handleToolbarModelChange = useCallback(
    (model: string) => {
      if (activeSessionId && activeWorktreeId && activeWorktreePath) {
        setSessionModel.mutate({
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          model,
        })
        // Broadcast to other clients (fire-and-forget)
        invoke('broadcast_session_setting', {
          sessionId: activeSessionId,
          key: 'model',
          value: model,
        }).catch(() => {
          /* noop */
        })
      }
    },
    [activeSessionId, activeWorktreeId, activeWorktreePath, setSessionModel]
  )

  const handleToolbarProviderChange = useCallback(
    (provider: string | null) => {
      if (activeSessionId) {
        useChatStore.getState().setSelectedProvider(activeSessionId, provider)
        if (activeWorktreeId && activeWorktreePath) {
          setSessionProvider.mutate({
            sessionId: activeSessionId,
            worktreeId: activeWorktreeId,
            worktreePath: activeWorktreePath,
            provider,
          })
        }
      }
    },
    [activeSessionId, activeWorktreeId, activeWorktreePath, setSessionProvider]
  )

  // PERFORMANCE: Use refs to keep callback stable, get store actions via getState()
  const handleToolbarThinkingLevelChange = useCallback(
    (level: ThinkingLevel) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      const store = useChatStore.getState()

      // Update Zustand store immediately for responsive UI
      store.setThinkingLevel(sessionId, level)

      // Mark as manually overridden if in build/yolo mode
      const currentMode = store.getExecutionMode(sessionId)
      if (currentMode !== 'plan') {
        store.setManualThinkingOverride(sessionId, true)
      }

      // Persist to backend (fire-and-forget, don't block UI)
      setSessionThinkingLevel.mutate({
        sessionId,
        worktreeId,
        worktreePath,
        thinkingLevel: level,
      })
      // Broadcast to other clients (fire-and-forget)
      invoke('broadcast_session_setting', {
        sessionId,
        key: 'thinkingLevel',
        value: level,
      }).catch(() => {
        /* noop */
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutate is stable, refs used for IDs
    []
  )

  const handleToolbarEffortLevelChange = useCallback((level: EffortLevel) => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    const store = useChatStore.getState()
    store.setEffortLevel(sessionId, level)

    // Mark as manually overridden if in build/yolo mode
    const currentMode = store.getExecutionMode(sessionId)
    if (currentMode !== 'plan') {
      store.setManualThinkingOverride(sessionId, true)
    }
  }, [])

  const handleToggleMcpServer = useCallback((serverName: string) => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    useChatStore.getState().toggleMcpServer(sessionId, serverName)
  }, [])

  const handleOpenProjectSettings = useCallback(() => {
    if (!worktree?.project_id) return
    useProjectsStore.getState().openProjectSettings(worktree.project_id)
  }, [worktree?.project_id])

  const handleToolbarSetExecutionMode = useCallback(
    (mode: ExecutionMode) => {
      if (activeSessionId) {
        setExecutionMode(activeSessionId, mode)
        // Broadcast to other clients (fire-and-forget)
        invoke('broadcast_session_setting', {
          sessionId: activeSessionId,
          key: 'executionMode',
          value: mode,
        }).catch(() => {
          /* noop */
        })
      }
    },
    [activeSessionId, setExecutionMode]
  )

  const handleOpenMagicModal = useCallback(() => {
    useUIStore.getState().setMagicModalOpen(true)
  }, [])

  // Wraps modal open/close for load context
  const handleLoadContextModalChange = useCallback(
    (open: boolean) => {
      setLoadContextModalOpen(open)
    },
    [setLoadContextModalOpen]
  )

  // Handle investigate workflow run - sends investigation prompt for a failed GitHub Actions run
  const handleInvestigate = useCallback(
    async (type: 'issue' | 'pr') => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      const modelKey = type === 'issue' ? 'investigate_issue_model' : 'investigate_pr_model'
      const providerKey = type === 'issue' ? 'investigate_issue_provider' : 'investigate_pr_provider'
      const investigateModel =
        preferences?.magic_prompt_models?.[modelKey] ??
        selectedModelRef.current
      const investigateProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        providerKey,
        preferences?.default_provider
      )
      const { customProfileName: resolvedInvestigateProfile } =
        resolveCustomProfile(investigateModel, investigateProvider)

      let prompt: string

      if (type === 'issue') {
        // Query by worktree ID — during auto-investigate, contexts are registered
        // under worktree ID (not session ID) by the backend create_worktree command
        const contexts = await queryClient.fetchQuery({
          queryKey: ['investigate-contexts', 'issue', activeWorktreeId],
          queryFn: () =>
            invoke<{ number: number }[]>('list_loaded_issue_contexts', {
              sessionId: activeWorktreeId,
            }),
          staleTime: 0,
        })
        const refs = (contexts ?? []).map(c => `#${c.number}`).join(', ')
        const word = (contexts ?? []).length === 1 ? 'issue' : 'issues'
        const customPrompt = preferences?.magic_prompts?.investigate_issue
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_ISSUE_PROMPT
        prompt = template
          .replace(/\{issueWord\}/g, word)
          .replace(/\{issueRefs\}/g, refs)
      } else {
        const contexts = await queryClient.fetchQuery({
          queryKey: ['investigate-contexts', 'pr', activeWorktreeId],
          queryFn: () =>
            invoke<{ number: number }[]>('list_loaded_pr_contexts', {
              sessionId: activeWorktreeId,
            }),
          staleTime: 0,
        })
        const refs = (contexts ?? []).map(c => `#${c.number}`).join(', ')
        const word = (contexts ?? []).length === 1 ? 'PR' : 'PRs'
        const customPrompt = preferences?.magic_prompts?.investigate_pr
        const template =
          customPrompt && customPrompt.trim()
            ? customPrompt
            : DEFAULT_INVESTIGATE_PR_PROMPT
        prompt = template
          .replace(/\{prWord\}/g, word)
          .replace(/\{prRefs\}/g, refs)
      }

      const {
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setSelectedProvider,
        setExecutingMode,
      } = useChatStore.getState()

      setLastSentMessage(activeSessionId, prompt)
      setError(activeSessionId, null)
      addSendingSession(activeSessionId)
      setSelectedModel(activeSessionId, investigateModel)
      setSelectedProvider(activeSessionId, investigateProvider)
      setExecutingMode(activeSessionId, executionModeRef.current)

      // Persist the provider to backend so subsequent messages use the same one
      setSessionProvider.mutate({
        sessionId: activeSessionId,
        worktreeId: activeWorktreeId,
        worktreePath: activeWorktreePath,
        provider: investigateProvider,
      })

      // Compute adaptive thinking for the resolved provider (not the stale ref)
      const investigateIsCustom = Boolean(investigateProvider && investigateProvider !== '__anthropic__')
      const investigateUseAdaptive = !investigateIsCustom && supportsAdaptiveThinking(
        investigateModel, cliStatus?.version ?? null
      )

      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message: prompt,
          model: investigateModel,
          executionMode: executionModeRef.current,
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: investigateUseAdaptive
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: buildMcpConfigJson(
            mcpServersDataRef.current,
            enabledMcpServersRef.current
          ),
          customProfileName: resolvedInvestigateProfile,
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
        },
        { onSettled: () => inputRef.current?.focus() }
      )
    },
    [
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      sendMessage,
      queryClient,
      preferences?.magic_prompts?.investigate_issue,
      preferences?.magic_prompts?.investigate_pr,
      preferences?.magic_prompt_models?.investigate_issue_model,
      preferences?.magic_prompt_models?.investigate_pr_model,
      preferences?.magic_prompt_providers?.investigate_issue_provider,
      preferences?.magic_prompt_providers?.investigate_pr_provider,
      preferences?.default_provider,
      preferences?.parallel_execution_prompt_enabled,
      preferences?.chrome_enabled,
      preferences?.ai_language,
      setSessionProvider,
      resolveCustomProfile,
      cliStatus?.version,
    ]
  )

  const handleInvestigateWorkflowRun = useCallback(
    async (detail: WorkflowRunDetail) => {
      const customPrompt = preferences?.magic_prompts?.investigate_workflow_run
      const template =
        customPrompt && customPrompt.trim()
          ? customPrompt
          : DEFAULT_INVESTIGATE_WORKFLOW_RUN_PROMPT

      const prompt = template
        .replace(/\{workflowName\}/g, detail.workflowName)
        .replace(/\{runUrl\}/g, detail.runUrl)
        .replace(/\{runId\}/g, detail.runId)
        .replace(/\{branch\}/g, detail.branch)
        .replace(/\{displayTitle\}/g, detail.displayTitle)

      const investigateModel =
        preferences?.magic_prompt_models?.investigate_workflow_run_model ??
        selectedModelRef.current
      const investigateProvider = resolveMagicPromptProvider(
        preferences?.magic_prompt_providers,
        'investigate_workflow_run_provider',
        preferences?.default_provider
      )
      const { customProfileName: resolvedInvestigateProfile } =
        resolveCustomProfile(investigateModel, investigateProvider)

      // Find the right worktree for this branch
      let targetWorktreeId: string | null = null
      let targetWorktreePath: string | null = null

      if (detail.projectPath) {
        // Use fetchQuery to ensure data is loaded (not just cached)
        const projects = await queryClient.fetchQuery({
          queryKey: projectsQueryKeys.list(),
          queryFn: () => invoke<Project[]>('list_projects'),
          staleTime: 1000 * 60,
        })
        const project = projects?.find(p => p.path === detail.projectPath)

        if (project) {
          let worktrees: Worktree[] = []
          try {
            worktrees = await queryClient.fetchQuery({
              queryKey: projectsQueryKeys.worktrees(project.id),
              queryFn: () =>
                invoke<Worktree[]>('list_worktrees', {
                  projectId: project.id,
                }),
              staleTime: 1000 * 60,
            })
          } catch (err) {
            console.error('[INVESTIGATE-WF] Failed to fetch worktrees:', err)
          }

          // status is optional — undefined or 'ready' both mean usable
          const isUsable = (w: Worktree) => !w.status || w.status === 'ready'

          if (worktrees.length > 0) {
            // Find worktree matching the run's branch
            const matching = worktrees.find(
              w => w.branch === detail.branch && isUsable(w)
            )
            if (matching) {
              targetWorktreeId = matching.id
              targetWorktreePath = matching.path
            } else {
              // Fall back to the base worktree (first usable one)
              const base = worktrees.find(w => isUsable(w))
              if (base) {
                targetWorktreeId = base.id
                targetWorktreePath = base.path
              }
            }
          }

          // No usable worktrees — create the base session first
          if (!targetWorktreeId) {
            try {
              const baseSession = await invoke<Worktree>(
                'create_base_session',
                { projectId: project.id }
              )
              queryClient.invalidateQueries({
                queryKey: projectsQueryKeys.worktrees(project.id),
              })
              targetWorktreeId = baseSession.id
              targetWorktreePath = baseSession.path
            } catch (error) {
              console.error(
                '[INVESTIGATE-WF] Failed to create base session:',
                error
              )
              toast.error(`Failed to open base session: ${error}`)
              return
            }
          }
        }
      }

      // Final fallback: use active worktree
      if (!targetWorktreeId || !targetWorktreePath) {
        targetWorktreeId = activeWorktreeIdRef.current
        targetWorktreePath = activeWorktreePathRef.current
      }

      if (!targetWorktreeId || !targetWorktreePath) {
        console.error('[INVESTIGATE-WF] No worktree found at all, aborting')
        toast.error('No worktree found for this branch')
        return
      }

      // Capture for closure stability
      const worktreeId = targetWorktreeId
      const worktreePath = targetWorktreePath

      // Compute adaptive thinking for the resolved provider (not the stale ref)
      const investigateIsCustom = Boolean(investigateProvider && investigateProvider !== '__anthropic__')
      const investigateUseAdaptive = !investigateIsCustom && supportsAdaptiveThinking(
        investigateModel, cliStatus?.version ?? null
      )

      const sendInvestigateMessage = (targetSessionId: string) => {
        const {
          addSendingSession,
          setLastSentMessage,
          setError,
          setSelectedModel,
          setSelectedProvider,
          setExecutingMode,
        } = useChatStore.getState()

        setLastSentMessage(targetSessionId, prompt)
        setError(targetSessionId, null)
        addSendingSession(targetSessionId)
        setSelectedModel(targetSessionId, investigateModel)
        setSelectedProvider(targetSessionId, investigateProvider)
        setExecutingMode(targetSessionId, executionModeRef.current)

        // Persist the provider to backend so subsequent messages use the same one
        setSessionProvider.mutate({
          sessionId: targetSessionId,
          worktreeId,
          worktreePath,
          provider: investigateProvider,
        })

        sendMessage.mutate(
          {
            sessionId: targetSessionId,
            worktreeId,
            worktreePath,
            message: prompt,
            model: investigateModel,
            executionMode: executionModeRef.current,
            thinkingLevel: selectedThinkingLevelRef.current,
            effortLevel: investigateUseAdaptive
              ? selectedEffortLevelRef.current
              : undefined,
            mcpConfig: buildMcpConfigJson(
              mcpServersDataRef.current,
              enabledMcpServersRef.current
            ),
            customProfileName: resolvedInvestigateProfile,
            parallelExecutionPrompt:
              preferences?.parallel_execution_prompt_enabled
                ? (preferences.magic_prompts?.parallel_execution ??
                  DEFAULT_PARALLEL_EXECUTION_PROMPT)
                : undefined,
            chromeEnabled: preferences?.chrome_enabled ?? false,
            aiLanguage: preferences?.ai_language,
          },
          { onSettled: () => inputRef.current?.focus() }
        )
      }

      // Switch to the target worktree, create a new session, then send the prompt
      const { setActiveWorktree, setActiveSession } = useChatStore.getState()
      const { selectWorktree, expandProject } = useProjectsStore.getState()
      setActiveWorktree(worktreeId, worktreePath)
      selectWorktree(worktreeId)

      // Expand the project in sidebar so user can see the worktree
      const projects = queryClient.getQueryData<Project[]>(
        projectsQueryKeys.list()
      )
      const project = projects?.find(p => p.path === detail.projectPath)
      if (project) expandProject(project.id)

      createSession.mutate(
        { worktreeId, worktreePath },
        {
          onSuccess: session => {
            setActiveSession(worktreeId, session.id)
            sendInvestigateMessage(session.id)
          },
          onError: error => {
            console.error('[INVESTIGATE-WF] Failed to create session:', error)
            toast.error(`Failed to create session: ${error}`)
          },
        }
      )
    },
    [
      sendMessage,
      createSession,
      queryClient,
      preferences?.magic_prompts?.investigate_workflow_run,
      preferences?.magic_prompt_models?.investigate_workflow_run_model,
      preferences?.magic_prompt_providers?.investigate_workflow_run_provider,
      preferences?.default_provider,
      preferences?.parallel_execution_prompt_enabled,
      preferences?.chrome_enabled,
      preferences?.ai_language,
      setSessionProvider,
      resolveCustomProfile,
      cliStatus?.version,
    ]
  )

  // Listen for magic-command events from MagicModal
  // Pass isModal and isViewingCanvasTab to prevent duplicate listeners when modal is open over canvas
  useMagicCommands({
    handleSaveContext,
    handleLoadContext,
    handleCommit,
    handleCommitAndPush,
    handlePull,
    handlePush,
    handleOpenPr,
    handleReview,
    handleMerge,
    handleResolveConflicts,
    handleInvestigateWorkflowRun,
    handleInvestigate,
    isModal,
    isViewingCanvasTab,
    sessionModalOpen,
  })

  // Pick up pending investigate type from UI store (set by projects.ts when
  // worktree is created/unarchived with auto-investigate flag)
  useEffect(() => {
    if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return
    const type = useUIStore.getState().consumePendingInvestigateType()
    if (type) {
      handleInvestigate(type)
    }
  }, [activeSessionId, activeWorktreeId, activeWorktreePath, handleInvestigate])

  // Listen for command palette context events
  useEffect(() => {
    const handleSaveContextEvent = () => handleSaveContext()
    const handleLoadContextEvent = () => handleLoadContext()
    const handleRunScriptEvent = () => {
      if (!isServerApp() || !activeWorktreeId || !runScript) return
      useTerminalStore.getState().startRun(activeWorktreeId, runScript)
    }

    window.addEventListener('command:save-context', handleSaveContextEvent)
    window.addEventListener('command:load-context', handleLoadContextEvent)
    window.addEventListener('command:run-script', handleRunScriptEvent)
    return () => {
      window.removeEventListener('command:save-context', handleSaveContextEvent)
      window.removeEventListener('command:load-context', handleLoadContextEvent)
      window.removeEventListener('command:run-script', handleRunScriptEvent)
    }
  }, [handleSaveContext, handleLoadContext, activeWorktreeId, runScript])

  // Listen for toggle-debug-mode command
  useEffect(() => {
    const handleToggleDebugMode = () => {
      if (!preferences) return
      savePreferences.mutate({
        ...preferences,
        debug_mode_enabled: !preferences.debug_mode_enabled,
      })
    }

    window.addEventListener('command:toggle-debug-mode', handleToggleDebugMode)
    return () => {
      window.removeEventListener(
        'command:toggle-debug-mode',
        handleToggleDebugMode
      )
    }
  }, [preferences, savePreferences])

  // Listen for set-chat-input events (used by conflict resolution flow)
  useEffect(() => {
    const handleSetChatInput = (e: CustomEvent<{ text: string }>) => {
      const { text } = e.detail
      const sessionId = activeSessionIdRef.current
      if (sessionId && text) {
        const { setInputDraft } = useChatStore.getState()
        setInputDraft(sessionId, text)
        // Focus the input
        inputRef.current?.focus()
      }
    }

    window.addEventListener(
      'set-chat-input',
      handleSetChatInput as EventListener
    )
    return () =>
      window.removeEventListener(
        'set-chat-input',
        handleSetChatInput as EventListener
      )
  }, [])

  // Message handlers hook - handles questions, plan approval, permission approval, finding fixes
  const {
    handleQuestionAnswer,
    handleSkipQuestion,
    handlePlanApproval,
    handlePlanApprovalYolo,
    handleStreamingPlanApproval,
    handleStreamingPlanApprovalYolo,
    handlePendingPlanApprovalCallback,
    handlePermissionApproval,
    handlePermissionApprovalYolo,
    handlePermissionDeny,
    handleFixFinding,
    handleFixAllFindings,
  } = useMessageHandlers({
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    selectedModelRef,
    getCustomProfileName: () => {
      return selectedProviderRef.current ?? undefined
    },
    executionModeRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    getMcpConfig,
    sendMessage,
    queryClient,
    scrollToBottom,
    inputRef,
    pendingPlanMessage,
  })

  // Copy a sent user message to the clipboard with attachment metadata
  // When pasted back, ChatInput detects the custom format and restores attachments
  const handleCopyToInput = useCallback(async (message: ChatMessage) => {
    // Extract clean text (without attachment markers)
    const cleanText = stripAllMarkers(message.content)

    // Extract attachment paths from the raw message content
    const imagePaths = extractImagePaths(message.content)
    const textFilePaths = extractTextFilePaths(message.content)
    const fileMentionPaths = extractFileMentionPaths(message.content)
    const skillPaths = extractSkillPaths(message.content)

    // Build metadata for skill names
    const skills = skillPaths.map(path => {
      const parts = normalizePath(path).split('/')
      const skillsIdx = parts.findIndex(p => p === 'skills')
      const name =
        skillsIdx >= 0 && parts[skillsIdx + 1]
          ? (parts[skillsIdx + 1] ?? getFilename(path))
          : getFilename(path)
      return { name, path }
    })

    // Build JSON metadata for attachments
    const metadata = JSON.stringify({
      images: imagePaths,
      textFiles: textFilePaths,
      files: fileMentionPaths,
      skills,
    })

    // Write to clipboard: plain text + HTML with embedded metadata
    // The HTML contains a hidden span with JSON so ChatInput can detect it on paste
    const htmlContent = `<span data-jean-prompt="${encodeURIComponent(metadata)}">${cleanText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([cleanText], { type: 'text/plain' }),
          'text/html': new Blob([htmlContent], { type: 'text/html' }),
        }),
      ])
      toast.success('Prompt copied')
    } catch {
      // Fallback to plain text
      await navigator.clipboard.writeText(cleanText)
      toast.success('Text copied (without attachments)')
    }
  }, [])

  // Listen for approve-plan keyboard shortcut event
  // Skip when on canvas view (non-modal) - CanvasGrid handles it there
  useEffect(() => {
    if (!isModal && isViewingCanvasTab) return

    const handleApprovePlanEvent = () => {
      // Check if we have a streaming plan to approve
      if (hasStreamingPlan) {
        handleStreamingPlanApproval()
        return
      }
      // Check if we have a pending (non-streaming) plan to approve
      if (pendingPlanMessage) {
        handlePlanApproval(pendingPlanMessage.id)
      }
    }

    window.addEventListener('approve-plan', handleApprovePlanEvent)
    return () =>
      window.removeEventListener('approve-plan', handleApprovePlanEvent)
  }, [
    isModal,
    isViewingCanvasTab,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingPlanApproval,
    handlePlanApproval,
  ])

  // Listen for approve-plan-yolo keyboard shortcut event
  // Skip when on canvas view (non-modal) - CanvasGrid handles it there
  useEffect(() => {
    if (!isModal && isViewingCanvasTab) return

    const handleApprovePlanYoloEvent = () => {
      // Check if we have a streaming plan to approve
      if (hasStreamingPlan) {
        handleStreamingPlanApprovalYolo()
        return
      }
      // Check if we have a pending (non-streaming) plan to approve
      if (pendingPlanMessage) {
        handlePlanApprovalYolo(pendingPlanMessage.id)
      }
    }

    window.addEventListener('approve-plan-yolo', handleApprovePlanYoloEvent)
    return () =>
      window.removeEventListener(
        'approve-plan-yolo',
        handleApprovePlanYoloEvent
      )
  }, [
    isModal,
    isViewingCanvasTab,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingPlanApprovalYolo,
    handlePlanApprovalYolo,
  ])

  // Listen for review-fix-message events from ReviewResultsPanel
  // Fix messages are sent in the same session (the review session)
  useEffect(() => {
    const handleReviewFixMessage = (e: CustomEvent) => {
      // Skip if this is the modal ChatWindow (the main window handles the event)
      if (isModal) return

      const { sessionId, worktreeId, worktreePath, message } = e.detail
      if (!sessionId || !worktreeId || !worktreePath || !message) return
      // Only handle events for this ChatWindow's worktree (avoids duplicate from modal)
      if (worktreeId !== activeWorktreeIdRef.current) return

      const {
        addSendingSession,
        setSelectedModel,
        setExecutingMode,
        setLastSentMessage,
        setError,
      } = useChatStore.getState()

      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, 'build')
      const thinkingLvl = selectedThinkingLevelRef.current
      const hasManualOverride = useChatStore
        .getState()
        .hasManualThinkingOverride(sessionId)
      const fixResolved = resolveCustomProfile(selectedModelRef.current, selectedProviderRef.current)
      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: fixResolved.model,
          customProfileName: fixResolved.customProfileName,
          executionMode: 'build',
          thinkingLevel: thinkingLvl,
          disableThinkingForMode: thinkingLvl !== 'off' && !hasManualOverride,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: buildMcpConfigJson(
            mcpServersDataRef.current,
            enabledMcpServersRef.current
          ),
          parallelExecutionPrompt:
            preferences?.parallel_execution_prompt_enabled
              ? (preferences.magic_prompts?.parallel_execution ??
                DEFAULT_PARALLEL_EXECUTION_PROMPT)
              : undefined,
          chromeEnabled: preferences?.chrome_enabled ?? false,
          aiLanguage: preferences?.ai_language,
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    }

    window.addEventListener(
      'review-fix-message',
      handleReviewFixMessage as EventListener
    )
    return () =>
      window.removeEventListener(
        'review-fix-message',
        handleReviewFixMessage as EventListener
      )
  }, [
    sendMessage,
    preferences?.parallel_execution_prompt_enabled,
    preferences?.chrome_enabled,
    preferences?.ai_language,
    isModal,
  ])

  // Handle removing a queued message
  const handleRemoveQueuedMessage = useCallback(
    (sessionId: string, messageId: string) => {
      useChatStore.getState().removeQueuedMessage(sessionId, messageId)
    },
    []
  )

  // Handle force-sending a stuck queued message
  const handleForceSendQueued = useCallback((sessionId: string) => {
    useChatStore.getState().forceProcessQueue(sessionId)
  }, [])

  // Handle cancellation of running Claude process (triggered by Cmd+Option+Backspace / Ctrl+Alt+Backspace)
  const handleCancel = useCallback(async () => {
    if (!activeSessionId || !activeWorktreeId || !isSending) return

    const cancelled = await cancelChatMessage(activeSessionId, activeWorktreeId)
    if (!cancelled) {
      // Process might have finished just before we tried to cancel
      toast.info('No active request to cancel')
    }
    // Note: The chat:cancelled event listener will handle UI cleanup
  }, [activeSessionId, activeWorktreeId, isSending])

  // Handle removing a pending image
  const handleRemovePendingImage = useCallback(
    (imageId: string) => {
      if (!activeSessionId) return
      const { removePendingImage } = useChatStore.getState()
      removePendingImage(activeSessionId, imageId)
    },
    [activeSessionId]
  )

  // Handle removing a pending text file
  const handleRemovePendingTextFile = useCallback(
    (textFileId: string) => {
      if (!activeSessionId) return
      const { removePendingTextFile } = useChatStore.getState()
      removePendingTextFile(activeSessionId, textFileId)
    },
    [activeSessionId]
  )

  // Handle removing a pending skill
  const handleRemovePendingSkill = useCallback(
    (skillId: string) => {
      if (!activeSessionId) return
      const { removePendingSkill } = useChatStore.getState()
      removePendingSkill(activeSessionId, skillId)
    },
    [activeSessionId]
  )

  // Handle slash command execution (from / menu)
  const handleCommandExecute = useCallback(
    (commandName: string) => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      // Commands are executed immediately by sending as the message
      // The command name (e.g., "/commit") is sent directly, Claude CLI interprets it
      const queuedMessage: QueuedMessage = {
        id: generateId(),
        message: commandName,
        pendingImages: [],
        pendingFiles: [],
        pendingSkills: [],
        pendingTextFiles: [],
        model: selectedModelRef.current,
        provider: selectedProviderRef.current,
        executionMode: executionModeRef.current,
        thinkingLevel: selectedThinkingLevelRef.current,
        disableThinkingForMode: false,
        effortLevel: useAdaptiveThinkingRef.current
          ? selectedEffortLevelRef.current
          : undefined,
        mcpConfig: buildMcpConfigJson(
          mcpServersDataRef.current,
          enabledMcpServersRef.current
        ),
        queuedAt: Date.now(),
      }

      // Check if currently sending - queue if so, otherwise send immediately
      const { isSending: checkIsSendingNow, enqueueMessage } =
        useChatStore.getState()
      if (checkIsSendingNow(activeSessionId)) {
        enqueueMessage(activeSessionId, queuedMessage)
      } else {
        sendMessageNow(queuedMessage)
      }
    },
    [activeSessionId, activeWorktreeId, activeWorktreePath, sendMessageNow]
  )

  // Handle removing a pending file (@ mention)
  const handleRemovePendingFile = useCallback(
    (fileId: string) => {
      if (!activeSessionId) return
      const { removePendingFile, getPendingFiles, inputDrafts } =
        useChatStore.getState()

      // Find the file to get its filename before removing
      const files = getPendingFiles(activeSessionId)
      const file = files.find(f => f.id === fileId)
      if (file) {
        // Remove @filename from the input text
        const filename = getFilename(file.relativePath)
        const currentInput = inputDrafts[activeSessionId] ?? ''
        // Match @filename followed by space, newline, or end of string
        const pattern = new RegExp(
          `@${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`,
          'g'
        )
        const newInput = currentInput
          .replace(pattern, '')
          .replace(/\s+/g, ' ')
          .trim()
        setInputDraft(activeSessionId, newInput)
      }

      removePendingFile(activeSessionId, fileId)
    },
    [activeSessionId, setInputDraft]
  )

  // Pre-calculate last plan message index for approve button logic
  const lastPlanMessageIndex = useMemo(() => {
    const messages = session?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (
        m &&
        m.role === 'assistant' &&
        m.tool_calls?.some(tc => isExitPlanMode(tc))
      ) {
        return i
      }
    }
    return -1
  }, [session?.messages])

  // Messages for rendering - memoize to ensure stable reference
  const messages = useMemo(() => session?.messages ?? [], [session?.messages])

  // Pre-compute hasFollowUpMessage for all messages in O(n) instead of O(n²)
  // Maps message index to whether a user message follows it
  const hasFollowUpMap = useMemo(() => {
    const map = new Map<number, boolean>()
    let foundUserMessage = false
    // Walk backwards through messages
    for (let i = messages.length - 1; i >= 0; i--) {
      map.set(i, foundUserMessage)
      if (messages[i]?.role === 'user') {
        foundUserMessage = true
      }
    }
    return map
  }, [messages])

  // Virtualizer for message list - always use virtualization for consistent performance
  // Even small conversations benefit from virtualization when messages have heavy content
  // Note: MainWindowContent handles the case when no worktree is selected
  if (!activeWorktreePath || !activeWorktreeId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select a worktree to start chatting
      </div>
    )
  }

  return (
    <ErrorBoundary
      onError={(error, errorInfo) => {
        logger.error('ChatWindow crashed', {
          error: error.message,
          stack: error.stack,
        })
        saveCrashState(
          { activeWorktreeId, activeSessionId },
          {
            error: error.message,
            stack: error.stack ?? '',
            componentStack: errorInfo.componentStack ?? undefined,
          }
        ).catch(() => {
          /* noop */
        })
      }}
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ChatErrorFallback
          error={error}
          resetErrorBoundary={resetErrorBoundary}
          activeWorktreeId={activeWorktreeId}
        />
      )}
    >
      <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
        {/* Session tab bar - hidden in modal mode and canvas-only mode */}
        {!isModal && !canvasOnlyMode && (
          <SessionTabBar
            worktreeId={activeWorktreeId}
            worktreePath={activeWorktreePath}
            projectId={worktree?.project_id}
            isBase={worktree?.session_type === 'base'}
          />
        )}

        {/* Canvas view (when canvas tab is active) */}
        {!isModal && isViewingCanvasTab ? (
          <SessionCanvasView
            worktreeId={activeWorktreeId}
            worktreePath={activeWorktreePath}
          />
        ) : (
          <ResizablePanelGroup direction="horizontal" className="flex-1">
            <ResizablePanel defaultSize={hasReviewResults && reviewSidebarVisible ? 50 : 100} minSize={40}>
          <ResizablePanelGroup direction="vertical" className="h-full">
            <ResizablePanel
              defaultSize={terminalVisible ? 70 : 100}
              minSize={30}
            >
              <div className="flex h-full flex-col">
                {/* Messages area */}
                <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
                  {/* Session digest reminder (shows when opening a session that had activity while out of focus) */}
                  {activeSessionId && (
                    <SessionDigestReminder sessionId={activeSessionId} />
                  )}
                  <ScrollArea
                    className="h-full w-full"
                    viewportRef={scrollViewportRef}
                    onScroll={handleScroll}
                  >
                    <div className="mx-auto max-w-7xl px-4 py-4 md:px-6 min-w-0 w-full">
                      <div className="select-text space-y-4 font-mono text-sm min-w-0 break-words overflow-x-auto">
                        {/* Debug info (enabled via Settings → Experimental → Debug mode) */}
                        {preferences?.debug_mode_enabled &&
                          activeWorktreeId &&
                          activeWorktreePath &&
                          activeSessionId && (
                            <div className="text-[0.625rem] text-muted-foreground/50 bg-muted/30 rounded font-mono">
                              <SessionDebugPanel
                                worktreeId={activeWorktreeId}
                                worktreePath={activeWorktreePath}
                                sessionId={activeSessionId}
                                selectedModel={selectedModel}
                                selectedProvider={selectedProvider}
                                onFileClick={setViewingFilePath}
                              />
                            </div>
                          )}
                        {/* Setup script output from jean.json */}
                        {setupScriptResult && activeWorktreeId && (
                          <SetupScriptOutput
                            result={setupScriptResult}
                            onDismiss={() =>
                              clearSetupScriptResult(activeWorktreeId)
                            }
                          />
                        )}
                        {isLoading ||
                          isSessionsLoading ||
                          isSessionSwitching ? (
                          <div className="text-muted-foreground">
                            Loading...
                          </div>
                        ) : !session || session.messages.length === 0 ? (
                          <div className="text-muted-foreground">
                            No messages yet. Start a conversation!
                          </div>
                        ) : (
                          // Virtualized message list - only renders visible messages for performance
                          <VirtualizedMessageList
                            ref={virtualizedListRef}
                            messages={messages}
                            scrollContainerRef={scrollViewportRef}
                            totalMessages={messages.length}
                            lastPlanMessageIndex={lastPlanMessageIndex}
                            hasFollowUpMap={hasFollowUpMap}
                            sessionId={deferredSessionId ?? ''}
                            worktreePath={activeWorktreePath ?? ''}
                            approveShortcut={approveShortcut}
                            approveShortcutYolo={approveShortcutYolo}
                            approveButtonRef={approveButtonRef}
                            isSending={isSending}
                            onPlanApproval={handlePlanApproval}
                            onPlanApprovalYolo={handlePlanApprovalYolo}
                            onQuestionAnswer={handleQuestionAnswer}
                            onQuestionSkip={handleSkipQuestion}
                            onFileClick={setViewingFilePath}
                            onEditedFileClick={setViewingFilePath}
                            onFixFinding={handleFixFinding}
                            onFixAllFindings={handleFixAllFindings}
                            isQuestionAnswered={isQuestionAnswered}
                            getSubmittedAnswers={getSubmittedAnswers}
                            areQuestionsSkipped={areQuestionsSkipped}
                            isFindingFixed={isFindingFixed}
                            onCopyToInput={handleCopyToInput}
                            shouldScrollToBottom={isAtBottom}
                            onScrollToBottomHandled={
                              handleScrollToBottomHandled
                            }
                          />
                        )}
                        {isSending && activeSessionId && (
                          <StreamingMessage
                            sessionId={activeSessionId}
                            contentBlocks={currentStreamingContentBlocks}
                            toolCalls={currentToolCalls}
                            streamingContent={streamingContent}
                            streamingExecutionMode={streamingExecutionMode}
                            selectedThinkingLevel={selectedThinkingLevel}
                            approveShortcut={approveShortcut}
                            approveShortcutYolo={approveShortcutYolo}
                            onQuestionAnswer={handleQuestionAnswer}
                            onQuestionSkip={handleSkipQuestion}
                            onFileClick={setViewingFilePath}
                            onEditedFileClick={setViewingFilePath}
                            isQuestionAnswered={isQuestionAnswered}
                            getSubmittedAnswers={getSubmittedAnswers}
                            areQuestionsSkipped={areQuestionsSkipped}
                            isStreamingPlanApproved={isStreamingPlanApproved}
                            onStreamingPlanApproval={
                              handleStreamingPlanApproval
                            }
                            onStreamingPlanApprovalYolo={
                              handleStreamingPlanApprovalYolo
                            }
                          />
                        )}

                        {/* Permission approval UI - shown when tools require approval (never in yolo mode) */}
                        {pendingDenials.length > 0 &&
                          activeSessionId &&
                          !isSending &&
                          executionMode !== 'yolo' && (
                            <PermissionApproval
                              sessionId={activeSessionId}
                              denials={pendingDenials}
                              onApprove={handlePermissionApproval}
                              onApproveYolo={handlePermissionApprovalYolo}
                              onDeny={handlePermissionDeny}
                            />
                          )}

                        {/* Queued messages - shown inline after streaming/messages */}
                        {activeSessionId && (
                          <QueuedMessagesList
                            messages={currentQueuedMessages}
                            sessionId={activeSessionId}
                            onRemove={handleRemoveQueuedMessage}
                            onForceSend={handleForceSendQueued}
                            isSessionIdle={!isSending}
                          />
                        )}
                      </div>
                    </div>
                  </ScrollArea>

                  {/* Floating scroll buttons */}
                  <FloatingButtons
                    hasPendingPlan={!!pendingPlanMessage}
                    hasStreamingPlan={hasStreamingPlan}
                    showFindingsButton={!areFindingsVisible}
                    isAtBottom={isAtBottom}
                    approveShortcut={approveShortcut}
                    hasPlan={hasPlan}
                    onStreamingPlanApproval={handleStreamingPlanApproval}
                    onPendingPlanApproval={handlePendingPlanApprovalCallback}
                    onScrollToFindings={scrollToFindings}
                    onScrollToBottom={scrollToBottom}
                    onOpenPlan={() => {
                      if (latestPlanContent) {
                        setPlanDialogContent(latestPlanContent)
                      }
                      setIsPlanDialogOpen(true)
                    }}
                  />
                </div>

                {/* Error banner - shows when request fails */}
                {currentError && (
                  <ErrorBanner
                    error={currentError}
                    onDismiss={() =>
                      activeSessionId && setError(activeSessionId, null)
                    }
                  />
                )}

                {/* Input container - full width, centered content */}
                <div className="bg-sidebar">
                  <div className="mx-auto max-w-7xl">
                    {/* Input area - unified container with textarea and toolbar */}
                    <form
                      ref={formRef}
                      onSubmit={handleSubmit}
                      className={cn(
                        'relative overflow-hidden rounded-lg transition-all duration-150',
                        isDragging &&
                        'ring-2 ring-primary ring-inset bg-primary/5'
                      )}
                    >
                      {/* Pending file preview (@ mentions) */}
                      <FilePreview
                        files={currentPendingFiles}
                        onRemove={handleRemovePendingFile}
                      />

                      {/* Pending image preview */}
                      <ImagePreview
                        images={currentPendingImages}
                        onRemove={handleRemovePendingImage}
                      />

                      {/* Pending text file preview */}
                      <TextFilePreview
                        textFiles={currentPendingTextFiles}
                        onRemove={handleRemovePendingTextFile}
                      />

                      {/* Pending skills preview */}
                      {currentPendingSkills.length > 0 && (
                        <div className="px-4 md:px-6 pt-2 flex flex-wrap gap-2">
                          {currentPendingSkills.map(skill => (
                            <SkillBadge
                              key={skill.id}
                              skill={skill}
                              onRemove={() =>
                                handleRemovePendingSkill(skill.id)
                              }
                            />
                          ))}
                        </div>
                      )}

                      {/* Task widget - shows current session's active todos */}
                      {/* Show if: has todos AND (no dismissal OR source differs from dismissed message) */}
                      {activeTodos.length > 0 &&
                        (dismissedTodoMessageId === null ||
                          (todoSourceMessageId !== null &&
                            todoSourceMessageId !==
                            dismissedTodoMessageId)) && (
                          <div className="px-4 md:px-6 pt-2">
                            <TodoWidget
                              todos={normalizeTodosForDisplay(
                                activeTodos,
                                isFromStreaming
                              )}
                              isStreaming={isSending}
                              onClose={() =>
                                setDismissedTodoMessageId(
                                  todoSourceMessageId ?? '__streaming__'
                                )
                              }
                            />
                          </div>
                        )}

                      {/* Textarea section */}
                      <div className="px-4 pt-3 pb-2 md:px-6">
                        <ChatInput
                          activeSessionId={activeSessionId}
                          activeWorktreePath={activeWorktreePath}
                          isSending={isSending}
                          executionMode={executionMode}
                          focusChatShortcut={focusChatShortcut}
                          onSubmit={handleSubmit}
                          onCancel={handleCancel}
                          onCommandExecute={handleCommandExecute}
                          onHasValueChange={setHasInputValue}
                          formRef={formRef}
                          inputRef={inputRef}
                        />
                      </div>

                      {/* Bottom toolbar - memoized to prevent re-renders */}
                      <ChatToolbar
                        isSending={isSending}
                        hasPendingQuestions={hasPendingQuestions}
                        hasPendingAttachments={hasPendingAttachments}
                        hasInputValue={hasInputValue}
                        executionMode={executionMode}
                        selectedModel={selectedModel}
                        selectedProvider={selectedProvider}
                        providerLocked={(session?.messages?.length ?? 0) > 0}
                        selectedThinkingLevel={selectedThinkingLevel}
                        selectedEffortLevel={selectedEffortLevel}
                        thinkingOverrideActive={
                          executionMode !== 'plan' &&
                          (useAdaptiveThinkingFlag ||
                            selectedThinkingLevel !== 'off') &&
                          !hasManualThinkingOverride
                        }
                        useAdaptiveThinking={useAdaptiveThinkingFlag}
                        hideThinkingLevel={hideThinkingLevel}
                        baseBranch={gitStatus?.base_branch ?? 'main'}
                        uncommittedAdded={uncommittedAdded}
                        uncommittedRemoved={uncommittedRemoved}
                        branchDiffAdded={branchDiffAdded}
                        branchDiffRemoved={branchDiffRemoved}
                        prUrl={worktree?.pr_url}
                        prNumber={worktree?.pr_number}
                        displayStatus={displayStatus}
                        checkStatus={checkStatus}
                        mergeableStatus={mergeableStatus}
                        magicModalShortcut={magicModalShortcut}
                        activeWorktreePath={activeWorktreePath}
                        worktreeId={activeWorktreeId ?? null}
                        activeSessionId={activeSessionId}
                        projectId={worktree?.project_id}
                        loadedIssueContexts={loadedIssueContexts ?? []}
                        loadedPRContexts={loadedPRContexts ?? []}
                        attachedSavedContexts={attachedSavedContexts ?? []}
                        onOpenMagicModal={handleOpenMagicModal}
                        onSaveContext={handleSaveContext}
                        onLoadContext={handleLoadContext}
                        onCommit={handleCommit}
                        onCommitAndPush={handleCommitAndPush}
                        onOpenPr={handleOpenPr}
                        onReview={() => handleReview(activeSessionId ?? undefined)}
                        onMerge={handleMerge}
                        onResolvePrConflicts={handleResolvePrConflicts}
                        onResolveConflicts={handleResolveConflicts}
                        hasOpenPr={Boolean(worktree?.pr_url)}
                        onSetDiffRequest={setDiffRequest}
                        onModelChange={handleToolbarModelChange}
                        onProviderChange={handleToolbarProviderChange}
                        customCliProfiles={
                          preferences?.custom_cli_profiles ?? []
                        }
                        onThinkingLevelChange={handleToolbarThinkingLevelChange}
                        onEffortLevelChange={handleToolbarEffortLevelChange}
                        onSetExecutionMode={handleToolbarSetExecutionMode}
                        onCancel={handleCancel}
                        queuedMessageCount={currentQueuedMessages.length}
                        availableMcpServers={availableMcpServers}
                        enabledMcpServers={enabledMcpServers}
                        onToggleMcpServer={handleToggleMcpServer}
                        onOpenProjectSettings={handleOpenProjectSettings}
                      />
                    </form>
                  </div>
                </div>
              </div>
            </ResizablePanel>

            {/* Terminal panel - only render when panel is open (native app only, not in modal) */}
            {!isModal &&
              isServerApp() &&
              activeWorktreePath &&
              terminalPanelOpen && (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    ref={terminalPanelRef}
                    defaultSize={terminalVisible ? 30 : 4}
                    minSize={terminalVisible ? 15 : 4}
                    collapsible
                    collapsedSize={4}
                    onCollapse={handleTerminalCollapse}
                    onExpand={handleTerminalExpand}
                  >
                    <TerminalPanel
                      isCollapsed={!terminalVisible}
                      onExpand={handleTerminalExpand}
                    />
                  </ResizablePanel>
                </>
              )}
          </ResizablePanelGroup>
            </ResizablePanel>

            {/* Review sidebar - shown when active session has review results */}
            {hasReviewResults && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel
                  ref={reviewPanelRef}
                  defaultSize={reviewSidebarVisible ? 50 : 0}
                  minSize={reviewSidebarVisible ? 20 : 0}
                  collapsible
                  collapsedSize={0}
                  onCollapse={handleReviewSidebarCollapse}
                  onExpand={handleReviewSidebarExpand}
                >
                  {activeSessionId && (
                    <ReviewResultsPanel sessionId={activeSessionId} />
                  )}
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}

        {/* File content modal for viewing files from tool calls */}
        <FileContentModal
          filePath={viewingFilePath}
          onClose={() => setViewingFilePath(null)}
        />

        {/* Git diff modal for viewing diffs */}
        <GitDiffModal
          diffRequest={diffRequest}
          onClose={() => setDiffRequest(null)}
          onAddToPrompt={handleGitDiffAddToPrompt}
          onExecutePrompt={handleGitDiffExecutePrompt}
        />

        {/* Single file diff modal for viewing edited file changes */}
        <FileDiffModal
          filePath={editedFilePath}
          worktreePath={activeWorktreePath ?? ''}
          onClose={() => setEditedFilePath(null)}
        />

        {/* Load Context modal for selecting saved contexts */}
        <LoadContextModal
          open={loadContextModalOpen}
          onOpenChange={handleLoadContextModalChange}
          worktreeId={activeWorktreeId}
          worktreePath={activeWorktreePath ?? null}
          activeSessionId={activeSessionId ?? null}
          projectName={worktree?.name ?? 'unknown-project'}
        />

        {/* Plan dialog - editable view of latest plan */}
        {isPlanDialogOpen &&
          (planDialogContent ? (
            <PlanDialog
              content={planDialogContent}
              isOpen={isPlanDialogOpen}
              onClose={() => {
                setIsPlanDialogOpen(false)
                setPlanDialogContent(null)
              }}
              editable={true}
              approvalContext={
                activeWorktreeId && activeWorktreePath && activeSessionId
                  ? {
                    worktreeId: activeWorktreeId,
                    worktreePath: activeWorktreePath,
                    sessionId: activeSessionId,
                    pendingPlanMessageId: pendingPlanMessage?.id ?? null,
                  }
                  : undefined
              }
              onApprove={updatedPlan => {
                if (
                  !activeSessionId ||
                  !activeWorktreeId ||
                  !activeWorktreePath
                )
                  return

                // Mark plan as approved if there's a pending plan message
                if (pendingPlanMessage) {
                  markPlanApprovedService(
                    activeWorktreeId,
                    activeWorktreePath,
                    activeSessionId,
                    pendingPlanMessage.id
                  )
                  // Optimistically update query cache
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
                }

                // Build approval message
                const message = updatedPlan
                  ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
                  : 'Approved'

                // Queue instead of immediate execution
                const { enqueueMessage, setExecutionMode } =
                  useChatStore.getState()
                setExecutionMode(activeSessionId, 'build')

                const queuedMessage: QueuedMessage = {
                  id: generateId(),
                  message,
                  pendingImages: [],
                  pendingFiles: [],
                  pendingSkills: [],
                  pendingTextFiles: [],
                  model: selectedModelRef.current,
                  provider: selectedProviderRef.current,
                  executionMode: 'build',
                  thinkingLevel: selectedThinkingLevelRef.current,
                  disableThinkingForMode: !useChatStore
                    .getState()
                    .hasManualThinkingOverride(activeSessionId),
                  effortLevel: useAdaptiveThinkingRef.current
                    ? selectedEffortLevelRef.current
                    : undefined,
                  mcpConfig: buildMcpConfigJson(
                    mcpServersDataRef.current,
                    enabledMcpServersRef.current
                  ),
                  queuedAt: Date.now(),
                }

                enqueueMessage(activeSessionId, queuedMessage)
              }}
              onApproveYolo={updatedPlan => {
                if (
                  !activeSessionId ||
                  !activeWorktreeId ||
                  !activeWorktreePath
                )
                  return

                // Mark plan as approved if there's a pending plan message
                if (pendingPlanMessage) {
                  markPlanApprovedService(
                    activeWorktreeId,
                    activeWorktreePath,
                    activeSessionId,
                    pendingPlanMessage.id
                  )
                  // Optimistically update query cache
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
                }

                // Build approval message
                const message = updatedPlan
                  ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
                  : 'Approved - yolo'

                // Queue instead of immediate execution
                const { enqueueMessage, setExecutionMode } =
                  useChatStore.getState()
                setExecutionMode(activeSessionId, 'yolo')

                const queuedMessage: QueuedMessage = {
                  id: generateId(),
                  message,
                  pendingImages: [],
                  pendingFiles: [],
                  pendingSkills: [],
                  pendingTextFiles: [],
                  model: selectedModelRef.current,
                  provider: selectedProviderRef.current,
                  executionMode: 'yolo',
                  thinkingLevel: selectedThinkingLevelRef.current,
                  disableThinkingForMode: !useChatStore
                    .getState()
                    .hasManualThinkingOverride(activeSessionId),
                  effortLevel: useAdaptiveThinkingRef.current
                    ? selectedEffortLevelRef.current
                    : undefined,
                  mcpConfig: buildMcpConfigJson(
                    mcpServersDataRef.current,
                    enabledMcpServersRef.current
                  ),
                  queuedAt: Date.now(),
                }

                enqueueMessage(activeSessionId, queuedMessage)
              }}
            />
          ) : latestPlanFilePath ? (
            <PlanDialog
              filePath={latestPlanFilePath}
              isOpen={isPlanDialogOpen}
              onClose={() => setIsPlanDialogOpen(false)}
              editable={true}
              approvalContext={
                activeWorktreeId && activeWorktreePath && activeSessionId
                  ? {
                    worktreeId: activeWorktreeId,
                    worktreePath: activeWorktreePath,
                    sessionId: activeSessionId,
                    pendingPlanMessageId: pendingPlanMessage?.id ?? null,
                  }
                  : undefined
              }
              onApprove={updatedPlan => {
                if (
                  !activeSessionId ||
                  !activeWorktreeId ||
                  !activeWorktreePath
                )
                  return

                // Mark plan as approved if there's a pending plan message
                if (pendingPlanMessage) {
                  markPlanApprovedService(
                    activeWorktreeId,
                    activeWorktreePath,
                    activeSessionId,
                    pendingPlanMessage.id
                  )
                  // Optimistically update query cache
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
                }

                // Build approval message
                const message = updatedPlan
                  ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
                  : 'Approved'

                // Queue instead of immediate execution
                const { enqueueMessage, setExecutionMode } =
                  useChatStore.getState()
                setExecutionMode(activeSessionId, 'build')

                const queuedMessage: QueuedMessage = {
                  id: generateId(),
                  message,
                  pendingImages: [],
                  pendingFiles: [],
                  pendingSkills: [],
                  pendingTextFiles: [],
                  model: selectedModelRef.current,
                  provider: selectedProviderRef.current,
                  executionMode: 'build',
                  thinkingLevel: selectedThinkingLevelRef.current,
                  disableThinkingForMode: !useChatStore
                    .getState()
                    .hasManualThinkingOverride(activeSessionId),
                  effortLevel: useAdaptiveThinkingRef.current
                    ? selectedEffortLevelRef.current
                    : undefined,
                  mcpConfig: buildMcpConfigJson(
                    mcpServersDataRef.current,
                    enabledMcpServersRef.current
                  ),
                  queuedAt: Date.now(),
                }

                enqueueMessage(activeSessionId, queuedMessage)
              }}
              onApproveYolo={updatedPlan => {
                if (
                  !activeSessionId ||
                  !activeWorktreeId ||
                  !activeWorktreePath
                )
                  return

                // Mark plan as approved if there's a pending plan message
                if (pendingPlanMessage) {
                  markPlanApprovedService(
                    activeWorktreeId,
                    activeWorktreePath,
                    activeSessionId,
                    pendingPlanMessage.id
                  )
                  // Optimistically update query cache
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
                }

                // Build approval message
                const message = updatedPlan
                  ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
                  : 'Approved - yolo'

                // Queue instead of immediate execution
                const { enqueueMessage, setExecutionMode } =
                  useChatStore.getState()
                setExecutionMode(activeSessionId, 'yolo')

                const queuedMessage: QueuedMessage = {
                  id: generateId(),
                  message,
                  pendingImages: [],
                  pendingFiles: [],
                  pendingSkills: [],
                  pendingTextFiles: [],
                  model: selectedModelRef.current,
                  provider: selectedProviderRef.current,
                  executionMode: 'yolo',
                  thinkingLevel: selectedThinkingLevelRef.current,
                  disableThinkingForMode: !useChatStore
                    .getState()
                    .hasManualThinkingOverride(activeSessionId),
                  effortLevel: useAdaptiveThinkingRef.current
                    ? selectedEffortLevelRef.current
                    : undefined,
                  mcpConfig: buildMcpConfigJson(
                    mcpServersDataRef.current,
                    enabledMcpServersRef.current
                  ),
                  queuedAt: Date.now(),
                }

                enqueueMessage(activeSessionId, queuedMessage)
              }}
            />
          ) : null)}

        {/* Merge options dialog */}
        <AlertDialog open={showMergeDialog} onOpenChange={setShowMergeDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Merge to Base</AlertDialogTitle>
              <AlertDialogDescription>
                Choose how to merge your changes into the base branch.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-2 py-4">
              <Button
                variant="outline"
                className="h-auto justify-between py-3"
                onClick={() => executeMerge('merge')}
              >
                <div className="flex items-center">
                  <GitMerge className="mr-3 h-5 w-5 shrink-0" />
                  <div className="text-left">
                    <div className="font-medium">Preserve History</div>
                    <div className="text-xs text-muted-foreground">
                      Keep all commits, create merge commit
                    </div>
                  </div>
                </div>
                <kbd className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  P
                </kbd>
              </Button>
              <Button
                variant="outline"
                className="h-auto justify-between py-3"
                onClick={() => executeMerge('squash')}
              >
                <div className="flex items-center">
                  <Layers className="mr-3 h-5 w-5 shrink-0" />
                  <div className="text-left">
                    <div className="font-medium">Squash Commits</div>
                    <div className="text-xs text-muted-foreground">
                      Combine all commits into one
                    </div>
                  </div>
                </div>
                <kbd className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  S
                </kbd>
              </Button>
              <Button
                variant="outline"
                className="h-auto justify-between py-3"
                onClick={() => executeMerge('rebase')}
              >
                <div className="flex items-center">
                  <GitBranch className="mr-3 h-5 w-5 shrink-0" />
                  <div className="text-left">
                    <div className="font-medium">Rebase</div>
                    <div className="text-xs text-muted-foreground">
                      Replay commits on top of base
                    </div>
                  </div>
                </div>
                <kbd className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  R
                </kbd>
              </Button>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </ErrorBoundary>
  )
}
