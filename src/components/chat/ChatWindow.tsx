import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
  useSetSessionBackend,
  useSetSessionProvider,
  useCreateSession,
} from '@/services/chat'
import { useWorktree, useProjects, useRunScript } from '@/services/projects'
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
import { getLabelTextColor } from '@/lib/label-colors'
import { PREDEFINED_CLI_PROFILES, type CliBackend } from '@/types/preferences'
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
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import { getFilename, normalizePath } from '@/lib/path-utils'
import { cn } from '@/lib/utils'
import { PermissionApproval } from './PermissionApproval'
import { SetupScriptOutput } from './SetupScriptOutput'
import { TodoWidget } from './TodoWidget'
import { AgentWidget } from './AgentWidget'
import { normalizeTodosForDisplay } from './tool-call-utils'
import { ImagePreview } from './ImagePreview'
import { TextFilePreview } from './TextFilePreview'
import { SkillBadge } from './SkillBadge'
import { FileContentModal } from './FileContentModal'
import { FilePreview } from './FilePreview'
import { ChatInput } from './ChatInput'
import { SessionDebugPanel } from './SessionDebugPanel'
import { ChatToolbar } from './ChatToolbar'
import { ReviewResultsPanel } from './ReviewResultsPanel'
import { WorktreeCanvasView } from './WorktreeCanvasView'
import { QueuedMessagesList } from './QueuedMessageItem'
import { FloatingButtons } from './FloatingButtons'
import { PlanDialog } from './PlanDialog'
import { RecapDialog } from './RecapDialog'
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
import { buildMcpConfigJson } from '@/services/mcp'
import type { McpServerInfo } from '@/types/chat'
import { useGitStatus } from '@/services/git-status'
import { useRemotePicker } from '@/hooks/useRemotePicker'
import { isNativeApp } from '@/lib/environment'
import { supportsAdaptiveThinking } from '@/lib/model-utils'
import { useClaudeCliStatus } from '@/services/claude-cli'
import { usePrStatus, usePrStatusEvents } from '@/services/pr-status'
import type { PrDisplayStatus, CheckStatus } from '@/types/pr-status'
import type { QueuedMessage, SessionDigest } from '@/types/chat'
import type { DiffRequest } from '@/types/git-diff'
import { FileDiffModal } from './FileDiffModal'

// Lazy-loaded heavy modals (code splitting)
const GitDiffModal = lazy(() =>
  import('./GitDiffModal').then(mod => ({ default: mod.GitDiffModal }))
)
const LoadContextModal = lazy(() =>
  import('../magic/LoadContextModal').then(mod => ({
    default: mod.LoadContextModal,
  }))
)
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
import { useMessageHandlers } from './hooks/useMessageHandlers'
import { useMagicCommands } from './hooks/useMagicCommands'
import { useDragAndDropImages } from './hooks/useDragAndDropImages'
import { usePlanDialogApproval } from './hooks/usePlanDialogApproval'
import { useChatWindowEvents } from './hooks/useChatWindowEvents'
import { useInvestigateHandlers } from './hooks/useInvestigateHandlers'
import { useMcpServerResolution } from './hooks/useMcpServerResolution'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useToolbarHandlers } from './hooks/useToolbarHandlers'
import { useMessageSending } from './hooks/useMessageSending'
import { usePlanState } from './hooks/usePlanState'
import { useActiveTodosAndAgents } from './hooks/useActiveTodosAndAgents'
import { usePendingAttachments } from './hooks/usePendingAttachments'

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
  /** When true, hides terminal panel and other elements not needed in modal */
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
  // Session label for top-right badge
  const sessionLabel = useChatStore(state =>
    activeSessionId ? (state.sessionLabels[activeSessionId] ?? null) : null
  )

  // Function selectors - these return stable function references
  const isQuestionAnswered = useChatStore(state => state.isQuestionAnswered)
  const getSubmittedAnswers = useChatStore(state => state.getSubmittedAnswers)
  const areQuestionsSkipped = useChatStore(state => state.areQuestionsSkipped)
  const isFindingFixed = useChatStore(state => state.isFindingFixed)
  // DATA subscription for answered questions - triggers re-render when persisted state is restored
  // Subscribe to the size of answered questions (a stable primitive) to trigger re-renders
  // when questions are answered, without creating new Set references on every store update
  const answeredQuestionsSize = useChatStore(state =>
    activeSessionId ? (state.answeredQuestions[activeSessionId]?.size ?? 0) : 0
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
  const isViewingCanvasTab = isViewingCanvasTabRaw
  const sessionModalOpen = useUIStore(state => state.sessionChatModalOpen)
  const focusChatShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.focus_chat_input ??
      DEFAULT_KEYBINDINGS.focus_chat_input) as string
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
  const setSessionBackend = useSetSessionBackend()
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

  // Per-session provider selection: persisted session → zustand → project default → global default
  const projectDefaultProvider = project?.default_provider ?? null
  const globalDefaultProvider = preferences?.default_provider ?? null
  const defaultProvider = projectDefaultProvider ?? globalDefaultProvider
  const zustandProvider = useChatStore(state =>
    deferredSessionId ? state.selectedProviders[deferredSessionId] : undefined
  )
  const sessionProvider = session?.selected_provider ?? zustandProvider
  const selectedProvider =
    sessionProvider !== undefined ? sessionProvider : defaultProvider
  // __anthropic__ is the sentinel for "use default Anthropic" — treat as non-custom for feature detection
  const isCustomProvider = Boolean(
    selectedProvider && selectedProvider !== '__anthropic__'
  )

  // Installed backends (only these should be selectable)
  const { installedBackends } = useInstalledBackends()

  // Per-session backend selection: session → zustand → project default → global default
  const zustandBackend = useChatStore(state =>
    deferredSessionId ? state.selectedBackends[deferredSessionId] : undefined
  )
  const projectDefaultBackend = (project?.default_backend ?? null) as CliBackend | null
  const globalDefaultBackend = (preferences?.default_backend ?? 'claude') as CliBackend
  const resolvedBackend: CliBackend =
    (session?.backend as CliBackend) ??
    zustandBackend ??
    projectDefaultBackend ??
    globalDefaultBackend
  // Clamp to installed backends — prevents showing "Claude" when only Codex is installed
  const selectedBackend: CliBackend =
    installedBackends.length > 0 && !installedBackends.includes(resolvedBackend)
      ? (installedBackends[0] as CliBackend)
      : resolvedBackend
  const isCodexBackend = selectedBackend === 'codex'
  const isOpencodeBackend = selectedBackend === 'opencode'

  // Per-session model selection, falls back to preferences default (backend-aware)
  const defaultModel: string = isCodexBackend
    ? (preferences?.selected_codex_model ?? 'gpt-5.3-codex')
    : isOpencodeBackend
      ? (preferences?.selected_opencode_model ?? 'opencode/gpt-5.2-codex')
      : ((preferences?.selected_model as ClaudeModel) ?? DEFAULT_MODEL)
  const selectedModel: string = session?.selected_model ?? defaultModel

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

  // Per-session effort level, falls back to preferences default (backend-aware)
  const defaultEffortLevel = isCodexBackend
    ? ((
        {
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'max',
        } as Record<string, EffortLevel>
      )[preferences?.default_codex_reasoning_effort ?? 'high'] ?? 'high')
    : ((preferences?.default_effort_level as EffortLevel) ?? 'high')
  const sessionEffortLevel = useChatStore(state =>
    deferredSessionId ? state.effortLevels[deferredSessionId] : undefined
  )
  const selectedEffortLevel: EffortLevel =
    sessionEffortLevel ?? defaultEffortLevel

  // MCP servers: resolve enabled servers cascade (session → project → global)
  const { availableMcpServers, enabledMcpServers } = useMcpServerResolution({
    activeWorktreePath,
    deferredSessionId,
    project,
    preferences,
  })

  // CLI version for adaptive thinking feature detection
  const { data: cliStatus } = useClaudeCliStatus()
  // Custom providers don't support Opus 4.6 adaptive thinking — use thinking levels instead
  const useAdaptiveThinkingFlag =
    !isCustomProvider &&
    supportsAdaptiveThinking(selectedModel, cliStatus?.version ?? null)

  // Hide thinking level UI entirely for providers that don't support it
  const customCliProfiles = preferences?.custom_cli_profiles ?? []
  const activeProfile = isCustomProvider
    ? customCliProfiles.find(p => p.name === selectedProvider)
    : null
  // Fall back to predefined template's supports_thinking for profiles saved before this field existed
  const activeSupportsThinking =
    activeProfile?.supports_thinking ??
    PREDEFINED_CLI_PROFILES.find(p => p.name === selectedProvider)
      ?.supports_thinking
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
  // Note: Uses answeredQuestionsSize as dependency to trigger re-render when questions
  // are answered, then reads the actual Set from getState() for the .has() check
  const hasPendingQuestions = useMemo(() => {
    if (!activeSessionId || isSending) return false
    if (!lastAssistantMessage?.tool_calls) return false

    const answered = useChatStore.getState().answeredQuestions[activeSessionId]
    return lastAssistantMessage.tool_calls.some(
      tc => isAskUserQuestion(tc) && !answered?.has(tc.id)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, lastAssistantMessage, isSending, answeredQuestionsSize])

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
  const isCodexBackendRef = useRef(isCodexBackend)
  const executionModeRef = useRef(executionMode)
  const enabledMcpServersRef = useRef(enabledMcpServers)
  const mcpServersDataRef = useRef<McpServerInfo[]>(availableMcpServers)
  const selectedBackendRef = useRef(selectedBackend)

  // Keep refs in sync with current values (runs on every render, but cheap)
  activeSessionIdRef.current = activeSessionId
  activeWorktreeIdRef.current = activeWorktreeId
  activeWorktreePathRef.current = activeWorktreePath
  selectedModelRef.current = selectedModel
  selectedProviderRef.current = selectedProvider
  selectedThinkingLevelRef.current = selectedThinkingLevel
  selectedEffortLevelRef.current = selectedEffortLevel
  useAdaptiveThinkingRef.current = useAdaptiveThinkingFlag
  isCodexBackendRef.current = isCodexBackend
  executionModeRef.current = executionMode
  enabledMcpServersRef.current = enabledMcpServers
  mcpServersDataRef.current = availableMcpServers
  selectedBackendRef.current = selectedBackend

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
    activeWorktreeId,
  })

  // Drag and drop images into chat input
  const { isDragging } = useDragAndDropImages(activeSessionId)

  // State for file content modal (opened by clicking filenames in tool calls)
  const [viewingFilePath, setViewingFilePath] = useState<string | null>(null)

  // State for git diff modal (opened by clicking diff stats)
  const [diffRequest, setDiffRequest] = useState<DiffRequest | null>(null)

  // State for single file diff modal (opened by clicking edited file badges)
  const [editedFilePath, setEditedFilePath] = useState<string | null>(null)

  // Active todos and agents from streaming/persisted tool calls (with dismissal tracking)
  const {
    activeTodos,
    todoSourceMessageId,
    todoIsFromStreaming: isFromStreaming,
    dismissedTodoMessageId,
    setDismissedTodoMessageId,
    activeAgents,
    agentSourceMessageId,
    agentIsFromStreaming,
    dismissedAgentMessageId,
    setDismissedAgentMessageId,
  } = useActiveTodosAndAgents({
    activeSessionId,
    isSending,
    currentToolCalls,
    lastAssistantMessage,
  })

  // Plan state: pending plan message, streaming plan, content, file path
  const {
    pendingPlanMessage,
    hasStreamingPlan,
    latestPlanContent,
    latestPlanFilePath,
  } = usePlanState({
    sessionMessages: session?.messages,
    currentToolCalls,
    isSending,
    activeSessionId,
    isStreamingPlanApproved,
  })

  // State for plan dialog
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false)
  const [planDialogContent, setPlanDialogContent] = useState<string | null>(
    null
  )

  // State for recap dialog
  const [isRecapDialogOpen, setIsRecapDialogOpen] = useState(false)
  const [recapDialogDigest, setRecapDialogDigest] =
    useState<SessionDigest | null>(null)
  const [isGeneratingRecap, setIsGeneratingRecap] = useState(false)

  // Plan dialog approval handlers (DRYs 4x-duplicated onApprove/onApproveYolo callbacks)
  const { handlePlanDialogApprove, handlePlanDialogApproveYolo } =
    usePlanDialogApproval({
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      pendingPlanMessage,
      selectedModelRef,
      selectedProviderRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      isCodexBackendRef,
      mcpServersDataRef,
      enabledMcpServersRef,
    })

  // Note: Streaming event listeners are in App.tsx, not here
  // This ensures they stay active even when ChatWindow is unmounted (e.g., session board view)

  // Message sending pipeline: resolveCustomProfile, sendMessageNow, handleSubmit, git diff handlers
  const {
    resolveCustomProfile,
    sendMessageNow,
    handleSubmit,
    handleCancel,
    handleGitDiffAddToPrompt,
    handleGitDiffExecutePrompt,
  } = useMessageSending({
    activeSessionId,
    activeWorktreeId,
    activeWorktreePath,
    inputRef,
    selectedModelRef,
    selectedProviderRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    executionModeRef,
    useAdaptiveThinkingRef,
    isCodexBackendRef,
    mcpServersDataRef,
    enabledMcpServersRef,
    selectedBackendRef,
    activeWorktreeIdRef,
    preferences,
    sendMessage,
    queryClient,
    scrollToBottom,
    sessionsData,
    setInputDraft,
    clearInputDraft,
    isModal,
  })

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

  // Wrap push/pull/commit-and-push with remote picker for multi-remote repos
  const pickRemoteOrRun = useRemotePicker(activeWorktreePath)

  const handlePushWithPicker = useCallback(
    () => pickRemoteOrRun(remote => handlePush(remote)),
    [pickRemoteOrRun, handlePush]
  )

  const handleCommitAndPushWithPicker = useCallback(
    () => pickRemoteOrRun(remote => handleCommitAndPush(remote)),
    [pickRemoteOrRun, handleCommitAndPush]
  )

  const handlePullWithPicker = useCallback(
    () => pickRemoteOrRun(remote => handlePull(remote)),
    [pickRemoteOrRun, handlePull]
  )

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

  // Window event listeners are called after useMessageHandlers (needs plan approval handlers)

  // PERFORMANCE: Stable callbacks for ChatToolbar to prevent re-renders
  const {
    handleToolbarModelChange,
    handleToolbarBackendChange,
    handleTabBackendSwitch,
    handleToolbarProviderChange,
    handleToolbarThinkingLevelChange,
    handleToolbarEffortLevelChange,
    handleToggleMcpServer,
    handleOpenProjectSettings,
    handleToolbarSetExecutionMode,
    handleOpenMagicModal,
    handleLoadContextModalChange,
  } = useToolbarHandlers({
    activeSessionId,
    activeWorktreeId,
    activeWorktreePath,
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    enabledMcpServersRef,
    selectedBackend,
    installedBackends,
    session,
    preferences,
    queryClient,
    worktreeProjectId: worktree?.project_id,
    setSessionModel,
    setSessionBackend,
    setSessionProvider,
    setSessionThinkingLevel,
    setExecutionMode,
    setLoadContextModalOpen,
  })

  // Investigate issue/PR and workflow run handlers
  const { handleInvestigate, handleInvestigateWorkflowRun } =
    useInvestigateHandlers({
      activeSessionId,
      activeWorktreeId,
      activeWorktreePath,
      inputRef,
      preferences,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      executionModeRef,
      mcpServersDataRef,
      enabledMcpServersRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      sendMessage,
      setSessionProvider,
      setSessionBackend,
      setSessionModel,
      createSession,
      resolveCustomProfile,
      cliVersion: cliStatus?.version ?? null,
    })

  // Listen for magic-command events from MagicModal
  // Pass isModal and isViewingCanvasTab to prevent duplicate listeners when modal is open over canvas
  useMagicCommands({
    handleSaveContext,
    handleLoadContext,
    handleCommit,
    handleCommitAndPush: handleCommitAndPushWithPicker,
    handlePull: handlePullWithPicker,
    handlePush: handlePushWithPicker,
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

  // Pick up per-worktree auto-investigate flags (set by useNewWorktreeHandlers
  // when worktree is created with auto-investigate). Uses per-worktree Sets so
  // multiple concurrent worktree creations each get their own investigation.
  useEffect(() => {
    if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return
    const uiStore = useUIStore.getState()
    if (uiStore.consumeAutoInvestigate(activeWorktreeId)) {
      handleInvestigate('issue')
    } else if (uiStore.consumeAutoInvestigatePR(activeWorktreeId)) {
      handleInvestigate('pr')
    }
  }, [activeSessionId, activeWorktreeId, activeWorktreePath, handleInvestigate])

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

  // Window event listeners (focus, plan, recap, git-diff, cancel, create-session, plan approval, etc.)
  useChatWindowEvents({
    inputRef,
    activeSessionId,
    activeWorktreeId,
    activeWorktreePath,
    isModal,
    isViewingCanvasTab,
    latestPlanContent,
    latestPlanFilePath,
    setPlanDialogContent,
    setIsPlanDialogOpen,
    session,
    isRecapDialogOpen,
    recapDialogDigest,
    setRecapDialogDigest,
    setIsRecapDialogOpen,
    setIsGeneratingRecap,
    gitStatus,
    sessionModalOpen,
    setDiffRequest,
    isAtBottom,
    scrollToBottom,
    streamingContent,
    currentStreamingContentBlocks,
    isSending,
    currentQueuedMessages,
    createSession,
    preferences,
    savePreferences,
    handleSaveContext,
    handleLoadContext,
    runScript,
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingPlanApproval,
    handleStreamingPlanApprovalYolo,
    handlePlanApproval,
    handlePlanApprovalYolo,
    isCodexBackend,
  })

  // Pending attachment removal, slash command execution, queue management
  const {
    handleRemovePendingImage,
    handleRemovePendingTextFile,
    handleRemovePendingSkill,
    handleRemovePendingFile,
    handleCommandExecute,
    handleRemoveQueuedMessage,
    handleForceSendQueued,
  } = usePendingAttachments({
    activeSessionId,
    activeWorktreeId,
    activeWorktreePath,
    selectedModelRef,
    selectedProviderRef,
    executionModeRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    isCodexBackendRef,
    mcpServersDataRef,
    enabledMcpServersRef,
    setInputDraft,
    sendMessageNow,
  })

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
        {/* Canvas view (when canvas tab is active) */}
        {!isModal && isViewingCanvasTab ? (
          <WorktreeCanvasView
            worktreeId={activeWorktreeId}
            worktreePath={activeWorktreePath}
          />
        ) : (
          <ResizablePanelGroup direction="horizontal" className="flex-1">
            <ResizablePanel
              defaultSize={hasReviewResults && reviewSidebarVisible ? 50 : 100}
              minSize={40}
            >
              <ResizablePanelGroup direction="vertical" className="h-full">
                <ResizablePanel
                  defaultSize={terminalVisible ? 70 : 100}
                  minSize={30}
                >
                  <div className="flex h-full flex-col">
                    {/* Messages area */}
                    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
                      {/* Session label badge - absolute positioned to avoid covering content */}
                      {sessionLabel && (
                        <span
                          className="absolute top-2 right-4 z-20 inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
                          style={{
                            backgroundColor: sessionLabel.color,
                            color: getLabelTextColor(sessionLabel.color),
                          }}
                        >
                          {sessionLabel.name}
                        </span>
                      )}
                      {/* Bottom fade gradient so messages don't hard-cut at the input area */}
                      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-8 bg-gradient-to-b from-transparent to-background" />
                      {/* Session digest reminder (shows when opening a session that had activity while out of focus) */}
                      {activeSessionId && (
                        <SessionDigestReminder sessionId={activeSessionId} />
                      )}
                      <ScrollArea
                        className="h-full w-full"
                        viewportRef={scrollViewportRef}
                        onScroll={handleScroll}
                      >
                        <div className="mx-auto max-w-7xl px-4 pt-4 pb-8 md:px-6 min-w-0 w-full">
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
                                    selectedBackend={selectedBackend}
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
                                No messages yet. Image something useful!
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
                                hideApproveButtons={isCodexBackend}
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
                                isStreamingPlanApproved={
                                  isStreamingPlanApproved
                                }
                                onStreamingPlanApproval={
                                  handleStreamingPlanApproval
                                }
                                onStreamingPlanApprovalYolo={
                                  handleStreamingPlanApprovalYolo
                                }
                                hideApproveButtons={isCodexBackend}
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
                        hideApproveButtons={isCodexBackend}
                        onStreamingPlanApproval={handleStreamingPlanApproval}
                        onPendingPlanApproval={
                          handlePendingPlanApprovalCallback
                        }
                        onScrollToFindings={scrollToFindings}
                        onScrollToBottom={scrollToBottom}
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
                    <div>
                      <div className="mx-auto max-w-7xl">
                        <div className="relative sm:mx-auto sm:mb-3 sm:max-w-3xl">
                          {/* Input area - unified container with textarea and toolbar */}
                          <form
                            ref={formRef}
                            onSubmit={handleSubmit}
                            className={cn(
                              'relative overflow-hidden border-t border-border bg-sidebar transition-[background-color,box-shadow] duration-150 sm:rounded-lg sm:border',
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

                            {/* Task widget - inline fallback for narrow screens */}
                            {activeTodos.length > 0 &&
                              (dismissedTodoMessageId === null ||
                                (todoSourceMessageId !== null &&
                                  todoSourceMessageId !==
                                    dismissedTodoMessageId)) && (
                                <div className="px-4 md:px-6 pt-2 xl:hidden">
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

                            {/* Agent widget - inline fallback for narrow screens */}
                            {activeAgents.length > 0 &&
                              (dismissedAgentMessageId === null ||
                                (agentSourceMessageId !== null &&
                                  agentSourceMessageId !==
                                    dismissedAgentMessageId)) && (
                                <div className="px-4 md:px-6 pt-2 xl:hidden">
                                  <AgentWidget
                                    agents={activeAgents}
                                    isStreaming={agentIsFromStreaming}
                                    onClose={() =>
                                      setDismissedAgentMessageId(
                                        agentSourceMessageId ?? '__streaming__'
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
                                canSwitchBackendWithTab={
                                  (session?.messages?.length ?? 0) === 0
                                }
                                focusChatShortcut={focusChatShortcut}
                                onSubmit={handleSubmit}
                                onCancel={handleCancel}
                                onSwitchBackendWithTab={handleTabBackendSwitch}
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
                              selectedBackend={selectedBackend}
                              sessionHasMessages={
                                (session?.messages?.length ?? 0) > 0
                              }
                              selectedModel={selectedModel}
                              selectedProvider={selectedProvider}
                              providerLocked={
                                (session?.messages?.length ?? 0) > 0
                              }
                              selectedThinkingLevel={selectedThinkingLevel}
                              selectedEffortLevel={selectedEffortLevel}
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
                              activeWorktreePath={activeWorktreePath}
                              worktreeId={activeWorktreeId ?? null}
                              activeSessionId={activeSessionId}
                              projectId={worktree?.project_id}
                              loadedIssueContexts={loadedIssueContexts ?? []}
                              loadedPRContexts={loadedPRContexts ?? []}
                              attachedSavedContexts={
                                attachedSavedContexts ?? []
                              }
                              onOpenMagicModal={handleOpenMagicModal}
                              onSaveContext={handleSaveContext}
                              onLoadContext={handleLoadContext}
                              onCommit={handleCommit}
                              onCommitAndPush={handleCommitAndPushWithPicker}
                              onOpenPr={handleOpenPr}
                              onReview={() => handleReview()}
                              onMerge={handleMerge}
                              onResolvePrConflicts={handleResolvePrConflicts}
                              onResolveConflicts={handleResolveConflicts}
                              hasOpenPr={Boolean(worktree?.pr_url)}
                              onSetDiffRequest={setDiffRequest}
                              installedBackends={installedBackends}
                              onBackendChange={handleToolbarBackendChange}
                              onModelChange={handleToolbarModelChange}
                              onProviderChange={handleToolbarProviderChange}
                              customCliProfiles={
                                preferences?.custom_cli_profiles ?? []
                              }
                              onThinkingLevelChange={
                                handleToolbarThinkingLevelChange
                              }
                              onEffortLevelChange={
                                handleToolbarEffortLevelChange
                              }
                              onSetExecutionMode={handleToolbarSetExecutionMode}
                              onCancel={handleCancel}
                              queuedMessageCount={currentQueuedMessages.length}
                              availableMcpServers={availableMcpServers}
                              enabledMcpServers={enabledMcpServers}
                              onToggleMcpServer={handleToggleMcpServer}
                              onOpenProjectSettings={handleOpenProjectSettings}
                            />
                          </form>

                          {/* Side panel widgets (Tasks + Agents) for wide screens */}
                          {(activeTodos.length > 0 ||
                            activeAgents.length > 0) && (
                            <div className="hidden xl:flex flex-col gap-2 absolute left-full bottom-0 ml-3 w-64 z-20">
                              {activeTodos.length > 0 &&
                                (dismissedTodoMessageId === null ||
                                  (todoSourceMessageId !== null &&
                                    todoSourceMessageId !==
                                      dismissedTodoMessageId)) && (
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
                                )}
                              {activeAgents.length > 0 &&
                                (dismissedAgentMessageId === null ||
                                  (agentSourceMessageId !== null &&
                                    agentSourceMessageId !==
                                      dismissedAgentMessageId)) && (
                                  <AgentWidget
                                    agents={activeAgents}
                                    isStreaming={agentIsFromStreaming}
                                    onClose={() =>
                                      setDismissedAgentMessageId(
                                        agentSourceMessageId ?? '__streaming__'
                                      )
                                    }
                                  />
                                )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </ResizablePanel>

                {/* Terminal panel - only render when panel is open (native app only, not in modal) */}
                {!isModal &&
                  isNativeApp() &&
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
        <Suspense fallback={null}>
          <GitDiffModal
            diffRequest={diffRequest}
            onClose={() => setDiffRequest(null)}
            onAddToPrompt={handleGitDiffAddToPrompt}
            onExecutePrompt={handleGitDiffExecutePrompt}
            uncommittedStats={{
              added: uncommittedAdded,
              removed: uncommittedRemoved,
            }}
            branchStats={{ added: branchDiffAdded, removed: branchDiffRemoved }}
          />
        </Suspense>

        {/* Single file diff modal for viewing edited file changes */}
        <FileDiffModal
          filePath={editedFilePath}
          worktreePath={activeWorktreePath ?? ''}
          onClose={() => setEditedFilePath(null)}
        />

        {/* Load Context modal for selecting saved contexts */}
        <Suspense fallback={null}>
          <LoadContextModal
            open={loadContextModalOpen}
            onOpenChange={handleLoadContextModalChange}
            worktreeId={activeWorktreeId}
            worktreePath={activeWorktreePath ?? null}
            activeSessionId={activeSessionId ?? null}
            projectName={worktree?.name ?? 'unknown-project'}
          />
        </Suspense>

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
              onApprove={handlePlanDialogApprove}
              onApproveYolo={handlePlanDialogApproveYolo}
              hideApproveButtons={isCodexBackend}
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
              onApprove={handlePlanDialogApprove}
              onApproveYolo={handlePlanDialogApproveYolo}
              hideApproveButtons={isCodexBackend}
            />
          ) : null)}

        {/* Recap dialog */}
        <RecapDialog
          digest={recapDialogDigest}
          isOpen={isRecapDialogOpen}
          onClose={() => {
            setIsRecapDialogOpen(false)
            setRecapDialogDigest(null)
          }}
          isGenerating={isGeneratingRecap}
          onRegenerate={() =>
            window.dispatchEvent(new CustomEvent('open-recap'))
          }
        />

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
