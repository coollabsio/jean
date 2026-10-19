import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { FullScreenTerminalSurface } from './FullScreenTerminalSurface'

vi.mock('./TerminalView', () => ({
  SingleTerminalView: ({
    terminalId,
    worktreeId,
    worktreePath,
    isActive,
  }: {
    terminalId: string
    worktreeId: string
    worktreePath: string
    isActive?: boolean
  }) => (
    <div data-testid="terminal-view">
      {terminalId}:{worktreeId}:{worktreePath}:{String(isActive)}
    </div>
  ),
}))

describe('FullScreenTerminalSurface', () => {
  beforeEach(() => {
    useUIStore.setState({ sessionPrimarySurface: {} })
  })

  it('renders through TerminalView so the selected emulator is respected', () => {
    const { container } = render(
      <FullScreenTerminalSurface
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        terminalId="terminal-1"
      />
    )

    expect(screen.getByTestId('terminal-view')).toHaveTextContent(
      'terminal-1:worktree-1:/tmp/worktree-1:true'
    )
    expect(container.firstElementChild).toHaveAttribute(
      'data-terminal-root',
      'true'
    )
    expect(container.firstElementChild).toHaveAttribute(
      'data-terminal-surface',
      'session'
    )
  })

  it('passes inactive state down so hidden terminal sessions do not start', () => {
    render(
      <FullScreenTerminalSurface
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        terminalId="terminal-1"
        isActive={false}
      />
    )

    expect(screen.getByTestId('terminal-view')).toHaveTextContent(
      'terminal-1:worktree-1:/tmp/worktree-1:false'
    )
  })

  it('does not show a header by default for full-screen terminals', () => {
    render(
      <FullScreenTerminalSurface
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        terminalId="terminal-1"
      />
    )

    expect(screen.queryByRole('button', { name: /chat/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Magic' })).toBeNull()
  })

  it('shows the Magic button for a native CLI session when asked', () => {
    useUIStore.getState().setSessionPrimarySurface('session-1', 'terminal')
    render(
      <FullScreenTerminalSurface
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        terminalId="terminal-1"
        sessionId="session-1"
        showMagicButton
      />
    )

    expect(screen.getByRole('button', { name: 'Magic' })).toBeInTheDocument()
  })

  it('hides the Magic button for a chat session even when the slot is enabled', () => {
    useUIStore.getState().setSessionPrimarySurface('session-1', 'chat')
    render(
      <FullScreenTerminalSurface
        worktreeId="worktree-1"
        worktreePath="/tmp/worktree-1"
        terminalId="terminal-1"
        sessionId="session-1"
        showMagicButton
      />
    )

    expect(screen.queryByRole('button', { name: 'Magic' })).toBeNull()
  })
})
