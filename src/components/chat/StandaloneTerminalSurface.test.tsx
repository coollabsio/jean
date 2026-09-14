import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { StandaloneTerminalSurface } from './StandaloneTerminalSurface'

const {
  initTerminal,
  fit,
  focus,
  isNativeApp,
  readFromClipboard,
  writeTerminalInput,
} = vi.hoisted(() => ({
  initTerminal: vi.fn().mockResolvedValue(undefined),
  fit: vi.fn(),
  focus: vi.fn(),
  isNativeApp: vi.fn(() => false),
  readFromClipboard: vi.fn(),
  writeTerminalInput: vi.fn(),
}))

vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
    initTerminal,
    fit,
    focus,
  }),
}))

vi.mock('@/hooks/useTerminalThemeSync', () => ({
  useTerminalBackgroundColor: () => '#111111',
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => isNativeApp(),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/terminal-instances', () => ({
  writeTerminalInput,
  focusTerminal: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => ({
  readFromClipboard,
  normalizeClipboardForTerminal: (text: string) => text.replace(/\r\n?/g, '\n'),
}))

let mockContentRect = { width: 640, height: 360 }

class ResizeObserverMock {
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe = (target: Element) => {
    const { width, height } = mockContentRect
    this.callback(
      [
        {
          target,
          contentRect: {
            width,
            height,
            top: 0,
            left: 0,
            bottom: height,
            right: width,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    )
  }

  unobserve = vi.fn()
  disconnect = vi.fn()
}

describe('StandaloneTerminalSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockContentRect = { width: 640, height: 360 }
    isNativeApp.mockReturnValue(false)
    window.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver
  })

  it('shows the extra-keys bar and initializes the terminal on web access', async () => {
    render(
      <StandaloneTerminalSurface
        terminalId="login-term-1"
        command="claude"
        commandArgs={['login']}
        className="h-[300px]"
      />
    )

    expect(screen.getByTestId('standalone-terminal-surface')).toBeTruthy()
    expect(screen.getByTestId('terminal-extra-keys-bar')).toBeTruthy()

    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(1))
  })

  it('hides the special-keys bar on native desktop', () => {
    isNativeApp.mockReturnValue(true)

    render(
      <StandaloneTerminalSurface
        terminalId="login-term-2"
        command="claude"
        commandArgs={['login']}
      />
    )

    expect(screen.queryByTestId('terminal-extra-keys-bar')).toBeNull()
  })

  it('pastes clipboard text into native desktop login terminals', async () => {
    isNativeApp.mockReturnValue(true)
    readFromClipboard.mockResolvedValue('login-code\r\n')

    render(
      <StandaloneTerminalSurface
        terminalId="login-term-paste"
        command="claude"
        commandArgs={['login']}
      />
    )

    fireEvent.keyDown(screen.getByTestId('standalone-terminal-surface'), {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
    })

    await waitFor(() =>
      expect(writeTerminalInput).toHaveBeenCalledWith(
        'login-term-paste',
        'login-code\n'
      )
    )
  })

  it('does not start the login PTY while the container is still tiny (issue #624)', async () => {
    mockContentRect = { width: 40, height: 20 }

    render(
      <StandaloneTerminalSurface
        terminalId="login-term-tiny"
        command="opencode"
        commandArgs={['auth', 'login']}
        className="h-[300px]"
      />
    )

    // ResizeObserver fired with sub-minimum size — must not spawn yet.
    await new Promise(r => setTimeout(r, 30))
    expect(initTerminal).not.toHaveBeenCalled()
  })
})
