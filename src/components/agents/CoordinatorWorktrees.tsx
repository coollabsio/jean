import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  StatusIndicator,
  type IndicatorStatus,
} from '@/components/ui/status-indicator'
import { SNOOZE_AFTER_SECONDS } from '@/components/projects/recent-activity'
import {
  getRecentSessionStatus,
  type RecentSessionStatus,
} from '@/components/projects/recent-session-status'
import { fetchRecentWorktrees } from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import type { Project, RecentWorktreeItem } from '@/types/projects'

const RANK = { working: 0, waiting: 1, completed: 2 } as const
type ActiveTone = keyof typeof RANK

const INDICATOR: Record<
  ActiveTone,
  { status: IndicatorStatus; label: string }
> = {
  working: { status: 'running', label: 'Running' },
  waiting: { status: 'waiting', label: 'Waiting for input' },
  completed: { status: 'completed', label: 'Done' },
}

export interface ActiveWorktreeRow {
  item: RecentWorktreeItem
  tone: ActiveTone
}

/**
 * One row per worktree with running, waiting or recently done work: its most
 * important session (running, then waiting, then done). Running rows go
 * first; inside a status the incoming recent-activity order stays. Done work
 * older than `activeSince` (unix seconds) and `skipWorktreeId` are left out.
 */
export function activeWorktreeRows(
  items: RecentWorktreeItem[],
  statusOf: (item: RecentWorktreeItem) => RecentSessionStatus,
  activeSince: number,
  skipWorktreeId?: string
): ActiveWorktreeRow[] {
  const byWorktree = new Map<string, ActiveWorktreeRow>()
  for (const item of items) {
    if (item.worktree.id === skipWorktreeId) continue
    const { tone } = statusOf(item)
    if (!(tone in RANK)) continue
    const activeTone = tone as ActiveTone
    if (activeTone === 'completed' && item.lastActivityAt <= activeSince)
      continue
    const current = byWorktree.get(item.worktree.id)
    if (!current || RANK[activeTone] < RANK[current.tone])
      byWorktree.set(item.worktree.id, { item, tone: activeTone })
  }
  return [...byWorktree.values()].sort((a, b) => RANK[a.tone] - RANK[b.tone])
}

const activeSince = () => Math.floor(Date.now() / 1000) - SNOOZE_AFTER_SECONDS

function openSession(item: RecentWorktreeItem) {
  const chat = useChatStore.getState()
  chat.registerWorktreePath(item.worktree.id, item.worktree.path)
  chat.setActiveSession(item.worktree.id, item.session.id)
  // The mounted project canvas opens its session modal for this event
  window.dispatchEvent(
    new CustomEvent('open-session-modal', {
      detail: {
        sessionId: item.session.id,
        worktreeId: item.worktree.id,
        worktreePath: item.worktree.path,
      },
    })
  )
}

/** The project's worktrees with running, waiting or recently done work. */
export function CoordinatorWorktrees({
  project,
  coordinatorWorktreeId,
  onOpen,
}: {
  project: Project
  coordinatorWorktreeId?: string
  onOpen?: () => void
}) {
  const sendingSessionIds = useChatStore(state => state.sendingSessionIds)
  const waitingForInputSessionIds = useChatStore(
    state => state.waitingForInputSessionIds
  )
  const query = useQuery({
    // The 'recent-worktrees' prefix gets the same refreshes as the sidebar
    queryKey: ['recent-worktrees', 'coordinator', project.id],
    queryFn: () => fetchRecentWorktrees([project], 25, [], activeSince()),
    staleTime: 30_000,
  })
  const items = query.data?.items
  const rows = useMemo(
    () =>
      activeWorktreeRows(
        items ?? [],
        item =>
          getRecentSessionStatus(item.session, {
            sending: sendingSessionIds[item.session.id] ?? false,
            waiting: waitingForInputSessionIds[item.session.id] ?? false,
          }),
        activeSince(),
        coordinatorWorktreeId
      ),
    [items, sendingSessionIds, waitingForInputSessionIds, coordinatorWorktreeId]
  )

  if (query.error)
    return (
      <p className="px-4 py-6 text-sm text-destructive" role="alert">
        Could not load worktrees: {String(query.error)}
      </p>
    )
  if (!items)
    return <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
  if (rows.length === 0)
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No running work in this project.
      </p>
    )

  return (
    <ul className="flex flex-col py-1" aria-label="Active worktrees">
      {rows.map(({ item, tone }) => (
        <li key={item.worktree.id}>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
            onClick={() => {
              openSession(item)
              onOpen?.()
            }}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <StatusIndicator
                status={INDICATOR[tone].status}
                label={INDICATOR[tone].label}
                className="size-2"
              />
            </span>
            <span className="min-w-0 shrink truncate text-foreground">
              {item.worktree.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.session.name}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
