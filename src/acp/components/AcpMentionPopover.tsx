import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { File as FileIcon } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { acpSearchFiles } from '../api/api'

/**
 * `@file` mention popover for ACP sessions. Mirrors `AcpSlashPopover`'s
 * UX (anchored above the composer, ↑/↓/Enter via an imperative handle)
 * but ranking happens *server-side* via `acp_search_files` — the backend
 * does the gitignore walk and nucleo-matcher scoring once per worktree
 * with a TTL cache, so we don't ship the file list across the bridge.
 *
 * Selection semantics live in the parent: this component just hands the
 * picked relative path back via `onSelectPath`.
 */
const MAX_RESULTS = 50
const SEARCH_DEBOUNCE_MS = 80

function wrapIndex(index: number, length: number, delta: number): number {
  return length === 0 ? 0 : (index + delta + length) % length
}

export interface AcpMentionPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: () => void
}

export interface AcpMentionPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Worktree root the search is scoped to (absolute path). */
  worktreePath: string
  /** Substring after the leading `@` in the composer (e.g. `"src/foo"`). */
  searchQuery: string
  /** Element the popover anchors to — typically the textarea wrapper. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Repo-relative path picked by the user. */
  onSelectPath: (relPath: string) => void
  handleRef?: React.RefObject<AcpMentionPopoverHandle | null>
}

export function AcpMentionPopover({
  open,
  onOpenChange,
  worktreePath,
  searchQuery,
  anchorRef,
  onSelectPath,
  handleRef,
}: AcpMentionPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [stableWidth, setStableWidth] = useState<number | undefined>(undefined)
  const [results, setResults] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  // Debounce the search call — typing "@compone" otherwise fires 7 round-trips
  // to the backend; with 80ms debounce we batch trailing chars but still feel
  // instant. The cache makes repeat queries microseconds anyway, but skipping
  // the bridge round-trip is the bigger win.
  useEffect(() => {
    if (!open || !worktreePath) {
      setResults([])
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      acpSearchFiles(worktreePath, searchQuery, MAX_RESULTS)
        .then(paths => {
          if (cancelled) return
          setResults(paths)
        })
        .catch(() => {
          if (cancelled) return
          setResults([])
        })
        .finally(() => {
          if (cancelled) return
          setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, worktreePath, searchQuery])

  // Reset highlight to top whenever the result set changes — typing a
  // new char shouldn't leave the highlight pinned mid-list past where
  // results now end.
  useEffect(() => {
    setSelectedIndex(0)
  }, [searchQuery])

  const clamped = Math.min(selectedIndex, Math.max(0, results.length - 1))

  const select = useCallback(
    (path: string) => {
      onSelectPath(path)
    },
    [onSelectPath]
  )

  const selectHighlighted = useCallback(() => {
    const item = results[clamped]
    if (item) select(item)
  }, [results, clamped, select])

  useImperativeHandle(
    handleRef,
    () => ({
      moveUp: () => setSelectedIndex(i => wrapIndex(i, results.length, -1)),
      moveDown: () => setSelectedIndex(i => wrapIndex(i, results.length, 1)),
      selectCurrent: () => selectHighlighted(),
    }),
    [results.length, selectHighlighted]
  )

  // Keep highlighted row in view as the user arrows down through a
  // scrolling list.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.querySelector(`[data-index="${clamped}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [clamped])

  useEffect(() => {
    if (!open || !anchorRef.current) return
    setStableWidth(anchorRef.current.offsetWidth)
  }, [open, anchorRef])

  if (!open) return null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <PopoverContent
        className="p-0"
        style={stableWidth ? { width: stableWidth } : undefined}
        align="start"
        side="top"
        sideOffset={8}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList ref={listRef} className="max-h-[24rem]">
            {results.length === 0 ? (
              <CommandEmpty>
                {loading ? 'Searching…' : 'No files found'}
              </CommandEmpty>
            ) : (
              <CommandGroup>
                {results.map((path, i) => {
                  const isSelected = i === clamped
                  // Surface the basename prominently with the directory as
                  // secondary context — long deeply-nested paths otherwise
                  // collapse the basename into a truncated middle.
                  const sep = path.lastIndexOf('/')
                  const basename = sep >= 0 ? path.slice(sep + 1) : path
                  const dir = sep >= 0 ? path.slice(0, sep) : ''
                  return (
                    <CommandItem
                      key={path}
                      data-index={i}
                      value={path}
                      onSelect={() => select(path)}
                      className={cn(
                        'flex items-center gap-2 cursor-pointer',
                        'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                        isSelected && '!bg-accent !text-accent-foreground'
                      )}
                    >
                      <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-sm font-medium">
                          {basename}
                        </span>
                        {dir && (
                          <span className="truncate text-xs text-muted-foreground">
                            {dir}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
