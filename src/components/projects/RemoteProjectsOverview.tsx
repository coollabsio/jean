import { useMemo, useState } from 'react'
import { Server, WifiOff } from 'lucide-react'
import { useMultiServerProjects } from '@/services/multi-server-projects'
import { cn } from '@/lib/utils'

export function RemoteProjectsOverview() {
  const { data: projects = [], isLoading } = useMultiServerProjects()
  const [serverFilter, setServerFilter] = useState<string | null>(null)
  const servers = useMemo(
    () => [
      ...new Map(
        projects.map(project => [project.serverId, project.serverName])
      ),
    ],
    [projects]
  )
  const visibleProjects = serverFilter
    ? projects.filter(project => project.serverId === serverFilter)
    : projects

  if (isLoading && projects.length === 0) {
    return (
      <div className="px-2 py-3 text-xs text-muted-foreground">
        Loading remote servers…
      </div>
    )
  }
  if (projects.length === 0) return null

  return (
    <section className="border-t px-1.5 py-2" aria-label="Remote projects">
      <div className="mb-2 flex items-center gap-1 overflow-x-auto px-0.5">
        <button
          type="button"
          className={cn(
            'rounded px-2 py-1 text-xs',
            serverFilter === null
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground'
          )}
          onClick={() => setServerFilter(null)}
        >
          All servers
        </button>
        {servers.map(([serverId, serverName]) => (
          <button
            key={serverId}
            type="button"
            className={cn(
              'rounded px-2 py-1 text-xs',
              serverFilter === serverId
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground'
            )}
            onClick={() => setServerFilter(serverId)}
          >
            {serverName}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        {visibleProjects.map(project => (
          <div
            key={project.key}
            className="flex items-center gap-2 rounded-md border px-2 py-1.5"
          >
            <Server className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">
              {project.name}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {project.serverName}
            </span>
            {project.offline && (
              <span className="flex shrink-0 items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                <WifiOff className="size-3" />
                Offline
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
