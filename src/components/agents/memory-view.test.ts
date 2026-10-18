import { describe, expect, it } from 'vitest'
import type {
  AgentJournalEntry,
  AgentMemory,
  AgentMemoryChange,
} from '@/services/agents'
import {
  activeFilterCount,
  dateInputToUnix,
  EMPTY_MEMORY_FILTERS,
  journalDayLabel,
  describeMemoryChange,
  groupJournalByDay,
  journalSearchActive,
  journalSearchRequest,
  memorySearchActive,
  memorySearchRequest,
  partitionMemories,
  showAgentMemorySection,
  showUserFactSection,
  visibleChanges,
} from './memory-view'

function memory(overrides: Partial<AgentMemory>): AgentMemory {
  return {
    id: 1,
    agentId: 'jean',
    projectId: null,
    kind: 'fact',
    content: 'note',
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: null,
    scope: 'agent',
    supersededBy: null,
    supersededAt: null,
    ...overrides,
  }
}

function entry(overrides: Partial<AgentJournalEntry>): AgentJournalEntry {
  return {
    id: 1,
    agentId: 'jean',
    projectId: null,
    content: 'happened',
    occurredAt: 0,
    createdAt: 0,
    source: 'user',
    sourceSessionId: null,
    ...overrides,
  }
}

function change(overrides: Partial<AgentMemoryChange>): AgentMemoryChange {
  return {
    id: 1,
    memoryId: 4,
    actorAgentId: null,
    ownerAgentId: null,
    action: 'supersede',
    scope: 'user',
    kind: 'fact',
    beforeContent: 'UTC',
    afterContent: 'Helsinki',
    createdAt: 10,
    ...overrides,
  }
}

describe('partitionMemories', () => {
  it('keeps user facts apart from private and shared memory', () => {
    const { userFacts, rest } = partitionMemories([
      memory({ id: 1, scope: 'agent', content: 'private' }),
      memory({ id: 2, scope: 'user', agentId: null, content: 'Ada' }),
      memory({ id: 3, scope: 'shared', agentId: null, content: 'shared rule' }),
    ])
    expect(userFacts.map(item => item.id)).toEqual([2])
    expect(rest.map(item => item.id)).toEqual([1, 3])
  })
})

describe('memory search request', () => {
  it('omits empty filters and converts a local day range', () => {
    expect(
      memorySearchActive({
        query: '  ',
        kind: '',
        scope: '',
        pinned: '',
        from: '',
        to: '',
        project: ' ',
      })
    ).toBe(false)
    const request = memorySearchRequest({
      query: ' orbit ',
      kind: 'fact',
      scope: 'user',
      pinned: 'yes',
      from: '1970-01-02',
      to: '1970-01-02',
      project: ' coolify ',
    })
    expect(request.query).toBe('orbit')
    expect(request.kind).toBe('fact')
    expect(request.scope).toBe('user')
    expect(request.pinned).toBe(true)
    expect(request.projectId).toBe('coolify')
    expect(request.from).toEqual(expect.any(Number))
    expect(request.to).toEqual(expect.any(Number))
    expect((request.to ?? 0) - (request.from ?? 0)).toBe(86_399)
    expect(
      journalSearchActive({
        query: '',
        kind: 'rule',
        scope: 'agent',
        pinned: 'no',
        from: '',
        to: '',
        project: 'orbit',
      })
    ).toBe(false)
    expect(
      journalSearchRequest({
        query: 'shipped',
        kind: 'rule',
        scope: 'agent',
        pinned: 'yes',
        from: '1970-01-02',
        to: '',
        project: 'orbit',
      })
    ).toEqual({
      query: 'shipped',
      from: request.from,
    })
  })

  it('rejects a calendar day that does not exist', () => {
    expect(dateInputToUnix('', false)).toBeNull()
    expect(dateInputToUnix('1970-02-31', false)).toBeNull()
    expect(dateInputToUnix('nope', true)).toBeNull()
  })
})

describe('sections', () => {
  it('hides the other section when a scope filter is set', () => {
    expect(showUserFactSection({ ...empty(), scope: 'agent' })).toBe(false)
    expect(showUserFactSection({ ...empty(), scope: 'user' })).toBe(true)
    expect(showUserFactSection({ ...empty(), kind: 'rule' })).toBe(false)
    expect(showUserFactSection({ ...empty(), kind: 'fact' })).toBe(true)
    expect(showAgentMemorySection({ ...empty(), scope: 'user' })).toBe(false)
    expect(showAgentMemorySection({ ...empty(), scope: 'shared' })).toBe(true)
  })
})

describe('groupJournalByDay', () => {
  it('groups by UTC day, newest first', () => {
    const groups = groupJournalByDay(
      [
        entry({ id: 1, occurredAt: 100, content: 'early' }),
        entry({ id: 2, occurredAt: 86_400 + 10, content: 'next' }),
        entry({ id: 3, occurredAt: 200, content: 'later that day' }),
      ],
      'UTC'
    )
    expect(groups.map(group => group.day)).toEqual(['1970-01-02', '1970-01-01'])
    expect(groups[1]?.entries.map(item => item.id)).toEqual([3, 1])
  })
})

describe('changes', () => {
  it('describes who changed a fact and can collapse the list', () => {
    expect(describeMemoryChange(change({}))).toBe('You corrected a user fact')
    expect(
      describeMemoryChange(
        change({ action: 'forget', actorAgentId: 'jean', memoryId: 9 })
      )
    ).toBe('agent jean forgot #9')
    const many = [1, 2, 3].map(id => change({ id }))
    expect(visibleChanges(many, false, 2)).toHaveLength(2)
    expect(visibleChanges(many, true, 2)).toHaveLength(3)
  })
})

function empty() {
  return {
    query: '',
    kind: '' as const,
    scope: '' as const,
    pinned: '' as const,
    from: '',
    to: '',
    project: '',
  }
}

describe('activeFilterCount', () => {
  it('counts set filters but not the search text', () => {
    expect(activeFilterCount(EMPTY_MEMORY_FILTERS)).toBe(0)
    expect(
      activeFilterCount({ ...EMPTY_MEMORY_FILTERS, query: 'deploy' })
    ).toBe(0)
    expect(
      activeFilterCount({
        ...EMPTY_MEMORY_FILTERS,
        kind: 'rule',
        pinned: 'yes',
        from: '2026-10-01',
        project: '  ',
      })
    ).toBe(3)
  })
})

describe('journalDayLabel', () => {
  const now = new Date(2026, 9, 18, 15, 0, 0)

  it('names today and yesterday', () => {
    expect(journalDayLabel('2026-10-18', now)).toBe('Today')
    expect(journalDayLabel('2026-10-17', now)).toBe('Yesterday')
  })

  it('shows a short date, with the year only for other years', () => {
    expect(journalDayLabel('2026-10-16', now)).toBe('Fri 16 Oct')
    expect(journalDayLabel('2025-12-31', now)).toBe('Wed 31 Dec 2025')
  })

  it('returns unknown input unchanged', () => {
    expect(journalDayLabel('soon', now)).toBe('soon')
  })
})
