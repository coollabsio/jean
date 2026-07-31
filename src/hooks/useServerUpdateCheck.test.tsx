import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useUIStore } from '@/store/ui-store'
import { applyServerUpdate, useServerUpdateCheck } from './useServerUpdateCheck'

const invokeMock = vi.fn()
const isLocalBackendMock = vi.fn(() => false)

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/lib/environment', () => ({
  isLocalBackend: () => isLocalBackendMock(),
}))

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}))

describe('useServerUpdateCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invokeMock.mockReset()
    isLocalBackendMock.mockReturnValue(false)
    useUIStore.getState().setPendingServerUpdate(null)
    useUIStore.getState().setPendingUpdateVersion(null)
    useUIStore.getState().setUpdateModalVersion(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    useUIStore.getState().setPendingServerUpdate(null)
    useUIStore.getState().setPendingUpdateVersion(null)
    useUIStore.getState().setUpdateModalVersion(null)
  })

  it('stores a sticky pending server update that survives toast-only dismissal', async () => {
    invokeMock.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      canUpdate: true,
      reason: null,
      channel: 'server',
    })

    renderHook(() => useServerUpdateCheck())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000)
    })

    expect(useUIStore.getState().pendingServerUpdate).toEqual({
      latestVersion: '1.2.0',
      currentVersion: '1.0.0',
      canUpdate: true,
      reason: null,
    })
  })

  it('opens the desktop update modal for desktop host channel (issue #509)', async () => {
    invokeMock.mockResolvedValue({
      updateAvailable: true,
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      canUpdate: true,
      reason: 'Install runs on the host Jean desktop app (native updater)',
      channel: 'desktop',
    })

    renderHook(() => useServerUpdateCheck())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000)
    })

    expect(useUIStore.getState().pendingServerUpdate).toBeNull()
    expect(useUIStore.getState().updateModalVersion).toBe('1.2.0')
    expect(useUIStore.getState().pendingUpdateVersion).toBeNull()
  })

  it('clears sticky state after a successful apply', async () => {
    useUIStore.getState().setPendingServerUpdate({
      latestVersion: '1.2.0',
      currentVersion: '1.0.0',
      canUpdate: true,
      reason: null,
    })
    useUIStore.getState().setPendingUpdateVersion('1.2.0')

    invokeMock.mockResolvedValue({
      success: true,
      version: '1.2.0',
      message: 'Installed jean-server 1.2.0; restart scheduled',
      restartScheduled: true,
    })

    await applyServerUpdate('1.2.0')

    expect(useUIStore.getState().pendingServerUpdate).toBeNull()
    expect(useUIStore.getState().pendingUpdateVersion).toBeNull()
    expect(invokeMock).toHaveBeenCalledWith('apply_server_update')
  })

  it('keeps sticky state when apply fails so the user can retry', async () => {
    useUIStore.getState().setPendingServerUpdate({
      latestVersion: '1.2.0',
      currentVersion: '1.0.0',
      canUpdate: true,
      reason: null,
    })

    invokeMock.mockRejectedValue(new Error('sessions still running'))

    await applyServerUpdate('1.2.0')

    expect(useUIStore.getState().pendingServerUpdate).toEqual({
      latestVersion: '1.2.0',
      currentVersion: '1.0.0',
      canUpdate: true,
      reason: null,
    })
  })
})
