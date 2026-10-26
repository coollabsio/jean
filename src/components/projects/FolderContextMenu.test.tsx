import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { FolderContextMenu } from './FolderContextMenu'

const mocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
  invoke: vi.fn(),
  projects: [] as Project[],
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/transport', () => ({
  invoke: mocks.invoke,
}))
vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: mocks.projects }),
  useCreateFolder: () => ({ mutate: mocks.createFolder, isPending: false }),
  useDeleteFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useMoveItem: () => ({ mutate: vi.fn(), isPending: false }),
  projectsQueryKeys: {
    worktrees: (projectId: string) => ['projects', 'worktrees', projectId],
  },
}))

function project(partial: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    name: partial.id,
    path: '/tmp',
    default_branch: 'main',
    added_at: 0,
    order: 0,
    ...partial,
  }
}

const folder = project({
  id: 'folder-1',
  name: 'Work',
  is_folder: true,
  path: '',
})

function renderMenu() {
  render(
    <FolderContextMenu folder={folder}>
      <button type="button">Work</button>
    </FolderContextMenu>
  )
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Work' }))
}

describe('FolderContextMenu', () => {
  beforeEach(() => {
    mocks.createFolder.mockReset()
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue([])
    mocks.projects = [
      folder,
      project({
        id: 'child-folder',
        is_folder: true,
        parent_id: 'folder-1',
        path: '',
      }),
      project({ id: 'project-1', parent_id: 'folder-1' }),
      project({ id: 'project-2', parent_id: 'child-folder' }),
    ]
    useProjectsStore.setState({
      expandedFolderIds: new Set(),
      expandedProjectIds: new Set(),
      expandedWorktreeIds: new Set(),
    })
  })

  it('offers new folder, new project, and project expansion', () => {
    renderMenu()

    for (const name of [
      'New Folder',
      'New Project',
      'Expand projects',
      'Collapse projects',
      'Expand projects & sessions',
      'Collapse projects & sessions',
      'Delete Folder(not empty)',
    ]) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
    }
  })

  it('creates a nested folder and expands its parent', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(screen.getByRole('menuitem', { name: 'New Folder' }))

    expect(mocks.createFolder).toHaveBeenCalledWith({
      name: 'New Folder',
      parentId: 'folder-1',
    })
    expect(useProjectsStore.getState().expandedFolderIds.has('folder-1')).toBe(
      true
    )
  })

  it('expands nested projects and their sessions', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockImplementation(
      async (_command: string, args: { projectId: string }) => [
        { id: `wt-${args.projectId}`, origin: 'manual' },
        { id: 'fix', origin: 'auto_fix' },
      ]
    )
    renderMenu()

    await user.click(
      screen.getByRole('menuitem', { name: 'Expand projects & sessions' })
    )

    await waitFor(() => {
      expect(
        [...useProjectsStore.getState().expandedWorktreeIds].sort()
      ).toEqual(['wt-project-1', 'wt-project-2'])
    })
    expect([...useProjectsStore.getState().expandedProjectIds].sort()).toEqual([
      'project-1',
      'project-2',
    ])
    expect(
      useProjectsStore.getState().expandedFolderIds.has('child-folder')
    ).toBe(true)
  })

  it('disables New Folder at the maximum nesting depth', () => {
    const deep = project({
      id: 'deep',
      name: 'Deep',
      is_folder: true,
      path: '',
      parent_id: 'child-folder',
    })
    mocks.projects = [
      folder,
      project({
        id: 'child-folder',
        is_folder: true,
        parent_id: 'folder-1',
        path: '',
      }),
      deep,
    ]
    render(
      <FolderContextMenu folder={deep}>
        <button type="button">Deep</button>
      </FolderContextMenu>
    )
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Deep' }))

    expect(
      screen.getByRole('menuitem', { name: 'New Folder' })
    ).toHaveAttribute('data-disabled')
  })
})
