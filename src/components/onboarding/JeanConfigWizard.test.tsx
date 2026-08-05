import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/react'
import { render } from '@/test/test-utils'
import { useProjectsStore } from '@/store/projects-store'
import { JeanConfigWizard } from './JeanConfigWizard'

const projectsMock = vi.hoisted(() => ({
  saveMutateAsync: vi.fn().mockResolvedValue(undefined),
  jeanConfigData: undefined as unknown,
  jeanConfigIsLoading: false,
}))

vi.mock('@/services/projects', () => ({
  useProjects: () => ({
    data: [{ id: 'project-1', name: 'Jean', path: '/tmp/jean' }],
  }),
  useSaveJeanConfig: () => ({
    isPending: false,
    mutateAsync: projectsMock.saveMutateAsync,
  }),
  useJeanConfig: () => ({
    data: projectsMock.jeanConfigData,
    isLoading: projectsMock.jeanConfigIsLoading,
  }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { has_seen_jean_config_wizard: false },
  }),
  usePatchPreferences: () => ({ mutate: vi.fn() }),
}))

beforeEach(() => {
  projectsMock.saveMutateAsync.mockClear()
  projectsMock.jeanConfigData = undefined
  projectsMock.jeanConfigIsLoading = false
})

describe('JeanConfigWizard mobile layout', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      jeanConfigWizardOpen: true,
      jeanConfigWizardProjectId: 'project-1',
    })
  })

  it('keeps the form scrollable and the actions inside the mobile viewport', () => {
    render(<JeanConfigWizard />)

    expect(
      screen.getByRole('dialog', { name: 'Configure Automation' })
    ).toHaveClass(
      '!inset-0',
      '!h-dvh',
      '!max-w-none',
      'flex',
      'overflow-hidden'
    )
    expect(screen.getByTestId('jean-config-wizard-scroll')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
      'overscroll-contain'
    )
    expect(screen.getByTestId('jean-config-wizard-actions')).toHaveClass(
      'shrink-0',
      'pb-[calc(env(safe-area-inset-bottom)+1rem)]'
    )
    expect(screen.getByRole('button', { name: 'Skip' })).toHaveClass('h-11')
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('h-11')
  })

  it('stacks configured port fields within the mobile width', async () => {
    const user = userEvent.setup()
    render(<JeanConfigWizard />)

    await user.click(screen.getByRole('button', { name: 'Add port' }))

    expect(screen.getByTestId('jean-config-wizard-port-fields')).toHaveClass(
      'grid',
      'grid-cols-2',
      'sm:flex'
    )
    expect(screen.getByPlaceholderText('Label')).toHaveClass(
      'col-span-2',
      'sm:w-auto'
    )
  })
})

describe('JeanConfigWizard provider preservation', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      jeanConfigWizardOpen: true,
      jeanConfigWizardProjectId: 'project-1',
    })
  })

  it('preserves an existing provider block in the saved payload', async () => {
    const user = userEvent.setup()
    projectsMock.jeanConfigData = {
      scripts: { setup: null, teardown: null, run: null },
      ports: null,
      provider: { git: 'gitlab', host: 'gitlab.example.com' },
    }

    render(<JeanConfigWizard />)

    // Enter some content so the Save button becomes enabled.
    await user.type(screen.getByPlaceholderText('e.g. npm install'), 'npm ci')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(projectsMock.saveMutateAsync).toHaveBeenCalledTimes(1)
    const payload = projectsMock.saveMutateAsync.mock.calls[0]?.[0] as {
      config: { provider?: unknown }
    }
    expect(payload.config.provider).toEqual({
      git: 'gitlab',
      host: 'gitlab.example.com',
    })
  })

  it('keeps Save disabled while the config query is still loading', async () => {
    const user = userEvent.setup()
    projectsMock.jeanConfigIsLoading = true
    projectsMock.jeanConfigData = undefined

    render(<JeanConfigWizard />)

    // Content is present (so hasContent is true), but the load gate must still
    // keep Save disabled until the existing config resolves — otherwise the
    // spread would drop a pre-existing provider block.
    await user.type(screen.getByPlaceholderText('e.g. npm install'), 'npm ci')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
