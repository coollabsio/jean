import type { Project } from '@/types/projects'

export interface ProjectServerSection {
  id: string
  title: string
  projects: Project[]
}

export function groupProjectsByServer(
  projects: Project[]
): ProjectServerSection[] {
  const sections = new Map<string, ProjectServerSection>()

  for (const project of projects) {
    const id = project.serverId ?? 'local'
    const section = sections.get(id)
    if (section) {
      section.projects.push(project)
      continue
    }

    sections.set(id, {
      id,
      title: project.serverName ?? 'Projects',
      projects: [project],
    })
  }

  return [...sections.values()]
}
