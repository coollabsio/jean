import { render, screen } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralPane } from './GeneralPane'

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
}))

vi.mock('@/lib/transport', () => ({
  convertFileSrc: (path: string) => `file://${path}`,
  convertProjectFileSrc: (path: string) => `project://${path}`,
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: mocks.projects }),
  useProjectBranches: () => ({ data: [], isLoading: false, error: null }),
  useUpdateProjectSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useAppDataDir: () => ({ data: '/app-data' }),
  useSetProjectAvatar: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveProjectAvatar: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: { custom_cli_profiles: [] } }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: [] }),
}))

function project(avatarPath: string): Project {
  return {
    id: 'project-1',
    name: 'Jean',
    path: '/projects/jean',
    default_branch: 'main',
    added_at: 1,
    order: 0,
    avatar_path: avatarPath,
  }
}

describe('GeneralPane project avatar', () => {
  beforeEach(() => {
    mocks.projects = [project('avatars/project-1-old.png')]
  })

  it('reloads the avatar when a replacement keeps the same persisted path', () => {
    const { rerender } = render(
      <GeneralPane projectId="project-1" projectPath="/projects/jean" />
    )
    const firstSrc = screen
      .getByRole('img', { name: 'Jean' })
      .getAttribute('src')

    mocks.projects = [project('avatars/project-1-new.png')]
    rerender(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)

    expect(screen.getByRole('img', { name: 'Jean' })).not.toHaveAttribute(
      'src',
      firstSrc
    )
  })
})
