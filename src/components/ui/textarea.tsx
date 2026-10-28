import * as React from 'react'

import { cn } from '@/lib/utils'

function Textarea({
  className,
  wrap,
  ...props
}: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      wrap={wrap ?? 'soft'}
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-foreground/25 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 min-w-0 w-full overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
