import { useCallback, useState } from 'react'
import { Flag } from '@/components/icons/reicon'
import { toast } from 'sonner'
import { useChatStore } from '@/store/chat-store'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

interface GoalBadgeProps {
  sessionId: string | null | undefined
  onClearGoal: () => Promise<void>
}

/** Composer top-edge tab that shows the session's active goal. */
export function GoalBadge({ sessionId, onClearGoal }: GoalBadgeProps) {
  const objective = useChatStore(state =>
    sessionId ? state.codexGoals[sessionId]?.trim() || null : null
  )
  const [clearing, setClearing] = useState(false)
  const [open, setOpen] = useState(false)

  const handleClear = useCallback(async () => {
    if (clearing) return
    setClearing(true)
    try {
      await onClearGoal()
      setOpen(false)
    } catch (err) {
      toast.error(`Failed to clear goal: ${err}`)
    } finally {
      setClearing(false)
    }
  }, [clearing, onClearGoal])

  if (!objective) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Show goal"
          title="Show goal"
          className="flex h-6 items-center gap-1 rounded-t-md border border-b-0 border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Flag className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Goal</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Goal
        </div>
        <div className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground">
          {objective}
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClear}
            disabled={clearing}
          >
            {clearing ? 'Clearing...' : 'Clear goal'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
