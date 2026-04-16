import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { useWslAvailability, useWslDistros } from './wsl'

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

const createWrapper = (queryClient: QueryClient) => {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  Wrapper.displayName = 'TestQueryClientWrapper'
  return Wrapper
}

describe('wsl service', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = createTestQueryClient()
    vi.clearAllMocks()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
  })

  it('detects WSL availability from the backend', async () => {
    const { invoke } = await import('@/lib/transport')
    vi.mocked(invoke).mockResolvedValueOnce(true)

    const { result } = renderHook(() => useWslAvailability(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invoke).toHaveBeenCalledWith('is_wsl_available')
    expect(result.current.data).toBe(true)
  })

  it('returns WSL distros from the backend', async () => {
    const { invoke } = await import('@/lib/transport')
    vi.mocked(invoke).mockResolvedValueOnce(['Ubuntu', 'Debian'])

    const { result } = renderHook(() => useWslDistros(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invoke).toHaveBeenCalledWith('list_wsl_distros')
    expect(result.current.data).toEqual(['Debian', 'Ubuntu'])
  })
})
