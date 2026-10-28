import { useState } from 'react'
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { Worktree } from '@/types/projects'
import {
  UncommittedChangesStep,
  useWorktreeUncommittedChanges,
} from './UncommittedChangesStep'

interface DeleteWorktreeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktree: Worktree
  onDelete: (skipTeardown?: boolean) => void
}

/** "Delete Worktree" confirmation from the worktree context and dropdown menus. */
export function DeleteWorktreeDialog(props: DeleteWorktreeDialogProps) {
  if (!props.open) return null
  return <DeleteWorktreeDialogContent {...props} />
}

function DeleteWorktreeDialogContent({
  open,
  onOpenChange,
  worktree,
  onDelete,
}: DeleteWorktreeDialogProps) {
  const uncommitted = useWorktreeUncommittedChanges(worktree)
  // Set when the first confirm needs the uncommitted-changes step.
  const [pendingSkipTeardown, setPendingSkipTeardown] = useState<
    boolean | null
  >(null)

  if (uncommitted && pendingSkipTeardown !== null) {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <UncommittedChangesStep
            branchName={worktree.branch}
            changes={uncommitted}
            onConfirm={() => onDelete(pendingSkipTeardown)}
          />
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  const confirm = (skipTeardown: boolean) => {
    if (uncommitted) {
      setPendingSkipTeardown(skipTeardown)
      return
    }
    onDelete(skipTeardown)
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            confirm(false)
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
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertDialogAction
                onClick={e => {
                  e.preventDefault()
                  confirm(true)
                }}
                variant="outline"
              >
                Delete Without Teardown
              </AlertDialogAction>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              Delete without running the teardown script. Resources it manages
              may need manual cleanup.
            </TooltipContent>
          </Tooltip>
          <AlertDialogAction
            autoFocus
            onClick={e => {
              e.preventDefault()
              confirm(false)
            }}
            variant="destructive"
          >
            Delete
            <kbd className="ml-1.5 text-xs opacity-70">↵</kbd>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
