import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileQueryKeys } from '@/services/files'
import { prefetchInputListsWhenQuiet } from './prefetch-input-lists'

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))
vi.mock('@/lib/transport', () => ({ invoke: mockInvoke }))

describe('prefetchInputListsWhenQuiet', () => {
  const win = window as unknown as { __JEAN_E2E_MOCK__?: boolean }
  let queryClient: QueryClient
  const sent = () => mockInvoke.mock.calls.map(call => call[0] as string)

  beforeEach(() => {
    vi.useFakeTimers()
    win.__JEAN_E2E_MOCK__ = true
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue([])
    queryClient = new QueryClient()
  })

  afterEach(() => {
    delete win.__JEAN_E2E_MOCK__
    vi.useRealTimers()
  })

  it('waits until no request is in flight, then loads the lists once', async () => {
    let finishOther: (value: unknown) => void = () => undefined
    void queryClient.fetchQuery({
      queryKey: ['other'],
      queryFn: () => new Promise(resolve => (finishOther = resolve)),
    })

    prefetchInputListsWhenQuiet(queryClient, 'wt1', '/repo')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent()).toEqual([])

    finishOther('done')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sent().sort()).toEqual([
      'list_claude_commands',
      'list_claude_skills',
      'list_codex_skills',
      'list_commandcode_skills',
      'list_cursor_skills',
      'list_grok_skills',
      'list_opencode_skills',
      'list_pi_skills',
      'list_plugin_skills',
      'list_worktree_files',
    ])
  })

  it('does not load a list that is already cached', async () => {
    queryClient.setQueryData(
      fileQueryKeys.worktreeFiles('/repo', { worktreeId: 'wt1' }),
      []
    )

    prefetchInputListsWhenQuiet(queryClient, 'wt1', '/repo')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sent()).not.toContain('list_worktree_files')
    expect(sent()).toContain('list_claude_skills')
  })

  it('loads nothing when cancelled first', async () => {
    const cancel = prefetchInputListsWhenQuiet(queryClient, 'wt1', '/repo')
    cancel()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sent()).toEqual([])
  })
})
