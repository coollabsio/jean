import { Search, X } from '@/components/icons/reicon'
import { Input } from '@/components/ui/input'
import { useProjectsStore } from '@/store/projects-store'
import { SearchFieldContextMenu } from './SearchFieldContextMenu'

/** Search field shared by all sidebar tabs; the text stays across tabs. */
export function SidebarSearchField({ label }: { label: string }) {
  const query = useProjectsStore(state => state.sidebarSearchQuery)
  const clear = () => useProjectsStore.getState().setSidebarSearchQuery('')
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <SearchFieldContextMenu>
        <Input
          type="text"
          role="searchbox"
          value={query}
          onChange={event =>
            useProjectsStore
              .getState()
              .setSidebarSearchQuery(event.target.value)
          }
          onKeyDown={event => {
            if (event.key === 'Escape' && query) {
              event.preventDefault()
              clear()
            }
          }}
          placeholder="Search…"
          aria-label={label}
          className="h-8 border-transparent bg-transparent pl-7 pr-7 text-xs shadow-none focus-visible:border-transparent dark:bg-transparent"
        />
      </SearchFieldContextMenu>
      {query && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** True when any of the texts contains the query (case-insensitive). */
export function matchesSidebarSearch(
  query: string,
  ...texts: (string | null | undefined)[]
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return texts.some(text => text?.toLowerCase().includes(needle))
}
