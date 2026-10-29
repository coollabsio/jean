import { describe, expect, it } from 'vitest'
import {
  getCanvasRowAttention,
  getCanvasRowState,
  sortByCanvasRowState,
  type CanvasRowState,
} from './canvas-row-state'

describe('getCanvasRowState', () => {
  it('prefers waiting over running', () => {
    expect(getCanvasRowState({ waitingCount: 1, runningCount: 2 })).toBe(
      'waiting'
    )
  })

  it('treats running sessions and pending setup as running', () => {
    expect(getCanvasRowState({ waitingCount: 0, runningCount: 1 })).toBe(
      'running'
    )
    expect(
      getCanvasRowState({ waitingCount: 0, runningCount: 0, isPending: true })
    ).toBe('running')
  })

  it('falls back to idle', () => {
    expect(getCanvasRowState({ waitingCount: 0, runningCount: 0 })).toBe('idle')
  })
})

describe('sortByCanvasRowState', () => {
  it('orders groups waiting, running, idle and keeps order inside a group', () => {
    const items: [string, CanvasRowState][] = [
      ['a', 'idle'],
      ['b', 'running'],
      ['c', 'waiting'],
      ['d', 'idle'],
      ['e', 'running'],
    ]
    const sorted = sortByCanvasRowState(items, ([, state]) => state)
    expect(sorted.map(([name]) => name)).toEqual(['c', 'b', 'e', 'a', 'd'])
  })
})

describe('getCanvasRowAttention', () => {
  it('flags conflicts before failing checks', () => {
    expect(
      getCanvasRowAttention({
        checkStatus: 'failure',
        mergeable: 'conflicting',
      })
    ).toBe('conflicts')
  })

  it('flags failing and errored checks', () => {
    expect(getCanvasRowAttention({ checkStatus: 'failure' })).toBe(
      'checks_failing'
    )
    expect(getCanvasRowAttention({ checkStatus: 'error' })).toBe(
      'checks_failing'
    )
  })

  it('ignores healthy or unknown state', () => {
    expect(
      getCanvasRowAttention({ checkStatus: 'success', mergeable: 'mergeable' })
    ).toBeNull()
    expect(getCanvasRowAttention({ checkStatus: 'pending' })).toBeNull()
    expect(getCanvasRowAttention({})).toBeNull()
  })
})
