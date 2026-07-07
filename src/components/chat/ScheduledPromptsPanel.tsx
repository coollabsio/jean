import { memo, useState } from 'react'
import { AlarmClock, ChevronRight, X } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  useScheduledPrompts,
  useCancelScheduledPrompt,
} from '@/services/scheduled-prompts'
import type { ScheduledPrompt } from '@/types/scheduled-prompts'

interface ScheduledPromptsPanelProps {
  sessionId: string
}

function triggerLabel(prompt: ScheduledPrompt): string {
  switch (prompt.trigger.kind) {
    case 'sessionReset':
      return 'session reset'
    case 'weeklyReset':
      return 'weekly reset'
    case 'explicit':
      return 'scheduled time'
  }
}

/** "in 2h 5m" / "in 40s" / "any moment" for a future unix timestamp (seconds). */
function relativeFireLabel(fireAtSecs: number): string {
  const deltaSecs = fireAtSecs - Math.floor(Date.now() / 1000)
  if (deltaSecs <= 0) return 'any moment'
  const hours = Math.floor(deltaSecs / 3600)
  const minutes = Math.floor((deltaSecs % 3600) / 60)
  if (hours > 0) return `in ${hours}h ${minutes}m`
  if (minutes > 0) return `in ${minutes}m`
  return `in ${deltaSecs}s`
}

/**
 * Collapsible list of prompts scheduled to fire on a usage reset, shown above
 * the chat input — mirrors {@link QueuedPromptsPanel}. Only entries for the
 * active session are listed.
 */
export const ScheduledPromptsPanel = memo(function ScheduledPromptsPanel({
  sessionId,
}: ScheduledPromptsPanelProps) {
  const [isOpen, setIsOpen] = useState(true)
  const { data: allPrompts } = useScheduledPrompts()
  const { mutateAsync: cancelScheduledPrompt } = useCancelScheduledPrompt()

  const prompts = (allPrompts ?? []).filter(p => p.sessionId === sessionId)

  const handleCancel = async (id: string) => {
    try {
      await cancelScheduledPrompt(id)
      toast.success('Scheduled prompt cancelled.')
    } catch (error) {
      toast.error(`Failed to cancel: ${error}`)
    }
  }

  if (prompts.length === 0) return null

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      {/* Styled to read as an extension of the chat input card below */}
      <div className="border-t border-border bg-card sm:rounded-t-lg sm:border sm:border-b-0">
        <div className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
          <CollapsibleTrigger className="flex flex-1 items-center gap-2 hover:bg-muted/50 select-none -ml-3 -my-2 pl-3 py-2 rounded-l-md">
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
            <AlarmClock className="h-4 w-4 shrink-0" />
            <span className="font-medium">Scheduled for reset</span>
            <span className="rounded bg-muted/50 px-1.5 py-0.5 text-xs">
              {prompts.length}
            </span>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="max-h-48 overflow-y-auto border-t border-border/50">
            {prompts.map((prompt, index) => (
              <div
                key={prompt.id}
                className="group flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30"
              >
                <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                  #{index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {prompt.prompt}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {relativeFireLabel(prompt.fireAt)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Fires on {triggerLabel(prompt)} —{' '}
                    {new Date(prompt.fireAt * 1000).toLocaleString()}
                  </TooltipContent>
                </Tooltip>
                {prompt.lastError && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive">
                        retrying
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{prompt.lastError}</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Cancel scheduled prompt"
                      onClick={() => handleCancel(prompt.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive hover:text-white group-hover:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel</TooltipContent>
                </Tooltip>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})
