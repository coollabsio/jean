import { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { StatusIndicator } from '@/components/ui/status-indicator'
import type {
  IndicatorStatus,
  IndicatorVariant,
} from '@/components/ui/status-indicator'
import { ArrowDown, ArrowUp, ChevronDown, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dismissibleToast } from '@/lib/dismissible-toast'
import { isBaseSession, type Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { pushNeedsRemotePicker, useRemotePicker } from '@/hooks/useRemotePicker'
import { TerminalStatusIndicator } from '@/hooks/useWorktreeTerminalStatus'
import { WorktreeContextMenu } from './WorktreeContextMenu'
import { useWorktreeMenuActions } from './useWorktreeMenuActions'
import { CloseWorktreeDialog } from '@/components/chat/CloseWorktreeDialog'
import { useSessionArchive } from '@/components/chat/hooks/useSessionArchive'
import { middleClickClose } from '@/lib/middle-click'
import {
  decideWorktreeMiddleClose,
  decideSessionMiddleClose,
} from './worktree-close-decision'
import { useRenameWorktree } from '@/services/projects'
import { useSessions } from '@/services/chat'
import { isAskUserQuestion, isPlanToolCall, type Session } from '@/types/chat'
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
  defaultBranch,
}: WorktreeItemProps) {
  const isMobile = useIsMobile()
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const selectWorktree = useProjectsStore(state => state.selectWorktree)
  const selectProject = useProjectsStore(state => state.selectProject)
  const isExpanded = useProjectsStore(state =>
    state.expandedWorktreeIds.has(worktree.id)
  )
  const toggleWorktreeExpanded = useProjectsStore(
    state => state.toggleWorktreeExpanded
  )
  // Check if any session in this worktree is running (chat)
  const isChatRunning = useChatStore(state =>
    state.isWorktreeRunning(worktree.id)
  )
  const isQuestionAnswered = useChatStore(state => state.isQuestionAnswered)
  const sendingSessionKey = useChatStore(state => {
    const ids: string[] = []
    for (const [sessionId, isSending] of Object.entries(
      state.sendingSessionIds
    )) {
      if (isSending && state.sessionWorktreeMap[sessionId] === worktree.id) {
        ids.push(sessionId)
      }
    }
    return ids.sort().join('|')
  })
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
  const pickRemoteOrRun = useRemotePicker(worktree.path)

  // Uncommitted changes (working directory)
  const uncommittedAdded =
    gitStatus?.uncommitted_added ?? worktree.cached_uncommitted_added ?? 0
  const uncommittedRemoved =
    gitStatus?.uncommitted_removed ?? worktree.cached_uncommitted_removed ?? 0
  const hasUncommitted = uncommittedAdded > 0 || uncommittedRemoved > 0

  // Fetch sessions to check for persisted unanswered questions
  const { data: sessionsData } = useSessions(worktree.id, worktree.path)

  // Canonical worktree actions — computed once here and passed to
  // WorktreeContextMenu so the hook isn't run twice per row. The middle-click
  // close reuses `handleArchiveOrClose` (same as the context menu).
  const menuActions = useWorktreeMenuActions({ worktree, projectId })
  const { handleArchiveOrClose, preferences } = menuActions

  // Delete/archive a single conversation (session) respecting removal_behavior.
  const { handleDeleteSession } = useSessionArchive({
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    removalBehavior: preferences?.removal_behavior,
  })

  // Confirmation dialog shared by middle-click close of a worktree or a
  // conversation — mirrors the canvas/session-tab "validation" flow. Stores the
  // intent (not a callback) so the action is derived in onConfirm.
  const [closeConfirm, setCloseConfirm] = useState<{
    mode: 'worktree' | 'session'
    sessionId?: string
  } | null>(null)

  // Check if any session has streaming AskUserQuestion waiting (blinks).
  // Return primitive booleans from the store selector so each sidebar row avoids
  // subscribing to the full activeToolCalls/sessionWorktreeMap objects.
  const isStreamingWaitingQuestion = useChatStore(state => {
    for (const [sessionId, toolCalls] of Object.entries(
      state.activeToolCalls
    )) {
      if (state.sessionWorktreeMap[sessionId] !== worktree.id) continue
      if (
        toolCalls.some(
          tc =>
            isAskUserQuestion(tc) && !state.isQuestionAnswered(sessionId, tc.id)
        )
      ) {
        return true
      }
    }
    return false
  })

  // Check if any session has streaming ExitPlanMode waiting (solid)
  const isStreamingWaitingPlan = useChatStore(state => {
    for (const [sessionId, toolCalls] of Object.entries(
      state.activeToolCalls
    )) {
      if (state.sessionWorktreeMap[sessionId] !== worktree.id) continue
      if (
        !(state.sendingSessionIds[sessionId] ?? false) &&
        toolCalls.some(
          tc =>
            isPlanToolCall(tc) && !state.isQuestionAnswered(sessionId, tc.id)
        )
      ) {
        return true
      }
    }
    return false
  })

  // Check if any session has unanswered AskUserQuestion in persisted messages (blinks)
  const hasPendingQuestion = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    for (const session of sessions) {
      // Skip sessions that are currently streaming (handled by isStreamingWaitingQuestion)
      if (useChatStore.getState().sendingSessionIds[session.id]) continue

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
  }, [
    sessionsData?.sessions,
    sendingSessionKey,
    isQuestionAnswered,
    useChatStore,
  ])

  // Check if any session has unanswered ExitPlanMode in persisted messages (solid)
  // Uses plan_approved / approved_plan_message_ids (matching session-card-utils.tsx)
  const hasPendingPlan = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    for (const session of sessions) {
      // Skip sessions that are currently streaming (handled by isStreamingWaitingPlan)
      if (useChatStore.getState().sendingSessionIds[session.id]) continue

      const approvedPlanIds = new Set(session.approved_plan_message_ids ?? [])

      // Find last assistant message by iterating from end (avoids array copy from .reverse())
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const msg = session.messages[i]
        if (msg?.role === 'assistant') {
          if (
            msg.tool_calls?.some(isPlanToolCall) &&
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
  }, [sessionsData?.sessions, sendingSessionKey, useChatStore])

  // Check if any session is explicitly waiting for user input
  const isExplicitlyWaiting = useChatStore(state => {
    for (const [sessionId, isWaiting] of Object.entries(
      state.waitingForInputSessionIds
    )) {
      if (isWaiting && state.sessionWorktreeMap[sessionId] === worktree.id) {
        return true
      }
    }
    return false
  })

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
  const isReviewing = useChatStore(state => {
    const sessions = sessionsData?.sessions ?? []
    for (const session of sessions) {
      if (state.reviewingSessions[session.id]) return true
    }
    return false
  })

  // Get execution mode for running session (yolo vs vibing/plan)
  const runningSessionExecutionMode = useChatStore(state => {
    for (const [sessionId, isSending] of Object.entries(
      state.sendingSessionIds
    )) {
      if (isSending && state.sessionWorktreeMap[sessionId] === worktree.id) {
        return (
          state.executingModes[sessionId] ??
          state.executionModes[sessionId] ??
          'plan'
        )
      }
    }
    return 'plan'
  })

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

  // Active session for this worktree (reactive subscription)
  const activeSessionId = useChatStore(
    state => state.activeSessionIds[worktree.id]
  )

  const storeState = useCanvasStoreState()

  // Card data is only rendered by the expanded session list, so skip the
  // O(sessions × messages) computation entirely for collapsed rows.
  const sessionGroups = useMemo(() => {
    if (!isExpanded) return []
    const sessions = sessionsData?.sessions ?? []
    return groupCardsByStatus(
      sessions.map(s => computeSessionCardData(s, storeState))
    )
  }, [isExpanded, sessionsData?.sessions, storeState])

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

  // Middle-click closes the worktree, mirroring the canvas/session-tab close —
  // including the confirmation dialog when `confirm_session_close` is enabled.
  const handleWorktreeMiddleClose = useCallback(() => {
    if (
      decideWorktreeMiddleClose(preferences?.confirm_session_close) ===
      'confirm'
    ) {
      setCloseConfirm({ mode: 'worktree' })
    } else {
      handleArchiveOrClose()
    }
  }, [preferences?.confirm_session_close, handleArchiveOrClose])

  // Middle-click on a conversation row deletes it, mirroring the session-tab
  // middle-click: validate only when removing the last session of the worktree.
  const handleSessionMiddleClose = useCallback(
    (session: Session) => {
      // The row is rendered from sessionsData, so the count is reliable here.
      const activeSessionCount = (sessionsData?.sessions ?? []).filter(
        s => !s.archived_at
      ).length
      const decision = decideSessionMiddleClose({
        activeSessionCount,
        sessionIsEmpty: !session.message_count,
        confirmSessionClose: preferences?.confirm_session_close,
      })
      if (decision === 'confirm') {
        setCloseConfirm({ mode: 'session', sessionId: session.id })
      } else {
        handleDeleteSession(session.id)
      }
    },
    [
      sessionsData?.sessions,
      handleDeleteSession,
      preferences?.confirm_session_close,
    ]
  )

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
        baseBranch: worktree.base_branch ?? defaultBranch,
        projectId,
        remote: worktree.base_remote,
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
    [
      worktree.id,
      worktree.path,
      worktree.base_branch,
      worktree.base_remote,
      defaultBranch,
      projectId,
      selectWorktree,
    ]
  )

  const handlePush = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()

      const runPush = async (remote?: string) => {
        const opToast = dismissibleToast.loading('Pushing changes...')
        try {
          const result = await gitPush(
            worktree.path,
            worktree.pr_number,
            remote
          )
          triggerImmediateGitPoll()
          fetchWorktreesStatus(projectId)
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

      if (pushNeedsRemotePicker(worktree.pr_number)) {
        pickRemoteOrRun(runPush)
      } else {
        runPush()
      }
    },
    [pickRemoteOrRun, worktree.path, worktree.pr_number, projectId]
  )

  return (
    <div>
      <WorktreeContextMenu actions={menuActions}>
        <div
          className={cn(
            'group relative flex cursor-pointer items-center gap-1.5 py-1.5 pr-2 overflow-hidden transition-colors duration-150',
            isNarrowSidebar ? 'pl-4' : 'pl-7',
            isSelected
              ? 'bg-primary/10 text-foreground before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:bg-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
          )}
          onClick={handleClick}
          {...middleClickClose(handleWorktreeMiddleClose)}
          onDoubleClick={handleDoubleClick}
        >
          {/* Chat status indicator (spinner/dot) */}
          <StatusIndicator
            status={indicatorStatus}
            variant={indicatorVariant}
            className="h-2 w-2"
          />

          {/* Terminal running/failed indicator */}
          <TerminalStatusIndicator worktreeId={worktree.id} />

          {/* Workspace name - editable on double-click */}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              aria-label="Worktree name"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              onClick={e => e.stopPropagation()}
              className="flex-1 bg-transparent text-base outline-none ring-1 ring-ring rounded px-1 md:text-sm"
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
                type="button"
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
                  type="button"
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
                  type="button"
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
                    className={cn(
                      'flex items-center gap-1.5 pl-5 py-1 cursor-pointer text-sm truncate',
                      activeSessionId === card.session.id && isSelected
                        ? 'text-foreground bg-primary/10 font-medium'
                        : activeSessionId === card.session.id
                          ? 'text-foreground/80 hover:text-foreground hover:bg-accent/50'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                    )}
                    onClick={e => {
                      e.stopPropagation()
                      handleSessionSelect(card.session.id)
                    }}
                    {...middleClickClose(() =>
                      handleSessionMiddleClose(card.session)
                    )}
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

      <CloseWorktreeDialog
        open={!!closeConfirm}
        onOpenChange={open => {
          if (!open) setCloseConfirm(null)
        }}
        onConfirm={() => {
          const intent = closeConfirm
          setCloseConfirm(null)
          if (!intent) return
          if (intent.mode === 'session' && intent.sessionId) {
            handleDeleteSession(intent.sessionId)
          } else {
            handleArchiveOrClose()
          }
        }}
        branchName={worktree.branch}
        mode={closeConfirm?.mode ?? 'worktree'}
      />
    </div>
  )
}
