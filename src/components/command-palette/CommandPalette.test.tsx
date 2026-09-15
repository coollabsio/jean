import { fireEvent, render, screen } from '@testing-library/react'
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
  getActiveConnectionId,
  projectStoreState,
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
  getActiveConnectionId: vi.fn(() => 'remote-1'),
  projectStoreState: {
    projectAccessTimestamps: {} as Record<string, number>,
    selectedProjectId: null as string | null,
  },
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
      {
        id: 'remote-1:project-2',
        name: 'Active Tool',
        path: '/projects/active-tool',
        is_folder: false,
        serverId: 'remote-1',
        serverName: 'Active server',
      },
      {
        id: 'remote-2:project-2',
        name: 'Build Tool',
        path: '/projects/build-tool',
        is_folder: false,
        serverId: 'remote-2',
        serverName: 'Build server',
      },
      {
        id: 'project-2',
        name: 'Local Tool',
        path: '/projects/local-tool',
        is_folder: false,
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
      selector(projectStoreState),
    { getState: () => ({ selectProject }) }
  ),
}))

vi.mock('@/lib/commands', () => ({
  getAllCommands: () => [],
  executeCommand: vi.fn(),
}))

vi.mock('@/lib/remote-connections', () => ({
  LOCAL_CONNECTION_ID: 'local',
  getActiveConnectionId,
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
    getActiveConnectionId.mockReturnValue('remote-1')
    projectStoreState.selectedProjectId = null
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
    expect(screen.getAllByText('Open on Local')).not.toHaveLength(0)
    expect(screen.getAllByText('Open on Build server')).not.toHaveLength(0)
  })

  it('does not show a redundant Local server label in Web Access', () => {
    isNativeApp.mockReturnValue(false)

    render(<CommandPalette />)

    expect(screen.queryByText('Open on Local')).not.toBeInTheDocument()
    expect(screen.queryByText('Open on Build server')).not.toBeInTheDocument()
  })

  it('shows projects from the active instance first before and after filtering', () => {
    render(<CommandPalette />)

    const visibleProjectNames = () =>
      screen.getAllByRole('option').map(row => row.textContent)

    expect(visibleProjectNames()[0]).toContain('Active Tool')

    fireEvent.change(screen.getByPlaceholderText('Type a command or search...'), {
      target: { value: 'tool' },
    })

    expect(
      visibleProjectNames().map(name =>
        name?.replace(/^./, '').replace(/Open on .*/, '')
      )
    )
      .toEqual(['Active Tool', 'Build Tool', 'Local Tool'])
  })

  it('treats unscoped projects as local when local is active', () => {
    getActiveConnectionId.mockReturnValue('local')

    render(<CommandPalette />)
    const firstProject = screen.getAllByRole('option')[0]

    expect(firstProject).toHaveTextContent('Jean')
  })

  it('uses the selected project owner as the active instance', () => {
    getActiveConnectionId.mockReturnValue('local')
    projectStoreState.selectedProjectId = 'remote-2:project-1'

    render(<CommandPalette />)

    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Build Tool')
  })
})
