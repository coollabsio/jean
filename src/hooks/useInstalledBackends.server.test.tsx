import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useInstalledBackends } from './useInstalledBackends'
import {
  SettingsTargetProvider,
  useSettingsTargetServerId,
} from '@/lib/settings-target'

vi.mock('@/lib/environment', () => ({
  hasBackend: () => true,
  hasBackendTransport: () => true,
}))

vi.mock('@/lib/transport', () => ({
  invokeForOptionalServer: async (serverId: string, command: string) => ({
    installed:
      serverId === 'remote-a'
        ? command === 'check_codex_cli_installed'
        : serverId === 'remote-b'
          ? command === 'check_pi_cli_installed'
          : true,
  }),
  invoke: vi.fn(),
  listen: vi.fn(),
  useWsConnectionStatus: () => true,
}))

describe('settings backend availability', () => {
  it('keeps installed backends separate when switching settings instances', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let serverId = 'local'
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <SettingsTargetProvider serverId={serverId}>
          {children}
        </SettingsTargetProvider>
      </QueryClientProvider>
    )
    const { result, rerender, unmount } = renderHook(
      () => useInstalledBackends({ serverId: useSettingsTargetServerId() }),
      { wrapper }
    )

    await waitFor(() =>
      expect(result.current.installedBackends).toHaveLength(9)
    )
    serverId = 'remote-a'
    rerender()
    await waitFor(() =>
      expect(result.current.installedBackends).toEqual(['codex'])
    )
    serverId = 'remote-b'
    rerender()
    await waitFor(() =>
      expect(result.current.installedBackends).toEqual(['pi'])
    )
    serverId = 'local'
    rerender()
    await waitFor(() =>
      expect(result.current.installedBackends).toHaveLength(9)
    )
    unmount()
    queryClient.clear()
  })
})
