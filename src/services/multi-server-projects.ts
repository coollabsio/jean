import type { Project } from '@/types/projects'
import { serverResourceKey } from '@/lib/server-resource'
import type { ServerId, ServerOwned } from '@/types/server-resource'
import { useQuery } from '@tanstack/react-query'
import { useRemoteConnections } from '@/lib/remote-connections'
import {
  invokeOnServer,
  useServerConnectionSnapshots,
} from '@/lib/server-connections'
import { registerServerResourcePath } from '@/lib/server-command-routing'

const CACHE_SCHEMA_VERSION = 1
const CACHE_PREFIX = 'jean-server-projects:'

export interface ProjectSnapshotStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ServerProjectSource {
  serverId: ServerId
  name: string
  online: boolean
}

export type MultiServerProject = ServerOwned<Project> & {
  key: string
  serverName: string
  offline: boolean
  cachedAt: number | null
}

interface ProjectSnapshot {
  schemaVersion: number
  cachedAt: number
  projects: Project[]
}

function cacheKey(serverId: ServerId): string {
  return `${CACHE_PREFIX}${serverId}`
}

export function saveProjectSnapshot(
  storage: ProjectSnapshotStorage,
  serverId: ServerId,
  projects: Project[],
  cachedAt = Date.now()
): void {
  storage.setItem(
    cacheKey(serverId),
    JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, cachedAt, projects })
  )
}

export function loadProjectSnapshot(
  storage: ProjectSnapshotStorage,
  serverId: ServerId
): ProjectSnapshot | null {
  const raw = storage.getItem(cacheKey(serverId))
  if (!raw) return null
  try {
    const snapshot = JSON.parse(raw) as Partial<ProjectSnapshot>
    if (
      snapshot.schemaVersion !== CACHE_SCHEMA_VERSION ||
      typeof snapshot.cachedAt !== 'number' ||
      !Array.isArray(snapshot.projects)
    ) {
      return null
    }
    return snapshot as ProjectSnapshot
  } catch {
    return null
  }
}

function decorateProjects(
  source: ServerProjectSource,
  projects: Project[],
  offline: boolean,
  cachedAt: number | null
): MultiServerProject[] {
  return projects.map(project => ({
    ...project,
    serverId: source.serverId,
    serverName: source.name,
    key: serverResourceKey({
      serverId: source.serverId,
      resourceId: project.id,
    }),
    offline,
    cachedAt,
  }))
}

export async function loadProjectsForServers(
  sources: ServerProjectSource[],
  invoke: (serverId: ServerId, command: string) => Promise<Project[]>,
  storage: ProjectSnapshotStorage
): Promise<MultiServerProject[]> {
  const groups = await Promise.all(
    sources.map(async source => {
      if (source.online) {
        try {
          const projects = await invoke(source.serverId, 'list_projects')
          const cachedAt = Date.now()
          saveProjectSnapshot(storage, source.serverId, projects, cachedAt)
          return decorateProjects(source, projects, false, cachedAt)
        } catch {
          // Use the last confirmed snapshot below.
        }
      }

      const snapshot = loadProjectSnapshot(storage, source.serverId)
      return snapshot
        ? decorateProjects(source, snapshot.projects, true, snapshot.cachedAt)
        : []
    })
  )
  return groups.flat()
}

export function toRoutedProjects(projects: MultiServerProject[]): Project[] {
  return projects.map(project => {
    registerServerResourcePath(project.serverId, project.path)
    return {
      ...project,
      id: project.key,
      resourceId: project.resourceId ?? project.id,
      parent_id: project.parent_id
        ? serverResourceKey({
            serverId: project.serverId,
            resourceId: project.parent_id,
          })
        : undefined,
      linked_project_ids: project.linked_project_ids?.map(resourceId =>
        serverResourceKey({ serverId: project.serverId, resourceId })
      ),
    }
  })
}

export function useMultiServerProjects(enabled = true) {
  const connections = useRemoteConnections()
  const snapshots = useServerConnectionSnapshots()
  const sources = (enabled ? connections : [])
    .filter(connection => connection.enabled !== false)
    .map(connection => ({
      serverId: connection.id,
      name: connection.name,
      online: snapshots.get(connection.id)?.status === 'online',
    }))
  const sourceKey = sources
    .map(source => `${source.serverId}:${source.online}`)
    .join('|')

  return useQuery({
    queryKey: ['multi-server', 'projects', sourceKey],
    queryFn: () =>
      loadProjectsForServers(
        sources,
        (serverId, command) => invokeOnServer<Project[]>(serverId, command),
        window.localStorage
      ),
    enabled: enabled && sources.length > 0,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
}
