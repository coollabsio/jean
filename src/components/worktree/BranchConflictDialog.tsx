import { useCallback, useEffect, useState } from 'react'
import { GitBranch, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  useCreateWorktree,
  useCreateWorktreeFromExistingBranch,
} from '@/services/projects'
import type { WorktreeBranchExistsEvent } from '@/types/projects'

/**
 * Dialog shown when worktree creation fails because the branch already exists.
 *
 * Offers two options:
 * - Use the existing branch (checkout into a new worktree)
 * - Create a new branch with a suggested alternative name
 *
 * Listens for the 'branch-conflict-detected' custom DOM event dispatched
 * by the worktree:branch_exists Tauri event listener in projects.ts.
 */
export function BranchConflictDialog() {
  const [open, setOpen] = useState(false)
  const [conflict, setConflict] = useState<WorktreeBranchExistsEvent | null>(
    null
  )

  const createWorktree = useCreateWorktree()
  const createFromExisting = useCreateWorktreeFromExistingBranch()

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<WorktreeBranchExistsEvent>).detail
      setConflict(detail)
      setOpen(true)
    }

    window.addEventListener('branch-conflict-detected', handler)
    return () => window.removeEventListener('branch-conflict-detected', handler)
  }, [])

  const handleUseExisting = useCallback(() => {
    if (!conflict) return
    setOpen(false)

    createFromExisting.mutate(
      {
        projectId: conflict.project_id,
        branchName: conflict.branch,
        issueContext: conflict.issue_context,
        prContext: conflict.pr_context,
      },
      {
        onError: (error: Error) => {
          toast.error('Failed to create worktree', {
            description: error.message,
          })
        },
      }
    )
  }, [conflict, createFromExisting])

  const handleCreateNew = useCallback(() => {
    if (!conflict) return
    setOpen(false)

    createWorktree.mutate(
      {
        projectId: conflict.project_id,
        customName: conflict.suggested_name,
        issueContext: conflict.issue_context,
        prContext: conflict.pr_context,
      },
      {
        onError: (error: Error) => {
          toast.error('Failed to create worktree', {
            description: error.message,
          })
        },
      }
    )
  }, [conflict, createWorktree])

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Branch already exists</AlertDialogTitle>
          <AlertDialogDescription>
            The branch{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
              {conflict?.branch}
            </code>{' '}
            already exists. What would you like to do?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 pt-2">
          <Button onClick={handleUseExisting} className="w-full justify-start">
            <GitBranch className="h-4 w-4 mr-2" />
            Use Existing Branch
          </Button>
          <Button
            variant="outline"
            onClick={handleCreateNew}
            className="w-full justify-start"
          >
            <Plus className="h-4 w-4 mr-2" />
            Create New Branch
          </Button>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
