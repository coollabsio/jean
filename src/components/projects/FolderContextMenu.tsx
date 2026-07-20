import { ArrowUpToLine, Plus, Trash2 } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import type { Project } from '@/types/projects'
import { useDeleteFolder, useMoveItem, useProjects } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'

interface FolderContextMenuProps {
  folder: Project
  children: React.ReactNode
}

export function FolderContextMenu({
  folder,
  children,
}: FolderContextMenuProps) {
  const deleteFolder = useDeleteFolder()
  const moveItem = useMoveItem()
  const { data: projects = [] } = useProjects()
  const isMobile = useIsMobile()
  const setAddProjectDialogOpen = useProjectsStore(
    state => state.setAddProjectDialogOpen
  )

  // Check if folder is empty (no children)
  const isEmpty = !projects.some(p => p.parent_id === folder.id)
  const isNested = folder.parent_id !== undefined

  const handleNewProject = () => {
    if (isMobile) {
      useUIStore.getState().setLeftSidebarVisible(false)
    }
    setAddProjectDialogOpen(true, folder.id)
  }

  const handleMoveToRoot = () => {
    moveItem.mutate({ itemId: folder.id, newParentId: undefined })
  }

  const handleDelete = () => {
    deleteFolder.mutate(folder.id)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={handleNewProject}>
          <Plus className="mr-2 h-4 w-4" />
          New Project
        </ContextMenuItem>
        {isNested && (
          <ContextMenuItem onClick={handleMoveToRoot}>
            <ArrowUpToLine className="mr-2 h-4 w-4" />
            Move to Root
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={handleDelete}
          disabled={!isEmpty}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete Folder
          {!isEmpty && (
            <span className="ml-auto text-xs opacity-60">(not empty)</span>
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
