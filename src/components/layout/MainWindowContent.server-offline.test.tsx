/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MainWindowContent } from './MainWindowContent'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import type { ServerConnectionSnapshot } from '@/lib/server-connections'

const REMOTE_PROJECT_ID = 'dev:project-1'
const snapshots = new Map<string, ServerConnectionSnapshot>()

function setRemoteStatus(
  status: ServerConnectionSnapshot['status'],
  lastConnectedAt: number | null = 1
) {
  snapshots.set('dev', {
    serverId: 'dev',
    name: 'DEV Server',
    status,
    lastConnectedAt,
    error: null,
    appVersion: null,
    capabilities: {},
  })
}

vi.mock('@/lib/server-connections', () => ({
  useServerConnectionSnapshots: () => snapshots,
  reconnectRemoteServer: vi.fn(),
}))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/services/projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: REMOTE_PROJECT_ID,
        name: 'coolify',
        path: '/srv/coolify',
        serverId: 'dev',
      },
    ],
  }),
}))
vi.mock('@/components/agents/agents-feature', () => ({
  useShowAgents: () => false,
}))
vi.mock('@/components/agents/AgentNotificationsListener', () => ({
  AgentNotificationsListener: () => null,
}))
vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: [], isLoading: false }),
}))
vi.mock('@/components/chat/ChatWindow', () => ({
  ChatWindow: () => <div data-testid="chat-window">Chat</div>,
}))
vi.mock('@/components/dashboard/ProjectCanvasView', () => ({
  ProjectCanvasView: () => <div data-testid="project-canvas">Canvas</div>,
}))

describe('MainWindowContent with an unreachable server', () => {
  beforeEach(() => {
    snapshots.clear()
    useProjectsStore.setState({ selectedProjectId: REMOTE_PROJECT_ID })
    useChatStore.setState({ activeWorktreeId: null, activeWorktreePath: null })
  })

  it('shows the project canvas when the server is online', async () => {
    setRemoteStatus('online')
    render(<MainWindowContent />)
    expect(await screen.findByTestId('project-canvas')).toBeTruthy()
  })

  it('hides the project canvas when the server goes offline', () => {
    setRemoteStatus('connecting')
    render(<MainWindowContent />)
    expect(screen.queryByTestId('project-canvas')).toBeNull()
    expect(screen.getByText('DEV Server is offline')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  })

  it('hides the chat of a worktree on an offline server', () => {
    setRemoteStatus('auth-error')
    useChatStore.setState({
      activeWorktreeId: 'dev:worktree-1',
      activeWorktreePath: '/srv/coolify-wt',
    })
    render(<MainWindowContent />)
    expect(screen.queryByTestId('chat-window')).toBeNull()
    expect(screen.getByText('DEV Server is offline')).toBeTruthy()
  })

  it('shows a connecting state before the first connection', () => {
    setRemoteStatus('connecting', null)
    render(<MainWindowContent />)
    expect(screen.queryByTestId('project-canvas')).toBeNull()
    expect(screen.getByText('Connecting to DEV Server…')).toBeTruthy()
  })

  it('keeps local chats visible', async () => {
    setRemoteStatus('connecting')
    useChatStore.setState({
      activeWorktreeId: 'local-worktree',
      activeWorktreePath: '/home/me/wt',
    })
    render(<MainWindowContent />)
    expect(await screen.findByTestId('chat-window')).toBeTruthy()
  })
})
