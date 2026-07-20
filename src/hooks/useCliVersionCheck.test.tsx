import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke as transportInvoke } from '@/lib/transport'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { setWsConnected } from '@/lib/environment'
import { useCliVersionCheck } from './useCliVersionCheck'

const mockState = {
  preferences: {
    auto_update_ai_backends: true,
    claude_cli_source: 'jean',
    codex_cli_source: 'jean',
    opencode_cli_source: 'path',
    pi_cli_source: 'jean',
    gh_cli_source: 'jean',
    coderabbit_cli_source: 'jean',
    commandcode_cli_source: 'jean',
  },
  piStatus: { installed: true, version: '1.0.0', path: '/jean/bin/pi' },
  piPathInfo: {
    found: false,
    version: null as string | null,
    path: null as string | null,
    package_manager: null as string | null,
  },
  commandcodeStatus: {
    installed: false,
    version: null as string | null,
    path: null as string | null,
  },
}

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}))

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: mockState.preferences,
    isLoading: false,
  }),
}))

vi.mock('@/services/claude-cli', () => ({
  claudeCliQueryKeys: { all: ['claude-cli'] },
  useClaudeCliStatus: () => ({
    data: { installed: false, version: null, path: null },
    isLoading: false,
  }),
  useAvailableCliVersions: () => ({ data: [], isLoading: false }),
  useClaudePathDetection: () => ({
    data: { found: false, version: null, path: null, package_manager: null },
  }),
}))

vi.mock('@/services/gh-cli', () => ({
  ghCliQueryKeys: { all: ['gh-cli'] },
  useGhCliStatus: () => ({
    data: { installed: false, version: null, path: null },
    isLoading: false,
  }),
  useAvailableGhVersions: () => ({ data: [], isLoading: false }),
  useGhPathDetection: () => ({
    data: { found: false, version: null, path: null, package_manager: null },
  }),
}))

vi.mock('@/services/codex-cli', () => ({
  codexCliQueryKeys: { all: ['codex-cli'] },
  useCodexCliStatus: () => ({
    data: { installed: false, version: null, path: null },
    isLoading: false,
  }),
  useAvailableCodexVersions: () => ({ data: [], isLoading: false }),
  useCodexPathDetection: () => ({
    data: { found: false, version: null, path: null, package_manager: null },
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  opencodeCliQueryKeys: { all: ['opencode-cli'] },
  useOpencodeCliStatus: () => ({
    data: { installed: true, version: '1.0.0', path: '/usr/bin/opencode' },
    isLoading: false,
  }),
  useAvailableOpencodeVersions: () => ({
    data: [{ version: '1.1.0', prerelease: false }],
    isLoading: false,
  }),
  useOpencodePathDetection: () => ({
    data: {
      found: true,
      version: '1.0.0',
      path: '/usr/bin/opencode',
      package_manager: null,
    },
  }),
}))

vi.mock('@/services/pi-cli', () => ({
  piCliQueryKeys: { all: ['pi-cli'] },
  usePiCliStatus: () => ({
    data: mockState.piStatus,
    isLoading: false,
  }),
  useAvailablePiVersions: () => ({
    data: [{ version: '1.1.0', prerelease: false }],
    isLoading: false,
  }),
  usePiPathDetection: () => ({
    data: mockState.piPathInfo,
  }),
}))

vi.mock('@/services/commandcode-cli', () => ({
  commandcodeCliQueryKeys: { all: ['commandcode-cli'] },
  useCommandCodeCliStatus: () => ({
    data: mockState.commandcodeStatus,
    isLoading: false,
  }),
  useAvailableCommandCodeVersions: () => ({
    data: [{ version: '1.1.0', prerelease: false }],
    isLoading: false,
  }),
}))

describe('useCliVersionCheck', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockState.preferences = {
      auto_update_ai_backends: true,
      claude_cli_source: 'jean',
      codex_cli_source: 'jean',
      opencode_cli_source: 'path',
      pi_cli_source: 'jean',
      gh_cli_source: 'jean',
      coderabbit_cli_source: 'jean',
      commandcode_cli_source: 'jean',
    }
    mockState.piStatus = {
      installed: true,
      version: '1.0.0',
      path: '/jean/bin/pi',
    }
    mockState.piPathInfo = {
      found: false,
      version: null,
      path: null,
      package_manager: null,
    }
    mockState.commandcodeStatus = {
      installed: false,
      version: null,
      path: null,
    }
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    setWsConnected(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    queryClient.clear()
    setWsConnected(false)
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
  })

  it('runs mobile-safe CLI updates through the shared transport invoke', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useCliVersionCheck(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await Promise.resolve()

    expect(transportInvoke).toHaveBeenCalledWith('run_cli_path_update', {
      command: '/usr/bin/opencode',
      args: ['upgrade'],
      cliType: 'opencode',
    })
    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it('runs Jean-managed PI updates through the shared transport invoke', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useCliVersionCheck(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await Promise.resolve()

    expect(transportInvoke).toHaveBeenCalledWith('install_pi_cli', {
      version: '1.1.0',
    })
    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it('runs PI PATH updates through the PI self-update command', async () => {
    mockState.preferences.pi_cli_source = 'path'
    mockState.piStatus = {
      installed: true,
      version: '1.0.0',
      path: '/opt/homebrew/bin/pi',
    }
    mockState.piPathInfo = {
      found: true,
      version: '1.0.0',
      path: '/opt/homebrew/bin/pi',
      package_manager: 'homebrew',
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useCliVersionCheck(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await Promise.resolve()

    expect(transportInvoke).toHaveBeenCalledWith('run_cli_path_update', {
      command: '/opt/homebrew/bin/pi',
      args: ['update', '--self'],
      cliType: 'pi',
    })
    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it('auto-updates Jean-managed Command Code', async () => {
    mockState.commandcodeStatus = {
      installed: true,
      version: '1.0.0',
      path: '/jean/bin/cmd',
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useCliVersionCheck(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    await Promise.resolve()

    expect(transportInvoke).toHaveBeenCalledWith('install_commandcode_cli', {
      version: '1.1.0',
    })
  })

  it('updates PATH-managed Command Code through its self-update command', async () => {
    mockState.preferences.commandcode_cli_source = 'path'
    mockState.commandcodeStatus = {
      installed: true,
      version: '1.0.0',
      path: '/opt/homebrew/bin/cmd',
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    renderHook(() => useCliVersionCheck(), { wrapper })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    await Promise.resolve()

    expect(transportInvoke).toHaveBeenCalledWith('run_cli_path_update', {
      command: '/opt/homebrew/bin/cmd',
      args: ['update'],
      cliType: 'commandcode',
    })
  })
})
