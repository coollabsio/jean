import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@/types/projects'

type Handler = (event: { payload: unknown }) => void

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Set<Handler>>(),
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/transport', () => ({
  listen: async (event: string, handler: Handler) => {
    const set = mocks.handlers.get(event) ?? new Set<Handler>()
    set.add(handler)
    mocks.handlers.set(event, set)
    return () => set.delete(handler)
  },
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))

import { runBulkInvestigation } from './bulkInvestigateUtils'

function emit(event: string, payload: unknown) {
  for (const handler of mocks.handlers.get(event) ?? []) handler({ payload })
}

const worktree = (id: string) => ({ id }) as Worktree

describe('runBulkInvestigation', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('starts the next item only after the previous worktree is created', async () => {
    const started: string[] = []
    const run = runBulkInvestigation(
      ['a', 'b'],
      'issue',
      'issues',
      async id => {
        started.push(id)
        return worktree(id)
      }
    )

    await vi.waitFor(() => expect(started).toEqual(['a']))
    expect(mocks.toast.loading).toHaveBeenLastCalledWith(
      'Starting investigation 1 of 2 issues…',
      { id: 'toast-id' }
    )

    emit('worktree:created', { worktree: worktree('a') })
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']))

    emit('worktree:created', { worktree: worktree('b') })
    await run

    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Investigating 2 issues in background',
      { id: 'toast-id' }
    )
    expect(mocks.handlers.get('worktree:created')?.size).toBe(0)
  })

  it('handles a created event that arrives before the create call returns', async () => {
    await runBulkInvestigation(['a'], 'issue', 'issues', async id => {
      emit('worktree:created', { worktree: worktree(id) })
      return worktree(id)
    })

    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Investigating 1 issue in background',
      { id: 'toast-id' }
    )
  })

  it('counts worktree errors and thrown items as failures and continues', async () => {
    const run = runBulkInvestigation(
      ['a', 'b', 'c'],
      'issue',
      'issues',
      async id => {
        if (id === 'b') throw new Error('fetch failed')
        return worktree(id)
      }
    )

    await vi.waitFor(() =>
      expect(mocks.handlers.get('worktree:error')?.size).toBe(1)
    )
    emit('worktree:error', { id: 'a', project_id: 'p', error: 'git failed' })
    await vi.waitFor(() =>
      expect(mocks.toast.loading).toHaveBeenLastCalledWith(
        'Starting investigation 3 of 3 issues…',
        { id: 'toast-id' }
      )
    )
    emit('worktree:created', { worktree: worktree('c') })
    await run

    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'Investigating 1 in background; 2 failed',
      { id: 'toast-id' }
    )
  })
})
