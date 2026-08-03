import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { invoke } from '@/lib/transport'
import { SingleTerminalView, TerminalView } from './TerminalView'

const { mockInvoke, initTerminal, fit, focus, isNativeApp } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  initTerminal: vi.fn().mockResolvedValue(undefined),
  fit: vi.fn(),
  focus: vi.fn(),
  isNativeApp: vi.fn(() => false),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
    initTerminal,
    fit,
    focus,
  }),
}))

vi.mock('@/hooks/useTerminalThemeSync', () => ({
  useTerminalBackgroundColor: () => '#000000',
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => isNativeApp(),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/terminal-instances', () => ({
  disposeTerminal: vi.fn(),
  disposePanelWorktreeTerminals: vi.fn(),
  writeTerminalInput: vi.fn(),
  focusTerminal: vi.fn(),
}))

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
}

function setupBrowserMocks() {
  window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
  window.requestAnimationFrame =
    window.requestAnimationFrame ??
    ((callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
}

describe('SingleTerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    setupBrowserMocks()
    useTerminalStore.setState({
      terminals: {
        'worktree-1': [
          {
            id: 'terminal-1',
            worktreeId: 'worktree-1',
            command: 'codex',
            commandArgs: [],
            label: 'Codex',
            kind: 'session',
          },
          {
            id: 'terminal-2',
            worktreeId: 'worktree-1',
            command: 'claude',
            commandArgs: [],
            label: 'Claude',
            kind: 'session',
          },
        ],
      },
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: false,
      terminalPanelOpen: {},
      modalTerminalOpen: {},
    })
  })

  it('does not initialize inactive full-screen terminal sessions', () => {
    render(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive={false}
      />
    )

    expect(initTerminal).not.toHaveBeenCalled()
  })

  it('initializes when the full-screen terminal becomes active', async () => {
    const { rerender } = render(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive={false}
      />
    )

    rerender(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive
      />
    )

    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(1))
  })

  it('initializes the new terminal when switching full-screen session terminals', async () => {
    const { rerender } = render(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive
      />
    )

    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(1))

    rerender(
      <SingleTerminalView
        terminalId="terminal-2"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive
      />
    )

    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(2))
  })

  it('shows the special-keys bar on web access', async () => {
    isNativeApp.mockReturnValue(false)

    render(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('terminal-extra-keys-bar')).toBeTruthy()
    )
  })

  it('hides the special-keys bar on native desktop', () => {
    isNativeApp.mockReturnValue(true)

    render(
      <SingleTerminalView
        terminalId="terminal-1"
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        isActive
      />
    )

    expect(screen.queryByTestId('terminal-extra-keys-bar')).toBeNull()
  })
})

describe('TerminalView auto-create race condition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    setupBrowserMocks()
    useTerminalStore.setState({
      terminals: {},
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: false,
      terminalPanelOpen: {},
      modalTerminalOpen: {},
    })
    useUIStore.setState({ uiStateInitialized: false })
  })

  it('does not auto-create a terminal before uiStateInitialized is true', async () => {
    render(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)

    // Yield a few microtasks + timers so useEffects have run.
    await waitFor(() => {
      expect(
        useTerminalStore.getState().terminals['worktree-1']
      ).toBeUndefined()
    })

    expect(
      useTerminalStore.getState().terminals['worktree-1'] ?? []
    ).toHaveLength(0)
  })

  it('auto-creates a default shell after uiStateInitialized flips to true with no restored terminals', async () => {
    const { rerender } = render(
      <TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />
    )

    // Sanity: nothing created yet.
    expect(
      useTerminalStore.getState().terminals['worktree-1'] ?? []
    ).toHaveLength(0)

    // Simulate useUIStatePersistence completing hydration.
    act(() => {
      useUIStore.setState({ uiStateInitialized: true })
    })
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)

    await waitFor(() => {
      const list = useTerminalStore.getState().terminals['worktree-1'] ?? []
      expect(list).toHaveLength(1)
    })

    const created = useTerminalStore.getState().terminals['worktree-1']?.[0]
    expect(created?.command).toBeNull()
    expect(created?.kind ?? 'panel').toBe('panel')
  })

  it('does not auto-create when restore already populated panel terminals', async () => {
    // Pre-populate the store as if restore had already completed.
    useTerminalStore.setState({
      terminals: {
        'worktree-1': [
          {
            id: 'persisted-1',
            worktreeId: 'worktree-1',
            command: null,
            commandArgs: null,
            label: 'Shell',
            kind: 'panel',
          },
        ],
      },
      activeTerminalIds: { 'worktree-1': 'persisted-1' },
    })
    useUIStore.setState({ uiStateInitialized: true })

    render(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)

    await waitFor(() => {
      expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(
        1
      )
    })

    // The persisted terminal must still be the only one — no phantom shell.
    const ids = (useTerminalStore.getState().terminals['worktree-1'] ?? []).map(
      t => t.id
    )
    expect(ids).toEqual(['persisted-1'])
  })

  it('does not auto-create a second terminal on rerender after first auto-create', async () => {
    useUIStore.setState({ uiStateInitialized: true })

    const { rerender } = render(
      <TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />
    )

    await waitFor(() => {
      expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(
        1
      )
    })

    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)

    expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(1)
  })

  // REGRESSION GUARD for the original "lost session on refresh" bug.
  //
  // Old behavior: TerminalView mounted before useUIStatePersistence finished
  // its async hydrate. addTerminal fired synchronously, then
  // restoreTerminalRuntimeState overwrote `terminals`, leaving the freshly
  // generated phantom ID in the backend's TERMINAL_SESSIONS registry forever.
  //
  // Asserted invariants after the fix:
  //   1. While uiStateInitialized is false, no addTerminal side effect runs.
  //   2. The first addTerminal only fires AFTER uiStateInitialized flips.
  //   3. No second addTerminal fires from this TerminalView instance even on
  //      repeated rerenders (mirrors React strict-mode + worktree-switch churn).
  //   4. Crucially: if restoreTerminalRuntimeState populates the store BEFORE
  //      uiStateInitialized flips (the happy path), TerminalView never adds a
  //      phantom — the persisted IDs survive verbatim.
  it('regression: full refresh sequence produces no phantom terminal id even with churn', async () => {
    // ── Step 1: empty store + hydrate in flight ──────────────────────────
    expect(useTerminalStore.getState().terminals).toEqual({})

    const { rerender } = render(
      <TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />
    )

    // Multiple rerenders while hydrate is in flight (simulates React strict
    // mode + parent re-renders from TanStack Query resolving).
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)

    // Nothing should have been created yet.
    expect(useTerminalStore.getState().terminals).toEqual({})

    // ── Step 2: hydrate completes FIRST with restored terminals ─────────
    // This is the critical ordering: restoreTerminalRuntimeState runs in a
    // useEffect that sets state synchronously via `setState`, BEFORE
    // `setIsInitialized(true)` resolves. The setIsInitialized flip is what
    // unblocks TerminalView's auto-create.
    act(() => {
      useTerminalStore.setState({
        terminals: {
          'worktree-1': [
            {
              id: 'live-pty-1',
              worktreeId: 'worktree-1',
              command: 'pnpm dev',
              commandArgs: null,
              label: 'pnpm dev',
              kind: 'panel',
            },
            {
              id: 'live-pty-2',
              worktreeId: 'worktree-1',
              command: null,
              commandArgs: null,
              label: 'Shell',
              kind: 'panel',
            },
          ],
        },
        activeTerminalIds: { 'worktree-1': 'live-pty-1' },
        runningTerminals: new Set(['live-pty-1', 'live-pty-2']),
      })
      useUIStore.setState({ uiStateInitialized: true })
    })
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)

    // ── Step 3: only the persisted IDs survive, no phantom added ────────
    const ids = (useTerminalStore.getState().terminals['worktree-1'] ?? []).map(
      t => t.id
    )
    expect(ids).toEqual(['live-pty-1', 'live-pty-2'])

    // No third auto-created terminal that would have spawned an orphan PTY.
    expect(ids).toHaveLength(2)
  })

  it('regression: when hydrate is empty AND uiStateInitialized flips, exactly one default shell is created (not zero, not two)', async () => {
    const { rerender } = render(
      <TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />
    )

    // Hydrate completes with no terminals to restore (e.g., all PTYs dead).
    act(() => {
      useUIStore.setState({ uiStateInitialized: true })
    })
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)
    rerender(<TerminalView worktreeId="worktree-1" worktreePath="/repo/wt-1" />)

    await waitFor(() => {
      expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(
        1
      )
    })

    const created = useTerminalStore.getState().terminals['worktree-1']?.[0]
    expect(created?.command).toBeNull()
    expect(created?.kind ?? 'panel').toBe('panel')
  })
})

describe('TerminalView tab middle-click', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    setupBrowserMocks()
    useUIStore.setState({ uiStateInitialized: true })
    useTerminalStore.setState({
      terminals: {
        'worktree-1': [
          {
            id: 'terminal-1',
            worktreeId: 'worktree-1',
            command: 'bash',
            commandArgs: [],
            label: 'Terminal 1',
            kind: 'panel',
          },
          {
            id: 'terminal-2',
            worktreeId: 'worktree-1',
            command: 'bash',
            commandArgs: [],
            label: 'Terminal 2',
            kind: 'panel',
          },
        ],
      },
      activeTerminalIds: { 'worktree-1': 'terminal-1' },
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: true,
      terminalPanelOpen: { 'worktree-1': true },
      modalTerminalOpen: {},
    })
  })

  const renderTabBar = () =>
    render(
      <TerminalView worktreeId="worktree-1" worktreePath="/tmp/worktree-1" />
    )

  const getTab = (label: string) => {
    // Tab chrome is a clickable div (sibling of the close button) so nested
    // interactive a11y rules are satisfied — not a single outer <button>.
    const labelEl = screen.getByText(label)
    const tab =
      labelEl.closest('[draggable="true"]') ??
      labelEl.closest('.cursor-pointer') ??
      labelEl.parentElement
    if (!tab) throw new Error(`Tab for "${label}" not found`)
    return tab
  }

  it('closes the tab on middle-click (button 1)', async () => {
    renderTabBar()

    fireEvent(
      getTab('Terminal 1'),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    )

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('stop_terminal', {
        terminalId: 'terminal-1',
      })
    )
    await waitFor(() => {
      const remaining =
        useTerminalStore.getState().terminals['worktree-1'] ?? []
      expect(remaining.some(t => t.id === 'terminal-1')).toBe(false)
      expect(remaining.some(t => t.id === 'terminal-2')).toBe(true)
    })
  })

  it('does not close on right-click (button 2)', () => {
    renderTabBar()

    // button 2 returns synchronously before any async work, so the assertion
    // can run immediately after dispatching the event.
    fireEvent(
      getTab('Terminal 1'),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 })
    )

    expect(invoke).not.toHaveBeenCalledWith('stop_terminal', {
      terminalId: 'terminal-1',
    })
    const remaining = useTerminalStore.getState().terminals['worktree-1'] ?? []
    expect(remaining.some(t => t.id === 'terminal-1')).toBe(true)
  })
})
