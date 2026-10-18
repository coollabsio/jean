import type {
  AgentJournalEntry,
  AgentMemory,
  AgentMemoryChange,
  AgentMemoryQuery,
  MemoryKind,
  MemoryScope,
} from '@/services/agents'

export interface MemorySearchFilters {
  query: string
  kind: '' | MemoryKind
  scope: '' | MemoryScope
  pinned: '' | 'yes' | 'no'
  /** YYYY-MM-DD, local calendar day */
  from: string
  to: string
  project: string
}

export const EMPTY_MEMORY_FILTERS: MemorySearchFilters = {
  query: '',
  kind: '',
  scope: '',
  pinned: '',
  from: '',
  to: '',
  project: '',
}

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/

/** Start or end of a local calendar day, as unix seconds. */
export function dateInputToUnix(
  value: string,
  endOfDay: boolean
): number | null {
  const match = DATE_INPUT.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59)
    : new Date(year, month - 1, day, 0, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return Math.floor(date.getTime() / 1000)
}

export function memorySearchActive(filters: MemorySearchFilters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.kind !== '' ||
    filters.scope !== '' ||
    filters.pinned !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.project.trim() !== ''
  )
}

/** Filters set besides the search text, for the Filters button badge. */
export function activeFilterCount(filters: MemorySearchFilters): number {
  return [
    filters.kind,
    filters.scope,
    filters.pinned,
    filters.from,
    filters.to,
    filters.project.trim(),
  ].filter(value => value !== '').length
}

export function journalSearchActive(filters: MemorySearchFilters): boolean {
  return filters.query.trim() !== '' || filters.from !== '' || filters.to !== ''
}

export function memorySearchRequest(
  filters: MemorySearchFilters
): AgentMemoryQuery {
  const request: AgentMemoryQuery = {}
  const query = filters.query.trim()
  if (query) request.query = query
  if (filters.kind) request.kind = filters.kind
  if (filters.scope) request.scope = filters.scope
  const project = filters.project.trim()
  if (project) request.projectId = project
  if (filters.pinned === 'yes') request.pinned = true
  if (filters.pinned === 'no') request.pinned = false
  const from = dateInputToUnix(filters.from, false)
  const to = dateInputToUnix(filters.to, true)
  if (from !== null) request.from = from
  if (to !== null) request.to = to
  return request
}

export function journalSearchRequest(
  filters: MemorySearchFilters
): AgentMemoryQuery {
  const request: AgentMemoryQuery = {}
  const query = filters.query.trim()
  if (query) request.query = query
  const from = dateInputToUnix(filters.from, false)
  const to = dateInputToUnix(filters.to, true)
  if (from !== null) request.from = from
  if (to !== null) request.to = to
  return request
}

export function partitionMemories(memories: AgentMemory[]): {
  userFacts: AgentMemory[]
  rest: AgentMemory[]
} {
  const userFacts: AgentMemory[] = []
  const rest: AgentMemory[] = []
  for (const memory of memories) {
    if (memory.scope === 'user') userFacts.push(memory)
    else rest.push(memory)
  }
  return { userFacts, rest }
}

/** User memory holds only facts, so a rule or open-work filter hides it. */
export function showUserFactSection(filters: MemorySearchFilters): boolean {
  return (
    (filters.scope === '' || filters.scope === 'user') &&
    (filters.kind === '' || filters.kind === 'fact')
  )
}

export function showAgentMemorySection(filters: MemorySearchFilters): boolean {
  return filters.scope !== 'user'
}

export function formatDay(unixSeconds: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSeconds * 1000))
}

export function formatJournalTime(
  unixSeconds: number,
  timeZone?: string
): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(unixSeconds * 1000))
}

export function groupJournalByDay(
  entries: AgentJournalEntry[],
  timeZone?: string
): { day: string; entries: AgentJournalEntry[] }[] {
  const sorted = [...entries].sort(
    (a, b) => b.occurredAt - a.occurredAt || b.id - a.id
  )
  const groups: { day: string; entries: AgentJournalEntry[] }[] = []
  for (const entry of sorted) {
    const day = formatDay(entry.occurredAt, timeZone)
    const last = groups[groups.length - 1]
    if (last?.day === day) last.entries.push(entry)
    else groups.push({ day, entries: [entry] })
  }
  return groups
}

/** Heading for a `formatDay` group: Today, Yesterday, or "Fri 16 Oct". */
export function journalDayLabel(day: string, now = new Date()): string {
  const toKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  if (day === toKey(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (day === toKey(yesterday)) return 'Yesterday'
  const match = DATE_INPUT.exec(day)
  if (!match) return day
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  )
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(item => item.type === type)?.value ?? ''
  const label = `${part('weekday')} ${part('day')} ${part('month')}`
  return date.getFullYear() === now.getFullYear()
    ? label
    : `${label} ${part('year')}`
}

export function journalSourceLabel(source: string): string {
  switch (source) {
    case 'rotation':
      return 'Archived chat'
    case 'agent':
      return 'Agent'
    case 'user':
      return 'You'
    default:
      return source
  }
}

export function describeMemoryChange(change: AgentMemoryChange): string {
  const who = change.actorAgentId ? `agent ${change.actorAgentId}` : 'You'
  switch (change.action) {
    case 'create':
      return `${who} saved a ${change.scope} ${change.kind}`
    case 'update':
      return `${who} edited #${change.memoryId}`
    case 'forget':
      return `${who} forgot #${change.memoryId}`
    case 'supersede':
      return `${who} corrected a ${change.scope} fact`
    default:
      return `${who} ${change.action} #${change.memoryId}`
  }
}

export function visibleChanges(
  changes: AgentMemoryChange[],
  expanded: boolean,
  limit = 8
): AgentMemoryChange[] {
  return expanded ? changes : changes.slice(0, limit)
}
