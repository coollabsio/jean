import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { trackTerminalKeyboardMode } from '@/lib/terminal-instances'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import {
  formatMagicPromptForPty,
  routeCurrentSessionMagicPrompt,
} from './magic-prompt-pty'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  isTransportConnected: () => true,
  listen: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

describe('formatMagicPromptForPty', () => {
  it('wraps multi-line prompts in bracketed paste and submits with Enter', () => {
    expect(formatMagicPromptForPty('line 1\nline 2', true)).toBe(
      '\u001b[200~line 1\rline 2\u001b[201~\r'
    )
  })

  it('writes the prompt and Enter when bracketed paste is off', () => {
    expect(formatMagicPromptForPty('fix the tests', false)).toBe(
      'fix the tests\r'
    )
  })
})

describe('routeCurrentSessionMagicPrompt', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
    vi.mocked(toast.error).mockClear()
    useUIStore.setState({
      sessionPrimarySurface: {},
      sessionTerminalIds: {},
    })
    useTerminalStore.setState({ runningTerminals: new Set() })
  })

  it('writes the rendered prompt into the running native CLI pty', () => {
    useUIStore.getState().setSessionPrimarySurface('session-1', 'terminal')
    useUIStore.getState().setSessionTerminalId('session-1', 'term-1')
    useTerminalStore.getState().setTerminalRunning('term-1', true)
    trackTerminalKeyboardMode('term-1', '\u001b[?2004h')

    const prompt = 'Investigate the loaded GitHub issue (#42)'
    expect(routeCurrentSessionMagicPrompt('session-1', prompt)).toBe('pty')

    expect(invoke).toHaveBeenCalledWith('terminal_write', {
      terminalId: 'term-1',
      data: `\u001b[200~${prompt}\u001b[201~\r`,
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('leaves chat sessions on the unchanged path', () => {
    useUIStore.getState().setSessionPrimarySurface('session-1', 'chat')
    useUIStore.getState().setSessionTerminalId('session-1', 'term-1')
    useTerminalStore.getState().setTerminalRunning('term-1', true)

    expect(
      routeCurrentSessionMagicPrompt('session-1', 'Investigate issue #7')
    ).toBe('chat')
    expect(invoke).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts and does not write when the native CLI pty has exited', () => {
    useUIStore.getState().setSessionPrimarySurface('session-1', 'terminal')
    useUIStore.getState().setSessionTerminalId('session-1', 'term-1')
    useTerminalStore.getState().setTerminalRunning('term-1', false)

    expect(routeCurrentSessionMagicPrompt('session-1', 'do the thing')).toBe(
      'exited'
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('exited'))
  })

  it('toasts when a terminal session has no pty id', () => {
    useUIStore.getState().setSessionPrimarySurface('session-1', 'terminal')

    expect(routeCurrentSessionMagicPrompt('session-1', 'do the thing')).toBe(
      'exited'
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })
})
