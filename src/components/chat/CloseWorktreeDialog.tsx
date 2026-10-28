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
  onConfirm: () => void
  branchName?: string
  mode?: CloseConfirmMode
  /** Worktree to delete. When it has uncommitted changes, a second step asks again. */
  worktree?: Worktree
}

export function CloseWorktreeDialog({
  open,
  onOpenChange,
  onConfirm,
  branchName,
  mode = 'worktree',
  worktree,
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
}: CloseWorktreeDialogProps) {
  const uncommitted = useWorktreeUncommittedChanges(
    mode === 'worktree' ? worktree : undefined
  )
  const [showUncommittedStep, setShowUncommittedStep] = useState(false)
  const isSession = mode === 'session'
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
            onConfirm={onConfirm}
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
    onConfirm()
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
