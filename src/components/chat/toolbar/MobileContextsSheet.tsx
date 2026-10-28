import type { ReactNode } from 'react'
import { ExternalLink } from '@/components/icons/reicon'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { openExternal } from '@/lib/platform'

export interface MobileContextItem {
  key: string
  icon: ReactNode
  label: string
  onView: () => void
  externalUrl?: string | null
}

export interface MobileContextGroup {
  title: string
  items: MobileContextItem[]
}

/** Bottom sheet listing the contexts loaded into the session, by kind. */
export function MobileContextsSheet({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: MobileContextGroup[]
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[75svh] overflow-hidden rounded-t-xl p-0"
        showCloseButton={false}
      >
        <SheetHeader className="shrink-0 border-b px-4 py-3 text-left">
          <SheetTitle>Contexts</SheetTitle>
          <SheetDescription className="sr-only">
            Issues, pull requests, and saved contexts loaded into this session.
          </SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
          {groups.map(group => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="px-3 pt-3 pb-1 text-xs text-muted-foreground">
                {group.title}
              </h3>
              {group.items.map(item => (
                <div key={item.key} className="flex items-center">
                  <button
                    type="button"
                    className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-left active:bg-accent"
                    onClick={() => {
                      onOpenChange(false)
                      item.onView()
                    }}
                  >
                    {item.icon}
                    <span className="truncate text-sm">{item.label}</span>
                  </button>
                  {item.externalUrl && (
                    <button
                      type="button"
                      aria-label={`Open ${item.label} in browser`}
                      className="mr-1 flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-accent"
                      onClick={() =>
                        item.externalUrl && openExternal(item.externalUrl)
                      }
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
