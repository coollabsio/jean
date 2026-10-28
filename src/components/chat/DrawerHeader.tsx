import type { ComponentType } from 'react'
import {
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelRightDashed,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import { SheetTitle } from '@/components/ui/sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { MODAL_TERMINAL_PRIMARY_ROW_CLASS } from './modal-terminal-layout'

export type DrawerDockMode = 'floating' | 'left' | 'right' | 'bottom'

const DOCK_MODES: DrawerDockMode[] = ['floating', 'left', 'right', 'bottom']

const DOCK_OPTIONS: Record<
  DrawerDockMode,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  floating: { label: 'Float', icon: PanelRightDashed },
  left: { label: 'Dock left', icon: PanelLeft },
  right: { label: 'Dock right', icon: PanelRight },
  bottom: { label: 'Dock bottom', icon: PanelBottom },
}

interface DrawerHeaderProps {
  title: string
  icon: ComponentType<{ className?: string }>
  dockMode: DrawerDockMode
  onDockModeChange: (mode: DrawerDockMode) => void
  onClose: () => void
  /** Extra attributes for the dock menu content (the browser uses this to
   * hide its native webview, which paints over DOM, while the menu is open). */
  menuContentProps?: Record<`data-${string}`, string>
}

/** Shared header for the terminal and browser drawers: title, dock menu, close. */
export function DrawerHeader({
  title,
  icon: Icon,
  dockMode,
  onDockModeChange,
  onClose,
  menuContentProps,
}: DrawerHeaderProps) {
  const CurrentIcon = DOCK_OPTIONS[dockMode].icon

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-between gap-2 border-b px-3',
        MODAL_TERMINAL_PRIMARY_ROW_CLASS
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        {/* Floating drawers render inside a Sheet, which needs a SheetTitle. */}
        {dockMode === 'floating' ? (
          <SheetTitle className="text-sm font-medium">{title}</SheetTitle>
        ) : (
          <div className="text-sm font-medium">{title}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${title} position`}
                >
                  <CurrentIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Position</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" {...menuContentProps}>
            <DropdownMenuRadioGroup
              value={dockMode}
              onValueChange={value => {
                const next = DOCK_MODES.find(mode => mode === value)
                if (next) onDockModeChange(next)
              }}
            >
              {DOCK_MODES.map(mode => {
                const { label, icon: OptionIcon } = DOCK_OPTIONS[mode]
                return (
                  <DropdownMenuRadioItem key={mode} value={mode}>
                    <OptionIcon className="size-3.5" />
                    {label}
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ModalCloseButton size="sm" onClick={onClose} />
      </div>
    </div>
  )
}
