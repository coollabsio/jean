import { isPanelTerminal, useTerminalStore } from '@/store/terminal-store'

/**
 * Whether a worktree has at least one running panel terminal.
 */
export function useWorktreeTerminalStatus(worktreeId: string) {
  const hasActiveTerminal = useTerminalStore(state => {
    const terminals = state.terminals[worktreeId] ?? []
    return terminals.some(
      t => isPanelTerminal(t) && state.runningTerminals.has(t.id)
    )
  })

  return { hasActiveTerminal }
}
