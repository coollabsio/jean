import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  BellDot,
  Loader2,
  CheckCircle2,
} from 'lucide-react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { useAllSessions } from '@/services/chat'
import { useUnreadCount } from './useUnreadCount'
import { formatShortcutDisplay } from '@/types/keybindings'
import type { Session } from '@/types/chat'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  type SessionListItem,
  isUnread,
  isActionable,
  formatRelativeTime,
  getSessionStatus,
  navigateToSession,
} from '@/lib/session-utils'

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
  // Listen for command palette event to open the popover
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('command:open-unread-sessions', handler)
    return () =>
      window.removeEventListener('command:open-unread-sessions', handler)
  }, [])

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

  // Combined list for keyboard navigation (unread first, then read)
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
      // Adjust focus: stay at same index or move up if at end
      setFocusedIndex(i => {
        const newTotal = unreadItems.length - 1
        if (newTotal <= 0) return -1
        return Math.min(i, newTotal - 1)
      })
    },
    [queryClient, unreadItems.length, markSessionsReadOptimistically]
  )

  const handleSelect = useCallback((item: SessionListItem) => {
    markSessionsReadOptimistically([item.session.id])
    setOpen(false)
    navigateToSession(item)
  }, [markSessionsReadOptimistically])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
          // Only mark-read works on unread items (first N in the list)
          if (focusedIndex >= 0 && focusedIndex < unreadItems.length && unreadItems[focusedIndex]) {
            handleMarkOneRead(unreadItems[focusedIndex])
          }
          break
      }
    },
    [allItems, unreadItems, focusedIndex, handleSelect, handleMarkOneRead]
  )

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return
    document
      .querySelector(`[data-unread-index="${focusedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  // Popover is always openable (notification center style).
  // When unread > 0, show animated bell trigger; otherwise show title as clickable button.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {unreadCount > 0 ? (
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
        ) : hideTitle ? (
          <span className="sr-only" />
        ) : (
          <button
            type="button"
            className="block truncate text-sm font-medium text-foreground/80 cursor-pointer"
          >
            {title}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="center"
        sideOffset={6}
        className="w-[min(440px,calc(100vw-2rem))] p-0"
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
                  data-unread-index={idx}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setFocusedIndex(idx)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors cursor-pointer flex items-start gap-2',
                    focusedIndex === idx && 'bg-accent',
                    isRead && 'opacity-50'
                  )}
                >
                  <StatusIcon
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 mt-0.5',
                      status?.className ?? 'text-muted-foreground'
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50 shrink-0">
                        {item.projectName}
                      </span>
                      <span className="text-[11px] text-muted-foreground/40 shrink-0 ml-auto">
                        {formatRelativeTime(item.session.updated_at)}
                      </span>
                    </div>
                    <span className="text-[13px] truncate block">
                      {item.session.name}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
