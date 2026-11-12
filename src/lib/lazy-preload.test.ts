import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preloadWhenIdle } from './lazy-preload'

describe('preloadWhenIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs loaders one at a time and continues after a failure', async () => {
    const calls: string[] = []
    const loader =
      (name: string, fail = false) =>
      () => {
        calls.push(name)
        return fail ? Promise.reject(new Error(name)) : Promise.resolve()
      }

    preloadWhenIdle([loader('a'), loader('b', true), loader('c')])
    expect(calls).toEqual([])

    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('stops loading after cancel', async () => {
    const calls: string[] = []
    const cancel = preloadWhenIdle([
      () => (calls.push('a'), Promise.resolve()),
      () => (calls.push('b'), Promise.resolve()),
    ])

    await vi.advanceTimersByTimeAsync(250)
    cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toEqual(['a'])
  })
})
