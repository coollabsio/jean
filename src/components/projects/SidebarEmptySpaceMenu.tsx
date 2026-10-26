import { FolderPlus, Plus } from '@/components/icons/reicon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface SidebarEmptySpaceMenuProps {
  children: React.ReactElement
  offerNewFolder: boolean
  onNewProject: () => void
  onNewFolder: () => void
  onContextMenu?: (event: React.MouseEvent) => void
}

/** Right-click on empty sidebar space: New project, plus New folder near Folders. */
export function SidebarEmptySpaceMenu({
  children,
  offerNewFolder,
  onNewProject,
  onNewFolder,
  onContextMenu,
}: SidebarEmptySpaceMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={onNewProject}>
          <Plus className="mr-2 h-4 w-4" />
          New project
        </ContextMenuItem>
        {offerNewFolder && (
          <ContextMenuItem onSelect={onNewFolder}>
            <FolderPlus className="mr-2 h-4 w-4" />
            New folder
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
