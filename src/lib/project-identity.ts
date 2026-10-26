import type { Project, ProjectHostCheckout } from '@/types/projects'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

export type { ProjectHostCheckout }

/**
 * Identity key for a git remote URL.
 * SSH, HTTPS, and `git@` forms of the same repository compare equal.
 */
export function normalizeCloneUrl(
  raw: string | null | undefined
): string | null {
  if (!raw) return null
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null

  if (trimmed.startsWith('file://')) {
    const path = trimmed.slice('file://'.length).replace(/\/+$/, '')
    return path || null
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\')) return trimmed

  if (trimmed.startsWith('git@')) {
    const rest = trimmed.slice('git@'.length)
    const split = rest.indexOf(':')
    if (split <= 0) return null
    return hostPathIdentity(rest.slice(0, split), rest.slice(split + 1))
  }

  for (const prefix of ['ssh://', 'https://', 'http://', 'git://']) {
    if (trimmed.startsWith(prefix)) {
      return urlIdentity(trimmed.slice(prefix.length))
    }
  }
  return null
}

function urlIdentity(rest: string): string | null {
  const at = rest.lastIndexOf('@')
  const withoutUser = at >= 0 ? rest.slice(at + 1) : rest
  const slash = withoutUser.indexOf('/')
  if (slash <= 0) return null
  const hostPort = withoutUser.slice(0, slash)
  const host = hostPort.split(':')[0] ?? hostPort
  return hostPathIdentity(host, withoutUser.slice(slash + 1))
}

function hostPathIdentity(host: string, path: string): string | null {
  const normalizedHost = host.trim().toLowerCase()
  const normalizedPath = path
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .toLowerCase()
  if (!normalizedHost || !normalizedPath) return null
  return `${normalizedHost}/${normalizedPath}`
}

function serverIdOf(project: Project): string {
  return project.serverId ?? LOCAL_SERVER_ID
}

function checkoutFor(project: Project): ProjectHostCheckout {
  const serverId = serverIdOf(project)
  return {
    serverId,
    projectId: project.id,
    path: project.path,
    serverName:
      project.serverName ?? (serverId === LOCAL_SERVER_ID ? 'Local' : serverId),
    offline: project.offline,
  }
}

function canonicalRank(project: Project): number {
  const local = serverIdOf(project) === LOCAL_SERVER_ID
  if (local && !project.offline) return 0
  if (!project.offline) return 1
  if (local) return 2
  return 3
}

/**
 * One sidebar row per repository. Host checkouts stay attached so Start on…
 * can target a machine without listing the project again.
 */
export function collapseProjectsByIdentity(projects: Project[]): Project[] {
  const groups = new Map<string, Project[]>()
  const passthrough: Project[] = []

  for (const project of projects) {
    if (project.is_folder || project.server) {
      passthrough.push(project)
      continue
    }
    const identity = normalizeCloneUrl(project.origin_url)
    if (!identity) {
      passthrough.push({ ...project, hostCheckouts: [checkoutFor(project)] })
      continue
    }
    const group = groups.get(identity)
    if (group) group.push(project)
    else groups.set(identity, [project])
  }

  const collapsed = [...groups.values()].map(members => {
    const ordered = [...members].sort((a, b) => {
      const rank = canonicalRank(a) - canonicalRank(b)
      if (rank !== 0) return rank
      return a.order - b.order
    })
    const canonical = ordered[0]
    if (!canonical) return null
    const hostCheckouts = ordered.map(checkoutFor)
    return {
      ...canonical,
      hostCheckouts,
      worktree_count: ordered.reduce(
        (sum, project) => sum + (project.worktree_count ?? 0),
        0
      ),
      has_base_session: ordered.some(project => project.has_base_session),
    }
  })

  return [...passthrough, ...collapsed.filter(project => project !== null)]
}

export function findProjectForWorktree(
  projects: Project[],
  projectId: string | null | undefined
): Project | null {
  if (!projectId) return null
  return (
    projects.find(project => project.id === projectId) ??
    projects.find(project =>
      project.hostCheckouts?.some(checkout => checkout.projectId === projectId)
    ) ??
    null
  )
}
