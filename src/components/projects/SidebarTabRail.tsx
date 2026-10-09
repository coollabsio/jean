import { useCallback } from 'react'
import { Code, Settings } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isNativeApp } from '@/lib/environment'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'

/** Top-level Jean features. Agents will be added here later. */
type RailSection = 'workspace'

const SECTIONS: { section: RailSection; label: string; Icon: typeof Code }[] = [
  { section: 'workspace', label: 'Workspace', Icon: Code },
]

const RAIL_BUTTON_CLASS =
  'relative flex size-12 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

interface SidebarTabRailProps {
  /** Desktop: clicking the active section hides the sidebar, any section shows it. */
  togglesSidebar?: boolean
  className?: string
  children?: React.ReactNode
}

/** Vertical 72px icon rail: feature sections, Settings at the bottom. */
export function SidebarTabRail({
  togglesSidebar = false,
  className,
  children,
}: SidebarTabRailProps) {
  const sidebarVisible = useUIStore(state => state.leftSidebarVisible)
  const showActive = !togglesSidebar || sidebarVisible
  const isMobile = useIsMobile()

  // Only one section exists, so clicking it only toggles the sidebar.
  const handleSelect = useCallback(() => {
    if (!togglesSidebar) return
    const { leftSidebarVisible, setLeftSidebarVisible } = useUIStore.getState()
    setLeftSidebarVisible(!leftSidebarVisible)
  }, [togglesSidebar])

  const handleOpenSettings = useCallback(() => {
    const ui = useUIStore.getState()
    // Mobile: close the drawer so Settings is not hidden behind it
    if (isMobile) ui.setLeftSidebarVisible(false)
    ui.togglePreferences()
  }, [isMobile])

  return (
    <div
      className={cn(
        'flex w-18 shrink-0 flex-col items-center gap-1.5 pt-2',
        // Center Settings on the sidebar footer row (see ProjectsSidebar)
        isNativeApp() ? 'pb-2' : 'pb-[max(0.5rem,env(safe-area-inset-bottom))]',
        className
      )}
    >
      {children}
      <div
        className="flex flex-col items-center gap-1.5"
        role="tablist"
        aria-label="Jean features"
        aria-orientation="vertical"
      >
        {SECTIONS.map(({ section, label, Icon }) => {
          const selected = showActive
          return (
            <Tooltip key={section}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={label}
                  className={cn(
                    RAIL_BUTTON_CLASS,
                    selected
                      ? 'text-foreground before:absolute before:inset-y-2 before:left-0 before:w-px before:bg-foreground'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                  onClick={handleSelect}
                >
                  <Icon className="size-6" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleOpenSettings}
            aria-label="Open Settings"
            data-testid="sidebar-settings"
            className={cn(
              RAIL_BUTTON_CLASS,
              'mt-auto text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <Settings className="size-6" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Settings</TooltipContent>
      </Tooltip>
    </div>
  )
}
