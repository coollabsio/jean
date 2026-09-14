import { useCallback, useEffect, useState } from 'react'
import {
  Plus,
  Folder,
  Archive,
  Briefcase,
  AlertTriangle,
  Server,
} from 'lucide-react'
import { useSidebarWidth } from '@/components/layout/SidebarWidthContext'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useProjects, useCreateFolder } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { ProjectTree } from './ProjectTree'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { scheduleIdleWork } from '@/lib/idle'
import { ServerFeatureSurfaces } from '@/components/remote/ServerFeatureSurfaces'
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
  const createFolder = useCreateFolder()
  const sidebarWidth = useSidebarWidth()
  const isMobile = useIsMobile()
  const [backendCheckReady, setBackendCheckReady] = useState(false)
  const [serverFilter, setServerFilter] = useState(ALL_SERVERS)
  const serverSnapshots = useServerConnectionSnapshots()
  const showServerFilter =
    isNativeApp() && new Set(projects.map(projectServerId)).size > 1
  const visibleProjects = showServerFilter
    ? filterProjectsByServer(projects, serverFilter)
    : projects
  useEffect(() => scheduleIdleWork(() => setBackendCheckReady(true), 1500), [])
  const { installedBackends } = useInstalledBackends({
    enabled: backendCheckReady,
  })
  const setupIncomplete = installedBackends.length === 0

  // Responsive layout threshold
  const isNarrow = sidebarWidth < 180

  const handleNewProject = useCallback(() => {
    closeMobileSidebarIfNeeded(isMobile)
    setAddProjectDialogOpen(true)
  }, [isMobile, setAddProjectDialogOpen])

  const handleOpenArchived = useCallback(() => {
    closeMobileSidebarIfNeeded(isMobile)
    window.dispatchEvent(new CustomEvent('command:open-archived-modal'))
  }, [isMobile])

  return (
    <div className="flex h-full flex-col">
      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {showServerFilter && (
          <div className="px-3 pb-1 pt-2">
            <Select value={serverFilter} onValueChange={setServerFilter}>
              <SelectTrigger
                size="sm"
                aria-label="Filter projects by server"
                className="w-full rounded-lg border-border/50 bg-muted/50 px-2 text-xs text-muted-foreground shadow-none hover:bg-muted/80 hover:text-foreground"
              >
                <Server className="size-3.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value={ALL_SERVERS}>All servers</SelectItem>
                {[...new Set(projects.map(projectServerId))].map(serverId => {
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
                    <SelectItem key={serverId} value={serverId}>
                      {snapshot?.name ?? fallback ?? 'Local'}
                      {statusLabel}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
        )}
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

      {/* Footer - transparent buttons with hover background.
          Extra bottom padding (plus safe-area) lifts controls off the screen edge. */}
      <div
        className={`flex gap-1 p-1.5 pb-[calc(var(--safe-area-bottom)+1.25rem)] ${isNarrow ? 'flex-col' : 'items-center'}`}
      >
        <ServerFeatureSurfaces />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
            >
              {!isNarrow && <Plus className="size-3.5" />}
              New
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            style={{ width: sidebarWidth - 12 }}
          >
            <DropdownMenuItem
              onClick={() => createFolder.mutate({ name: 'New Folder' })}
            >
              <Folder className="mr-2 size-3.5" />
              Folder
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleNewProject}
              disabled={!backendCheckReady || setupIncomplete}
            >
              <Briefcase className="mr-2 size-3.5" />
              Project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
          onClick={handleOpenArchived}
        >
          {!isNarrow && <Archive className="size-3.5" />}
          Archived
        </button>
      </div>
    </div>
  )
}
