import { Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUIStore } from '@/store/ui-store'

/**
 * Opens the Magic palette from a terminal session's toolbar.
 *
 * Terminal sessions have no composer, so they lose the Magic button that lives
 * in the chat toolbar. This puts it back next to terminal/browser/run. It opens
 * the same `MagicModal` — one palette, one set of shortcuts — rather than a
 * parallel menu that would drift out of sync with it.
 *
 * Renders nothing for Jean Chat sessions, which still have the composer button.
 */
interface TerminalMagicButtonProps {
  sessionId: string | null | undefined
}

export function TerminalMagicButton({ sessionId }: TerminalMagicButtonProps) {
  const setMagicModalOpen = useUIStore(state => state.setMagicModalOpen)
  const surface = useUIStore(state =>
    sessionId ? state.sessionPrimarySurface[sessionId] : undefined
  )

  if (surface !== 'terminal') return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          aria-label="Magic"
          onClick={() => setMagicModalOpen(true)}
        >
          <Wand2 className="h-3 w-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Magic{' '}
        <kbd className="ml-1 text-[0.625rem] opacity-60">⌘M</kbd>
      </TooltipContent>
    </Tooltip>
  )
}
