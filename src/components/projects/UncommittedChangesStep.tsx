import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useGitStatus } from '@/services/git-status'
import { isBaseSession, type Worktree } from '@/types/projects'

export interface UncommittedChanges {
  added: number
  removed: number
}

/**
 * Uncommitted line changes that deleting `worktree` would discard, or null
 * when there are none. Base sessions are never deleted from disk, so they
 * always return null. Mount only while a delete dialog is open.
 */
export function useWorktreeUncommittedChanges(
  worktree: Worktree | undefined
): UncommittedChanges | null {
  const deletable = !!worktree && !isBaseSession(worktree)
  const { data: gitStatus } = useGitStatus(deletable ? worktree.id : null)
  if (!deletable) return null
  const added =
    gitStatus?.uncommitted_added ?? worktree.cached_uncommitted_added ?? 0
  const removed =
    gitStatus?.uncommitted_removed ?? worktree.cached_uncommitted_removed ?? 0
  return added > 0 || removed > 0 ? { added, removed } : null
}

/**
 * Second confirmation step of a worktree delete dialog. Cancel has focus and
 * Enter does not confirm, so a held or repeated Enter cannot discard changes.
 */
export function UncommittedChangesStep({
  branchName,
  changes,
  onConfirm,
}: {
  branchName?: string
  changes: UncommittedChanges
  onConfirm: () => void
}) {
  const target = branchName ? `The "${branchName}" worktree` : 'This worktree'
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Discard uncommitted changes?</AlertDialogTitle>
        <AlertDialogDescription>
          {target} has uncommitted changes (
          <span className="text-success">+{changes.added}</span>/
          <span className="text-destructive">-{changes.removed}</span> lines).
          Deleting it discards them permanently.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} variant="destructive">
          Discard and Delete
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}
