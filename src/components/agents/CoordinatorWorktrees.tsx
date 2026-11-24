import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  StatusIndicator,
  type IndicatorStatus,
} from '@/components/ui/status-indicator'
import {
  getRecentSessionStatus,
  type RecentSessionStatus,
} from '@/components/projects/recent-session-status'
import { formatRelative } from '@/lib/relative-time'
import { useAgentDetails } from '@/services/agents'
import { fetchRecentWorktrees } from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import {
  isBaseSession,
  type Project,
  type RecentWorktreeItem,
} from '@/types/projects'

type DelegatedTone = 'running' | 'waiting' | 'failed' | 'done'

const RANK: Record<DelegatedTone, number> = {
  running: 0,
  waiting: 1,
  failed: 2,
  done: 2,
}

const INDICATOR: Record<
  DelegatedTone,
  { status: IndicatorStatus; label: string }
> = {
  running: { status: 'running', label: 'Running' },
  waiting: { status: 'waiting', label: 'Waiting for input' },
  failed: { status: 'crashed', label: 'Failed' },
  done: { status: 'completed', label: 'Done' },
}

function delegatedTone({ tone }: RecentSessionStatus): DelegatedTone {
  if (tone === 'working') return 'running'
  if (tone === 'waiting' || tone === 'failed') return tone
  return 'done'
}

export interface DelegatedSessionRow {
  item: RecentWorktreeItem
  tone: DelegatedTone
}

/**
 * One row per session the coordinator started, base sessions left out.
 * Running rows go first, then waiting; inside a status the incoming
 * recent-activity order stays.
 */
export function delegatedSessionRows(
  items: RecentWorktreeItem[],
  delegatedSessionIds: ReadonlySet<string>,
  statusOf: (item: RecentWorktreeItem) => RecentSessionStatus
): DelegatedSessionRow[] {
  return items
    .filter(
      item =>
        delegatedSessionIds.has(item.session.id) &&
        !isBaseSession(item.worktree)
    )
    .map(item => ({ item, tone: delegatedTone(statusOf(item)) }))
    .sort((a, b) => RANK[a.tone] - RANK[b.tone])
}

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

function Message({ children }: { children: string }) {
  return <p className="px-4 py-6 text-sm text-muted-foreground">{children}</p>
}

/** The worktree sessions the project's coordinator started. */
export function CoordinatorWorktrees({
  project,
  agentId,
  onOpen,
}: {
  project: Project
  agentId: string | undefined
  onOpen?: () => void
}) {
  const sendingSessionIds = useChatStore(state => state.sendingSessionIds)
  const waitingForInputSessionIds = useChatStore(
    state => state.waitingForInputSessionIds
  )
  const details = useAgentDetails(agentId ?? null)
  const delegations = details.data?.delegations
  const sessionIds = useMemo(
    () => [...new Set((delegations ?? []).map(d => d.sessionId))].sort(),
    [delegations]
  )
  const query = useQuery({
    // The 'recent-worktrees' prefix gets the same refreshes as the sidebar
    queryKey: ['recent-worktrees', 'coordinator', project.id, sessionIds],
    // Limit 1: the delegated sessions come in through includeSessionIds
    queryFn: () => fetchRecentWorktrees([project], 1, sessionIds),
    enabled: sessionIds.length > 0,
    staleTime: 30_000,
  })
  const items = query.data?.items
  const rows = useMemo(
    () =>
      delegatedSessionRows(items ?? [], new Set(sessionIds), item =>
        getRecentSessionStatus(item.session, {
          sending: sendingSessionIds[item.session.id] ?? false,
          waiting: waitingForInputSessionIds[item.session.id] ?? false,
        })
      ),
    [items, sessionIds, sendingSessionIds, waitingForInputSessionIds]
  )

  const error = details.error ?? query.error
  if (error)
    return (
      <p className="px-4 py-6 text-sm text-destructive" role="alert">
        Could not load sessions: {String(error)}
      </p>
    )
  if (!delegations || (sessionIds.length > 0 && !items))
    return <Message>Loading…</Message>
  if (rows.length === 0)
    return <Message>The coordinator has not started any work yet.</Message>

  return (
    <ul className="flex flex-col py-1" aria-label="Coordinator sessions">
      {rows.map(({ item, tone }) => (
        <li key={item.session.id}>
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
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatRelative(item.lastActivityAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
