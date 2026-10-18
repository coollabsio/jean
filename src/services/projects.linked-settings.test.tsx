import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeForServer = vi.fn()
const isNativeApp = vi.fn()

vi.mock('@/lib/transport', () => ({
  invokeForServer: (...args: unknown[]) => invokeForServer(...args),
}))

vi.mock('@/lib/environment', () => ({
  hasBackend: () => true,
  isNativeApp: () => isNativeApp(),
}))

import { useUpdateProjectSettings } from './projects'

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  )
}

describe('linked project settings', () => {
  beforeEach(() => {
    invokeForServer.mockReset().mockResolvedValue({ id: 'project' })
    isNativeApp.mockReset()
  })

  it('sends resource IDs to the serving instance in Web Access', async () => {
    isNativeApp.mockReturnValue(false)
    const { result } = renderHook(() => useUpdateProjectSettings(), {
      wrapper,
    })

    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'server-a:project',
        linkedProjectIds: ['server-b:linked'],
      })
    })

    expect(invokeForServer).toHaveBeenCalledWith(
      'server-a',
      'update_project_settings',
      expect.objectContaining({
        projectId: 'project',
        linkedProjectIds: ['linked'],
      })
    )
  })

  it('rejects links between different instances in the native app', async () => {
    isNativeApp.mockReturnValue(true)
    const { result } = renderHook(() => useUpdateProjectSettings(), {
      wrapper,
    })

    await expect(
      result.current.mutateAsync({
        projectId: 'server-a:project',
        linkedProjectIds: ['server-b:linked'],
      })
    ).rejects.toThrow('Linked projects must belong to the same Jean instance')

    expect(invokeForServer).not.toHaveBeenCalled()
  })

  it('keeps same-instance links valid in the native app', async () => {
    isNativeApp.mockReturnValue(true)
    const { result } = renderHook(() => useUpdateProjectSettings(), {
      wrapper,
    })

    await act(async () => {
      await result.current.mutateAsync({
        projectId: 'server-a:project',
        linkedProjectIds: ['server-a:linked'],
      })
    })

    await waitFor(() => {
      expect(invokeForServer).toHaveBeenCalledWith(
        'server-a',
        'update_project_settings',
        expect.objectContaining({
          projectId: 'project',
          linkedProjectIds: ['linked'],
        })
      )
    })
  })
})
