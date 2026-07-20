import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'

Element.prototype.scrollIntoView = vi.fn()

const {
  markConnectionSwitch,
  reloadApp,
  selectConnection,
  setCommandPaletteOpen,
} = vi.hoisted(() => ({
  markConnectionSwitch: vi.fn(),
  reloadApp: vi.fn(),
  selectConnection: vi.fn(),
  setCommandPaletteOpen: vi.fn(),
}))

vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    commandPaletteOpen: true,
    setCommandPaletteOpen,
  }),
}))

vi.mock('@/hooks/use-command-context', () => ({
  useCommandContext: () => ({ showToast: vi.fn() }),
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
    ],
  }),
  useAppDataDir: () => ({ data: undefined }),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: { getState: () => ({ clearActiveWorktree: vi.fn() }) },
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({ projectAccessTimestamps: {}, selectedProjectId: null }),
}))

vi.mock('@/lib/commands', () => ({
  getAllCommands: () => [],
  executeCommand: vi.fn(),
}))

vi.mock('@/lib/remote-connections', () => ({
  LOCAL_CONNECTION_ID: 'local',
  getActiveConnectionId: () => 'remote-1',
  markConnectionSwitch,
  selectConnection,
  useRemoteConnections: () => [
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
  ],
}))

describe('CommandPalette connections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists localhost and inactive remote connections', () => {
    render(<CommandPalette />)

    expect(screen.getByText('Connections')).toBeInTheDocument()
    expect(screen.getByText('Localhost')).toBeInTheDocument()
    expect(screen.getByText('This device')).toBeInTheDocument()
    expect(screen.getByText('Build server')).toBeInTheDocument()
    expect(screen.getByText('https://build.example.com')).toBeInTheDocument()
    expect(screen.queryByText('Active server')).not.toBeInTheDocument()
  })

  it('lists projects before connections', () => {
    render(<CommandPalette />)

    const projectsHeading = screen.getByText('Projects')
    const connectionsHeading = screen.getByText('Connections')

    expect(
      projectsHeading.compareDocumentPosition(connectionsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('switches connections through the existing reload flow', () => {
    render(<CommandPalette reloadApp={reloadApp} />)

    fireEvent.click(screen.getByText('Localhost'))

    expect(setCommandPaletteOpen).toHaveBeenCalledWith(false)
    expect(markConnectionSwitch).toHaveBeenCalledOnce()
    expect(selectConnection).toHaveBeenCalledWith('local')
    expect(reloadApp).toHaveBeenCalledOnce()
  })
})
