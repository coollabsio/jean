import { describe, expect, it } from 'vitest'
import { selectSessionRenderTarget } from './session-render-target'

describe('selectSessionRenderTarget', () => {
  it('does not keep the previous session when the worktree changes', () => {
    const active = {
      sessionId: 'remote-two:session-2',
      worktreeId: 'remote-two:worktree-2',
      worktreePath: '/srv/two/project',
    }
    const deferred = {
      sessionId: 'remote-one:session-1',
      worktreeId: 'remote-one:worktree-1',
      worktreePath: '/srv/one/project',
    }

    expect(selectSessionRenderTarget(active, deferred)).toBe(active)
  })

  it('does not keep a remote session when changing to a local worktree', () => {
    const active = {
      sessionId: 'local-session',
      worktreeId: 'local-worktree',
      worktreePath: '/Users/me/project',
    }
    const deferred = {
      sessionId: 'remote-one:session-1',
      worktreeId: 'remote-one:worktree-1',
      worktreePath: '/srv/one/project',
    }

    expect(selectSessionRenderTarget(active, deferred)).toBe(active)
  })

  it('does not keep the previous session while switching tabs in one worktree', () => {
    const active = {
      sessionId: 'remote-one:session-2',
      worktreeId: 'remote-one:worktree-1',
      worktreePath: '/srv/one/project',
    }
    const deferred = {
      sessionId: 'remote-one:session-1',
      worktreeId: 'remote-one:worktree-1',
      worktreePath: '/srv/one/project',
    }

    expect(selectSessionRenderTarget(active, deferred)).toBe(active)
  })
})
