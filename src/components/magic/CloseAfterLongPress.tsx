import { useState, type ReactElement, type ReactNode } from 'react'
import { useLongPress, type LongPressHandlers } from '@/hooks/use-long-press'
import { cn } from '@/lib/utils'

export interface LongPressBinding {
  /** Spread on the option button. Absent when long-press is off. */
  handlers?: LongPressHandlers
  /** Call first in `onClick`; skip the click when it returns true. */
  consumeLongPress: () => boolean
  /** Inline choices after a long press; place them below the option. */
  choices: ReactNode
}

const NO_LONG_PRESS: LongPressBinding = {
  consumeLongPress: () => false,
  choices: null,
}

const CHOICE_CLASS =
  'flex min-h-11 flex-1 items-center justify-center rounded-md border border-border/70 px-3 text-sm active:bg-accent'

/**
 * Mobile: long-press a magic option to choose between running it and running
 * it, then closing the session. A plain tap runs the option as usual.
 *
 * The choices render inline, not in a popover: the tap the browser sends when
 * the finger lifts moves focus to the option, and a popover in the modal
 * sheet closes on that focus change.
 */
export function CloseAfterLongPress({
  enabled,
  label,
  onRun,
  className,
  children,
}: {
  enabled: boolean
  label: string
  onRun: (closeSession: boolean) => void
  className?: string
  children: (binding: LongPressBinding) => ReactElement
}) {
  const [open, setOpen] = useState(false)
  const { handlers, consumeLongPress } = useLongPress(() => {
    navigator.vibrate?.(10)
    setOpen(true)
  })

  if (!enabled) return children(NO_LONG_PRESS)

  const run = (closeSession: boolean) => {
    setOpen(false)
    onRun(closeSession)
  }

  const choices = open ? (
    <div
      role="group"
      aria-label={`${label} options`}
      className={cn('flex gap-2 py-1', className)}
    >
      <button type="button" className={CHOICE_CLASS} onClick={() => run(false)}>
        {label}
      </button>
      <button type="button" className={CHOICE_CLASS} onClick={() => run(true)}>
        {label} & close session
      </button>
    </div>
  ) : null

  return children({ handlers, consumeLongPress, choices })
}
