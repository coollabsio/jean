import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Terminal, Wand2 } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { useClaudeSkills, useClaudeCommands } from '@/services/skills'
import type { ClaudeSkill, ClaudeCommand, PendingSkill } from '@/types/chat'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/uuid'
import { fuzzySearchItems } from '@/lib/fuzzy-search'

export interface SlashPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: () => void
}

interface SlashPopoverProps {
  /** Whether the popover is open */
  open: boolean
  /** Callback when popover should close */
  onOpenChange: (open: boolean) => void
  /** Callback when a skill is selected (adds to pending, continues editing) */
  onSelectSkill: (skill: PendingSkill) => void
  /** Callback when a command is selected (executes immediately) */
  onSelectCommand: (command: ClaudeCommand) => void
  /** Current search query (text after /) */
  searchQuery: string
  /** Position for the anchor (relative to textarea container) */
  anchorPosition: { top: number; left: number } | null
  /** Reference to the form container for stable positioning */
  containerRef?: React.RefObject<HTMLElement | null>
  /** Whether slash is at prompt start (enables commands) */
  isAtPromptStart: boolean
  /** Worktree path for loading project-level commands/skills */
  worktreePath?: string | null
  /** Ref to expose navigation methods to parent */
  handleRef?: React.RefObject<SlashPopoverHandle | null>
}

type ListItem =
  | { type: 'command'; data: ClaudeCommand }
  | { type: 'skill'; data: ClaudeSkill }

export function SlashPopover({
  open,
  onOpenChange,
  onSelectSkill,
  onSelectCommand,
  searchQuery,
  anchorPosition,
  containerRef,
  isAtPromptStart,
  worktreePath,
  handleRef,
}: SlashPopoverProps) {
  const { data: skills = [] } = useClaudeSkills(worktreePath)
  const { data: commands = [] } = useClaudeCommands(worktreePath)
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Filter and combine items based on search query and context (fuzzy match)
  const filteredItems = useMemo(() => {
    const items: ListItem[] = []

    // Add commands first (only if at prompt start)
    if (isAtPromptStart) {
      fuzzySearchItems(commands, searchQuery, 10).forEach(cmd => {
        items.push({ type: 'command', data: cmd })
      })
    }

    // Add skills
    fuzzySearchItems(skills, searchQuery, 10).forEach(skill => {
      items.push({ type: 'skill', data: skill })
    })

    return items.slice(0, 15) // Limit total to 15
  }, [skills, commands, searchQuery, isAtPromptStart])

  // Clamp selectedIndex to valid range (handles case when filter reduces results)
  const clampedSelectedIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredItems.length - 1)
  )

  const handleSelectSkill = useCallback(
    (skill: ClaudeSkill) => {
      const pendingSkill: PendingSkill = {
        id: generateId(),
        name: skill.name,
        path: skill.path,
      }
      onSelectSkill(pendingSkill)
      onOpenChange(false)
    },
    [onSelectSkill, onOpenChange]
  )

  const handleSelectCommand = useCallback(
    (command: ClaudeCommand) => {
      onSelectCommand(command)
      onOpenChange(false)
    },
    [onSelectCommand, onOpenChange]
  )

  // Handle selecting the currently highlighted item
  const selectHighlighted = useCallback(() => {
    const item = filteredItems[clampedSelectedIndex]
    if (!item) return

    if (item.type === 'command') {
      handleSelectCommand(item.data)
    } else {
      handleSelectSkill(item.data)
    }
  }, [
    filteredItems,
    clampedSelectedIndex,
    handleSelectCommand,
    handleSelectSkill,
  ])

  // Expose navigation methods via ref for parent to call
  useImperativeHandle(handleRef, () => {
    return {
      moveUp: () => {
        setSelectedIndex(i => Math.max(i - 1, 0))
      },
      moveDown: () => {
        setSelectedIndex(i => Math.min(i + 1, filteredItems.length - 1))
      },
      selectCurrent: () => {
        selectHighlighted()
      },
    }
  }, [filteredItems.length, selectHighlighted])

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    const selectedItem = list.querySelector(
      `[data-index="${clampedSelectedIndex}"]`
    )
    selectedItem?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelectedIndex])

  // Calculate anchor position relative to form container for stable positioning
  // When skill badges appear above the textarea, the ChatInput div shifts down.
  // By anchoring to the form's top, the popover stays in the same position.
  const anchorRef = useRef<HTMLDivElement>(null)
  const [stableAnchorTop, setStableAnchorTop] = useState(0)

  useEffect(() => {
    if (
      !open ||
      !anchorPosition ||
      !containerRef?.current ||
      !anchorRef.current
    ) {
      return
    }
    const formRect = containerRef.current.getBoundingClientRect()
    const wrapperRect = anchorRef.current.parentElement?.getBoundingClientRect()
    if (wrapperRect) {
      // Negative offset to position at form top instead of ChatInput top
      setStableAnchorTop(formRect.top - wrapperRect.top)
    }
  }, [open, anchorPosition, containerRef])

  if (!open || !anchorPosition) return null

  // Split items by type for grouped rendering
  const commandItems = filteredItems.filter(item => item.type === 'command')
  const skillItems = filteredItems.filter(item => item.type === 'skill')

  const resolvedTop = containerRef ? stableAnchorTop : anchorPosition.top

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        ref={anchorRef}
        style={{
          position: 'absolute',
          top: resolvedTop,
          left: anchorPosition.left,
          pointerEvents: 'none',
        }}
      />
      <PopoverContent
        className="w-80 p-0"
        align="start"
        side="top"
        sideOffset={12}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList ref={listRef} className="max-h-[250px]">
            {filteredItems.length === 0 ? (
              <CommandEmpty>No commands or skills found</CommandEmpty>
            ) : (
              <>
                {commandItems.length > 0 && (
                  <CommandGroup heading="Commands">
                    {commandItems.map((item, localIndex) => {
                      // Commands come first in filteredItems, so localIndex = globalIndex
                      const globalIndex = localIndex
                      const isSelected = globalIndex === clampedSelectedIndex
                      return (
                        <CommandItem
                          key={`cmd-${item.data.name}`}
                          data-index={globalIndex}
                          value={`cmd-${item.data.name}`}
                          onSelect={() => handleSelectCommand(item.data)}
                          className={cn(
                            'flex items-center gap-2 cursor-pointer',
                            // Override cmdk's internal selection styling - we manage selection ourselves
                            'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                            isSelected && '!bg-accent !text-accent-foreground'
                          )}
                        >
                          <Terminal className="h-4 w-4 shrink-0 text-blue-500" />
                          <div className="flex flex-col min-w-0">
                            <span className="truncate text-sm font-medium">
                              /{item.data.name}
                            </span>
                            {item.data.description && (
                              <span className="truncate text-xs text-muted-foreground">
                                {item.data.description}
                              </span>
                            )}
                          </div>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )}
                {skillItems.length > 0 && (
                  <CommandGroup heading="Skills">
                    {skillItems.map((item, localIndex) => {
                      // Skills come after commands, so globalIndex = commandItems.length + localIndex
                      const globalIndex = commandItems.length + localIndex
                      const isSelected = globalIndex === clampedSelectedIndex
                      return (
                        <CommandItem
                          key={`skill-${item.data.name}`}
                          data-index={globalIndex}
                          value={`skill-${item.data.name}`}
                          onSelect={() => handleSelectSkill(item.data)}
                          className={cn(
                            'flex items-center gap-2 cursor-pointer',
                            // Override cmdk's internal selection styling - we manage selection ourselves
                            'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                            isSelected && '!bg-accent !text-accent-foreground'
                          )}
                        >
                          <Wand2 className="h-4 w-4 shrink-0 text-purple-500" />
                          <div className="flex flex-col min-w-0">
                            <span className="truncate text-sm font-medium">
                              /{item.data.name}
                            </span>
                            {item.data.description && (
                              <span className="truncate text-xs text-muted-foreground">
                                {item.data.description}
                              </span>
                            )}
                          </div>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
