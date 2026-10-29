import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ZoomableImage } from './zoomable-image'

// Container is 200x200 at the origin, so its center is (100, 100).
function setup() {
  render(
    <ZoomableImage>
      <img src="shot.png" alt="shot" />
    </ZoomableImage>
  )
  const container = screen.getByTestId('zoomable-image')
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect
  const content = container.firstElementChild as HTMLElement
  return { container, transform: () => content.style.transform }
}

function pointer(
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  el: HTMLElement,
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp = 0
) {
  const event = new Event(type.toLowerCase(), {
    bubbles: true,
  })
  Object.assign(event, { pointerId, clientX, clientY, pointerType: 'touch' })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  fireEvent(el, event)
}

describe('ZoomableImage', () => {
  it('zooms around the pinch center and resets when pinched back out', () => {
    const { container, transform } = setup()

    pointer('pointerDown', container, 1, 90, 100)
    pointer('pointerDown', container, 2, 110, 100)
    pointer('pointerMove', container, 1, 80, 100)
    pointer('pointerMove', container, 2, 120, 100)
    expect(transform()).toBe('translate(0px, 0px) scale(2)')

    pointer('pointerMove', container, 1, 95, 100)
    pointer('pointerMove', container, 2, 105, 100)
    pointer('pointerUp', container, 1, 95, 100)
    pointer('pointerUp', container, 2, 105, 100)
    expect(transform()).toBe('translate(0px, 0px) scale(1)')
  })

  it('pans with one finger only while zoomed', () => {
    const { container, transform } = setup()

    pointer('pointerDown', container, 1, 100, 100)
    pointer('pointerMove', container, 1, 150, 100)
    pointer('pointerUp', container, 1, 150, 100)
    expect(transform()).toBe('translate(0px, 0px) scale(1)')

    pointer('pointerDown', container, 1, 90, 100)
    pointer('pointerDown', container, 2, 110, 100)
    pointer('pointerMove', container, 2, 130, 100)
    pointer('pointerUp', container, 2, 130, 100)
    // The content point under the fingers follows their midpoint (0 → 10px).
    expect(transform()).toBe('translate(10px, 0px) scale(2)')

    pointer('pointerMove', container, 1, 100, 120)
    pointer('pointerUp', container, 1, 100, 120)
    expect(transform()).toBe('translate(20px, 20px) scale(2)')
  })

  it('toggles zoom on double tap', () => {
    const { container, transform } = setup()

    pointer('pointerDown', container, 1, 150, 100, 0)
    pointer('pointerUp', container, 1, 150, 100, 50)
    pointer('pointerDown', container, 1, 150, 100, 150)
    pointer('pointerUp', container, 1, 150, 100, 200)
    // Tap point (50px right of center) stays fixed: 50 - 50 * 2.5 = -75.
    expect(transform()).toBe('translate(-75px, 0px) scale(2.5)')

    pointer('pointerDown', container, 1, 150, 100, 1000)
    pointer('pointerUp', container, 1, 150, 100, 1050)
    pointer('pointerDown', container, 1, 150, 100, 1150)
    pointer('pointerUp', container, 1, 150, 100, 1200)
    expect(transform()).toBe('translate(0px, 0px) scale(1)')
  })
})
