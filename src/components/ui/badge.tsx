import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary:
          'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline: 'bg-muted/50 text-foreground [a&]:hover:bg-muted',
        muted: 'bg-muted/50 text-muted-foreground [a&]:hover:bg-muted',
        // Soft status pills: the only colors a pill may carry.
        success: 'rounded-sm px-1.5 bg-success/10 text-success',
        warning: 'rounded-sm px-1.5 bg-warning/10 text-warning',
        info: 'rounded-sm px-1.5 bg-info/10 text-info',
        danger: 'rounded-sm px-1.5 bg-destructive/10 text-destructive',
        subtle: 'rounded-sm px-1.5 bg-muted text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

/** Small warning badge used for beta features (backends, WSL, GitLab). */
function BetaBadge({ className }: { className?: string }) {
  return (
    <Badge
      aria-hidden="true"
      variant="warning"
      className={cn(
        'py-0 text-2xs leading-4 tracking-wide uppercase',
        className
      )}
    >
      Beta
    </Badge>
  )
}

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, BetaBadge, badgeVariants }
