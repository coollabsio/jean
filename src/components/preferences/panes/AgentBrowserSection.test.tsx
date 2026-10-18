import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@/lib/transport'
import { AgentBrowserSection } from './AgentBrowserSection'

vi.mock('@/lib/transport', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn() }))
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
  },
}))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: ['claude', 'codex'] }),
}))
vi.mock('@/services/mcp', () => ({ invalidateAllMcpServers: vi.fn() }))
const prefs = vi.hoisted(() => ({
  data: { agent_browser_enabled: false },
  mutateAsync: vi.fn(),
}))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: prefs.data }),
  usePatchPreferences: () => ({
    mutateAsync: prefs.mutateAsync,
    isPending: false,
  }),
}))

const status = {
  installed: false,
  binaryPath: null,
  version: null,
  managedDir: '/tmp/agent-browser-cli',
  managedInstall: false,
  claudeSnippet: '{}',
  codexSnippet: '',
  installHint: 'install agent-browser',
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentBrowserSection />
    </QueryClientProvider>
  )
}

describe('AgentBrowserSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prefs.data = { agent_browser_enabled: false }
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'get_agent_browser_status') return status
      if (command === 'install_agent_browser') {
        return { ...status, installed: true }
      }
      if (command === 'install_agent_browser_mcp') return []
      if (command === 'remove_agent_browser_mcp') return []
      return null
    })
  })

  it('is off by default and does not check the install status', () => {
    renderSection()

    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(screen.queryByRole('button', { name: /retry setup/i })).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('installs the browser and MCP setup when turned on', async () => {
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole('switch'))

    expect(prefs.mutateAsync).toHaveBeenCalledWith({
      agent_browser_enabled: true,
    })
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('install_agent_browser_mcp', {
        backends: ['claude', 'codex'],
      })
    })
  })

  it('removes the MCP setup when turned off', async () => {
    prefs.data = { agent_browser_enabled: true }
    const user = userEvent.setup()
    renderSection()

    await user.click(screen.getByRole('switch'))

    expect(prefs.mutateAsync).toHaveBeenCalledWith({
      agent_browser_enabled: false,
    })
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('remove_agent_browser_mcp')
    })
    expect(invoke).not.toHaveBeenCalledWith('install_agent_browser')
  })

  it('repairs the browser and MCP setup with one action', async () => {
    prefs.data = { agent_browser_enabled: true }
    const user = userEvent.setup()
    renderSection()

    await user.click(
      await screen.findByRole('button', { name: /retry setup/i })
    )

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('install_agent_browser_mcp', {
        backends: ['claude', 'codex'],
      })
    })
    expect(
      screen.queryByRole('button', { name: /install mcp into backends/i })
    ).not.toBeInTheDocument()
  })
})
