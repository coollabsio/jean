import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
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
  useCreateSession,
  cancelChatMessage,
} from '@/services/chat'
import { useWorktree, useProjects, useRunScript } from '@/services/projects'
import {
  githubQueryKeys,
  useLoadedIssueContexts,
  useLoadedPRContexts,
  useAttachedSavedContexts,
} from '@/services/github'
import type {
  LoadedIssueContext,
  LoadedPullRequestContext,
} from '@/types/github'
import {
  useChatStore,
  DEFAULT_THINKING_LEVEL,
} from '@/store/chat-store'
import { usePreferences } from '@/services/preferences'
import type { AiCliProvider } from '@/types/preferences'
import { getDefaultModelForProvider } from '@/types/preferences'
import type {
  ToolCall,
  ThinkingLevel,
  ContentBlock,
  PendingImage,
  PendingTextFile,
  PendingSkill,
  PermissionDenial,
  PendingFile,
} from '@/types/chat'
import { isAskUserQuestion, isExitPlanMode, isTodoWrite } from '@/types/chat'
import { getFilename } from '@/lib/path-utils'
import { cn } from '@/lib/utils'
import { PermissionApproval } from './PermissionApproval'
import { SetupScriptOutput } from './SetupScriptOutput'
import { SessionTabBar } from './SessionTabBar'
import { TodoWidget } from './TodoWidget'
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
import { QueuedMessagesList } from './QueuedMessageItem'
import { FloatingButtons } from './FloatingButtons'
import { StreamingMessage } from './StreamingMessage'
import { ErrorBanner } from './ErrorBanner'
import { SessionDigestReminder } from './SessionDigestReminder'
import {
  VirtualizedMessageList,
  type VirtualizedMessageListHandle,
} from './VirtualizedMessageList'
import { useUIStore } from '@/store/ui-store'
import { useGitStatus } from '@/services/git-status'
import { usePrStatus, usePrStatusEvents } from '@/services/pr-status'
import type { PrDisplayStatus, CheckStatus } from '@/types/pr-status'
import type { QueuedMessage, ExecutionMode } from '@/types/chat'
import type { DiffRequest } from '@/types/git-diff'
import { isBaseSession } from '@/types/projects'
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
import { useMagicCommands } from './hooks/useMagicCommands'
import { useDragAndDropImages } from './hooks/useDragAndDropImages'

/** Check if we're in development mode */
const isDev = import.meta.env.DEV

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

export function ChatWindow() {
  // PERFORMANCE: Use focused selectors instead of whole-store destructuring
  // This prevents re-renders when other sessions' state changes (e.g., streaming chunks)

  // Stable values that don't change per-session
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  // PERFORMANCE: Proper selector for activeSessionId - subscribes to changes
  // This triggers re-render when tabs are clicked (setActiveSession updates activeSessionIds)
  // Without this, ChatWindow wouldn't know when to re-render on tab switch
  let activeSessionId = useChatStore(state =>
    state.activeWorktreeId
      ? state.activeSessionIds[state.activeWorktreeId]
      : undefined
  )

  // Function selectors - these return stable function references
  const checkIsSending = useChatStore(state => state.isSending)
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
  // PERFORMANCE: Proper selector for isViewingReviewTab - subscribes to actual data
  const isViewingReviewTab = useChatStore(state =>
    state.activeWorktreeId
      ? (state.viewingReviewTab[state.activeWorktreeId] ?? false)
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
  const { data: sessionsData, isLoading: isSessionsLoading } = useSessions(
    activeWorktreeId,
    activeWorktreePath
  )

  // Sync active session from backend if store doesn't have one
  useEffect(() => {
    if (!activeWorktreeId || !sessionsData) return

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
  }, [sessionsData, activeWorktreeId])

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
  const sendMessage = useSendMessage()
  const createSession = useCreateSession()
  const setSessionModel = useSetSessionModel()
  const setSessionThinkingLevel = useSetSessionThinkingLevel()

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
    activeWorktreeId ?? null
  )

  // Loaded PR contexts for indicator and investigate PR functionality
  const { data: loadedPRContexts } = useLoadedPRContexts(
    activeWorktreeId ?? null
  )

  // Emit readiness event for auto-investigate coordination
  // When a worktree is marked for auto-investigate, projects.ts waits for this event
  // before dispatching the magic-command, ensuring session and contexts are ready
  useEffect(() => {
    if (!activeWorktreeId || !activeSessionId) return

    // Check if this worktree was marked for auto-investigate
    const { autoInvestigateWorktreeIds, autoInvestigatePRWorktreeIds } =
      useUIStore.getState()
    const shouldInvestigateIssue =
      autoInvestigateWorktreeIds.has(activeWorktreeId)
    const shouldInvestigatePR =
      autoInvestigatePRWorktreeIds.has(activeWorktreeId)

    if (!shouldInvestigateIssue && !shouldInvestigatePR) return

    // Wait for contexts to be loaded
    const hasIssueContexts =
      shouldInvestigateIssue &&
      loadedIssueContexts &&
      loadedIssueContexts.length > 0
    const hasPRContexts =
      shouldInvestigatePR && loadedPRContexts && loadedPRContexts.length > 0

    if (hasIssueContexts) {
      window.dispatchEvent(
        new CustomEvent('chat-ready-for-investigate', {
          detail: { worktreeId: activeWorktreeId, type: 'issue' },
        })
      )
    }
    if (hasPRContexts) {
      window.dispatchEvent(
        new CustomEvent('chat-ready-for-investigate', {
          detail: { worktreeId: activeWorktreeId, type: 'pr' },
        })
      )
    }
  }, [activeWorktreeId, activeSessionId, loadedIssueContexts, loadedPRContexts])

  // Attached saved contexts for indicator
  const { data: attachedSavedContexts } = useAttachedSavedContexts(
    activeWorktreeId ?? null
  )
  // Use live status if available, otherwise fall back to cached
  const behindCount =
    gitStatus?.behind_count ?? worktree?.cached_behind_count ?? 0
  const aheadCount =
    gitStatus?.unpushed_count ?? worktree?.cached_unpushed_count ?? 0
  const hasBranchUpdates = behindCount > 0
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

  // Per-session provider selection, falls back to preferences default
  const defaultProvider: AiCliProvider =
    (preferences?.default_ai_provider as AiCliProvider) ?? 'claude'
  const sessionProvider: AiCliProvider =
    (session?.selected_provider as AiCliProvider) ?? defaultProvider

  // Per-session model selection, falls back to default for current provider
  const defaultModelForSession = getDefaultModelForProvider(sessionProvider)
  const sessionModel = (session?.selected_model as string) ?? defaultModelForSession

  // Local state for immediate UI updates when user changes provider/model
  // This avoids showing stale values while waiting for session mutation to complete
  const [displayProvider, setDisplayProvider] = useState<AiCliProvider>(sessionProvider)
  const [displayModel, setDisplayModel] = useState<string>(sessionModel)

  // Sync display state ONLY when session ID changes (switching chats)
  // We intentionally DON'T include sessionProvider/sessionModel in deps because:
  // 1. User changes provider via dropdown -> setDisplayProvider/setDisplayModel called immediately
  // 2. Mutation saves to backend -> query invalidated -> sessionProvider/sessionModel update
  // 3. If we synced here, we'd overwrite display state with potentially stale/partial data
  // The display state is the source of truth for UI; session data is for persistence
  const prevSessionIdRef = useRef(activeSessionId)
  useEffect(() => {
    // Only sync when switching to a DIFFERENT session
    if (prevSessionIdRef.current !== activeSessionId) {
      prevSessionIdRef.current = activeSessionId
      setDisplayProvider(sessionProvider)
      setDisplayModel(sessionModel)
    }
  }, [activeSessionId, sessionProvider, sessionModel])

  // Use display values for UI, refs for sending messages
  const selectedProvider = displayProvider
  const selectedModel = displayModel

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

  // Only show "Thinking..." for this specific session (uses activeSessionId for immediate feedback)
  const isSending = activeSessionId ? checkIsSending(activeSessionId) : false

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
    return (
      (images?.length ?? 0) > 0 ||
      (textFiles?.length ?? 0) > 0 ||
      (files?.length ?? 0) > 0
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
  const selectedProviderRef = useRef(selectedProvider)
  const selectedModelRef = useRef(selectedModel)
  const selectedThinkingLevelRef = useRef(selectedThinkingLevel)
  const executionModeRef = useRef(executionMode)

  // Keep refs in sync with current values (runs on every render, but cheap)
  activeSessionIdRef.current = activeSessionId
  activeWorktreeIdRef.current = activeWorktreeId
  activeWorktreePathRef.current = activeWorktreePath
  // NOTE: Provider/model refs are NOT synced here on every render because:
  // 1. User clicks dropdown to change provider -> handleToolbarProviderChange updates ref
  // 2. Mutation starts -> triggers re-render
  // 3. If we sync ref here, it would overwrite with old session data (not updated yet)
  // 4. User sends message -> would use old provider instead of the one they just selected
  // Instead, refs are ONLY updated in the change handlers and when session ID changes (see useEffect below)
  selectedThinkingLevelRef.current = selectedThinkingLevel
  executionModeRef.current = executionMode

  // Sync provider/model refs ONLY when session ID changes (switching chats)
  // This ensures we load the stored preferences for the new session
  // We intentionally don't include selectedProvider/selectedModel in deps because:
  // - They change AFTER the mutation completes
  // - But the refs were already set by the change handlers BEFORE the mutation
  // - If we sync here on every provider/model change, we'd overwrite with stale session data
  useEffect(() => {
    selectedProviderRef.current = selectedProvider
    selectedModelRef.current = selectedModel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // Ref for approve button (passed to VirtualizedMessageList)
  const approveButtonRef = useRef<HTMLButtonElement>(null)
  const pendingInvestigateRef = useRef(false)

  // Terminal panel ref for imperative collapse/expand
  const terminalPanelRef = useRef<ImperativePanelHandle>(null)

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

  // Listen for global run command from keybinding (CMD+R by default)
  useEffect(() => {
    const handleToggleWorkspaceRun = () => {
      if (!activeWorktreeId || !runScript) return
      useTerminalStore.getState().startRun(activeWorktreeId, runScript)
    }

    window.addEventListener('toggle-workspace-run', handleToggleWorkspaceRun)
    return () =>
      window.removeEventListener(
        'toggle-workspace-run',
        handleToggleWorkspaceRun
      )
  }, [activeWorktreeId, runScript])

  // Global Cmd+Option+Backspace (Mac) / Ctrl+Alt+Backspace (Windows/Linux) listener for cancellation
  // (works even when textarea is disabled)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === 'Backspace' &&
        (e.metaKey || e.ctrlKey) &&
        e.altKey &&
        isSending &&
        activeSessionId &&
        activeWorktreeId
      ) {
        e.preventDefault()
        cancelChatMessage(activeSessionId, activeWorktreeId)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isSending, activeSessionId, activeWorktreeId])

  // Note: Streaming event listeners are in App.tsx, not here
  // This ensures they stay active even when ChatWindow is unmounted (e.g., session board view)

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
      // Capture the execution mode this message is being sent with
      setExecutingMode(activeSessionId, queuedMsg.executionMode)
      // Track the model being used for this session (needed for permission approval flow)
      setSelectedModel(activeSessionId, queuedMsg.model)

      // Get session-approved tools to include
      const sessionApprovedTools = getApprovedTools(activeSessionId)

      // Build base allowed tools (git always, web tools if enabled)
      const webTools = preferences?.allow_web_tools_in_plan_mode
        ? ['WebFetch', 'WebSearch']
        : []
      const baseAllowedTools = [...GIT_ALLOWED_TOOLS, ...webTools]

      const allowedTools =
        sessionApprovedTools.length > 0
          ? [...baseAllowedTools, ...sessionApprovedTools]
          : baseAllowedTools.length > GIT_ALLOWED_TOOLS.length
            ? baseAllowedTools
            : undefined

      // Build full message with attachment refs for backend
      const fullMessage = buildMessageWithRefs(queuedMsg)

      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message: fullMessage,
          provider: queuedMsg.provider,
          model: queuedMsg.model,
          executionMode: queuedMsg.executionMode,
          thinkingLevel: queuedMsg.thinkingLevel,
          disableThinkingForMode: queuedMsg.disableThinkingForMode,
          parallelExecutionPromptEnabled:
            preferences?.parallel_execution_prompt_enabled ?? false,
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
      preferences?.parallel_execution_prompt_enabled,
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
      sendMessage.mutate(
        {
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          message,
          model,
          executionMode: 'build',
          thinkingLevel,
          disableThinkingForMode: thinkingLevel !== 'off' && !hasManualOverride,
          parallelExecutionPromptEnabled:
            preferences?.parallel_execution_prompt_enabled ?? false,
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

      // Need either text, images, files, or text files to send
      if (
        !textMessage &&
        images.length === 0 &&
        files.length === 0 &&
        textFiles.length === 0
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
        id: crypto.randomUUID(),
        message,
        pendingImages: images,
        pendingFiles: files,
        pendingSkills: skills,
        pendingTextFiles: textFiles,
        provider: selectedProviderRef.current,
        model: selectedModelRef.current,
        executionMode: mode,
        thinkingLevel: thinkingLvl,
        disableThinkingForMode:
          mode !== 'plan' && thinkingLvl !== 'off' && !hasManualOverride,
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
  const handleToolbarProviderChange = useCallback(
    (provider: AiCliProvider) => {
      // Update refs immediately for next message send (don't wait for query refetch)
      selectedProviderRef.current = provider
      const newDefaultModel = getDefaultModelForProvider(provider)
      selectedModelRef.current = newDefaultModel

      // Update display state immediately for UI
      setDisplayProvider(provider)
      setDisplayModel(newDefaultModel)

      // Gemini and Codex don't support plan mode well - auto-switch to build if currently in plan
      // Gemini CLI only has YOLO mode, Codex keeps asking questions instead of implementing
      if ((provider === 'gemini' || provider === 'codex') && executionModeRef.current === 'plan') {
        executionModeRef.current = 'build'
        if (activeSessionId) {
          setExecutionMode(activeSessionId, 'build')
        }
      }

      // Save provider AND model to session (per-session persistence)
      if (activeSessionId && activeWorktreeId && activeWorktreePath) {
        setSessionModel.mutate({
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          provider,
          model: newDefaultModel,
        })
      }
    },
    [activeSessionId, activeWorktreeId, activeWorktreePath, setSessionModel, setExecutionMode]
  )

  const handleToolbarModelChange = useCallback(
    (model: string) => {
      // Update ref immediately for next message send
      selectedModelRef.current = model

      // Update display state immediately for UI
      setDisplayModel(model)

      if (activeSessionId && activeWorktreeId && activeWorktreePath) {
        setSessionModel.mutate({
          sessionId: activeSessionId,
          worktreeId: activeWorktreeId,
          worktreePath: activeWorktreePath,
          model,
        })
      }
    },
    [activeSessionId, activeWorktreeId, activeWorktreePath, setSessionModel]
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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutate is stable, refs used for IDs
    []
  )

  const handleToolbarSetExecutionMode = useCallback(
    (mode: ExecutionMode) => {
      if (activeSessionId) {
        setExecutionMode(activeSessionId, mode)
      }
    },
    [activeSessionId, setExecutionMode]
  )

  const handleOpenMagicModal = useCallback(() => {
    useUIStore.getState().setMagicModalOpen(true)
  }, [])

  // Handle investigate context - sends prompt to analyze loaded issue(s) and/or PR(s)
  // If nothing is loaded, opens the Load Context modal instead
  const handleInvestigate = useCallback(async () => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    if (!sessionId || !worktreeId || !worktreePath) {
      toast.error('No active session')
      return
    }

    // Fetch both loaded issues and PRs in parallel
    const [loadedIssues, loadedPRs] = await Promise.all([
      queryClient.fetchQuery({
        queryKey: githubQueryKeys.loadedContexts(worktreeId),
        queryFn: () =>
          invoke<LoadedIssueContext[]>('list_loaded_issue_contexts', {
            worktreeId,
          }),
        staleTime: 1000 * 60,
      }),
      queryClient.fetchQuery({
        queryKey: githubQueryKeys.loadedPrContexts(worktreeId),
        queryFn: () =>
          invoke<LoadedPullRequestContext[]>('list_loaded_pr_contexts', {
            worktreeId,
          }),
        staleTime: 1000 * 60,
      }),
    ])

    const hasIssues = loadedIssues && loadedIssues.length > 0
    const hasPRs = loadedPRs && loadedPRs.length > 0

    // If nothing loaded, open the Load Context modal and re-trigger on close
    if (!hasIssues && !hasPRs) {
      pendingInvestigateRef.current = true
      setLoadContextModalOpen(true)
      return
    }

    // Build combined prompt from loaded issues and/or PRs
    const promptParts: string[] = []

    if (hasIssues) {
      const issueRefs = loadedIssues.map(i => `#${i.number}`).join(', ')
      const issueWord = loadedIssues.length === 1 ? 'issue' : 'issues'
      const customPrompt = preferences?.magic_prompts?.investigate_issue
      const issueTemplate =
        customPrompt && customPrompt.trim()
          ? customPrompt
          : `Investigate the loaded GitHub {issueWord} ({issueRefs}).

## Investigation Steps

1. **Read the issue context file(s)** to understand the full problem description and comments.

2. **Analyze the problem**:
   - What is the expected vs actual behavior?
   - Are there error messages, stack traces, or reproduction steps?

3. **Explore the codebase** to find relevant code:
   - Search for files/functions mentioned in the {issueWord}
   - Read source files to understand current implementation
   - Trace the affected code path

4. **Identify root cause**:
   - Where does the bug originate OR where should the feature be implemented?
   - What constraints/edge cases need handling?
   - Any related issues or tech debt?

5. **Check for regression**:
   - If this is a bug fix, determine if this is a regression (something that worked before)
   - Look at git history or related code to understand if the feature previously worked
   - Identify what change may have caused the regression

6. **Propose solution**:
   - Clear explanation of needed changes
   - Specific files to modify
   - Potential risks/trade-offs
   - Test cases to verify

## Guidelines

- Be thorough but focused - investigate deeply without getting sidetracked
- Ask clarifying questions if requirements are unclear
- If multiple solutions exist, explain trade-offs
- Reference specific file paths and line numbers

Begin your investigation now.`

      promptParts.push(
        issueTemplate
          .replace(/\{issueRefs\}/g, issueRefs)
          .replace(/\{issueWord\}/g, issueWord)
      )
    }

    if (hasPRs) {
      const prRefs = loadedPRs.map(pr => `#${pr.number}`).join(', ')
      const prWord = loadedPRs.length === 1 ? 'pull request' : 'pull requests'
      const customPrompt = preferences?.magic_prompts?.investigate_pr
      const prTemplate =
        customPrompt && customPrompt.trim()
          ? customPrompt
          : `Investigate the loaded GitHub {prWord} ({prRefs}).

## Investigation Steps

1. **Read the PR context file(s)** to understand the full description, reviews, and comments.

2. **Understand the changes**:
   - What is the PR trying to accomplish?
   - What branches are involved (head → base)?
   - Are there any review comments or requested changes?

3. **Explore the codebase** to understand the context:
   - Check out the PR branch if needed
   - Read the files being modified
   - Understand the current implementation

4. **Analyze the approach**:
   - Does the implementation match the PR description?
   - Are there any concerns raised in reviews?
   - What feedback has been given?

5. **Identify action items**:
   - What changes are requested by reviewers?
   - Are there any failing checks or tests?
   - What needs to be done to get this PR merged?

6. **Propose next steps**:
   - Address reviewer feedback
   - Specific files to modify
   - Test cases to add or update

## Guidelines

- Be thorough but focused - investigate deeply without getting sidetracked
- Pay attention to reviewer feedback and requested changes
- If multiple approaches exist, explain trade-offs
- Reference specific file paths and line numbers

Begin your investigation now.`

      promptParts.push(
        prTemplate.replace(/\{prRefs\}/g, prRefs).replace(/\{prWord\}/g, prWord)
      )
    }

    const prompt = promptParts.join('\n\n---\n\n')

    // Send message
    const investigateModel =
      preferences?.magic_prompt_models?.investigate_model ??
      selectedModelRef.current

    const {
      addSendingSession,
      setLastSentMessage,
      setError,
      setSelectedModel,
      setExecutingMode,
    } = useChatStore.getState()

    setLastSentMessage(sessionId, prompt)
    setError(sessionId, null)
    addSendingSession(sessionId)
    setSelectedModel(sessionId, investigateModel)
    setExecutingMode(sessionId, executionModeRef.current)

    sendMessage.mutate(
      {
        sessionId,
        worktreeId,
        worktreePath,
        message: prompt,
        model: investigateModel,
        executionMode: executionModeRef.current,
        thinkingLevel: selectedThinkingLevelRef.current,
        parallelExecutionPromptEnabled:
          preferences?.parallel_execution_prompt_enabled ?? false,
        aiLanguage: preferences?.ai_language,
      },
      { onSettled: () => inputRef.current?.focus() }
    )
  }, [
    queryClient,
    sendMessage,
    setLoadContextModalOpen,
    preferences?.magic_prompts?.investigate_issue,
    preferences?.magic_prompts?.investigate_pr,
    preferences?.magic_prompt_models?.investigate_model,
    preferences?.parallel_execution_prompt_enabled,
    preferences?.ai_language,
  ])

  // Wraps modal open/close to auto-trigger investigation after user loads context
  const handleLoadContextModalChange = useCallback(
    async (open: boolean) => {
      setLoadContextModalOpen(open)
      if (!open && pendingInvestigateRef.current) {
        pendingInvestigateRef.current = false
        // Only re-trigger investigate if the user actually loaded contexts
        const worktreeId = activeWorktreeIdRef.current
        if (!worktreeId) return
        const [loadedIssues, loadedPRs] = await Promise.all([
          queryClient.fetchQuery({
            queryKey: githubQueryKeys.loadedContexts(worktreeId),
            queryFn: () =>
              invoke<LoadedIssueContext[]>('list_loaded_issue_contexts', {
                worktreeId,
              }),
            staleTime: 1000 * 60,
          }),
          queryClient.fetchQuery({
            queryKey: githubQueryKeys.loadedPrContexts(worktreeId),
            queryFn: () =>
              invoke<LoadedPullRequestContext[]>('list_loaded_pr_contexts', {
                worktreeId,
              }),
            staleTime: 1000 * 60,
          }),
        ])
        if (
          (loadedIssues && loadedIssues.length > 0) ||
          (loadedPRs && loadedPRs.length > 0)
        ) {
          handleInvestigate()
        }
      }
    },
    [setLoadContextModalOpen, handleInvestigate, queryClient]
  )

  // Handle checkout PR - opens modal to select and checkout a PR to a new worktree
  const handleCheckoutPR = useCallback(() => {
    useUIStore.getState().setCheckoutPRModalOpen(true)
  }, [])

  // Listen for magic-command events from MagicModal
  useMagicCommands({
    handleSaveContext,
    handleLoadContext,
    handleCommit,
    handleCommitAndPush,
    handleOpenPr,
    handleReview,
    handleMerge,
    handleResolveConflicts,
    handleInvestigate,
    handleCheckoutPR,
  })

  // Listen for command palette context events
  useEffect(() => {
    const handleSaveContextEvent = () => handleSaveContext()
    const handleLoadContextEvent = () => handleLoadContext()
    const handleRunScriptEvent = () => {
      if (!activeWorktreeId || !runScript) return
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
    selectedProviderRef,
    selectedModelRef,
    executionModeRef,
    selectedThinkingLevelRef,
    sendMessage,
    queryClient,
    scrollToBottom,
    inputRef,
    pendingPlanMessage,
  })

  // Listen for approve-plan keyboard shortcut event
  useEffect(() => {
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
    hasStreamingPlan,
    pendingPlanMessage,
    handleStreamingPlanApproval,
    handlePlanApproval,
  ])

  // Listen for review-fix-message events from ReviewResultsPanel
  // This allows the panel to trigger message sends without prop drilling
  useEffect(() => {
    const handleReviewFixMessage = (e: CustomEvent) => {
      const { worktreeId, worktreePath, message, createNewSession } = e.detail
      if (!worktreeId || !worktreePath || !message) return

      const sendFixMessage = (targetSessionId: string) => {
        const {
          addSendingSession,
          setSelectedModel,
          setViewingReviewTab,
          setExecutingMode,
          setLastSentMessage,
          setError,
        } = useChatStore.getState()

        // Switch back to chat view to show the fix message
        setViewingReviewTab(worktreeId, false)

        // Send the fix message
        setLastSentMessage(targetSessionId, message)
        setError(targetSessionId, null)
        addSendingSession(targetSessionId)
        setSelectedModel(targetSessionId, selectedModelRef.current)
        setExecutingMode(targetSessionId, 'build') // Always use build mode for fixes
        const thinkingLvl = selectedThinkingLevelRef.current
        const hasManualOverride = useChatStore
          .getState()
          .hasManualThinkingOverride(targetSessionId)
        sendMessage.mutate(
          {
            sessionId: targetSessionId,
            worktreeId,
            worktreePath,
            message,
            model: selectedModelRef.current,
            executionMode: 'build', // Always use build mode for fixes
            thinkingLevel: thinkingLvl,
            // Build mode: disable thinking if preference enabled and no manual override
            disableThinkingForMode: thinkingLvl !== 'off' && !hasManualOverride,
            parallelExecutionPromptEnabled:
              preferences?.parallel_execution_prompt_enabled ?? false,
            aiLanguage: preferences?.ai_language,
          },
          {
            onSettled: () => {
              inputRef.current?.focus()
            },
          }
        )
      }

      if (createNewSession) {
        // Create a new session first, then send the message
        createSession.mutate(
          { worktreeId, worktreePath },
          {
            onSuccess: session => {
              useChatStore.getState().setActiveSession(worktreeId, session.id)
              sendFixMessage(session.id)
            },
          }
        )
      } else {
        // Use existing session (legacy behavior, shouldn't happen with new code)
        const { sessionId } = e.detail
        if (sessionId) {
          sendFixMessage(sessionId)
        }
      }
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
  }, [sendMessage, createSession])

  // Handle removing a queued message
  const handleRemoveQueuedMessage = useCallback(
    (sessionId: string, messageId: string) => {
      useChatStore.getState().removeQueuedMessage(sessionId, messageId)
    },
    []
  )

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
        id: crypto.randomUUID(),
        message: commandName,
        pendingImages: [],
        pendingFiles: [],
        pendingSkills: [],
        pendingTextFiles: [],
        provider: selectedProviderRef.current,
        model: selectedModelRef.current,
        executionMode: executionModeRef.current,
        thinkingLevel: selectedThinkingLevelRef.current,
        disableThinkingForMode: false,
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
      fallback={
        <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
          <span>Something went wrong. Please refresh the page.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Refresh
          </Button>
        </div>
      }
    >
      <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
        {/* Session tab bar */}
        <SessionTabBar
          worktreeId={activeWorktreeId}
          worktreePath={activeWorktreePath}
          projectId={worktree?.project_id}
          isBase={worktree?.session_type === 'base'}
        />

        {/* Review results panel (when review tab is active) */}
        {isViewingReviewTab ? (
          <ReviewResultsPanel worktreeId={activeWorktreeId} />
        ) : (
          <ResizablePanelGroup direction="vertical" className="flex-1">
            <ResizablePanel
              defaultSize={terminalVisible ? 70 : 100}
              minSize={30}
            >
              <div className="relative flex h-full flex-col">
                {/* Messages area - with padding at bottom for floating input */}
                <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden pb-32">
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
                        {/* Debug info (dev mode only) */}
                        {isDev && activeWorktreeId && activeWorktreePath && activeSessionId && (
                          <div className="text-[0.625rem] text-muted-foreground/50 bg-muted/30 rounded font-mono">
                            <SessionDebugPanel
                              worktreeId={activeWorktreeId}
                              worktreePath={activeWorktreePath}
                              sessionId={activeSessionId}
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
                    onStreamingPlanApproval={handleStreamingPlanApproval}
                    onPendingPlanApproval={handlePendingPlanApprovalCallback}
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

                {/* Input container */}
                <div className="absolute bottom-0 left-0 right-0 px-4 pb-4 md:px-6 pointer-events-none">
                  <div className="mx-auto max-w-4xl pointer-events-auto">
                    {/* Pending file preview (@ mentions) */}
                    <FilePreview
                      files={currentPendingFiles}
                      onRemove={handleRemovePendingFile}
                      disabled={isSending}
                    />

                    {/* Pending image preview */}
                    <ImagePreview
                      images={currentPendingImages}
                      onRemove={handleRemovePendingImage}
                      disabled={isSending}
                    />

                    {/* Pending text file preview */}
                    <TextFilePreview
                      textFiles={currentPendingTextFiles}
                      onRemove={handleRemovePendingTextFile}
                      disabled={isSending}
                    />

                    {/* Pending skills preview */}
                    {currentPendingSkills.length > 0 && (
                      <div className="px-4 md:px-6 pt-2 flex flex-wrap gap-2">
                        {currentPendingSkills.map(skill => (
                          <SkillBadge
                            key={skill.id}
                            skill={skill}
                            onRemove={() => handleRemovePendingSkill(skill.id)}
                          />
                        ))}
                      </div>
                    )}

                    {/* Task widget - shows current session's active todos */}
                    {/* Show if: has todos AND (no dismissal OR source differs from dismissed message) */}
                    {activeTodos.length > 0 &&
                      (dismissedTodoMessageId === null ||
                        (todoSourceMessageId !== null &&
                          todoSourceMessageId !== dismissedTodoMessageId)) && (
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

                    {/* Input area - floating container with textarea and toolbar */}
                    <form
                      ref={formRef}
                      onSubmit={handleSubmit}
                      className={cn(
                        'pointer-events-auto relative rounded-2xl border border-border/50 bg-background shadow-lg transition-all duration-150',
                        isDragging &&
                          'ring-2 ring-primary ring-inset bg-primary/5'
                      )}
                    >
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
                        selectedProvider={selectedProvider}
                        selectedModel={selectedModel}
                        selectedThinkingLevel={selectedThinkingLevel}
                        thinkingOverrideActive={
                          executionMode !== 'plan' &&
                          selectedThinkingLevel !== 'off' &&
                          !hasManualThinkingOverride
                        }
                        queuedMessageCount={currentQueuedMessages.length}
                        hasBranchUpdates={hasBranchUpdates}
                        behindCount={behindCount}
                        aheadCount={aheadCount}
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
                        loadedIssueContexts={loadedIssueContexts ?? []}
                        loadedPRContexts={loadedPRContexts ?? []}
                        attachedSavedContexts={attachedSavedContexts ?? []}
                        onOpenMagicModal={handleOpenMagicModal}
                        onSaveContext={handleSaveContext}
                        onLoadContext={handleLoadContext}
                        onCommit={handleCommit}
                        onOpenPr={handleOpenPr}
                        onReview={handleReview}
                        onMerge={handleMerge}
                        onResolvePrConflicts={handleResolvePrConflicts}
                        onResolveConflicts={handleResolveConflicts}
                        isBaseSession={worktree ? isBaseSession(worktree) : true}
                        hasOpenPr={Boolean(worktree?.pr_url)}
                        onSetDiffRequest={setDiffRequest}
                        onProviderChange={handleToolbarProviderChange}
                        onModelChange={handleToolbarModelChange}
                        onThinkingLevelChange={handleToolbarThinkingLevelChange}
                        onSetExecutionMode={handleToolbarSetExecutionMode}
                        onCancel={handleCancel}
                      />
                    </form>
                  </div>
                </div>
              </div>
            </ResizablePanel>

            {/* Terminal panel - only render when panel is open */}
            {activeWorktreePath && terminalPanelOpen && (
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
