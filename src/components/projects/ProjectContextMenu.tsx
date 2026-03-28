import {
  ArrowUpToLine,
  Code,
  ExternalLink,
  Folder,
  FolderOpen,
  Home,
  Plus,
  Settings,
  Terminal,
  Trash2,
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { isBaseSession, type Project } from '@/types/projects'
import {
  useCreateBaseSession,
  useMoveItem,
  useOpenProjectOnGitHub,
  useOpenProjectWorktreesFolder,
  useOpenWorktreeInEditor,
  useOpenWorktreeInFinder,
  useOpenWorktreeInTerminal,
  useRemoveProject,
  useWorktrees,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { getEditorLabel, getTerminalLabel } from '@/types/preferences'
import { getFileManagerName } from '@/lib/platform'

interface ProjectContextMenuProps {
  project: Project
  children: React.ReactNode
}

export function ProjectContextMenu({
  project,
  children,
}: ProjectContextMenuProps) {
  const createBaseSession = useCreateBaseSession()
  const moveItem = useMoveItem()
  const removeProject = useRemoveProject()
  const openOnGitHub = useOpenProjectOnGitHub()
  const openInFinder = useOpenWorktreeInFinder()
  const openWorktreesFolder = useOpenProjectWorktreesFolder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()
  const { data: worktrees = [] } = useWorktrees(project.id)
  const { data: preferences } = usePreferences()
  const { openProjectSettings, selectProject } = useProjectsStore()
  const setNewWorktreeModalOpen = useUIStore(
    state => state.setNewWorktreeModalOpen
  )
  // Check if base session already exists
  const existingBaseSession = worktrees.find(isBaseSession)
  const isNested = project.parent_id !== undefined

  const handleOpenInFinder = () => {
    openInFinder.mutate(project.path)
  }

  const handleOpenWorktreesFolder = () => {
    openWorktreesFolder.mutate(project.id)
  }

  const handleOpenInTerminal = () => {
    openInTerminal.mutate({
      worktreePath: project.path,
      terminal: preferences?.terminal,
    })
  }

  const handleOpenInEditor = () => {
    openInEditor.mutate({
      worktreePath: project.path,
      editor: preferences?.editor,
    })
  }

  const handleNewWorktree = () => {
    selectProject(project.id)
    setNewWorktreeModalOpen(true)
  }

  const handleNewBaseSession = () => {
    createBaseSession.mutate(project.id)
  }

  const handleRemoveProject = () => {
    removeProject.mutate(project.id)
  }

  const handleOpenOnGitHub = () => {
    openOnGitHub.mutate(project.id)
  }

  const handleMoveToRoot = () => {
    moveItem.mutate({ itemId: project.id, newParentId: undefined })
  }

  const handleOpenSettings = () => {
    openProjectSettings(project.id)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuItem onClick={handleOpenSettings}>
          <Settings className="mr-2 h-4 w-4" />
          Project Settings
        </ContextMenuItem>

        {isNested && (
          <ContextMenuItem onClick={handleMoveToRoot}>
            <ArrowUpToLine className="mr-2 h-4 w-4" />
            Move to Root
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleNewBaseSession}>
          <Home className="mr-2 h-4 w-4" />
          {existingBaseSession ? 'Open Base Session' : 'New Base Session'}
        </ContextMenuItem>

        <ContextMenuItem onClick={handleNewWorktree}>
          <Plus className="mr-2 h-4 w-4" />
          New Worktree
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleOpenInEditor}>
          <Code className="mr-2 h-4 w-4" />
          Open in {getEditorLabel(preferences?.editor)}
        </ContextMenuItem>

        <ContextMenuItem onClick={handleOpenInFinder}>
          <FolderOpen className="mr-2 h-4 w-4" />
          Open in {getFileManagerName()}
        </ContextMenuItem>

        <ContextMenuItem onClick={handleOpenInTerminal}>
          <Terminal className="mr-2 h-4 w-4" />
          Open in {getTerminalLabel(preferences?.terminal)}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={handleOpenWorktreesFolder}>
          <Folder className="mr-2 h-4 w-4" />
          Open Worktrees Folder
        </ContextMenuItem>

        <ContextMenuItem onClick={handleOpenOnGitHub}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Open on GitHub
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          variant="destructive"
          onClick={handleRemoveProject}
          disabled={worktrees.length > 0}
          className="whitespace-nowrap"
        >
          <Trash2 className="mr-2 h-4 w-4 shrink-0" />
          Remove Project
          {worktrees.length > 0 && (
            <span className="ml-auto text-xs opacity-60 shrink-0">
              ({worktrees.length} worktrees)
            </span>
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
