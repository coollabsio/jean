import { memo, useCallback } from 'react'
import { AlarmClock } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useCreateScheduledPrompt } from '@/services/scheduled-prompts'
import type { ScheduleTrigger } from '@/types/scheduled-prompts'

interface ScheduleForResetButtonProps {
  sessionId: string | undefined
  worktreeId: string | null | undefined
  worktreePath: string | undefined
  backend: string
  model?: string | null
  /** Reads the current draft prompt text from the composer. */
  getPromptText: () => string
  /** Clears the composer after a prompt is scheduled. */
  onScheduled?: () => void
}

/**
 * Compact composer control that queues the currently-typed prompt to fire
 * automatically when the backend usage window resets. Backed by the
 * `scheduled_prompts` Tauri commands.
 */
export const ScheduleForResetButton = memo(function ScheduleForResetButton({
  sessionId,
  worktreeId,
  worktreePath,
  backend,
  model,
  getPromptText,
  onScheduled,
}: ScheduleForResetButtonProps) {
  const { mutateAsync: createScheduledPrompt, isPending } =
    useCreateScheduledPrompt()

  // Only Claude and Codex expose a usage window with a reset timestamp.
  const supportsReset = backend === 'claude' || backend === 'codex'

  const schedule = useCallback(
    async (trigger: ScheduleTrigger) => {
      const prompt = getPromptText().trim()
      if (!prompt) {
        toast.error('Type a prompt first, then schedule it.')
        return
      }
      if (!sessionId || !worktreeId || !worktreePath) {
        toast.error('No active session to schedule against.')
        return
      }

      try {
        const entry = await createScheduledPrompt({
          sessionId,
          worktreeId,
          worktreePath,
          prompt,
          backend,
          model,
          trigger,
        })
        const when = new Date(entry.fireAt * 1000).toLocaleString()
        toast.success(`Prompt scheduled — fires around ${when}.`)
        onScheduled?.()
      } catch (error) {
        toast.error(`Failed to schedule prompt: ${error}`)
      }
    },
    [
      backend,
      createScheduledPrompt,
      getPromptText,
      model,
      onScheduled,
      sessionId,
      worktreeId,
      worktreePath,
    ]
  )

  if (!supportsReset) return null

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              disabled={isPending}
              aria-label="Schedule prompt for usage reset"
            >
              <AlarmClock className="h-3.5 w-3.5" />
              Schedule for reset
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Send this prompt when my usage resets</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Send this prompt when…</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => schedule({ kind: 'sessionReset' })}>
          My session window resets
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => schedule({ kind: 'weeklyReset' })}>
          My weekly window resets
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
