import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MODIFIER_HINT_SHOW_DELAY_MS,
  useModifierHintsVisible,
} from './useModifierHintsVisible'

const isCtrlHeld = (event: Pick<KeyboardEvent, 'ctrlKey'>) => event.ctrlKey

function press(type: 'keydown' | 'keyup', init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, init))
  })
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useModifierHintsVisible', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows after the delay while the modifier is held', () => {
    const { result } = renderHook(() => useModifierHintsVisible(isCtrlHeld))

    press('keydown', { key: 'Control', ctrlKey: true })
    wait(MODIFIER_HINT_SHOW_DELAY_MS - 1)
    expect(result.current).toBe(false)
    wait(1)
    expect(result.current).toBe(true)

    press('keyup', { key: 'Control', ctrlKey: false })
    expect(result.current).toBe(false)
  })

  it('does not show for a quick shortcut such as Ctrl+C', () => {
    const { result } = renderHook(() => useModifierHintsVisible(isCtrlHeld))

    press('keydown', { key: 'Control', ctrlKey: true })
    press('keydown', { key: 'c', ctrlKey: true })
    wait(MODIFIER_HINT_SHOW_DELAY_MS)
    expect(result.current).toBe(false)
  })

  it('hides when the window loses focus', () => {
    const { result } = renderHook(() => useModifierHintsVisible(isCtrlHeld))
    press('keydown', { key: 'Control', ctrlKey: true })
    wait(MODIFIER_HINT_SHOW_DELAY_MS)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current).toBe(false)
  })

  it('stays hidden when disabled', () => {
    const { result } = renderHook(() =>
      useModifierHintsVisible(isCtrlHeld, false)
    )
    press('keydown', { key: 'Control', ctrlKey: true })
    wait(MODIFIER_HINT_SHOW_DELAY_MS)
    expect(result.current).toBe(false)
  })
})
