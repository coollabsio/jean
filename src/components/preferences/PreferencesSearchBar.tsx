import React from 'react'
import { Search, type LucideIcon } from '@/components/icons/reicon'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import type { PreferencePane } from '@/store/ui-store'
import type { PreferenceSearchEntry } from './preferences-search'

interface SearchGroup {
  pane: PreferencePane
  title: string
  items: PreferenceSearchEntry[]
}

interface PreferencesSearchBarProps {
  variant: 'desktop' | 'mobile'
  searchValue: string
  onSearchValueChange: (value: string) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  selectedId: string
  onSelectedIdChange: (id: string) => void
  isSearching: boolean
  searchResults: PreferenceSearchEntry[]
  groupedResults: SearchGroup[]
  paneIconMap: Record<PreferencePane, LucideIcon>
  onResultSelect: (entry: PreferenceSearchEntry) => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  containerRef?: React.RefObject<HTMLDivElement | null>
}

export const PreferencesSearchBar: React.FC<PreferencesSearchBarProps> = ({
  variant,
  searchValue,
  onSearchValueChange,
  searchOpen,
  onSearchOpenChange,
  selectedId,
  onSelectedIdChange,
  isSearching,
  searchResults,
  groupedResults,
  paneIconMap,
  onResultSelect,
  inputRef,
  containerRef,
}) => {
  const isDesktop = variant === 'desktop'

  return (
    <div
      ref={containerRef}
      className={isDesktop ? 'relative shrink-0' : 'relative md:hidden'}
    >
      <Command
        value={selectedId}
        onValueChange={onSelectedIdChange}
        shouldFilter={false}
        className={
          isDesktop
            ? 'bg-transparent overflow-visible h-auto w-auto'
            : 'bg-transparent overflow-visible'
        }
      >
        <div
          className={
            isDesktop
              ? 'flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm focus-within:ring-1 focus-within:ring-ring focus-within:border-ring transition-colors'
              : 'flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm focus-within:ring-1 focus-within:ring-ring focus-within:border-ring transition-colors'
          }
        >
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            aria-label="Search settings"
            placeholder="Search settings..."
            value={searchValue}
            onChange={e => {
              onSearchValueChange(e.target.value)
              onSearchOpenChange(true)
            }}
            onFocus={() => {
              if (searchValue.trim()) onSearchOpenChange(true)
            }}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground text-sm"
          />
          {isDesktop && !searchValue && (
            <kbd className="pointer-events-none text-[10px] font-mono text-muted-foreground/60">
              /
            </kbd>
          )}
        </div>

        {searchOpen && isSearching && (
          <CommandList
            className={
              isDesktop
                ? 'absolute top-full left-0 mt-1.5 w-80 max-w-[calc(100vw-2rem)] max-h-[360px] overflow-y-auto rounded-lg border border-border bg-popover shadow-lg z-50'
                : 'absolute top-full left-0 right-0 mt-1.5 max-h-[320px] overflow-y-auto rounded-lg border border-border bg-popover shadow-lg z-50'
            }
          >
            {searchResults.length === 0 ? (
              <CommandEmpty>No settings found.</CommandEmpty>
            ) : (
              groupedResults.map(group => {
                const Icon = paneIconMap[group.pane]
                return (
                  <CommandGroup
                    key={group.pane}
                    heading={
                      <span className="flex items-center gap-1.5">
                        {Icon && <Icon className="size-3" />}
                        {group.title}
                      </span>
                    }
                  >
                    {group.items.map(result => (
                      <CommandItem
                        key={result.id}
                        value={result.id}
                        onSelect={() => onResultSelect(result)}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="truncate text-sm">
                            {result.title}
                          </span>
                          {result.sectionTitle &&
                            result.sectionTitle !== result.paneTitle && (
                              <span className="text-xs text-muted-foreground truncate">
                                {result.sectionTitle}
                              </span>
                            )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )
              })
            )}
          </CommandList>
        )}
      </Command>
    </div>
  )
}
