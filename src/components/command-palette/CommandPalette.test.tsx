import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'

Element.prototype.scrollIntoView = vi.fn()

const {
  fetchRemoteServerInfo,
  markConnectionSwitch,
  selectConnection,
  selectProject,
  setCommandPaletteOpen,
  showToast,
  warnRemoteVersionMismatch,
  isNativeApp,
} = vi.hoisted(() => ({
  fetchRemoteServerInfo: vi.fn(async () => ({
    ok: true,
    appVersion: '0.1.69',
    webBuildId: '0.1.69-test',
  })),
  markConnectionSwitch: vi.fn(),
  selectConnection: vi.fn(),
  selectProject: vi.fn(),
  setCommandPaletteOpen: vi.fn(),
  showToast: vi.fn(),
  warnRemoteVersionMismatch: vi.fn(() => false),
  isNativeApp: vi.fn(() => true),
}))

const remoteConnections = [
  {
    id: 'remote-1',
    name: 'Active server',
    url: 'https://active.example.com',
    token: 'active-token',
  },
  {
    id: 'remote-2',
    name: 'Build server',
    url: 'https://build.example.com',
    token: 'build-token',
  },
]

vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    commandPaletteOpen: true,
    setCommandPaletteOpen,
  }),
}))

vi.mock('@/hooks/use-command-context', () => ({
  useCommandContext: () => ({ showToast }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: 'project-1',
        name: 'Jean',
        path: '/projects/jean',
        is_folder: false,
      },
      {
        id: 'remote-2:project-1',
        name: 'Jean',
        path: '/projects/jean',
        is_folder: false,
        serverId: 'remote-2',
        serverName: 'Build server',
      },
    ],
  }),
  useAppDataDir: () => ({ data: undefined }),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: { getState: () => ({ clearActiveWorktree: vi.fn() }) },
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ projectAccessTimestamps: {}, selectedProjectId: null }),
    { getState: () => ({ selectProject }) }
  ),
}))

vi.mock('@/lib/commands', () => ({
  getAllCommands: () => [],
  executeCommand: vi.fn(),
}))

vi.mock('@/lib/remote-connections', () => ({
  LOCAL_CONNECTION_ID: 'local',
  getActiveConnectionId: () => 'remote-1',
  getRemoteConnections: () => remoteConnections,
  markConnectionSwitch,
  selectConnection,
  useRemoteConnections: () => remoteConnections,
}))

vi.mock('@/lib/remote-version', () => ({
  fetchRemoteServerInfo,
  warnRemoteVersionMismatch,
}))

vi.mock('@/lib/environment', () => ({ isNativeApp }))

describe('CommandPalette projects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRemoteServerInfo.mockResolvedValue({
      ok: true,
      appVersion: '0.1.69',
      webBuildId: '0.1.69-test',
    })
    warnRemoteVersionMismatch.mockReturnValue(false)
    isNativeApp.mockReturnValue(true)
  })

  it('does not offer global server switching', () => {
    render(<CommandPalette />)

    expect(screen.queryByText('Connections')).not.toBeInTheDocument()
    expect(screen.queryByText('Localhost')).not.toBeInTheDocument()
    expect(
      screen.queryByText('https://build.example.com')
    ).not.toBeInTheDocument()
  })

  it('uses unique project values and shows the owning server', () => {
    render(<CommandPalette />)

    const projectRows = screen
      .getAllByText('Jean')
      .map(label => label.closest('[cmdk-item]'))
    expect(projectRows).toHaveLength(2)
    expect(projectRows[0]?.getAttribute('data-value')).not.toBe(
      projectRows[1]?.getAttribute('data-value')
    )
    expect(screen.getByText('Open on Local')).toBeInTheDocument()
    expect(screen.getByText('Open on Build server')).toBeInTheDocument()
  })

  it('does not show a redundant Local server label in Web Access', () => {
    isNativeApp.mockReturnValue(false)

    render(<CommandPalette />)

    expect(screen.queryByText('Open on Local')).not.toBeInTheDocument()
    expect(screen.queryByText('Open on Build server')).not.toBeInTheDocument()
  })
})
