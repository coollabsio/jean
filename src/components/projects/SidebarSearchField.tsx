import { Search } from '@/components/icons/reicon'
import { useUIStore } from '@/store/ui-store'

/** Looks like a search field; opens the command palette, where search lives. */
export function SidebarSearchField() {
  return (
    <button
      type="button"
      aria-label="Search"
      onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}
      className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Search className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">Search…</span>
    </button>
  )
}
