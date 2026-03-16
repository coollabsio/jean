import { describe, expect, it, vi } from 'vitest'
import { navigateToApprovedWorktree } from './worktree-approval-navigation'

const worktree = {
  id: 'wt-1',
  path: '/tmp/wt-1',
  project_id: 'proj-1',
}

function createActions() {
  return {
    expandProject: vi.fn(),
    selectWorktree: vi.fn(),
    registerWorktreePath: vi.fn(),
    setActiveWorktree: vi.fn(),
    openWorktreeModal: vi.fn(),
  }
}

describe('navigateToApprovedWorktree', () => {
  it('reopens the new worktree in the modal when a session modal is already open', () => {
    const actions = createActions()

    const destination = navigateToApprovedWorktree(
      worktree,
      {
        activeWorktreePath: '/repo/current',
        sessionChatModalOpen: true,
      },
      actions
    )

    expect(destination).toBe('modal')
    expect(actions.expandProject).toHaveBeenCalledWith('proj-1')
    expect(actions.selectWorktree).toHaveBeenCalledWith('wt-1')
    expect(actions.registerWorktreePath).toHaveBeenCalledWith(
      'wt-1',
      '/tmp/wt-1'
    )
    expect(actions.openWorktreeModal).toHaveBeenCalledWith('wt-1', '/tmp/wt-1')
    expect(actions.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('opens the modal when approving from the project canvas', () => {
    const actions = createActions()

    const destination = navigateToApprovedWorktree(
      worktree,
      {
        activeWorktreePath: null,
        sessionChatModalOpen: false,
      },
      actions
    )

    expect(destination).toBe('modal')
    expect(actions.openWorktreeModal).toHaveBeenCalledWith('wt-1', '/tmp/wt-1')
    expect(actions.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('switches the main chat view when already browsing a worktree inline', () => {
    const actions = createActions()

    const destination = navigateToApprovedWorktree(
      worktree,
      {
        activeWorktreePath: '/repo/current',
        sessionChatModalOpen: false,
      },
      actions
    )

    expect(destination).toBe('chat')
    expect(actions.setActiveWorktree).toHaveBeenCalledWith('wt-1', '/tmp/wt-1')
    expect(actions.openWorktreeModal).not.toHaveBeenCalled()
  })
})
