import { act, renderHook, waitFor } from '@testing-library/react'
import { render, screen } from '@/test/test-utils'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PropsWithChildren } from 'react'
import { useTerminalStore } from '@/store/terminal-store'
import {
  TerminalStatusIndicator,
  useWorktreeTerminalStatus,
} from './useWorktreeTerminalStatus'

function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  )
}

describe('useWorktreeTerminalStatus', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
    })
  })

  it('reports an active generic panel shell without classifying it as a script', async () => {
    const terminalId = useTerminalStore.getState().addTerminal('worktree-1')
    const { result } = renderHook(
      () => useWorktreeTerminalStatus('worktree-1'),
      { wrapper }
    )

    act(() => {
      useTerminalStore.getState().setTerminalRunning(terminalId, true)
    })

    await waitFor(() => expect(result.current.hasActiveTerminal).toBe(true))
    expect(result.current.activeTerminalCount).toBe(1)
    expect(result.current.hasRunningTerminal).toBe(false)
    expect(result.current.tooltipLines).toContain('Shell')
  })

  it('reports a Jean-launched script as active and running', async () => {
    const terminalId = useTerminalStore
      .getState()
      .addTerminal('worktree-1', 'bun run dev')
    const { result } = renderHook(
      () => useWorktreeTerminalStatus('worktree-1'),
      { wrapper }
    )

    act(() => {
      useTerminalStore.getState().setTerminalRunning(terminalId, true)
    })

    await waitFor(() => expect(result.current.hasActiveTerminal).toBe(true))
    expect(result.current.hasRunningTerminal).toBe(true)
    expect(result.current.tooltipLines).toContain('bun run dev')
  })

  it('does not count a full-screen session terminal as panel activity', () => {
    const terminalId = useTerminalStore
      .getState()
      .addTerminal('worktree-1', 'codex', 'Codex', {
        kind: 'session',
        activate: false,
        openPanel: false,
      })
    useTerminalStore.getState().setTerminalRunning(terminalId, true)

    const { result } = renderHook(
      () => useWorktreeTerminalStatus('worktree-1'),
      { wrapper }
    )

    expect(result.current.hasActiveTerminal).toBe(false)
    expect(result.current.hasRunningTerminal).toBe(false)
  })

  it('reports failed run commands for sidebar and canvas indicators', () => {
    const terminalId = useTerminalStore
      .getState()
      .addTerminal('worktree-1', 'bun run dev')
    useTerminalStore.getState().setTerminalFailed(terminalId, true)

    const { result } = renderHook(
      () => useWorktreeTerminalStatus('worktree-1'),
      { wrapper }
    )

    expect(result.current.hasActiveTerminal).toBe(false)
    expect(result.current.hasFailedTerminal).toBe(true)
    expect(result.current.tooltipLines).toContain('bun run dev (crashed)')
  })

  it('renders the shared sidepanel/canvas script indicator', () => {
    const terminalId = useTerminalStore
      .getState()
      .addTerminal('worktree-1', 'bun run dev')
    useTerminalStore.getState().setTerminalRunning(terminalId, true)

    const { container } = render(
      <TerminalStatusIndicator worktreeId="worktree-1" />
    )

    expect(screen.getByLabelText('1 active terminal')).toBeInTheDocument()
    expect(container.querySelector('svg.lucide-terminal')).toHaveClass(
      'text-amber-500'
    )
    expect(screen.queryByText('bun run dev')).toBeNull()
  })

  it('shows a compact count when multiple worktree terminals are active', () => {
    const firstId = useTerminalStore.getState().addTerminal('worktree-1')
    const secondId = useTerminalStore.getState().addTerminal('worktree-1')
    useTerminalStore.getState().setTerminalRunning(firstId, true)
    useTerminalStore.getState().setTerminalRunning(secondId, true)

    render(<TerminalStatusIndicator worktreeId="worktree-1" />)

    expect(screen.getByLabelText('2 active terminals')).toHaveTextContent('2')
  })

  it('renders a readable terminal summary for the worktree viewer', () => {
    const terminalId = useTerminalStore.getState().addTerminal('worktree-1')
    useTerminalStore.getState().setTerminalRunning(terminalId, true)

    render(
      <TerminalStatusIndicator worktreeId="worktree-1" variant="summary" />
    )

    expect(screen.getByText('1 terminal running')).toBeInTheDocument()
  })

  it('includes failures alongside running terminals in the worktree summary', () => {
    const runningId = useTerminalStore.getState().addTerminal('worktree-1')
    const failedId = useTerminalStore
      .getState()
      .addTerminal('worktree-1', 'bun run dev')
    useTerminalStore.getState().setTerminalRunning(runningId, true)
    useTerminalStore.getState().setTerminalFailed(failedId, true)

    render(
      <TerminalStatusIndicator worktreeId="worktree-1" variant="summary" />
    )

    expect(
      screen.getByText('1 terminal running · 1 failed')
    ).toBeInTheDocument()
  })
})
