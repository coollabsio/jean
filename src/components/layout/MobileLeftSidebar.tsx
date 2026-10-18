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

// Keep in sync with the `3rem` gutter in the drawer width class below.
const DRAWER_GUTTER_PX = 48

/** Real drawer width in px, so sidebar content can size itself correctly. */
function useDrawerWidth() {
  const [width, setWidth] = useState(
    () => window.innerWidth - DRAWER_GUTTER_PX
  )

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth - DRAWER_GUTTER_PX)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return width
}

interface MobileLeftSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
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
  isDragging = false,
  dragOffset = 0,
  dragTransition = '',
}: MobileLeftSidebarProps) {
  const [openedByDrag, setOpenedByDrag] = useState(false)
  const width = useDrawerWidth()

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
        // Almost full width; the thin dimmed strip on the right still dismisses.
        className="bg-sidebar text-sidebar-foreground dark:bg-[#0b0b0b] w-[calc(100vw-3rem)] gap-0 border-r p-0 sm:max-w-[calc(100vw-3rem)]"
        style={
          {
            ...(isDragging
              ? {
                  transform: `translate3d(min(0px, calc(-100% + ${dragOffset}px)), 0, 0)`,
                  transition: dragTransition || 'none',
                  willChange: 'transform',
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
