import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useTerminalStore } from '@/store/terminal-store'
import { useWorktreeTerminalStatus } from './useWorktreeTerminalStatus'

describe('useWorktreeTerminalStatus', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      terminals: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
    })
  })

  it('reports an active panel shell', () => {
    const terminalId = useTerminalStore.getState().addTerminal('worktree-1')
    const { result } = renderHook(() =>
      useWorktreeTerminalStatus('worktree-1')
    )
    expect(result.current.hasActiveTerminal).toBe(false)

    act(() => {
      useTerminalStore.getState().setTerminalRunning(terminalId, true)
    })

    expect(result.current.hasActiveTerminal).toBe(true)
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

    const { result } = renderHook(() =>
      useWorktreeTerminalStatus('worktree-1')
    )

    expect(result.current.hasActiveTerminal).toBe(false)
  })

  it('does not count a failed script as active', () => {
    const terminalId = useTerminalStore
      .getState()
      .addTerminal('worktree-1', 'bun run dev')
    useTerminalStore.getState().setTerminalFailed(terminalId, true)

    const { result } = renderHook(() =>
      useWorktreeTerminalStatus('worktree-1')
    )

    expect(result.current.hasActiveTerminal).toBe(false)
  })
})
