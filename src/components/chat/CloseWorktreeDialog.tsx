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

export type CloseConfirmMode = 'worktree' | 'session'

interface CloseWorktreeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  branchName?: string
  mode?: CloseConfirmMode
}

export function CloseWorktreeDialog({
  open,
  onOpenChange,
  onConfirm,
  branchName,
  mode = 'worktree',
}: CloseWorktreeDialogProps) {
  if (!open) return null

  return (
    <CloseWorktreeDialogContent
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      branchName={branchName}
      mode={mode}
    />
  )
}

function CloseWorktreeDialogContent({
  open,
  onOpenChange,
  onConfirm,
  branchName,
  mode = 'worktree',
}: CloseWorktreeDialogProps) {
  const isSession = mode === 'session'
  const title = isSession ? 'Delete session?' : 'Delete worktree?'
  const description = isSession
    ? 'This will delete this session. Deleted sessions are removed from disk after 30 days.'
    : branchName
      ? `This will permanently delete the "${branchName}" worktree and all its sessions.`
      : 'This will permanently delete the worktree and all its sessions.'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            onConfirm()
            onOpenChange(false)
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            autoFocus
            onClick={onConfirm}
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
