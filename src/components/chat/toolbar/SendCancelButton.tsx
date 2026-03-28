import { Rocket } from 'lucide-react'
import { getModifierSymbol, isMacOS } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'

interface SendCancelButtonProps {
  isSending: boolean
  canSend: boolean
  executionMode: string
  queuedMessageCount?: number
  onCancel: () => void
}

const MODE_LABELS: Record<string, string> = {
  plan: 'Plan',
  build: 'Build',
  yolo: 'Yolo',
}

export function SendCancelButton({
  isSending,
  canSend,
  executionMode,
  queuedMessageCount,
  onCancel,
}: SendCancelButtonProps) {
  const isMobile = useIsMobile()

  if (isSending) {
    const cancelButton = (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'flex h-8 items-center justify-center gap-1.5 px-3 text-xs font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90',
              !canSend && 'rounded-r-lg'
            )}
          >
            <span>{queuedMessageCount ? 'Skip to Next' : 'Cancel'}</span>
            {!isMobile && (
              <Kbd className="ml-0.5 h-4 text-[10px] bg-primary-foreground/20 text-primary-foreground">
                {isMacOS ? `${getModifierSymbol()}⌥⌫` : 'Ctrl+Alt+⌫'}
              </Kbd>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {queuedMessageCount
            ? `Skip to next queued message (${isMacOS ? `${getModifierSymbol()}+Option+Backspace` : 'Ctrl+Alt+Backspace'})`
            : `Cancel (${isMacOS ? `${getModifierSymbol()}+Option+Backspace` : 'Ctrl+Alt+Backspace'})`}
        </TooltipContent>
      </Tooltip>
    )

    if (canSend) {
      return (
        <div className="flex items-center">
          {cancelButton}
          <div className="h-4 w-px shrink-0 bg-border/50" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="submit"
                className="flex h-8 items-center justify-center gap-1.5 rounded-r-lg px-2.5 text-xs font-medium transition-colors text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              >
                <span>Queue</span>
                <Rocket className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {isMobile ? 'Queue message' : 'Queue message (Enter)'}
            </TooltipContent>
          </Tooltip>
        </div>
      )
    }

    return cancelButton
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="submit"
          disabled={!canSend}
          className={cn(
            'flex h-8 items-center justify-center gap-1.5 rounded-r-lg px-3 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
            canSend
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
          )}
        >
          <span className="w-9 text-center">
            {MODE_LABELS[executionMode] ?? executionMode}
          </span>
          <Rocket className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {isMobile ? 'Send message' : 'Send message (Enter)'}
      </TooltipContent>
    </Tooltip>
  )
}
