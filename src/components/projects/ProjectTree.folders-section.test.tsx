import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { ProjectTree } from './ProjectTree'

const mocks = vi.hoisted(() => ({
  createFolder: vi.fn(),
}))

vi.mock('@/services/projects', () => ({
  useReorderItems: () => ({ mutate: vi.fn() }),
  useMoveItem: () => ({ mutate: vi.fn() }),
  useCreateFolder: () => ({ mutate: mocks.createFolder, isPending: false }),
}))
vi.mock('./FolderTreeItem', () => ({
  FolderTreeItem: ({
    folder,
    children,
  }: {
    folder: Project
    children: React.ReactNode
  }) => (
    <div>
      <span>{folder.name}</span>
      {children}
    </div>
  ),
}))
vi.mock('./ProjectTreeItem', () => ({
  ProjectTreeItem: ({ project }: { project: Project }) => (
    <span>{project.name}</span>
  ),
}))

const projects: Project[] = [
  {
    id: 'folder-1',
    name: 'My folder',
    path: '',
    default_branch: '',
    added_at: 0,
    order: 0,
    is_folder: true,
  },
  {
    id: 'project-1',
    name: 'Standalone project',
    path: '/tmp/project',
    default_branch: 'main',
    added_at: 0,
    order: 1,
  },
]

describe('ProjectTree Folders section', () => {
  beforeEach(() => {
    mocks.createFolder.mockReset()
    useProjectsStore.setState({
      expandedFolderIds: new Set(),
      expandedProjectIds: new Set(),
      addProjectDialogOpen: false,
    })
  })

  it('hides only the Folders section and preserves individual folder state', async () => {
    const user = userEvent.setup()
    render(<ProjectTree projects={projects} />)

    await user.click(screen.getByRole('button', { name: 'Hide folders' }))
    expect(screen.queryByText('My folder')).not.toBeInTheDocument()
    expect(screen.getByText('Standalone project')).toBeInTheDocument()
    expect(useProjectsStore.getState().expandedFolderIds.size).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Show folders' }))
    expect(screen.getByText('My folder')).toBeInTheDocument()
  })

  it('keeps bulk folder actions in the header context menu', async () => {
    const user = userEvent.setup()
    render(<ProjectTree projects={projects} />)

    await user.click(screen.getByRole('button', { name: 'Hide folders' }))
    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByText('Folders'),
    })
    await user.click(screen.getByRole('menuitem', { name: 'Expand all' }))
    expect(useProjectsStore.getState().expandedFolderIds.has('folder-1')).toBe(
      true
    )
    expect(screen.getByText('My folder')).toBeInTheDocument()

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByText('Folders'),
    })
    await user.click(screen.getByRole('menuitem', { name: 'Collapse all' }))
    expect(useProjectsStore.getState().expandedFolderIds.size).toBe(0)
  })

  it('shows matching folders while searching', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ProjectTree projects={projects} />)
    await user.click(screen.getByRole('button', { name: 'Hide folders' }))

    rerender(<ProjectTree projects={projects} searchQuery="My folder" />)
    expect(screen.getByText('My folder')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide folders' })).toBeDisabled()
  })

  it('expands, collapses, and hides the Projects category from its header', async () => {
    const user = userEvent.setup()
    render(<ProjectTree projects={projects} />)

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByText('Projects'),
    })
    await user.click(screen.getByRole('menuitem', { name: 'Expand all' }))
    expect(
      useProjectsStore.getState().expandedProjectIds.has('project-1')
    ).toBe(true)

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByText('Projects'),
    })
    await user.click(
      screen.getByRole('menuitem', { name: 'Collapse category' })
    )
    expect(screen.queryByText('Standalone project')).not.toBeInTheDocument()

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByText('Projects'),
    })
    await user.click(screen.getByRole('menuitem', { name: 'Expand category' }))
    expect(screen.getByText('Standalone project')).toBeInTheDocument()
  })

  it('offers New project in empty space, and New folder near Folders', async () => {
    const user = userEvent.setup()
    render(
      <ProjectTree
        projects={projects}
        onNewFolder={() => mocks.createFolder()}
      />
    )

    fireEvent.contextMenu(screen.getByTestId('project-tree'), { clientY: 400 })
    expect(
      screen.getByRole('menuitem', { name: 'New project' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'New folder' })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'New project' }))
    expect(useProjectsStore.getState().addProjectDialogOpen).toBe(true)

    fireEvent.contextMenu(screen.getByTestId('project-tree'), { clientY: 0 })
    await user.click(screen.getByRole('menuitem', { name: 'New folder' }))
    expect(mocks.createFolder).toHaveBeenCalled()
  })
})
