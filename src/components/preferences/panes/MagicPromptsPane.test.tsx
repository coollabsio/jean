import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test/test-utils'
import { defaultPreferences } from '@/types/preferences'
import { MagicPromptsPane } from './MagicPromptsPane'

const mutateMock = vi.fn()
let installedBackendsMock = ['claude', 'codex']
let preferencesMock = { ...defaultPreferences }
let availableGrokModelsMock:
  | { id: string; label: string; isDefault: boolean }[]
  | undefined

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      ...preferencesMock,
      magic_prompt_modes: {
        investigate_issue_mode: 'plan',
        investigate_pr_mode: 'plan',
        investigate_workflow_run_mode: 'plan',
        investigate_security_alert_mode: 'plan',
        investigate_advisory_mode: 'plan',
        investigate_linear_issue_mode: 'plan',
        investigate_sentry_issue_mode: 'plan',
        review_comments_mode: 'plan',
        final_review_mode: 'yolo',
        resolve_conflicts_mode: 'yolo',
      },
    },
  }),
  usePatchPreferences: () => ({ mutate: mutateMock }),
}))

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({ installedBackends: installedBackendsMock }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useAvailableOpencodeModels: () => ({ data: undefined }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useAvailableCursorModels: () => ({ data: undefined }),
}))

vi.mock('@/services/commandcode-cli', () => ({
  useAvailableCommandCodeModels: () => ({ data: undefined }),
}))

vi.mock('@/services/pi-cli', () => ({
  useAvailablePiModels: () => ({ data: undefined }),
}))

vi.mock('@/services/grok-cli', () => ({
  useAvailableGrokModels: () => ({ data: availableGrokModelsMock }),
}))

vi.mock('@/services/model-catalog', () => ({
  getCatalogModelOptions: (_catalog: unknown, backend: 'claude' | 'codex') =>
    backend === 'claude'
      ? [
          { value: 'claude-fable-5', label: 'Claude Fable 5' },
          { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
        ]
      : [],
  getCatalogModelReasoning: (
    _catalog: unknown,
    backend: string,
    model: string
  ) =>
    (backend === 'claude' && model !== 'haiku') || backend === 'codex'
      ? {
          type: 'effort',
          default: backend === 'codex' ? 'low' : 'high',
          levels: [
            { value: 'low', label: 'Low', description: 'Light' },
            { value: 'high', label: 'High', description: 'Deep' },
          ],
        }
      : undefined,
  useModelCatalog: () => ({ data: undefined }),
}))

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

beforeEach(() => {
  mutateMock.mockReset()
  installedBackendsMock = ['claude', 'codex']
  preferencesMock = { ...defaultPreferences }
  availableGrokModelsMock = undefined
  globalThis.ResizeObserver = ResizeObserverMock as never
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

describe('MagicPromptsPane', () => {
  it('lets chat-style magic prompts choose plan or yolo as their default mode', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Default mode' }))
    await user.click(screen.getByRole('option', { name: 'Yolo' }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_prompt_modes: expect.objectContaining({
          investigate_issue_mode: 'yolo',
        }),
      })
    )
  })

  it('uses a compact prompt picker on mobile instead of relying only on the sidebar', () => {
    render(<MagicPromptsPane />)

    expect(
      screen.getByRole('combobox', { name: 'Magic prompt' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('magic-prompts-sidebar')).toHaveClass('hidden')
    expect(screen.getByTestId('magic-prompts-sidebar')).toHaveClass('md:block')
  })

  it('does not include release post as an editable magic prompt', () => {
    render(<MagicPromptsPane />)

    expect(screen.queryByText('Release Post')).toBeNull()
  })

  it('provides a dedicated Sentry investigation prompt', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(
      screen.getByRole('button', { name: 'Investigate Sentry Issue' })
    )

    expect(screen.getByText('{sentryRefs}')).toBeInTheDocument()
    expect(screen.getByText('{sentryContext}')).toBeInTheDocument()
  })

  it('provides dedicated Final Review settings', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('button', { name: 'Final Review' }))

    expect(
      screen.getByRole('combobox', { name: 'Backend' })
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Default mode' })
    ).toHaveTextContent('Yolo')
    expect(
      screen.getByDisplayValue(/final pre-merge audit/i)
    ).toBeInTheDocument()
  })

  it('uses the catalog Claude models for magic prompt model choices', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Model' }))

    expect(screen.getByText('Fable 5')).toBeInTheDocument()
  })

  it('lets magic prompts choose Pi, Command Code, and Grok backends', async () => {
    installedBackendsMock = ['claude', 'pi', 'commandcode', 'grok']
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Backend' }))

    expect(screen.getByRole('option', { name: 'PI' })).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Command Code' })
    ).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Grok' })).toBeInTheDocument()
  })

  it('lists Codex second in the magic prompt backend menu', async () => {
    installedBackendsMock = [
      'claude',
      'codex',
      'opencode',
      'cursor',
      'pi',
      'commandcode',
      'grok',
      'kimi',
    ]
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Backend' }))

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('Claude')
    expect(options[1]).toHaveTextContent('Codex')
  })

  it('shows the available Grok models when Grok is selected', async () => {
    installedBackendsMock = ['claude', 'grok']
    availableGrokModelsMock = [
      { id: 'grok-4.5', label: 'Grok 4.5', isDefault: true },
    ]
    preferencesMock = {
      ...defaultPreferences,
      magic_prompt_backends: {
        ...defaultPreferences.magic_prompt_backends,
        investigate_issue_backend: 'grok',
      },
      magic_prompt_models: {
        ...defaultPreferences.magic_prompt_models,
        investigate_issue_model: 'grok/grok-4.5',
      },
    }
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Model' }))

    expect(
      screen.getByRole('option', { name: /Grok 4\.5/ })
    ).toBeInTheDocument()
    expect(screen.queryByText('No models found.')).toBeNull()
  })

  it('keeps magic prompt control labels paired with dropdowns on mobile', () => {
    render(<MagicPromptsPane />)

    expect(screen.getByTestId('magic-prompt-config')).toHaveClass(
      'border',
      'rounded-lg'
    )
    expect(screen.getByTestId('magic-prompt-backend-control')).toHaveClass(
      'grid-cols-[72px_minmax(0,1fr)]'
    )
    expect(screen.getByTestId('magic-prompt-model-control')).toHaveClass(
      'grid-cols-[72px_minmax(0,1fr)]'
    )
    expect(screen.getByTestId('magic-prompt-mode-control')).toHaveClass(
      'grid-cols-[72px_minmax(0,1fr)]'
    )
    expect(screen.getByTestId('magic-prompt-reasoning-control')).toHaveClass(
      'grid-cols-[72px_minmax(0,1fr)]'
    )
  })

  it('uses the selected model capability for an explicit reasoning level', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    const reasoning = screen.getByRole('combobox', { name: 'Reasoning level' })
    expect(reasoning).toHaveTextContent('High')

    await user.click(reasoning)
    expect(screen.getByRole('option', { name: /Low/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Model default/ })).toBeNull()
    await user.click(screen.getByRole('option', { name: /Low/ }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_prompt_efforts: expect.objectContaining({
          investigate_issue_effort: 'low',
        }),
      })
    )
  })

  it('shows only level names in every reasoning menu', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Reasoning level' }))
    expect(screen.getByRole('option', { name: 'Low' })).toBeInTheDocument()
    expect(screen.queryByText('Light')).toBeNull()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Code Review' }))
    await user.click(
      screen.getByRole('combobox', { name: 'Review 1 reasoning' })
    )
    expect(screen.getByRole('option', { name: 'High' })).toBeInTheDocument()
    expect(screen.queryByText('Deep')).toBeNull()
  })

  it('resets reasoning to the new model default when the backend changes', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Backend' }))
    await user.click(screen.getByRole('option', { name: 'Codex' }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_prompt_efforts: expect.objectContaining({
          investigate_issue_effort: 'low',
        }),
      })
    )
  })

  it('disables reasoning for a custom provider without thinking support', () => {
    preferencesMock = {
      ...defaultPreferences,
      custom_cli_profiles: [
        {
          name: 'No Thinking',
          settings_json: '{}',
          supports_thinking: false,
        },
      ],
      magic_prompt_providers: {
        ...defaultPreferences.magic_prompt_providers,
        investigate_issue_provider: 'No Thinking',
      },
    }

    render(<MagicPromptsPane />)

    expect(
      screen.getByRole('combobox', { name: 'Reasoning level' })
    ).toBeDisabled()
  })

  it('offers backend-native effort levels when discovered models lack catalog metadata', async () => {
    installedBackendsMock = ['claude', 'pi']
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('combobox', { name: 'Backend' }))
    await user.click(screen.getByRole('option', { name: 'PI' }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_prompt_efforts: expect.objectContaining({
          investigate_issue_effort: 'high',
        }),
      })
    )
  })

  it('shows presets in a dropdown with every GPT 5.6 variant', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    expect(screen.queryByRole('button', { name: 'Claude Defaults' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Apply preset' }))

    expect(
      screen.getByRole('menuitem', { name: 'Claude Defaults' })
    ).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'GPT 5.6 Sol' })).toBeVisible()
    expect(
      screen.getByRole('menuitem', { name: 'GPT 5.6 Sol Fast' })
    ).toBeVisible()
    expect(screen.getByRole('menuitem', { name: 'GPT 5.6 Luna' })).toBeVisible()
    expect(
      screen.getByRole('menuitem', { name: 'GPT 5.6 Luna Fast' })
    ).toBeVisible()
    expect(
      screen.getByRole('menuitem', { name: 'GPT 5.6 Terra' })
    ).toBeVisible()
    expect(
      screen.getByRole('menuitem', { name: 'GPT 5.6 Terra Fast' })
    ).toBeVisible()

    await user.click(
      screen.getByRole('menuitem', { name: 'GPT 5.6 Luna Fast' })
    )

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_prompt_models: expect.objectContaining({
          investigate_issue_model: 'gpt-5.6-luna-fast',
          review_comments_model: 'gpt-5.6-luna-fast',
        }),
        magic_prompt_backends: expect.objectContaining({
          investigate_issue_backend: 'codex',
          review_comments_backend: 'codex',
        }),
        magic_prompt_efforts: expect.objectContaining({
          investigate_issue_effort: 'low',
          review_comments_effort: 'low',
        }),
        magic_code_review_configs: [
          {
            backend: 'codex',
            model: 'gpt-5.6-luna-fast',
            reasoning_effort: 'low',
          },
        ],
      })
    )
  })

  it('uses Luna Fast with low reasoning for Codex commit message presets', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('button', { name: 'Apply preset' }))
    await user.click(screen.getByRole('menuitem', { name: 'GPT 5.6 Sol' }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_prompt_models: expect.objectContaining({
          investigate_issue_model: 'gpt-5.6-sol',
          commit_message_model: 'gpt-5.6-luna-fast',
        }),
        magic_prompt_efforts: expect.objectContaining({
          commit_message_effort: 'low',
        }),
      })
    )
  })

  it('adds a second unique backend and model to code review', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByText('Code Review'))
    await user.click(screen.getByRole('button', { name: 'Add review' }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_code_review_configs: [
          expect.objectContaining({ backend: 'claude' }),
          expect.objectContaining({ backend: 'codex' }),
        ],
      })
    )
  })

  it('configures reasoning separately for each code review model', async () => {
    preferencesMock = {
      ...defaultPreferences,
      magic_code_review_configs: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'low',
        },
        {
          backend: 'claude',
          model: 'claude-fable-5',
          reasoning_effort: 'high',
        },
      ],
    }
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('button', { name: 'Code Review' }))

    expect(
      screen.getByRole('combobox', { name: 'Review 1 reasoning' })
    ).toHaveTextContent('Low')
    expect(
      screen.getByRole('combobox', { name: 'Review 2 reasoning' })
    ).toHaveTextContent('High')

    await user.click(
      screen.getByRole('combobox', { name: 'Review 2 reasoning' })
    )
    await user.click(screen.getByRole('option', { name: /Low/ }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_code_review_configs: [
          expect.objectContaining({ reasoning_effort: 'low' }),
          expect.objectContaining({ reasoning_effort: 'low' }),
        ],
      })
    )
  })

  it('applies the selected provider capability only to Claude review rows', async () => {
    preferencesMock = {
      ...defaultPreferences,
      custom_cli_profiles: [
        {
          name: 'Custom Provider',
          settings_json: '{}',
          supports_thinking: false,
        },
      ],
      magic_prompt_models: {
        ...defaultPreferences.magic_prompt_models,
        code_review_model: 'gpt-5.6-sol',
      },
      magic_code_review_configs: [
        {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'low',
        },
        {
          backend: 'claude',
          model: 'claude-fable-5',
          reasoning_effort: 'high',
        },
      ],
    }
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('button', { name: 'Code Review' }))
    await user.click(screen.getByRole('combobox', { name: 'Provider' }))
    await user.click(screen.getByRole('option', { name: 'Custom Provider' }))

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        magic_code_review_configs: [
          expect.objectContaining({ reasoning_effort: 'low' }),
          expect.objectContaining({ reasoning_effort: null }),
        ],
      })
    )
  })

  it('lays out each mobile review setting as one labeled full-width row', async () => {
    const user = userEvent.setup()
    render(<MagicPromptsPane />)

    await user.click(screen.getByRole('button', { name: 'Code Review' }))

    const review = screen.getByTestId('magic-code-review-config-0')
    expect(review).toHaveClass('flex-col')
    expect(within(review).getByText('Backend')).toBeInTheDocument()
    expect(within(review).getByText('Model')).toBeInTheDocument()
    expect(within(review).getByText('Reasoning')).toBeInTheDocument()
    expect(
      within(review).getByRole('combobox', { name: 'Review 1 backend' })
    ).toHaveClass('w-full')
    expect(
      within(review).getByRole('combobox', { name: 'Review 1 model' })
    ).toHaveClass('w-full')
    expect(
      within(review).getByRole('combobox', { name: 'Review 1 reasoning' })
    ).toHaveClass('w-full')
  })
})
