import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  BellDot,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  CirclePause,
  HelpCircle,
  FileText,
} from 'lucide-react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { invoke } from '@tauri-apps/api/core'
import { useQueryClient } from '@tanstack/react-query'
import { useAllSessions } from '@/services/chat'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useUnreadCount } from './useUnreadCount'
import { formatShortcutDisplay } from '@/types/keybindings'
import type { Session } from '@/types/chat'
import { useIsMobile } from '@/hooks/use-mobile'

function isUnread(session: Session): boolean {
  if (session.archived_at) return false
  const actionableStatuses = ['completed', 'cancelled', 'crashed']
  const hasFinishedRun =
    session.last_run_status &&
    actionableStatuses.includes(session.last_run_status)
  const isWaiting = session.waiting_for_input
  const isReviewing = session.is_reviewing
  if (!hasFinishedRun && !isWaiting && !isReviewing) return false
  if (!session.last_opened_at) return true
  return session.last_opened_at < session.updated_at
}

function formatRelativeTime(timestamp: number): string {
  const ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
  const diffMs = Date.now() - ms
  if (diffMs < 0) return 'just now'
  const minuteMs = 60_000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (diffMs < hourMs)
    return `${Math.max(1, Math.floor(diffMs / minuteMs))}m ago`
  if (diffMs < dayMs) return `${Math.floor(diffMs / hourMs)}h ago`
  return `${Math.floor(diffMs / dayMs)}d ago`
}

interface UnreadItem {
  session: Session
  projectId: string
  projectName: string
  worktreeId: string
  worktreeName: string
  worktreePath: string
}

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

interface UnreadBellProps {
  title: string
  hideTitle?: boolean
}

export function UnreadBell({ title, hideTitle }: UnreadBellProps) {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const contentRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const unreadCount = useUnreadCount()
  const { data: allSessions, isLoading } = useAllSessions(open)
  const selectedProjectId = useProjectsStore(
    state => state.selectedProjectId
  )

  // Listen for command palette event to open the popover
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('command:open-unread-sessions', handler)
    return () =>
      window.removeEventListener('command:open-unread-sessions', handler)
  }, [])

  // Reset open state when all sessions are read so the popover
  // doesn't auto-reappear when a new unread session arrives
  useEffect(() => {
    if (unreadCount === 0) setOpen(false)
  }, [unreadCount])

  // Invalidate cache each time popover opens
  useEffect(() => {
    if (open) {
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
      setFocusedIndex(0)
    }
  }, [open, queryClient])

  // Invalidate when any session is opened (so the count stays fresh)
  useEffect(() => {
    const handler = () =>
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
    window.addEventListener('session-opened', handler)
    return () => window.removeEventListener('session-opened', handler)
  }, [queryClient])

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
    return results.sort(
      (a, b) => b.session.updated_at - a.session.updated_at
    )
  }, [allSessions])

  const groupedItems = useMemo(() => {
    const groups = new Map<
      string,
      { projectId: string; projectName: string; items: UnreadItem[] }
    >()
    for (const item of unreadItems) {
      const existing = groups.get(item.projectId)
      if (existing) {
        existing.items.push(item)
      } else {
        groups.set(item.projectId, {
          projectId: item.projectId,
          projectName: item.projectName,
          items: [item],
        })
      }
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.projectId === selectedProjectId) return -1
      if (b.projectId === selectedProjectId) return 1
      return a.projectName.localeCompare(b.projectName)
    })
  }, [unreadItems, selectedProjectId])

  // Flat list of items across groups for keyboard navigation
  const flatItems = useMemo(
    () => groupedItems.flatMap(g => g.items),
    [groupedItems]
  )

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
      // Adjust focus: stay at same index or move up if at end
      setFocusedIndex(i => {
        const newTotal = flatItems.length - 1
        if (newTotal <= 0) return -1
        return Math.min(i, newTotal - 1)
      })
    },
    [queryClient, flatItems.length, markSessionsReadOptimistically]
  )

  const handleSelect = useCallback((item: UnreadItem) => {
    const { selectedProjectId, selectProject } =
      useProjectsStore.getState()
    const {
      setActiveSession,
      clearActiveWorktree,
      setLastOpenedForProject,
    } = useChatStore.getState()

    const crossProject = selectedProjectId !== item.projectId
    if (crossProject) {
      selectProject(item.projectId)
    }

    // Navigate to ProjectCanvasView
    clearActiveWorktree()
    setActiveSession(item.worktreeId, item.session.id)
    setLastOpenedForProject(item.projectId, item.worktreeId, item.session.id)
    markSessionsReadOptimistically([item.session.id])
    setOpen(false)

    if (crossProject) {
      // Component remounts with new projectId key — use store-based auto-open
      useUIStore
        .getState()
        .markWorktreeForAutoOpenSession(
          item.worktreeId,
          item.session.id
        )
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
  }, [markSessionsReadOptimistically])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const total = flatItems.length
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
          if (focusedIndex >= 0 && flatItems[focusedIndex]) {
            handleSelect(flatItems[focusedIndex])
          }
          break
        case 'Backspace':
          e.preventDefault()
          if (focusedIndex >= 0 && flatItems[focusedIndex]) {
            handleMarkOneRead(flatItems[focusedIndex])
          }
          break
      }
    },
    [flatItems, focusedIndex, handleSelect, handleMarkOneRead]
  )

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return
    document
      .querySelector(`[data-unread-index="${focusedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  // No unread → show normal title (or nothing if hideTitle)
  if (unreadCount === 0) {
    if (hideTitle) return null
    return (
      <span className="block truncate text-sm font-medium text-foreground/80">
        {title}
      </span>
    )
  }

  // Build flat index for rendering
  let itemIndex = 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="card-border-spin">
          <button
            type="button"
            className="relative z-[1] flex items-center gap-1.5 truncate rounded-md bg-background px-1.5 text-sm font-medium text-yellow-400 cursor-pointer"
          >
            <BellDot className="h-3.5 w-3.5 shrink-0 animate-[bell-ring_2s_ease-in-out_infinite]" />
            {unreadCount} finished{' '}
            {unreadCount === 1 ? 'session' : 'sessions'}
            {!isMobile && (
              <Kbd className="ml-1 h-4 px-1 text-[10px] opacity-60">
                {formatShortcutDisplay('mod+shift+f')}
              </Kbd>
            )}
          </button>
        </div>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="center"
        sideOffset={6}
        className="w-[380px] p-0"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={e => e.stopPropagation()}
        onOpenAutoFocus={e => {
          e.preventDefault()
          contentRef.current?.focus()
        }}
      >
        {/* Mark all read */}
        {unreadItems.length > 0 && (
          <div className="flex items-center justify-end px-3 py-1.5 border-b">
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Mark all read
            </button>
          </div>
        )}

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
            {groupedItems.map(group => (
              <div key={group.projectId}>
                <div className="text-[10px] font-medium uppercase tracking-wider px-2 pt-1.5 pb-0.5 text-muted-foreground">
                  {group.projectName}
                </div>
                {group.items.map(item => {
                  const status = getSessionStatus(item.session)
                  const StatusIcon = status?.icon ?? CheckCircle2
                  const idx = itemIndex++

                  return (
                    <button
                      key={item.session.id}
                      type="button"
                      data-unread-index={idx}
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
                      <span className="text-sm truncate flex-1 min-w-0">
                        {item.session.name}
                      </span>
                      <span className="text-[11px] text-muted-foreground/60 min-w-0 max-w-[40%] truncate">
                        {item.worktreeName}
                      </span>
                      <span className="text-[11px] text-muted-foreground/40 shrink-0">
                        {formatRelativeTime(item.session.updated_at)}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
