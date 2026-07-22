import { describe, expect, it } from 'vitest'
import {
  mergeWorktreesPreservingOptimistic,
  removePendingWorktree,
} from './worktree-list-cache'
import type { Worktree } from '@/types/projects'

function makeWorktree(
  overrides: Partial<Worktree> & Pick<Worktree, 'id'>
): Worktree {
  return {
    project_id: 'proj-1',
    name: overrides.name ?? overrides.id,
    path: `/tmp/${overrides.id}`,
    branch: overrides.branch ?? overrides.id,
    created_at: 1,
    order: 0,
    session_type: 'worktree',
    ...overrides,
  }
}

describe('mergeWorktreesPreservingOptimistic', () => {
  it('returns server list when there is no previous cache', () => {
    const server = [makeWorktree({ id: 'a' })]
    expect(mergeWorktreesPreservingOptimistic(server, undefined)).toEqual(
      server
    )
    expect(mergeWorktreesPreservingOptimistic(server, [])).toEqual(server)
  })

  it('preserves pending worktrees missing from the server response', () => {
    const pending = makeWorktree({ id: 'pending-1', status: 'pending' })
    const ready = makeWorktree({ id: 'ready-1', status: 'ready' })
    const server = [ready]

    const merged = mergeWorktreesPreservingOptimistic(server, [pending, ready])

    expect(merged.map(w => w.id)).toEqual(['pending-1', 'ready-1'])
    expect(merged[0]?.status).toBe('pending')
  })

  it('drops pending once the server includes the same id', () => {
    const pending = makeWorktree({ id: 'wt-1', status: 'pending', name: 'old' })
    const serverReady = makeWorktree({
      id: 'wt-1',
      name: 'new-name',
      branch: 'new-name',
    })

    const merged = mergeWorktreesPreservingOptimistic([serverReady], [pending])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.id).toBe('wt-1')
    expect(merged[0]?.name).toBe('new-name')
    expect(merged[0]?.status).toBeUndefined()
  })

  it('clears deleting status on server-backed rows', () => {
    const deleting = makeWorktree({ id: 'wt-1', status: 'deleting' })
    const server = [makeWorktree({ id: 'wt-1', name: 'from-server' })]

    const merged = mergeWorktreesPreservingOptimistic(server, [deleting])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.status).toBeUndefined()
    expect(merged[0]?.name).toBe('from-server')
  })

  it('does not keep non-optimistic rows that disappeared from the server', () => {
    const previous = [
      makeWorktree({ id: 'gone', status: 'ready' }),
      makeWorktree({ id: 'pending', status: 'pending' }),
    ]
    const server = [makeWorktree({ id: 'kept' })]

    const merged = mergeWorktreesPreservingOptimistic(server, previous)

    expect(merged.map(w => w.id)).toEqual(['pending', 'kept'])
  })
})

describe('removePendingWorktree', () => {
  it('removes only the exhausted pending row', () => {
    const exhausted = makeWorktree({ id: 'exhausted', status: 'pending' })
    const otherPending = makeWorktree({ id: 'other', status: 'pending' })
    const ready = makeWorktree({ id: 'ready', status: 'ready' })

    expect(
      removePendingWorktree([exhausted, otherPending, ready], 'exhausted')
    ).toEqual([otherPending, ready])
  })

  it('does not remove a server-reconciled row', () => {
    const ready = makeWorktree({ id: 'ready', status: 'ready' })

    expect(removePendingWorktree([ready], 'ready')).toEqual([ready])
  })
})
