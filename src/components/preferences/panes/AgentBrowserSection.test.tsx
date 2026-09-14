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

const status = {
  installed: false,
  binaryPath: null,
  version: null,
  profilePath: '/tmp/agent-browser/profile',
  profileExists: false,
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
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'get_agent_browser_status') return status
      if (command === 'install_agent_browser') {
        return { ...status, installed: true, profileExists: true }
      }
      if (command === 'install_agent_browser_mcp') return []
      return null
    })
  })

  it('installs the browser and MCP configuration with one action', async () => {
    const user = userEvent.setup()
    renderSection()

    await user.click(
      await screen.findByRole('button', { name: /^install agent-browser$/i })
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
