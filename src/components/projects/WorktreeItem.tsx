import { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { StatusIndicator } from '@/components/ui/status-indicator'
import type {
  IndicatorStatus,
  IndicatorVariant,
} from '@/components/ui/status-indicator'
import { ArrowDown, ArrowUp, ChevronDown, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { isBaseSession, type Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { WorktreeContextMenu } from './WorktreeContextMenu'
import { useRenameWorktree } from '@/services/projects'
import { useSessions } from '@/services/chat'
import { isAskUserQuestion, isExitPlanMode } from '@/types/chat'
import {
  computeSessionCardData,
  groupCardsByStatus,
  statusConfig,
} from '@/components/chat/session-card-utils'
import { useCanvasStoreState } from '@/components/chat/hooks/useCanvasStoreState'
import {
  useGitStatus,
  gitPush,
  fetchWorktreesStatus,
  triggerImmediateGitPoll,
  performGitPull,
} from '@/services/git-status'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
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
  const isMobile = useIsMobile()
  const {
    selectedWorktreeId,
    selectWorktree,
    selectProject,
    expandedWorktreeIds,
    toggleWorktreeExpanded,
  } = useProjectsStore()
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
  const unpushedCount =
    gitStatus?.unpushed_count ?? worktree.cached_unpushed_count ?? 0
  const pushCount = unpushedCount

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
  // Uses plan_approved / approved_plan_message_ids (matching session-card-utils.tsx)
  const hasPendingPlan = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    for (const session of sessions) {
      // Skip sessions that are currently streaming (handled by isStreamingWaitingPlan)
      if (sendingSessionIds[session.id]) continue

      const approvedPlanIds = new Set(session.approved_plan_message_ids ?? [])

      // Find last assistant message by iterating from end (avoids array copy from .reverse())
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const msg = session.messages[i]
        if (msg?.role === 'assistant') {
          if (
            msg.tool_calls?.some(isExitPlanMode) &&
            !msg.plan_approved &&
            !approvedPlanIds.has(msg.id)
          ) {
            return true
          }
          break
        }
      }
    }
    return false
  }, [sessionsData?.sessions, sendingSessionIds])

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

  // Check for persisted waiting state from session metadata (fallback when messages not loaded)
  const hasPersistedWaitingQuestion = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    return sessions.some(
      s => s.waiting_for_input && s.waiting_for_input_type === 'question'
    )
  }, [sessionsData?.sessions])

  const hasPersistedWaitingPlan = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    return sessions.some(
      s => s.waiting_for_input && s.waiting_for_input_type === 'plan'
    )
  }, [sessionsData?.sessions])

  // Question waiting (blinks) vs plan waiting (solid)
  const isWaitingQuestion =
    isStreamingWaitingQuestion ||
    hasPendingQuestion ||
    isExplicitlyWaiting ||
    hasPersistedWaitingQuestion
  const isWaitingPlan =
    isStreamingWaitingPlan || hasPendingPlan || hasPersistedWaitingPlan

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

  // Determine indicator status and variant for StatusIndicator component
  const { indicatorStatus, indicatorVariant } = useMemo((): {
    indicatorStatus: IndicatorStatus
    indicatorVariant?: IndicatorVariant
  } => {
    if (isWaitingQuestion || isWaitingPlan) {
      return { indicatorStatus: 'waiting' }
    }
    if (isChatRunning) {
      return {
        indicatorStatus: 'running',
        indicatorVariant:
          runningSessionExecutionMode === 'yolo' ? 'destructive' : 'default',
      }
    }
    if (loadingOperation) {
      return { indicatorStatus: 'running', indicatorVariant: 'loading' }
    }
    if (isReviewing) {
      return { indicatorStatus: 'review' }
    }
    return { indicatorStatus: 'idle' }
  }, [
    isWaitingQuestion,
    isWaitingPlan,
    isChatRunning,
    runningSessionExecutionMode,
    loadingOperation,
    isReviewing,
  ])

  // Worktree expansion state for sidebar session list
  const isExpanded = expandedWorktreeIds.has(worktree.id)
  const storeState = useCanvasStoreState()

  // Compute card data for all sessions (needed for both summary and expanded list)
  const allCards = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    return sessions.map(s => computeSessionCardData(s, storeState))
  }, [sessionsData?.sessions, storeState])

  const sessionGroups = useMemo(() => {
    if (!isExpanded) return []
    return groupCardsByStatus(allCards)
  }, [isExpanded, allCards])

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      toggleWorktreeExpanded(worktree.id)
    },
    [worktree.id, toggleWorktreeExpanded]
  )

  const handleSessionSelect = useCallback(
    (sessionId: string) => {
      selectProject(projectId)
      selectWorktree(worktree.id)
      // Clear active worktree so MainWindowContent renders ProjectCanvasView
      // (which hosts SessionChatModal with topbar + session tabs)
      useChatStore.getState().clearActiveWorktree()
      useChatStore.getState().setActiveSession(worktree.id, sessionId)
      // Open session modal in ProjectCanvasView
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: {
              sessionId,
              worktreeId: worktree.id,
              worktreePath: worktree.path,
            },
          })
        )
      }, 50)
    },
    [projectId, worktree.id, worktree.path, selectProject, selectWorktree]
  )

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
    // Clear active worktree so MainWindowContent renders ProjectCanvasView
    // (which hosts SessionChatModal with topbar + session tabs)
    useChatStore.getState().clearActiveWorktree()

    // Open session modal with the first active session
    const sessions = sessionsData?.sessions ?? []
    const activeSessions = sessions.filter(s => !s.archived_at)
    const activeSessionId =
      useChatStore.getState().activeSessionIds[worktree.id]
    const targetSessionId = activeSessionId ?? activeSessions[0]?.id
    if (targetSessionId) {
      useChatStore.getState().setActiveSession(worktree.id, targetSessionId)
    }
    // Always open modal — SessionChatModal fetches sessions independently
    // and falls back to first available session when no activeSessionId is set
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('open-session-modal', {
          detail: {
            sessionId: targetSessionId ?? '',
            worktreeId: worktree.id,
            worktreePath: worktree.path,
          },
        })
      )
    }, 50)

    // Close sidebar on mobile after navigation
    if (isMobile) {
      useUIStore.getState().setLeftSidebarVisible(false)
    }
  }, [
    isMobile,
    projectId,
    worktree.id,
    worktree.path,
    sessionsData?.sessions,
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
        e.stopPropagation()
        handleSubmit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        handleCancel()
      } else if (
        e.key === ' ' ||
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      ) {
        // Prevent space/arrows from triggering parent handlers or canvas navigation
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
      await performGitPull({
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        baseBranch: defaultBranch,
        projectId,
        onMergeConflict: () => {
          selectWorktree(worktree.id)
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent('magic-command', {
                detail: { command: 'resolve-conflicts' },
              })
            )
          }, 100)
        },
      })
    },
    [worktree.id, worktree.path, defaultBranch, projectId, selectWorktree]
  )

  const handlePush = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      const toastId = toast.loading('Pushing changes...')
      try {
        const result = await gitPush(worktree.path, worktree.pr_number)
        triggerImmediateGitPoll()
        fetchWorktreesStatus(projectId)
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
    [worktree.path, worktree.pr_number, projectId]
  )

  return (
    <div>
      <WorktreeContextMenu
        worktree={worktree}
        projectId={projectId}
        projectPath={projectPath}
      >
        <div
          className={cn(
            'group relative flex cursor-pointer items-center gap-1.5 py-1.5 pr-2 overflow-hidden transition-colors duration-150',
            isNarrowSidebar ? 'pl-4' : 'pl-7',
            isSelected
              ? 'bg-primary/10 text-foreground before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:bg-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
          )}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
        >
          {/* Status indicator */}
          <StatusIndicator
            status={indicatorStatus}
            variant={indicatorVariant}
            className="h-2 w-2"
          />

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
              className={cn(
                'flex flex-1 items-center gap-0.5 truncate text-sm',
                isBase && 'font-medium'
              )}
            >
              <span className="truncate">{worktree.name}</span>
              {/* Chevron for expand/collapse sessions */}
              <button
                className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-50 hover:!opacity-100 hover:bg-accent-foreground/10"
                onClick={handleChevronClick}
              >
                <ChevronDown
                  className={cn(
                    'size-3 transition-transform',
                    isExpanded && 'rotate-180'
                  )}
                />
              </button>
              {/* Show branch name only when different from displayed name */}
              {(() => {
                const displayBranch =
                  gitStatus?.current_branch ?? worktree.branch
                return displayBranch !== worktree.name ? (
                  <span className="ml-0.5 inline-flex max-w-[80px] items-center gap-0.5 truncate text-xs text-muted-foreground">
                    <GitBranch className="h-2.5 w-2.5" />
                    {displayBranch}
                  </span>
                ) : null
              })()}
            </span>
          )}

          {/* Pull badge - shown when behind remote */}
          {behindCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handlePull}
                  className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
                >
                  <span className="flex items-center gap-0.5">
                    <ArrowDown className="h-3 w-3" />
                    {behindCount}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{`Pull ${behindCount} commit${behindCount > 1 ? 's' : ''} from remote`}</TooltipContent>
            </Tooltip>
          )}

          {/* Push badge - unpushed commits */}
          {pushCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handlePush}
                  className="shrink-0 rounded bg-orange-500/10 px-1.5 py-0.5 text-[11px] font-medium text-orange-500 transition-colors hover:bg-orange-500/20"
                >
                  <span className="flex items-center gap-0.5">
                    <ArrowUp className="h-3 w-3" />
                    {pushCount}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{`Push ${pushCount} commit${pushCount > 1 ? 's' : ''} to remote`}</TooltipContent>
            </Tooltip>
          )}

          {/* Uncommitted changes */}
          {hasUncommitted && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium">
                  <span className="text-green-500">+{uncommittedAdded}</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-red-500">-{uncommittedRemoved}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>{`Uncommitted: +${uncommittedAdded}/-${uncommittedRemoved} lines`}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </WorktreeContextMenu>

      {/* Expandable session list grouped by status */}
      {isExpanded && sessionGroups.length > 0 && (
        <div
          className={cn(
            'border-l border-border/40 py-0.5',
            isNarrowSidebar ? 'ml-6' : 'ml-9'
          )}
        >
          {sessionGroups.map(group => (
            <div key={group.key}>
              <div className="pl-3 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {group.title}{' '}
                <span className="text-muted-foreground/60">
                  {group.cards.length}
                </span>
              </div>
              {group.cards.map(card => {
                const config = statusConfig[card.status]
                return (
                  <div
                    key={card.session.id}
                    className="flex items-center gap-1.5 pl-5 py-1 cursor-pointer text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 truncate"
                    onClick={e => {
                      e.stopPropagation()
                      handleSessionSelect(card.session.id)
                    }}
                  >
                    <StatusIndicator
                      status={config.indicatorStatus}
                      variant={config.indicatorVariant}
                      className="h-1.5 w-1.5 shrink-0"
                    />
                    <span className="truncate text-xs">
                      {card.session.name || 'Untitled'}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
