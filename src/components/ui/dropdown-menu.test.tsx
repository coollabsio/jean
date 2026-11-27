import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from './dropdown-menu'

vi.mock('@/lib/viewport', () => ({
  MOBILE_BREAKPOINT: 768,
  isMobileViewport: () => true,
}))

describe('mobile dropdown bottom sheet', () => {
  it('a tap outside closes the sheet without clicking what is under it', async () => {
    const onBehindClick = vi.fn()
    const onOpenChange = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <DropdownMenu
          open={open}
          onOpenChange={next => {
            onOpenChange(next)
            setOpen(next)
          }}
        >
          <DropdownMenuContent>
            <DropdownMenuItem>item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
    render(
      <>
        <button onClick={onBehindClick}>behind</button>
        <Harness />
      </>
    )
    // Radix attaches its outside-pointerdown listener after a tick
    await act(() => new Promise(r => setTimeout(r, 0)))
    const behind = screen.getByText('behind')

    fireEvent.pointerDown(behind)
    fireEvent.mouseDown(behind)
    fireEvent.mouseUp(behind)
    fireEvent.click(behind)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onBehindClick).not.toHaveBeenCalled()

    // The guard ends with the dismissing gesture; the next tap works.
    fireEvent.pointerDown(behind)
    fireEvent.click(behind)
    expect(onBehindClick).toHaveBeenCalledTimes(1)
  })
})
