import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react'
import {
  Archive,
  ChevronDown,
  Eye,
  EyeOff,
  GitBranchPlus,
  GitPullRequestArrow,
  Pencil,
  RefreshCw,
  Tag,
  Terminal,
  Globe,
  Play,
  Plus,
  Trash2,
} from 'lucide-react'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { cn } from '@/lib/utils'
import { dismissibleToast } from '@/lib/dismissible-toast'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { DismissButton } from '@/components/ui/dismiss-button'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { GitStatusBadges } from '@/components/ui/git-status-badges'
import { NewIssuesBadge } from '@/components/shared/NewIssuesBadge'
import { OpenPRsBadge } from '@/components/shared/OpenPRsBadge'
import { FailedRunsBadge } from '@/components/shared/FailedRunsBadge'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { CloseWorktreeDialog } from './CloseWorktreeDialog'
import { useChatStore } from '@/store/chat-store'
import { isPanelTerminal, useTerminalStore } from '@/store/terminal-store'
import { useBrowserStore } from '@/store/browser-store'
import { useUIStore } from '@/store/ui-store'
import {
  useSessions,
  useRenameSession,
  useReorderSessions,
  reconnectNativeCliSession,
  canReconnectSession,
} from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { useWorktree, useProjects, useRunScripts } from '@/services/projects'
import { useGitHubPRs } from '@/services/github'
import {
  useGitStatus,
  gitPush,
  fetchWorktreesStatus,
  triggerImmediateGitPoll,
  performGitPull,
} from '@/services/git-status'
import { isBaseSession } from '@/types/projects'
import type { Session } from '@/types/chat'
import { isNativeApp } from '@/lib/environment'
import { notify } from '@/lib/notifications'
import { copyToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { ChatWindow } from './ChatWindow'
import { ModalTerminalDrawer } from './ModalTerminalDrawer'
import { ModalBrowserDrawer } from '@/components/browser/ModalBrowserDrawer'
import { OpenInButton } from '@/components/open-in/OpenInButton'
import { DevToolsDropdown } from './DevToolsDropdown'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import {
  computeSessionCardData,
  getResumeCommand,
  statusConfig,
  type SessionCardData,
} from './session-card-utils'
import {
  buildReorderedSessionIdsWithinStatus,
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
import { pushNeedsRemotePicker, useRemotePicker } from '@/hooks/useRemotePicker'
import { useIsTouchDevice } from '@/hooks/use-touch-device'
import { useSwipeBack } from '@/hooks/useSwipeBack'
import {
  MODAL_TERMINAL_PRIMARY_ROW_CLASS,
  MODAL_TERMINAL_SECONDARY_ROW_CLASS,
} from './modal-terminal-layout'

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

    const waitingIds = sortedCards
      .filter(c => c.status === 'waiting')
      .map(c => c.session.id)

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

interface SessionChatModalProps {
  worktreeId: string
  worktreePath: string
  isOpen: boolean
  onClose: () => void
}

export function SessionChatModal({
  worktreeId,
  worktreePath,
  isOpen,
  onClose,
}: SessionChatModalProps) {
  const isMobile = useIsMobile()
  const isTouch = useIsTouchDevice()
  const swipe = useSwipeBack({
    onSwipeBack: onClose,
    enabled: isTouch && isOpen,
  })
  const { data: sessionsData } = useSessions(
    worktreeId || null,
    worktreePath || null
  )
  const sessions = useMemo(
    () => sessionsData?.sessions ?? [],
    [sessionsData?.sessions]
  )
  const { data: preferences } = usePreferences()
  const { data: runScripts = [] } = useRunScripts(worktreePath)
  const isModalTerminalOpen = useTerminalStore(
    state => state.modalTerminalOpen[worktreeId] ?? false
  )
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
  const hasRunningTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(
      t => isPanelTerminal(t) && state.runningTerminals.has(t.id)
    )
  })
  const hasFailedTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(
      t => isPanelTerminal(t) && !!t.command && state.failedTerminals.has(t.id)
    )
  })
  const terminalShortcut = formatShortcutDisplay(
    preferences?.keybindings?.toggle_terminal ??
      DEFAULT_KEYBINDINGS.toggle_terminal
  )
  const runShortcut = formatShortcutDisplay(
    preferences?.keybindings?.execute_run ?? DEFAULT_KEYBINDINGS.execute_run
  )
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
  }, [sessions.length])

  // Active session from store
  const activeSessionId = useChatStore(
    state => state.activeSessionIds[worktreeId]
  )
  const currentSessionId = activeSessionId ?? sessions[0]?.id ?? null
  const currentSession = sessions.find(s => s.id === currentSessionId) ?? null
  // Canonical store state shared with canvas for consistent status derivation.
  const storeState = useCanvasStoreState()
  // Compute card data once per session — same derivation as ProjectCanvasView,
  // so canvas badges and modal tab badges stay in sync.
  const cards = useMemo(
    () => sessions.map(s => computeSessionCardData(s, storeState)),
    [sessions, storeState]
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
  }, [isOpen, currentSessionId, sessions.length, currentSessionStatus])

  // Git status for header badges
  const { data: worktree } = useWorktree(worktreeId)
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null
  const { data: openPRs } = useGitHubPRs(project?.path ?? null, 'open')
  const stackedOnPR =
    worktree?.base_branch && worktree.base_branch !== project?.default_branch
      ? openPRs?.find(pr => pr.headRefName === worktree.base_branch)
      : undefined
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



  // Rename session state
  const renameSession = useRenameSession()
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
      if (newName && newName !== sessions.find(s => s.id === sessionId)?.name) {
        renameSession.mutate({ worktreeId, worktreePath, sessionId, newName })
      }
      setRenamingSessionId(null)
    },
    [renameValue, worktreeId, worktreePath, renameSession, sessions]
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
      const session = sessions.find(s => s.id === sessionId)
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
  }, [isOpen, sessions])

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
  const pendingCloseAction = useRef<(() => void) | null>(null)

  const executeCloseAction = useCallback(() => {
    pendingCloseAction.current?.()
    pendingCloseAction.current = null
    setCloseConfirmOpen(false)
  }, [])

  const removeSessionTab = useCallback(
    (session: Session) => {
      const activeSessions = sessions.filter(s => !s.archived_at)
      if (activeSessions.length <= 1) {
        const action = () => {
          handleDeleteSession(session.id)
          onClose()
        }
        const sessionIsEmpty = !session.message_count
        if (preferences?.confirm_session_close !== false && !sessionIsEmpty) {
          pendingCloseAction.current = action
          setCloseConfirmOpen(true)
        } else {
          action()
        }
      } else {
        selectVisualNeighbor(session.id)
        handleDeleteSession(session.id)
      }
    },
    [
      sessions,
      handleDeleteSession,
      onClose,
      preferences?.confirm_session_close,
      selectVisualNeighbor,
      handleArchiveSession,
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
      const activeSessions = sessions.filter(s => !s.archived_at)
      const action = () => {
        if (activeSessions.length <= 1) {
          if (currentSessionId) {
            handleDeleteSession(currentSessionId)
          }
          onClose()
        } else if (currentSessionId) {
          selectVisualNeighbor(currentSessionId)
          handleDeleteSession(currentSessionId)
        }
      }
      const currentSession = sessions.find(s => s.id === currentSessionId)
      const sessionIsEmpty = !currentSession?.message_count
      if (preferences?.confirm_session_close !== false && !sessionIsEmpty) {
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
    sessions,
    currentSessionId,
    onClose,
    handleDeleteSession,
    selectVisualNeighbor,
    preferences?.confirm_session_close,
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

  const reorderSessions = useReorderSessions()
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null)

  const handleCreateSession = useCallback(() => {
    useUIStore.getState().openNewSessionModeModal({
      worktreeId,
      worktreePath,
      origin: 'modal',
      intent: 'picker',
    })
  }, [worktreeId, worktreePath])

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

  // Sorted tab order: attention and active sessions first, review next,
  // idle/new empty sessions last. Within each tier, manual tab order wins.
  const sortedCards = useMemo(() => {
    return sortSessionCardsForTabs(cards)
  }, [cards])

  const handleSessionDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, sessionId: string) => {
      setDraggedSessionId(sessionId)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', sessionId)
    },
    []
  )

  const handleSessionDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, targetSessionId: string) => {
      if (
        draggedSessionId &&
        buildReorderedSessionIdsWithinStatus(
          sortedCards,
          draggedSessionId,
          targetSessionId
        )
      ) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }
    },
    [draggedSessionId, sortedCards]
  )

  const handleSessionDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, targetSessionId: string) => {
      e.preventDefault()
      const sourceId =
        draggedSessionId || e.dataTransfer.getData('text/plain') || null
      if (!sourceId) return

      const sessionIds = buildReorderedSessionIdsWithinStatus(
        sortedCards,
        sourceId,
        targetSessionId
      )
      setDraggedSessionId(null)
      if (!sessionIds) return

      reorderSessions.mutate({ worktreeId, worktreePath, sessionIds })
    },
    [draggedSessionId, reorderSessions, sortedCards, worktreeId, worktreePath]
  )

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
        if (card.status !== 'waiting') continue
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

  const handlePull = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      await performGitPull({
        worktreeId,
        worktreePath,
        baseBranch: defaultBranch,
        projectId: project?.id,
      })
    },
    [worktreeId, worktreePath, defaultBranch, project?.id]
  )

  const pickRemoteOrRun = useRemotePicker(worktreePath)

  const handlePush = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()

      const runPush = async (remote?: string) => {
        const opToast = dismissibleToast.loading('Pushing changes...')
        try {
          const result = await gitPush(
            worktreePath,
            worktree?.pr_number,
            remote
          )
          triggerImmediateGitPoll()
          if (project) fetchWorktreesStatus(project.id)
          if (result.fellBack) {
            opToast.warning(
              'Could not push to PR branch, pushed to new branch instead'
            )
          } else {
            opToast.success('Changes pushed')
          }
        } catch (error) {
          opToast.error(`Push failed: ${error}`)
        }
      }

      if (pushNeedsRemotePicker(worktree?.pr_number)) {
        pickRemoteOrRun(runPush)
      } else {
        runPush()
      }
    },
    [pickRemoteOrRun, worktree, worktreePath, project]
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

  const handleRun = useCallback(() => {
    const first = runScripts[0]
    if (!first) {
      notify('No run script configured in jean.json', undefined, {
        type: 'error',
      })
      return
    }
    useTerminalStore.getState().startRun(worktreeId, first)
    useTerminalStore.getState().setModalTerminalOpen(worktreeId, true)
  }, [worktreeId, runScripts])

  const handleRunCommand = useCallback(
    (cmd: string) => {
      useTerminalStore.getState().startRun(worktreeId, cmd)
      useTerminalStore.getState().setModalTerminalOpen(worktreeId, true)
    },
    [worktreeId]
  )

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement
        const portalAncestor = target?.closest?.(
          '[data-slot="dialog-portal"], [data-slot="alert-dialog-portal"], [data-slot="sheet-portal"]'
        )
        const terminalAncestor = target?.closest?.(
          '[data-terminal-root="true"]'
        )
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
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleClose, closeConfirmOpen])

  if (!isOpen || !worktreeId) return null

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
        style={
          isMobile
            ? {
                transform: `translateX(${swipe.translateX}px)`,
                transition: swipe.transitionStyle || undefined,
                willChange: swipe.isSwiping ? 'transform' : undefined,
              }
            : undefined
        }
      >
        {isMobile && (
          <div
            className={cn(
              'absolute left-0 top-1/2 z-50 h-10 w-1 -translate-y-1/2 rounded-r-full bg-muted-foreground/20 transition-opacity duration-300',
              swipe.isSwiping ? 'opacity-0' : 'opacity-100'
            )}
          />
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
          <div className="shrink-0 border-b sm:text-left">
            <div
              className={cn(
                'flex items-center justify-between gap-2 px-4 py-2',
                MODAL_TERMINAL_PRIMARY_ROW_CLASS
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-sm font-medium min-w-0 flex-1 truncate">
                  {project && !isMobile && (
                    <span className="text-muted-foreground font-normal">
                      <button
                        type="button"
                        className="hover:text-foreground transition-colors cursor-pointer text-foreground text-lg font-semibold"
                        onClick={handleClose}
                      >
                        {project.name}
                      </button>
                      <span className="mx-1.5 text-muted-foreground/50">›</span>
                    </span>
                  )}
                  {isBase ? 'Base Session' : (worktree?.name ?? 'Worktree')}
                </h2>
                {worktree?.base_branch &&
                  worktree.base_branch !== project?.default_branch && (
                    <span className="inline-flex shrink min-w-0 items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                      <GitBranchPlus className="h-2.5 w-2.5" />
                      <span className="max-w-16 sm:max-w-40 truncate">
                        {worktree.base_branch}
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
                <GitStatusBadges
                  behindCount={behindCount}
                  unpushedCount={unpushedCount}
                  diffAdded={isMobile ? 0 : uncommittedAdded}
                  diffRemoved={isMobile ? 0 : uncommittedRemoved}
                  branchDiffAdded={isBase || isMobile ? 0 : branchDiffAdded}
                  branchDiffRemoved={isBase || isMobile ? 0 : branchDiffRemoved}
                  onPull={handlePull}
                  onPush={handlePush}
                  onDiffClick={handleUncommittedDiffClick}
                  onBranchDiffClick={handleBranchDiffClick}
                />
                {project && (
                  <div className="hidden items-center gap-2 md:flex">
                    <NewIssuesBadge
                      projectPath={project.path}
                      projectId={project.id}
                    />
                    <OpenPRsBadge
                      projectPath={project.path}
                      projectId={project.id}
                    />
                    <FailedRunsBadge projectPath={project.path} />
                  </div>
                )}
                {worktree && project && (
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
                  />
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {/* Desktop: inline action buttons */}
                <div className="hidden sm:flex items-center gap-1">
                  <OpenInButton
                    worktreePath={worktreePath}
                    branch={worktree?.branch}
                  />
                  {currentSessionId && (
                    <DevToolsDropdown
                      sessionId={currentSessionId}
                      worktreeId={worktreeId}
                      worktreePath={worktreePath}
                      session={currentSession}
                    />
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        aria-label="Toggle terminal"
                        onClick={() => {
                          useTerminalStore
                            .getState()
                            .toggleModalTerminal(worktreeId)
                        }}
                      >
                        <Terminal className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Terminal{' '}
                      <kbd className="ml-1 text-[0.625rem] opacity-60">
                        {terminalShortcut}
                      </kbd>
                    </TooltipContent>
                  </Tooltip>
                  {isNativeApp() && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          aria-label="Toggle browser"
                          onClick={() => {
                            useBrowserStore.getState().toggleModal(worktreeId)
                          }}
                        >
                          <Globe className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Browser</TooltipContent>
                    </Tooltip>
                  )}
                  {runScripts.length === 1 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          aria-label="Run"
                          onClick={handleRun}
                        >
                          <Play
                            className={`h-3 w-3 ${hasFailedTerminal ? 'text-red-500' : hasRunningTerminal ? 'text-amber-500 dark:text-yellow-400 animate-icon-glow' : ''}`}
                          />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {hasFailedTerminal
                          ? 'Crashed'
                          : hasRunningTerminal
                            ? 'Running'
                            : 'Run'}{' '}
                        <kbd className="ml-1 text-[0.625rem] opacity-60">
                          {runShortcut}
                        </kbd>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {runScripts.length > 1 && (
                    <div className="flex items-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-r-none px-2 text-xs"
                            aria-label="Run first command"
                            onClick={handleRun}
                          >
                            <Play
                              className={`h-3 w-3 ${hasFailedTerminal ? 'text-red-500' : hasRunningTerminal ? 'text-amber-500 dark:text-yellow-400 animate-icon-glow' : ''}`}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {hasFailedTerminal
                            ? 'Crashed'
                            : hasRunningTerminal
                              ? 'Running'
                              : 'Run first command'}{' '}
                          <kbd className="ml-1 text-[0.625rem] opacity-60">
                            {runShortcut}
                          </kbd>
                        </TooltipContent>
                      </Tooltip>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-l-none border-l border-border/50 px-1 text-xs"
                            aria-label="Choose run command"
                          >
                            <ChevronDown className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {runScripts.map((cmd, i) => (
                            <DropdownMenuItem
                              key={i}
                              onSelect={() => handleRunCommand(cmd)}
                              className="font-mono text-xs"
                            >
                              {cmd}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
                <ModalCloseButton onClick={handleClose} />
              </div>
            </div>
          </div>

          {/* Session tabs */}
          {sessions.length > 0 && (
            <div
              className={cn(
                'relative flex shrink-0 items-center gap-0.5 border-b pr-4',
                MODAL_TERMINAL_SECONDARY_ROW_CLASS
              )}
            >
              {hasWaitingLeft && (
                <button
                  type="button"
                  onClick={() => scrollToFirstWaiting('left')}
                  className="absolute left-0 top-0 bottom-0 w-1 bg-yellow-500 animate-blink rounded-r z-10 cursor-pointer"
                  aria-label="Scroll to waiting session"
                />
              )}
              {hasWaitingRight && (
                <button
                  type="button"
                  onClick={() => scrollToFirstWaiting('right')}
                  className="absolute right-0 top-0 bottom-0 w-1 bg-yellow-500 animate-blink rounded-l z-10 cursor-pointer"
                  aria-label="Scroll to waiting session"
                />
              )}
              <ScrollArea
                className="min-w-0 flex-1"
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
                    return (
                      <ContextMenu key={session.id}>
                        <ContextMenuTrigger asChild>
                          <div
                            data-session-id={session.id}
                            role="button"
                            tabIndex={0}
                            draggable={renamingSessionId !== session.id}
                            onDragStart={e =>
                              handleSessionDragStart(e, session.id)
                            }
                            onDragOver={e =>
                              handleSessionDragOver(e, session.id)
                            }
                            onDrop={e => handleSessionDrop(e, session.id)}
                            onDragEnd={() => setDraggedSessionId(null)}
                            onClick={() => handleTabClick(session.id)}
                            onAuxClick={e => handleTabAuxClick(e, session)}
                            onKeyDown={e => {
                              if (renamingSessionId === session.id) return
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                handleTabClick(session.id)
                              }
                            }}
                            onDoubleClick={() =>
                              handleStartRenameImmediate(
                                session.id,
                                session.name
                              )
                            }
                            className={cn(
                              'group/tab flex shrink-0 items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs transition-colors whitespace-nowrap',
                              isActive
                                ? 'bg-muted text-foreground'
                                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                              draggedSessionId === session.id && 'opacity-60',
                              status === 'waiting' &&
                                'bg-yellow-500/10 text-yellow-700 border-yellow-500 hover:bg-yellow-500/20 hover:text-yellow-800 dark:bg-yellow-400/10 dark:text-yellow-300 dark:border-yellow-400 dark:hover:bg-yellow-400/20 dark:hover:text-yellow-200'
                            )}
                          >
                            <StatusIndicator
                              status={config.indicatorStatus}
                              variant={config.indicatorVariant}
                              className="h-1.5 w-1.5"
                            />
                            {idx < 9 && (
                              <kbd className="shrink-0 rounded border border-border/50 px-1 py-px text-[9px] font-medium leading-none text-muted-foreground/70">
                                ⌘{idx + 1}
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
                                className="w-full min-w-0 bg-transparent text-base outline-none md:text-xs"
                              />
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="truncate max-w-48">
                                    {session.name}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                  {session.name}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {renamingSessionId !== session.id && (
                              <DismissButton
                                tooltip={
                                  sessions.filter(s => !s.archived_at).length <=
                                  1
                                    ? 'Close worktree'
                                    : 'Remove session'
                                }
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
                          <ContextMenuItem
                            // "Mark as Idle" only clears the manual reviewing
                            // flag. When review is driven by AI review_results,
                            // clearing the flag leaves the session in review —
                            // no effect — so disable it there.
                            disabled={
                              status === 'review' && !!session.review_results
                            }
                            onSelect={() => {
                              const { reviewingSessions, setSessionReviewing } =
                                useChatStore.getState()
                              const isReviewing =
                                reviewingSessions[session.id] ||
                                !!session.review_results
                              setSessionReviewing(session.id, !isReviewing)
                            }}
                          >
                            {status === 'review' ? (
                              <>
                                <EyeOff className="mr-2 h-4 w-4" />
                                Mark as Idle
                              </>
                            ) : (
                              <>
                                <Eye className="mr-2 h-4 w-4" />
                                Mark for Review
                              </>
                            )}
                          </ContextMenuItem>
                          {resumeCommand && (
                            <ContextMenuItem
                              onSelect={() => {
                                void copyToClipboard(resumeCommand)
                                  .then(() =>
                                    toast.success('Resume command copied')
                                  )
                                  .catch(() =>
                                    toast.error('Failed to copy resume command')
                                  )
                              }}
                            >
                              <Terminal className="mr-2 h-4 w-4" />
                              Copy Resume Command
                            </ContextMenuItem>
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
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onSelect={() => handleArchiveSession(session.id)}
                          >
                            <Archive className="mr-2 h-4 w-4" />
                            Archive Session
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            variant="destructive"
                            onSelect={() => handleDeleteSession(session.id)}
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
                    className="h-6 w-6 p-0 shrink-0"
                    onClick={handleCreateSession}
                  >
                    <Plus className="h-3 w-3" />
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
            ) : null}
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
        mode="session"
      />
    </>
  )
}
