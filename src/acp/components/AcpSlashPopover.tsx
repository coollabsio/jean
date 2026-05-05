import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import Fuse from 'fuse.js'
import type { IFuseOptions } from 'fuse.js'
import { Terminal } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { AcpAvailableCommand } from '../store/acp-store'

/**
 * Slash-command popover for ACP sessions. Mirrors the non-ACP
 * `SlashPopover` UX (anchored above the composer, fuzzy filter via
 * Fuse, arrow-key + Enter navigation through an imperative handle) but
 * collapsed to a single flat list — ACP advertises a flat
 * `availableCommands` array per session, with no skills/backends/plugins
 * concept yet.
 *
 * Selection semantics live in the parent: the parent inserts `/name `
 * into the composer and this component just hands the picked command
 * back via `onSelectCommand`.
 */
const MAX_VISIBLE_ITEMS = 500
const FUSE_OPTIONS = {
  keys: [
    { name: 'name', weight: 2 },
    { name: 'description', weight: 1 },
  ],
  threshold: 0.4,
  ignoreLocation: true,
} satisfies IFuseOptions<AcpAvailableCommand>

function commandIdentity(cmd: AcpAvailableCommand): string {
  return `${cmd.name}\u0000${cmd.input?.hint ?? ''}\u0000${cmd.description ?? ''}`
}

function commandRichness(cmd: AcpAvailableCommand): number {
  return (cmd.input?.hint ? 10_000 : 0) + (cmd.description?.length ?? 0)
}

/**
 * ACP may advertise multiple commands with the same slash name (e.g. two
 * different `/review` entries from different sources). In ACP we don't render
 * a source label and selecting either row inserts the same `/name ` text, so
 * duplicate names only create ambiguity. Collapse them down to the "richest"
 * variant (prefer one with an argument hint, then the longer description).
 */
function dedupeCommandsByName(
  commands: AcpAvailableCommand[]
): AcpAvailableCommand[] {
  const deduped = new Map<string, AcpAvailableCommand>()
  for (const cmd of commands) {
    const prev = deduped.get(cmd.name)
    if (!prev || commandRichness(cmd) > commandRichness(prev)) {
      deduped.set(cmd.name, cmd)
    }
  }
  return Array.from(deduped.values())
}

function wrapIndex(index: number, length: number, delta: number): number {
  return length === 0 ? 0 : (index + delta + length) % length
}

export interface AcpSlashPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: () => void
}

export interface AcpSlashPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Catalog from the agent. Component returns null when empty. */
  commands: AcpAvailableCommand[]
  /** Substring after the leading `/` in the composer (e.g. `"in"` for `"/in"`). */
  searchQuery: string
  /** Element the popover anchors to — typically the textarea wrapper. */
  anchorRef: React.RefObject<HTMLElement | null>
  onSelectCommand: (command: AcpAvailableCommand) => void
  handleRef?: React.RefObject<AcpSlashPopoverHandle | null>
}

export function AcpSlashPopover({
  open,
  onOpenChange,
  commands,
  searchQuery,
  anchorRef,
  onSelectCommand,
  handleRef,
}: AcpSlashPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [stableWidth, setStableWidth] = useState<number | undefined>(undefined)

  const visibleCommands = useMemo(
    () => dedupeCommandsByName(commands),
    [commands]
  )

  const fuse = useMemo(
    () => new Fuse(visibleCommands, FUSE_OPTIONS),
    [visibleCommands]
  )

  const filtered = useMemo(() => {
    if (!searchQuery) return visibleCommands.slice(0, MAX_VISIBLE_ITEMS)
    return fuse
      .search(searchQuery, { limit: MAX_VISIBLE_ITEMS })
      .map(r => r.item)
  }, [visibleCommands, fuse, searchQuery])

  // Reset highlight to top whenever the result set changes — typing a
  // new char shouldn't leave the highlight pinned mid-list past where
  // results now end.
  useEffect(() => {
    setSelectedIndex(0)
  }, [searchQuery])

  const clamped = Math.min(selectedIndex, Math.max(0, filtered.length - 1))

  const select = useCallback(
    (cmd: AcpAvailableCommand) => {
      onSelectCommand(cmd)
    },
    [onSelectCommand]
  )

  const selectHighlighted = useCallback(() => {
    const item = filtered[clamped]
    if (item) select(item)
  }, [filtered, clamped, select])

  useImperativeHandle(
    handleRef,
    () => ({
      moveUp: () => setSelectedIndex(i => wrapIndex(i, filtered.length, -1)),
      moveDown: () => setSelectedIndex(i => wrapIndex(i, filtered.length, 1)),
      selectCurrent: () => selectHighlighted(),
    }),
    [filtered.length, selectHighlighted]
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

  if (!open || visibleCommands.length === 0) return null

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
            {filtered.length === 0 ? (
              <CommandEmpty>No commands found</CommandEmpty>
            ) : (
              <CommandGroup>
                {filtered.map((cmd, i) => {
                  const isSelected = i === clamped
                  const itemId = commandIdentity(cmd)
                  return (
                    <CommandItem
                      key={itemId}
                      data-index={i}
                      value={itemId}
                      onSelect={() => select(cmd)}
                      className={cn(
                        'flex items-center gap-2 cursor-pointer',
                        'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                        isSelected && '!bg-accent !text-accent-foreground'
                      )}
                    >
                      <Terminal className="h-4 w-4 shrink-0 text-blue-500" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">
                          /{cmd.name}
                          {cmd.input?.hint && (
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {cmd.input.hint}
                            </span>
                          )}
                        </span>
                        {cmd.description && (
                          <span className="truncate text-xs text-muted-foreground">
                            {cmd.description}
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
