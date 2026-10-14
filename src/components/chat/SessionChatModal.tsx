import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react'
import {
  Archive,
  Copy,
  GitBranchPlus,
  GitPullRequestArrow,
  Globe,
  Maximize,
  Minimize,
  Pencil,
  RefreshCw,
  Tag,
  Play,
  Plus,
  Terminal,
  Trash2,
} from '@/components/icons/reicon'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { DismissButton } from '@/components/ui/dismiss-button'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { GitStatusBadges } from '@/components/ui/git-status-badges'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import {
  CloseWorktreeDialog,
  type CloseConfirmMode,
} from './CloseWorktreeDialog'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useBrowserStore } from '@/store/browser-store'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import {
  useSessions,
  useSession,
  useCreateSession,
  useClearSessionHistory,
  useRenameSession,
  reconnectNativeCliSession,
  canReconnectSession,
} from '@/services/chat'
import { resolveBackendCliPath } from '@/services/cli-binary'
import { usePreferences } from '@/services/preferences'
import { parseServerResourceKey } from '@/lib/server-resource'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { usePackageScripts, type PackageScript } from '@/services/projects'
import { useGitHubPRs } from '@/services/github'
import { useGitStatus, performGitSync } from '@/services/git-status'
import { isBaseSession, type Project, type Worktree } from '@/types/projects'
import type { Session } from '@/types/chat'
import { isNativeApp } from '@/lib/environment'
import { isImeComposingEvent } from '@/lib/ime-composition'
import { copyToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { ChatWindow } from './ChatWindow'
import { ModalTerminalDrawer } from './ModalTerminalDrawer'
import { ModalBrowserDrawer } from '@/components/browser/ModalBrowserDrawer'
import { OpenInButton } from '@/components/open-in/OpenInButton'
import { ScriptsButton } from '@/components/open-in/ScriptsButton'
import { DevToolsDropdown } from './DevToolsDropdown'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import {
  buildNativeClientSessionInput,
  createSessionCardDataCache,
  getResumeCommand,
  isActionableWaitingStatus,
  statusConfig,
  type SessionCardData,
} from './session-card-utils'
import {
  resolveModalSessionId,
  sessionsForTabBar,
  sortSessionCardsForTabs,
} from './session-tab-order'
import { useCanvasStoreState } from './hooks/useCanvasStoreState'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { WorktreeDropdownMenu } from '@/components/projects/WorktreeDropdownMenu'
import { LabelModal } from './LabelModal'
import { useSessionArchive } from './hooks/useSessionArchive'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  isModOnlyHeld,
  useModifierHintsVisible,
} from '@/hooks/useModifierHintsVisible'
import { pushNeedsRemotePicker, useRemotePicker } from '@/hooks/useRemotePicker'
import { useIsTouchDevice } from '@/hooks/use-touch-device'
import { useSwipeBack } from '@/hooks/useSwipeBack'
import {
  MODAL_TERMINAL_PRIMARY_ROW_CLASS,
  MODAL_TERMINAL_SECONDARY_ROW_CLASS,
} from './modal-terminal-layout'
import {
  getStackedBaseBranch,
  resolveStackedOnPr,
} from './worktree-branch-badge'
import { isUnreadSession } from '@/components/unread/unread-utils'

/** Track whether any waiting tabs are off-screen to the left or right */
function useOffScreenWaiting(
  sortedCards: SessionCardData[],
  viewportRef: RefObject<HTMLDivElement | null>
) {
  const [hasLeft, setHasLeft] = useState(false)
  const [hasRight, setHasRight] = useState(false)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const waitingIds = sortedCards.flatMap(c =>
      isActionableWaitingStatus(c.status) ? [c.session.id] : []
    )

    if (waitingIds.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasLeft(false)
      setHasRight(false)
      return
    }

    const check = () => {
      const { scrollLeft, clientWidth } = viewport
      let left = false
      let right = false
      for (const id of waitingIds) {
        const el = viewport.querySelector(
          `[data-session-id="${id}"]`
        ) as HTMLElement | null
        if (!el) continue
        if (el.offsetLeft + el.offsetWidth <= scrollLeft) left = true
        else if (el.offsetLeft >= scrollLeft + clientWidth) right = true
      }
      setHasLeft(left)
      setHasRight(right)
    }

    check()
    viewport.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(check)
    ro.observe(viewport)
    return () => {
      viewport.removeEventListener('scroll', check)
      ro.disconnect()
    }
  }, [sortedCards, viewportRef])

  return { hasLeft, hasRight }
}

function HeaderSurfaceToggle({
  label,
  icon: Icon,
  isOpen,
  shortcut,
  onClick,
}: {
  label: string
  icon: typeof Terminal
  isOpen: boolean
  shortcut: string | undefined
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-7 w-7 text-muted-foreground hover:text-foreground',
            isOpen && 'bg-muted text-foreground'
          )}
          aria-label={`Toggle ${label.toLowerCase()}`}
          aria-pressed={isOpen}
          onClick={onClick}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {isNativeApp() && (
          <kbd className="ml-1 text-[0.625rem] opacity-60">
            {formatShortcutDisplay(shortcut)}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

interface SessionChatModalProps {
  worktreeId: string
  worktreePath: string
  worktree: Worktree | null
  project: Project | null
  isOpen: boolean
  onClose: () => void
  onRequestCloseWorktree: () => void
}

export const SessionChatModal = memo(function SessionChatModal({
  worktreeId,
  worktreePath,
  worktree,
  project,
  isOpen,
  onClose,
  onRequestCloseWorktree,
}: SessionChatModalProps) {
  const isMobile = useIsMobile()
  const isTouch = useIsTouchDevice()
  const zenMode = useUIStore(state => state.zenMode)
  const toggleZenMode = useUIStore(state => state.toggleZenMode)
  const isModalTerminalOpen = useTerminalStore(
    state => state.modalTerminalOpen[worktreeId] ?? false
  )
  const leftSidebarVisible = useUIStore(state => state.leftSidebarVisible)
  // While the Recent list is visible, Cmd/Ctrl+1-9 opens Recent sessions,
  // so the session tab number hints are hidden.
  const recentTabActive = useProjectsStore(
    state => state.sidebarActiveTab === 'recent'
  )
  const recentShortcutsActive = leftSidebarVisible && recentTabActive
  const showTabShortcutHints = useModifierHintsVisible(
    isModOnlyHeld,
    isOpen && isNativeApp() && !isMobile && !recentShortcutsActive
  )
  // Left-edge swipe right: open the sidebar without leaving the worktree.
  const swipeOpenSidebar = useCallback(() => {
    useUIStore.getState().setLeftSidebarVisible(true)
  }, [])
  const swipe = useSwipeBack({
    onSwipeBack: swipeOpenSidebar,
    enabled: isTouch && isOpen && !leftSidebarVisible,
    animateToEnd: false,
    visualFeedback: true,
  })
  useEffect(() => {
    useUIStore.getState().setLeftSidebarSwipe({
      isDragging: swipe.isSwiping,
      dragOffset: swipe.translateX,
      dragTransition: swipe.transitionStyle,
    })
  }, [swipe.isSwiping, swipe.translateX, swipe.transitionStyle])
  useEffect(() => {
    return () => {
      useUIStore.getState().setLeftSidebarSwipe({
        isDragging: false,
        dragOffset: 0,
        dragTransition: '',
      })
    }
  }, [])
  const { data: sessionsData } = useSessions(
    worktreeId || null,
    worktreePath || null,
    { refetchOnMount: 'always' }
  )
  const sessions = useMemo(
    () => sessionsData?.sessions ?? [],
    [sessionsData?.sessions]
  )
  // Active session from store. The chat can render from this id before the
  // worktree session list arrives. Keep that session in the tab row.
  const activeSessionId = useChatStore(
    state => state.activeSessionIds[worktreeId]
  )
  const activeSessionIsListed =
    !!activeSessionId &&
    sessions.some(session => session.id === activeSessionId)
  const { data: missingActiveSession, isError: missingActiveSessionFailed } =
    useSession(
      activeSessionIsListed ? null : (activeSessionId ?? null),
      worktreeId || null,
      worktreePath || null
    )
  // A deleted session keeps its id in the store (persisted UI state, other
  // clients). Once the list has loaded and the direct lookup fails, fall back
  // to a listed session so one tab is always selected.
  const activeSessionGone = !!sessionsData && missingActiveSessionFailed
  const currentSessionId = resolveModalSessionId(
    activeSessionId,
    sessions.map(session => session.id),
    sessionsData?.active_session_id,
    activeSessionGone
  )
  const tabSessions = useMemo(
    () =>
      sessionsForTabBar(
        sessions,
        activeSessionGone ? null : (missingActiveSession ?? null)
      ),
    [activeSessionGone, missingActiveSession, sessions]
  )
  const showSessionTabs = tabSessions.length > 0 || !!currentSessionId
  const serverId = parseServerResourceKey(worktreeId)?.serverId
  const { data: preferences } = usePreferences(serverId)
  const { data: packageScripts = [] } = usePackageScripts(worktreePath)
  const modalTerminalDockMode = useTerminalStore(
    state => state.modalTerminalDockMode
  )
  const hasBottomTerminal =
    isModalTerminalOpen && modalTerminalDockMode === 'bottom'
  const isBrowserModalOpen = useBrowserStore(
    state => state.modalOpen[worktreeId] ?? false
  )
  const browserModalDockMode = useBrowserStore(state => state.modalDockMode)
  const hasBottomBrowser =
    isBrowserModalOpen && browserModalDockMode === 'bottom'
  const hasBottomDock = hasBottomTerminal || hasBottomBrowser
  // Horizontal scroll on session tabs
  const modalTabScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const viewport = modalTabScrollRef.current
    if (!viewport) return

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        e.preventDefault()
        viewport.scrollLeft += e.deltaY
      }
    }

    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [showSessionTabs, zenMode])

  const currentSession =
    tabSessions.find(session => session.id === currentSessionId) ?? null
  // Canonical store state shared with canvas for consistent status derivation.
  const storeState = useCanvasStoreState()
  // Per-session card cache: a store update for one session only recomputes
  // that session's card instead of rescanning every tab's messages.
  const sessionCardDataCache = useMemo(() => createSessionCardDataCache(), [])
  // Compute card data once per session — same derivation as ProjectCanvasView,
  // so canvas badges and modal tab badges stay in sync.
  const cards = useMemo(
    () => tabSessions.map(s => sessionCardDataCache(s, storeState)),
    [sessionCardDataCache, storeState, tabSessions]
  )

  const cardForSession = useCallback(
    (id: string | null | undefined) =>
      id ? (cards.find(c => c.session.id === id) ?? null) : null,
    [cards]
  )

  // Track focused session's status so scroll fires when it changes position
  const currentSessionStatus =
    cardForSession(currentSession?.id)?.status ?? null

  // Auto-scroll active tab into view, including when modal opens or status changes
  useEffect(() => {
    if (!isOpen) return
    if (!currentSessionId) return
    const scrollId = requestAnimationFrame(() => {
      const viewport = modalTabScrollRef.current
      if (!viewport) return
      const activeTab = viewport.querySelector(
        `[data-session-id="${currentSessionId}"]`
      )
      if (activeTab) {
        activeTab.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        })
      }
    })
    return () => cancelAnimationFrame(scrollId)
  }, [isOpen, currentSessionId, tabSessions.length, currentSessionStatus])

  // The canvas already loaded the complete worktree and project records. Use
  // that snapshot for the first modal paint instead of issuing another query,
  // which briefly rendered an incomplete header on remote servers.
  const stackedBaseBranch = getStackedBaseBranch(
    worktree?.base_branch,
    worktree?.branch,
    project?.default_branch,
    worktree?.base_remote
  )
  const { data: openPRs } = useGitHubPRs(project?.path ?? null, 'open', {
    ownerId: project?.id,
  })
  const stackedOnPR = resolveStackedOnPr(
    stackedBaseBranch,
    openPRs,
    project?.default_branch
  )
  const isBase = worktree ? isBaseSession(worktree) : false
  const { data: gitStatus } = useGitStatus(worktreeId)
  const behindCount =
    gitStatus?.behind_count ?? worktree?.cached_behind_count ?? 0
  const unpushedCount =
    gitStatus?.unpushed_count ?? worktree?.cached_unpushed_count ?? 0
  const uncommittedAdded =
    gitStatus?.uncommitted_added ?? worktree?.cached_uncommitted_added ?? 0
  const uncommittedRemoved =
    gitStatus?.uncommitted_removed ?? worktree?.cached_uncommitted_removed ?? 0
  const branchDiffAdded =
    gitStatus?.branch_diff_added ?? worktree?.cached_branch_diff_added ?? 0
  const branchDiffRemoved =
    gitStatus?.branch_diff_removed ?? worktree?.cached_branch_diff_removed ?? 0
  const defaultBranch = project?.default_branch ?? 'main'

  const hasSetActiveRef = useRef<string | null>(null)

  // Set active session synchronously before paint
  useLayoutEffect(() => {
    if (
      isOpen &&
      currentSessionId &&
      hasSetActiveRef.current !== currentSessionId
    ) {
      const { setActiveSession } = useChatStore.getState()
      setActiveSession(worktreeId, currentSessionId)
      hasSetActiveRef.current = currentSessionId
    }
  }, [isOpen, currentSessionId, worktreeId])

  // Reset refs when modal closes
  useEffect(() => {
    if (!isOpen) {
      hasSetActiveRef.current = null
    }
  }, [isOpen])

  // Label modal state
  const [labelModalOpen, setLabelModalOpen] = useState(false)
  const [labelTargetSessionId, setLabelTargetSessionId] = useState<
    string | null
  >(null)
  const labelSessionId = labelTargetSessionId ?? currentSessionId
  const currentLabel = useChatStore(state =>
    labelSessionId ? (state.sessionLabels[labelSessionId] ?? null) : null
  )
  const namingSessionIds = useChatStore(state => state.namingSessionIds)

  // Rename session state
  const renameSession = useRenameSession()
  const createSession = useCreateSession()
  const clearSessionHistory = useClearSessionHistory()
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
    null
  )
  const [renameValue, setRenameValue] = useState('')
  // Start rename immediately (for double-click)
  const handleStartRenameImmediate = useCallback(
    (sessionId: string, currentName: string) => {
      setRenameValue(currentName)
      setRenamingSessionId(sessionId)
    },
    []
  )
  // Delay rename start so the input renders after the context menu fully closes
  // (Radix restores focus to the trigger on close, which would steal focus from the input)
  const handleStartRename = useCallback(
    (sessionId: string, currentName: string) => {
      setRenameValue(currentName)
      setTimeout(() => setRenamingSessionId(sessionId), 200)
    },
    []
  )

  const handleRenameSubmit = useCallback(
    (sessionId: string) => {
      const newName = renameValue.trim()
      if (
        newName &&
        newName !== tabSessions.find(session => session.id === sessionId)?.name
      ) {
        renameSession.mutate({ worktreeId, worktreePath, sessionId, newName })
      }
      setRenamingSessionId(null)
    },
    [renameValue, worktreeId, worktreePath, renameSession, tabSessions]
  )

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent, sessionId: string) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleRenameSubmit(sessionId)
      } else if (e.key === 'Escape') {
        setRenamingSessionId(null)
      }
    },
    [handleRenameSubmit]
  )

  useEffect(() => {
    if (!isOpen) return

    const handleRenameSessionCommand = (
      e: CustomEvent<{ sessionId?: string }>
    ) => {
      const sessionId = e.detail?.sessionId
      if (!sessionId) return
      const session = tabSessions.find(s => s.id === sessionId)
      if (!session || session.archived_at) return

      setRenameValue(session.name)
      setRenamingSessionId(session.id)
    }

    window.addEventListener(
      'command:rename-session',
      handleRenameSessionCommand as EventListener
    )
    return () =>
      window.removeEventListener(
        'command:rename-session',
        handleRenameSessionCommand as EventListener
      )
  }, [isOpen, tabSessions])

  const renameInputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) {
      node.focus()
      node.select()
    }
  }, [])

  // Session archive/delete handlers
  const { handleArchiveSession, handleDeleteSession } = useSessionArchive({
    worktreeId,
    worktreePath,
    removalBehavior: preferences?.removal_behavior,
  })

  // Select the visually adjacent session after closing a tab.
  // Uses the sorted tab order (what the user sees) rather than backend storage order.
  // Ref is updated after sortedSessions is computed (below).
  const sortedSessionsRef = useRef<Session[]>([])

  const selectVisualNeighbor = useCallback(
    (closedId: string) => {
      const activeId = useChatStore.getState().activeSessionIds[worktreeId]
      if (activeId !== closedId) return // Only switch if closing the active tab
      const sorted = sortedSessionsRef.current
      const idx = sorted.findIndex(s => s.id === closedId)
      if (idx === -1) return
      // Left neighbor first, then right
      const left = idx > 0 ? sorted[idx - 1] : undefined
      const right = idx < sorted.length - 1 ? sorted[idx + 1] : undefined
      const nextId = left?.id ?? right?.id ?? null
      if (nextId) {
        useChatStore.getState().setActiveSession(worktreeId, nextId)
      }
    },
    [worktreeId]
  )

  // CMD+W: close the active session tab, or close modal if last tab
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const [closeConfirmMode, setCloseConfirmMode] =
    useState<CloseConfirmMode>('session')
  const pendingCloseAction = useRef<(() => void) | null>(null)

  const executeCloseAction = useCallback(() => {
    pendingCloseAction.current?.()
    pendingCloseAction.current = null
    setCloseConfirmOpen(false)
  }, [])

  // Close (delete or archive per removal behavior) or explicitly archive a
  // session tab, asking for confirmation first.
  const removeSessionTab = useCallback(
    (session: Session, archive = false) => {
      const activeSessions = tabSessions.filter(s => !s.archived_at)
      const sessionIsEmpty = !session.message_count
      // Confirm any non-empty session when preference is on (default). Only
      // confirming the last tab allowed held/cascade closes to wipe chats
      // without a prompt (issue #56). Empty sessions close immediately.
      const needsConfirm =
        preferences?.confirm_session_close !== false && !sessionIsEmpty

      const action = () => {
        if (activeSessions.length > 1) {
          selectVisualNeighbor(session.id)
        }
        if (archive) {
          handleArchiveSession(session.id)
          return
        }
        // The mutation selects the backend-created empty session after success
        // when this was the last session.
        handleDeleteSession(session.id)
      }

      if (needsConfirm) {
        setCloseConfirmMode(archive ? 'session-archive' : 'session')
        pendingCloseAction.current = action
        setCloseConfirmOpen(true)
      } else {
        action()
      }
    },
    [
      tabSessions,
      handleArchiveSession,
      handleDeleteSession,
      preferences?.confirm_session_close,
      selectVisualNeighbor,
    ]
  )

  const handleTabAuxClick = useCallback(
    (e: MouseEvent<HTMLDivElement>, session: Session) => {
      if (e.button !== 1) return
      e.preventDefault()
      e.stopPropagation()
      removeSessionTab(session)
    },
    [removeSessionTab]
  )

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: Event) => {
      e.stopImmediatePropagation()
      const activeSessions = tabSessions.filter(s => !s.archived_at)
      if (activeSessions.length === 0) {
        setCloseConfirmMode('worktree')
        pendingCloseAction.current = () => {
          onRequestCloseWorktree()
          onClose()
        }
        setCloseConfirmOpen(true)
        return
      }
      const action = () => {
        if (activeSessions.length <= 1) {
          if (currentSessionId) {
            handleDeleteSession(currentSessionId)
          }
        } else if (currentSessionId) {
          selectVisualNeighbor(currentSessionId)
          handleDeleteSession(currentSessionId)
        }
      }
      const currentSession = tabSessions.find(s => s.id === currentSessionId)
      const sessionIsEmpty = !currentSession?.message_count
      if (preferences?.confirm_session_close !== false && !sessionIsEmpty) {
        setCloseConfirmMode('session')
        pendingCloseAction.current = action
        setCloseConfirmOpen(true)
      } else {
        action()
      }
    }
    window.addEventListener('close-session-or-worktree', handler, {
      capture: true,
    })
    return () =>
      window.removeEventListener('close-session-or-worktree', handler, {
        capture: true,
      })
  }, [
    isOpen,
    tabSessions,
    currentSessionId,
    handleDeleteSession,
    selectVisualNeighbor,
    preferences?.confirm_session_close,
    onRequestCloseWorktree,
    onClose,
  ])

  // Listen for toggle-session-label event (CMD+S)
  useEffect(() => {
    if (!isOpen) return
    const handler = () => {
      setLabelTargetSessionId(null)
      setLabelModalOpen(true)
    }
    window.addEventListener('toggle-session-label', handler)
    return () => window.removeEventListener('toggle-session-label', handler)
  }, [isOpen])

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  const handleTabClick = useCallback(
    (sessionId: string) => {
      if (renamingSessionId === sessionId) return
      const { setActiveSession } = useChatStore.getState()
      setActiveSession(worktreeId, sessionId)
    },
    [renamingSessionId, worktreeId]
  )

  const handleCreateSession = useCallback(() => {
    useUIStore.getState().openNewSessionModeModal({
      worktreeId,
      worktreePath,
      origin: 'modal',
      intent: 'picker',
    })
  }, [worktreeId, worktreePath])

  const handleClearContext = useCallback(() => {
    if (!currentSessionId || clearSessionHistory.isPending) return
    if (useChatStore.getState().isSending(currentSessionId)) {
      toast.info(
        'Wait for the current session to finish before clearing context.'
      )
      return
    }
    clearSessionHistory.mutate(
      {
        worktreeId,
        worktreePath,
        sessionId: currentSessionId,
      },
      {
        onSuccess: () =>
          window.dispatchEvent(new CustomEvent('focus-chat-input')),
      }
    )
  }, [clearSessionHistory, currentSessionId, worktreeId, worktreePath])

  useEffect(() => {
    if (!isOpen) return
    window.addEventListener('clear-session-context', handleClearContext)
    return () =>
      window.removeEventListener('clear-session-context', handleClearContext)
  }, [handleClearContext, isOpen])

  const handleOpenInNativeClient = useCallback(
    (session: Session) => {
      void (async () => {
        // Prefer Jean-managed / resolved absolute path so bare names like
        // `grok` work when the CLI is not on PATH (default jean install).
        const resolvedCommand = await resolveBackendCliPath(session.backend)
        const input = buildNativeClientSessionInput(
          session,
          worktreeId,
          worktreePath,
          { resolvedCommand }
        )
        if (!input) {
          toast.error('No native resume command is available for this session')
          return
        }

        createSession.mutate(input, {
          onSuccess: nativeSession => {
            useChatStore
              .getState()
              .setSelectedBackend(nativeSession.id, input.backend)
            void reconnectNativeCliSession(nativeSession, worktreeId, {
              openModal: false,
              showToast: false,
            }).then(() => toast.success('Opened in native client'))
          },
        })
      })()
    },
    [createSession, worktreeId, worktreePath]
  )

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: Event) => {
      e.stopImmediatePropagation()
      const intent =
        (e as CustomEvent<{ intent?: 'default' | 'picker' }>).detail?.intent ??
        'picker'
      useUIStore.getState().openNewSessionModeModal({
        worktreeId,
        worktreePath,
        origin: 'modal',
        intent,
      })
    }
    window.addEventListener('create-new-session', handler, { capture: true })
    return () =>
      window.removeEventListener('create-new-session', handler, {
        capture: true,
      })
  }, [isOpen, worktreeId, worktreePath])

  // Keep Code Review first, then running sessions, then most recently updated.
  const sortedCards = useMemo(() => {
    return sortSessionCardsForTabs(cards)
  }, [cards])

  const sortedSessions = useMemo(
    () => sortedCards.map(c => c.session),
    [sortedCards]
  )

  // Keep ref in sync for selectVisualNeighbor (declared above sortedSessions)
  useEffect(() => {
    sortedSessionsRef.current = sortedSessions
  }, [sortedSessions])

  // Off-screen waiting tab indicators
  const { hasLeft: hasWaitingLeft, hasRight: hasWaitingRight } =
    useOffScreenWaiting(sortedCards, modalTabScrollRef)

  const scrollToFirstWaiting = useCallback(
    (direction: 'left' | 'right') => {
      const viewport = modalTabScrollRef.current
      if (!viewport) return
      const { scrollLeft, clientWidth } = viewport
      for (const card of sortedCards) {
        if (!isActionableWaitingStatus(card.status)) continue
        const el = viewport.querySelector(
          `[data-session-id="${card.session.id}"]`
        ) as HTMLElement | null
        if (!el) continue
        const isLeft = el.offsetLeft + el.offsetWidth <= scrollLeft
        const isRight = el.offsetLeft >= scrollLeft + clientWidth
        if (
          (direction === 'left' && isLeft) ||
          (direction === 'right' && isRight)
        ) {
          el.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'nearest',
          })
          handleTabClick(card.session.id)
          return
        }
      }
    },
    [sortedCards, handleTabClick]
  )

  // Listen for switch-session events from the global keybinding system (OPT+CMD+LEFT/RIGHT)
  useEffect(() => {
    if (!isOpen || sortedSessions.length <= 1) return

    const handleSwitchSession = (e: Event) => {
      const detail = (e as CustomEvent).detail
      let newIndex: number

      if (detail?.index !== undefined) {
        // CMD+1–9: switch by index directly
        if (detail.index >= sortedSessions.length) return
        newIndex = detail.index
      } else {
        const direction = detail?.direction as 'next' | 'previous'
        if (!direction) return
        const currentIndex = sortedSessions.findIndex(
          s => s.id === currentSessionId
        )
        if (currentIndex === -1) return
        newIndex =
          direction === 'next'
            ? (currentIndex + 1) % sortedSessions.length
            : (currentIndex - 1 + sortedSessions.length) % sortedSessions.length
      }

      const target = sortedSessions[newIndex]
      if (!target) return
      const { setActiveSession } = useChatStore.getState()
      setActiveSession(worktreeId, target.id)
    }

    window.addEventListener('switch-session', handleSwitchSession)
    return () =>
      window.removeEventListener('switch-session', handleSwitchSession)
  }, [isOpen, sortedSessions, currentSessionId, worktreeId])

  const pickRemoteOrRun = useRemotePicker(worktreePath)

  // Display preference of this client, not of the worktree's server
  const { data: localPreferences } = usePreferences(LOCAL_SERVER_ID)

  const handleSync = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()

      const runSync = async (remote?: string) => {
        await performGitSync({
          needsPull: behindCount > 0,
          needsPush: unpushedCount > 0,
          pull: {
            worktreeId,
            worktreePath,
            baseBranch: worktree?.base_branch ?? defaultBranch,
            projectId: project?.id,
            remote: worktree?.base_remote,
          },
          prNumber: worktree?.pr_number,
          pushRemote: remote,
        })
      }

      if (unpushedCount > 0 && pushNeedsRemotePicker(worktree?.pr_number)) {
        pickRemoteOrRun(runSync)
      } else {
        void runSync()
      }
    },
    [
      behindCount,
      unpushedCount,
      worktreeId,
      worktreePath,
      worktree?.base_branch,
      worktree?.base_remote,
      worktree?.pr_number,
      defaultBranch,
      project?.id,
      pickRemoteOrRun,
    ]
  )

  const handleUncommittedDiffClick = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('open-git-diff', { detail: { type: 'uncommitted' } })
    )
  }, [])

  const handleBranchDiffClick = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('open-git-diff', { detail: { type: 'branch' } })
    )
  }, [])

  const handlePackageScript = useCallback(
    (script: PackageScript) => {
      useTerminalStore
        .getState()
        .addTerminal(worktreeId, script.command, script.name, {
          commandArgs: script.args,
        })
      useTerminalStore.getState().setModalTerminalOpen(worktreeId, true)
    },
    [worktreeId]
  )

  const handleToggleModalTerminal = useCallback(() => {
    useTerminalStore.getState().toggleModalTerminal(worktreeId)
  }, [worktreeId])

  const handleToggleModalBrowser = useCallback(() => {
    useBrowserStore.getState().toggleModal(worktreeId)
  }, [worktreeId])

  // Close on Escape key
  const onEscapeClose = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    // CJK IME: Escape cancels the active composition — must not close the
    // modal. keyCode 229 covers Safari/WKWebView (see issue #584 for Enter).
    if (isImeComposingEvent(e)) return
    const target = e.target as HTMLElement
    const portalAncestor = target?.closest?.(
      '[data-slot="dialog-portal"], [data-slot="alert-dialog-portal"], [data-slot="sheet-portal"]'
    )
    const terminalAncestor = target?.closest?.('[data-terminal-root="true"]')
    const { planDialogOpen, gitDiffModalOpen, contextViewerOpen } =
      useUIStore.getState()

    // Don't close if PlanDialog is open — let it handle ESC
    if (planDialogOpen) return
    // Don't close if GitDiffModal is open — let it handle ESC
    if (gitDiffModalOpen) return
    // Don't close if ContextViewerDialog is open — let it handle ESC
    if (contextViewerOpen) return
    // Don't close if CloseWorktreeDialog is open — let it handle ESC
    if (closeConfirmOpen) return
    // Don't close if ESC originated inside a child dialog/sheet portal
    if (portalAncestor) return
    // Don't close if ESC originated inside the pinned terminal
    if (terminalAncestor) return

    handleClose()
  })

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => onEscapeClose(e)
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  if (!isOpen || !worktreeId) return null

  const worktreeMenu = !zenMode && worktree && project && (
    <WorktreeDropdownMenu
      worktree={worktree}
      projectId={project.id}
      projectPath={project.path}
      uncommittedAdded={uncommittedAdded}
      uncommittedRemoved={uncommittedRemoved}
      branchDiffAdded={isBase ? 0 : branchDiffAdded}
      branchDiffRemoved={isBase ? 0 : branchDiffRemoved}
      onUncommittedDiffClick={handleUncommittedDiffClick}
      onBranchDiffClick={handleBranchDiffClick}
      onToggleTerminal={handleToggleModalTerminal}
      onToggleBrowser={isNativeApp() ? handleToggleModalBrowser : undefined}
      packageScripts={packageScripts}
      onRunPackageScript={handlePackageScript}
      serverProject={project.server ? project : null}
    />
  )

  return (
    <>
      <div
        key={worktreeId}
        ref={isTouch ? swipe.containerRef : undefined}
        className={cn(
          'absolute inset-0 z-10 flex min-w-0 overflow-hidden bg-background pt-[3px]',
          !isMobile && 'pb-2',
          hasBottomDock ? 'flex-col' : 'flex-row'
        )}
        data-testid="session-chat-modal-swipe"
      >
        {isMobile && swipe.isSwiping && (
          <div
            className="pointer-events-none absolute top-1/2 z-[60] flex -translate-y-1/2 items-center justify-center"
            style={{ left: swipe.translateX - 8 }}
            data-testid="mobile-sidebar-swipe-indicator"
          >
            <div
              className="rounded-full bg-muted-foreground/30 transition-transform"
              style={{
                width: 8 + swipe.progress * 24,
                height: 8 + swipe.progress * 24,
                opacity: 0.3 + swipe.progress * 0.7,
              }}
            />
          </div>
        )}
        {isModalTerminalOpen && modalTerminalDockMode === 'left' && (
          <ModalTerminalDrawer
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            dockMode="left"
          />
        )}
        <ModalBrowserDrawer worktreeId={worktreeId} dockMode="left" />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!zenMode && (
            <div className="shrink-0 border-b border-border/40 sm:text-left">
              <div
                className={cn(
                  'flex items-center justify-between gap-2 px-4 py-2',
                  MODAL_TERMINAL_PRIMARY_ROW_CLASS
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {/* Mobile: menu sits right after the title; the title truncates so git badges stay visible */}
                  <div
                    className={cn(
                      isMobile ? 'flex min-w-0 items-center gap-2' : 'contents'
                    )}
                  >
                    <h2
                      className={cn(
                        'text-sm font-medium min-w-0 truncate',
                        !isMobile && 'flex-1'
                      )}
                    >
                      {project && !isMobile && (
                        <span className="text-muted-foreground font-normal">
                          <button
                            type="button"
                            className="hover:text-foreground transition-colors cursor-pointer text-foreground text-lg font-semibold"
                            onClick={handleClose}
                          >
                            {project.name}
                          </button>
                          <span className="mx-1.5 text-muted-foreground/50">
                            ›
                          </span>
                        </span>
                      )}
                      {isBase ? 'Base Session' : (worktree?.name ?? 'Worktree')}
                    </h2>
                    {isMobile && worktreeMenu}
                  </div>
                  {!zenMode && stackedBaseBranch && (
                    <span
                      className={cn(
                        'inline-flex min-w-0 items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground',
                        isMobile ? 'shrink-0' : 'shrink'
                      )}
                    >
                      <GitBranchPlus className="h-2.5 w-2.5" />
                      <span className="max-w-16 sm:max-w-40 truncate">
                        {stackedBaseBranch}
                      </span>
                      {stackedOnPR && (
                        <>
                          <span className="text-border">·</span>
                          <GitPullRequestArrow className="h-2.5 w-2.5" />#
                          {stackedOnPR.number}
                        </>
                      )}
                    </span>
                  )}
                  {!zenMode && (
                    <GitStatusBadges
                      behindCount={behindCount}
                      unpushedCount={unpushedCount}
                      diffAdded={uncommittedAdded}
                      diffRemoved={uncommittedRemoved}
                      branchDiffAdded={isBase ? 0 : branchDiffAdded}
                      branchDiffRemoved={isBase ? 0 : branchDiffRemoved}
                      onSync={handleSync}
                      onDiffClick={handleUncommittedDiffClick}
                      onBranchDiffClick={handleBranchDiffClick}
                    />
                  )}
                  {!isMobile && worktreeMenu}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {isMobile && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                          aria-label={
                            zenMode ? 'Exit zen mode' : 'Enter zen mode'
                          }
                          aria-pressed={zenMode}
                          data-testid="toggle-zen-mode"
                          onClick={toggleZenMode}
                        >
                          {zenMode ? (
                            <Minimize className="size-2.5" />
                          ) : (
                            <Maximize className="size-2.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {zenMode ? 'Exit zen mode' : 'Zen mode'}{' '}
                        <kbd className="ml-1 text-[0.625rem] opacity-60">
                          {formatShortcutDisplay(
                            preferences?.keybindings?.toggle_zen_mode ??
                              DEFAULT_KEYBINDINGS.toggle_zen_mode
                          )}
                        </kbd>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {!zenMode && (
                    <>
                      {!isMobile && !project?.server && (
                        <>
                          <HeaderSurfaceToggle
                            label="Terminal"
                            icon={Terminal}
                            isOpen={isModalTerminalOpen}
                            shortcut={
                              localPreferences?.keybindings?.toggle_terminal ??
                              DEFAULT_KEYBINDINGS.toggle_terminal
                            }
                            onClick={handleToggleModalTerminal}
                          />
                          {isNativeApp() && (
                            <HeaderSurfaceToggle
                              label="Browser"
                              icon={Globe}
                              isOpen={isBrowserModalOpen}
                              shortcut={
                                localPreferences?.keybindings?.toggle_browser ??
                                DEFAULT_KEYBINDINGS.toggle_browser
                              }
                              onClick={handleToggleModalBrowser}
                            />
                          )}
                        </>
                      )}
                      {/* Desktop: secondary tools that are not in the menu */}
                      <div className="hidden lg:flex items-center gap-1">
                        <OpenInButton
                          worktreePath={worktreePath}
                          serverId={worktree?.serverId}
                          branch={worktree?.branch}
                          server={project?.server}
                        />
                        <ScriptsButton
                          projectId={worktree?.project_id}
                          worktreePath={worktreePath}
                          onRun={handlePackageScript}
                        />
                        {currentSessionId && (
                          <DevToolsDropdown
                            sessionId={currentSessionId}
                            worktreeId={worktreeId}
                            worktreePath={worktreePath}
                            session={currentSession}
                          />
                        )}
                      </div>
                      <ModalCloseButton
                        onClick={handleClose}
                        className={cn(
                          isMobile &&
                            'text-muted-foreground hover:text-foreground'
                        )}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Session tabs — hidden in zen mode for an immersive chat surface */}
          {!zenMode && showSessionTabs && (
            <div
              className={cn(
                'relative flex shrink-0 items-center gap-0.5 border-b border-border/40 pr-4',
                MODAL_TERMINAL_SECONDARY_ROW_CLASS
              )}
            >
              {hasWaitingLeft && (
                <button
                  type="button"
                  onClick={() => scrollToFirstWaiting('left')}
                  className="absolute left-0 top-0 bottom-0 w-1 bg-warning animate-blink rounded-r z-10 cursor-pointer"
                  aria-label="Scroll to waiting session"
                />
              )}
              {hasWaitingRight && (
                <button
                  type="button"
                  onClick={() => scrollToFirstWaiting('right')}
                  className="absolute right-0 top-0 bottom-0 w-1 bg-warning animate-blink rounded-l z-10 cursor-pointer"
                  aria-label="Scroll to waiting session"
                />
              )}
              <ScrollArea
                className="min-w-0 flex-1 sm:flex-initial"
                viewportClassName="overflow-x-auto overflow-y-hidden overscroll-x-contain overscroll-y-none touch-pan-x scrollbar-hide [-webkit-overflow-scrolling:touch]"
                viewportRef={modalTabScrollRef}
              >
                <div className="flex min-w-max items-center gap-0 py-0 px-0">
                  {sortedCards.map((card, idx) => {
                    const session = card.session
                    const isActive = session.id === currentSessionId
                    const status = card.status
                    const config = statusConfig[status]
                    const chatState = useChatStore.getState()
                    const sessionLabel = chatState.sessionLabels[session.id]
                    const resumeCommand = getResumeCommand(session)
                    const isGeneratingName =
                      namingSessionIds[session.id] ?? false
                    return (
                      <ContextMenu key={session.id}>
                        <ContextMenuTrigger asChild>
                          <div
                            data-session-id={session.id}
                            onClick={() => handleTabClick(session.id)}
                            onAuxClick={e => handleTabAuxClick(e, session)}
                            onDoubleClick={() =>
                              handleStartRenameImmediate(
                                session.id,
                                session.name
                              )
                            }
                            className={cn(
                              'group/tab flex shrink-0 items-center gap-1.5 border-r border-border/40 px-3 py-1.5 text-xs transition-colors whitespace-nowrap cursor-pointer',
                              isActive
                                ? 'bg-muted text-foreground'
                                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                              !isActive &&
                                !isActionableWaitingStatus(status) &&
                                isUnreadSession(session) &&
                                'bg-muted/60 text-foreground/90 hover:bg-muted/80',
                              isActionableWaitingStatus(status) &&
                                'bg-warning/10 text-warning border-warning hover:bg-warning/20 hover:text-warning'
                            )}
                          >
                            <StatusIndicator
                              status={config.indicatorStatus}
                              shape={config.indicatorShape}
                              label={config.label}
                              className="h-1.5 w-1.5"
                            />
                            {showTabShortcutHints && idx < 9 && (
                              <kbd className="shrink-0 rounded border border-border/50 px-1 py-px text-[9px] font-medium leading-none text-muted-foreground/70">
                                {formatShortcutDisplay(`mod+${idx + 1}`)}
                              </kbd>
                            )}
                            {renamingSessionId === session.id ? (
                              <input
                                ref={renameInputRef}
                                type="text"
                                value={renameValue}
                                onChange={e => setRenameValue(e.target.value)}
                                onBlur={() => handleRenameSubmit(session.id)}
                                onKeyDown={e =>
                                  handleRenameKeyDown(e, session.id)
                                }
                                onPointerDown={e => e.stopPropagation()}
                                onClick={e => e.stopPropagation()}
                                aria-label="Rename session"
                                className="w-full min-w-0 bg-transparent text-base outline-none md:text-xs"
                              />
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="flex max-w-48 items-center gap-1.5 truncate">
                                    <span className="truncate">
                                      {isGeneratingName
                                        ? 'Generating…'
                                        : session.name}
                                    </span>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                  {isGeneratingName
                                    ? 'Generating session name…'
                                    : session.name}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {renamingSessionId !== session.id && (
                              <DismissButton
                                tooltip={'Remove session'}
                                onClick={e => {
                                  e.stopPropagation()
                                  removeSessionTab(session)
                                }}
                                className="ml-0.5 opacity-60 sm:opacity-0 sm:group-hover/tab:opacity-60 hover:!opacity-100"
                                size="xs"
                              />
                            )}
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-64">
                          <ContextMenuItem
                            onSelect={() =>
                              handleStartRename(session.id, session.name)
                            }
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Rename
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => {
                              setLabelTargetSessionId(session.id)
                              setLabelModalOpen(true)
                            }}
                          >
                            <Tag className="mr-2 h-4 w-4" />
                            {sessionLabel ? 'Remove Label' : 'Add Label'}
                          </ContextMenuItem>
                          {resumeCommand && (
                            <>
                              <ContextMenuItem
                                disabled={createSession.isPending}
                                onSelect={() =>
                                  handleOpenInNativeClient(session)
                                }
                              >
                                <Play className="mr-2 h-4 w-4" />
                                Open in Native Client
                              </ContextMenuItem>
                              <ContextMenuItem
                                onSelect={() => {
                                  void copyToClipboard(resumeCommand)
                                    .then(() =>
                                      toast.success('Resume command copied')
                                    )
                                    .catch(() =>
                                      toast.error(
                                        'Failed to copy resume command'
                                      )
                                    )
                                }}
                              >
                                <Copy className="mr-2 h-4 w-4" />
                                Native Resume Command
                              </ContextMenuItem>
                            </>
                          )}
                          {canReconnectSession(session) && (
                            <ContextMenuItem
                              onSelect={() =>
                                void reconnectNativeCliSession(
                                  session,
                                  worktreeId
                                )
                              }
                            >
                              <RefreshCw className="mr-2 h-4 w-4" />
                              Reconnect
                            </ContextMenuItem>
                          )}
                          <ContextMenuItem
                            onSelect={() => {
                              void copyToClipboard(session.id)
                                .then(() => toast.success('Session ID copied'))
                                .catch(() =>
                                  toast.error('Failed to copy session ID')
                                )
                            }}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            Copy Session ID
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onSelect={() => removeSessionTab(session, true)}
                          >
                            <Archive className="mr-2 h-4 w-4" />
                            Archive Session
                          </ContextMenuItem>
                          <ContextMenuItem
                            variant="destructive"
                            onSelect={() => removeSessionTab(session)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete Session
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    )
                  })}
                </div>
                <ScrollBar orientation="horizontal" className="h-1" />
              </ScrollArea>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'shrink-0 p-0',
                      isMobile
                        ? 'h-7 w-7 text-muted-foreground hover:text-foreground'
                        : 'h-6 w-6'
                    )}
                    onClick={handleCreateSession}
                    aria-label="New session"
                  >
                    <Plus className={isMobile ? 'size-4' : 'h-3 w-3'} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New session</TooltipContent>
              </Tooltip>
            </div>
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {currentSessionId ? (
              <div className="absolute inset-0 z-20 min-h-0 min-w-0">
                <ChatWindow
                  key={currentSessionId}
                  isModal
                  worktreeId={worktreeId}
                  worktreePath={worktreePath}
                />
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {sessionsData
                    ? 'No sessions yet. Create one to start chatting.'
                    : 'Loading sessions…'}
                </p>
                {sessionsData && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCreateSession}
                  >
                    <Plus className="mr-2 h-3.5 w-3.5" />
                    New session
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {isModalTerminalOpen && modalTerminalDockMode === 'right' && (
          <ModalTerminalDrawer
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            dockMode="right"
          />
        )}
        <ModalBrowserDrawer worktreeId={worktreeId} dockMode="right" />
        {isModalTerminalOpen && modalTerminalDockMode === 'bottom' && (
          <ModalTerminalDrawer
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            dockMode="bottom"
          />
        )}
        {/* Browser bottom drawer sits at outer-flex bottom row alongside
            terminal-bottom; outer flex flips to flex-col when either is
            docked at bottom (see hasBottomDock). */}
        <ModalBrowserDrawer worktreeId={worktreeId} dockMode="bottom" />
        {modalTerminalDockMode === 'floating' && (
          <ModalTerminalDrawer
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            dockMode="floating"
          />
        )}
        <ModalBrowserDrawer worktreeId={worktreeId} dockMode="floating" />
      </div>
      <LabelModal
        isOpen={labelModalOpen}
        onClose={() => {
          setLabelModalOpen(false)
          setLabelTargetSessionId(null)
        }}
        sessionId={labelSessionId}
        currentLabel={currentLabel}
      />

      <CloseWorktreeDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        onConfirm={executeCloseAction}
        branchName={worktree?.branch}
        mode={closeConfirmMode}
      />
    </>
  )
})
