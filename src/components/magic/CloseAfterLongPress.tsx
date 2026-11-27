import { useState, type ReactElement } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useLongPress, type LongPressHandlers } from '@/hooks/use-long-press'

export interface LongPressBinding {
  /** Spread on the option button. Absent when long-press is off. */
  handlers?: LongPressHandlers
  /** Call first in `onClick`; skip the click when it returns true. */
  consumeLongPress: () => boolean
}

const NO_LONG_PRESS: LongPressBinding = { consumeLongPress: () => false }

const CHOICE_CLASS =
  'flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm active:bg-accent hover:bg-accent'

/**
 * Mobile: long-press a magic option to choose between running it and running
 * it, then closing the session. A plain tap runs the option as usual.
 */
export function CloseAfterLongPress({
  enabled,
  label,
  onRun,
  children,
}: {
  enabled: boolean
  label: string
  onRun: (closeSession: boolean) => void
  children: (binding: LongPressBinding) => ReactElement
}) {
  const [open, setOpen] = useState(false)
  const { handlers, consumeLongPress } = useLongPress(() => setOpen(true))

  if (!enabled) return children(NO_LONG_PRESS)

  const run = (closeSession: boolean) => {
    setOpen(false)
    onRun(closeSession)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        {children({ handlers, consumeLongPress })}
      </PopoverAnchor>
      <PopoverContent align="start" className="w-60 p-1">
        <button
          type="button"
          className={CHOICE_CLASS}
          onClick={() => run(false)}
        >
          {label}
        </button>
        <button
          type="button"
          className={CHOICE_CLASS}
          onClick={() => run(true)}
        >
          {label} & close session
        </button>
      </PopoverContent>
    </Popover>
  )
}
