import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import type * as Environment from '@/lib/environment'

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
  openSessionInWorktree,
  openPreferencesEntry,
  sessionState,
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
  openSessionInWorktree: vi.fn(),
  openPreferencesEntry: vi.fn(),
  sessionState: {
    entries: [] as unknown[],
    hits: [] as unknown[],
  },
  agentState: {
    pageOpen: false,
    selectedAgentId: 'jean',
    leftAt: 0,
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
    (selector?: (state: Record<string, unknown>) => unknown) => {
      const state = {
        commandPaletteOpen: true,
        setCommandPaletteOpen,
        selectedAgentId: agentState.selectedAgentId,
        agentsLeftAt: agentState.leftAt,
      }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        setRailSection,
        setSelectedAgentId,
        openPreferencesEntry,
      }),
    }
  ),
}))

vi.mock('@/components/agents/agents-feature', () => ({
  useAgentsEnabledServers: () => agentState.servers,
  useShowAgents: () => agentState.pageOpen,
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

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof Environment>()),
  isNativeApp,
}))

vi.mock('@/services/chat', () => ({
  useAllSessions: () => ({ data: { entries: sessionState.entries } }),
  useSessionMessageSearch: () => ({
    data: { hits: sessionState.hits, truncated: false },
  }),
}))

vi.mock('@/components/chat/open-session', () => ({ openSessionInWorktree }))

const worktreeEntry = {
  project_id: 'project-1',
  project_name: 'Jean',
  worktree_id: 'wt-1',
  worktree_name: 'fix-login',
  worktree_path: '/w/fix-login',
  sessions: [
    {
      id: 'session-1',
      name: 'Refactor palette',
      updated_at: 100,
      backend: 'claude',
    },
    {
      id: 'session-archived',
      name: 'Refactor old palette',
      updated_at: 50,
      archived_at: 60,
    },
  ],
}

const typeSearch = (text: string) =>
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } })

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
    agentState.pageOpen = false
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
    // Only projects from another server get a server badge
    expect(screen.queryByText('Local')).not.toBeInTheDocument()
    expect(screen.getAllByText('Build server')).not.toHaveLength(0)
  })

  it('does not show a redundant Local server label in Web Access', () => {
    isNativeApp.mockReturnValue(false)

    render(<CommandPalette />)

    expect(screen.queryByText('Local')).not.toBeInTheDocument()
    expect(screen.queryByText('Build server')).not.toBeInTheDocument()
  })

  it('shows projects from the active instance first before and after filtering', () => {
    render(<CommandPalette />)

    const visibleProjectNames = () =>
      screen
        .getAllByRole('option')
        .filter(row =>
          row.closest('[cmdk-group]')?.textContent?.startsWith('Projects')
        )
        .map(row => row.textContent)

    expect(visibleProjectNames()[0]).toContain('Active Tool')

    fireEvent.change(
      screen.getByPlaceholderText(
        'Search sessions, messages, settings and commands…'
      ),
      {
        target: { value: 'tool' },
      }
    )

    expect(
      visibleProjectNames().map(name =>
        name?.replace(/^./, '').replace(/(Active|Build) server$/, '')
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

  it('hides the current project in the project view', () => {
    projectStoreState.selectedProjectId = 'project-2'

    render(<CommandPalette />)

    expect(screen.queryByText('Local Tool')).not.toBeInTheDocument()
  })

  it('lists the current project on the Agents page to switch back to it', () => {
    projectStoreState.selectedProjectId = 'project-2'
    agentState.pageOpen = true

    render(<CommandPalette />)

    expect(screen.getByText('Local Tool')).toBeInTheDocument()
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
    projectStoreState.projectAccessTimestamps = {}
    agentState.pageOpen = false
    agentState.selectedAgentId = 'jean'
    agentState.leftAt = 0
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
    expect(row).toHaveTextContent('Build server')
    expect(row).not.toHaveTextContent('Reviews PRs')

    fireEvent.click(row as Element)

    expect(setRailSection).toHaveBeenCalledWith('agents')
    expect(setSelectedAgentId).toHaveBeenCalledWith('remote-2:reviewer')
  })

  it('lists the previous agent first after switching to a project', () => {
    agentState.selectedAgentId = 'remote-2:reviewer'
    agentState.leftAt = 200
    projectStoreState.projectAccessTimestamps = { 'project-2': 100 }

    render(<CommandPalette />)

    const first = document.querySelector('[cmdk-item]')
    expect(first).toHaveTextContent('Reviewer')
  })

  it('keeps projects first when a project was opened after the agent', () => {
    agentState.selectedAgentId = 'remote-2:reviewer'
    agentState.leftAt = 100
    projectStoreState.projectAccessTimestamps = { 'project-2': 200 }

    render(<CommandPalette />)

    const first = document.querySelector('[cmdk-item]')
    expect(first?.closest('[cmdk-group]')).toHaveTextContent(/^Projects/)
  })

  it('hides agents when the feature is off', () => {
    agentState.servers = []

    render(<CommandPalette />)

    expect(screen.queryByText('Reviewer')).not.toBeInTheDocument()
  })
})

describe('CommandPalette search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentState.servers = []
    agentState.agents = []
    sessionState.entries = [worktreeEntry]
    sessionState.hits = []
  })

  it('lists matching sessions only while typing, without archived ones', () => {
    render(<CommandPalette />)
    expect(screen.queryByText('Refactor palette')).not.toBeInTheDocument()

    typeSearch('refactor')

    const row = screen.getByText('Refactor palette').closest('[cmdk-item]')
    expect(row?.closest('[cmdk-group]')).toHaveTextContent(/^Sessions/)
    expect(row).toHaveTextContent('Jean · fix-login')
    expect(screen.queryByText('Refactor old palette')).not.toBeInTheDocument()
  })

  it('opens the selected session in its worktree and closes the palette', () => {
    render(<CommandPalette />)
    typeSearch('fix-login')

    fireEvent.click(screen.getByText('Refactor palette'))

    expect(setCommandPaletteOpen).toHaveBeenCalledWith(false)
    expect(openSessionInWorktree).toHaveBeenCalledWith(
      { id: 'wt-1', path: '/w/fix-login', project_id: 'project-1' },
      'session-1'
    )
  })

  it('shows message hits with their snippet and drops sessions already listed', () => {
    sessionState.hits = [
      {
        session_id: 'session-1',
        session_name: 'Refactor palette',
        project_id: 'project-1',
        project_name: 'Jean',
        worktree_id: 'wt-1',
        worktree_name: 'fix-login',
        worktree_path: '/w/fix-login',
        snippet: 'the refactor plan',
        match_count: 1,
        updated_at: 100,
      },
      {
        session_id: 'session-2',
        session_name: 'Planning',
        project_id: 'project-2',
        project_name: 'Local Tool',
        worktree_id: 'wt-2',
        worktree_name: 'main',
        worktree_path: '/w/main',
        snippet: 'we should refactor the router',
        match_count: 2,
        updated_at: 90,
      },
    ]
    render(<CommandPalette />)
    typeSearch('refactor')

    const group = screen.getByText('In messages').closest('[cmdk-group]')
    expect(group).toHaveTextContent('Planning')
    expect(group).toHaveTextContent('we should refactor the router')
    expect(group).not.toHaveTextContent('Refactor palette')
  })

  it('opens settings at the selected entry', () => {
    render(<CommandPalette />)
    typeSearch('keybindings')

    const group = screen
      .getByText('Settings', { selector: '[cmdk-group-heading]' })
      .closest('[cmdk-group]')
    const first = group?.querySelector('[cmdk-item]') as HTMLElement
    fireEvent.click(first)

    expect(openPreferencesEntry).toHaveBeenCalledWith(expect.any(String))
    expect(setCommandPaletteOpen).toHaveBeenCalledWith(false)
  })
})
