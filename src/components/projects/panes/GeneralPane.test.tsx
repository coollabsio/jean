import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralPane } from './GeneralPane'

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  installedBackends: [] as string[],
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
  useInstalledBackends: () => ({ installedBackends: mocks.installedBackends }),
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
    mocks.installedBackends = []
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('marks installed Devin as beta in the default backend list', async () => {
    mocks.installedBackends = ['claude', 'devin']
    const user = userEvent.setup()
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)

    const field = screen.getByText('Default Backend').parentElement
    if (!field) throw new Error('Expected default backend field')
    await user.click(within(field).getByRole('combobox'))

    const devin = screen.getByRole('option', { name: 'Devin' })
    const claude = screen.getByRole('option', { name: 'Claude' })
    expect(within(devin).getByText('Beta')).toHaveClass('bg-warning/10')
    expect(within(claude).queryByText('Beta')).toBeNull()
  })

  it('reloads the avatar when the persisted path changes', () => {
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
