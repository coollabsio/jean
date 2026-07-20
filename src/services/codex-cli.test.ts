import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  codexCliQueryKeys,
  installCodexUsageUpdateListener,
  useCodexCliStatus,
} from './codex-cli'
import type { CodexUsageSnapshot } from '@/types/codex-cli'

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  listen: (...args: unknown[]) => listenMock(...args),
  useWsConnectionStatus: vi.fn(() => true),
}))

vi.mock('@/lib/environment', () => ({
  hasBackend: () => false,
  hasBackendTransport: () => true,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('Codex usage update listener', () => {
  beforeEach(() => {
    listenMock.mockReset()
  })

  it('updates the Codex usage query cache from usage-updated events', async () => {
    let capturedHandler:
      | ((event: { payload: CodexUsageSnapshot }) => void)
      | undefined
    const unlisten = vi.fn()
    listenMock.mockImplementation((eventName, handler) => {
      expect(eventName).toBe('codex-cli:usage-updated')
      capturedHandler = handler
      return Promise.resolve(unlisten)
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const snapshot: CodexUsageSnapshot = {
      planType: 'plus',
      session: {
        usedPercent: 42,
        resetsAt: 1_771_456_509,
        limitWindowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 17,
        resetsAt: 1_772_023_891,
        limitWindowSeconds: 604_800,
      },
      reviews: null,
      creditsRemaining: 12.5,
      rateLimitReachedType: 'rate_limit_reached',
      modelLimits: [],
      fetchedAt: 1_771_450_000,
    }

    const cleanup = await installCodexUsageUpdateListener(queryClient)
    capturedHandler?.({ payload: snapshot })

    expect(queryClient.getQueryData(codexCliQueryKeys.usage())).toEqual(
      snapshot
    )
    cleanup()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})

describe('Codex CLI status', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('checks the configured remote backend before its WebSocket connects', async () => {
    invokeMock.mockResolvedValue({
      installed: true,
      version: '1.2.3',
      path: '/usr/local/bin/codex',
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)

    const { result } = renderHook(() => useCodexCliStatus(), { wrapper })

    await waitFor(() => expect(result.current.data?.installed).toBe(true))
    expect(invokeMock).toHaveBeenCalledWith('check_codex_cli_installed')
  })
})
