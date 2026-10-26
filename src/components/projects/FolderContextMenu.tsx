import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpToLine,
  FolderPlus,
  Plus,
  Trash2,
} from '@/components/icons/reicon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import type { Project, Worktree } from '@/types/projects'
import {
  projectsQueryKeys,
  useCreateFolder,
  useDeleteFolder,
  useMoveItem,
  useProjects,
} from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { invoke } from '@/lib/transport'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'
import {
  canCreateNestedFolder,
  collectDescendantFolderIds,
  collectDescendantProjects,
  visibleWorktreeIds,
} from './sidebar-context-menu'

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
  const createFolder = useCreateFolder()
  const { data: projects = [] } = useProjects()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const setAddProjectDialogOpen = useProjectsStore(
    state => state.setAddProjectDialogOpen
  )
  // Check if folder is empty (no children)
  const isEmpty = !projects.some(p => p.parent_id === folder.id)
  const isNested = folder.parent_id !== undefined
  const canNestFolder = canCreateNestedFolder(projects, folder.id)
  const descendantProjects = collectDescendantProjects(projects, folder.id)
  const projectIds = descendantProjects.map(project => project.id)
  const hasProjects = projectIds.length > 0

  const handleNewProject = () => {
    if (isMobile) {
      useUIStore.getState().setLeftSidebarVisible(false)
    }
    setAddProjectDialogOpen(true, folder.id)
  }

  const handleNewFolder = () => {
    useProjectsStore.getState().setFoldersExpanded([folder.id], true)
    createFolder.mutate({ name: 'New Folder', parentId: folder.id })
  }

  const revealProjects = () => {
    useProjectsStore
      .getState()
      .setFoldersExpanded(
        [folder.id, ...collectDescendantFolderIds(projects, folder.id)],
        true
      )
  }

  const handleExpandProjects = () => {
    revealProjects()
    useProjectsStore.getState().setProjectsExpanded(projectIds, true)
  }

  const handleCollapseProjects = () => {
    useProjectsStore.getState().setProjectsExpanded(projectIds, false)
  }

  const handleExpandProjectsAndSessions = () => {
    revealProjects()
    useProjectsStore.getState().setProjectsExpanded(projectIds, true)
    void loadVisibleWorktreeIds(queryClient, projectIds).then(ids => {
      useProjectsStore.getState().setWorktreesExpanded(ids, true)
    })
  }

  const handleCollapseProjectsAndSessions = () => {
    useProjectsStore.getState().setProjectsExpanded(projectIds, false)
    void loadVisibleWorktreeIds(queryClient, projectIds).then(ids => {
      useProjectsStore.getState().setWorktreesExpanded(ids, false)
    })
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
      <ContextMenuContent className="w-64">
        <ContextMenuItem onClick={handleNewFolder} disabled={!canNestFolder}>
          <FolderPlus className="mr-2 h-4 w-4" />
          New Folder
        </ContextMenuItem>
        <ContextMenuItem onClick={handleNewProject}>
          <Plus className="mr-2 h-4 w-4" />
          New Project
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={handleExpandProjects}
          disabled={!hasProjects}
        >
          Expand projects
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={handleCollapseProjects}
          disabled={!hasProjects}
        >
          Collapse projects
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={handleExpandProjectsAndSessions}
          disabled={!hasProjects}
        >
          Expand projects & sessions
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={handleCollapseProjectsAndSessions}
          disabled={!hasProjects}
        >
          Collapse projects & sessions
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

async function loadVisibleWorktreeIds(
  queryClient: ReturnType<typeof useQueryClient>,
  projectIds: string[]
): Promise<string[]> {
  let failed = false
  const lists = await Promise.all(
    projectIds.map(async projectId => {
      const cached = queryClient.getQueryData<Worktree[]>(
        projectsQueryKeys.worktrees(projectId)
      )
      if (cached) return cached
      try {
        return await invoke<Worktree[]>('list_worktrees', { projectId })
      } catch (error) {
        failed = true
        logger.error('Failed to load worktrees for folder menu', {
          error,
          projectId,
        })
        return []
      }
    })
  )
  if (failed) toast.error('Failed to load worktrees')
  return lists.flatMap(visibleWorktreeIds)
}
