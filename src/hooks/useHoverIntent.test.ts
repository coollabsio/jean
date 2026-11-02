import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useHoverIntent } from './useHoverIntent'

describe('useHoverIntent', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires only for the element the pointer rests on', () => {
    const onIntent = vi.fn()
    const { result } = renderHook(() => useHoverIntent(onIntent, 100))

    result.current.start('a')
    vi.advanceTimersByTime(50)
    result.current.start('b')
    vi.advanceTimersByTime(100)

    expect(onIntent).toHaveBeenCalledTimes(1)
    expect(onIntent).toHaveBeenCalledWith('b')
  })

  it('does not fire after the pointer leaves or the component unmounts', () => {
    const onIntent = vi.fn()
    const { result, unmount } = renderHook(() => useHoverIntent(onIntent, 100))

    result.current.start('a')
    result.current.cancel()
    vi.advanceTimersByTime(200)
    result.current.start('b')
    unmount()
    vi.advanceTimersByTime(200)

    expect(onIntent).not.toHaveBeenCalled()
  })
})
