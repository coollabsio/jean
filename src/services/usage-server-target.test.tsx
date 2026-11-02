import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useClaudeUsage } from './claude-cli'
import { useCodexUsage } from './codex-cli'
import { useGrokUsage } from './grok-cli'
import { SettingsTargetProvider } from '@/lib/settings-target'

vi.mock('@/lib/environment', () => ({
  hasBackend: () => true,
  hasBackendTransport: () => true,
}))

vi.mock('@/lib/transport', () => ({
  invokeForOptionalServer: async (
    serverId: string | undefined,
    command: string
  ) => ({ command, server: serverId ?? 'local', fetchedAt: 1 }),
  listen: vi.fn(),
  useWsConnectionStatus: () => true,
}))

describe('usage queries follow the settings target server', () => {
  it.each([
    ['claude', useClaudeUsage, 'get_claude_usage'],
    ['codex', useCodexUsage, 'get_codex_usage'],
    ['grok', useGrokUsage, 'get_grok_usage'],
  ] as const)('%s usage', async (_name, useUsage, command) => {
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
    const { result, rerender, unmount } = renderHook(() => useUsage(), {
      wrapper,
    })

    await waitFor(() =>
      expect(result.current.data).toEqual({
        command,
        server: 'local',
        fetchedAt: 1,
      })
    )
    serverId = 'remote-a'
    rerender()
    await waitFor(() =>
      expect(result.current.data).toEqual({
        command,
        server: 'remote-a',
        fetchedAt: 1,
      })
    )
    unmount()
    queryClient.clear()
  })
})
