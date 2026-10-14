import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  BarChart3,
  Command,
  Menu,
  Plus,
  Github,
  Heart,
} from '@/components/icons/reicon'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { usePreferences } from '@/services/preferences'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'
import { openExternal } from '@/lib/platform'
import {
  UsageMenuItem,
  useUsageEntries,
} from '@/components/usage/usage-entries'

interface DockBurgerButtonProps {
  /** Extra classes merged onto the trigger button (e.g. responsive visibility). */
  className?: string
}

export function DockBurgerButton({ className }: DockBurgerButtonProps = {}) {
  const isMobile = useIsMobile()
  const { data: preferences } = usePreferences()

  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Only installed + authenticated backends appear in the usage menu.
  const usageEntries = useUsageEntries(menuOpen)
  const showUsageSection = usageEntries.length > 0

  const toggleMenu = useCallback(() => {
    setMenuOpen(prev => !prev)
  }, [])

  // Global shortcut — only respond when this instance is the visible variant.
  // Both desktop + mobile burgers mount; CSS (`hidden`/`@xl:hidden`) hides one.
  // `offsetParent === null` is true for `display: none`, so the hidden variant skips.
  useEffect(() => {
    const handler = () => {
      if (!triggerRef.current || triggerRef.current.offsetParent === null)
        return
      toggleMenu()
    }
    window.addEventListener('toggle-quick-menu', handler)
    return () => window.removeEventListener('toggle-quick-menu', handler)
  }, [toggleMenu])

  const commandPaletteShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_command_palette ??
      DEFAULT_KEYBINDINGS.open_command_palette) as string
  )
  const menuShortcut = formatShortcutDisplay(
    (preferences?.keybindings?.open_quick_menu ??
      DEFAULT_KEYBINDINGS.open_quick_menu) as string
  )

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={`Menu (${menuShortcut})`}
              className={cn(
                'flex h-8 items-center gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground',
                className
              )}
            >
              <Menu className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Menu ({menuShortcut})</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" className="min-w-[240px]">
        <DropdownMenuItem
          onClick={() =>
            useProjectsStore.getState().setAddProjectDialogOpen(true)
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Project
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            window.dispatchEvent(new CustomEvent('command:open-archived-modal'))
          }
        >
          <Archive className="mr-2 h-4 w-4" />
          Archives
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}
        >
          <Command className="mr-2 h-4 w-4" />
          Command Palette
          {!isMobile && (
            <DropdownMenuShortcut>
              {commandPaletteShortcut}
            </DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
        {isMobile && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => openExternal('https://github.com/coollabsio/jean')}
            >
              <Github className="mr-2 h-4 w-4" />
              Jean on GitHub
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => openExternal('https://jean.build/sponsorships/')}
            >
              <Heart className="mr-2 h-4 w-4 text-pink-600 dark:text-pink-500" />
              Sponsor Jean
            </DropdownMenuItem>
          </>
        )}

        {showUsageSection && (
          <>
            <DropdownMenuSeparator />
            {usageEntries.map(entry => (
              <UsageMenuItem key={entry.id} entry={entry} />
            ))}
            <DropdownMenuItem
              onClick={() => useUIStore.getState().openPreferencesPane('usage')}
            >
              <BarChart3 className="mr-2 h-4 w-4" />
              Open Usage Details
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
