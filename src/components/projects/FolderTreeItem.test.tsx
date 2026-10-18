import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { FolderTreeItem } from './FolderTreeItem'

const mocks = vi.hoisted(() => ({
  renameFolderMutate: vi.fn(),
}))

vi.mock('@/services/projects', () => ({
  useRenameFolder: () => ({ mutate: mocks.renameFolderMutate }),
  useDeleteFolder: () => ({ mutate: vi.fn(), isPending: false }),
  useMoveItem: () => ({ mutate: vi.fn(), isPending: false }),
  useProjects: () => ({ data: [] }),
}))

vi.mock('./FolderContextMenu', () => ({
  FolderContextMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

const folder: Project = {
  id: 'folder-1',
  name: 'New Folder',
  path: '',
  default_branch: '',
  added_at: 0,
  order: 0,
  is_folder: true,
}

describe('FolderTreeItem', () => {
  beforeEach(() => {
    mocks.renameFolderMutate.mockReset()
    useProjectsStore.setState({
      expandedFolderIds: new Set(),
      editingFolderId: 'folder-1',
    })
  })

  it('lets the rename input shrink inside the folder row', () => {
    render(
      <FolderTreeItem folder={folder} depth={0} childCount={0}>
        <div />
      </FolderTreeItem>
    )

    expect(screen.getByRole('textbox', { name: 'Rename folder' })).toHaveClass(
      'min-w-0'
    )
  })

  it('shows the direct child count only while collapsed', async () => {
    useProjectsStore.setState({ editingFolderId: null })
    const user = userEvent.setup()
    render(
      <FolderTreeItem folder={folder} depth={0} childCount={2}>
        <div>Child rows</div>
      </FolderTreeItem>
    )

    expect(screen.getByRole('status', { name: '2 items' })).toHaveTextContent(
      '2'
    )
    expect(screen.queryByText('Child rows')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Expand folder' }))
    expect(
      screen.queryByRole('status', { name: '2 items' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Child rows')).toBeInTheDocument()
  })
})
