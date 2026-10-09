import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronUp,
  Pencil,
  Server,
  Shield,
  Trash2,
} from '@/components/icons/reicon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { openServerProject, useRemoveServerProject } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import type { Project } from '@/types/projects'
import { ServerUserSetupDialog } from './ServerUserSetupDialog'
import { serverSubtitle } from './servers-view'

/** No user means the ssh default, often root. */
function usesAdminUser(project: Project): boolean {
  if (project.server?.local) return false
  const user = project.server?.user
  return !user || user === 'root'
}

interface ServersListProps {
  /** Server projects only, already sorted (see serverProjectsForView) */
  servers: Project[]
  /** Shared search text of the Projects view */
  searchQuery: string
}

const iconButtonClass =
  'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

/** Servers section at the top of the Projects view. */
export function ServersList({ servers, searchQuery }: ServersListProps) {
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const removeServer = useRemoveServerProject()
  const [removing, setRemoving] = useState<Project | null>(null)
  const [settingUp, setSettingUp] = useState<Project | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  const filteredServers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return servers
    return servers.filter(
      project =>
        project.name.toLowerCase().includes(query) ||
        serverSubtitle(project).toLowerCase().includes(query)
    )
  }, [servers, searchQuery])

  const handleOpen = useCallback(
    (project: Project) => {
      openServerProject(project.id, queryClient)
      if (isMobile) useUIStore.getState().setLeftSidebarVisible(false)
    },
    [isMobile, queryClient]
  )

  // The dialog lives outside the sidebar, so the mobile drawer can close.
  const openServerDialog = useCallback(
    (project?: Project) => {
      if (isMobile) useUIStore.getState().setLeftSidebarVisible(false)
      useProjectsStore.getState().setServerDialog({ project })
    },
    [isMobile]
  )

  const showServers = collapsed === false || Boolean(searchQuery)

  return (
    <>
      {/* Nothing to show: the Add server action is in the Projects "+" menu */}
      {filteredServers.length > 0 && (
        <div className="py-1">
          <div className="flex items-center justify-between pl-3 pr-2 pb-1 pt-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Servers
            </span>
            <button
              type="button"
              className="flex size-4 shrink-0 items-center justify-center rounded opacity-50 hover:bg-accent-foreground/10 hover:opacity-100"
              onClick={() => setCollapsed(value => !value)}
              aria-label={showServers ? 'Hide servers' : 'Show servers'}
              aria-expanded={showServers}
              disabled={Boolean(searchQuery)}
            >
              {showServers ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </button>
          </div>
          {showServers && (
            <ul className="flex flex-col gap-px px-1.5 pb-1">
              {filteredServers.map(project => {
                return (
                  <li key={project.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => handleOpen(project)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-20 text-left transition-colors hover:bg-muted/50',
                        selectedProjectId === project.id && 'bg-muted'
                      )}
                    >
                      <Server className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{project.name}</span>
                        <span className="truncate text-[0.6875rem] text-muted-foreground">
                          {serverSubtitle(project)}
                        </span>
                        {usesAdminUser(project) && (
                          <span className="truncate text-[0.6875rem] text-amber-600 dark:text-amber-500">
                            Uses root · set up a restricted user
                          </span>
                        )}
                      </span>
                    </button>
                    {/* Touch devices cannot hover, so keep actions visible there. */}
                    <div
                      className={cn(
                        'absolute right-1.5 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100',
                        isMobile && 'opacity-100'
                      )}
                    >
                      {!project.server?.local && (
                        <button
                          type="button"
                          className={iconButtonClass}
                          onClick={() => setSettingUp(project)}
                          aria-label={`Set up restricted user on ${project.name}`}
                          title="Set up restricted user"
                        >
                          <Shield className="size-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        className={iconButtonClass}
                        onClick={() => openServerDialog(project)}
                        aria-label={`Edit ${project.name}`}
                      >
                        <Pencil className="size-3" />
                      </button>
                      {/* The built-in local entry cannot be removed. */}
                      {!project.server?.local && (
                        <button
                          type="button"
                          className={iconButtonClass}
                          onClick={() => setRemoving(project)}
                          aria-label={`Remove ${project.name}`}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      <ServerUserSetupDialog
        project={settingUp}
        onOpenChange={open => !open && setSettingUp(null)}
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={open => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the server entry and its chat sessions only. Your
              projects, worktrees and other servers stay. Nothing changes on the
              server itself.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => removing && removeServer.mutate(removing.id)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
