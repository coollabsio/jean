import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ProjectTreeItem } from './ProjectTreeItem'
import type { Project, Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'

const mocks = vi.hoisted(() => ({
  worktrees: [] as Worktree[] | undefined,
  worktreeQueryOptions: [] as { enabled?: boolean }[],
  updateSettingsMutate: vi.fn(),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/hooks/useRemotePicker', () => ({
  useRemotePicker: () => (run: (remote?: string) => void) => run(),
}))

vi.mock('@/services/projects', () => ({
  useWorktrees: (_projectId: string, options?: { enabled?: boolean }) => {
    mocks.worktreeQueryOptions.push(options ?? {})
    return { data: mocks.worktrees }
  },
  useAppDataDir: () => ({ data: '' }),
  useUpdateProjectSettings: () => ({
    mutate: mocks.updateSettingsMutate,
    isPending: false,
  }),
}))

vi.mock('@/services/git-status', () => ({
  useFetchWorktreesStatus: () => undefined,
  useGitStatus: () => ({ data: null }),
  gitPush: vi.fn(),
  fetchWorktreesStatus: vi.fn(),
  performGitPull: vi.fn(),
}))

vi.mock('@/components/shared/NewIssuesBadge', () => ({
  NewIssuesBadge: () => null,
}))
vi.mock('@/components/shared/OpenPRsBadge', () => ({
  OpenPRsBadge: () => null,
}))
vi.mock('@/components/shared/FailedRunsBadge', () => ({
  FailedRunsBadge: () => null,
}))
vi.mock('@/components/shared/SecurityAlertsBadge', () => ({
  SecurityAlertsBadge: () => null,
}))

vi.mock('./WorktreeList', () => ({
  WorktreeList: () => <div data-testid="worktree-list" />,
}))

vi.mock('./ProjectContextMenu', () => ({
  ProjectContextMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

const project: Project = {
  id: 'project-1',
  name: 'jean',
  path: '/tmp/jean',
  default_branch: 'main',
  added_at: 0,
  order: 0,
}

const worktree: Worktree = {
  id: 'wt-1',
  project_id: 'project-1',
  name: 'feature',
  path: '/tmp/jean-feature',
  branch: 'feature',
  created_at: 0,
  order: 0,
  status: 'ready',
  session_type: 'worktree',
}

describe('ProjectTreeItem', () => {
  beforeEach(() => {
    mocks.worktrees = [worktree]
    mocks.worktreeQueryOptions = []
    mocks.updateSettingsMutate.mockReset()
    useProjectsStore.setState({
      selectedProjectId: 'project-1',
      selectedWorktreeId: 'wt-1',
      expandedProjectIds: new Set(['project-1']),
      expandedWorktreeIds: new Set(),
      expandedFolderIds: new Set(),
      projectAccessTimestamps: {},
      projectCanvasSettings: {},
      addProjectDialogOpen: false,
      addProjectParentFolderId: null,
      projectSettingsDialogOpen: false,
      projectSettingsProjectId: null,
      projectSettingsInitialPane: null,
      gitInitModalOpen: false,
      gitInitModalPath: null,
      cloneModalOpen: false,
      jeanConfigWizardOpen: false,
      jeanConfigWizardProjectId: null,
      editingFolderId: null,
    })
    useChatStore.setState({
      activeWorktreeId: 'wt-1',
      activeWorktreePath: '/tmp/jean-feature',
    })
  })

  it('does not show project action buttons in the project row', () => {
    render(<ProjectTreeItem project={project} />)

    expect(
      screen.queryByRole('button', { name: 'Project settings' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'New worktree' })
    ).not.toBeInTheDocument()
  })

  it('opens the project canvas without changing sidebar expansion', async () => {
    const user = userEvent.setup()
    render(<ProjectTreeItem project={project} />)

    await user.click(screen.getByTestId('project-row-project-1'))

    const projectsState = useProjectsStore.getState()
    expect(projectsState.selectedProjectId).toBe('project-1')
    expect(projectsState.selectedWorktreeId).toBeNull()
    expect(projectsState.expandedProjectIds.has('project-1')).toBe(true)
    expect(useChatStore.getState().activeWorktreeId).toBeNull()
    expect(useChatStore.getState().activeWorktreePath).toBeNull()
  })

  it('toggles sidebar worktrees only from the chevron', async () => {
    const user = userEvent.setup()
    render(<ProjectTreeItem project={project} />)

    await user.click(screen.getByRole('button', { name: 'Collapse project' }))

    const projectsState = useProjectsStore.getState()
    expect(projectsState.selectedWorktreeId).toBe('wt-1')
    expect(projectsState.expandedProjectIds.has('project-1')).toBe(false)
    expect(useChatStore.getState().activeWorktreeId).toBe('wt-1')
    expect(useChatStore.getState().activeWorktreePath).toBe('/tmp/jean-feature')
  })

  it('disables worktree loading for collapsed, unselected projects', () => {
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
      expandedProjectIds: new Set(),
    })

    render(<ProjectTreeItem project={project} />)

    expect(mocks.worktreeQueryOptions.at(-1)).toEqual({ enabled: false })
    expect(
      screen.getByRole('button', { name: 'Expand project' })
    ).toBeInTheDocument()
  })

  it('uses the project summary count without loading collapsed workspaces', () => {
    mocks.worktrees = undefined
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
      expandedProjectIds: new Set(),
    })

    render(<ProjectTreeItem project={{ ...project, worktree_count: 3 }} />)

    expect(mocks.worktreeQueryOptions.at(-1)).toEqual({ enabled: false })
    expect(
      screen.getByRole('status', { name: '3 workspaces' })
    ).toHaveTextContent('3')
  })

  it('prefers loaded worktrees over a stale project summary count', () => {
    mocks.worktrees = []
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
      expandedProjectIds: new Set(),
    })

    render(<ProjectTreeItem project={{ ...project, worktree_count: 2 }} />)

    expect(
      screen.queryByRole('status', { name: '2 workspaces' })
    ).not.toBeInTheDocument()
  })

  it('hides the count when workspaces are shown', () => {
    render(<ProjectTreeItem project={{ ...project, worktree_count: 1 }} />)

    expect(
      screen.queryByRole('status', { name: '1 workspace' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('worktree-list')).toBeInTheDocument()
  })

  it('loads and shows worktrees that match the sidebar search', () => {
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
      expandedProjectIds: new Set(),
    })

    render(<ProjectTreeItem project={project} searchQuery="feature" />)

    expect(mocks.worktreeQueryOptions.at(-1)).toEqual({ enabled: true })
    expect(screen.getByTestId('project-row-project-1')).toBeInTheDocument()
    expect(screen.getByTestId('worktree-list')).toBeInTheDocument()
  })

  it('hides projects that do not match the sidebar search', () => {
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
      expandedProjectIds: new Set(),
    })

    render(<ProjectTreeItem project={project} searchQuery="missing" />)

    expect(screen.queryByTestId('project-row-project-1')).toBeNull()
  })

  it('opens project canvas when the project has no worktrees', async () => {
    mocks.worktrees = []
    const user = userEvent.setup()
    render(<ProjectTreeItem project={project} />)

    await user.click(screen.getByTestId('project-row-project-1'))

    expect(useProjectsStore.getState().selectedProjectId).toBe('project-1')
    expect(useProjectsStore.getState().selectedWorktreeId).toBeNull()
    expect(useChatStore.getState().activeWorktreeId).toBeNull()
    expect(useChatStore.getState().activeWorktreePath).toBeNull()
  })

  it('starts inline rename on double-click and renames on Enter', async () => {
    const user = userEvent.setup()
    render(<ProjectTreeItem project={project} />)

    await user.dblClick(screen.getByTestId('project-row-project-1'))

    const input = screen.getByRole('textbox', { name: 'Project name' })
    expect(input).toHaveValue('jean')

    await user.clear(input)
    await user.type(input, 'jean-app{Enter}')

    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      projectId: 'project-1',
      name: 'jean-app',
    })
  })

  it('keeps cached offline projects read-only without a repeated server badge', async () => {
    mocks.worktrees = []
    useProjectsStore.setState({ selectedProjectId: null })
    const user = userEvent.setup()
    render(
      <ProjectTreeItem
        project={{
          ...project,
          id: 'remote:project-1',
          serverId: 'remote',
          serverName: 'Build',
          offline: true,
        }}
      />
    )

    expect(screen.queryByText('Build')).toBeNull()
    expect(screen.getByText('Offline')).toBeInTheDocument()
    await user.click(screen.getByTestId('project-row-remote:project-1'))
    expect(useProjectsStore.getState().selectedProjectId).toBeNull()
  })
})
