import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'

Element.prototype.scrollIntoView = vi.fn()

const {
  fetchRemoteServerInfo,
  markConnectionSwitch,
  selectConnection,
  selectProject,
  openServerProject,
  setCommandPaletteOpen,
  showToast,
  warnRemoteVersionMismatch,
  isNativeApp,
  getActiveConnectionId,
  projectStoreState,
  setRailSection,
  setSelectedAgentId,
  agentState,
} = vi.hoisted(() => ({
  fetchRemoteServerInfo: vi.fn(async () => ({
    ok: true,
    appVersion: '0.1.69',
    webBuildId: '0.1.69-test',
  })),
  markConnectionSwitch: vi.fn(),
  selectConnection: vi.fn(),
  selectProject: vi.fn(),
  openServerProject: vi.fn(),
  setCommandPaletteOpen: vi.fn(),
  showToast: vi.fn(),
  warnRemoteVersionMismatch: vi.fn(() => false),
  isNativeApp: vi.fn(() => true),
  getActiveConnectionId: vi.fn(() => 'remote-1'),
  projectStoreState: {
    projectAccessTimestamps: {} as Record<string, number>,
    selectedProjectId: null as string | null,
  },
  setRailSection: vi.fn(),
  setSelectedAgentId: vi.fn(),
  agentState: {
    servers: [] as string[],
    agents: [] as {
      id: string
      name: string
      description: string
      icon: string
      serverId: string
      serverName: string
    }[],
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
  useUIStore: Object.assign(
    () => ({
      commandPaletteOpen: true,
      setCommandPaletteOpen,
    }),
    { getState: () => ({ setRailSection, setSelectedAgentId }) }
  ),
}))

vi.mock('@/components/agents/agents-feature', () => ({
  useAgentsEnabledServers: () => agentState.servers,
}))

vi.mock('@/services/agents', () => ({
  useAgentsList: () => ({ data: agentState.agents }),
}))

vi.mock('@/hooks/use-command-context', () => ({
  useCommandContext: () => ({ showToast }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
}))

vi.mock('@/services/projects', () => ({
  openServerProject,
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
      {
        id: 'server-1',
        name: 'devserver',
        path: '',
        is_folder: false,
        server: { host: 'dev.example.com', user: 'deploy' },
      },
      {
        id: 'server-legacy',
        name: 'old-copy',
        path: '',
        is_folder: false,
        server: { host: 'old.example.com', jean_connection_id: 'remote-1' },
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
    (selector: (state: unknown) => unknown) => selector(projectStoreState),
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
    agentState.servers = []
    agentState.agents = []
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

    fireEvent.change(
      screen.getByPlaceholderText('Type a command or search...'),
      {
        target: { value: 'tool' },
      }
    )

    expect(
      visibleProjectNames().map(name =>
        name?.replace(/^./, '').replace(/Open on .*/, '')
      )
    ).toEqual(['Active Tool', 'Build Tool', 'Local Tool'])
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

  it('lists servers in their own group and opens them as servers', () => {
    render(<CommandPalette />)

    const serverRow = screen.getByText('devserver').closest('[cmdk-item]')
    const group = serverRow?.closest('[cmdk-group]')
    expect(group).toHaveTextContent(/^Servers/)
    expect(group).not.toHaveTextContent('Local Tool')
    expect(serverRow).toHaveTextContent('deploy@dev.example.com')
    expect(screen.queryByText('old-copy')).not.toBeInTheDocument()

    fireEvent.click(serverRow as Element)

    expect(openServerProject).toHaveBeenCalledWith('server-1', {})
    expect(selectProject).not.toHaveBeenCalled()
  })

  it('leaves the Agents page when a project is selected', () => {
    render(<CommandPalette />)

    fireEvent.click(
      screen.getByText('Local Tool').closest('[cmdk-item]') as Element
    )

    expect(setRailSection).toHaveBeenCalledWith('workspace')
    expect(selectProject).toHaveBeenCalledWith('project-2')
  })
})

describe('CommandPalette agents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativeApp.mockReturnValue(true)
    getActiveConnectionId.mockReturnValue('local')
    projectStoreState.selectedProjectId = null
    agentState.servers = ['local']
    agentState.agents = [
      {
        id: 'jean',
        name: 'Jean',
        description: 'The boss',
        icon: 'jean',
        serverId: 'local',
        serverName: 'Local',
      },
      {
        id: 'remote-2:reviewer',
        name: 'Reviewer',
        description: 'Reviews PRs',
        icon: 'blue',
        serverId: 'remote-2',
        serverName: 'Build server',
      },
    ]
  })

  it('lists agents and opens the selected agent', () => {
    render(<CommandPalette />)

    const row = screen.getByText('Reviewer').closest('[cmdk-item]')
    expect(row?.closest('[cmdk-group]')).toHaveTextContent(/^Agents/)
    expect(row).toHaveTextContent('Reviews PRs · Build server')

    fireEvent.click(row as Element)

    expect(setRailSection).toHaveBeenCalledWith('agents')
    expect(setSelectedAgentId).toHaveBeenCalledWith('remote-2:reviewer')
  })

  it('hides agents when the feature is off', () => {
    agentState.servers = []

    render(<CommandPalette />)

    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument()
  })
})
