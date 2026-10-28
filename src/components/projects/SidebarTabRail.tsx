import { useCallback } from 'react'
import { Settings } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isNativeApp } from '@/lib/environment'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePreferences } from '@/services/preferences'
import { DEFAULT_KEYBINDINGS, formatShortcutDisplay } from '@/types/keybindings'

/** Desktop rail width in px; MainWindow offsets the title bar by it. */
export const SIDEBAR_RAIL_WIDTH = 48

interface SidebarTabRailProps {
  className?: string
}

/**
 * Desktop column left of the sidebar. MainWindow keeps it mounted while the
 * sidebar is collapsed, so it holds the Settings gear. The view tabs live in
 * SidebarTabs; on mobile that row also holds Settings, so the rail is empty.
 */
export function SidebarTabRail({ className }: SidebarTabRailProps) {
  const isMobile = useIsMobile()
  const { data: preferences } = usePreferences()
  const settingsShortcut = formatShortcutDisplay(
    preferences?.keybindings?.open_preferences ??
      DEFAULT_KEYBINDINGS.open_preferences
  )

  const handleOpenSettings = useCallback(() => {
    useUIStore.getState().togglePreferences()
  }, [])

  if (isMobile) return null

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col items-center pt-2',
        isNativeApp() ? 'pb-2' : 'pb-[max(0.5rem,env(safe-area-inset-bottom))]',
        className
      )}
      style={{ width: SIDEBAR_RAIL_WIDTH }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleOpenSettings}
            aria-label="Open Settings"
            data-testid="sidebar-settings"
            className="mt-auto flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Settings className="size-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          Settings
          <kbd className="ml-1.5 text-2xs opacity-60">{settingsShortcut}</kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
