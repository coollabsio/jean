import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import {
  ProjectTreeItem,
  resolveProjectRowClickAction,
} from './ProjectTreeItem'
import type { Project, Worktree } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useChatStore } from '@/store/chat-store'

const mocks = vi.hoisted(() => ({
  worktrees: [] as Worktree[],
  updateSettingsMutate: vi.fn(),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/hooks/useRemotePicker', () => ({
  useRemotePicker: () => (run: (remote?: string) => void) => run(),
}))

vi.mock('@/services/projects', () => ({
  useWorktrees: () => ({ data: mocks.worktrees }),
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

describe('resolveProjectRowClickAction', () => {
  it('toggles expand when the project has worktrees', () => {
    expect(resolveProjectRowClickAction(true)).toBe('toggle-expand')
  })

  it('opens canvas when the project has no worktrees', () => {
    expect(resolveProjectRowClickAction(false)).toBe('open-canvas')
  })
})

describe('ProjectTreeItem', () => {
  beforeEach(() => {
    mocks.worktrees = [worktree]
    mocks.updateSettingsMutate.mockReset()
    useProjectsStore.setState({
      selectedProjectId: 'project-1',
      selectedWorktreeId: 'wt-1',
      expandedProjectIds: new Set(['project-1']),
      expandedWorktreeIds: new Set(),
      expandedFolderIds: new Set(),
      projectAccessTimestamps: {},
      projectCanvasSettings: {},
      githubDashboardFavoriteProjectIds: [],
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

  it('toggles expand without clearing the selected worktree/session', async () => {
    const user = userEvent.setup()
    render(<ProjectTreeItem project={project} />)

    await user.click(screen.getByTestId('project-row-project-1'))

    const projectsState = useProjectsStore.getState()
    expect(projectsState.selectedWorktreeId).toBe('wt-1')
    expect(projectsState.expandedProjectIds.has('project-1')).toBe(false)
    expect(useChatStore.getState().activeWorktreeId).toBe('wt-1')
    expect(useChatStore.getState().activeWorktreePath).toBe('/tmp/jean-feature')
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
})
