import { describe, expect, it } from 'vitest'
import type { RecentWorktreeItem } from '@/types/projects'
import { groupRecentRows, sortRecentRows } from './RecentWorktreesList'

function row(sessionId: string): RecentWorktreeItem {
  return {
    session: { id: sessionId },
  } as RecentWorktreeItem
}

const ids = (rows: RecentWorktreeItem[]) => rows.map(r => r.session.id)

describe('sortRecentRows', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map(row)

  it('puts running rows first inside the pinned and unpinned groups', () => {
    const pinned = new Set(['b', 'e'])
    const running = new Set(['c', 'e', 'f'])
    const sorted = sortRecentRows(rows, pinned, r => running.has(r.session.id))
    expect(ids(sorted)).toEqual(['e', 'b', 'c', 'f', 'a', 'd'])
  })

  it('keeps the recent-activity order when nothing runs', () => {
    const sorted = sortRecentRows(rows, new Set(['d']), () => false)
    expect(ids(sorted)).toEqual(['d', 'a', 'b', 'c', 'e', 'f'])
  })

  it('does not change the input array', () => {
    sortRecentRows(rows, new Set(['f']), () => true)
    expect(ids(rows)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})

describe('groupRecentRows', () => {
  const now = 2_000_000_000_000
  const active = Math.floor(now / 1000) - 60
  const snoozed = Math.floor(now / 1000) - 2 * 24 * 60 * 60
  function sessionRow(
    id: string,
    leadId?: string,
    lastActivityAt = active
  ): RecentWorktreeItem {
    return {
      session: {
        id,
        ...(leadId
          ? {
              delegated_by: {
                origin_session_id: leadId,
                origin_worktree_id: 'wt',
              },
            }
          : {}),
      },
      lastActivityAt,
    } as RecentWorktreeItem
  }

  it('nests a sub-session under its lead when both are in the same part', () => {
    const grouped = groupRecentRows(
      [
        sessionRow('child', 'lead'),
        sessionRow('other'),
        sessionRow('lead'),
        sessionRow('grandchild', 'child'),
      ],
      new Set(),
      () => false,
      now
    )
    expect(ids(grouped.listRows)).toEqual([
      'other',
      'lead',
      'child',
      'grandchild',
    ])
    expect(Object.fromEntries(grouped.depthById)).toEqual({
      child: 1,
      grandchild: 2,
    })
  })

  it('keeps a sub-session at top level when its lead is in another part or not loaded', () => {
    const grouped = groupRecentRows(
      [
        sessionRow('running-child', 'lead'),
        sessionRow('lead'),
        sessionRow('orphan', 'not-loaded'),
        sessionRow('old-child', 'lead', snoozed),
      ],
      new Set(),
      row => row.session.id === 'running-child',
      now
    )
    expect(ids(grouped.listRows)).toEqual(['lead', 'orphan'])
    expect(ids(grouped.workingRows)).toEqual(['running-child'])
    expect(ids(grouped.snoozedRows)).toEqual(['old-child'])
    expect(grouped.depthById.size).toBe(0)
  })

  it('shows no pinned separator when the only pinned row is nested under an unpinned lead', () => {
    const grouped = groupRecentRows(
      [sessionRow('child', 'lead'), sessionRow('lead'), sessionRow('other')],
      new Set(['child']),
      () => false,
      now
    )
    expect(ids(grouped.listRows)).toEqual(['lead', 'child', 'other'])
    expect(grouped.firstUnpinnedSessionId).toBeNull()
  })

  it('keeps an unpinned sub-session of a pinned lead above the pinned separator', () => {
    const grouped = groupRecentRows(
      [sessionRow('plain'), sessionRow('child', 'lead'), sessionRow('lead')],
      new Set(['lead']),
      () => false,
      now
    )
    expect(ids(grouped.listRows)).toEqual(['lead', 'child', 'plain'])
    expect(grouped.firstUnpinnedSessionId).toBe('plain')
  })

  it('draws no pinned separator without pinned rows', () => {
    const grouped = groupRecentRows(
      [sessionRow('a'), sessionRow('b')],
      new Set(),
      () => false,
      now
    )
    expect(grouped.firstUnpinnedSessionId).toBeNull()
  })
})

describe('groupRecentRows pinned separator', () => {
  it('goes above the first unpinned top-level row when a top-level row is pinned', () => {
    const rows = ['p', 'a', 'b'].map(id => ({
      session: { id },
      lastActivityAt: Math.floor(2_000_000_000_000 / 1000) - 60,
    })) as RecentWorktreeItem[]
    const grouped = groupRecentRows(
      rows,
      new Set(['p']),
      () => false,
      2_000_000_000_000
    )
    expect(grouped.firstUnpinnedSessionId).toBe('a')
  })
})
