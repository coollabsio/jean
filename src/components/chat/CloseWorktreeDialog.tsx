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
import { Checkbox } from '@/components/ui/checkbox'
import { useState } from 'react'
import {
  UncommittedChangesStep,
  useWorktreeUncommittedChanges,
} from '@/components/projects/UncommittedChangesStep'
import type { Worktree } from '@/types/projects'

export type CloseConfirmMode = 'worktree' | 'session'

interface CloseWorktreeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (options: { closeSubSessions: boolean }) => void
  branchName?: string
  mode?: CloseConfirmMode
  /** Worktree to delete. When it has uncommitted changes, a second step asks again. */
  worktree?: Worktree
  /** Finished sub-sessions of the session to delete, offered to delete too. */
  finishedSubSessionCount?: number
}

export function CloseWorktreeDialog({
  open,
  onOpenChange,
  onConfirm,
  branchName,
  mode = 'worktree',
  worktree,
  finishedSubSessionCount = 0,
}: CloseWorktreeDialogProps) {
  if (!open) return null

  return (
    <CloseWorktreeDialogContent
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      branchName={branchName}
      mode={mode}
      worktree={worktree}
      finishedSubSessionCount={finishedSubSessionCount}
    />
  )
}

function CloseWorktreeDialogContent({
  open,
  onOpenChange,
  onConfirm,
  branchName,
  mode = 'worktree',
  worktree,
  finishedSubSessionCount = 0,
}: CloseWorktreeDialogProps) {
  const uncommitted = useWorktreeUncommittedChanges(
    mode === 'worktree' ? worktree : undefined
  )
  const [showUncommittedStep, setShowUncommittedStep] = useState(false)
  const isSession = mode === 'session'
  const offersSubSessions = isSession && finishedSubSessionCount > 0
  const [closeSubSessions, setCloseSubSessions] = useState(true)
  const title = isSession ? 'Delete session?' : 'Delete worktree?'
  const description = isSession
    ? 'This will delete this session. Deleted sessions are removed from disk after 30 days.'
    : branchName
      ? `This will permanently delete the "${branchName}" worktree and all its sessions.`
      : 'This will permanently delete the worktree and all its sessions.'

  if (uncommitted && showUncommittedStep) {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <UncommittedChangesStep
            branchName={branchName ?? worktree?.branch}
            changes={uncommitted}
            onConfirm={() => onConfirm({ closeSubSessions: false })}
          />
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  // With uncommitted changes, the first confirm opens the second step.
  const confirm = () => {
    if (uncommitted) {
      setShowUncommittedStep(true)
      return
    }
    onConfirm({ closeSubSessions: offersSubSessions && closeSubSessions })
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            confirm()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {offersSubSessions && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={closeSubSessions}
              onCheckedChange={checked => setCloseSubSessions(checked === true)}
            />
            {`Also close ${finishedSubSessionCount} finished sub-session${finishedSubSessionCount === 1 ? '' : 's'}`}
          </label>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            autoFocus
            onClick={e => {
              e.preventDefault()
              confirm()
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
