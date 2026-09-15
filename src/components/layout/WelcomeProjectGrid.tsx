import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  convertFileSrc,
  convertProjectFileSrc,
  convertServerFileSrc,
  convertServerProjectFileSrc,
} from '@/lib/transport'
import type { Project } from '@/types/projects'
import { useAppDataDir } from '@/services/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

interface WelcomeProjectGridProps {
  projects: Project[]
  onProjectClick: (projectId: string) => void
  onAddProject: () => void
}

function ProjectCard({
  project,
  appDataDir,
  onClick,
}: {
  project: Project
  appDataDir: string
  onClick: () => void
}) {
  const avatarKey = project.avatar_path ?? project.default_avatar_path ?? null
  const [imgErrorKey, setImgErrorKey] = useState<string | null>(null)
  const imgError = imgErrorKey === avatarKey

  const avatarUrl =
    project.avatar_path && !imgError
      ? project.serverId
        ? convertServerFileSrc(project.serverId, project.avatar_path)
        : appDataDir
          ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
          : null
      : project.default_avatar_path && !imgError
        ? project.serverId
          ? convertServerProjectFileSrc(
              project.serverId,
              project.default_avatar_path
            )
          : convertProjectFileSrc(project.default_avatar_path)
        : null

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-md border bg-muted/30 p-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/50"
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={project.name}
          className="size-8 shrink-0 rounded-md object-cover"
          onError={() => setImgErrorKey(avatarKey)}
        />
      ) : (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted-foreground/20">
          <span className="text-sm font-medium uppercase text-muted-foreground">
            {project.name[0]}
          </span>
        </div>
      )}
      <span className="truncate text-sm font-medium">{project.name}</span>
    </button>
  )
}

export function WelcomeProjectGrid({
  projects,
  onProjectClick,
  onAddProject,
}: WelcomeProjectGridProps) {
  const [search, setSearch] = useState('')
  const { data: appDataDir = '' } = useAppDataDir()

  const projectGroups = useMemo(() => {
    const filtered = search.trim()
      ? projects.filter(project =>
          project.name.toLowerCase().includes(search.toLowerCase())
        )
      : projects
    const groups = new Map<
      string,
      { serverName: string; projects: Project[] }
    >()

    for (const project of filtered) {
      const serverId = project.serverId ?? LOCAL_SERVER_ID
      const group = groups.get(serverId)

      if (group) {
        group.projects.push(project)
      } else {
        groups.set(serverId, {
          serverName:
            serverId === LOCAL_SERVER_ID
              ? 'Local'
              : (project.serverName ?? serverId),
          projects: [project],
        })
      }
    }

    return [...groups.entries()]
      .map(([serverId, group]) => ({ serverId, ...group }))
      .sort((a, b) => {
        if (a.serverId === LOCAL_SERVER_ID) return -1
        if (b.serverId === LOCAL_SERVER_ID) return 1
        return a.serverName.localeCompare(b.serverName)
      })
  }, [projects, search])

  const filteredProjectCount = projectGroups.reduce(
    (total, group) => total + group.projects.length,
    0
  )

  return (
    <div className="flex flex-1 flex-col items-center gap-6 overflow-y-auto px-6 py-12 font-sans">
      <h1 className="text-4xl font-bold text-foreground">Welcome to Jean!</h1>

      {projects.length >= 6 && (
        <div className="w-full max-w-4xl">
          <Input
            placeholder="Filter projects..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
            className="max-w-xs"
          />
        </div>
      )}

      <div className="flex w-full max-w-4xl flex-col gap-6">
        {projectGroups.map(group => (
          <section key={group.serverId} className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {group.serverName}
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {group.projects.map(project => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  appDataDir={appDataDir}
                  onClick={() => onProjectClick(project.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {filteredProjectCount === 0 && search && (
        <p className="text-sm text-muted-foreground">
          No projects match &ldquo;{search}&rdquo;
        </p>
      )}

      <Button variant="outline" size="sm" onClick={onAddProject}>
        <Plus className="mr-2 h-4 w-4" />
        Add Project
        <Kbd className="ml-2 h-5 px-1.5 text-[10px]">⌘ N</Kbd>
      </Button>
    </div>
  )
}
