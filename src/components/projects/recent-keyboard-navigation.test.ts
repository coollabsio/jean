import { describe, expect, it } from 'vitest'
import type { RecentWorktreeItem } from '@/types/projects'
import { getAdjacentRecentRow } from './RecentWorktreesList'

function row(sessionId: string): RecentWorktreeItem {
  return {
    session: { id: sessionId },
  } as RecentWorktreeItem
}

describe('getAdjacentRecentRow', () => {
  const rows = [row('first'), row('second'), row('third')]

  it('moves down and up from the selected session', () => {
    expect(getAdjacentRecentRow(rows, 'second', 1)?.session.id).toBe('third')
    expect(getAdjacentRecentRow(rows, 'second', -1)?.session.id).toBe('first')
  })

  it('stays at the first and last row at the boundaries', () => {
    expect(getAdjacentRecentRow(rows, 'first', -1)?.session.id).toBe('first')
    expect(getAdjacentRecentRow(rows, 'third', 1)?.session.id).toBe('third')
  })

  it('starts at the edge that matches the direction', () => {
    expect(getAdjacentRecentRow(rows, null, 1)?.session.id).toBe('first')
    expect(getAdjacentRecentRow(rows, null, -1)?.session.id).toBe('third')
  })

  it('returns no row for an empty list', () => {
    expect(getAdjacentRecentRow([], null, 1)).toBeUndefined()
  })
})
