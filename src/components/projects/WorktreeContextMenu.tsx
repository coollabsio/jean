import {
  Code,
  FolderOpen,
  Play,
  Terminal,
  Trash2,
  X,
} from '@/components/icons/reicon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { getEditorLabel, getTerminalLabel } from '@/types/preferences'
import {
  canOpenInEditor,
  canOpenInFinder,
  canOpenInTerminal,
} from '@/lib/environment'
import { getFileManagerName } from '@/lib/platform'
import type { useWorktreeMenuActions } from './useWorktreeMenuActions'
import { DeleteWorktreeDialog } from './DeleteWorktreeDialog'

interface WorktreeContextMenuProps {
  // Computed once by the parent (WorktreeItem) and passed in so the hook isn't
  // run twice per worktree row.
  actions: ReturnType<typeof useWorktreeMenuActions>
  serverId?: string
  children: React.ReactNode
}

export function WorktreeContextMenu({
  actions,
  serverId,
  children,
}: WorktreeContextMenuProps) {
  const {
    worktree,
    showDeleteConfirm,
    setShowDeleteConfirm,
    isBase,
    runScripts,
    preferences,
    handleRun,
    handleRunCommand,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleClose,
    handleDelete,
  } = actions

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {runScripts.length === 1 && (
          <ContextMenuItem onClick={handleRun}>
            <Play className="mr-2 h-4 w-4" />
            Run
          </ContextMenuItem>
        )}
        {runScripts.length > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Play className="mr-2 h-4 w-4" />
              Run
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {runScripts.map(cmd => (
                <ContextMenuItem
                  key={cmd}
                  onSelect={() => handleRunCommand(cmd)}
                  className="font-mono text-xs"
                >
                  {cmd}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        {(canOpenInEditor() ||
          canOpenInTerminal() ||
          canOpenInFinder(serverId)) && <ContextMenuSeparator />}

        {canOpenInEditor() && (
          <ContextMenuItem onClick={handleOpenInEditor}>
            <Code className="mr-2 h-4 w-4" />
            Open in {getEditorLabel(preferences?.editor)}
          </ContextMenuItem>
        )}

        {canOpenInFinder(serverId) && (
          <ContextMenuItem onClick={handleOpenInFinder}>
            <FolderOpen className="mr-2 h-4 w-4" />
            Open in {getFileManagerName()}
          </ContextMenuItem>
        )}

        {canOpenInTerminal() && (
          <ContextMenuItem onClick={handleOpenInTerminal}>
            <Terminal className="mr-2 h-4 w-4" />
            Open in {getTerminalLabel(preferences?.terminal)}
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        {isBase ? (
          <ContextMenuItem onClick={handleClose}>
            <X className="mr-2 h-4 w-4" />
            Close Session
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => setShowDeleteConfirm(true)}>
            <Trash2 className="mr-2 h-4 w-4 text-destructive" />
            Delete Worktree
          </ContextMenuItem>
        )}
      </ContextMenuContent>

      <DeleteWorktreeDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        worktree={worktree}
        onDelete={handleDelete}
      />
    </ContextMenu>
  )
}
