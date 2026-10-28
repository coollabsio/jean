import { cn } from '@/lib/utils'

/**
 * `modHint`: a hint for a shortcut that needs a modifier (⌘/Ctrl/Alt). It stays
 * hidden until the user holds a modifier key (see `lib/modifier-hints.ts`).
 */
function Kbd({
  className,
  modHint,
  ...props
}: React.ComponentProps<'kbd'> & { modHint?: boolean }) {
  return (
    <kbd
      data-slot="kbd"
      data-mod-hint={modHint ? '' : undefined}
      className={cn(
        'bg-muted text-muted-foreground pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm px-1 font-sans text-xs font-medium select-none',
        "[&_svg:not([class*='size-'])]:size-3",
        '[[data-slot=tooltip-content]_&]:border [[data-slot=tooltip-content]_&]:border-border/60 [[data-slot=tooltip-content]_&]:bg-popover/70 [[data-slot=tooltip-content]_&]:text-popover-foreground',
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({
  className,
  modHint,
  ...props
}: React.ComponentProps<'div'> & { modHint?: boolean }) {
  return (
    <kbd
      data-slot="kbd-group"
      data-mod-hint={modHint ? '' : undefined}
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
