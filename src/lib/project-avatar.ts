import {
  convertFileSrc,
  convertProjectFileSrc,
  convertServerFileSrc,
  convertServerProjectFileSrc,
} from '@/lib/transport'
import type { Project } from '@/types/projects'

/** Image URL of a project's avatar (custom first, then default), or null. */
export function projectAvatarUrl(
  project: Project,
  appDataDir: string | undefined
): string | null {
  if (project.avatar_path) {
    if (project.serverId) {
      return convertServerFileSrc(project.serverId, project.avatar_path)
    }
    return appDataDir
      ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
      : null
  }
  if (project.default_avatar_path) {
    return project.serverId
      ? convertServerProjectFileSrc(
          project.serverId,
          project.default_avatar_path
        )
      : convertProjectFileSrc(project.default_avatar_path)
  }
  return null
}
