import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  BellDot,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  CirclePause,
  HelpCircle,
  FileText,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { useAllSessions } from '@/services/chat'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { Session } from '@/types/chat'

interface UnreadSessionsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * A session is "unread" if it has activity the user hasn't seen:
 * - Not archived
 * - Has a meaningful status (finished, waiting for input, or reviewing)
 * - Never opened, or opened before last update
 */
function isUnread(session: Session): boolean {
  if (session.archived_at) return false

  const actionableStatuses = ['completed', 'cancelled', 'crashed']
  const hasFinishedRun =
    session.last_run_status &&
    actionableStatuses.includes(session.last_run_status)
  const isWaiting = session.waiting_for_input
  const isReviewing = session.is_reviewing

  // Must have some actionable state
  if (!hasFinishedRun && !isWaiting && !isReviewing) return false

  // Never opened → definitely unread
  if (!session.last_opened_at) return true

  // Opened before last update → unread
  return session.last_opened_at < session.updated_at
}

/** Format a unix timestamp (seconds) to relative time like "2h ago" */
function formatRelativeTime(timestamp: number): string {
  const ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
  const diffMs = Date.now() - ms
  if (diffMs < 0) return 'just now'
  const minuteMs = 60_000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs))
    return `${minutes}m ago`
  }
  if (diffMs < dayMs) {
    const hours = Math.floor(diffMs / hourMs)
    return `${hours}h ago`
  }
  const days = Math.floor(diffMs / dayMs)
  return `${days}d ago`
}

interface UnreadItem {
  session: Session
  projectId: string
  projectName: string
  worktreeId: string
  worktreeName: string
  worktreePath: string
}

/** Get display info for a session's current state */
function getSessionStatus(session: Session) {
  if (session.waiting_for_input) {
    const isplan = session.waiting_for_input_type === 'plan'
    return {
      icon: isplan ? FileText : HelpCircle,
      label: isplan ? 'Needs approval' : 'Needs input',
      className: 'text-yellow-500',
    }
  }

  const config: Record<
    string,
    { icon: typeof CheckCircle2; label: string; className: string }
  > = {
    completed: {
      icon: CheckCircle2,
      label: 'Completed',
      className: 'text-green-500',
    },
    cancelled: {
      icon: CirclePause,
      label: 'Cancelled',
      className: 'text-muted-foreground',
    },
    crashed: {
      icon: AlertTriangle,
      label: 'Crashed',
      className: 'text-destructive',
    },
  }

  if (session.last_run_status && config[session.last_run_status]) {
    return config[session.last_run_status]
  }

  return null
}

export function UnreadSessionsDrawer({
  open,
  onOpenChange,
}: UnreadSessionsDrawerProps) {
  const queryClient = useQueryClient()
  const panelRef = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const { data: allSessions, isLoading } = useAllSessions(open)
  // Invalidate cached data each time panel opens so manually-read sessions disappear
  useEffect(() => {
    if (open) {
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
      setFocusedIndex(-1)
      // Auto-focus panel for keyboard nav
      setTimeout(() => panelRef.current?.focus(), 50)
    }
  }, [open, queryClient])

  const unreadItems = useMemo((): UnreadItem[] => {
    if (!allSessions) return []

    const results: UnreadItem[] = []

    for (const entry of allSessions.entries) {
      for (const session of entry.sessions) {
        if (isUnread(session)) {
          results.push({
            session,
            projectId: entry.project_id,
            projectName: entry.project_name,
            worktreeId: entry.worktree_id,
            worktreeName: entry.worktree_name,
            worktreePath: entry.worktree_path,
          })
        }
      }
    }

    return results.sort((a, b) => b.session.updated_at - a.session.updated_at)
  }, [allSessions])

  const markSessionsReadOptimistically = useCallback(
    (sessionIds: string[]) => {
      const now = Math.floor(Date.now() / 1000)
      queryClient.setQueryData(['all-sessions'], old => {
        if (!old) return old
        const data = old as { entries?: { sessions?: Session[] }[] }
        if (!data.entries) return old
        return {
          ...data,
          entries: data.entries.map(entry => ({
            ...entry,
            sessions: (entry.sessions ?? []).map(session =>
              sessionIds.includes(session.id)
                ? { ...session, last_opened_at: now }
                : session
            ),
          })),
        }
      })
    },
    [queryClient]
  )

  const handleMarkAllRead = useCallback(async () => {
    const ids = unreadItems.map(item => item.session.id)
    markSessionsReadOptimistically(ids)
    await invoke('set_sessions_last_opened_bulk', { sessionIds: ids })
    queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
    window.dispatchEvent(new CustomEvent('session-opened'))
  }, [unreadItems, queryClient, markSessionsReadOptimistically])

  const handleMarkOneRead = useCallback(
    async (item: UnreadItem) => {
      markSessionsReadOptimistically([item.session.id])
      await invoke('set_session_last_opened', {
        sessionId: item.session.id,
      })
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
      window.dispatchEvent(new CustomEvent('session-opened'))
      setFocusedIndex(i => {
        const newTotal = unreadItems.length - 1
        if (newTotal <= 0) return -1
        return Math.min(i, newTotal - 1)
      })
    },
    [queryClient, unreadItems.length, markSessionsReadOptimistically]
  )

  const handleSelect = useCallback(
    (item: UnreadItem) => {
      const { selectedProjectId, selectProject } = useProjectsStore.getState()
      const { setActiveSession, clearActiveWorktree } = useChatStore.getState()

      const crossProject = selectedProjectId !== item.projectId
      if (crossProject) {
        selectProject(item.projectId)
      }

      // Navigate to ProjectCanvasView
      clearActiveWorktree()
      setActiveSession(item.worktreeId, item.session.id)
      markSessionsReadOptimistically([item.session.id])
      onOpenChange(false)

      if (crossProject) {
        // Component remounts with new projectId key — use store-based auto-open
        useUIStore
          .getState()
          .markWorktreeForAutoOpenSession(item.worktreeId, item.session.id)
      } else {
        // Same project, component stays mounted — use event
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent('open-session-modal', {
              detail: {
                sessionId: item.session.id,
                worktreeId: item.worktreeId,
                worktreePath: item.worktreePath,
              },
            })
          )
        }, 50)
      }
    },
    [onOpenChange, markSessionsReadOptimistically]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false)
        return
      }

      const total = unreadItems.length
      if (!total) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setFocusedIndex(i => (i < 0 ? 0 : Math.min(i + 1, total - 1)))
          break
        case 'ArrowUp':
          e.preventDefault()
          setFocusedIndex(i => (i < 0 ? 0 : Math.max(i - 1, 0)))
          break
        case 'Enter':
          e.preventDefault()
          if (focusedIndex >= 0 && unreadItems[focusedIndex]) {
            handleSelect(unreadItems[focusedIndex])
          }
          break
        case 'Backspace':
          e.preventDefault()
          if (focusedIndex >= 0 && unreadItems[focusedIndex]) {
            handleMarkOneRead(unreadItems[focusedIndex])
          }
          break
      }
    },
    [unreadItems, focusedIndex, handleSelect, handleMarkOneRead, onOpenChange]
  )

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return
    document
      .querySelector(`[data-unread-drawer-index="${focusedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80]" onClick={() => onOpenChange(false)}>
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="absolute left-1/2 top-12 -translate-x-1/2 w-[min(480px,calc(100vw-2rem))] bg-popover border rounded-lg shadow-lg animate-in fade-in-0 slide-in-from-top-2 duration-200 outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <BellDot className="h-3.5 w-3.5" />
            Unread
            {unreadItems.length > 0 && (
              <span className="text-xs bg-muted px-1.5 py-0.5 rounded-full">
                {unreadItems.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unreadItems.length > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                Mark all read
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : unreadItems.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-xs">
            No unread sessions
          </div>
        ) : (
          <div className="max-h-[min(400px,60vh)] overflow-y-auto p-1">
            {unreadItems.map((item, idx) => {
              const status = getSessionStatus(item.session)
              const StatusIcon = status?.icon ?? CheckCircle2

              return (
                <button
                  key={item.session.id}
                  type="button"
                  data-unread-drawer-index={idx}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setFocusedIndex(idx)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors cursor-pointer flex items-center gap-2',
                    focusedIndex === idx && 'bg-accent'
                  )}
                >
                  <StatusIcon
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      status?.className ?? 'text-muted-foreground'
                    )}
                  />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50 shrink-0">
                    {item.projectName}
                  </span>
                  <span className="text-[13px] truncate flex-1 min-w-0">
                    {item.session.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground/40 shrink-0">
                    {formatRelativeTime(item.session.updated_at)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default UnreadSessionsDrawer
