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
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { useAllSessions } from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useUnreadCount } from './useUnreadCount'
import { formatShortcutDisplay } from '@/types/keybindings'
import type { Session } from '@/types/chat'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'
import { isUnreadSession } from './unread-utils'

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
  // Prefer specific actionable reasons over generic waiting (matches canvas)
  const hasCodexPermission =
    (session.pending_codex_permission_requests?.length ?? 0) > 0 ||
    (session.pending_opencode_permission_requests?.length ?? 0) > 0 ||
    (session.pending_permission_denials?.length ?? 0) > 0
  const hasCodexCommand =
    (session.pending_codex_command_approval_requests?.length ?? 0) > 0
  const hasCodexUserInput =
    (session.pending_codex_user_input_requests?.length ?? 0) > 0
  const hasCodexMcp =
    (session.pending_codex_mcp_elicitation_requests?.length ?? 0) > 0
  const hasCodexTool =
    (session.pending_codex_dynamic_tool_call_requests?.length ?? 0) > 0

  if (hasCodexPermission) {
    return {
      icon: AlertTriangle,
      label: 'Permission required',
      className: 'text-yellow-500',
    }
  }
  if (hasCodexCommand) {
    return {
      icon: AlertTriangle,
      label: 'Command approval required',
      className: 'text-yellow-500',
    }
  }
  if (hasCodexTool) {
    return {
      icon: AlertTriangle,
      label: 'Tool approval required',
      className: 'text-yellow-500',
    }
  }
  if (hasCodexMcp) {
    return {
      icon: HelpCircle,
      label: 'MCP input required',
      className: 'text-yellow-500',
    }
  }
  if (hasCodexUserInput) {
    return {
      icon: HelpCircle,
      label: 'Input required',
      className: 'text-yellow-500',
    }
  }
  if (session.waiting_for_input) {
    const isPlan = session.waiting_for_input_type === 'plan'
    return {
      icon: isPlan ? FileText : HelpCircle,
      label: isPlan ? 'Plan approval required' : 'Input required',
      className: 'text-yellow-500',
    }
  }
  if (session.scheduled_wakeup) {
    return {
      icon: CirclePause,
      label: 'Scheduled',
      className: 'text-cyan-500',
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
  const [snapshotItems, setSnapshotItems] = useState<UnreadItem[] | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const showDesktopKeyboardAffordances = isNativeApp() && !isMobile
  const queryClient = useQueryClient()
  const unreadCount = useUnreadCount()
  const { data: preferences } = usePreferences()
  const animationEnabled =
    preferences?.finished_session_animation_enabled ?? true
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
      // Snapshot fallback: if popover was opened via command palette / external
      // event (bypassing handleOpenChange), seed the snapshot here so subsequent
      // status flips can't drain the rendered list. No-op if already set.
      setSnapshotItems(prev => prev ?? unreadItems)
    }
    // unreadItems intentionally omitted: snapshot only on open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, queryClient])

  // Invalidate when any session is opened (so the count stays fresh)
  useEffect(() => {
    const handler = () =>
      queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
    window.addEventListener('session-opened', handler)
    return () => window.removeEventListener('session-opened', handler)
  }, [queryClient])

  // Clear snapshot when popover fully closes
  useEffect(() => {
    if (!open) setSnapshotItems(null)
  }, [open])

  // Prune deleted sessions from the open snapshot. A session removed from the
  // live ['all-sessions'] data (closed/archived/worktree deleted) is dropped,
  // while a row that merely flipped status stays present in `entries` — so this
  // does not reintroduce the mid-interaction yank the snapshot prevents.
  useEffect(() => {
    if (!open || !allSessions) return
    const liveIds = new Set(
      allSessions.entries.flatMap(e => e.sessions.map(s => s.id))
    )
    setSnapshotItems(prev =>
      prev ? prev.filter(item => liveIds.has(item.session.id)) : prev
    )
    // snapshotItems intentionally omitted to avoid a self-triggering loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSessions, open])

  const unreadItems = useMemo((): UnreadItem[] => {
    if (!allSessions) return []
    const results: UnreadItem[] = []
    for (const entry of allSessions.entries) {
      for (const session of entry.sessions) {
        if (isUnreadSession(session)) {
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

  // Items rendered inside the popover. While open, prefer the snapshot taken at
  // open time so a queued prompt restarting a session (status flip → unread=false)
  // does not yank items out from under the user mid-interaction.
  const displayItems = open && snapshotItems ? snapshotItems : unreadItems

  const markSessionsReadOptimistically = useCallback(
    (sessionIds: string[]) => {
      const now = Math.floor(Date.now() / 1000)
      const sessionIdSet = new Set(sessionIds)
      queryClient.setQueryData(['all-sessions'], old => {
        if (!old) return old
        const data = old as { entries?: { sessions?: Session[] }[] }
        if (!data.entries) return old
        return {
          ...data,
          entries: data.entries.map(entry => ({
            ...entry,
            sessions: (entry.sessions ?? []).map(session =>
              sessionIdSet.has(session.id)
                ? { ...session, last_opened_at: now }
                : session
            ),
          })),
        }
      })
    },
    [queryClient]
  )

  const markSessionsOpened = useCallback(
    async (sessionIds: string[]) => {
      const ids = [...new Set(sessionIds)].filter(Boolean)
      if (ids.length === 0) return

      const idSet = new Set(ids)
      setSnapshotItems(prev =>
        prev ? prev.filter(item => !idSet.has(item.session.id)) : prev
      )
      markSessionsReadOptimistically(ids)

      try {
        if (ids.length === 1) {
          await invoke('set_session_last_opened', {
            sessionId: ids[0],
          })
        } else {
          await invoke('set_sessions_last_opened_bulk', { sessionIds: ids })
        }
      } catch {
        // Cache invalidation below will reconcile optimistic state.
      } finally {
        queryClient.invalidateQueries({ queryKey: ['all-sessions'] })
        window.dispatchEvent(
          new CustomEvent('session-opened', { detail: { sessionIds: ids } })
        )
      }
    },
    [markSessionsReadOptimistically, queryClient]
  )

  const handleMarkAllRead = useCallback(async () => {
    const ids = displayItems.map(item => item.session.id)
    await markSessionsOpened(ids)
  }, [displayItems, markSessionsOpened])

  const handleMarkOneRead = useCallback(
    async (item: UnreadItem) => {
      await markSessionsOpened([item.session.id])
      // Adjust focus: stay at same index or move up if at end
      setFocusedIndex(i => {
        const newTotal = displayItems.length - 1
        if (newTotal <= 0) return -1
        return Math.min(i, newTotal - 1)
      })
    },
    [displayItems.length, markSessionsOpened]
  )

  const handleSelect = useCallback(
    (item: UnreadItem) => {
      const { selectedProjectId, selectProject } = useProjectsStore.getState()
      const { setActiveSession, clearActiveWorktree, setLastOpenedForProject } =
        useChatStore.getState()

      if (selectedProjectId !== item.projectId) {
        selectProject(item.projectId)
      }

      // Navigate to ProjectCanvasView (no-op if already there)
      clearActiveWorktree()
      setActiveSession(item.worktreeId, item.session.id, {
        markOpened: false,
      })
      setLastOpenedForProject(item.projectId, item.worktreeId, item.session.id)

      // Queue auto-open via store so it survives lazy-mount + Suspense + remount.
      // ProjectCanvasView consumes pendingAutoOpenSessionIds in its own effect.
      useUIStore
        .getState()
        .markWorktreeForAutoOpenSession(item.worktreeId, item.session.id)

      // Mark read AFTER auto-open is queued so unreadCount->0 unmount can't race
      // the modal-open path. Bell popover closes via the unreadCount===0 check.
      void markSessionsOpened([item.session.id])
      setOpen(false)
    },
    [markSessionsOpened]
  )

  const handleTriggerClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      // Single finished session: navigate directly. Captures session id at click
      // time, immune to status flips that would otherwise drop unreadCount→0
      // and unmount the popover before the user can pick the item.
      const only = unreadItems.length === 1 ? unreadItems[0] : null
      if (only) {
        e.preventDefault()
        handleSelect(only)
        return
      }
      setSnapshotItems(unreadItems)
    },
    [unreadItems, handleSelect]
  )

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) setSnapshotItems(unreadItems)
      setOpen(next)
    },
    [unreadItems]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const total = displayItems.length
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
          if (focusedIndex >= 0 && displayItems[focusedIndex]) {
            handleSelect(displayItems[focusedIndex])
          }
          break
        case 'Backspace':
        case 'r':
        case 'R':
          if (!showDesktopKeyboardAffordances) break
          e.preventDefault()
          if (focusedIndex >= 0 && displayItems[focusedIndex]) {
            handleMarkOneRead(displayItems[focusedIndex])
          }
          break
      }
    },
    [
      displayItems,
      focusedIndex,
      handleSelect,
      handleMarkOneRead,
      showDesktopKeyboardAffordances,
    ]
  )

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return
    document
      .querySelector(`[data-unread-index="${focusedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  // No unread → show normal title (or nothing if hideTitle).
  // Keep trigger mounted while popover is open so a queued prompt restarting a
  // session mid-interaction can't yank the trigger out and detach the popover.
  if (unreadCount === 0 && !open) {
    if (hideTitle) return null
    return (
      <span className="block truncate text-sm font-medium text-foreground/80">
        {title}
      </span>
    )
  }

  // Display count: prefer snapshot length while popover is open so the trigger
  // label matches what's actually shown inside the popover (and stays > 0 after
  // a status flip, until the user dismisses).
  const displayCount =
    open && snapshotItems ? snapshotItems.length : unreadCount

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <div>
          <button
            type="button"
            onClick={handleTriggerClick}
            className="relative z-[1] flex items-center gap-1.5 truncate rounded-md bg-background px-1.5 text-sm font-medium text-yellow-400 cursor-pointer"
          >
            <BellDot
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                animationEnabled &&
                  'animate-[bell-ring_2s_ease-in-out_infinite]'
              )}
            />
            {displayCount} finished{' '}
            {displayCount === 1 ? 'session' : 'sessions'}
            {showDesktopKeyboardAffordances && (
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
        {displayItems.length > 0 && (
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
        ) : displayItems.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-xs">
            No unread sessions
          </div>
        ) : (
          <div className="max-h-[min(400px,60vh)] overflow-y-auto p-1">
            {displayItems.map((item, idx) => {
              const status = getSessionStatus(item.session)
              const StatusIcon = status?.icon ?? CheckCircle2

              return (
                <button
                  key={item.session.id}
                  type="button"
                  data-unread-index={idx}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setFocusedIndex(idx)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors cursor-pointer flex items-start gap-2',
                    focusedIndex === idx && 'bg-accent'
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
                      {showDesktopKeyboardAffordances &&
                        focusedIndex === idx && (
                          <Kbd
                            className="h-4 min-w-4 px-1 text-[10px] opacity-70"
                            title="Press R to mark read"
                          >
                            R
                          </Kbd>
                        )}
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
