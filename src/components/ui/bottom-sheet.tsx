import type { ReactNode } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/**
 * Look and motion of every mobile bottom sheet. Mobile dropdown menus use it
 * too, so menus and sheets slide in the same way.
 */
export const BOTTOM_SHEET_SURFACE_CLASS =
  'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 max-h-[75svh] rounded-t-xl border-t shadow-lg'

/** Padding that keeps the last row above the home indicator. */
export const BOTTOM_SHEET_SAFE_PADDING_CLASS =
  'pb-[calc(env(safe-area-inset-bottom)+0.5rem)]'

/** One tappable row in a bottom sheet list. */
export const BOTTOM_SHEET_ROW_CLASS =
  'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left active:bg-accent'

/**
 * The standard mobile bottom sheet: a titled header and a scrolling body.
 * Set `fullHeight` for search pickers that should not resize while filtering,
 * and `scrollBody={false}` when the children own their scroll area.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  showDescription = false,
  fullHeight = false,
  scrollBody = true,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: string
  showDescription?: boolean
  fullHeight?: boolean
  scrollBody?: boolean
  children: ReactNode
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className={cn(
          BOTTOM_SHEET_SURFACE_CLASS,
          'min-h-0 overflow-hidden p-0',
          fullHeight && 'h-[75svh]'
        )}
      >
        <SheetHeader className="shrink-0 border-b px-4 py-3 text-left">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className={cn(!showDescription && 'sr-only')}>
            {description}
          </SheetDescription>
        </SheetHeader>
        <div
          className={
            scrollBody
              ? cn(
                  'min-h-0 flex-1 overflow-y-auto overscroll-contain px-2',
                  BOTTOM_SHEET_SAFE_PADDING_CLASS
                )
              : 'flex min-h-0 flex-1 flex-col'
          }
        >
          {children}
        </div>
      </SheetContent>
    </Sheet>
  )
}
