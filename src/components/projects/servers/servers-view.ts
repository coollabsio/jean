import { isNativeApp } from '@/lib/environment'
import { formatServerTarget, type Project } from '@/types/projects'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { projectServerId } from '../server-filter'

/**
 * Old copies of Jean remote connections (SSH from this computer). A
 * jean-server now shows its own local entry instead, so these are removed.
 */
export function isLegacyConnectionCopy(project: Project): boolean {
  return !!project.server?.jean_connection_id
}

/**
 * Servers for the Servers tab. Every Jean shows its own entries: its machine
 * (no SSH) and the SSH servers it stores. The native app lists them for all
 * connected Jeans; Web Access only gets its own Jean.
 * Order: this computer, other Jean machines, then SSH servers.
 */
export function serverProjectsForView(projects: Project[]): Project[] {
  const rank = (project: Project) =>
    project.server?.local
      ? projectServerId(project) === LOCAL_SERVER_ID
        ? 0
        : 1
      : 2
  return projects
    .filter(project => !!project.server && !isLegacyConnectionCopy(project))
    .sort((a, b) => rank(a) - rank(b))
}

/** Legacy connection copies stored by this Jean, to delete once. */
export function legacyConnectionCopies(projects: Project[]): Project[] {
  return projects.filter(
    project =>
      isLegacyConnectionCopy(project) &&
      projectServerId(project) === LOCAL_SERVER_ID
  )
}

/** Jeans (by server ID) that have no built-in local entry yet. */
export function jeansWithoutLocalEntry(
  jeanIds: string[],
  projects: Project[]
): string[] {
  const withLocal = new Set(
    projects
      .filter(project => project.server?.local)
      .map(project => projectServerId(project))
  )
  return jeanIds.filter(id => !withLocal.has(id))
}

/**
 * Subtitle of a server row. A Jean's own machine runs without SSH: this
 * computer in the native app, a Jean server otherwise. SSH servers show their
 * target and, in the native app, the Jean that runs them.
 */
export function serverSubtitle(project: Project): string {
  const owner = projectServerId(project)
  const remoteOwner =
    owner !== LOCAL_SERVER_ID ? (project.serverName ?? 'remote Jean') : null
  if (project.server?.local) {
    return owner === LOCAL_SERVER_ID && isNativeApp()
      ? 'This computer · no SSH'
      : 'Jean server · no SSH'
  }
  const target = project.server ? formatServerTarget(project.server) : ''
  return remoteOwner ? `${target} · via ${remoteOwner}` : target
}
