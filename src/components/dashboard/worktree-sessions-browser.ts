import { getBackendLabel } from '@/components/ui/backend-label'
import {
  isActionableWaitingStatus,
  statusConfig,
  type SessionCardData,
  type SessionStatus,
} from '@/components/chat/session-card-utils'
import { getSessionActivityTimestamp } from '@/components/projects/worktree-sort-utils'

/** Sidebar and canvas worktree clicks open this browser instead of a session tab. */
export const BROWSE_WORKTREE_SESSIONS_EVENT = 'browse-worktree-sessions'

export interface BrowseWorktreeSessionsDetail {
  projectId: string
  worktreeId: string
  worktreePath: string
}

export const EMPTY_SESSION_BROWSER_CARDS: SessionCardData[] = []

/**
 * Dispatch immediately, then again on the next turn so a project switch can
 * mount ProjectCanvasView before the browser opens.
 */
export function dispatchBrowseWorktreeSessions(
  detail: BrowseWorktreeSessionsDetail
) {
  const emit = () => {
    window.dispatchEvent(
      new CustomEvent(BROWSE_WORKTREE_SESSIONS_EVENT, { detail })
    )
  }
  emit()
  window.setTimeout(emit, 50)
}

export type SessionBrowserStatusFilter =
  | 'all'
  | 'waiting'
  | 'in_progress'
  | 'review'
  | 'idle'

/**
 * Same buckets as the sidebar session groups. Every session status belongs
 * to exactly one bucket so a new status has to be filed here.
 */
export const SESSION_BROWSER_STATUS_BUCKET: Record<
  SessionStatus,
  Exclude<SessionBrowserStatusFilter, 'all'>
> = {
  waiting: 'waiting',
  plan_approval: 'waiting',
  input_required: 'waiting',
  permission: 'waiting',
  command_approval: 'waiting',
  mcp_input: 'waiting',
  tool_approval: 'waiting',
  planning: 'in_progress',
  vibing: 'in_progress',
  yoloing: 'in_progress',
  reviewing: 'in_progress',
  scheduled: 'in_progress',
  review: 'review',
  completed: 'review',
  cancelled: 'review',
  crashed: 'review',
  idle: 'idle',
}

const STATUS_FILTERS: {
  id: Exclude<SessionBrowserStatusFilter, 'all'>
  label: string
}[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'idle', label: 'Idle' },
]

export interface SessionBrowserFilterTab {
  key: string
  label: string
  count: number
  color?: string
}

export interface SessionBrowserStatusLabels {
  statusLabel: string
  /** Live agent activity when it differs from the effective session status. */
  agentStatusLabel: string | null
}

/**
 * Effective session status includes a manual override. Live agent activity
 * (running, waiting, scheduled, and terminal run state) is shown beside it
 * when the two differ. A separate workflow-status field is not stored yet.
 */
export function getSessionBrowserStatusLabels(
  card: Pick<SessionCardData, 'status' | 'automaticStatus'>
): SessionBrowserStatusLabels {
  const statusLabel = statusConfig[card.status].label
  if (card.automaticStatus === card.status) {
    return { statusLabel, agentStatusLabel: null }
  }
  return {
    statusLabel,
    agentStatusLabel: statusConfig[card.automaticStatus].label,
  }
}

export function sessionBrowserStatusClass(status: SessionStatus): string {
  if (isActionableWaitingStatus(status)) {
    return 'bg-warning text-warning-foreground'
  }
  if (status === 'yoloing' || status === 'cancelled' || status === 'crashed') {
    return 'bg-destructive/10 text-destructive'
  }
  if (SESSION_BROWSER_STATUS_BUCKET[status] === 'in_progress') {
    return 'bg-info/10 text-info'
  }
  if (status === 'review' || status === 'completed') {
    return 'bg-success/10 text-success'
  }
  return 'bg-muted text-muted-foreground'
}

export function formatSessionBrowserTime(
  timestamp?: number,
  now = Date.now()
): string | null {
  if (!timestamp) return null
  const normalizedTimestamp =
    timestamp > 0 && timestamp < 1_000_000_000_000
      ? timestamp * 1000
      : timestamp
  const diffMs = now - normalizedTimestamp
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

export function visibleSessionBrowserCards(
  cards: SessionCardData[]
): SessionCardData[] {
  return cards.filter(card => !card.session.archived_at)
}

export function getSessionBrowserFilterTabs(
  cards: SessionCardData[]
): SessionBrowserFilterTab[] {
  const counts: Record<Exclude<SessionBrowserStatusFilter, 'all'>, number> = {
    waiting: 0,
    in_progress: 0,
    review: 0,
    idle: 0,
  }
  const labels = new Map<string, { count: number; color: string }>()

  for (const card of cards) {
    counts[SESSION_BROWSER_STATUS_BUCKET[card.status]] += 1
    if (card.label) {
      const existing = labels.get(card.label.name)
      if (existing) existing.count += 1
      else labels.set(card.label.name, { count: 1, color: card.label.color })
    }
  }

  const labelTabs = [...labels.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, label]) => ({
      key: `label:${name}`,
      label: name,
      count: label.count,
      color: label.color,
    }))

  return [
    { key: 'all', label: 'All', count: cards.length },
    ...STATUS_FILTERS.map(filter => ({
      key: filter.id,
      label: filter.label,
      count: counts[filter.id],
    })),
    ...labelTabs,
  ]
}

function sessionBrowserSearchText(card: SessionCardData): string {
  const { statusLabel, agentStatusLabel } = getSessionBrowserStatusLabels(card)
  const backend = card.session.backend
    ? getBackendLabel(card.session.backend)
    : ''
  return [
    card.session.name,
    card.label?.name ?? '',
    statusLabel,
    agentStatusLabel ?? '',
    backend,
  ]
    .join('\n')
    .toLowerCase()
}

export function filterSessionBrowserCards(
  cards: SessionCardData[],
  filterKey: string,
  query: string
): SessionCardData[] {
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = cards.filter(card => {
    if (!matchesSessionBrowserFilter(card, filterKey)) return false
    if (!normalizedQuery) return true
    return sessionBrowserSearchText(card).includes(normalizedQuery)
  })
  return filtered.sort(compareSessionBrowserCards)
}

export function matchesSessionBrowserFilter(
  card: SessionCardData,
  filterKey: string
): boolean {
  if (filterKey === 'all') return true
  if (filterKey.startsWith('label:')) {
    return card.label?.name === filterKey.slice('label:'.length)
  }
  return SESSION_BROWSER_STATUS_BUCKET[card.status] === filterKey
}

function compareSessionBrowserCards(
  a: SessionCardData,
  b: SessionCardData
): number {
  const activity =
    getSessionActivityTimestamp(b.session) -
    getSessionActivityTimestamp(a.session)
  if (activity !== 0) return activity
  return a.session.name.localeCompare(b.session.name)
}

export function cycleSessionBrowserFilter(
  tabs: SessionBrowserFilterTab[],
  currentKey: string,
  direction: -1 | 1
): string {
  if (tabs.length === 0) return 'all'
  const index = tabs.findIndex(tab => tab.key === currentKey)
  const safeIndex = index === -1 ? 0 : index
  const next = (safeIndex + direction + tabs.length) % tabs.length
  return tabs[next]?.key ?? 'all'
}
