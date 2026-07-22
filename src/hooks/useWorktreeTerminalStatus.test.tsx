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
    expect(result.current.hasRunningTerminal).toBe(false)
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

    expect(container.querySelector('svg.lucide-play')).toHaveClass(
      'text-amber-500'
    )
    expect(screen.queryByText('bun run dev')).toBeNull()
  })
})
