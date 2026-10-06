import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  GitBranchPlus,
  FolderPlus,
  Plus,
  AlertTriangle,
  ChevronDown,
  Search,
  Server,
  Settings,
  Settings2,
  X,
} from '@/components/icons/reicon'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ensureLocalServerProject,
  invalidateProjectLists,
  useCreateFolder,
  useProjects,
} from '@/services/projects'
import { logger } from '@/lib/logger'
import { invoke } from '@/lib/transport'
import { isServerProject, type Project } from '@/types/projects'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { ProjectTree } from './ProjectTree'
import { RecentWorktreesList } from './RecentWorktreesList'
import { ServersList } from './servers/ServersList'
import {
  jeansWithoutLocalEntry,
  legacyConnectionCopies,
  serverProjectsForView,
} from './servers/servers-view'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { scheduleIdleWork } from '@/lib/idle'
import { isNativeApp } from '@/lib/environment'
import { FALLBACK_APP_VERSION } from '@/lib/app-version'
import { openExternal } from '@/lib/platform'
import { useServerConnectionSnapshots } from '@/lib/server-connections'
import {
  ALL_SERVERS,
  filterProjectsByServer,
  projectServerId,
} from './server-filter'

const EMPTY_PROJECTS: Project[] = []

/** Close the mobile projects drawer when leaving into a dialog/modal. */
function closeMobileSidebarIfNeeded(isMobile: boolean) {
  if (isMobile) {
    useUIStore.getState().setLeftSidebarVisible(false)
  }
}

/**
 * Each Jean shows its own machine in the Servers tab (no SSH). Create that
 * entry on this Jean, and in the native app on every connected jean-server.
 * Also delete old SSH copies of remote connections once: the jean-server's own
 * entry replaces them.
 */
function useServerEntries(projects: Project[], ready: boolean) {
  const queryClient = useQueryClient()
  const snapshots = useServerConnectionSnapshots()
  const requested = useRef(new Set<string>())
  const jeanIds = useMemo(
    () =>
      isNativeApp()
        ? [...snapshots.values()]
            .filter(
              snapshot =>
                snapshot.status === 'local' || snapshot.status === 'online'
            )
            .map(snapshot => snapshot.serverId)
        : [LOCAL_SERVER_ID],
    [snapshots]
  )

  useEffect(() => {
    if (!ready) return
    const once = (key: string) => {
      if (requested.current.has(key)) return false
      requested.current.add(key)
      return true
    }
    const tasks = [
      ...jeansWithoutLocalEntry(jeanIds, projects)
        .filter(jeanId => once(`local:${jeanId}`))
        .map(jeanId => ensureLocalServerProject(jeanId)),
      ...legacyConnectionCopies(projects)
        .filter(project => once(`remove:${project.id}`))
        .map(project =>
          invoke('remove_server_project', { projectId: project.id })
        ),
    ]
    if (tasks.length === 0) return
    void Promise.allSettled(tasks).then(results => {
      invalidateProjectLists(queryClient)
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn('Failed to update server entries', {
            error: result.reason,
          })
        }
      }
    })
  }, [jeanIds, projects, ready, queryClient])
}

export function ProjectsSidebar() {
  const {
    data: projects = EMPTY_PROJECTS,
    isLoading,
    isSuccess,
    isError,
    error,
    refetch,
  } = useProjects()
  useServerEntries(projects, isSuccess)
  const setAddProjectDialogOpen = useProjectsStore(
    state => state.setAddProjectDialogOpen
  )
  const createFolder = useCreateFolder()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const sidebarWidth = useSidebarWidth()
  const isMobile = useIsMobile()
  const [backendCheckReady, setBackendCheckReady] = useState(false)
  const serverFilter = useProjectsStore(
    state => state.sidebarServerFilter ?? ALL_SERVERS
  )
  const setServerFilter = useProjectsStore(
    state => state.setSidebarServerFilter
  )
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const activeTab = useProjectsStore(state => state.sidebarActiveTab)
  const setActiveTab = useProjectsStore(state => state.setSidebarActiveTab)
  const [searchQuery, setSearchQuery] = useState('')
  const [appVersion, setAppVersion] = useState(FALLBACK_APP_VERSION)
  const [footerActionsEl, setFooterActionsEl] = useState<HTMLDivElement | null>(
    null
  )
  const serverSnapshots = useServerConnectionSnapshots()
  const serverIds = useMemo(
    () => [...new Set(projects.map(projectServerId))],
    [projects]
  )
  const showServerMenu = isNativeApp()
  const showServerFilter = showServerMenu && serverIds.length > 1
  const visibleProjects = showServerFilter
    ? filterProjectsByServer(projects, serverFilter)
    : projects
  const treeProjects = useMemo(
    () => visibleProjects.filter(project => !isServerProject(project)),
    [visibleProjects]
  )
  const serverProjects = useMemo(
    () => serverProjectsForView(projects),
    [projects]
  )
  useEffect(() => {
    if (serverFilter !== ALL_SERVERS && !serverIds.includes(serverFilter)) {
      setServerFilter(ALL_SERVERS)
    }
  }, [serverFilter, serverIds, setServerFilter])
  const selectedServerLabel =
    serverFilter === ALL_SERVERS
      ? 'All servers'
      : (serverSnapshots.get(serverFilter)?.name ??
        projects.find(project => projectServerId(project) === serverFilter)
          ?.serverName ??
        'Local')
  useEffect(() => scheduleIdleWork(() => setBackendCheckReady(true), 1500), [])
  useEffect(() => {
    if (!isNativeApp()) return

    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => setAppVersion(FALLBACK_APP_VERSION))
  }, [])
  const { installedBackends } = useInstalledBackends({
    enabled: backendCheckReady,
  })
  const setupIncomplete = installedBackends.length === 0

  const handleNewProject = useCallback(() => {
    closeMobileSidebarIfNeeded(isMobile)
    setAddProjectDialogOpen(true)
  }, [isMobile, setAddProjectDialogOpen])

  const handleNewFolder = useCallback(() => {
    setSearchQuery('')
    createFolder.mutate({ name: 'New Folder' })
  }, [createFolder])

  const handleNewWorktree = useCallback(() => {
    if (!selectedProjectId) return
    closeMobileSidebarIfNeeded(isMobile)
    useUIStore.getState().setNewWorktreeModalOpen(true)
  }, [isMobile, selectedProjectId])

  const handleOpenSettings = useCallback(() => {
    closeMobileSidebarIfNeeded(isMobile)
    useUIStore.getState().togglePreferences()
  }, [isMobile])

  return (
    <div className="flex h-full flex-col">
      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center border-b border-border/40 px-2 pt-1">
          <div
            className="@container grid min-w-0 flex-1 grid-cols-3"
            role="tablist"
            aria-label="Sidebar view"
          >
            {(['projects', 'recent', 'servers'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                title={tab}
                className={`relative h-8 min-w-0 px-1 text-xs font-medium capitalize transition-colors ${
                  activeTab === tab
                    ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setActiveTab(tab)}
              >
                <span className="inline-flex max-w-full items-center justify-center gap-1">
                  <span className="truncate">{tab}</span>
                  {tab === 'servers' && (
                    <Badge
                      variant="outline"
                      className="hidden shrink-0 rounded-sm border-warning/40 bg-warning/10 px-1 py-0 text-[9px] leading-3.5 tracking-wide text-warning uppercase @[17rem]:inline-flex"
                    >
                      Beta
                    </Badge>
                  )}
                </span>
              </button>
            ))}
          </div>
          {isMobile && (
            <button
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => closeMobileSidebarIfNeeded(isMobile)}
              aria-label="Close sidebar"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {activeTab === 'projects' ? (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div className="border-b border-border/40 pb-2 pt-[3px]">
              <div className="flex gap-1 px-3 pt-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="search"
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    placeholder="Search projects…"
                    aria-label="Search projects and worktrees"
                    className="h-8 border-transparent bg-transparent pl-7 pr-2 text-xs shadow-none focus-visible:border-transparent dark:bg-transparent"
                  />
                </div>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          aria-label="Add project or folder"
                        >
                          <Plus className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Add project or folder</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={handleNewProject}
                      disabled={!backendCheckReady || setupIncomplete}
                      aria-label="Add project"
                    >
                      <Plus className="size-3.5" />
                      Add project
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={handleNewFolder}
                      disabled={createFolder.isPending}
                    >
                      <FolderPlus className="size-3.5" />
                      New folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                      onClick={handleNewWorktree}
                      disabled={!selectedProjectId}
                      aria-label="Add worktree to selected project"
                    >
                      <GitBranchPlus className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Add worktree to selected project
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            {showServerMenu && (
              <div className="px-3 py-2">
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
            {isLoading ? (
              <div className="flex items-center justify-center p-4">
                <span className="text-sm text-muted-foreground">
                  Loading...
                </span>
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
                  Your project data may be corrupted. Jean kept the file
                  unchanged so it can be recovered.
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
            ) : !projects.some(project => !isServerProject(project)) ? (
              <div className="flex h-full items-center justify-center px-2">
                <span className="truncate text-sm text-muted-foreground/50">
                  No projects found
                </span>
              </div>
            ) : (
              <ProjectTree
                projects={treeProjects}
                groupByServer={showServerFilter && serverFilter === ALL_SERVERS}
                searchQuery={searchQuery}
              />
            )}
          </div>
        ) : activeTab === 'servers' ? (
          <ServersList servers={serverProjects} />
        ) : (
          <RecentWorktreesList
            projects={visibleProjects}
            footerActionsContainer={footerActionsEl}
          />
        )}
      </div>
      <div
        className={`flex shrink-0 items-center justify-between ${showServerMenu ? 'p-2' : 'px-2 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]'}`}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpenSettings}
              aria-label="Open Settings"
              data-testid="sidebar-settings"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Settings className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
        <div
          ref={setFooterActionsEl}
          className="flex min-w-0 flex-1 justify-center"
        />
        <button
          type="button"
          onClick={() =>
            openExternal(
              `https://github.com/coollabsio/jean/releases/tag/v${appVersion}`
            )
          }
          data-testid="sidebar-app-version"
          className="flex h-8 items-center px-1.5 text-[0.625rem] leading-none text-foreground/40 transition-colors hover:text-foreground/60"
        >
          v{appVersion}
        </button>
      </div>
    </div>
  )
}
