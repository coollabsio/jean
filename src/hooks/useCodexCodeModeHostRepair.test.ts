import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCodexCodeModeHostRepair } from './useCodexCodeModeHostRepair'

const invokeMock = vi.fn()

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn() },
}))

describe('useCodexCodeModeHostRepair', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(false)
  })

  it('repairs an existing managed Codex install once at startup', async () => {
    const { rerender } = renderHook(
      ({ installed }) => useCodexCodeModeHostRepair(installed),
      { initialProps: { installed: false } }
    )

    expect(invokeMock).not.toHaveBeenCalled()

    await act(async () => {
      rerender({ installed: true })
    })
    await act(async () => Promise.resolve())

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith(
      'install_missing_codex_code_mode_host'
    )

    await act(async () => {
      rerender({ installed: true })
    })
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
