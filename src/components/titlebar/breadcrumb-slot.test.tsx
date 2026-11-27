import { act, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { describe, expect, it } from 'vitest'
import { titleBarSlotRef, useTitleBarSlot } from './breadcrumb-slot'

const SLOT = 'test-slot'

function Slot() {
  return <div data-testid="slot" ref={titleBarSlotRef(SLOT)} />
}

function View({ enabled = true }: { enabled?: boolean }) {
  const slot = useTitleBarSlot(SLOT, enabled)
  const content = <span>content</span>
  return slot ? (
    createPortal(content, slot)
  ) : (
    <div data-testid="inline">{content}</div>
  )
}

describe('useTitleBarSlot', () => {
  it('portals into a slot that mounts after the view and falls back when it unmounts', () => {
    const { rerender } = render(<View />)
    expect(screen.getByTestId('inline')).toHaveTextContent('content')

    act(() =>
      rerender(
        <>
          <Slot />
          <View />
        </>
      )
    )
    expect(screen.getByTestId('slot')).toHaveTextContent('content')
    expect(screen.queryByTestId('inline')).toBeNull()

    act(() => rerender(<View />))
    expect(screen.getByTestId('inline')).toHaveTextContent('content')
  })

  it('returns null when disabled', () => {
    render(
      <>
        <Slot />
        <View enabled={false} />
      </>
    )
    expect(screen.getByTestId('slot')).toBeEmptyDOMElement()
    expect(screen.getByTestId('inline')).toHaveTextContent('content')
  })
})
