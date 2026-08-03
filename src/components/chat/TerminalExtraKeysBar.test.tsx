import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClipboardModule from '@/lib/clipboard'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { TerminalExtraKeysBar } from './TerminalExtraKeysBar'

const {
  writeTerminalInput,
  focusTerminal,
  getTerminalSelection,
  copyToClipboard,
  readFromClipboard,
  toastSuccess,
  toastError,
} = vi.hoisted(() => ({
  writeTerminalInput: vi.fn(),
  focusTerminal: vi.fn(),
  getTerminalSelection: vi.fn(() => ''),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  readFromClipboard: vi.fn().mockResolvedValue(''),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/terminal-instances', () => ({
  writeTerminalInput,
  focusTerminal,
  getTerminalSelection,
}))

vi.mock('@/lib/clipboard', async () => {
  const actual = await vi.importActual<typeof ClipboardModule>('@/lib/clipboard')
  return {
    ...actual,
    copyToClipboard,
    readFromClipboard,
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}))

describe('TerminalExtraKeysBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getTerminalSelection.mockReturnValue('')
    readFromClipboard.mockResolvedValue('')
    copyToClipboard.mockResolvedValue(undefined)
  })

  it('renders Termius-style special keys including clipboard actions', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    expect(screen.getByTestId('terminal-extra-keys-bar')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Paste from clipboard' })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Copy selected terminal text' })
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send esc' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send tab' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Toggle ctrl' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send ^C' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send ^Z' })).toBeTruthy()
  })

  it('writes control sequences on one-shot key press', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Send ^C' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x03')
    expect(focusTerminal).toHaveBeenCalledWith('term-1')

    fireEvent.click(screen.getByRole('button', { name: 'Send esc' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x1b')

    fireEvent.click(screen.getByRole('button', { name: 'Send tab' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\t')
  })

  it('toggles sticky ctrl and applies it to the next keystroke', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    const ctrl = screen.getByRole('button', { name: 'Toggle ctrl' })
    fireEvent.click(ctrl)
    expect(ctrl).toHaveAttribute('aria-pressed', 'true')
    expect(writeTerminalInput).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'c' })
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x03')
    expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggles sticky alt and prefixes the next keystroke with ESC', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle alt' }))
    fireEvent.keyDown(window, { key: 'b' })
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '\x1bb')
  })

  it('writes printable symbols from the bar', () => {
    render(<TerminalExtraKeysBar terminalId="term-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Send /' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '/')

    fireEvent.click(screen.getByRole('button', { name: 'Send |' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '|')

    fireEvent.click(screen.getByRole('button', { name: 'Send ~' }))
    expect(writeTerminalInput).toHaveBeenCalledWith('term-1', '~')
  })

  it('copies selected terminal text to the clipboard', async () => {
    getTerminalSelection.mockReturnValue('selected line\n')

    render(<TerminalExtraKeysBar terminalId="term-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy selected terminal text' })
    )

    await waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledWith('selected line')
      expect(toastSuccess).toHaveBeenCalledWith('Copied')
      expect(focusTerminal).toHaveBeenCalledWith('term-1')
    })
  })

  it('shows an error when copy is pressed with no selection', async () => {
    getTerminalSelection.mockReturnValue('   ')

    render(<TerminalExtraKeysBar terminalId="term-1" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy selected terminal text' })
    )

    await waitFor(() => {
      expect(copyToClipboard).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith('No text selected')
    })
  })

  it('pastes clipboard text into the terminal', async () => {
    readFromClipboard.mockResolvedValue('hello\r\nworld\r')

    render(<TerminalExtraKeysBar terminalId="term-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Paste from clipboard' }))

    await waitFor(() => {
      expect(writeTerminalInput).toHaveBeenCalledWith('term-1', 'hello\nworld\n')
      expect(focusTerminal).toHaveBeenCalledWith('term-1')
    })
  })

  it('shows an error when paste clipboard is empty', async () => {
    readFromClipboard.mockResolvedValue('')

    render(<TerminalExtraKeysBar terminalId="term-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Paste from clipboard' }))

    await waitFor(() => {
      expect(writeTerminalInput).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith('Clipboard is empty')
    })
  })
})
