import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryClient } from '@/lib/query-client'
import { useUIStore } from '@/store/ui-store'
import {
  clearServerResourcePaths,
  registerServerResourcePath,
} from '@/lib/server-command-routing'
import { openMcpLogin, refreshMcpLoginHealth } from './mcp-auth'

const { invoke, toast } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: {
    loading: vi.fn(() => 'loading'),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}))
vi.mock('@/lib/transport', () => ({ invokeForOptionalServer: invoke }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/services/mcp', () => ({
  MCP_HEALTH_KEY: 'mcp-health',
  MCP_SERVERS_KEY: 'mcp-servers',
}))

const prepared = {
  command: '/managed/claude',
  commandArgs: ['mcp', 'login', '--no-browser', 'orbit-dev'],
  worktreePath: '/repo',
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  clearServerResourcePaths()
  useUIStore.getState().closeCliLoginModal()
  invoke.mockResolvedValue(prepared)
})
afterEach(() => queryClient.clear())

describe('MCP sign-in', () => {
  it('opens the selected backend with prepared arguments and directory', async () => {
    expect(await openMcpLogin('claude', 'orbit-dev', '/repo')).toBe(true)
    expect(useUIStore.getState()).toMatchObject({
      cliLoginModalOpen: true,
      cliLoginModalType: 'claude',
      cliLoginModalCommand: prepared.command,
      cliLoginModalCommandArgs: prepared.commandArgs,
      cliLoginModalAction: 'login',
      cliLoginModalMcpContext: {
        serverName: 'orbit-dev',
        worktreePath: '/repo',
      },
    })
  })

  it('keeps the explicit owner even when two servers have the same path', async () => {
    registerServerResourcePath('remote-a', '/repo')
    registerServerResourcePath('remote-b', '/repo')
    await openMcpLogin('codex', 'orbit-dev', '/repo', 'remote-b')
    expect(invoke.mock.calls[0]).toEqual([
      'remote-b',
      'prepare_mcp_login',
      { backend: 'codex', serverName: 'orbit-dev', worktreePath: '/repo' },
    ])
    expect(useUIStore.getState().cliLoginModalMcpContext?.serverId).toBe(
      'remote-b'
    )
  })

  it('uses the registered path owner without an explicit resource ID', async () => {
    registerServerResourcePath('remote', '/repo')
    await openMcpLogin('claude', 'orbit-dev', '/repo')
    expect(useUIStore.getState().cliLoginModalMcpContext?.serverId).toBe(
      'remote'
    )
  })

  it('shows preparation errors without opening a terminal', async () => {
    invoke.mockRejectedValue(new Error('Update the CLI'))
    expect(await openMcpLogin('claude', 'orbit-dev')).toBe(false)
    expect(useUIStore.getState().cliLoginModalOpen).toBe(false)
    expect(toast.error.mock.calls[0]?.[0]).toContain('Update the CLI')
  })

  it('does not replace another login that opens during preparation', async () => {
    let resolve!: (value: typeof prepared) => void
    invoke.mockReturnValue(new Promise(r => (resolve = r)))
    const pending = openMcpLogin('claude', 'orbit-dev', '/repo')
    useUIStore
      .getState()
      .openCliLoginModal('gh', '/managed/gh', ['auth', 'login'])
    resolve(prepared)
    expect(await pending).toBe(false)
    expect(useUIStore.getState().cliLoginModalType).toBe('gh')
    expect(useUIStore.getState().cliLoginModalMcpContext).toBeNull()
  })

  it('leaves unsupported backends and an already open window unchanged', async () => {
    expect(await openMcpLogin('grok', 'orbit-dev')).toBe(false)
    useUIStore.getState().openCliLoginModal('gh', '/managed/gh')
    expect(await openMcpLogin('claude', 'orbit-dev')).toBe(false)
    expect(useUIStore.getState().cliLoginModalType).toBe('gh')
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('MCP health after sign-in', () => {
  it('refreshes disabled manual queries, including the global empty path', async () => {
    const stale = { statuses: { 'orbit-dev': 'needsAuthentication' } }
    const updated = { statuses: { 'orbit-dev': 'connected' } }
    queryClient.setQueryData(['mcp-health', 'claude', '', 'local'], stale)
    queryClient.setQueryData(['mcp-health', 'claude', '/repo', 'local'], stale)
    queryClient.setQueryData(['mcp-health', 'codex', '/repo', 'local'], stale)
    invoke.mockResolvedValue(updated)
    await refreshMcpLoginHealth('claude', {
      serverName: 'orbit-dev',
      worktreePath: '/home/user',
    })
    expect(
      queryClient.getQueryData(['mcp-health', 'claude', '', 'local'])
    ).toEqual(updated)
    expect(
      queryClient.getQueryData(['mcp-health', 'claude', '/repo', 'local'])
    ).toEqual(updated)
    expect(
      queryClient.getQueryData(['mcp-health', 'codex', '/repo', 'local'])
    ).toEqual(stale)
  })

  it('does not refresh another server with local credentials', async () => {
    registerServerResourcePath('remote', '/remote/repo')
    const stale = { statuses: { 'orbit-dev': 'needsAuthentication' } }
    queryClient.setQueryData(
      ['mcp-health', 'claude', '/remote/repo', 'remote'],
      stale
    )
    queryClient.setQueryData(
      ['mcp-health', 'claude', '/local/repo', 'local'],
      stale
    )
    const updated = { statuses: { 'orbit-dev': 'connected' } }
    invoke.mockResolvedValue(updated)
    await refreshMcpLoginHealth('claude', {
      serverName: 'orbit-dev',
      worktreePath: '/remote/repo',
      serverId: 'remote',
    })
    expect(
      queryClient.getQueryData([
        'mcp-health',
        'claude',
        '/remote/repo',
        'remote',
      ])
    ).toEqual(updated)
    expect(
      queryClient.getQueryData(['mcp-health', 'claude', '/local/repo', 'local'])
    ).toEqual(stale)
  })
})

describe('MCP health refresh races', () => {
  it('keeps identical directories on different servers separate', async () => {
    registerServerResourcePath('remote-a', '/repo')
    registerServerResourcePath('remote-b', '/repo')
    const stale = { statuses: { 'orbit-dev': 'needsAuthentication' } }
    const updated = { statuses: { 'orbit-dev': 'connected' } }
    queryClient.setQueryData(
      ['mcp-health', 'claude', '/repo', 'remote-a'],
      stale
    )
    queryClient.setQueryData(
      ['mcp-health', 'claude', '/repo', 'remote-b'],
      stale
    )
    invoke.mockResolvedValue(updated)
    await refreshMcpLoginHealth('claude', {
      serverName: 'orbit-dev',
      worktreePath: '/repo',
      serverId: 'remote-b',
    })
    expect(
      queryClient.getQueryData(['mcp-health', 'claude', '/repo', 'remote-a'])
    ).toEqual(stale)
    expect(
      queryClient.getQueryData(['mcp-health', 'claude', '/repo', 'remote-b'])
    ).toEqual(updated)
  })

  it('cancels a pre-login health check so it cannot overwrite the new result', async () => {
    const key = ['mcp-health', 'claude', '/repo', 'local']
    let finishOld!: (value: unknown) => void
    const oldCheck = queryClient
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise(resolve => {
            finishOld = resolve
          }),
      })
      .catch(() => undefined)
    const updated = { statuses: { 'orbit-dev': 'connected' } }
    invoke.mockResolvedValue(updated)
    await refreshMcpLoginHealth('claude', {
      serverName: 'orbit-dev',
      worktreePath: '/repo',
    })
    finishOld({ statuses: { 'orbit-dev': 'needsAuthentication' } })
    await oldCheck
    expect(queryClient.getQueryData(key)).toEqual(updated)
  })
})
