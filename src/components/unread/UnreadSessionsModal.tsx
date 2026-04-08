import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  BellDot,
  Loader2,
  CheckCircle2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { useAllSessions } from '@/services/chat'
import type { Session } from '@/types/chat'
import {
  type SessionListItem,
  isUnread,
  isActionable,
  formatRelativeTime,
  getSessionStatus,
  navigateToSession,
} from '@/lib/session-utils'

interface UnreadSessionsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
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

  // Split actionable sessions into unread (top, full opacity) and read (bottom, dimmed)
  const { unreadItems, readItems } = useMemo(() => {
    if (!allSessions) return { unreadItems: [] as SessionListItem[], readItems: [] as SessionListItem[] }
    const unread: SessionListItem[] = []
    const read: SessionListItem[] = []
    for (const entry of allSessions.entries) {
      for (const session of entry.sessions) {
        if (!isActionable(session)) continue
        const item: SessionListItem = {
          session,
          projectId: entry.project_id,
          projectName: entry.project_name,
          worktreeId: entry.worktree_id,
          worktreeName: entry.worktree_name,
          worktreePath: entry.worktree_path,
        }
        if (isUnread(session)) {
          unread.push(item)
        } else {
          read.push(item)
        }
      }
    }
    const byUpdated = (a: SessionListItem, b: SessionListItem) =>
      b.session.updated_at - a.session.updated_at
    return {
      unreadItems: unread.sort(byUpdated),
      readItems: read.sort(byUpdated),
    }
  }, [allSessions])

  const allItems = useMemo(
    () => [...unreadItems, ...readItems],
    [unreadItems, readItems]
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
    async (item: SessionListItem) => {
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
    (item: SessionListItem) => {
      markSessionsReadOptimistically([item.session.id])
      onOpenChange(false)
      navigateToSession(item)
    },
    [onOpenChange, markSessionsReadOptimistically]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false)
        return
      }

      const total = allItems.length
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
          if (focusedIndex >= 0 && allItems[focusedIndex]) {
            handleSelect(allItems[focusedIndex])
          }
          break
        case 'Backspace':
          e.preventDefault()
          if (focusedIndex >= 0 && focusedIndex < unreadItems.length && unreadItems[focusedIndex]) {
            handleMarkOneRead(unreadItems[focusedIndex])
          }
          break
      }
    },
    [allItems, unreadItems, focusedIndex, handleSelect, handleMarkOneRead, onOpenChange]
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
        ) : allItems.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-xs">
            No sessions with activity
          </div>
        ) : (
          <div className="max-h-[min(400px,60vh)] overflow-y-auto p-1">
            {allItems.map((item, idx) => {
              const status = getSessionStatus(item.session)
              const StatusIcon = status?.icon ?? CheckCircle2
              const isRead = idx >= unreadItems.length

              return (
                <button
                  key={item.session.id}
                  type="button"
                  data-unread-drawer-index={idx}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setFocusedIndex(idx)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors cursor-pointer flex items-center gap-2',
                    focusedIndex === idx && 'bg-accent',
                    isRead && 'opacity-50'
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
