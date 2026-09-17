import { beforeEach, describe, expect, it, vi } from 'vitest'
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
      <FolderTreeItem folder={folder} depth={0}>
        <div />
      </FolderTreeItem>
    )

    expect(screen.getByRole('textbox', { name: 'Rename folder' })).toHaveClass(
      'min-w-0'
    )
  })
})
