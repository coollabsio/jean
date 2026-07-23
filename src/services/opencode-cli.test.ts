import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRefreshOpencodeModels } from './opencode-cli'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
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
  })

  it('uses the strict refresh command so refresh failures are propagated', async () => {
    invokeMock.mockRejectedValue(new Error('refresh failed'))
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useRefreshOpencodeModels(), { wrapper })

    await expect(
      act(async () => await result.current.mutateAsync())
    ).rejects.toThrow('refresh failed')
    expect(invokeMock).toHaveBeenCalledWith('refresh_opencode_models')
  })
})
