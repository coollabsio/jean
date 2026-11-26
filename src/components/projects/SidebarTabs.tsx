import type { ComponentType } from 'react'
import { Folder, History, X } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { suppressSidebarChromeContextMenu } from './sidebar-context-menu'

type SidebarView = 'projects' | 'recent'

const VIEWS: {
  view: SidebarView
  label: string
  Icon: ComponentType<{ className?: string }>
}[] = [
  { view: 'projects', label: 'Workspace', Icon: Folder },
  { view: 'recent', label: 'Recent', Icon: History },
]

/** One tab strip for the left sidebar: Workspace | Recent. */
export function SidebarTabs() {
  const active = useProjectsStore(state => state.sidebarActiveTab)
  const isMobile = useIsMobile()

  return (
    <div
      className="@container flex h-10 shrink-0 items-start gap-1 px-3 pt-2"
      onContextMenu={suppressSidebarChromeContextMenu}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-1"
        role="tablist"
        aria-label="Sidebar view"
      >
        {VIEWS.map(({ view, label, Icon }) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={active === view}
            className={cn(
              'flex h-7.5 min-w-0 flex-1 items-center justify-center truncate rounded-md px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              active === view
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
            title={label}
            aria-label={label}
            onClick={() =>
              useProjectsStore.getState().setSidebarActiveTab(view)
            }
          >
            {/* Very narrow sidebars show icons only */}
            <Icon className="size-4 shrink-0 @[11rem]:hidden" />
            <span className="hidden truncate @[11rem]:inline">{label}</span>
          </button>
        ))}
      </div>
      {/* Settings lives in the header; mobile keeps only close here */}
      {isMobile && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close sidebar"
          className="text-muted-foreground"
          onClick={() => useUIStore.getState().setLeftSidebarVisible(false)}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  )
}
