import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { Popover, PopoverAnchor, PopoverContent } from './popover'

function PreviewFromPopover({ childPopover }: { childPopover?: boolean }) {
  const [open, setOpen] = useState(true)
  return (
    <Popover open>
      <PopoverAnchor />
      <PopoverContent>List</PopoverContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Preview</DialogTitle>
          <button type="button">Inside</button>
          {childPopover && (
            <Popover open>
              <PopoverAnchor />
              <PopoverContent>Child</PopoverContent>
            </Popover>
          )}
        </DialogContent>
      </Dialog>
    </Popover>
  )
}

async function pressEscape() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Inside' }), {
    key: 'Escape',
  })
  await act(() => Promise.resolve())
}

describe('DialogContent ESC', () => {
  it('closes when the popover that opened it is still open', async () => {
    render(<PreviewFromPopover />)
    await pressEscape()
    expect(screen.queryByText('Preview')).not.toBeInTheDocument()
    expect(screen.getByText('List')).toBeInTheDocument()
  })

  it('stays open while a child popover is open', async () => {
    render(<PreviewFromPopover childPopover />)
    await pressEscape()
    expect(screen.getByText('Preview')).toBeInTheDocument()
  })
})
