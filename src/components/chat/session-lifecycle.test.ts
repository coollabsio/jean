import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import type { SessionCardData } from './session-card-utils'
import {
  decideSessionClose,
  isActiveSessionGone,
  isSessionEmpty,
  mergeSessionIntoWorktreeSessions,
  openSessions,
  resolveActiveAfterCloseSuccess,
  resolveActiveSessionId,
  resolvePersistedActiveSessionId,
  selectNeighborAfterClose,
  sessionsForTabBar,
  sortSessionCardsForTabs,
} from './session-lifecycle'

function session(id: string, order: number, created_at = order): Session {
  return {
    id,
    name: id,
    order,
    created_at,
    updated_at: created_at,
    messages: [],
  }
}

function card(
  id: string,
  status: SessionCardData['status'],
  order: number,
  updatedAt = order
) {
  return {
    session: { ...session(id, order), updated_at: updatedAt },
    status,
  } as SessionCardData
}

describe('session tab ordering', () => {
  it('always keeps the code review session first', () => {
    const review = card('review-session', 'review', 99)
    review.session.name = 'Code Review · Claude · claude-opus-4-8[1m]'

    const sorted = sortSessionCardsForTabs([
      card('waiting', 'waiting', 0),
      card('running', 'vibing', 1),
      review,
    ])

    expect(sorted.map(item => item.session.id)).toEqual([
      'review-session',
      'waiting',
      'running',
    ])
  })

  it('sorts non-running sessions by most recently updated first', () => {
    const sorted = sortSessionCardsForTabs([
      card('old-waiting', 'waiting', 0, 100),
      card('new-idle', 'idle', 20, 400),
      card('middle-review', 'review', 10, 300),
      card('middle-idle', 'idle', 2, 200),
    ])

    expect(sorted.map(item => item.session.id)).toEqual([
      'new-idle',
      'middle-review',
      'middle-idle',
      'old-waiting',
    ])
  })

  it('puts running sessions after all other sessions', () => {
    const review = card('review-session', 'review', 99, 1)
    review.session.name = 'Code Review · Claude'

    const sorted = sortSessionCardsForTabs([
      card('new-review', 'review', 0, 500),
      card('old-running', 'vibing', 1, 100),
      review,
      card('new-idle', 'idle', 2, 400),
      card('older-planning', 'planning', 3, 50),
    ])

    expect(sorted.map(item => item.session.id)).toEqual([
      'review-session',
      'new-review',
      'new-idle',
      'old-running',
      'older-planning',
    ])
  })
})

describe('resolveActiveSessionId', () => {
  const resolve = (
    current: string | undefined,
    listedIds: string[],
    backendActive: string | null = null,
    currentGone = false
  ) =>
    resolveActiveSessionId({ current, currentGone, backendActive, listedIds })

  it('keeps the current session when the sessions list is transiently empty', () => {
    expect(resolve('active-1', [])).toBe('active-1')
  })

  it('keeps the current session when a refetch temporarily omits it', () => {
    expect(resolve('running', ['other'], 'other')).toBe('running')
  })

  it('returns null when there is no current session and no sessions', () => {
    expect(resolve(undefined, [])).toBeNull()
  })

  it('selects the backend last-used session when the client has none', () => {
    expect(resolve(undefined, ['first', 'last-used'], 'last-used')).toBe(
      'last-used'
    )
  })

  it('ignores a backend selection absent from the current list', () => {
    expect(resolve(undefined, ['empty'], 'removed')).toBe('empty')
  })

  it('falls back to the first session when nothing is selected', () => {
    expect(resolve(undefined, ['first', 'second'])).toBe('first')
  })

  it('falls back to the backend selection when the current session is gone', () => {
    expect(resolve('deleted', ['first', 'last-used'], 'last-used', true)).toBe(
      'last-used'
    )
  })

  it('falls back to the first session when the current session is gone', () => {
    expect(resolve('deleted', ['first'], null, true)).toBe('first')
  })
})

describe('resolvePersistedActiveSessionId', () => {
  const resolve = (
    current: string | undefined,
    listedIds: string[],
    backendActive: string | null = null,
    currentGone = false
  ) =>
    resolvePersistedActiveSessionId({
      current,
      currentGone,
      backendActive,
      listedIds,
    })

  it('stores nothing while the backend active session is not listed yet', () => {
    expect(resolve(undefined, ['first'], 'new')).toBeNull()
    expect(resolve('deleted', ['first'], 'new', true)).toBeNull()
  })

  it('stores the backend active session once the refetched list has it', () => {
    expect(resolve(undefined, ['first', 'new'], 'new')).toBe('new')
  })

  it('keeps the current session even when the backend session is unlisted', () => {
    expect(resolve('mine', ['first'], 'new')).toBe('mine')
  })

  it('stores the first session when the backend names none', () => {
    expect(resolve(undefined, ['first', 'second'])).toBe('first')
    expect(resolve(undefined, [])).toBeNull()
  })
})

describe('openSessions', () => {
  it('drops closed (archived) sessions', () => {
    expect(
      openSessions([
        { id: 'a', archived_at: null },
        { id: 'b', archived_at: 5 },
        { id: 'c' },
      ]).map(item => item.id)
    ).toEqual(['a', 'c'])
  })
})

describe('selectNeighborAfterClose', () => {
  const tabs = ['a', 'b', 'c']

  it('selects the left neighbor of the closed active tab', () => {
    expect(selectNeighborAfterClose(tabs, 'b', 'b')).toBe('a')
  })

  it('selects the right neighbor when the first tab closes', () => {
    expect(selectNeighborAfterClose(tabs, 'a', 'a')).toBe('b')
  })

  it('selects nothing when the only tab closes', () => {
    expect(selectNeighborAfterClose(['a'], 'a', 'a')).toBeNull()
  })

  it('keeps the selection when an inactive tab closes', () => {
    expect(selectNeighborAfterClose(tabs, 'c', 'a')).toBeNull()
  })

  it('selects nothing when the closed tab is not shown', () => {
    expect(selectNeighborAfterClose(tabs, 'x', 'x')).toBeNull()
  })
})

describe('isSessionEmpty', () => {
  it('is empty with no messages and no draft', () => {
    expect(isSessionEmpty({ id: 's1', message_count: 0 }, {})).toBe(true)
  })

  it('is empty when the draft has only whitespace', () => {
    expect(isSessionEmpty({ id: 's1' }, { s1: '  \n ' })).toBe(true)
  })

  it('is not empty when an unsent draft exists', () => {
    expect(
      isSessionEmpty({ id: 's1', message_count: 0 }, { s1: 'fix it' })
    ).toBe(false)
  })

  it('ignores drafts of other sessions', () => {
    expect(isSessionEmpty({ id: 's1' }, { s2: 'fix it' })).toBe(true)
  })

  it('is not empty when the session has messages', () => {
    expect(isSessionEmpty({ id: 's1', message_count: 2 }, {})).toBe(false)
  })
})

describe('decideSessionClose', () => {
  const empty = { id: 's1', message_count: 0 }
  const used = { id: 's1', message_count: 3 }
  const other = { id: 's2' }
  const decide = (
    target: Parameters<typeof decideSessionClose>[0]['target'],
    sessions: Parameters<typeof decideSessionClose>[0]['sessions'],
    options: {
      inputDrafts?: Record<string, string>
      onLastSession?: 'close-session' | 'confirm-worktree'
      isServer?: boolean
    } = {}
  ) =>
    decideSessionClose({
      target,
      sessions,
      inputDrafts: options.inputDrafts ?? {},
      onLastSession: options.onLastSession ?? 'close-session',
      isServer: options.isServer,
    })

  it('closes an empty session at once when other sessions exist', () => {
    expect(decide(empty, [empty, other])).toBe('close-session')
  })

  it('confirms a session with messages or an unsent draft (issue #56)', () => {
    expect(decide(used, [used, other])).toBe('confirm-session')
    expect(
      decide(empty, [empty, other], { inputDrafts: { s1: 'draft' } })
    ).toBe('confirm-session')
  })

  it('closes the last tab like any other session', () => {
    expect(decide(empty, [empty])).toBe('close-session')
    expect(decide(used, [used])).toBe('confirm-session')
  })

  it('asks to delete the worktree for the last Recent row, even when empty', () => {
    expect(decide(empty, [empty], { onLastSession: 'confirm-worktree' })).toBe(
      'confirm-worktree'
    )
    expect(decide(used, [used], { onLastSession: 'confirm-worktree' })).toBe(
      'confirm-worktree'
    )
  })

  it('ignores deleted sessions when it counts the open ones', () => {
    expect(
      decide(used, [used, { id: 's2', archived_at: 1 }], {
        onLastSession: 'confirm-worktree',
      })
    ).toBe('confirm-worktree')
  })

  it('asks to close the worktree when no session is open', () => {
    expect(decide(null, [])).toBe('confirm-worktree')
  })

  it('never offers to close a server worktree', () => {
    expect(decide(null, [], { isServer: true })).toBe('noop')
    expect(
      decide(used, [used], {
        onLastSession: 'confirm-worktree',
        isServer: true,
      })
    ).toBe('confirm-session')
  })

  it('does nothing for an already closed session', () => {
    expect(decide({ id: 's1', archived_at: 9 }, [other])).toBe('noop')
  })

  it('does nothing without a target while sessions are open', () => {
    expect(decide(null, [other])).toBe('noop')
  })
})

describe('resolveActiveAfterCloseSuccess', () => {
  it('selects the backend session when the closed session was active', () => {
    expect(resolveActiveAfterCloseSuccess('closed', 'closed', 'next')).toEqual({
      kind: 'select',
      sessionId: 'next',
    })
  })

  it('selects the backend session when nothing is selected', () => {
    expect(resolveActiveAfterCloseSuccess(undefined, 'closed', 'next')).toEqual(
      { kind: 'select', sessionId: 'next' }
    )
  })

  it('keeps a neighbor the caller already selected', () => {
    expect(
      resolveActiveAfterCloseSuccess('neighbor', 'closed', 'next')
    ).toEqual({ kind: 'keep' })
  })

  it('clears the selection when the backend reports no session', () => {
    expect(resolveActiveAfterCloseSuccess('neighbor', 'closed', null)).toEqual({
      kind: 'clear',
    })
  })
})

describe('isActiveSessionGone', () => {
  it('treats an archived (closed) session as gone', () => {
    const closed = { ...session('closed', 1), archived_at: 123 }

    expect(isActiveSessionGone(true, false, closed)).toBe(true)
  })

  it('treats a failed lookup as gone', () => {
    expect(isActiveSessionGone(true, true, undefined)).toBe(true)
  })

  it('keeps a live session that the list does not include yet', () => {
    expect(isActiveSessionGone(true, false, session('open', 1))).toBe(false)
  })

  it('keeps the session while the list is still loading', () => {
    const closed = { ...session('closed', 1), archived_at: 123 }

    expect(isActiveSessionGone(false, true, closed)).toBe(false)
  })
})

describe('sessionsForTabBar', () => {
  it('keeps the open session when the worktree list is empty', () => {
    const open = session('open', 1)

    expect(sessionsForTabBar([], open).map(item => item.id)).toEqual(['open'])
  })

  it('does not duplicate a session that is already in the list', () => {
    const open = session('open', 1)
    const other = session('other', 2)

    expect(sessionsForTabBar([other, open], open).map(item => item.id)).toEqual(
      ['other', 'open']
    )
  })
})

describe('mergeSessionIntoWorktreeSessions', () => {
  it('creates a list from the known session when the cache is empty', () => {
    const open = session('open', 1)

    expect(
      mergeSessionIntoWorktreeSessions(undefined, 'worktree-1', open)
    ).toMatchObject({
      worktree_id: 'worktree-1',
      active_session_id: 'open',
      sessions: [open],
    })
  })

  it('adds the known session without dropping sessions already cached', () => {
    const open = session('open', 1)
    const other = session('other', 2)

    const merged = mergeSessionIntoWorktreeSessions(
      {
        worktree_id: 'worktree-1',
        sessions: [other],
        active_session_id: 'other',
        version: 2,
      },
      'worktree-1',
      open
    )

    expect(merged.sessions.map(item => item.id)).toEqual(['other', 'open'])
    expect(merged.active_session_id).toBe('other')
  })
})
