import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { useAgentBrowserUpdateCheck } from './useAgentBrowserUpdateCheck'

vi.mock('@/lib/transport', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/query-client', () => ({
  queryClient: { invalidateQueries: vi.fn(), setQueryData: vi.fn() },
}))
vi.mock('@/lib/environment', () => ({ updateTargetLabel: () => 'Local' }))
vi.mock('@/services/mcp', () => ({ invalidateAllMcpServers: vi.fn() }))
const prefs = vi.hoisted(() => ({
  agent_browser_enabled: true,
  auto_update_ai_backends: false,
}))
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
    prefs.auto_update_ai_backends = false
  })

  afterEach(() => vi.useRealTimers())

  it('does not check for updates when Agent Browser is off', async () => {
    prefs.agent_browser_enabled = false

    renderHook(() => useAgentBrowserUpdateCheck())
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(invoke).not.toHaveBeenCalled()
  })

  it('updates in the background when auto-update is on', async () => {
    prefs.auto_update_ai_backends = true
    vi.mocked(invoke).mockResolvedValue({
      installed: true,
      currentVersion: '0.8.0',
      latestVersion: '0.9.0',
      updateAvailable: true,
    })

    renderHook(() => useAgentBrowserUpdateCheck())
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      'check_agent_browser_update',
      'install_agent_browser',
      'install_agent_browser_mcp',
    ])
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith(
      'Agent Browser (Local) updated to 0.9.0',
      { id: undefined }
    )
  })

  it('asks for confirmation after an automatic update fails', async () => {
    prefs.auto_update_ai_backends = true
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'install_agent_browser') throw 'no provenance'
      return {
        installed: true,
        currentVersion: '0.8.0',
        latestVersion: '0.9.0',
        updateAvailable: true,
      }
    })

    renderHook(() => useAgentBrowserUpdateCheck())
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(toast.error).toHaveBeenCalledWith(
      'Agent Browser (Local) update failed: no provenance',
      { id: undefined }
    )

    await act(async () => vi.advanceTimersByTimeAsync(30 * 60_000))
    const installs = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === 'install_agent_browser')
    expect(installs).toHaveLength(1)
    expect(toast.info).toHaveBeenCalledWith(
      'Agent Browser (Local) update available',
      expect.objectContaining({ description: '0.8.0 → 0.9.0' })
    )
  })

  it('asks for confirmation when auto-update is off', async () => {
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
      'Agent Browser (Local) update available',
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
      'Updating Agent Browser (Local)…',
      expect.objectContaining({ id: 'agent-browser-update-progress' })
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith('install_agent_browser')
    expect(invoke).toHaveBeenCalledWith('install_agent_browser_mcp')
  })

  it('checks again every 30 minutes and skips checks during an update', async () => {
    let finishInstall: (value: unknown) => void = () => undefined
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'install_agent_browser') {
        return new Promise(resolve => {
          finishInstall = resolve
        })
      }
      return {
        installed: true,
        currentVersion: '0.8.0',
        latestVersion: '0.9.0',
        updateAvailable: true,
      }
    })
    const checks = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === 'check_agent_browser_update'
        ).length

    renderHook(() => useAgentBrowserUpdateCheck())
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(checks()).toBe(1)

    await act(async () => vi.advanceTimersByTimeAsync(30 * 60_000))
    expect(checks()).toBe(2)
    expect(toast.info).toHaveBeenCalledTimes(2)

    const options = vi.mocked(toast.info).mock.calls[1]?.[1]
    const action = options?.action as { onClick?: () => void } | undefined
    act(() => action?.onClick?.())
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60_000))
    expect(checks()).toBe(2)

    await act(async () => {
      finishInstall({})
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60_000))
    expect(checks()).toBe(3)
  })
})
