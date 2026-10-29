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

interface RevertLastCommitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  /** Branch shown in the warning; falls back to "this worktree" */
  branchName?: string
}

export function RevertLastCommitDialog({
  open,
  onOpenChange,
  onConfirm,
  branchName,
}: RevertLastCommitDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revert last commit?</AlertDialogTitle>
          <AlertDialogDescription>
            This will undo the latest local commit on{' '}
            {branchName ? (
              <span className="font-medium text-foreground">{branchName}</span>
            ) : (
              'this worktree'
            )}
            . Your working tree changes from that commit will be restored, but
            this action can be disruptive.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Revert last commit
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
