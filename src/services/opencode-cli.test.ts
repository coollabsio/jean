import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAvailableOpencodeModels, useRefreshOpencodeModels } from './opencode-cli'
import { SettingsTargetProvider } from '@/lib/settings-target'

const { invokeMock, invokeForOptionalServerMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  invokeForOptionalServerMock: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  invokeForOptionalServer: (...args: unknown[]) =>
    invokeForOptionalServerMock(...args),
  listen: vi.fn(),
}))

vi.mock('@/lib/environment', () => ({
  hasBackendTransport: () => true,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}))

describe('OpenCode model refresh', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeForOptionalServerMock.mockReset()
  })

  it('loads models from the selected remote Jean server', async () => {
    invokeForOptionalServerMock.mockResolvedValue(['remote/model'])
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SettingsTargetProvider, { serverId: 'remote-1' }, children)
      )

    const { result } = renderHook(() => useAvailableOpencodeModels(), {
      wrapper,
    })

    await waitFor(() => expect(result.current.data).toEqual(['remote/model']))
    expect(invokeForOptionalServerMock).toHaveBeenCalledWith(
      'remote-1',
      'list_opencode_models'
    )
  })

  it('uses the strict refresh command so refresh failures are propagated', async () => {
    invokeForOptionalServerMock.mockRejectedValue(new Error('refresh failed'))
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useRefreshOpencodeModels(), { wrapper })

    await expect(
      act(async () => await result.current.mutateAsync())
    ).rejects.toThrow('refresh failed')
    expect(invokeForOptionalServerMock).toHaveBeenCalledWith(
      undefined,
      'refresh_opencode_models'
    )
  })
})
