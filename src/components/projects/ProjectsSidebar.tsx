import { useCallback, useEffect, useState } from 'react'
import {
  Plus,
  AlertTriangle,
  ChevronDown,
  Server,
  Settings2,
} from 'lucide-react'
import { useSidebarWidth } from '@/components/layout/SidebarWidthContext'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RemoteConnectionsDialog } from '@/components/remote/RemoteConnectionsDialog'
import { useProjects } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { ProjectTree } from './ProjectTree'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { scheduleIdleWork } from '@/lib/idle'
import { isNativeApp } from '@/lib/environment'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import {
  ALL_SERVERS,
  filterProjectsByServer,
  projectServerId,
} from './server-filter'

/** Close the mobile projects drawer when leaving into a dialog/modal. */
function closeMobileSidebarIfNeeded(isMobile: boolean) {
  if (isMobile) {
    useUIStore.getState().setLeftSidebarVisible(false)
  }
}

export function ProjectsSidebar() {
  const {
    data: projects = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useProjects()
  const { setAddProjectDialogOpen } = useProjectsStore()
  const sidebarWidth = useSidebarWidth()
  const isMobile = useIsMobile()
  const [backendCheckReady, setBackendCheckReady] = useState(false)
  const [serverFilter, setServerFilter] = useState(ALL_SERVERS)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const serverSnapshots = useServerConnectionSnapshots()
  const serverIds = [...new Set(projects.map(projectServerId))]
  const showServerMenu = isNativeApp()
  const showServerFilter = showServerMenu && serverIds.length > 1
  const visibleProjects = showServerFilter
    ? filterProjectsByServer(projects, serverFilter)
    : projects
  const selectedServerLabel =
    serverFilter === ALL_SERVERS
      ? 'All servers'
      : (serverSnapshots.get(serverFilter)?.name ??
        projects.find(project => projectServerId(project) === serverFilter)
          ?.serverName ??
        'Local')
  useEffect(() => scheduleIdleWork(() => setBackendCheckReady(true), 1500), [])
  const { installedBackends } = useInstalledBackends({
    enabled: backendCheckReady,
  })
  const setupIncomplete = installedBackends.length === 0

  const handleNewProject = useCallback(() => {
    closeMobileSidebarIfNeeded(isMobile)
    setAddProjectDialogOpen(true)
  }, [isMobile, setAddProjectDialogOpen])

  return (
    <div className="flex h-full flex-col">
      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="border-b border-border/40 pb-2">
          {showServerMenu && (
            <div className="px-3 pb-1 pt-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Filter projects by server"
                    className="flex h-7 w-full items-center gap-2 rounded-md border border-transparent bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Server className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {selectedServerLabel}
                    </span>
                    <ChevronDown className="size-3.5 opacity-50" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="border-border/60 bg-popover/95 shadow-lg backdrop-blur-sm"
                  style={{ width: sidebarWidth - 24 }}
                >
                  <DropdownMenuRadioGroup
                    value={serverFilter}
                    onValueChange={setServerFilter}
                  >
                    <DropdownMenuRadioItem
                      value={ALL_SERVERS}
                      className="text-xs"
                    >
                      All servers
                    </DropdownMenuRadioItem>
                    {serverIds.map(serverId => {
                      const snapshot = serverSnapshots.get(serverId)
                      const fallback = projects.find(
                        project => projectServerId(project) === serverId
                      )?.serverName
                      const status = snapshot?.status
                      const statusLabel =
                        status && status !== 'local' && status !== 'online'
                          ? ` (${status})`
                          : ''
                      return (
                        <DropdownMenuRadioItem
                          key={serverId}
                          value={serverId}
                          className="text-xs"
                        >
                          {snapshot?.name ?? fallback ?? 'Local'}
                          {statusLabel}
                        </DropdownMenuRadioItem>
                      )
                    })}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-xs text-muted-foreground"
                    onSelect={() => setConnectionsOpen(true)}
                  >
                    <Settings2 className="size-3.5" />
                    Connections
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <RemoteConnectionsDialog
                open={connectionsOpen}
                onOpenChange={setConnectionsOpen}
                showTrigger={false}
              />
            </div>
          )}
          <div className={showServerMenu ? 'px-3' : 'px-3 pt-2'}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              onClick={handleNewProject}
              disabled={!backendCheckReady || setupIncomplete}
            >
              <Plus className="size-3.5" />
              <span>Add project</span>
            </button>
          </div>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center p-4">
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        ) : isError && projects.length === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center"
            role="alert"
          >
            <AlertTriangle className="size-4 text-destructive" />
            <span className="text-sm text-muted-foreground">
              Unable to load projects
            </span>
            <span className="text-xs text-muted-foreground/70">
              Your project data may be corrupted. Jean kept the file unchanged
              so it can be recovered.
            </span>
            <button
              type="button"
              className="text-xs text-primary underline-offset-4 hover:underline"
              onClick={() => void refetch()}
            >
              Retry
            </button>
            {error && (
              <span className="sr-only">
                {error instanceof Error ? error.message : String(error)}
              </span>
            )}
          </div>
        ) : projects.length === 0 ? (
          <div className="flex h-full items-center justify-center px-2">
            <span className="truncate text-sm text-muted-foreground/50">
              No projects found
            </span>
          </div>
        ) : (
          <ProjectTree
            projects={visibleProjects}
            groupByServer={showServerFilter && serverFilter === ALL_SERVERS}
          />
        )}
      </div>
    </div>
  )
}
