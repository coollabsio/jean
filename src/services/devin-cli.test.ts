import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useDevinCliStatus } from './devin-cli'

vi.mock('@/lib/environment', () => ({
  hasBackendTransport: () => true,
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(async () => ({
    installed: true,
    version: 'local',
    path: '/local/devin',
  })),
  invokeForOptionalServer: vi.fn(async (serverId?: string) => ({
    installed: serverId !== 'remote',
    version: serverId === 'remote' ? null : 'local',
    path: serverId === 'remote' ? null : '/local/devin',
  })),
}))

describe('Devin CLI status', () => {
  it('keeps local and remote installation status separate when the target changes', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const { result, rerender, unmount } = renderHook(
      ({ serverId }: { serverId: string }) => useDevinCliStatus({ serverId }),
      { wrapper, initialProps: { serverId: 'local' } }
    )

    await waitFor(() => expect(result.current.data?.installed).toBe(true))
    rerender({ serverId: 'remote' })
    await waitFor(() => expect(result.current.data?.installed).toBe(false))
    expect(result.current.data?.path).toBeNull()
    rerender({ serverId: 'local' })
    await waitFor(() => expect(result.current.data?.path).toBe('/local/devin'))
    unmount()
    queryClient.clear()
  })
})
