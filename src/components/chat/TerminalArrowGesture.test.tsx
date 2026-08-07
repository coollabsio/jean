import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@/test/test-utils'
import { TerminalArrowGesture } from './TerminalArrowGesture'
import {
  ARROW_GESTURE_LONG_PRESS_MS,
  isArrowGestureActive,
} from '@/lib/terminal-arrow-gesture'

const { writeTerminalInput, focusTerminal } = vi.hoisted(() => ({
  writeTerminalInput: vi.fn(),
  focusTerminal: vi.fn(),
}))

vi.mock('@/lib/terminal-instances', () => ({
  writeTerminalInput,
  focusTerminal,
}))

function fireTouch(
  el: HTMLElement,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  clientX: number,
  clientY: number,
  options?: { cancelable?: boolean }
) {
  const touch = {
    clientX,
    clientY,
    identifier: 1,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    target: el,
    force: 1,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
  } as unknown as Touch

  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: options?.cancelable ?? true,
    touches: type === 'touchend' || type === 'touchcancel' ? [] : [touch],
    targetTouches: type === 'touchend' || type === 'touchcancel' ? [] : [touch],
    changedTouches: [touch],
  })
  el.dispatchEvent(event)
  return event
}

describe('TerminalArrowGesture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the pad after a long-press and sends arrows on drag', () => {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const surfaceRef = { current: surface }

    render(
      <TerminalArrowGesture terminalId="term-1" surfaceRef={surfaceRef} />
    )

    expect(screen.queryByTestId('terminal-arrow-gesture-pad')).toBeNull()

    fireTouch(surface, 'touchstart', 100, 100)

    act(() => {
      vi.advanceTimersByTime(ARROW_GESTURE_LONG_PRESS_MS)
    })

    const pad = screen.getByTestId('terminal-arrow-gesture-pad')
    expect(pad).toBeTruthy()
    // In-flow chrome row above the emulator (not an overlay on the text).
    expect(pad.className).toContain('shrink-0')
    expect(pad.className).toContain('justify-end')
    expect(isArrowGestureActive('term-1')).toBe(true)
    expect(focusTerminal).toHaveBeenCalledWith('term-1')

    act(() => {
      fireTouch(surface, 'touchmove', 100, 40) // up
    })

    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x1b[A')

    act(() => {
      fireTouch(surface, 'touchend', 100, 40)
    })

    expect(screen.queryByTestId('terminal-arrow-gesture-pad')).toBeNull()
    expect(isArrowGestureActive('term-1')).toBe(false)

    surface.remove()
  })

  it('renders the pad as a chrome row above the terminal, not as an overlay', () => {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const surfaceRef = { current: surface }

    render(
      <TerminalArrowGesture terminalId="term-1" surfaceRef={surfaceRef} />
    )

    fireTouch(surface, 'touchstart', 20, 400)
    act(() => {
      vi.advanceTimersByTime(ARROW_GESTURE_LONG_PRESS_MS)
    })

    const pad = screen.getByTestId('terminal-arrow-gesture-pad')
    // Not absolutely positioned over the terminal buffer.
    expect(pad.className).not.toContain('absolute')
    expect(pad.className).not.toContain('fixed')
    expect(pad.className).toContain('justify-end')

    act(() => {
      fireTouch(surface, 'touchend', 20, 400)
    })
    surface.remove()
  })

  it('cancels long-press when the finger moves early (scroll)', () => {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const surfaceRef = { current: surface }

    render(
      <TerminalArrowGesture terminalId="term-1" surfaceRef={surfaceRef} />
    )

    fireTouch(surface, 'touchstart', 100, 100)
    fireTouch(surface, 'touchmove', 100, 150) // moved > cancel threshold

    act(() => {
      vi.advanceTimersByTime(ARROW_GESTURE_LONG_PRESS_MS + 50)
    })

    expect(screen.queryByTestId('terminal-arrow-gesture-pad')).toBeNull()
    expect(writeTerminalInput).not.toHaveBeenCalled()

    surface.remove()
  })

  it('repeats slowly at gear 0 so one step is deliberate', () => {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const surfaceRef = { current: surface }

    render(
      <TerminalArrowGesture terminalId="term-1" surfaceRef={surfaceRef} />
    )

    fireTouch(surface, 'touchstart', 100, 100)
    act(() => {
      vi.advanceTimersByTime(ARROW_GESTURE_LONG_PRESS_MS)
    })

    // Short pull (~35px) → gear 0
    act(() => {
      fireTouch(surface, 'touchmove', 100, 65)
    })

    expect(writeTerminalInput).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('terminal-arrow-gesture-pad')).toHaveAttribute(
      'data-gear',
      '0'
    )
    expect(screen.getByTestId('terminal-arrow-gear-meter')).toHaveAttribute(
      'data-gear',
      '0'
    )

    // Gear 0 first-repeat delay is 650ms — still one key before that.
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(writeTerminalInput).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(writeTerminalInput.mock.calls.length).toBeGreaterThan(1)

    act(() => {
      fireTouch(surface, 'touchend', 100, 65)
    })

    surface.remove()
  })

  it('shows higher gear indicators when pulled farther', () => {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const surfaceRef = { current: surface }

    render(
      <TerminalArrowGesture terminalId="term-1" surfaceRef={surfaceRef} />
    )

    fireTouch(surface, 'touchstart', 100, 100)
    act(() => {
      vi.advanceTimersByTime(ARROW_GESTURE_LONG_PRESS_MS)
    })

    // Far pull → gear 2
    act(() => {
      fireTouch(surface, 'touchmove', 100, -40)
    })

    const pad = screen.getByTestId('terminal-arrow-gesture-pad')
    expect(pad).toHaveAttribute('data-gear', '2')
    expect(pad).toHaveAttribute('data-direction', 'up')
    expect(screen.getByTestId('terminal-arrow-active-up')).toHaveAttribute(
      'data-gear',
      '2'
    )
    expect(screen.getByTestId('terminal-arrow-gear-meter')).toHaveAttribute(
      'data-gear',
      '2'
    )

    act(() => {
      fireTouch(surface, 'touchend', 100, -40)
    })

    surface.remove()
  })

  it('sends left/right for horizontal drags', () => {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const surfaceRef = { current: surface }

    render(
      <TerminalArrowGesture terminalId="term-1" surfaceRef={surfaceRef} />
    )

    fireTouch(surface, 'touchstart', 100, 100)
    act(() => {
      vi.advanceTimersByTime(ARROW_GESTURE_LONG_PRESS_MS)
    })

    act(() => {
      fireTouch(surface, 'touchmove', 160, 100)
    })
    expect(writeTerminalInput).toHaveBeenLastCalledWith('term-1', '\x1b[C')

    act(() => {
      fireTouch(surface, 'touchmove', 40, 100)
    })
    expect(writeTerminalInput).toHaveBeenLastCalledWith('term-1', '\x1b[D')

    act(() => {
      fireTouch(surface, 'touchend', 40, 100)
    })

    surface.remove()
  })
})
