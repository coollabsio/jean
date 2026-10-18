import { describe, expect, it } from 'vitest'
import type { RecentWorktreeItem } from '@/types/projects'
import { sortRecentRows } from './RecentWorktreesList'

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
