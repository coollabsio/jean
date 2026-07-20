import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useArchiveCleanup } from './useArchiveCleanup'

const { mockInvoke, mockLoggerInfo, mockToastInfo } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockToastInfo: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: mockLoggerInfo,
    error: vi.fn(),
  },
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { archive_retention_days: 7 },
  }),
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => true,
}))

vi.mock('sonner', () => ({
  toast: {
    info: mockToastInfo,
  },
}))

function renderCleanupHook() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  renderHook(() => useArchiveCleanup(), { wrapper })
}

describe('useArchiveCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs orphaned session index cleanup without showing a toast', async () => {
    mockInvoke.mockResolvedValue({
      deleted_worktrees: 0,
      deleted_sessions: 0,
      deleted_contexts: 0,
      deleted_orphan_indexes: 1,
    })

    renderCleanupHook()

    await waitFor(() => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'Archive cleanup complete',
        expect.objectContaining({ deleted_orphan_indexes: 1 })
      )
    })
    expect(mockToastInfo).not.toHaveBeenCalled()
  })
})
