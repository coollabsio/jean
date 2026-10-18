import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useAgentBrowserUpdateCheck } from './useAgentBrowserUpdateCheck'

vi.mock('@/lib/transport', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn(), setQueryData: vi.fn() },
}))
vi.mock('@/services/mcp', () => ({ invalidateAllMcpServers: vi.fn() }))
const prefs = vi.hoisted(() => ({ agent_browser_enabled: true }))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: prefs }),
}))
vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    loading: vi.fn(() => 'agent-browser-update'),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}))

describe('useAgentBrowserUpdateCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    prefs.agent_browser_enabled = true
  })

  afterEach(() => vi.useRealTimers())

  it('does not check for updates when Agent Browser is off', async () => {
    prefs.agent_browser_enabled = false

    renderHook(() => useAgentBrowserUpdateCheck())
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(invoke).not.toHaveBeenCalled()
  })

  it('asks for confirmation before it updates Agent Browser', async () => {
    vi.mocked(invoke).mockResolvedValue({
      installed: true,
      currentVersion: '0.8.0',
      latestVersion: '0.9.0',
      updateAvailable: true,
    })

    renderHook(() => useAgentBrowserUpdateCheck())
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(invoke).toHaveBeenCalledWith('check_agent_browser_update')
    expect(invoke).not.toHaveBeenCalledWith('install_agent_browser')
    expect(toast.info).toHaveBeenCalledWith(
      'Agent Browser update available',
      expect.objectContaining({
        description: '0.8.0 → 0.9.0',
        action: expect.objectContaining({ label: 'Update' }),
        cancel: expect.objectContaining({ label: 'Later' }),
      })
    )

    const options = vi.mocked(toast.info).mock.calls[0]?.[1]
    const action = options?.action as { onClick?: () => void } | undefined
    expect(action).toBeTruthy()
    act(() => action?.onClick?.())
    expect(toast.dismiss).toHaveBeenCalledWith('agent-browser-update')
    expect(toast.loading).toHaveBeenCalledWith(
      'Updating Agent Browser…',
      expect.objectContaining({ id: 'agent-browser-update-progress' })
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith('install_agent_browser')
    expect(invoke).toHaveBeenCalledWith('install_agent_browser_mcp')
  })
})
