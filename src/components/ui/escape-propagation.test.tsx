import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from './alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from './context-menu'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from './dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from './select'
import { Sheet, SheetContent, SheetTitle } from './sheet'

// Window-level ESC handlers (e.g. SessionChatModal) must not see an ESC that
// a Radix layer already used to close itself — otherwise one ESC closes both
// the layer and the session/worktree view underneath.
describe('ESC does not bubble past open overlay layers', () => {
  const windowEsc = vi.fn()
  const onWindowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') windowEsc()
  }

  beforeEach(() => {
    windowEsc.mockClear()
    window.addEventListener('keydown', onWindowKeyDown)
  })
  afterEach(() => window.removeEventListener('keydown', onWindowKeyDown))

  const pressEscape = () =>
    act(() => {
      const target = document.activeElement ?? document.body
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })

  const cases: [string, ReactNode][] = [
    [
      'Dialog',
      <Dialog open key="d">
        <DialogContent>
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    ],
    [
      'AlertDialog',
      <AlertDialog open key="a">
        <AlertDialogContent>
          <AlertDialogTitle>t</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    ],
    [
      'Sheet',
      <Sheet open key="s">
        <SheetContent>
          <SheetTitle>t</SheetTitle>
        </SheetContent>
      </Sheet>,
    ],
    [
      'Popover',
      <Popover open key="p">
        <PopoverTrigger>trigger</PopoverTrigger>
        <PopoverContent>content</PopoverContent>
      </Popover>,
    ],
    [
      'DropdownMenu',
      <DropdownMenu open key="m">
        <DropdownMenuContent>
          <DropdownMenuItem>item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    ],
    [
      'Select',
      <Select open value="a" key="sel">
        <SelectTrigger>trigger</SelectTrigger>
        <SelectContent>
          <SelectItem value="a">a</SelectItem>
        </SelectContent>
      </Select>,
    ],
  ]

  it.each(cases)('%s', (_name, ui) => {
    render(ui)
    pressEscape()
    expect(windowEsc).not.toHaveBeenCalled()
  })

  it('ContextMenu', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>area</ContextMenuTrigger>
        <ContextMenuContent>menu</ContextMenuContent>
      </ContextMenu>
    )
    act(() => {
      screen.getByText('area').dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: 1,
          clientY: 1,
        })
      )
    })
    expect(screen.getByText('menu')).toBeTruthy()
    pressEscape()
    expect(windowEsc).not.toHaveBeenCalled()
  })

  it('still reaches window when no layer is open', () => {
    render(<div>plain</div>)
    pressEscape()
    expect(windowEsc).toHaveBeenCalledTimes(1)
  })
})
