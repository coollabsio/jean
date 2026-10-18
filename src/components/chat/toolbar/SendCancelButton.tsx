import { getModifierSymbol, isClientMacOS } from '@/lib/platform'
import { isNativeApp } from '@/lib/environment'
import { edgePrimary, raised } from '@/components/ui/button'
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
  /** When true, the secondary action steers into the running turn instead of queueing. */
  willSteer?: boolean
  /** When true, steering requires the primary modifier plus Enter. */
  steerWithModifier?: boolean
  /** When true, the running backend accepts a manual steer action. */
  canSteer?: boolean
  queuedMessageCount?: number
  onCancel: () => void
  onSteer?: () => void
}

export function SendCancelButton({
  isSending,
  canSend,
  willSteer = false,
  steerWithModifier = false,
  canSteer = false,
  queuedMessageCount,
  onCancel,
  onSteer,
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
              'flex h-8 items-center justify-center gap-1.5 px-3 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90',
              raised,
              edgePrimary
            )}
          >
            <span>{queuedMessageCount ? 'Skip to Next' : 'Cancel'}</span>
            {!isMobile && (
              <Kbd className="ml-0.5 h-4 text-[10px] bg-primary-foreground/20 text-primary-foreground">
                {isClientMacOS ? `${getModifierSymbol()}⌥⌫` : 'Ctrl+Alt+⌫'}
              </Kbd>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {queuedMessageCount
            ? `Skip to next queued message (${isClientMacOS ? `${getModifierSymbol()}+Option+Backspace` : 'Ctrl+Alt+Backspace'})`
            : `Cancel (${isClientMacOS ? `${getModifierSymbol()}+Option+Backspace` : 'Ctrl+Alt+Backspace'})`}
        </TooltipContent>
      </Tooltip>
    )

    if (canSend) {
      const showSeparateSteer =
        canSteer && !willSteer && (isMobile || !isNativeApp())
      const actionLabel = willSteer ? 'Steer' : 'Queue'
      const actionShortcut = steerWithModifier
        ? isClientMacOS
          ? `${getModifierSymbol()}↵`
          : `${getModifierSymbol()}+Enter`
        : 'Enter'
      const actionTooltip = willSteer
        ? isMobile
          ? 'Steer into running turn'
          : `Steer into running turn (${actionShortcut})`
        : isMobile
          ? 'Queue message'
          : 'Queue message (Enter)'

      return (
        <div className="flex items-center">
          {cancelButton}
          <div className="h-4 w-px shrink-0 bg-border/50" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="submit"
                aria-label={actionLabel}
                className="flex h-8 items-center justify-center gap-1.5 px-2.5 text-xs font-medium transition-colors text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              >
                <span>{actionLabel}</span>
                {!isMobile && (
                  <Kbd className="h-4 text-[10px]">{actionShortcut}</Kbd>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{actionTooltip}</TooltipContent>
          </Tooltip>
          {showSeparateSteer && (
            <>
              <div className="h-4 w-px shrink-0 bg-border/50" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Steer"
                    onClick={onSteer}
                    className="flex h-8 items-center justify-center px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
                  >
                    Steer
                  </button>
                </TooltipTrigger>
                <TooltipContent>Steer into running turn</TooltipContent>
              </Tooltip>
            </>
          )}
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
            'flex h-8 items-center justify-center px-3 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
            canSend
              ? cn(
                  raised,
                  edgePrimary,
                  'bg-primary text-primary-foreground hover:bg-primary/90'
                )
              : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
          )}
        >
          <span>Send</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {isMobile ? 'Send message' : 'Send message (Enter)'}
      </TooltipContent>
    </Tooltip>
  )
}
