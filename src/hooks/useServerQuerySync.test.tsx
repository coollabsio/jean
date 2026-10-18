import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useServerQuerySync } from './useServerQuerySync'

let activeConnectionId = 'local'

vi.mock('@/lib/remote-connections', () => ({
  useActiveConnectionId: () => activeConnectionId,
}))

describe('useServerQuerySync', () => {
  beforeEach(() => {
    activeConnectionId = 'local'
  })

  it('clears stale caches and refetches active queries after each server change', async () => {
    const queryClient = new QueryClient()
    const resetQueries = vi.spyOn(queryClient, 'resetQueries')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result, rerender } = renderHook(
      () => {
        useServerQuerySync()
        return useQuery({
          queryKey: ['active-server-data'],
          queryFn: async () => `${activeConnectionId}-models`,
        })
      },
      { wrapper }
    )

    expect(resetQueries).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.data).toBe('local-models'))
    queryClient.setQueryData(['inactive-server-data'], 'local-auth')

    activeConnectionId = 'remote-one'
    rerender()

    await waitFor(() => expect(result.current.data).toBe('remote-one-models'))
    expect(queryClient.getQueryData(['inactive-server-data'])).toBeUndefined()
    expect(resetQueries).toHaveBeenCalledTimes(1)

    activeConnectionId = 'local'
    rerender()

    await waitFor(() => expect(result.current.data).toBe('local-models'))
    expect(resetQueries).toHaveBeenCalledTimes(2)
  })
})
