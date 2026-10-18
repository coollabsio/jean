import type { Project } from '@/types/projects'

export function haveSameProjectServer(
  first: Project | undefined,
  second: Project
): boolean {
  return (first?.serverId ?? 'local') === (second.serverId ?? 'local')
}
