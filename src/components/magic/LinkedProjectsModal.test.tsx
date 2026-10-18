import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { LinkedProjectsModal } from './LinkedProjectsModal'

const mutateMock = vi.fn()
let projectsMock: Project[] = []
const remoteConnectionMock = vi.hoisted(() => ({
  activeName: null as string | null,
  connections: [] as { name: string; url: string }[],
}))

vi.mock('@/lib/remote-connections', () => ({
  getActiveRemoteConnection: () =>
    remoteConnectionMock.activeName
      ? { name: remoteConnectionMock.activeName }
      : null,
  getRemoteConnections: () => remoteConnectionMock.connections,
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: projectsMock }),
  useUpdateProjectSettings: () => ({ mutate: mutateMock }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

function project(overrides: Partial<Project>): Project {
  return {
    id: 'project-id',
    name: 'project-name',
    path: '/tmp/project-name',
    default_branch: 'main',
    added_at: 1,
    order: 1,
    ...overrides,
  }
}

function renderModal() {
  return render(
    <LinkedProjectsModal
      open
      onOpenChange={vi.fn()}
      projectId="current-project"
    />
  )
}

describe('LinkedProjectsModal', () => {
  beforeEach(() => {
    mutateMock.mockReset()
    remoteConnectionMock.activeName = null
    remoteConnectionMock.connections = []
    projectsMock = [
      project({
        id: 'current-project',
        name: 'current',
        linked_project_ids: ['architecture'],
      }),
      project({ id: 'architecture', name: 'architecture' }),
      project({ id: 'jean', name: 'jean' }),
      project({ id: 'coolify', name: 'coolify' }),
      project({ id: 'coolify-io', name: 'coolify.io' }),
      project({ id: 'coolpack', name: 'coolpack' }),
      project({ id: 'folder', name: 'folder', is_folder: true }),
    ]
  })

  it('adds the selected visible project with ArrowDown and Enter', async () => {
    const user = userEvent.setup()
    renderModal()

    const search = screen.getByPlaceholderText('Search projects...')
    await user.click(search)
    await user.keyboard('{ArrowDown}{Enter}')

    expect(mutateMock).toHaveBeenCalledWith(
      {
        projectId: 'current-project',
        linkedProjectIds: ['architecture', 'coolify'],
      },
      expect.any(Object)
    )
  })

  it('uses filtered results for Enter selection', async () => {
    const user = userEvent.setup()
    renderModal()

    const search = screen.getByPlaceholderText('Search projects...')
    await user.type(search, 'pack')
    await user.keyboard('{Enter}')

    expect(mutateMock).toHaveBeenCalledWith(
      {
        projectId: 'current-project',
        linkedProjectIds: ['architecture', 'coolpack'],
      },
      expect.any(Object)
    )
  })

  it('uses a distinct input surface from the modal background', () => {
    renderModal()

    expect(screen.getByPlaceholderText('Search projects...')).toHaveClass(
      'bg-muted/40',
      'dark:bg-input/50',
      'shadow-sm'
    )
  })

  it('gives the project list a scrollable fixed-height viewport', () => {
    renderModal()

    const viewport = document.querySelector(
      '[data-slot="scroll-area-viewport"]'
    )
    expect(viewport?.parentElement).toHaveClass('h-48', 'min-h-0')
    expect(viewport).toHaveClass('overflow-y-auto')
  })

  it('shows the serving instance instead of Local in Web Access', () => {
    renderModal()

    expect(screen.getAllByText(window.location.host).length).toBeGreaterThan(0)
    expect(screen.queryByText('Local')).not.toBeInTheDocument()
  })

  it('uses the custom name of the active remote instance', () => {
    remoteConnectionMock.activeName = 'Production'

    renderModal()

    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
    expect(screen.queryByText(window.location.host)).not.toBeInTheDocument()
  })

  it('uses the saved custom name when Web Access serves that connection', () => {
    remoteConnectionMock.connections = [
      { name: 'Production', url: window.location.origin },
    ]

    renderModal()

    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
    expect(screen.queryByText(window.location.host)).not.toBeInTheDocument()
  })

  it('shows instance names and only offers projects from the current instance', () => {
    projectsMock = [
      project({
        id: 'dev:current-project',
        resourceId: 'current-project',
        name: 'current',
        serverId: 'dev',
        serverName: 'DEV Server',
      }),
      project({
        id: 'dev:jean-dev',
        resourceId: 'jean-dev',
        name: 'jean',
        serverId: 'dev',
        serverName: 'DEV Server',
      }),
      project({ id: 'jean-local', name: 'jean' }),
    ]

    render(
      <LinkedProjectsModal
        open
        onOpenChange={vi.fn()}
        projectId="dev:current-project"
      />
    )

    expect(screen.getByText('DEV Server')).toBeInTheDocument()
    expect(screen.getAllByText('jean')).toHaveLength(1)
    expect(screen.queryByText('Local')).not.toBeInTheDocument()
  })
})
