import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  AlertTriangle,
  BellDot,
  ChevronRight,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkingWaveform } from '@/components/ui/status-indicator'
import { cn } from '@/lib/utils'
import { isNativeApp } from '@/lib/environment'
import { formatShortcutDisplay } from '@/types/keybindings'
import {
  decideSessionClose,
  finishedSubSessionIds,
  mergeSessionIntoWorktreeSessions,
  nestUnderLeads,
} from '@/components/chat/session-lifecycle'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import {
  chatQueryKeys,
  prefetchSession,
  useCloseSession,
  useCloseSessions,
} from '@/services/chat'
import { useHoverIntent } from '@/hooks/useHoverIntent'
import {
  fetchRecentWorktrees,
  useCloseBaseSessionClean,
  useDeleteWorktree,
} from '@/services/projects'
import { invoke } from '@/lib/transport'
import { SwipeActionRow } from '@/components/ui/swipe-action-row'
import { CloseWorktreeDialog } from '@/components/chat/CloseWorktreeDialog'
import {
  setRecentSessionPinned,
  useRecentSessionPins,
} from '@/services/recent-session-pins'
import type { WorktreeSessions } from '@/types/chat'
import {
  isBaseSession,
  type Project,
  type RecentWorktreeItem,
} from '@/types/projects'
import { isUnreadSession } from '@/components/unread/unread-utils'
import { ProjectAvatar } from './ProjectAvatar'
import { getRecentSessionStatus } from './recent-session-status'
import { matchesSidebarSearch } from './SidebarSearchField'

const INITIAL_RECENT_LIMIT = 10
const RECENT_PAGE_SIZE = 25
const SNOOZE_AFTER_SECONDS = 24 * 60 * 60

interface RecentWorktreesListProps {
  projects: Project[]
  /** Filters the loaded rows by session, project or worktree name. */
  searchQuery?: string
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

/**
 * Split sorted rows into the list, the Working shelf (unpinned running), and
 * the Snoozed shelf (unpinned, inactive for a day). Inside each part a
 * sub-session follows its lead when both are there; `depthById` holds the
 * indent of each nested row.
 */
export function groupRecentRows(
  rows: RecentWorktreeItem[],
  pinned: ReadonlySet<string>,
  isRunning: (row: RecentWorktreeItem) => boolean,
  now = Date.now()
) {
  const groups = {
    listRows: [] as RecentWorktreeItem[],
    workingRows: [] as RecentWorktreeItem[],
    snoozedRows: [] as RecentWorktreeItem[],
  }
  for (const row of sortRecentRows(rows, pinned, isRunning)) {
    const isPinned = pinned.has(row.session.id)
    if (!isPinned && isRunning(row)) groups.workingRows.push(row)
    else if (!isPinned && isSnoozedSession(row.lastActivityAt, now))
      groups.snoozedRows.push(row)
    else groups.listRows.push(row)
  }
  const depthById = new Map<string, number>()
  const nest = (part: RecentWorktreeItem[]) =>
    nestUnderLeads(part, row => row.session).map(({ item, depth }) => {
      if (depth > 0) depthById.set(item.session.id, depth)
      return item
    })
  const listRows = nest(groups.listRows)
  // The pinned separator goes above the first unpinned top-level row. A
  // sub-session of a pinned lead stays above it, under its lead.
  const firstUnpinned = listRows.find(
    row => !pinned.has(row.session.id) && !depthById.has(row.session.id)
  )
  const hasPinned = listRows.some(
    row => pinned.has(row.session.id) && !depthById.has(row.session.id)
  )
  return {
    listRows,
    workingRows: nest(groups.workingRows),
    snoozedRows: nest(groups.snoozedRows),
    depthById,
    firstUnpinnedSessionId:
      hasPinned && firstUnpinned ? firstUnpinned.session.id : null,
  }
}

export function RecentWorktreesList({
  projects,
  searchQuery = '',
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
  const [snoozedExpanded, setSnoozedExpanded] = useState(false)
  const [workingExpanded, setWorkingExpanded] = useState(false)
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

  // Reset paging when the project set changes (adjusted during render so the
  // stale limit never reaches the query)
  const [prevProjectKey, setPrevProjectKey] = useState(projectKey)
  if (prevProjectKey !== projectKey) {
    setPrevProjectKey(projectKey)
    setLimit(INITIAL_RECENT_LIMIT)
    setSnoozedExpanded(false)
  }

  const query = useQuery({
    // Selection only changes the highlighted row. Keep it out of the query so
    // switching sessions cannot swap between cached list variants with
    // different ordering.
    queryKey: ['recent-worktrees', projectKey, limit, pinnedSessionIds],
    // Every non-snoozed session loads at once; only snoozed ones page.
    queryFn: () =>
      fetchRecentWorktrees(
        projects,
        limit,
        pinnedSessionIds,
        Math.floor(Date.now() / 1000) - SNOOZE_AFTER_SECONDS
      ),
    enabled: projects.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const rows = query.data?.items ?? EMPTY_RECENT_ROWS
  const pageSize = query.data?.pageSize ?? limit
  const pinned = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds])
  // Unpinned running sessions move to a collapsible Working shelf, and
  // unpinned snoozed sessions to a collapsible Snoozed shelf below it.
  // Pinned sessions stay in the pinned group. Inside each part, a
  // sub-session follows its lead when both are there.
  const {
    listRows,
    workingRows,
    snoozedRows,
    depthById,
    firstUnpinnedSessionId,
  } = useMemo(
    () =>
      groupRecentRows(
        rows.filter(row =>
          matchesSidebarSearch(
            searchQuery,
            row.session.name,
            row.projectName,
            row.worktree.name
          )
        ),
        pinned,
        row =>
          getRecentSessionStatus(row.session, {
            sending: sendingSessionIds[row.session.id] ?? false,
            waiting: waitingForInputSessionIds[row.session.id] ?? false,
          }).tone === 'working'
      ),
    [pinned, rows, searchQuery, sendingSessionIds, waitingForInputSessionIds]
  )
  // The shelf hides when no session runs. Collapse it then, so it always
  // comes back closed and the first click opens it.
  if (workingExpanded && workingRows.length === 0) setWorkingExpanded(false)
  const visibleWorkingRows = workingExpanded ? workingRows : EMPTY_RECENT_ROWS
  const visibleSnoozedRows = snoozedExpanded ? snoozedRows : EMPTY_RECENT_ROWS
  // Visual order, used by Cmd+Arrow navigation and Cmd+1-9 shortcuts.
  const displayedRows = useMemo(
    () => [...listRows, ...visibleWorkingRows, ...visibleSnoozedRows],
    [listRows, visibleWorkingRows, visibleSnoozedRows]
  )
  const projectsById = useMemo(
    () => new Map(projects.map(project => [project.id, project])),
    [projects]
  )
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
      const ui = useUIStore.getState()
      // Leave the Agents page so the project canvas can open the session
      ui.setRailSection('workspace')
      if (isMobile) ui.setLeftSidebarVisible(false)
    },
    [isMobile, queryClient, selectProject, selectWorktree]
  )
  const rowHover = useHoverIntent((row: RecentWorktreeItem) => {
    void prefetchSession(
      queryClient,
      row.session.id,
      row.worktree.id,
      row.worktree.path
    )
  })

  // Mobile swipe close follows the CMD+W session row rules
  const { mutate: closeSession } = useCloseSession()
  const closeSessions = useCloseSessions()
  const deleteWorktree = useDeleteWorktree()
  const closeBaseSessionClean = useCloseBaseSessionClean()
  const [closeTarget, setCloseTarget] = useState<{
    row: RecentWorktreeItem
    mode: 'session' | 'worktree'
    finishedSubSessionIds: string[]
  } | null>(null)
  const refreshRecent = useCallback(
    () =>
      void queryClient.invalidateQueries({ queryKey: ['recent-worktrees'] }),
    [queryClient]
  )
  const closeRow = useCallback(
    (
      row: RecentWorktreeItem,
      mode: 'session' | 'worktree',
      subSessionIds: string[] = []
    ) => {
      if (mode === 'session' && subSessionIds.length > 0) {
        void closeSessions(
          row.worktree.id,
          row.worktree.path,
          row.session.id,
          subSessionIds
        ).then(refreshRecent)
        return
      }
      if (mode === 'session') {
        closeSession(
          {
            worktreeId: row.worktree.id,
            worktreePath: row.worktree.path,
            sessionId: row.session.id,
          },
          { onSuccess: refreshRecent }
        )
        return
      }
      const close = isBaseSession(row.worktree)
        ? closeBaseSessionClean
        : deleteWorktree
      close.mutate(
        { worktreeId: row.worktree.id, projectId: row.projectId },
        { onSuccess: refreshRecent }
      )
    },
    [
      closeSession,
      closeSessions,
      closeBaseSessionClean,
      deleteWorktree,
      refreshRecent,
    ]
  )
  const requestCloseRow = useCallback(
    async (row: RecentWorktreeItem) => {
      const { sessions } = await invoke<WorktreeSessions>('get_sessions', {
        worktreeId: row.worktree.id,
        worktreePath: row.worktree.path,
        includeMessageCounts: false,
      })
      const chat = useChatStore.getState()
      const subSessionIds = finishedSubSessionIds(
        row.session.id,
        sessions,
        session => session,
        session => {
          const tone = getRecentSessionStatus(session, {
            sending: chat.sendingSessionIds[session.id] ?? false,
            waiting: chat.waitingForInputSessionIds[session.id] ?? false,
          }).tone
          return (
            tone !== 'working' &&
            tone !== 'waiting' &&
            !session.scheduled_wakeup
          )
        }
      )
      const decision = decideSessionClose({
        target: row.session,
        sessions,
        inputDrafts: chat.inputDrafts,
        onLastSession: 'confirm-worktree',
        finishedSubSessionCount: subSessionIds.length,
      })
      if (decision === 'noop') return
      if (decision === 'close-session') closeRow(row, 'session')
      else
        setCloseTarget({
          row,
          mode: decision === 'confirm-session' ? 'session' : 'worktree',
          finishedSubSessionIds: subSessionIds,
        })
    },
    [closeRow]
  )

  // next/previous_recent_session are matched in useMainWindowEventListeners,
  // which dispatches this event only while the Recent list is visible.
  // Effect Event: reads the latest rows/selection without re-subscribing the
  // window listener every time the list or session status changes.
  const onOpenAdjacent = useEffectEvent((event: Event) => {
    const direction = (event as CustomEvent<{ direction: 1 | -1 }>).detail
      ?.direction
    if (!direction) return
    const row = getAdjacentRecentRow(
      displayedRows,
      selectedSessionId,
      direction
    )
    if (!row) return
    handleOpen(row)
    const element = rowRefs.current.get(row.session.id)
    element?.focus({ preventScroll: true })
    element?.closest('li')?.scrollIntoView({ block: 'nearest' })
  })

  useEffect(() => {
    const listener = (event: Event) => onOpenAdjacent(event)
    window.addEventListener('open-adjacent-recent-session', listener)
    return () =>
      window.removeEventListener('open-adjacent-recent-session', listener)
  }, [])

  // Cmd/Ctrl+1-9 is matched in useMainWindowEventListeners, which dispatches
  // this event only while the Recent list is visible.
  const onOpenByIndex = useEffectEvent((event: Event) => {
    const index = (event as CustomEvent<{ index: number }>).detail?.index
    const row = index === undefined ? undefined : displayedRows[index]
    if (!row) return
    handleOpen(row)
    rowRefs.current
      .get(row.session.id)
      ?.closest('li')
      ?.scrollIntoView({ block: 'nearest' })
  })

  useEffect(() => {
    const listener = (event: Event) => onOpenByIndex(event)
    window.addEventListener('open-recent-session-by-index', listener)
    return () =>
      window.removeEventListener('open-recent-session-by-index', listener)
  }, [])

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
  const hiddenCount = Math.max(0, (query.data?.total ?? rows.length) - pageSize)
  // The page can be larger than the limit, so grow from the loaded size.
  const loadMore = () => setLimit(pageSize + RECENT_PAGE_SIZE)
  // Unloaded rows are all snoozed: the page holds every active session.
  const snoozedCount = snoozedRows.length + hiddenCount
  // Older snoozed pages load only while the Snoozed shelf is open.
  const showLoadMore = snoozedExpanded && hiddenCount > 0
  const renderRow = (row: RecentWorktreeItem, index: number) => {
    const depth = depthById.get(row.session.id) ?? 0
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
    const project = projectsById.get(row.projectId)
    const isServer = !!project?.server
    const showPinnedSeparator = row.session.id === firstUnpinnedSessionId
    return (
      <li
        key={row.session.id}
        className={cn(
          'group',
          // The negative margin carries the indent line through the list gap.
          depth > 0 && '-mt-2 border-l border-border/20 pt-2 pl-1',
          depth === 1 && 'ml-4',
          depth > 1 && 'ml-8'
        )}
      >
        {showPinnedSeparator && (
          <div
            role="separator"
            aria-hidden="true"
            className="mx-1 mb-2 border-t border-border/20"
          />
        )}
        <SwipeActionRow
          enabled={isMobile && !isServer}
          actionLabel="Close"
          onAction={() => void requestCloseRow(row)}
        >
          {/* react-doctor-disable-next-line react-doctor/no-static-element-interactions -- enlarges the hit area; the nested labelled row <button> bubbles its keyboard click here */}
          <div
            className={`relative flex w-full cursor-pointer flex-col gap-y-1 rounded-lg py-2.5 pl-3 pr-3 text-left transition-[background-color,box-shadow,color] hover:bg-muted/30 hover:text-foreground has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring ${isCurrent ? 'bg-muted/50 text-foreground shadow' : 'bg-transparent text-muted-foreground'}`}
            onClick={() => handleOpen(row)}
            onPointerEnter={() => rowHover.start(row)}
            onPointerLeave={rowHover.cancel}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={isPinned ? 'Unpin session' : 'Pin session'}
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
              </TooltipTrigger>
              <TooltipContent>
                {isPinned ? 'Unpin session' : 'Pin session'}
              </TooltipContent>
            </Tooltip>
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
                {project && <ProjectAvatar project={project} />}
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                  {namingSessionIds[row.session.id]
                    ? 'Generating…'
                    : row.session.name}
                </span>
                <span className="flex shrink-0 items-center justify-end gap-1.5 text-2xs empty:hidden">
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
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-2xs">
                  {isServer && (
                    <span
                      aria-hidden="true"
                      className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-px text-2xs font-medium text-muted-foreground"
                    >
                      <Server className="size-2.5" />
                      Server
                    </span>
                  )}
                  <span className="min-w-0 truncate">
                    {row.projectName} · {row.worktree.name}
                  </span>
                </span>
                <span className="flex shrink-0 items-center justify-end text-2xs tabular-nums">
                  {showShortcutHints && index < MAX_RECENT_SHORTCUTS ? (
                    <Kbd className="h-4 px-1 text-2xs">
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
        </SwipeActionRow>
      </li>
    )
  }
  const listClassName = '@container flex flex-col gap-2 px-2'
  const workingShelfSection = workingRows.length > 0 && (
    <section aria-label="Working sessions" className="pb-2">
      <button
        type="button"
        aria-expanded={workingExpanded}
        className="flex h-8 w-full items-center gap-1 px-3 text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setWorkingExpanded(value => !value)}
      >
        <ChevronRight
          className={`size-3 transition-transform ${workingExpanded ? 'rotate-90' : ''}`}
        />
        Working
        <span className="ml-auto flex items-center gap-1.5 font-normal tabular-nums">
          <WorkingWaveform />
          {workingRows.length}
        </span>
      </button>
      <ul className={listClassName}>
        {visibleWorkingRows.map((row, index) =>
          renderRow(row, listRows.length + index)
        )}
      </ul>
    </section>
  )

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="recent-worktrees-list"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {displayedRows.length === 0 && snoozedCount === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {searchQuery.trim() ? 'No matching sessions' : 'No recent sessions'}
          </div>
        )}
        <ul
          aria-label="Recent sessions"
          className={`${listClassName} pt-2 pb-2`}
        >
          {listRows.map((row, index) => renderRow(row, index))}
        </ul>
        {/* Shelves and paging actions sit at the bottom of a short list and
            scroll with a long one. */}
        <div className="mt-auto pb-[env(safe-area-inset-bottom)]">
          {workingShelfSection}
          {snoozedCount > 0 && (
            <section aria-label="Snoozed sessions" className="pb-2">
              <button
                type="button"
                aria-expanded={snoozedExpanded}
                title="Inactive for 24 hours"
                className="flex h-8 w-full items-center gap-1 px-3 text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => {
                  if (!snoozedExpanded && snoozedRows.length === 0) loadMore()
                  setSnoozedExpanded(value => !value)
                }}
              >
                <ChevronRight
                  className={`size-3 transition-transform ${snoozedExpanded ? 'rotate-90' : ''}`}
                />
                Snoozed
                <span className="ml-auto font-normal tabular-nums">
                  {snoozedCount}
                </span>
              </button>
              <ul className={listClassName}>
                {visibleSnoozedRows.map((row, index) =>
                  renderRow(
                    row,
                    listRows.length + visibleWorkingRows.length + index
                  )
                )}
              </ul>
            </section>
          )}
          {showLoadMore && (
            <div className="flex justify-center px-2 pb-2">
              <button
                type="button"
                className="flex h-5 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                onClick={loadMore}
              >
                <Plus className="size-3.5" /> Show{' '}
                {Math.min(hiddenCount, RECENT_PAGE_SIZE)} more
              </button>
            </div>
          )}
        </div>
      </div>
      <CloseWorktreeDialog
        open={!!closeTarget}
        onOpenChange={open => {
          if (!open) setCloseTarget(null)
        }}
        onConfirm={({ closeSubSessions }) => {
          if (closeTarget) {
            closeRow(
              closeTarget.row,
              closeTarget.mode,
              closeSubSessions ? closeTarget.finishedSubSessionIds : []
            )
          }
          setCloseTarget(null)
        }}
        mode={closeTarget?.mode}
        finishedSubSessionCount={closeTarget?.finishedSubSessionIds.length}
        branchName={closeTarget?.row.worktree.branch}
        worktree={
          closeTarget?.mode === 'worktree'
            ? closeTarget.row.worktree
            : undefined
        }
      />
      {failedCount > 0 && (
        <div className="shrink-0 border-t border-border/20 p-2">
          <div
            role="status"
            className="flex items-center justify-center gap-1 text-2xs text-warning"
          >
            <AlertTriangle className="size-3" /> Some recent sessions could not
            load.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
