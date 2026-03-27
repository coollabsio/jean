import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import {
  Archive,
  ChevronDown,
  Code,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Github,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Tag,
  Terminal,
  Play,
  Plus,
  Trash2,
} from 'lucide-react'
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
import { NewIssuesBadge } from '@/components/shared/NewIssuesBadge'
import { OpenPRsBadge } from '@/components/shared/OpenPRsBadge'
import { FailedRunsBadge } from '@/components/shared/FailedRunsBadge'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { CloseWorktreeDialog } from './CloseWorktreeDialog'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import {
  useSessions,
  useCreateSession,
  useRenameSession,
} from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { useWorktree, useProjects, useRunScripts } from '@/services/projects'
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
import { OpenInButton } from '@/components/open-in/OpenInButton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  useOpenWorktreeInEditor,
  useOpenWorktreeInTerminal,
  useOpenWorktreeInFinder,
  useOpenBranchOnGitHub,
} from '@/services/projects'
import { getOpenInDefaultLabel } from '@/types/preferences'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import {
  getResumeCommand,
  statusConfig,
  type SessionStatus,
} from './session-card-utils'
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

/** Track whether any waiting tabs are off-screen to the left or right */
function useOffScreenWaiting(
  sortedSessions: Session[],
  storeState: {
    sendingSessionIds: Record<string, boolean>
    executionModes: Record<string, string>
    executingModes: Record<string, string>
    reviewingSessions: Record<string, boolean>
  },
  viewportRef: RefObject<HTMLDivElement | null>
) {
  const [hasLeft, setHasLeft] = useState(false)
  const [hasRight, setHasRight] = useState(false)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const waitingIds = sortedSessions
      .filter(s => getSessionStatus(s, storeState) === 'waiting')
      .map(s => s.id)

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
  }, [sortedSessions, storeState, viewportRef])

  return { hasLeft, hasRight }
}

interface SessionChatModalProps {
  worktreeId: string
  worktreePath: string
  isOpen: boolean
  onClose: () => void
}

function getSessionStatus(
  session: Session,
  storeState: {
    sendingSessionIds: Record<string, boolean>
    executionModes: Record<string, string>
    executingModes: Record<string, string>
    reviewingSessions: Record<string, boolean>
  }
): SessionStatus {
  const isSending = storeState.sendingSessionIds[session.id]
  const executionMode = isSending
    ? (storeState.executingModes[session.id] ??
      storeState.executionModes[session.id] ??
      session.selected_execution_mode ??
      'plan')
    : (storeState.executionModes[session.id] ??
      session.selected_execution_mode ??
      'plan')
  const isReviewing =
    storeState.reviewingSessions[session.id] || !!session.review_results

  if (isSending) {
    if (executionMode === 'plan') return 'planning'
    if (executionMode === 'yolo') return 'yoloing'
    return 'vibing'
  }

  if (session.waiting_for_input) {
    return 'waiting'
  }

  if (isReviewing) return 'review'

  // Check for running/resumable processes (detected on app restart recovery)
  if (
    session.last_run_status === 'running' ||
    session.last_run_status === 'resumable'
  ) {
    const mode = session.last_run_execution_mode ?? 'plan'
    if (mode === 'plan') return 'planning'
    if (mode === 'yolo') return 'yoloing'
    return 'vibing'
  }

  if (session.last_run_status === 'completed') return 'completed'

  return 'idle'
}

export function SessionChatModal({
  worktreeId,
  worktreePath,
  isOpen,
  onClose,
}: SessionChatModalProps) {
  const isMobile = useIsMobile()
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
  const hasRunningTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(t => state.runningTerminals.has(t.id))
  })
  const terminalShortcut = formatShortcutDisplay(
    preferences?.keybindings?.toggle_terminal ?? DEFAULT_KEYBINDINGS.toggle_terminal
  )
  const runShortcut = formatShortcutDisplay(
    preferences?.keybindings?.execute_run ?? DEFAULT_KEYBINDINGS.execute_run
  )
  const createSession = useCreateSession()

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

  // Store state for tab status indicators
  const sendingSessionIds = useChatStore(state => state.sendingSessionIds)
  const executionModes = useChatStore(state => state.executionModes)
  const executingModes = useChatStore(state => state.executingModes)
  const reviewingSessions = useChatStore(state => state.reviewingSessions)
  const planFilePaths = useChatStore(state => state.planFilePaths)
  const sessionDigests = useChatStore(state => state.sessionDigests)
  const storeState = useMemo(
    () => ({
      sendingSessionIds,
      executionModes,
      executingModes,
      reviewingSessions,
    }),
    [sendingSessionIds, executionModes, executingModes, reviewingSessions]
  )

  // Track focused session's status so scroll fires when it changes position
  const currentSessionStatus = currentSession
    ? getSessionStatus(currentSession, storeState)
    : null

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

  // Plan/recap indicators for tab bar buttons
  const hasPlan =
    (currentSessionId ? !!planFilePaths[currentSessionId] : false) ||
    !!currentSession?.plan_file_path
  const hasRecap =
    (currentSessionId ? !!sessionDigests[currentSessionId] : false) ||
    !!currentSession?.digest
  const currentResumeCommand = currentSession
    ? getResumeCommand(currentSession)
    : null

  // Git status for header badges
  const { data: worktree } = useWorktree(worktreeId)
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null
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

  // Open-in actions for mobile overflow menu
  const openInEditor = useOpenWorktreeInEditor()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInFinder = useOpenWorktreeInFinder()
  const openOnGitHub = useOpenBranchOnGitHub()

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

  // CMD+W: close the active session tab, or close modal if last tab
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const pendingCloseAction = useRef<(() => void) | null>(null)

  const executeCloseAction = useCallback(() => {
    pendingCloseAction.current?.()
    pendingCloseAction.current = null
    setCloseConfirmOpen(false)
  }, [])

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
    handleArchiveSession,
    handleDeleteSession,
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
      const { setActiveSession } = useChatStore.getState()
      setActiveSession(worktreeId, sessionId)
    },
    [worktreeId]
  )

  const handleCreateSession = useCallback(() => {
    createSession.mutate(
      { worktreeId, worktreePath },
      {
        onSuccess: newSession => {
          const { setActiveSession } = useChatStore.getState()
          setActiveSession(worktreeId, newSession.id)
        },
      }
    )
  }, [worktreeId, worktreePath, createSession])

  // Sorted sessions for tab order (waiting → review → idle)
  const sortedSessions = useMemo(() => {
    const priority: Record<string, number> = {
      waiting: 0,
      permission: 0,
      review: 1,
    }
    return [...sessions].sort((a, b) => {
      const pa = priority[getSessionStatus(a, storeState)] ?? 2
      const pb = priority[getSessionStatus(b, storeState)] ?? 2
      if (pa !== pb) return pa - pb
      // Stable secondary sort: oldest first (consistent across refetches)
      return a.created_at - b.created_at
    })
  }, [sessions, storeState])

  // Off-screen waiting tab indicators
  const { hasLeft: hasWaitingLeft, hasRight: hasWaitingRight } =
    useOffScreenWaiting(sortedSessions, storeState, modalTabScrollRef)

  const scrollToFirstWaiting = useCallback(
    (direction: 'left' | 'right') => {
      const viewport = modalTabScrollRef.current
      if (!viewport) return
      const { scrollLeft, clientWidth } = viewport
      for (const session of sortedSessions) {
        if (getSessionStatus(session, storeState) !== 'waiting') continue
        const el = viewport.querySelector(
          `[data-session-id="${session.id}"]`
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
          handleTabClick(session.id)
          return
        }
      }
    },
    [sortedSessions, storeState, handleTabClick]
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

  const handlePush = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const toastId = toast.loading('Pushing changes...')
      try {
        const result = await gitPush(worktreePath, worktree?.pr_number)
        triggerImmediateGitPoll()
        if (project) fetchWorktreesStatus(project.id)
        if (result.fellBack) {
          toast.warning(
            'Could not push to PR branch, pushed to new branch instead',
            { id: toastId }
          )
        } else {
          toast.success('Changes pushed', { id: toastId })
        }
      } catch (error) {
        toast.error(`Push failed: ${error}`, { id: toastId })
      }
    },
    [worktree, worktreePath, project]
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
        const planDialogOpen = useUIStore.getState().planDialogOpen

        // Don't close if PlanDialog is open — let it handle ESC
        if (planDialogOpen) return
        // Don't close if CloseWorktreeDialog is open — let it handle ESC
        if (closeConfirmOpen) return
        // Don't close if ESC originated inside a child dialog/sheet portal
        if (portalAncestor) return

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
        className="absolute inset-0 z-10 flex flex-col overflow-hidden bg-background pb-2 pt-[3px]"
      >
        <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-2 sm:text-left">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm font-medium shrink-0">
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
              {isNativeApp() && (
                <div className="hidden sm:flex items-center gap-1">
                  <OpenInButton
                    worktreePath={worktreePath}
                    branch={worktree?.branch}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          useTerminalStore
                            .getState()
                            .toggleModalTerminal(worktreeId)
                        }}
                      >
                        <Terminal className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Terminal{' '}<kbd className="ml-1 text-[0.625rem] opacity-60">{terminalShortcut}</kbd></TooltipContent>
                  </Tooltip>
                  {runScripts.length === 1 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={handleRun}
                        >
                          <Play className={`h-3 w-3 ${hasRunningTerminal ? 'text-yellow-400 animate-icon-glow' : ''}`} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{hasRunningTerminal ? 'Running' : 'Run'}{' '}<kbd className="ml-1 text-[0.625rem] opacity-60">{runShortcut}</kbd></TooltipContent>
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
                            onClick={handleRun}
                          >
                            <Play className={`h-3 w-3 ${hasRunningTerminal ? 'text-yellow-400 animate-icon-glow' : ''}`} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{hasRunningTerminal ? 'Running' : 'Run first command'}{' '}<kbd className="ml-1 text-[0.625rem] opacity-60">{runShortcut}</kbd></TooltipContent>
                      </Tooltip>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-l-none border-l border-border/50 px-1 text-xs"
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
              )}
              {/* Mobile: overflow menu */}
              {isNativeApp() && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 flex sm:hidden"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        openInEditor.mutate({
                          worktreePath,
                          editor: preferences?.editor,
                        })
                      }
                    >
                      <Code className="h-4 w-4" />
                      {getOpenInDefaultLabel(
                        'editor',
                        preferences?.editor,
                        preferences?.terminal
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        openInTerminal.mutate({
                          worktreePath,
                          terminal: preferences?.terminal,
                        })
                      }
                    >
                      <Terminal className="h-4 w-4" />
                      {getOpenInDefaultLabel(
                        'terminal',
                        preferences?.editor,
                        preferences?.terminal
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => openInFinder.mutate(worktreePath)}
                    >
                      <FolderOpen className="h-4 w-4" />
                      Finder
                    </DropdownMenuItem>
                    {worktree?.branch && (
                      <DropdownMenuItem
                        onSelect={() =>
                          openOnGitHub.mutate({
                            repoPath: worktreePath,
                            branch: worktree.branch,
                          })
                        }
                      >
                        <Github className="h-4 w-4" />
                        GitHub
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() =>
                        useTerminalStore
                          .getState()
                          .toggleModalTerminal(worktreeId)
                      }
                    >
                      <Terminal className="h-4 w-4" />
                      Terminal
                    </DropdownMenuItem>
                    {runScripts.length === 1 && (
                      <DropdownMenuItem onSelect={handleRun}>
                        <Play className={`h-4 w-4 ${hasRunningTerminal ? 'text-yellow-400 animate-icon-glow' : ''}`} />
                        Run
                      </DropdownMenuItem>
                    )}
                    {runScripts.length > 1 && (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Play className={`h-4 w-4 ${hasRunningTerminal ? 'text-yellow-400 animate-icon-glow' : ''}`} />
                          Run
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {runScripts.map((cmd, i) => (
                            <DropdownMenuItem
                              key={i}
                              onSelect={() => handleRunCommand(cmd)}
                              className="font-mono text-xs"
                            >
                              {cmd}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                    {currentResumeCommand && (
                      <DropdownMenuItem
                        onSelect={() => {
                          void copyToClipboard(currentResumeCommand)
                            .then(() => toast.success('Resume command copied'))
                            .catch(() =>
                              toast.error('Failed to copy resume command')
                            )
                        }}
                      >
                        <Terminal className="h-4 w-4" />
                        Copy Resume Command
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={!hasRecap}
                      onSelect={() =>
                        window.dispatchEvent(new CustomEvent('open-recap'))
                      }
                    >
                      <Sparkles className="h-4 w-4" />
                      Recap
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!hasPlan}
                      onSelect={() =>
                        window.dispatchEvent(new CustomEvent('open-plan'))
                      }
                    >
                      <FileText className="h-4 w-4" />
                      Plan
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <ModalCloseButton onClick={handleClose} />
            </div>
          </div>
        </div>

        {/* Session tabs */}
        {sessions.length > 0 && (
          <div className="shrink-0 border-b flex items-center gap-0.5 pr-4 relative">
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
              <div className="flex min-w-max items-center gap-1.5 py-1 px-3">
                {sortedSessions.map((session, idx) => {
                  const isActive = session.id === currentSessionId
                  const status = getSessionStatus(session, storeState)
                  const config = statusConfig[status]
                  const chatState = useChatStore.getState()
                  const sessionLabel = chatState.sessionLabels[session.id]
                  const sessionHasPlan =
                    !!planFilePaths[session.id] || !!session.plan_file_path
                  const sessionHasRecap =
                    !!sessionDigests[session.id] || !!session.digest
                  const resumeCommand = getResumeCommand(session)
                  return (
                    <ContextMenu key={session.id}>
                      <ContextMenuTrigger asChild>
                        <button
                          data-session-id={session.id}
                          onClick={() => handleTabClick(session.id)}
                          onDoubleClick={() =>
                            handleStartRenameImmediate(session.id, session.name)
                          }
                          className={cn(
                            'group/tab flex rounded items-center gap-2 px-2.5 py-1.5 text-xs transition-colors whitespace-nowrap border border-transparent',
                            isActive
                              ? 'bg-muted text-foreground'
                              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                            status === 'waiting' &&
                              'border-dashed border-yellow-500 dark:border-yellow-400'
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
                              onClick={e => e.stopPropagation()}
                              className="w-full min-w-0 bg-transparent text-xs outline-none"
                            />
                          ) : (
                            <span className="truncate max-w-48">{session.name}</span>
                          )}
                          {renamingSessionId !== session.id && (
                            <DismissButton
                              tooltip={
                                sessions.filter(s => !s.archived_at).length <= 1
                                  ? 'Close worktree'
                                  : 'Remove session'
                              }
                              onClick={e => {
                                e.stopPropagation()
                                const activeSessions = sessions.filter(
                                  s => !s.archived_at
                                )
                                if (activeSessions.length <= 1) {
                                  const action = () => {
                                    handleDeleteSession(session.id)
                                    onClose()
                                  }
                                  const sessionIsEmpty = !session.message_count
                                  if (
                                    preferences?.confirm_session_close !==
                                      false &&
                                    !sessionIsEmpty
                                  ) {
                                    pendingCloseAction.current = action
                                    setCloseConfirmOpen(true)
                                  } else {
                                    action()
                                  }
                                } else {
                                  handleArchiveSession(session.id)
                                }
                              }}
                              className="ml-0.5 opacity-60 sm:opacity-0 sm:group-hover/tab:opacity-60 hover:!opacity-100"
                              size="xs"
                            />
                          )}
                        </button>
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
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          disabled={!sessionHasRecap}
                          onSelect={() => {
                            useChatStore
                              .getState()
                              .setActiveSession(worktreeId, session.id)
                            requestAnimationFrame(() => {
                              window.dispatchEvent(
                                new CustomEvent('open-recap')
                              )
                            })
                          }}
                        >
                          <Sparkles className="mr-2 h-4 w-4" />
                          Recap
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={!sessionHasPlan}
                          onSelect={() => {
                            useChatStore
                              .getState()
                              .setActiveSession(worktreeId, session.id)
                            requestAnimationFrame(() => {
                              window.dispatchEvent(new CustomEvent('open-plan'))
                            })
                          }}
                        >
                          <FileText className="mr-2 h-4 w-4" />
                          Plan
                        </ContextMenuItem>
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

        <div className="min-h-0 flex-1 overflow-hidden">
          {currentSessionId && (
            <ChatWindow
              key={currentSessionId}
              isModal
              worktreeId={worktreeId}
              worktreePath={worktreePath}
            />
          )}
        </div>

        {/* Terminal side drawer */}
        {isNativeApp() && (
          <ModalTerminalDrawer
            worktreeId={worktreeId}
            worktreePath={worktreePath}
          />
        )}
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
