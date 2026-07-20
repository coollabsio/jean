import { Suspense, lazy, useEffect, useState, type CSSProperties } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { SidebarWidthProvider } from './SidebarWidthContext'

const LeftSideBar = lazy(() =>
  import('./LeftSideBar').then(mod => ({
    default: mod.LeftSideBar,
  }))
)

interface MobileLeftSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  width: number
  isDragging?: boolean
  dragOffset?: number
  dragTransition?: string
}

/**
 * Mobile left sidebar as an overlay drawer.
 * Does not shift the main layout; tapping the dimmed backdrop closes it.
 */
export function MobileLeftSidebar({
  open,
  onOpenChange,
  width,
  isDragging = false,
  dragOffset = 0,
  dragTransition = '',
}: MobileLeftSidebarProps) {
  const [openedByDrag, setOpenedByDrag] = useState(false)

  useEffect(() => {
    if (isDragging) {
      setOpenedByDrag(true)
    } else if (!open) {
      setOpenedByDrag(false)
    }
  }, [isDragging, open])

  return (
    <Sheet
      open={open || isDragging}
      onOpenChange={nextOpen => {
        if (!isDragging) onOpenChange(nextOpen)
      }}
    >
      <SheetContent
        side="left"
        showCloseButton={false}
        // Don't autofocus the first tree control (Expand all) — that opens its
        // tooltip on focus when the drawer slides in on mobile.
        onOpenAutoFocus={e => e.preventDefault()}
        className="bg-sidebar text-sidebar-foreground w-[min(85vw,var(--mobile-sidebar-width))] gap-0 border-r p-0 sm:max-w-[min(85vw,var(--mobile-sidebar-width))]"
        style={
          {
            '--mobile-sidebar-width': `${width}px`,
            ...(isDragging
              ? {
                  transform: `translateX(min(0px, calc(-100% + ${dragOffset}px)))`,
                  transition: dragTransition || 'none',
                }
              : {}),
            ...(isDragging || (open && openedByDrag)
              ? { animation: 'none' }
              : {}),
          } as CSSProperties
        }
        data-testid="mobile-left-sidebar"
        data-swipe-dragging={isDragging}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Projects</SheetTitle>
          <SheetDescription>
            Navigate projects and worktrees. Tap the dimmed area to close.
          </SheetDescription>
        </SheetHeader>
        <SidebarWidthProvider value={width}>
          <div className="h-full w-full overflow-hidden">
            <Suspense fallback={null}>
              <LeftSideBar />
            </Suspense>
          </div>
        </SidebarWidthProvider>
      </SheetContent>
    </Sheet>
  )
}
