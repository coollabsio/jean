import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import type { SessionCardData } from './session-card-utils'
import {
  mergeSessionIntoWorktreeSessions,
  resolveInitialActiveSessionId,
  resolveModalSessionId,
  sessionsForTabBar,
  sortSessionCardsForTabs,
} from './session-tab-order'

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
      'running',
      'waiting',
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

  it('puts running sessions before sessions updated more recently', () => {
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
      'old-running',
      'older-planning',
      'new-review',
      'new-idle',
    ])
  })
})

describe('resolveModalSessionId', () => {
  it('keeps the active session when the sessions list is transiently empty', () => {
    expect(resolveModalSessionId('active-1', [])).toBe('active-1')
  })

  it('keeps the active session when it is still present', () => {
    expect(resolveModalSessionId('active-1', ['other', 'active-1'])).toBe(
      'active-1'
    )
  })

  it('keeps the active session when a refetch temporarily omits it', () => {
    expect(resolveModalSessionId('active-1', ['first', 'second'])).toBe(
      'active-1'
    )
  })

  it('returns null when there is no active session and no sessions', () => {
    expect(resolveModalSessionId(undefined, [])).toBeNull()
  })

  it('selects the backend last-used session when the client has none', () => {
    expect(
      resolveModalSessionId(undefined, ['first', 'last-used'], 'last-used')
    ).toBe('last-used')
  })

  it('selects the only empty session when the client has none', () => {
    expect(resolveModalSessionId(undefined, ['empty'], null)).toBe('empty')
  })

  it('ignores a backend selection absent from the current list', () => {
    expect(resolveModalSessionId(undefined, ['empty'], 'removed')).toBe('empty')
  })

  it('falls back to the backend selection when the active session is gone', () => {
    expect(
      resolveModalSessionId(
        'deleted',
        ['first', 'last-used'],
        'last-used',
        true
      )
    ).toBe('last-used')
  })

  it('falls back to the first session when the active session is gone', () => {
    expect(resolveModalSessionId('deleted', ['first'], null, true)).toBe(
      'first'
    )
  })
})

describe('resolveInitialActiveSessionId', () => {
  it('does not replace the selected session when a refresh omits it', () => {
    expect(
      resolveInitialActiveSessionId('running', 'other', ['other'])
    ).toBeNull()
  })

  it('uses the persisted backend selection when the client has none', () => {
    expect(
      resolveInitialActiveSessionId(undefined, 'persisted', [
        'first',
        'persisted',
      ])
    ).toBe('persisted')
  })

  it('falls back to the first session when no selection is persisted', () => {
    expect(
      resolveInitialActiveSessionId(undefined, null, ['first', 'second'])
    ).toBe('first')
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
