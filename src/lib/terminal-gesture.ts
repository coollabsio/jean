import {
  isPanelTerminal,
  useTerminalStore,
} from '@/store/terminal-store'

/**
 * Whether the chat terminal surface is open for a worktree.
 * - `panel`: full ChatWindow bottom/side terminal
 * - `modal`: SessionChatModal drawer/sheet terminal
 */
export function isChatTerminalOpen(
  worktreeId: string,
  mode: 'panel' | 'modal'
): boolean {
  const state = useTerminalStore.getState()
  if (mode === 'modal') {
    return state.modalTerminalOpen[worktreeId] ?? false
  }
  return (
    (state.terminalPanelOpen[worktreeId] ?? false) && state.terminalVisible
  )
}

/** Open the chat terminal (creates a panel tab if needed). */
export function openChatTerminal(
  worktreeId: string,
  mode: 'panel' | 'modal'
): void {
  const store = useTerminalStore.getState()
  if (mode === 'modal') {
    store.setModalTerminalOpen(worktreeId, true)
    return
  }

  const terminals = store.getTerminals(worktreeId).filter(isPanelTerminal)
  if (terminals.length === 0) {
    store.addTerminal(worktreeId)
  } else {
    store.setTerminalPanelOpen(worktreeId, true)
    store.setTerminalVisible(true)
  }
}

/** Close / hide the chat terminal surface. */
export function closeChatTerminal(
  worktreeId: string,
  mode: 'panel' | 'modal'
): void {
  const store = useTerminalStore.getState()
  if (mode === 'modal') {
    store.setModalTerminalOpen(worktreeId, false)
    return
  }
  store.setTerminalPanelOpen(worktreeId, false)
  store.setTerminalVisible(false)
}
