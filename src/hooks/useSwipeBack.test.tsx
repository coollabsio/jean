/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSwipeBack } from './useSwipeBack'

function TouchProbe({
  onSwipeBack,
  enabled = true,
  animateToEnd = true,
  edgeWidth = 24,
  threshold = 0.35,
  edge = 'left',
  visualFeedback,
}: {
  onSwipeBack: () => void
  enabled?: boolean
  animateToEnd?: boolean
  edgeWidth?: number
  threshold?: number
  edge?: 'left' | 'right'
  visualFeedback?: boolean
}) {
  const { containerRef, translateX, isSwiping } = useSwipeBack({
    onSwipeBack,
    enabled,
    animateToEnd,
    edgeWidth,
    threshold,
    edge,
    visualFeedback,
  })
  return (
    <div
      ref={containerRef}
      data-testid="swipe-target"
      data-translate={translateX}
      data-swiping={isSwiping ? 'true' : 'false'}
      style={{ width: 400, height: 600 }}
    />
  )
}

function fireTouch(
  el: Element,
  type: 'touchstart' | 'touchmove' | 'touchend',
  clientX: number,
  clientY = 100
) {
  const touch = {
    clientX,
    clientY,
    identifier: 0,
    pageX: clientX,
    pageY: clientY,
    screenX: clientX,
    screenY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
    target: el,
  } as unknown as Touch

  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === 'touchend' ? [] : [touch],
    targetTouches: type === 'touchend' ? [] : [touch],
    changedTouches: [touch],
  })
  el.dispatchEvent(event)
}

describe('useSwipeBack', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onSwipeBack after edge swipe right with animateToEnd', () => {
    const onSwipeBack = vi.fn()
    const { getByTestId } = render(<TouchProbe onSwipeBack={onSwipeBack} />)
    const el = getByTestId('swipe-target')

    // offsetWidth for threshold math
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true })

    act(() => {
      fireTouch(el, 'touchstart', 10)
      fireTouch(el, 'touchmove', 200)
      fireTouch(el, 'touchend', 200)
    })

    expect(onSwipeBack).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(onSwipeBack).toHaveBeenCalledTimes(1)
  })

  it('fires onSwipeBack immediately when animateToEnd is false', () => {
    const onSwipeBack = vi.fn()
    const { getByTestId } = render(
      <TouchProbe onSwipeBack={onSwipeBack} animateToEnd={false} />
    )
    const el = getByTestId('swipe-target')
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true })

    act(() => {
      fireTouch(el, 'touchstart', 8)
      fireTouch(el, 'touchmove', 180)
      fireTouch(el, 'touchend', 180)
    })

    expect(onSwipeBack).toHaveBeenCalledTimes(1)
  })

  it('resets finger-tracked feedback after opening an overlay', () => {
    const onSwipeBack = vi.fn()
    const { getByTestId } = render(
      <TouchProbe
        onSwipeBack={onSwipeBack}
        animateToEnd={false}
        visualFeedback
      />
    )
    const el = getByTestId('swipe-target')
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true })

    act(() => {
      fireTouch(el, 'touchstart', 8)
      fireTouch(el, 'touchmove', 180)
    })
    expect(el).toHaveAttribute('data-translate', '172')

    act(() => {
      fireTouch(el, 'touchend', 180)
    })

    expect(onSwipeBack).toHaveBeenCalledTimes(1)
    expect(el).toHaveAttribute('data-translate', '0')
    expect(el).toHaveAttribute('data-swiping', 'false')
  })

  it('does not fire when swipe starts outside the edge zone', () => {
    const onSwipeBack = vi.fn()
    const { getByTestId } = render(
      <TouchProbe onSwipeBack={onSwipeBack} edgeWidth={24} />
    )
    const el = getByTestId('swipe-target')
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true })

    act(() => {
      fireTouch(el, 'touchstart', 80)
      fireTouch(el, 'touchmove', 250)
      fireTouch(el, 'touchend', 250)
    })

    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(onSwipeBack).not.toHaveBeenCalled()
  })

  it('does not fire when enabled is false', () => {
    const onSwipeBack = vi.fn()
    const { getByTestId } = render(
      <TouchProbe onSwipeBack={onSwipeBack} enabled={false} />
    )
    const el = getByTestId('swipe-target')
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true })

    act(() => {
      fireTouch(el, 'touchstart', 8)
      fireTouch(el, 'touchmove', 200)
      fireTouch(el, 'touchend', 200)
    })

    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(onSwipeBack).not.toHaveBeenCalled()
  })

  it('cancels incomplete short swipes', () => {
    const onSwipeBack = vi.fn()
    const { getByTestId } = render(<TouchProbe onSwipeBack={onSwipeBack} />)
    const el = getByTestId('swipe-target')
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true })

    act(() => {
      fireTouch(el, 'touchstart', 8)
      fireTouch(el, 'touchmove', 40) // well under 0.35 * 400
      fireTouch(el, 'touchend', 40)
    })

    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(onSwipeBack).not.toHaveBeenCalled()
  })

  it('stops propagation so nested parent swipe handlers do not also fire', () => {
    const onInner = vi.fn()
    const onOuter = vi.fn()

    function Nested() {
      const { containerRef: innerRef } = useSwipeBack({
        onSwipeBack: onInner,
        animateToEnd: false,
      })
      const { containerRef: outerRef } = useSwipeBack({
        onSwipeBack: onOuter,
        animateToEnd: false,
      })
      return (
        <div
          ref={outerRef}
          data-testid="outer"
          style={{ width: 400, height: 600 }}
        >
          <div
            ref={innerRef}
            data-testid="inner"
            style={{ width: 400, height: 600 }}
          />
        </div>
      )
    }

    const { getByTestId } = render(<Nested />)
    const inner = getByTestId('inner')
    const outer = getByTestId('outer')
    Object.defineProperty(inner, 'offsetWidth', {
      value: 400,
      configurable: true,
    })
    Object.defineProperty(outer, 'offsetWidth', {
      value: 400,
      configurable: true,
    })

    act(() => {
      fireTouch(inner, 'touchstart', 8)
      fireTouch(inner, 'touchmove', 200)
      fireTouch(inner, 'touchend', 200)
    })

    expect(onInner).toHaveBeenCalledTimes(1)
    expect(onOuter).not.toHaveBeenCalled()
  })

  it('fires on right-edge swipe left when edge is right', () => {
    const onSwipeBack = vi.fn()
    const { getByTestId } = render(
      <TouchProbe onSwipeBack={onSwipeBack} animateToEnd={false} edge="right" />
    )
    const el = getByTestId('swipe-target')
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true })

    act(() => {
      // Start near right edge (400 - 8 = 392), swipe left to 200
      fireTouch(el, 'touchstart', 392)
      fireTouch(el, 'touchmove', 200)
      fireTouch(el, 'touchend', 200)
    })

    expect(onSwipeBack).toHaveBeenCalledTimes(1)
  })

  it('does not fire right-edge gesture when starting outside right edge zone', () => {
    const onSwipeBack = vi.fn()
    const { getByTestId } = render(
      <TouchProbe
        onSwipeBack={onSwipeBack}
        animateToEnd={false}
        edge="right"
        edgeWidth={24}
      />
    )
    const el = getByTestId('swipe-target')
    Object.defineProperty(el, 'offsetWidth', { value: 400, configurable: true })

    act(() => {
      fireTouch(el, 'touchstart', 200)
      fireTouch(el, 'touchmove', 50)
      fireTouch(el, 'touchend', 50)
    })

    expect(onSwipeBack).not.toHaveBeenCalled()
  })
})
