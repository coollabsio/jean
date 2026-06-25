import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { render, waitFor } from '@/test/test-utils'
import { useTerminalStore } from '@/store/terminal-store'
import { SingleTerminalView, TerminalView } from './TerminalView'

const initTerminal = vi.fn().mockResolvedValue(undefined)
const fit = vi.fn()
const focus = vi.fn()

vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => ({
    initTerminal,
    fit,
    focus,
  }),
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

describe('SingleTerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver
    window.requestAnimationFrame =
      window.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => {
        callback(0)
        return 0
      })
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
