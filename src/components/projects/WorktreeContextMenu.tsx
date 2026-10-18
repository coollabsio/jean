import {
  Archive,
  Code,
  FolderOpen,
  Play,
  Terminal,
  Trash2,
  X,
} from '@/components/icons/reicon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
    showDeleteConfirm,
    setShowDeleteConfirm,
    deleteSkipTeardown,
    isBase,
    runScripts,
    preferences,
    handleRun,
    handleRunCommand,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleArchiveOrClose,
    openDeleteConfirm,
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

        <ContextMenuItem onClick={handleArchiveOrClose}>
          {isBase ? (
            <>
              <X className="mr-2 h-4 w-4" />
              Close Session
            </>
          ) : (
            <>
              <Archive className="mr-2 h-4 w-4" />
              Archive Worktree
            </>
          )}
        </ContextMenuItem>

        {!isBase && (
          <>
            <ContextMenuItem onClick={() => openDeleteConfirm(false)}>
              <Trash2 className="mr-2 h-4 w-4 text-destructive" />
              Delete Worktree
            </ContextMenuItem>
            <ContextMenuItem onClick={() => openDeleteConfirm(true)}>
              <Trash2 className="mr-2 h-4 w-4 text-destructive" />
              Delete Without Teardown
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              handleDelete()
              setShowDeleteConfirm(false)
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteSkipTeardown
                ? 'Delete Without Teardown'
                : 'Delete Worktree'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the worktree, its branch, and all
              associated sessions. This action cannot be undone.
              {deleteSkipTeardown &&
                ' The teardown script will not run, so resources it manages may need manual cleanup.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              autoFocus
              onClick={handleDelete}
              variant="destructive"
            >
              Delete
              <kbd className="ml-1.5 text-xs opacity-70">↵</kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ContextMenu>
  )
}
