import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@/test/test-utils'
import type { Project, ProjectAutoFixSettings } from '@/types/projects'
import {
  AutoFixPane,
  buildAutoFixSettings,
  firstAvailableBackend,
  hasAutoFixSettingsChanges,
  MR_ROBOT_SETTINGS_BADGE,
  resolveAutoFixBackend,
} from './AutoFixPane'
import type { CliBackend } from '@/types/preferences'

const mutateMock = vi.fn()
let projectsMock: Project[] = []
let installedBackendsMock: CliBackend[] = ['claude', 'codex', 'cursor']

class ResizeObserverMock {
  observe() {
    return undefined
  }
  unobserve() {
    return undefined
  }
  disconnect() {
    return undefined
  }
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
Element.prototype.scrollIntoView = vi.fn()

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: projectsMock }),
  useUpdateProjectSettings: () => ({ mutate: mutateMock, isPending: false }),
}))

vi.mock('@/services/github', () => ({
  useGitHubLabels: () => ({
    data: [
      { name: 'bug', color: 'd73a4a' },
      { name: 'enhancement', color: 'a2eeef' },
      { name: 'blocked', color: 'd4c5f9' },
      { name: 'do not fix', color: '6b7280' },
      { name: 'wontfix', color: 'ffffff' },
    ],
    isLoading: false,
  }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      favorite_models: [],
      fast_mode_models: [],
    },
  }),
  usePatchPreferences: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    // Subset of CLI backends — uninstalled ones must not appear in the picker
    installedBackends: installedBackendsMock,
    isLoading: false,
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: undefined }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({ data: undefined }),
}))

vi.mock('@/services/pi-cli', () => ({
  useAvailablePiModels: () => ({ data: undefined }),
}))

vi.mock('@/services/commandcode-cli', () => ({
  useAvailableCommandCodeModels: () => ({ data: undefined }),
}))

const baseAutoFixSettings: ProjectAutoFixSettings = {
  enabled: false,
  interval_minutes: 30,
  issue_limit: 2,
  max_parallel_worktrees: 3,
  planning_backend: 'claude',
  planning_model: 'haiku',
  auto_yolo_enabled: false,
  yolo_backend: 'claude',
  yolo_model: null,
  active_hours_enabled: false,
  active_hours_start: 20,
  active_hours_end: 8,
  included_labels: [],
  excluded_labels: [],
}

function project(
  autoFixSettings: Partial<ProjectAutoFixSettings> = {}
): Project {
  return {
    id: 'project-id',
    name: 'Project',
    path: '/tmp/project',
    default_branch: 'main',
    added_at: 1,
    order: 1,
    auto_fix_settings: {
      ...baseAutoFixSettings,
      ...autoFixSettings,
    },
  }
}

function renderPane() {
  return render(<AutoFixPane projectId="project-id" />)
}

function getElementAt<T>(items: T[], index: number): T {
  const item = items[index]
  if (!item) throw new Error(`Expected element at index ${index}`)
  return item
}

describe('auto-fix backend defaults', () => {
  it('picks the first installed backend as the default', () => {
    expect(firstAvailableBackend(['codex', 'cursor'])).toBe('codex')
    expect(firstAvailableBackend([])).toBe('claude')
  })

  it('keeps an installed backend and remaps uninstalled ones', () => {
    expect(resolveAutoFixBackend('cursor', ['codex', 'cursor'])).toBe('cursor')
    expect(resolveAutoFixBackend('claude', ['codex', 'cursor'])).toBe('codex')
    expect(resolveAutoFixBackend(null, ['pi'])).toBe('pi')
  })

  it('defaults planning and yolo to the first available backend', () => {
    const settings = buildAutoFixSettings(null, ['codex', 'opencode'])
    expect(settings.planning_backend).toBe('codex')
    expect(settings.yolo_backend).toBe('codex')
  })
})

describe('AutoFixPane', () => {
  beforeEach(() => {
    mutateMock.mockReset()
    projectsMock = [project()]
    installedBackendsMock = ['claude', 'codex', 'cursor']
    HTMLElement.prototype.hasPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation(() => ({
        matches: false,
        media: '',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    )
  })

  it('labels Mr. Robot settings as beta', () => {
    expect(MR_ROBOT_SETTINGS_BADGE).toBe('Beta')
  })

  it('renders with project auto-fix settings', () => {
    renderPane()

    expect(screen.getByText('Mr. Robot')).toBeInTheDocument()
    expect(screen.getByText('Mr. Robot issue sweeps')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save settings' })
    ).toBeInTheDocument()
  })

  it('disables save until settings change', () => {
    renderPane()

    const button = screen.getByRole('button', { name: 'Save settings' })
    expect(button).toBeDisabled()

    fireEvent.change(getElementAt(screen.getAllByRole('spinbutton'), 0), {
      target: { value: '45' },
    })

    expect(button).not.toBeDisabled()
  })

  it('does not submit unchanged settings', () => {
    renderPane()

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('detects deep settings changes', () => {
    expect(
      hasAutoFixSettingsChanges(baseAutoFixSettings, baseAutoFixSettings)
    ).toBe(false)
    expect(
      hasAutoFixSettingsChanges(baseAutoFixSettings, {
        ...baseAutoFixSettings,
        interval_minutes: 45,
      })
    ).toBe(true)
  })

  it('saves when toggles change', async () => {
    const user = userEvent.setup()
    renderPane()

    const switches = screen.getAllByRole('switch')
    await user.click(getElementAt(switches, 0))
    await user.click(getElementAt(switches, 1))

    expect(mutateMock).toHaveBeenNthCalledWith(1, {
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({ enabled: true }),
    })
    expect(mutateMock).toHaveBeenNthCalledWith(2, {
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({
        active_hours_enabled: true,
      }),
    })
  })

  it('clamps numeric inputs to at least one before saving', async () => {
    const user = userEvent.setup()
    renderPane()

    fireEvent.change(getElementAt(screen.getAllByRole('spinbutton'), 0), {
      target: { value: '0' },
    })
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({ interval_minutes: 1 }),
    })
  })

  it('saves selected excluded GitHub labels', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.click(
      screen.getByRole('button', { name: 'Excluded GitHub labels' })
    )
    await user.click(await screen.findByText('wontfix'))
    await user.click(await screen.findByText('blocked'))
    await user.click(await screen.findByText('do not fix'))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({
        excluded_labels: ['wontfix', 'blocked', 'do not fix'],
      }),
    })
  })

  it('saves selected included GitHub labels', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.click(
      screen.getByRole('button', { name: 'Included GitHub labels' })
    )
    await user.click(await screen.findByText('bug'))
    await user.click(await screen.findByText('enhancement'))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({
        included_labels: ['bug', 'enhancement'],
      }),
    })
  })

  it('clears the planning model when the planning backend changes', async () => {
    const user = userEvent.setup()
    renderPane()

    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('Claude')
    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('Haiku')

    await user.click(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    )
    await user.click(await screen.findByRole('tab', { name: 'Codex' }))
    await user.click(await screen.findByText('Backend default'))

    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('Codex')
    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('Backend default')
  })

  it('selects a planning backend and model from the combined picker', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.click(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    )
    await user.click(await screen.findByRole('tab', { name: 'Codex' }))
    await user.click(await screen.findByText('GPT 5.4'))

    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('Codex')
    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('GPT 5.4')
  })

  it('selects a yolo backend and model from the combined picker', async () => {
    const user = userEvent.setup()
    projectsMock = [project({ auto_yolo_enabled: true })]
    renderPane()

    await user.click(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    )
    await user.click(await screen.findByRole('tab', { name: 'Cursor' }))
    await user.click(await screen.findByText('Auto'))

    expect(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    ).toHaveTextContent('Cursor')
    expect(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    ).toHaveTextContent('Auto')
  })

  it('keeps the yolo picker disabled when auto-yolo is off', () => {
    renderPane()

    expect(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    ).toBeDisabled()
  })

  it('shows backend default when an auto-fix model is null', () => {
    projectsMock = [
      project({
        planning_model: null,
        yolo_model: null,
        auto_yolo_enabled: true,
      }),
    ]
    renderPane()

    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('Backend default')
    expect(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    ).toHaveTextContent('Backend default')
  })

  it('defaults to the first installed backend when Claude is not available', () => {
    installedBackendsMock = ['codex', 'cursor']
    projectsMock = [
      {
        id: 'project-id',
        name: 'Project',
        path: '/tmp/project',
        default_branch: 'main',
        added_at: 1,
        order: 1,
        auto_fix_settings: null,
      },
    ]
    renderPane()

    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('Codex')
    expect(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    ).toHaveTextContent('Codex')
  })

  it('remaps a saved Claude backend when Claude is not installed', () => {
    installedBackendsMock = ['codex', 'cursor']
    projectsMock = [
      project({
        planning_backend: 'claude',
        yolo_backend: 'claude',
        auto_yolo_enabled: true,
      }),
    ]
    renderPane()

    expect(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    ).toHaveTextContent('Codex')
    expect(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    ).toHaveTextContent('Codex')
  })

  it('only offers installed backends for planning and yolo execution', async () => {
    const user = userEvent.setup()
    projectsMock = [project({ auto_yolo_enabled: true })]
    renderPane()

    const expectedBackends = ['Claude', 'Codex', 'Cursor']
    const hiddenBackends = [
      'OpenCode',
      'PI (Beta)',
      'Command Code (Beta)',
      'Grok (Beta)',
      'Kimi Code (Beta)',
    ]

    await user.click(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    )
    const planningTabs = screen.getByRole('tablist')
    for (const backend of expectedBackends) {
      expect(
        within(planningTabs).getByRole('tab', { name: backend })
      ).toBeInTheDocument()
    }
    for (const backend of hiddenBackends) {
      expect(
        within(planningTabs).queryByRole('tab', { name: backend })
      ).not.toBeInTheDocument()
    }
    await user.keyboard('{Escape}')

    await user.click(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    )
    const yoloTabs = screen.getByRole('tablist')
    for (const backend of expectedBackends) {
      expect(
        within(yoloTabs).getByRole('tab', { name: backend })
      ).toBeInTheDocument()
    }
    for (const backend of hiddenBackends) {
      expect(
        within(yoloTabs).queryByRole('tab', { name: backend })
      ).not.toBeInTheDocument()
    }
  })

  it('keeps saving null model settings from backend default selections', async () => {
    const user = userEvent.setup()
    projectsMock = [
      project({
        planning_model: null,
        yolo_model: null,
        auto_yolo_enabled: true,
      }),
    ]
    renderPane()

    await user.click(
      screen.getByRole('button', { name: 'Choose planning backend and model' })
    )
    await user.click(await screen.findByRole('tab', { name: 'Codex' }))
    await user.click(await screen.findByText('Backend default'))

    await user.click(
      screen.getByRole('button', { name: 'Choose yolo backend and model' })
    )
    await user.click(await screen.findByRole('tab', { name: 'Cursor' }))
    await user.click(await screen.findByText('Backend default'))

    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({
        planning_backend: 'codex',
        planning_model: null,
        yolo_backend: 'cursor',
        yolo_model: null,
      }),
    })
  })

  it('legacy: no separate backend and model comboboxes remain', () => {
    renderPane()

    expect(
      screen.queryByRole('combobox', { name: /backend/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: /model/i })
    ).not.toBeInTheDocument()
  })

  it('trims model strings and saves blank models as null', async () => {
    const user = userEvent.setup()
    projectsMock = [
      project({
        planning_model: '  haiku  ',
        yolo_model: '   ',
      }),
    ]
    renderPane()

    fireEvent.change(getElementAt(screen.getAllByRole('spinbutton'), 0), {
      target: { value: '31' },
    })
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({
        interval_minutes: 31,
        planning_model: 'haiku',
        yolo_model: null,
      }),
    })
  })
})
