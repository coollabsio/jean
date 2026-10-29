import { getModifierSymbol, isClientMacOS } from '@/lib/platform'
import { isNativeApp } from '@/lib/environment'
import { edgeNeutral, edgePrimary, raised } from '@/components/ui/button'
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
  /** When true, the primary modifier is held, so the action is modifier plus Enter. */
  actionWithModifier?: boolean
  /** When true, the running backend accepts a manual steer action. */
  canSteer?: boolean
  queuedMessageCount?: number
  onCancel: () => void
  onSteer?: () => void
  onQueue?: () => void
}

export function SendCancelButton({
  isSending,
  canSend,
  willSteer = false,
  actionWithModifier = false,
  canSteer = false,
  queuedMessageCount,
  onCancel,
  onSteer,
  onQueue,
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
              'flex h-8 items-center justify-center gap-1.5 px-3 text-xs font-medium bg-destructive text-white hover:bg-destructive/90 [--btn-edge:color-mix(in_oklab,var(--destructive)_55%,black)]',
              raised
            )}
          >
            <span>{queuedMessageCount ? 'Skip to Next' : 'Cancel'}</span>
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
      // Without a held modifier (mobile, web), offer the opposite of the
      // main action as a separate button.
      const showAlternate = canSteer && (isMobile || !isNativeApp())
      const alternateLabel = willSteer ? 'Queue' : 'Steer'
      const actionLabel = willSteer ? 'Steer' : 'Queue'
      const actionShortcut = actionWithModifier
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
          : `Queue message (${actionShortcut})`

      return (
        <div className="flex items-center gap-1.5">
          {cancelButton}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="submit"
                aria-label={actionLabel}
                className={cn(
                  'flex h-8 items-center justify-center gap-1.5 px-2.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90',
                  raised,
                  edgePrimary
                )}
              >
                <span>{actionLabel}</span>
                {!isMobile && (
                  <Kbd
                    modHint={actionWithModifier}
                    className="h-4 bg-primary-foreground/15 text-2xs text-primary-foreground"
                  >
                    {actionShortcut}
                  </Kbd>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{actionTooltip}</TooltipContent>
          </Tooltip>
          {showAlternate && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={alternateLabel}
                    onClick={willSteer ? onQueue : onSteer}
                    className={cn(
                      'flex h-8 items-center justify-center px-2.5 text-xs font-medium bg-muted text-foreground hover:bg-muted/80',
                      raised,
                      edgeNeutral
                    )}
                  >
                    {alternateLabel}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {willSteer ? 'Queue message' : 'Steer into running turn'}
                </TooltipContent>
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
