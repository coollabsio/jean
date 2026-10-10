import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  AlertTriangle,
  BellDot,
  Plus,
  Server,
  Thumbtack,
} from '@/components/icons/reicon'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  isModOnlyHeld,
  useModifierHintsVisible,
} from '@/hooks/useModifierHintsVisible'
import { Kbd } from '@/components/ui/kbd'
import { WorkingWaveform } from '@/components/ui/status-indicator'
import { isNativeApp } from '@/lib/environment'
import { formatShortcutDisplay } from '@/types/keybindings'
import { mergeSessionIntoWorktreeSessions } from '@/components/chat/session-tab-order'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { chatQueryKeys } from '@/services/chat'
import { fetchRecentWorktrees } from '@/services/projects'
import {
  setRecentSessionPinned,
  useRecentSessionPins,
} from '@/services/recent-session-pins'
import { fetchWorktreesStatus } from '@/services/git-status'
import type { WorktreeSessions } from '@/types/chat'
import type { Project, RecentWorktreeItem } from '@/types/projects'
import { isUnreadSession } from '@/components/unread/unread-utils'
import { getRecentSessionStatus } from './recent-session-status'

const INITIAL_RECENT_LIMIT = 10
const RECENT_PAGE_SIZE = 25
const SNOOZE_AFTER_SECONDS = 24 * 60 * 60

interface RecentWorktreesListProps {
  projects: Project[]
  /** Sidebar footer slot for the "Show more" actions (next to Settings). */
  footerActionsContainer?: HTMLElement | null
}

export function formatRecentActivity(
  timestamp: number,
  now = Date.now()
): string {
  const seconds = Math.max(0, Math.floor((now - timestamp * 1000) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`
}

export function isSnoozedSession(
  lastActivityAt: number,
  now = Date.now()
): boolean {
  return lastActivityAt <= Math.floor(now / 1000) - SNOOZE_AFTER_SECONDS
}

export function getAdjacentRecentRow(
  rows: RecentWorktreeItem[],
  selectedSessionId: string | null,
  direction: 1 | -1
): RecentWorktreeItem | undefined {
  if (rows.length === 0) return undefined

  const current = rows.findIndex(row => row.session.id === selectedSessionId)
  const nextIndex =
    current < 0
      ? direction > 0
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, current + direction))
  return rows[nextIndex]
}

const MAX_RECENT_SHORTCUTS = 9
const EMPTY_RECENT_ROWS: RecentWorktreeItem[] = []

/**
 * Pinned rows first. Inside the pinned and unpinned groups, running rows go
 * first. All other rows keep the incoming recent-activity order, so a
 * finished row goes back to its normal position.
 */
export function sortRecentRows(
  rows: RecentWorktreeItem[],
  pinnedSessionIds: ReadonlySet<string>,
  isRunning: (row: RecentWorktreeItem) => boolean
): RecentWorktreeItem[] {
  const rank = (row: RecentWorktreeItem) =>
    (pinnedSessionIds.has(row.session.id) ? 0 : 2) + (isRunning(row) ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b))
}

export function RecentWorktreesList({
  projects,
  footerActionsContainer,
}: RecentWorktreesListProps) {
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const selectProject = useProjectsStore(state => state.selectProject)
  const selectWorktree = useProjectsStore(state => state.selectWorktree)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const selectedSessionId = useChatStore(state =>
    selectedWorktreeId
      ? (state.activeSessionIds[selectedWorktreeId] ?? null)
      : null
  )
  const sendingSessionIds = useChatStore(state => state.sendingSessionIds)
  const waitingForInputSessionIds = useChatStore(
    state => state.waitingForInputSessionIds
  )
  const namingSessionIds = useChatStore(state => state.namingSessionIds)
  const pinnedSessionIds = useRecentSessionPins(projects)
  const [limit, setLimit] = useState(INITIAL_RECENT_LIMIT)
  const [showSnoozed, setShowSnoozed] = useState(false)
  const shortcutsEnabled = isNativeApp() && !isMobile
  const showShortcutHints = useModifierHintsVisible(
    isModOnlyHeld,
    shortcutsEnabled
  )
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const projectKey = useMemo(
    () =>
      projects
        .map(project => project.id)
        .sort()
        .join('\0'),
    [projects]
  )

  useEffect(() => {
    setLimit(INITIAL_RECENT_LIMIT)
    setShowSnoozed(false)
  }, [projectKey])

  const query = useQuery({
    // Selection only changes the highlighted row. Keep it out of the query so
    // switching sessions cannot swap between cached list variants with
    // different ordering.
    queryKey: ['recent-worktrees', projectKey, limit, pinnedSessionIds],
    queryFn: () => fetchRecentWorktrees(projects, limit, pinnedSessionIds),
    enabled: projects.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const rows = query.data?.items ?? EMPTY_RECENT_ROWS
  const snoozedBoundaryLoaded = rows
    .slice(0, limit)
    .some(row => isSnoozedSession(row.lastActivityAt))
  const pinned = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds])
  const displayedRows = useMemo(() => {
    const visibleRows = rows.filter(
      row =>
        showSnoozed ||
        pinned.has(row.session.id) ||
        !isSnoozedSession(row.lastActivityAt)
    )
    return sortRecentRows(
      visibleRows,
      pinned,
      row =>
        getRecentSessionStatus(row.session, {
          sending: sendingSessionIds[row.session.id] ?? false,
          waiting: waitingForInputSessionIds[row.session.id] ?? false,
        }).tone === 'working'
    )
  }, [pinned, rows, showSnoozed, sendingSessionIds, waitingForInputSessionIds])
  const serverProjectIds = useMemo(
    () =>
      new Set(
        projects.filter(project => !!project.server).map(project => project.id)
      ),
    [projects]
  )
  const recentProjectKey = useMemo(
    () => [...new Set(rows.map(row => row.projectId))].sort().join('\0'),
    [rows]
  )

  useEffect(() => {
    if (!recentProjectKey) return
    void Promise.allSettled(
      recentProjectKey
        .split('\0')
        .map(projectId =>
          fetchWorktreesStatus(projectId).catch(() => undefined)
        )
    )
  }, [recentProjectKey])

  const handleOpen = useCallback(
    (row: RecentWorktreeItem) => {
      const worktreeId = row.worktree.id
      const sessionId = row.session.id
      for (const queryKey of [
        chatQueryKeys.sessions(worktreeId),
        [...chatQueryKeys.sessions(worktreeId), 'with-counts'],
      ]) {
        queryClient.setQueryData<WorktreeSessions | undefined>(
          queryKey,
          current =>
            mergeSessionIntoWorktreeSessions(current, worktreeId, row.session)
        )
      }
      void queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      selectProject(row.projectId)
      selectWorktree(worktreeId)
      const chat = useChatStore.getState()
      chat.registerWorktreePath(worktreeId, row.worktree.path)
      chat.clearActiveWorktree()
      chat.setActiveSession(worktreeId, sessionId)
      chat.setLastOpenedForProject(row.projectId, worktreeId, sessionId)
      // The project canvas remounts when the repo changes. A timed window
      // event is lost during that remount, so queue the open until the new
      // canvas is ready. Also dispatch now for a canvas that is already open.
      useUIStore
        .getState()
        .markWorktreeForAutoOpenSession(worktreeId, sessionId)
      window.dispatchEvent(
        new CustomEvent('open-session-modal', {
          detail: {
            sessionId,
            worktreeId,
            worktreePath: row.worktree.path,
          },
        })
      )
      if (isMobile) useUIStore.getState().setLeftSidebarVisible(false)
    },
    [isMobile, queryClient, selectProject, selectWorktree]
  )

  // Effect Event: reads the latest rows/selection without re-subscribing the
  // window listener every time the list or session status changes.
  const onRecentKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!event.metaKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const row = getAdjacentRecentRow(
      displayedRows,
      selectedSessionId,
      event.key === 'ArrowDown' ? 1 : -1
    )
    if (!row) return
    handleOpen(row)
    rowRefs.current.get(row.session.id)?.focus()
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => onRecentKeyDown(event)
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  // Cmd/Ctrl+1-9 is matched in useMainWindowEventListeners, which dispatches
  // this event only while the Recent list is visible.
  useEffect(() => {
    const onOpenByIndex = (event: Event) => {
      const index = (event as CustomEvent<{ index: number }>).detail?.index
      const row = index === undefined ? undefined : displayedRows[index]
      if (row) handleOpen(row)
    }
    window.addEventListener('open-recent-session-by-index', onOpenByIndex)
    return () =>
      window.removeEventListener('open-recent-session-by-index', onOpenByIndex)
  }, [displayedRows, handleOpen])

  if (query.isPending && projects.length > 0) {
    return (
      <div
        role="status"
        className="px-3 py-6 text-center text-xs text-muted-foreground"
      >
        Loading recent sessions…
      </div>
    )
  }

  if (query.isError && rows.length === 0) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-muted-foreground"
      >
        <AlertTriangle className="size-4 text-destructive" />
        <span>Unable to load recent sessions</span>
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => void query.refetch()}
        >
          Retry
        </button>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        No prompted sessions yet
      </div>
    )
  }

  const failedCount =
    (query.data?.failedServerIds.length ?? 0) +
    (query.data?.failedWorktreeIds.length ?? 0)
  const hiddenCount = Math.max(0, (query.data?.total ?? rows.length) - limit)
  const footerButtonClass =
    'flex h-6 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground'
  const footerActions = (
    <>
      {hiddenCount > 0 && !snoozedBoundaryLoaded && (
        <button
          type="button"
          className={footerButtonClass}
          onClick={() => setLimit(value => value + RECENT_PAGE_SIZE)}
        >
          <Plus className="size-3.5" /> Show{' '}
          {Math.min(hiddenCount, RECENT_PAGE_SIZE)} more
        </button>
      )}
      {snoozedBoundaryLoaded && !showSnoozed && (
        <button
          type="button"
          className={footerButtonClass}
          onClick={() => {
            setShowSnoozed(true)
            setLimit(value => value + RECENT_PAGE_SIZE)
          }}
        >
          Show snoozed sessions
        </button>
      )}
      {showSnoozed && hiddenCount > 0 && (
        <button
          type="button"
          className={footerButtonClass}
          onClick={() => setLimit(value => value + RECENT_PAGE_SIZE)}
        >
          <Plus className="size-3.5" /> Show{' '}
          {Math.min(hiddenCount, RECENT_PAGE_SIZE)} more
        </button>
      )}
    </>
  )

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="recent-worktrees-list"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {displayedRows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No recent sessions
          </div>
        )}
        <ul
          aria-label="Recent sessions"
          className={`@container flex flex-col gap-2 px-2 pt-2 ${footerActionsContainer ? 'pb-10' : 'pb-2'}`}
        >
          {displayedRows.map((row, index) => {
            const isCurrent = row.session.id === selectedSessionId
            const activity = formatRecentActivity(row.lastActivityAt)
            const activityLabel =
              activity === 'now' ? 'active now' : `active ${activity} ago`
            const status = getRecentSessionStatus(row.session, {
              sending: sendingSessionIds[row.session.id] ?? false,
              waiting: waitingForInputSessionIds[row.session.id] ?? false,
            })
            const statusClassName =
              status.tone === 'waiting'
                ? 'text-warning'
                : status.tone === 'failed'
                  ? 'text-destructive'
                  : 'text-muted-foreground'
            const isWorking = status.tone === 'working'
            const isUnread = isUnreadSession(row.session)
            const isPinned = pinned.has(row.session.id)
            const isServer = serverProjectIds.has(row.projectId)
            const showPinnedSeparator =
              !isPinned &&
              index > 0 &&
              pinned.has(displayedRows[index - 1]?.session.id ?? '')
            return (
              <li key={row.session.id} className="group">
                {showPinnedSeparator && (
                  <div
                    role="separator"
                    aria-hidden="true"
                    className="mx-1 mb-2 border-t border-border/70"
                  />
                )}
                {showSnoozed &&
                  !isPinned &&
                  isSnoozedSession(row.lastActivityAt) &&
                  (index === 0 ||
                    pinned.has(displayedRows[index - 1]?.session.id ?? '') ||
                    !isSnoozedSession(
                      displayedRows[index - 1]?.lastActivityAt ?? 0
                    )) && (
                    <div className="px-1 py-1 text-[11px] font-medium text-muted-foreground">
                      Snoozed · inactive for 24 hours
                    </div>
                  )}
                <div
                  className={`relative flex w-full cursor-pointer flex-col gap-y-1 rounded-lg border py-2.5 pl-3 pr-3 text-left transition-[background-color,border-color,box-shadow,color] hover:bg-muted/30 hover:text-foreground has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring ${isCurrent ? 'border-border bg-muted/50 text-foreground shadow' : 'border-transparent bg-transparent text-muted-foreground'}`}
                  onClick={() => handleOpen(row)}
                >
                  <button
                    type="button"
                    aria-label={isPinned ? 'Unpin session' : 'Pin session'}
                    title={isPinned ? 'Unpin session' : 'Pin session'}
                    className={`absolute -left-1.5 -top-1.5 z-10 flex size-5 items-center justify-center transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100 md:group-focus-within:opacity-100 ${isPinned ? 'text-foreground' : 'text-muted-foreground'}`}
                    onClick={event => {
                      event.stopPropagation()
                      void setRecentSessionPinned(
                        queryClient,
                        row.session.id,
                        !isPinned
                      )
                    }}
                  >
                    <Thumbtack
                      size={11}
                      weight={isPinned ? 'Filled' : 'Outline'}
                    />
                  </button>
                  <button
                    ref={element => {
                      if (element) rowRefs.current.set(row.session.id, element)
                      else rowRefs.current.delete(row.session.id)
                    }}
                    type="button"
                    aria-current={isCurrent ? 'page' : undefined}
                    aria-label={`${row.session.name}, ${isServer ? 'server ' : ''}${row.projectName}, ${row.worktree.name}, ${status.label}${isUnread ? ', unread' : ''}, ${activityLabel}`}
                    className="flex w-full flex-col gap-y-1 text-left focus-visible:outline-none"
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                        {namingSessionIds[row.session.id]
                          ? 'Generating…'
                          : row.session.name}
                      </span>
                      <span className="flex shrink-0 items-center justify-end gap-1.5 text-[10px] empty:hidden">
                        {isUnread && (
                          <BellDot
                            aria-label="Unread session"
                            className="size-3.5 shrink-0 text-warning"
                          />
                        )}
                        {isWorking ? (
                          <WorkingWaveform />
                        ) : (
                          status.tone !== 'completed' && (
                            <span className={`font-medium ${statusClassName}`}>
                              {status.label}
                            </span>
                          )
                        )}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]">
                        {isServer && (
                          <span
                            aria-hidden="true"
                            className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground"
                          >
                            <Server className="size-2.5" />
                            Server
                          </span>
                        )}
                        <span className="min-w-0 truncate">
                          {row.projectName} · {row.worktree.name}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center justify-end gap-2 text-[10px] tabular-nums">
                        {(row.added > 0 || row.removed > 0) && (
                          <span className="hidden gap-1 font-medium @[15rem]:flex">
                            <span className="text-success">+{row.added}</span>
                            <span className="text-destructive">
                              -{row.removed}
                            </span>
                          </span>
                        )}
                        {showShortcutHints && index < MAX_RECENT_SHORTCUTS ? (
                          <Kbd className="h-4 px-1 text-[10px]">
                            {formatShortcutDisplay(`mod+${index + 1}`)}
                          </Kbd>
                        ) : (
                          <time
                            dateTime={new Date(
                              row.lastActivityAt * 1000
                            ).toISOString()}
                          >
                            {activity}
                          </time>
                        )}
                      </span>
                    </span>
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
      {footerActionsContainer &&
        createPortal(footerActions, footerActionsContainer)}
      {(failedCount > 0 ||
        (!footerActionsContainer &&
          (hiddenCount > 0 || (snoozedBoundaryLoaded && !showSnoozed)))) && (
        <div className="shrink-0 border-t border-border/40 p-2">
          {!footerActionsContainer && footerActions}
          {failedCount > 0 && (
            <div
              role="status"
              className="flex items-center justify-center gap-1 text-[11px] text-warning"
            >
              <AlertTriangle className="size-3" /> Some recent sessions could
              not load.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => void query.refetch()}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
