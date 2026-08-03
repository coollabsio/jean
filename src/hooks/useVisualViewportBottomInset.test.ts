import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  getWindowKeyboardInset,
  useVisualViewportBottomInset,
} from './useVisualViewportBottomInset'

interface FakeVisualViewport {
  height: number
  offsetTop: number
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  dispatch: (type: string) => void
}

function installVisualViewport(height: number, offsetTop = 0): FakeVisualViewport {
  const listeners = new Map<string, Set<EventListener>>()
  const vv: FakeVisualViewport = {
    height,
    offsetTop,
    addEventListener: vi.fn((type: string, cb: EventListener) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(cb)
    }),
    removeEventListener: vi.fn((type: string, cb: EventListener) => {
      listeners.get(type)?.delete(cb)
    }),
    dispatch(type: string) {
      for (const cb of listeners.get(type) ?? []) {
        cb(new Event(type))
      }
    },
  }
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: vv,
  })
  return vv
}

describe('getWindowKeyboardInset', () => {
  const originalInnerHeight = window.innerHeight

  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    })
  })

  it('returns 0 when visualViewport is missing', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    })
    expect(getWindowKeyboardInset()).toBe(0)
  })

  it('computes keyboard height from visual viewport', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    })
    installVisualViewport(500, 0)
    expect(getWindowKeyboardInset()).toBe(300)
  })

  it('accounts for visualViewport.offsetTop', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    })
    installVisualViewport(500, 50)
    expect(getWindowKeyboardInset()).toBe(250)
  })
})

describe('useVisualViewportBottomInset', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    })
  })

  it('returns 0 when disabled', () => {
    const el = document.createElement('div')
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 800,
      left: 0,
      right: 400,
      width: 400,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const ref = { current: el }
    installVisualViewport(500)

    const { result } = renderHook(() =>
      useVisualViewportBottomInset(ref, false)
    )
    expect(result.current).toBe(0)
  })

  it('reports how much of the element is below the visual viewport', async () => {
    vi.useFakeTimers()
    const el = document.createElement('div')
    document.body.appendChild(el)
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 800,
      left: 0,
      right: 400,
      width: 400,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const ref = { current: el }
    const vv = installVisualViewport(500, 0)

    const { result } = renderHook(() => useVisualViewportBottomInset(ref, true))

    // Initial measure: 800 - 500 = 300
    expect(result.current).toBe(300)

    // Keyboard closes — visual viewport grows.
    vv.height = 800
    await act(async () => {
      vv.dispatch('resize')
      // scheduleMeasure uses rAF + a delayed remeasure for iOS keyboard animation.
      await vi.runAllTimersAsync()
    })
    expect(result.current).toBe(0)

    el.remove()
    vi.useRealTimers()
  })
})
