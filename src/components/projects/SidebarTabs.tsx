import type { ComponentType } from 'react'
import { Folder, History, Settings, X } from '@/components/icons/reicon'
import { AgentsIcon } from '@/components/icons/AgentsIcon'
import { useAgentsEnabled } from '@/components/agents/agents-feature'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { suppressSidebarChromeContextMenu } from './sidebar-context-menu'

type SidebarView = 'projects' | 'recent' | 'agents'

const VIEWS: {
  view: SidebarView
  label: string
  Icon: ComponentType<{ className?: string }>
}[] = [
  { view: 'projects', label: 'Projects', Icon: Folder },
  { view: 'recent', label: 'Recent', Icon: History },
  { view: 'agents', label: 'Agents', Icon: AgentsIcon },
]

// Projects/Recent live in the projects store, Agents in the UI store's
// rail section; both are persisted in the client view state.
function selectView(view: SidebarView) {
  const ui = useUIStore.getState()
  if (view === 'agents') {
    ui.setRailSection('agents')
    return
  }
  useProjectsStore.getState().setSidebarActiveTab(view)
  ui.setRailSection('workspace')
}

/** One tab strip for the left sidebar: Projects | Recent | Agents. */
export function SidebarTabs() {
  const agentsEnabled = useAgentsEnabled()
  const agentsSelected = useUIStore(state => state.railSection === 'agents')
  const workspaceTab = useProjectsStore(state => state.sidebarActiveTab)
  const isMobile = useIsMobile()
  // Disabled Agents falls back to the workspace tab
  const active: SidebarView =
    agentsEnabled && agentsSelected ? 'agents' : workspaceTab
  const views = agentsEnabled
    ? VIEWS
    : VIEWS.filter(({ view }) => view !== 'agents')

  return (
    <div
      className="@container flex h-10 shrink-0 items-center gap-1 px-3 pt-1"
      onContextMenu={suppressSidebarChromeContextMenu}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-1"
        role="tablist"
        aria-label="Sidebar view"
      >
        {views.map(({ view, label, Icon }) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={active === view}
            className={cn(
              'flex h-7 min-w-0 flex-1 items-center justify-center truncate rounded-md px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              active === view
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
            title={label}
            aria-label={label}
            onClick={() => selectView(view)}
          >
            {/* Very narrow sidebars show icons only */}
            <Icon className="size-4 shrink-0 @[11rem]:hidden" />
            <span className="hidden truncate @[11rem]:inline">{label}</span>
          </button>
        ))}
      </div>
      {/* Desktop has Settings in the title bar; mobile keeps it and close here */}
      {isMobile && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open Settings"
            data-testid="sidebar-settings"
            className="text-muted-foreground"
            onClick={() => {
              const ui = useUIStore.getState()
              // Close the drawer so Settings is not hidden behind it
              ui.setLeftSidebarVisible(false)
              ui.togglePreferences()
            }}
          >
            <Settings className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close sidebar"
            className="text-muted-foreground"
            onClick={() => useUIStore.getState().setLeftSidebarVisible(false)}
          >
            <X className="size-4" />
          </Button>
        </>
      )}
    </div>
  )
}
