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

interface MoveSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceWorktreeName: string
  targetWorktreeName: string
  onMoveWithChanges: () => void
  onMoveWithoutChanges: () => void
}

export function MoveSessionDialog({
  open,
  onOpenChange,
  sourceWorktreeName,
  targetWorktreeName,
  onMoveWithChanges,
  onMoveWithoutChanges,
}: MoveSessionDialogProps) {
  if (!open) return null

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onEscapeKeyDown={e => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Migrate uncommitted changes?</AlertDialogTitle>
          <AlertDialogDescription>
            <strong>{sourceWorktreeName}</strong> has uncommitted changes. Do
            you want to move them to <strong>{targetWorktreeName}</strong>?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            onClick={() => {
              onMoveWithoutChanges()
              onOpenChange(false)
            }}
          >
            Move without changes
          </Button>
          <Button
            autoFocus
            onClick={() => {
              onMoveWithChanges()
              onOpenChange(false)
            }}
          >
            Move with changes
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
