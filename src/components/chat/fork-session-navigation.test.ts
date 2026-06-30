import { describe, expect, it, vi } from 'vitest'
import { navigateToForkedSession } from './fork-session-navigation'

const worktree = {
  id: 'fork-wt-1',
  path: '/tmp/fork-wt-1',
  project_id: 'proj-1',
}

const session = {
  id: 'fork-session-1',
}

function createActions() {
  return {
    expandProject: vi.fn(),
    selectWorktree: vi.fn(),
    registerWorktreePath: vi.fn(),
    setActiveWorktree: vi.fn(),
    setActiveSession: vi.fn(),
    addUserInitiatedSession: vi.fn(),
    openWorktreeModal: vi.fn(),
  }
}

describe('navigateToForkedSession', () => {
  it('keeps forked sessions in the modal when forking from a modal chat', () => {
    const actions = createActions()

    const destination = navigateToForkedSession(
      worktree,
      session,
      {
        activeWorktreePath: '/repo/current',
        sessionChatModalOpen: true,
      },
      actions
    )

    expect(destination).toBe('modal')
    expect(actions.expandProject).toHaveBeenCalledWith('proj-1')
    expect(actions.selectWorktree).toHaveBeenCalledWith('fork-wt-1')
    expect(actions.registerWorktreePath).toHaveBeenCalledWith(
      'fork-wt-1',
      '/tmp/fork-wt-1'
    )
    expect(actions.setActiveSession).toHaveBeenCalledWith(
      'fork-wt-1',
      'fork-session-1'
    )
    expect(actions.addUserInitiatedSession).toHaveBeenCalledWith(
      'fork-session-1'
    )
    expect(actions.openWorktreeModal).toHaveBeenCalledWith(
      'fork-wt-1',
      '/tmp/fork-wt-1'
    )
    expect(actions.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('switches the inline chat when forking from an inline chat', () => {
    const actions = createActions()

    const destination = navigateToForkedSession(
      worktree,
      session,
      {
        activeWorktreePath: '/repo/current',
        sessionChatModalOpen: false,
      },
      actions
    )

    expect(destination).toBe('chat')
    expect(actions.setActiveWorktree).toHaveBeenCalledWith(
      'fork-wt-1',
      '/tmp/fork-wt-1'
    )
    expect(actions.openWorktreeModal).not.toHaveBeenCalled()
  })
})
