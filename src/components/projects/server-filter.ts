import type { Project } from '@/types/projects'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

export const ALL_SERVERS = 'all'

export function projectServerId(project: Project): string {
  return project.serverId ?? LOCAL_SERVER_ID
}

export function filterProjectsByServer(
  projects: Project[],
  serverId: string
): Project[] {
  if (serverId === ALL_SERVERS) return projects
  return projects.filter(project => projectServerId(project) === serverId)
}
