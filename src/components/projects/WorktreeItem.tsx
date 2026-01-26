import { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { BorderSpinner } from '@/components/ui/border-spinner'
import { ArrowDown, ArrowUp, Circle, GitBranch, Square } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { isBaseSession, type Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { WorktreeContextMenu } from './WorktreeContextMenu'
import { useRenameWorktree } from '@/services/projects'
import { useSessions } from '@/services/chat'
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import {
  setActiveWorktreeForPolling,
  useGitStatus,
  gitPull,
  gitPush,
  fetchWorktreesStatus,
} from '@/services/git-status'
import { useSidebarWidth } from '@/components/layout/SidebarWidthContext'

interface WorktreeItemProps {
  worktree: Worktree
  projectId: string
  projectPath: string
  defaultBranch: string
}

export function WorktreeItem({
  worktree,
  projectId,
  projectPath,
  defaultBranch,
}: WorktreeItemProps) {
  const { selectedWorktreeId, selectWorktree, selectProject } =
    useProjectsStore()
  // Check if any session in this worktree is running (chat)
  const isChatRunning = useChatStore(state =>
    state.isWorktreeRunning(worktree.id)
  )
  // Get state needed for streaming waiting check
  const sessionWorktreeMap = useChatStore(state => state.sessionWorktreeMap)
  const activeToolCalls = useChatStore(state => state.activeToolCalls)
  const isQuestionAnswered = useChatStore(state => state.isQuestionAnswered)
  const executionModes = useChatStore(state => state.executionModes)
  const executingModes = useChatStore(state => state.executingModes)
  const sendingSessionIds = useChatStore(state => state.sendingSessionIds)
  const waitingForInputSessionIds = useChatStore(
    state => state.waitingForInputSessionIds
  )
  const reviewingSessions = useChatStore(state => state.reviewingSessions)
  // Check if worktree has a loading operation (commit, pr, review, merge, pull)
  const loadingOperation = useChatStore(
    state => state.worktreeLoadingOperations[worktree.id] ?? null
  )
  const isSelected = selectedWorktreeId === worktree.id
  const isBase = isBaseSession(worktree)

  // Get git status for this worktree from event-driven cache
  // Note: useGitStatus reads from TanStack Query cache, no network requests
  // Data is populated via git:status-update events from the backend
  const { data: gitStatus } = useGitStatus(worktree.id)
  const behindCount =
    gitStatus?.behind_count ?? worktree.cached_behind_count ?? 0
  const worktreeAheadCount =
    gitStatus?.worktree_ahead_count ?? worktree.cached_worktree_ahead_count ?? 0
  const baseBranchAheadCount =
    gitStatus?.base_branch_ahead_count ??
    worktree.cached_base_branch_ahead_count ??
    0
  // For base sessions, show base branch unpushed; for worktrees, show worktree unpushed
  const pushCount = isBase ? baseBranchAheadCount : worktreeAheadCount

  // Uncommitted changes (working directory)
  const uncommittedAdded =
    gitStatus?.uncommitted_added ?? worktree.cached_uncommitted_added ?? 0
  const uncommittedRemoved =
    gitStatus?.uncommitted_removed ?? worktree.cached_uncommitted_removed ?? 0
  const hasUncommitted = uncommittedAdded > 0 || uncommittedRemoved > 0

  // Fetch sessions to check for persisted unanswered questions
  const { data: sessionsData } = useSessions(worktree.id, worktree.path)

  // Check if any session has streaming AskUserQuestion waiting (blinks)
  const isStreamingWaitingQuestion = useMemo(() => {
    for (const [sessionId, toolCalls] of Object.entries(activeToolCalls)) {
      if (sessionWorktreeMap[sessionId] === worktree.id) {
        if (
          toolCalls.some(
            tc => isAskUserQuestion(tc) && !isQuestionAnswered(sessionId, tc.id)
          )
        ) {
          return true
        }
      }
    }
    return false
  }, [activeToolCalls, sessionWorktreeMap, worktree.id, isQuestionAnswered])

  // Check if any session has streaming ExitPlanMode waiting (solid)
  const isStreamingWaitingPlan = useMemo(() => {
    for (const [sessionId, toolCalls] of Object.entries(activeToolCalls)) {
      if (sessionWorktreeMap[sessionId] === worktree.id) {
        if (
          toolCalls.some(
            tc => isExitPlanMode(tc) && !isQuestionAnswered(sessionId, tc.id)
          )
        ) {
          return true
        }
      }
    }
    return false
  }, [activeToolCalls, sessionWorktreeMap, worktree.id, isQuestionAnswered])

  // Check if any session has unanswered AskUserQuestion in persisted messages (blinks)
  const hasPendingQuestion = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    for (const session of sessions) {
      // Skip sessions that are currently streaming (handled by isStreamingWaitingQuestion)
      if (sendingSessionIds[session.id]) continue

      // Find last assistant message by iterating from end (avoids array copy from .reverse())
      let lastAssistantMsg = null
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i]?.role === 'assistant') {
          lastAssistantMsg = session.messages[i]
          break
        }
      }
      if (
        lastAssistantMsg?.tool_calls?.some(
          tc => isAskUserQuestion(tc) && !isQuestionAnswered(session.id, tc.id)
        )
      ) {
        return true
      }
    }
    return false
  }, [sessionsData?.sessions, sendingSessionIds, isQuestionAnswered])

  // Check if any session has unanswered ExitPlanMode in persisted messages (solid)
  const hasPendingPlan = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    for (const session of sessions) {
      // Skip sessions that are currently streaming (handled by isStreamingWaitingPlan)
      if (sendingSessionIds[session.id]) continue

      // Find last assistant message by iterating from end (avoids array copy from .reverse())
      let lastAssistantMsg = null
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i]?.role === 'assistant') {
          lastAssistantMsg = session.messages[i]
          break
        }
      }
      if (
        lastAssistantMsg?.tool_calls?.some(
          tc => isExitPlanMode(tc) && !isQuestionAnswered(session.id, tc.id)
        )
      ) {
        return true
      }
    }
    return false
  }, [sessionsData?.sessions, sendingSessionIds, isQuestionAnswered])

  // Check if any session is explicitly waiting for user input
  const isExplicitlyWaiting = useMemo(() => {
    for (const [sessionId, isWaiting] of Object.entries(
      waitingForInputSessionIds
    )) {
      if (isWaiting && sessionWorktreeMap[sessionId] === worktree.id) {
        return true
      }
    }
    return false
  }, [waitingForInputSessionIds, sessionWorktreeMap, worktree.id])

  // Question waiting (blinks) vs plan waiting (solid)
  const isWaitingQuestion =
    isStreamingWaitingQuestion || hasPendingQuestion || isExplicitlyWaiting
  const isWaitingPlan = isStreamingWaitingPlan || hasPendingPlan

  // Check if any session in this worktree is in review state (done, needs user review)
  const isReviewing = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    for (const session of sessions) {
      if (reviewingSessions[session.id]) return true
    }
    return false
  }, [sessionsData?.sessions, reviewingSessions])

  // Get execution mode for running session (yolo vs vibing/plan)
  const runningSessionExecutionMode = useMemo(() => {
    for (const [sessionId, isSending] of Object.entries(sendingSessionIds)) {
      if (isSending && sessionWorktreeMap[sessionId] === worktree.id) {
        return executingModes[sessionId] ?? executionModes[sessionId] ?? 'plan'
      }
    }
    return 'plan'
  }, [
    sendingSessionIds,
    sessionWorktreeMap,
    worktree.id,
    executingModes,
    executionModes,
  ])

  // Determine indicator color: blinking yellow=waiting for user, green=review, grey=idle
  // Running state uses BorderSpinner component instead (handled in render)
  const indicatorColor = useMemo(() => {
    if (isWaitingQuestion) return 'text-yellow-500 animate-blink shadow-[0_0_6px_currentColor]'
    if (isWaitingPlan) return 'text-yellow-500 animate-blink shadow-[0_0_6px_currentColor]'
    if (isReviewing) return 'text-green-500 shadow-[0_0_6px_currentColor]'
    return 'text-muted-foreground/50'
  }, [isWaitingQuestion, isWaitingPlan, isReviewing])

  // Responsive padding based on sidebar width
  const sidebarWidth = useSidebarWidth()
  const isNarrowSidebar = sidebarWidth < 200

  // Inline editing state
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(worktree.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const renameWorktree = useRenameWorktree()

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // Listen for command:rename-worktree event from command palette
  useEffect(() => {
    const handleRenameWorktreeCommand = (
      e: CustomEvent<{ worktreeId: string }>
    ) => {
      if (e.detail.worktreeId === worktree.id) {
        setEditValue(worktree.name)
        setIsEditing(true)
      }
    }

    window.addEventListener(
      'command:rename-worktree',
      handleRenameWorktreeCommand as EventListener
    )
    return () =>
      window.removeEventListener(
        'command:rename-worktree',
        handleRenameWorktreeCommand as EventListener
      )
  }, [worktree.id, worktree.name])

  const handleClick = useCallback(() => {
    selectProject(projectId)
    selectWorktree(worktree.id)
    // Also set the active worktree for chat
    const { setActiveWorktree } = useChatStore.getState()
    setActiveWorktree(worktree.id, worktree.path)

    // Set the active worktree for git status polling (includes PR info if available)
    setActiveWorktreeForPolling({
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      baseBranch: defaultBranch,
      prNumber: worktree.pr_number,
      prUrl: worktree.pr_url,
    })
  }, [
    projectId,
    worktree.id,
    worktree.path,
    defaultBranch,
    worktree.pr_number,
    worktree.pr_url,
    selectProject,
    selectWorktree,
  ])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setEditValue(worktree.name)
      setIsEditing(true)
    },
    [worktree.name]
  )

  const handleSubmit = useCallback(() => {
    const trimmedValue = editValue.trim()
    if (trimmedValue && trimmedValue !== worktree.name) {
      renameWorktree.mutate({
        worktreeId: worktree.id,
        projectId,
        newName: trimmedValue,
      })
    }
    setIsEditing(false)
  }, [editValue, worktree.id, worktree.name, projectId, renameWorktree])

  const handleCancel = useCallback(() => {
    setEditValue(worktree.name)
    setIsEditing(false)
  }, [worktree.name])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      } else if (e.key === ' ') {
        // Prevent space from triggering parent ContextMenuTrigger
        e.stopPropagation()
      }
    },
    [handleSubmit, handleCancel]
  )

  const handleBlur = useCallback(() => {
    handleSubmit()
  }, [handleSubmit])

  const handlePull = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const { setWorktreeLoading, clearWorktreeLoading } = useChatStore.getState()
      setWorktreeLoading(worktree.id, 'pull')
      const toastId = toast.loading('Pulling changes...')
      try {
        await gitPull(worktree.path, defaultBranch)
        fetchWorktreesStatus(projectId)
        toast.success('Changes pulled', { id: toastId })
      } catch (error) {
        toast.error(`Pull failed: ${error}`, { id: toastId })
      } finally {
        clearWorktreeLoading(worktree.id)
      }
    },
    [worktree.id, worktree.path, defaultBranch, projectId]
  )

  const handlePush = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const toastId = toast.loading('Pushing changes...')
      try {
        await gitPush(worktree.path)
        fetchWorktreesStatus(projectId)
        toast.success('Changes pushed', { id: toastId })
      } catch (error) {
        toast.error(`Push failed: ${error}`, { id: toastId })
      }
    },
    [worktree.path, projectId]
  )

  return (
    <WorktreeContextMenu
      worktree={worktree}
      projectId={projectId}
      projectPath={projectPath}
    >
      <div
        className={cn(
          'group relative flex cursor-pointer items-center gap-1.5 py-1.5 pr-2 transition-colors duration-150',
          isNarrowSidebar ? 'pl-4' : 'pl-7',
          isSelected
            ? 'bg-primary/10 text-foreground before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:bg-primary'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
        )}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {/* Status indicator: circle for base session, square for worktrees */}
        {/* Priority: chat running > loading operation > idle states */}
        {isChatRunning ? (
          <BorderSpinner
            shape={isBase ? 'circle' : 'square'}
            className={cn(
              'h-2 w-2 shadow-[0_0_6px_currentColor]',
              runningSessionExecutionMode === 'yolo' ? 'text-destructive' : 'text-yellow-500'
            )}
            bgClassName={
              runningSessionExecutionMode === 'yolo' ? 'fill-destructive/50' : 'fill-yellow-500/50'
            }
          />
        ) : loadingOperation ? (
          <BorderSpinner
            shape={isBase ? 'circle' : 'square'}
            className="h-2 w-2 shadow-[0_0_6px_currentColor] text-cyan-500"
            bgClassName="fill-cyan-500/50"
          />
        ) : isBase ? (
          <Circle className={cn('h-2 w-2 shrink-0 fill-current rounded-full', indicatorColor)} />
        ) : (
          <Square className={cn('h-2 w-2 shrink-0 fill-current rounded-sm', indicatorColor)} />
        )}

        {/* Workspace name - editable on double-click */}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onClick={e => e.stopPropagation()}
            className="flex-1 bg-transparent text-sm outline-none ring-1 ring-ring rounded px-1"
          />
        ) : (
          <span
            className={cn('flex-1 truncate text-sm', isBase && 'font-medium')}
          >
            {worktree.name}
            {/* Show branch name if different from worktree name */}
            {worktree.branch !== worktree.name && (
              <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                <GitBranch className="h-2.5 w-2.5" />
                {worktree.branch}
              </span>
            )}
          </span>
        )}

        {/* Pull badge - shown when behind remote */}
        {behindCount > 0 && (
          <button
            onClick={handlePull}
            className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
            title={`Pull ${behindCount} commit${behindCount > 1 ? 's' : ''} from remote`}
          >
            <span className="flex items-center gap-0.5">
              <ArrowDown className="h-3 w-3" />
              {behindCount}
            </span>
          </button>
        )}

        {/* Push badge - unpushed commits */}
        {pushCount > 0 && (
          <button
            onClick={handlePush}
            className="shrink-0 rounded bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-medium text-orange-500 transition-colors hover:bg-orange-500/20"
            title={`Push ${pushCount} commit${pushCount > 1 ? 's' : ''} to remote`}
          >
            <span className="flex items-center gap-0.5">
              <ArrowUp className="h-3 w-3" />
              {pushCount}
            </span>
          </button>
        )}

        {/* Uncommitted changes */}
        {hasUncommitted && (
          <span
            className="shrink-0 text-[11px] font-medium"
            title={`Uncommitted: +${uncommittedAdded}/-${uncommittedRemoved} lines`}
          >
            <span className="text-green-500">+{uncommittedAdded}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-red-500">-{uncommittedRemoved}</span>
          </span>
        )}

      </div>
    </WorktreeContextMenu>
  )
}
