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
import { usePreferences } from '@/services/preferences'
import { useUIStore } from '@/store/ui-store'

interface CloseWorktreeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  branchName?: string
  mode?: 'worktree' | 'session'
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
  const { data: preferences } = usePreferences()
  const isDelete = (preferences?.removal_behavior ?? 'delete') === 'delete'
  const isSession = mode === 'session'
  const title = isSession
    ? isDelete
      ? 'Delete session?'
      : 'Archive session?'
    : isDelete
      ? 'Delete worktree?'
      : 'Archive & close worktree?'

  const description = isSession
    ? `This will ${isDelete ? 'permanently delete' : 'archive'} this session.`
    : branchName
      ? `This will ${isDelete ? 'permanently delete' : 'archive and close'} the "${branchName}" worktree and all its sessions.`
      : `This will ${isDelete ? 'permanently delete' : 'archive and close'} the worktree and all its sessions.`

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onEscapeKeyDown={e => e.stopPropagation()}
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
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{description}</p>
              {isDelete && (
                <p className="text-xs text-muted-foreground">
                  Removal behavior is set to delete.{' '}
                  <button
                    type="button"
                    className="underline hover:text-foreground transition-colors"
                    onClick={() => {
                      onOpenChange(false)
                      useUIStore.getState().openPreferencesPane('general')
                    }}
                  >
                    Change in Settings
                  </button>
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            autoFocus
            onClick={onConfirm}
            className={
              isDelete
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined
            }
          >
            {isDelete ? 'Delete' : 'Archive & Close'}
            <kbd className="ml-1.5 text-xs opacity-70">↵</kbd>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
