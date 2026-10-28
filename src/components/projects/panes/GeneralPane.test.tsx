import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, within } from '@/test/test-utils'
import type { Project } from '@/types/projects'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralPane } from './GeneralPane'

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  installedBackends: [] as string[],
  updateSettings: vi.fn(),
  preferences: {} as Record<string, unknown>,
}))

vi.mock('@/lib/transport', () => ({
  convertFileSrc: (path: string) => `file://${path}`,
  convertProjectFileSrc: (path: string) => `project://${path}`,
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: mocks.projects }),
  useProjectBranches: () => ({ data: [], isLoading: false, error: null }),
  useUpdateProjectSettings: () => ({
    mutate: mocks.updateSettings,
    isPending: false,
  }),
  useAppDataDir: () => ({ data: '/app-data' }),
  useSetProjectAvatar: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveProjectAvatar: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mocks.preferences }),
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
    mocks.updateSettings.mockReset()
    mocks.preferences = { custom_cli_profiles: [], default_backend: 'codex' }
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('marks installed Devin as beta in the default backend list', async () => {
    mocks.installedBackends = ['claude', 'devin']
    const user = userEvent.setup()
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)

    await user.click(screen.getByRole('combobox', { name: 'Default Backend' }))

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

  it('saves the project name on blur only when it changed', () => {
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)
    const name = screen.getByLabelText('Name')

    fireEvent.change(name, { target: { value: ' Jean ' } })
    fireEvent.blur(name)
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    fireEvent.change(name, { target: { value: 'Jean App ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    fireEvent.blur(name)
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1)
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { projectId: 'project-1', name: 'Jean App' },
      expect.anything()
    )
  })

  it('saves the system prompt on blur only when it changed', () => {
    render(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)
    const prompt = screen.getByLabelText('System Prompt')

    fireEvent.change(prompt, { target: { value: '' } })
    fireEvent.blur(prompt)
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    fireEvent.change(prompt, { target: { value: 'Use Rust' } })
    fireEvent.blur(prompt)
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { projectId: 'project-1', customSystemPrompt: 'Use Rust' },
      expect.anything()
    )
  })

  it('shows the inherited global backend until the project overrides it', () => {
    const { rerender } = render(
      <GeneralPane projectId="project-1" projectPath="/projects/jean" />
    )
    expect(screen.getByText('Inherits global: Codex')).toBeInTheDocument()

    mocks.projects = [
      { ...project('avatars/project-1-old.png'), default_backend: 'claude' },
    ]
    rerender(<GeneralPane projectId="project-1" projectPath="/projects/jean" />)
    expect(screen.getByText('Overrides global')).toBeInTheDocument()
    expect(screen.queryByText('Inherits global: Codex')).toBeNull()
  })
})
