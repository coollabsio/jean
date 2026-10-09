import { useCallback, useEffect, useState } from 'react'
import { Bot, Code, Settings } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { edgeNeutral, raised } from '@/components/ui/button'
import { isNativeApp } from '@/lib/environment'
import { FALLBACK_APP_VERSION } from '@/lib/app-version'
import { openExternal } from '@/lib/platform'
import { useUIStore, type RailSection } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'

/** Top-level Jean features */
const SECTIONS: { section: RailSection; label: string; Icon: typeof Code }[] = [
  { section: 'workspace', label: 'Workspace', Icon: Code },
  { section: 'agents', label: 'Agents', Icon: Bot },
]

// Same 3D raised look as Button (secondary variant)
const RAIL_BUTTON_CLASS = cn(
  raised,
  edgeNeutral,
  'relative flex size-12 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
)

// Active section stays pressed down: moved by the edge height, no outer edge,
// and a top inner shadow
const RAIL_BUTTON_PRESSED_CLASS =
  'translate-y-0.5 bg-muted text-foreground shadow-[inset_0_2px_0_var(--btn-edge)] hover:translate-y-0.5 hover:bg-muted hover:shadow-[inset_0_2px_0_var(--btn-edge)]'

interface SidebarTabRailProps {
  /** Desktop: clicking the active section hides the sidebar, any section shows it. */
  togglesSidebar?: boolean
  className?: string
  children?: React.ReactNode
}

/** Vertical 72px icon rail: feature sections, Settings and app version at the bottom. */
export function SidebarTabRail({
  togglesSidebar = false,
  className,
  children,
}: SidebarTabRailProps) {
  const railSection = useUIStore(state => state.railSection)
  const isMobile = useIsMobile()
  const [appVersion, setAppVersion] = useState(FALLBACK_APP_VERSION)

  useEffect(() => {
    if (!isNativeApp()) return

    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => setAppVersion(FALLBACK_APP_VERSION))
  }, [])

  const handleSelect = useCallback(
    (section: RailSection) => {
      const ui = useUIStore.getState()
      // Agents has no sidebar panel, only a main page
      if (section === 'agents') {
        ui.setRailSection('agents')
        if (isMobile) ui.setLeftSidebarVisible(false)
        return
      }
      if (ui.railSection !== 'workspace') {
        ui.setRailSection('workspace')
        if (togglesSidebar) ui.setLeftSidebarVisible(true)
        return
      }
      if (togglesSidebar) ui.setLeftSidebarVisible(!ui.leftSidebarVisible)
    },
    [togglesSidebar, isMobile]
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
          // Active = open section, even when the Workspace list is collapsed
          const selected = railSection === section
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
                    selected && RAIL_BUTTON_PRESSED_CLASS
                  )}
                  onClick={() => handleSelect(section)}
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
            // Plain icon, not a raised button
            className="mt-auto flex size-12 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Settings className="size-6" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Settings</TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={() =>
          openExternal(
            `https://github.com/coollabsio/jean/releases/tag/v${appVersion}`
          )
        }
        data-testid="sidebar-app-version"
        className="text-[0.625rem] leading-none text-foreground/40 transition-colors hover:text-foreground/60"
      >
        v{appVersion}
      </button>
    </div>
  )
}
