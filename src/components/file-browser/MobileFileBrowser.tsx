import { Suspense, lazy, useCallback } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useUIStore } from '@/store/ui-store'

const FileBrowserSidebar = lazy(() =>
  import('./FileBrowserSidebar').then(mod => ({
    default: mod.FileBrowserSidebar,
  }))
)

interface MobileFileBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Mobile file browser as a right overlay drawer.
 */
export function MobileFileBrowser({
  open,
  onOpenChange,
}: MobileFileBrowserProps) {
  // While a file is open, ignore sheet dismiss (outside tap / focus steal).
  // The file viewer is closed only via its own X; reopening the browser is fine.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && useUIStore.getState().viewingFilePath) {
        return
      }
      onOpenChange(next)
    },
    [onOpenChange]
  )

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        onOpenAutoFocus={e => e.preventDefault()}
        onInteractOutside={e => {
          // File viewer dialog sits above this sheet; never treat it as "outside"
          // dismiss for the browser (would race-close both layers on mobile).
          const target = e.target as HTMLElement | null
          if (
            target?.closest?.(
              '[data-slot="dialog-content"], [data-slot="dialog-overlay"], [data-slot="dialog-close"]'
            )
          ) {
            e.preventDefault()
          }
        }}
        // Almost full width; the thin dimmed strip on the left still dismisses.
        className="bg-sidebar text-sidebar-foreground w-[calc(100vw-3rem)] gap-0 border-l p-0 sm:max-w-[calc(100vw-3rem)]"
        data-testid="mobile-file-browser"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>File browser</SheetTitle>
          <SheetDescription>
            Browse and open files in the current worktree
          </SheetDescription>
        </SheetHeader>
        <Suspense fallback={null}>
          <FileBrowserSidebar />
        </Suspense>
      </SheetContent>
    </Sheet>
  )
}

export default MobileFileBrowser
