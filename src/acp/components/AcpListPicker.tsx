import { Check } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'

/**
 * Generic id/name/description shape that backs all ACP composer pickers
 * (model, mode, thought level). The `acp-store` types (`AcpModelInfo` etc.)
 * structurally satisfy this.
 */
export interface AcpListPickerItem {
  id: string
  name: string
  description?: string
}

/** Optional keyboard shortcut hint shown in the tooltip. When `match`
 *  is provided, the picker also listens at window/capture for the
 *  shortcut and toggles open/closed. When `match` is omitted, the
 *  shortcut is display-only — useful when the binding is owned by a
 *  parent (e.g. mode cycling via Shift+Tab in the Composer). */
export interface AcpListPickerShortcut {
  /** Returns true when the keyboard event should toggle this picker. */
  match?: (e: KeyboardEvent) => boolean
  /** Pretty label for the tooltip (e.g. `"⌥ + P"`). */
  display: string
}

export interface AcpListPickerProps<T extends AcpListPickerItem> {
  /** ID of the currently active item. May be undefined pre-hydration. */
  currentId: string | undefined
  /** Catalog of selectable items. Empty list → component renders nothing. */
  available: T[]
  /** Called when the user picks a different item. Caller owns the optimistic
   *  update + the actual round trip. */
  onChange: (id: string) => void
  /** Disable interaction (e.g. while a previous change is in flight, or
   *  before the session has been created). */
  disabled?: boolean
  /** Extra classes for the trigger button. */
  triggerClassName?: string
  /** Fired after the popover finishes closing. Use to restore focus to the
   *  upstream control (e.g. the chat textarea). */
  onClose?: () => void

  // — Per-instance copy ————————————————————————————————————————————————

  /** ARIA label for the trigger button (e.g. `"Choose model"`). */
  ariaLabel: string
  /** Tooltip text shown above the trigger (e.g. `"Model"`). */
  tooltipLabel: string
  /** Placeholder text inside the search Input. */
  searchPlaceholder: string
  /** Shown when the filter eliminates all rows. */
  emptyText: string
  /** Trigger label fallback when no item matches `currentId`. */
  fallbackLabel: string

  // — Optional behaviour ————————————————————————————————————————————————

  /** Global keyboard shortcut that toggles the popover open/closed. */
  shortcut?: AcpListPickerShortcut
  /** Controlled open state. When provided, the picker yields control over
   *  open/close to the parent (still calls `onOpenChange` + `onClose`
   *  callbacks). Use for behaviours like "hold-to-cycle" where the parent
   *  drives open/close from external key events. */
  open?: boolean
  /** Notified on every open-state change. Required when `open` is controlled. */
  onOpenChange?: (next: boolean) => void
}

/**
 * Generic, presentational popover-list picker that backs all three ACP
 * composer pickers (model, mode, thought level). The three differ only in
 * labels, item type, and the optional toggle shortcut — extracted into
 * one component so behaviour stays in lock-step.
 *
 * Behaviour shared across all three:
 *  - Popover trigger pill with tooltip showing `tooltipLabel` + optional
 *    shortcut kbd.
 *  - Searchable list (case-insensitive, matches `name`/`id`/`description`).
 *  - Currently-selected row pre-highlighted on open; arrow keys wrap.
 *  - Escape closes via window/capture listener and stops propagation so
 *    it doesn't bubble to the SessionChatModal's escape-to-canvas handler.
 *  - Optional global shortcut toggles open/closed.
 *  - `onClose` fires whenever the popover closes (selection, outside
 *    click, Escape) so callers can restore focus to the textarea.
 */
export function AcpListPicker<T extends AcpListPickerItem>({
  currentId,
  available,
  onChange,
  disabled = false,
  triggerClassName,
  onClose,
  ariaLabel,
  tooltipLabel,
  searchPlaceholder,
  emptyText,
  fallbackLabel,
  shortcut,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: AcpListPickerProps<T>) {
  const [openInternal, setOpenInternal] = useState(false)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : openInternal
  const [search, setSearch] = useState('')
  const [highlighted, setHighlighted] = useState<string>('')

  const itemValue = useCallback((item: T) => `${item.name} ${item.id}`, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!isControlled) setOpenInternal(next)
      onOpenChangeProp?.(next)
      if (!next) {
        setSearch('')
        onClose?.()
      } else {
        const current = available.find(item => item.id === currentId)
        setHighlighted(current ? itemValue(current) : '')
      }
    },
    [available, currentId, isControlled, itemValue, onClose, onOpenChangeProp]
  )

  // Keep the highlighted row in sync with `currentId` while the picker is
  // open — needed for "hold-to-cycle" parents that drive selection from
  // outside (mode picker on Shift+Tab) so the highlight tracks each step.
  useEffect(() => {
    if (!open) return
    const current = available.find(item => item.id === currentId)
    setHighlighted(current ? itemValue(current) : '')
  }, [open, currentId, available, itemValue])

  useEffect(() => {
    if (disabled || available.length === 0) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (shortcut?.match && shortcut.match(e)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        handleOpenChange(!open)
        return
      }
      // Escape closes when open, even if focus has escaped the popover.
      // stopImmediatePropagation prevents SessionChatModal's window-level
      // Escape listener from also firing and closing the modal back to
      // the project canvas.
      if (e.key === 'Escape' && open) {
        e.preventDefault()
        e.stopImmediatePropagation()
        handleOpenChange(false)
      }
    }
    // Capture phase so we run before bubble-phase listeners.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [disabled, available.length, open, handleOpenChange, shortcut])

  const handleSelect = useCallback(
    (id: string) => {
      onChange(id)
      handleOpenChange(false)
    },
    [onChange, handleOpenChange]
  )

  if (available.length === 0) return null

  const current = available.find(item => item.id === currentId)
  const triggerLabel = current?.name ?? currentId ?? fallbackLabel

  // Cheap client-side filter — lists are small (typically < 20 items).
  const q = search.trim().toLowerCase()
  const filtered = q
    ? available.filter(
        item =>
          item.name.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q) ||
          (item.description?.toLowerCase().includes(q) ?? false)
      )
    : available

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={ariaLabel}
              className={cn(
                'flex h-8 max-w-[22rem] items-center gap-2 rounded-md border border-border/70 bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
                triggerClassName
              )}
            >
              <span className="truncate">{triggerLabel}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <span className="flex items-center gap-2">
            {tooltipLabel}
            {shortcut ? <Kbd>{shortcut.display}</Kbd> : null}
          </span>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-[min(28rem,calc(100vw-4rem))] p-0"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <Command
            shouldFilter={false}
            loop
            value={highlighted}
            onValueChange={setHighlighted}
            className="flex h-full flex-1 flex-col"
          >
            <div className="border-b p-2">
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    handleOpenChange(false)
                  }
                }}
                placeholder={searchPlaceholder}
                className="h-9 text-base md:text-sm"
              />
            </div>
            <CommandList className="max-h-[24rem]">
              {filtered.length === 0 && (
                <CommandEmpty>{emptyText}</CommandEmpty>
              )}
              <CommandGroup>
                {filtered.map(item => {
                  const isSelected = item.id === currentId
                  return (
                    <CommandItem
                      key={item.id}
                      value={itemValue(item)}
                      onSelect={() => handleSelect(item.id)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{item.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {item.description ?? item.id}
                        </div>
                      </div>
                      <Check
                        className={cn(
                          'ml-2 h-4 w-4 shrink-0',
                          isSelected ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  )
}
