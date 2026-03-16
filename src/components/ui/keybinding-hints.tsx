import { Fragment } from 'react'
import { CircleHelp } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { formatShortcutDisplay, type ShortcutString } from '@/types/keybindings'
import { cn } from '@/lib/utils'

export interface KeybindingHint {
  /** Shortcut string e.g. 'mod+shift+n' or a display string like 'j/k' */
  shortcut: ShortcutString
  /** Label describing the action e.g. 'new worktree' */
  label: string
}

interface KeybindingHintsProps {
  hints: KeybindingHint[]
  className?: string
}

/**
 * A small help icon that opens a popover showing keyboard shortcut hints.
 */
export function KeybindingHints({ hints, className }: KeybindingHintsProps) {
  if (hints.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'absolute bottom-4 left-4 z-10 hidden sm:inline-flex h-7 w-7 rounded-full border border-border/30 bg-background/60 backdrop-blur-md text-muted-foreground hover:text-foreground',
            className
          )}
        >
          <CircleHelp className="size-4" />
          <span className="sr-only">Keyboard shortcuts</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-auto min-w-[200px] p-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-center">
          {hints.map(hint => (
            <Fragment key={hint.shortcut}>
              <Kbd className="h-5 px-1.5 text-[11px]">
                {formatShortcutDisplay(hint.shortcut)}
              </Kbd>
              <span className="text-xs text-muted-foreground">{hint.label}</span>
            </Fragment>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
