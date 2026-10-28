import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Server } from '@/components/icons/reicon'
import { AgentIcon } from '@/components/icons/JeanAgentIcon'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { BOTTOM_UP_LIST_CLASS } from './mention-list'
import type { FileMentionPopoverHandle } from './FileMentionPopover'
import {
  filterMentionCandidates,
  MENTION_GROUPS,
  type MentionCandidate,
} from './agent-mentions'

interface AgentMentionPopoverProps {
  candidates: MentionCandidate[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (candidate: MentionCandidate) => void
  /** Text after @ */
  searchQuery: string
  anchorPosition: { top: number; left: number } | null
  containerWidth?: number
  /** Same keyboard handle as the file picker, so ChatInput drives both */
  handleRef?: React.RefObject<FileMentionPopoverHandle | null>
}

function MentionIcon({ candidate }: { candidate: MentionCandidate }) {
  switch (candidate.type) {
    case 'agent':
      return <AgentIcon icon={candidate.icon} className="size-4 shrink-0" />
    case 'remote_jean':
      return <Server className="size-4 shrink-0 text-muted-foreground" />
    case 'project':
      return candidate.avatarUrl ? (
        <img
          src={candidate.avatarUrl}
          alt=""
          className="size-4 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted-foreground/20 text-2xs leading-none font-medium uppercase">
          {candidate.name[0] ?? '?'}
        </span>
      )
  }
}

/**
 * `@` picker for agent chats: agents, remote Jeans, and projects. Same look
 * and keyboard model as `FileMentionPopover`.
 */
export function AgentMentionPopover({
  candidates,
  open,
  onOpenChange,
  onSelect,
  searchQuery,
  anchorPosition,
  containerWidth,
  handleRef,
}: AgentMentionPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  const items = useMemo(
    () => filterMentionCandidates(candidates, searchQuery),
    [candidates, searchQuery]
  )
  const clampedSelectedIndex = Math.min(
    selectedIndex,
    Math.max(0, items.length - 1)
  )

  // Reset the highlight when the popover opens or the query changes, adjusted
  // during render so the stale highlight never paints.
  const [resetDeps, setResetDeps] = useState({ open, searchQuery })
  if (resetDeps.open !== open || resetDeps.searchQuery !== searchQuery) {
    setResetDeps({ open, searchQuery })
    if (open) setSelectedIndex(0)
  }

  const handleSelect = useCallback(
    (candidate: MentionCandidate) => {
      onSelect(candidate)
      onOpenChange(false)
    },
    [onSelect, onOpenChange]
  )

  useImperativeHandle(
    handleRef,
    () => ({
      // List renders bottom-up: ArrowUp moves to the next (worse) match.
      moveUp: () =>
        setSelectedIndex(i => Math.min(i + 1, Math.max(0, items.length - 1))),
      moveDown: () => setSelectedIndex(i => Math.max(i - 1, 0)),
      selectCurrent: () => {
        const item = items[clampedSelectedIndex]
        if (item) handleSelect(item)
      },
      selectPreviousScope: () => undefined,
      selectNextScope: () => undefined,
    }),
    [items, clampedSelectedIndex, handleSelect]
  )

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${clampedSelectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelectedIndex])

  if (!open || !anchorPosition) return null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        className="-mx-4 md:-mx-6"
        style={{
          position: 'absolute',
          top: anchorPosition.top,
          left: 0,
          right: 0,
          pointerEvents: 'none',
        }}
      />
      <PopoverContent
        className="p-0"
        style={containerWidth ? { width: containerWidth } : undefined}
        align="start"
        collisionPadding={0}
        side="top"
        sideOffset={20}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <div className="flex min-h-5 items-center border-b px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            Mention an agent, remote Jean, or project
          </span>
        </div>
        <Command shouldFilter={false}>
          <CommandList
            ref={listRef}
            className={cn('max-h-[min(360px,60vh)]', BOTTOM_UP_LIST_CLASS)}
          >
            {items.length === 0 ? (
              <CommandEmpty>No matches</CommandEmpty>
            ) : (
              MENTION_GROUPS.map(({ type, heading }) => {
                const groupItems = items.flatMap((item, index) =>
                  item.type === type ? [{ item, index }] : []
                )
                if (groupItems.length === 0) return null
                return (
                  <CommandGroup key={type} heading={heading}>
                    {groupItems.map(({ item, index }) => (
                      <CommandItem
                        key={`${item.type}:${item.serverName ?? ''}:${item.id}`}
                        data-index={index}
                        value={`${item.type}:${item.token}`}
                        onSelect={() => handleSelect(item)}
                        className={cn(
                          'flex cursor-pointer items-center gap-2',
                          // We manage selection ourselves
                          'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                          index === clampedSelectedIndex &&
                            '!bg-accent !text-accent-foreground'
                        )}
                      >
                        <MentionIcon candidate={item} />
                        <span className="truncate text-sm">{item.name}</span>
                        {item.serverName && (
                          <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                            {item.serverName}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )
              })
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
