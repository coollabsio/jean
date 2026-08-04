import type { ReactNode } from 'react'
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

// Native-desktop / viewport gating is toggled per test.
const { isNativeAppMock, isMobileMock } = vi.hoisted(() => ({
  isNativeAppMock: vi.fn(() => true),
  isMobileMock: vi.fn(() => false),
}))

vi.mock('@/lib/environment', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, isNativeApp: () => isNativeAppMock() }
})

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobileMock(),
}))

// Render react-resizable-panels as plain passthrough divs so split-tree
// structure is testable without a measured layout in jsdom.
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="rpg">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="rp">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="handle" />,
}))

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()
}

const PANEL_TERMINALS = [
  {
    id: 't1',
    worktreeId: 'w1',
    command: null,
    commandArgs: [],
    label: 'Shell',
    kind: 'panel' as const,
  },
  {
    id: 't2',
    worktreeId: 'w1',
    command: null,
    commandArgs: [],
    label: 'Shell',
    kind: 'panel' as const,
  },
]

// Two single-pane views (the common case: one terminal per tab).
const TWO_VIEWS = [
  {
    id: 'g1',
    layout: { type: 'leaf' as const, terminalId: 't1' },
    focusedTerminalId: 't1',
  },
  {
    id: 'g2',
    layout: { type: 'leaf' as const, terminalId: 't2' },
    focusedTerminalId: 't2',
  },
]

// One view tiling both terminals side by side.
const SPLIT_VIEW = [
  {
    id: 'gs',
    layout: {
      type: 'split' as const,
      orientation: 'horizontal' as const,
      children: [
        { type: 'leaf' as const, terminalId: 't1' },
        { type: 'leaf' as const, terminalId: 't2' },
      ],
    },
    focusedTerminalId: 't2',
  },
]

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

describe('TerminalView views (multiplexer)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativeAppMock.mockReturnValue(true)
    isMobileMock.mockReturnValue(false)
    window.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver
    window.requestAnimationFrame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => {
        callback(0)
        return 0
      })
    // Two single-pane views; view g2 (t2) active.
    useTerminalStore.setState({
      terminals: { w1: PANEL_TERMINALS },
      groups: { w1: TWO_VIEWS },
      activeGroupIds: { w1: 'g2' },
      activeTerminalIds: { w1: 't2' },
      dragTerminalId: null,
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: true,
      terminalPanelOpen: { w1: true },
      modalTerminalOpen: {},
    })
  })

  it('shows one tab per view and attaches only the active view', async () => {
    const { getAllByText } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    // Two tabs (both labelled "Shell").
    expect(getAllByText('Shell').length).toBe(2)
    // Only the active single-pane view attaches its terminal.
    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(1))
  })

  it('attaches every pane when the active view is split', async () => {
    useTerminalStore.setState({
      groups: { w1: SPLIT_VIEW },
      activeGroupIds: { w1: 'gs' },
    })
    render(<TerminalView worktreeId="w1" worktreePath="/tmp/w1" />)
    await waitFor(() => expect(initTerminal).toHaveBeenCalledTimes(2))
  })

  it('shows split buttons on native desktop', () => {
    const { getByLabelText } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    expect(getByLabelText('Split terminal right')).toBeTruthy()
    expect(getByLabelText('Split terminal down')).toBeTruthy()
  })

  it('clicking a pane focuses it (sets the active terminal)', () => {
    useTerminalStore.setState({
      groups: { w1: SPLIT_VIEW },
      activeGroupIds: { w1: 'gs' },
    })
    const { container } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    const pane = container.querySelector('[data-terminal-pane="t1"]')
    expect(pane).toBeTruthy()
    fireEvent.mouseDown(pane as Element)
    expect(useTerminalStore.getState().activeTerminalIds.w1).toBe('t1')
  })

  it('merges a dragged tab onto a pane (drop)', () => {
    // Active view g2 (single t2); drag view g1 (single t1) onto pane t2.
    useTerminalStore.getState().setDragTerminal('t1') // dragstart of view g1
    const { container } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    const pane = container.querySelector('[data-terminal-pane="t2"]')
    expect(pane).toBeTruthy()
    fireEvent.drop(pane as Element, {
      dataTransfer: { getData: () => 'group:g1', types: ['text/plain'] },
    })
    const state = useTerminalStore.getState()
    expect(state.groups.w1).toHaveLength(1) // merged into one view
    expect(state.activeTerminalIds.w1).toBe('t1')
  })

  it('ignores dropping the active tab onto its own pane (no-op)', () => {
    // Drag the active view g2 (terminal t2) onto its own pane t2 → nothing.
    useTerminalStore.getState().setDragTerminal('t2')
    const { container } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    const pane = container.querySelector('[data-terminal-pane="t2"]')
    expect(pane).toBeTruthy()
    fireEvent.drop(pane as Element, {
      dataTransfer: { getData: () => 'group:g2', types: ['text/plain'] },
    })
    // Still two separate views — no self-merge.
    expect(useTerminalStore.getState().groups.w1).toHaveLength(2)
  })

  it('detaches a pane into its own view via the detach button', () => {
    useTerminalStore.setState({
      groups: { w1: SPLIT_VIEW },
      activeGroupIds: { w1: 'gs' },
    })
    const { getAllByLabelText } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    // Two panes ⇒ chrome present; detach the first pane.
    const detachButtons = getAllByLabelText('Detach pane to new tab')
    expect(detachButtons.length).toBe(2)
    fireEvent.click(detachButtons[0] as Element)
    const state = useTerminalStore.getState()
    expect(state.groups.w1).toHaveLength(2) // split view + detached view
  })

  it('moves a pane onto another pane via drag (drop pane payload)', () => {
    // Split view [t1, t2]; drag pane t1 onto pane t2 → relocate within the view.
    useTerminalStore.setState({
      groups: { w1: SPLIT_VIEW },
      activeGroupIds: { w1: 'gs' },
    })
    useTerminalStore.getState().setDragTerminal('t1') // dragstart of pane t1
    const { container } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    const pane = container.querySelector('[data-terminal-pane="t2"]')
    expect(pane).toBeTruthy()
    fireEvent.drop(pane as Element, {
      dataTransfer: { getData: () => 'pane:t1', types: ['text/plain'] },
    })
    const state = useTerminalStore.getState()
    expect(state.groups.w1).toHaveLength(1)
    expect(state.activeTerminalIds.w1).toBe('t1')
  })

  it('renames a view via double-click on its tab', () => {
    const { container } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    // Single-pane views ⇒ the only renamable spans are the two tab labels.
    const tabLabels = container.querySelectorAll(
      'span[title="Double-click to rename"]'
    )
    expect(tabLabels.length).toBe(2)
    fireEvent.doubleClick(tabLabels[0] as Element) // view g1
    const input = container.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: 'Build' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const g1 = useTerminalStore.getState().groups.w1?.find(g => g.id === 'g1')
    expect(g1?.name).toBe('Build')
  })

  it('shows a per-pane title bar and renames a pane via double-click', () => {
    useTerminalStore.setState({
      groups: { w1: SPLIT_VIEW },
      activeGroupIds: { w1: 'gs' },
    })
    const { container } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    const pane = container.querySelector('[data-terminal-pane="t1"]')
    expect(pane).toBeTruthy()
    const label = pane?.querySelector(
      'span[title="Double-click to rename"]'
    ) as HTMLElement
    expect(label).toBeTruthy()
    fireEvent.doubleClick(label)
    const input = pane?.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'logs' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const t1 = useTerminalStore
      .getState()
      .terminals.w1?.find(t => t.id === 't1')
    expect(t1?.label).toBe('logs')
  })

  it('hides split buttons on web access', () => {
    isNativeAppMock.mockReturnValue(false)
    const { queryByLabelText } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    expect(queryByLabelText('Split terminal right')).toBeNull()
  })

  it('hides split buttons on mobile', () => {
    isMobileMock.mockReturnValue(true)
    const { queryByLabelText } = render(
      <TerminalView worktreeId="w1" worktreePath="/tmp/w1" />
    )
    expect(queryByLabelText('Split terminal right')).toBeNull()
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
    isNativeAppMock.mockReturnValue(true)
    isMobileMock.mockReturnValue(false)
    setupBrowserMocks()
    useUIStore.setState({ uiStateInitialized: true })
    // One single-pane view per terminal (the classic one-terminal-per-tab case).
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
      groups: {
        'worktree-1': [
          {
            id: 'g1',
            layout: { type: 'leaf' as const, terminalId: 'terminal-1' },
            focusedTerminalId: 'terminal-1',
          },
          {
            id: 'g2',
            layout: { type: 'leaf' as const, terminalId: 'terminal-2' },
            focusedTerminalId: 'terminal-2',
          },
        ],
      },
      activeGroupIds: { 'worktree-1': 'g1' },
      activeTerminalIds: { 'worktree-1': 'terminal-1' },
      dragTerminalId: null,
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

  it('closes the view on middle-click (button 1)', async () => {
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
