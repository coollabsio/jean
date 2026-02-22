import {
  Archive,
  Code,
  FileJson,
  FolderOpen,
  MoreHorizontal,
  Play,
  Plus,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import type { Worktree } from '@/types/projects'
import { getEditorLabel, getTerminalLabel } from '@/types/preferences'
import { isServerMode } from '@/lib/environment'
import { useProjectsStore } from '@/store/projects-store'
import { useWorktreeMenuActions } from './useWorktreeMenuActions'

interface WorktreeDropdownMenuProps {
  worktree: Worktree
  projectId: string
}

export function WorktreeDropdownMenu({
  worktree,
  projectId,
}: WorktreeDropdownMenuProps) {
  const {
    showDeleteConfirm,
    setShowDeleteConfirm,
    isBase,
    hasMessages,
    runScript,
    preferences,
    handleRun,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleArchiveOrClose,
    handleDelete,
    handleOpenJeanConfig,
    handleGenerateRecap,
  } = useWorktreeMenuActions({ worktree, projectId })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={e => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem
            onClick={() =>
              window.dispatchEvent(new CustomEvent('create-new-session'))
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            New Session
          </DropdownMenuItem>

          {isServerMode() && runScript && (
            <DropdownMenuItem onClick={handleRun}>
              <Play className="mr-2 h-4 w-4" />
              Run
            </DropdownMenuItem>
          )}

          <DropdownMenuItem onClick={handleOpenJeanConfig}>
            <FileJson className="mr-2 h-4 w-4" />
            Edit jean.json
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() =>
              useProjectsStore.getState().openProjectSettings(projectId)
            }
          >
            <Settings className="mr-2 h-4 w-4" />
            Project Settings
          </DropdownMenuItem>

          {hasMessages && (
            <DropdownMenuItem onClick={handleGenerateRecap}>
              <Sparkles className="mr-2 h-4 w-4" />
              Generate Recap
            </DropdownMenuItem>
          )}

          {isServerMode() && <DropdownMenuSeparator />}

          {isServerMode() && (
            <DropdownMenuItem onClick={handleOpenInEditor}>
              <Code className="mr-2 h-4 w-4" />
              Open in {getEditorLabel(preferences?.editor)}
            </DropdownMenuItem>
          )}

          {isServerMode() && (
            <DropdownMenuItem onClick={handleOpenInFinder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              Open in Finder
            </DropdownMenuItem>
          )}

          {isServerMode() && (
            <DropdownMenuItem onClick={handleOpenInTerminal}>
              <Terminal className="mr-2 h-4 w-4" />
              Open in {getTerminalLabel(preferences?.terminal)}
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={handleArchiveOrClose}>
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
          </DropdownMenuItem>

          {!isBase && (
            <DropdownMenuItem onClick={() => setShowDeleteConfirm(true)}>
              <Trash2 className="mr-2 h-4 w-4 text-destructive" />
              Delete Worktree
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
            <AlertDialogTitle>Delete Worktree</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the worktree, its branch, and all
              associated sessions. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              autoFocus
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
              <kbd className="ml-1.5 text-xs opacity-70">↵</kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
