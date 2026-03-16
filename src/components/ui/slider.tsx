'use client'

import * as React from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'

import { cn } from '@/lib/utils'

interface SliderProps
  extends Omit<
    React.ComponentProps<typeof SliderPrimitive.Root>,
    | 'min'
    | 'max'
    | 'step'
    | 'value'
    | 'defaultValue'
    | 'onValueChange'
    | 'onValueCommit'
  > {
  ticks: { value: number; label: string }[]
  value: number
  onValueChange: (value: number) => void
  /** Called only when the user finishes dragging (mouse/touch up). Use for expensive operations like zoom. */
  onValueCommit?: (value: number) => void
}

function Slider({
  className,
  ticks,
  value,
  onValueChange,
  onValueCommit,
  disabled,
  ...props
}: SliderProps) {
  const currentIndex = React.useMemo(() => {
    const idx = ticks.findIndex(t => t.value === value)
    if (idx >= 0) return idx
    // Snap to nearest if value not in ticks
    let closest = 0
    let minDiff = Infinity
    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i]
      if (!tick) continue
      const diff = Math.abs(tick.value - value)
      if (diff < minDiff) {
        minDiff = diff
        closest = i
      }
    }
    return closest
  }, [ticks, value])

  return (
    <div className="w-full space-y-1">
      <SliderPrimitive.Root
        data-slot="slider"
        min={0}
        max={ticks.length - 1}
        step={1}
        value={[currentIndex]}
        onValueChange={values => {
          const idx = values[0]
          if (idx != null) {
            const tick = ticks[idx]
            if (tick) onValueChange(tick.value)
          }
        }}
        onValueCommit={
          onValueCommit
            ? values => {
                const idx = values[0]
                if (idx != null) {
                  const tick = ticks[idx]
                  if (tick) onValueCommit(tick.value)
                }
              }
            : undefined
        }
        disabled={disabled}
        className={cn(
          'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50',
          className
        )}
        {...props}
      >
        <SliderPrimitive.Track className="bg-muted relative h-1.5 w-full grow overflow-hidden rounded-full">
          <SliderPrimitive.Range className="bg-primary absolute h-full" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="border-primary/50 bg-background focus-visible:ring-ring/50 block size-4 rounded-full border shadow-sm transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none" />
      </SliderPrimitive.Root>
      <div className="relative flex w-full justify-between px-[7px]">
        {ticks.map(tick => (
          <span
            key={tick.value}
            className={cn(
              'text-[10px] text-muted-foreground min-w-0',
              tick.value === value && 'text-foreground font-medium'
            )}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export { Slider }
