import { ChevronDown } from '@/components/icons/reicon'
import { cn } from '@/lib/utils'

/** The one sidebar expand/collapse chevron: down when open, right when closed. */
export function DisclosureChevron({
  open,
  className,
}: {
  open: boolean
  className?: string
}) {
  return (
    <ChevronDown
      className={cn(
        'size-3.5 transition-transform',
        !open && '-rotate-90',
        className
      )}
    />
  )
}
