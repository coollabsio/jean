import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useCommitChanges } from '@/services/projects'

export function CommitModal() {
  const { commitModalOpen, setCommitModalOpen } = useUIStore()
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const commitChanges = useCommitChanges()

  const [message, setMessage] = useState('')
  const [stageAll, setStageAll] = useState(true)

  // Handle dialog open/close with form reset
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        // Reset form state when closing
        setMessage('')
        setStageAll(true)
      }
      setCommitModalOpen(open)
    },
    [setCommitModalOpen]
  )

  const handleCommit = useCallback(() => {
    if (!selectedWorktreeId || !message.trim()) return

    commitChanges.mutate(
      {
        worktreeId: selectedWorktreeId,
        message: message.trim(),
        stageAll,
      },
      {
        onSuccess: () => {
          handleOpenChange(false)
        },
      }
    )
  }, [selectedWorktreeId, message, stageAll, commitChanges, handleOpenChange])

  // Handle CMD+Enter to submit
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleCommit()
      }
    },
    [handleCommit]
  )

  const isDisabled = !selectedWorktreeId || !message.trim()

  return (
    <Dialog open={commitModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Commit Changes</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="commit-message">Commit message</Label>
            <Textarea
              id="commit-message"
              placeholder="Describe your changes..."
              value={message}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              className="min-h-[100px] resize-none"
              autoFocus
            />
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="stage-all"
              checked={stageAll}
              onCheckedChange={checked => setStageAll(checked === true)}
            />
            <Label htmlFor="stage-all" className="text-sm font-normal">
              Stage all changes before committing
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={commitChanges.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCommit}
            disabled={isDisabled || commitChanges.isPending}
          >
            {commitChanges.isPending ? 'Committing...' : 'Commit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default CommitModal
