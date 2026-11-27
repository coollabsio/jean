import { useEffect, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { WorkingWaveform } from '@/components/ui/status-indicator'
import { DisclosureChevron } from '@/components/projects/DisclosureChevron'
import type { SessionCardData } from './session-card-utils'

const CLOSE_DELAY_MS = 150

interface RunningSessionsTabProps {
  cards: SessionCardData[]
  onSelect: (sessionId: string) => void
}

/** One tab for all running sessions. Hover or click lists them. */
export function RunningSessionsTab({
  cards,
  onSelect,
}: RunningSessionsTabProps) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const openNow = () => {
    cancelClose()
    setOpen(true)
  }
  const closeSoon = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }
  useEffect(() => cancelClose, [])

  const hoverHandlers = {
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') openNow()
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') closeSoon()
    },
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${cards.length} running sessions`}
          className="flex shrink-0 items-center gap-1.5 border-r border-border/20 px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none data-[state=open]:bg-muted/50 data-[state=open]:text-foreground"
          {...hoverHandlers}
          onPointerDown={e => {
            // Hover already opened it; a mouse click must not toggle it shut.
            if (e.pointerType !== 'mouse') return
            e.preventDefault()
            openNow()
          }}
        >
          <WorkingWaveform />
          <span>{cards.length} running</span>
          <DisclosureChevron open={open} className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72"
        onCloseAutoFocus={e => e.preventDefault()}
        {...hoverHandlers}
      >
        {cards.map(card => (
          <DropdownMenuItem
            key={card.session.id}
            onSelect={() => onSelect(card.session.id)}
            className="gap-2"
          >
            <WorkingWaveform />
            <span className="truncate">{card.session.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
