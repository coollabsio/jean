import { describe, expect, it, vi } from 'vitest'
import type { MouseEvent } from 'react'
import { middleClickClose } from './middle-click'

function auxClickEvent(
  target: Element,
  currentTarget: Element,
  button: number
): MouseEvent {
  return {
    button,
    target,
    currentTarget,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent
}

describe('middleClickClose', () => {
  it('closes on a middle-click that lands on a non-interactive descendant', () => {
    const row = document.createElement('div')
    const label = document.createElement('span')
    row.appendChild(label)

    const onClose = vi.fn()
    middleClickClose(onClose).onAuxClick(auxClickEvent(label, row, 1))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores a middle-click that originates on an interactive descendant', () => {
    // e.g. the expand chevron / pull badge nested inside a worktree row.
    const row = document.createElement('div')
    const chevron = document.createElement('button')
    row.appendChild(chevron)

    const onClose = vi.fn()
    middleClickClose(onClose).onAuxClick(auxClickEvent(chevron, row, 1))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes when the element it is spread on is itself a <button> (terminal tab)', () => {
    const tab = document.createElement('button')
    const inner = document.createElement('span')
    tab.appendChild(inner)

    const onClose = vi.fn()
    // Clicking the tab body: closest('button') resolves to the tab === currentTarget.
    middleClickClose(onClose).onAuxClick(auxClickEvent(inner, tab, 1))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a middle-click on a role="tab" label button inside the tab', () => {
    const tab = document.createElement('div')
    const label = document.createElement('button')
    label.setAttribute('role', 'tab')
    tab.appendChild(label)

    const onClose = vi.fn()
    middleClickClose(onClose).onAuxClick(auxClickEvent(label, tab, 1))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on right-click (button 2)', () => {
    const row = document.createElement('div')
    const label = document.createElement('span')
    row.appendChild(label)

    const onClose = vi.fn()
    middleClickClose(onClose).onAuxClick(auxClickEvent(label, row, 2))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('preventDefault on middle mousedown suppresses autoscroll', () => {
    const preventDefault = vi.fn()
    const onClose = vi.fn()
    middleClickClose(onClose).onMouseDown({
      button: 1,
      preventDefault,
    } as unknown as MouseEvent)

    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})
