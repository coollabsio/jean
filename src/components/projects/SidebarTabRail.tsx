import { useCallback } from 'react'
import { Folder, History, Server, Settings } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isNativeApp } from '@/lib/environment'
import { useProjectsStore, type SidebarTab } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'

const TABS: { tab: SidebarTab; label: string; Icon: typeof Folder }[] = [
  { tab: 'projects', label: 'Projects', Icon: Folder },
  { tab: 'recent', label: 'Recent', Icon: History },
  { tab: 'servers', label: 'Servers (Beta)', Icon: Server },
]

const RAIL_BUTTON_CLASS =
  'relative flex size-12 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

interface SidebarTabRailProps {
  /** Desktop: clicking the active tab hides the sidebar, any tab shows it. */
  togglesSidebar?: boolean
  className?: string
  children?: React.ReactNode
}

/** Vertical 72px icon rail: sidebar view tabs, Settings at the bottom. */
export function SidebarTabRail({
  togglesSidebar = false,
  className,
  children,
}: SidebarTabRailProps) {
  const activeTab = useProjectsStore(state => state.sidebarActiveTab)
  const sidebarVisible = useUIStore(state => state.leftSidebarVisible)
  const showActive = !togglesSidebar || sidebarVisible
  const isMobile = useIsMobile()

  const handleSelect = useCallback(
    (tab: SidebarTab) => {
      const { sidebarActiveTab, setSidebarActiveTab } =
        useProjectsStore.getState()
      if (togglesSidebar) {
        const { leftSidebarVisible, setLeftSidebarVisible } =
          useUIStore.getState()
        setLeftSidebarVisible(!(leftSidebarVisible && sidebarActiveTab === tab))
      }
      setSidebarActiveTab(tab)
    },
    [togglesSidebar]
  )

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
        isNativeApp()
          ? 'pb-0'
          : 'pb-[max(0.5rem,env(safe-area-inset-bottom))]',
        className
      )}
    >
      {children}
      <div
        className="flex flex-col items-center gap-1.5"
        role="tablist"
        aria-label="Sidebar view"
        aria-orientation="vertical"
      >
        {TABS.map(({ tab, label, Icon }) => {
          const selected = showActive && activeTab === tab
          return (
            <Tooltip key={tab}>
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
                  onClick={() => handleSelect(tab)}
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
