import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type { CliBackend } from '@/types/preferences'
import { AgentRunFields } from './AgentRunFields'
import {
  AGENT_DEFAULT_OPTION,
  agentRunPatch,
  EMPTY_AGENT_RUN,
  type AgentRunDraft,
} from './agent-config'

vi.mock('@/hooks/useInstalledBackends', () => ({
  useInstalledBackends: () => ({
    installedBackends: ['claude', 'codex'],
    isLoading: false,
  }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: { default_backend: 'codex', custom_cli_profiles: [] },
  }),
}))

vi.mock('@/services/skills', () => ({
  useAllBackendSkills: () => [],
}))

// The real picker is covered by its own tests; this stub exposes the props
// AgentRunFields passes and lets the test pick an option.
vi.mock('@/components/chat/toolbar/DesktopBackendModelPicker', () => ({
  DesktopBackendModelPicker: (props: {
    selectedBackend: CliBackend
    selectedModel: string
    installedBackends: CliBackend[]
    defaultModelOption?: { value: string; label: string }
    triggerLabel?: React.ReactNode
    keyboardShortcuts?: boolean
    onModelChange: (model: string) => void
    onBackendModelChange: (backend: CliBackend, model: string) => void
  }) => (
    <div
      data-testid="shared-picker"
      data-backend={props.selectedBackend}
      data-model={props.selectedModel}
      data-installed={props.installedBackends.join(',')}
      data-default-option={props.defaultModelOption?.value}
      data-shortcuts={String(props.keyboardShortcuts)}
    >
      {props.triggerLabel}
      <button type="button" onClick={() => props.onModelChange('gpt-5.5')}>
        pick model on shown backend
      </button>
      <button
        type="button"
        onClick={() => props.onBackendModelChange('codex', 'gpt-5.5')}
      >
        pick codex gpt
      </button>
      <button
        type="button"
        onClick={() =>
          props.onModelChange(props.defaultModelOption?.value ?? '')
        }
      >
        pick default model
      </button>
    </div>
  ),
}))

function renderFields(value: AgentRunDraft, inheritFrom?: string) {
  const onChange = vi.fn()
  render(
    <AgentRunFields
      idPrefix="test"
      serverId="local"
      value={value}
      onChange={onChange}
      inheritFrom={inheritFrom}
    />
  )
  return onChange
}

describe('AgentRunFields', () => {
  it('uses the shared chat picker with an inherit option and no global shortcuts', () => {
    renderFields(EMPTY_AGENT_RUN)
    const picker = screen.getByTestId('shared-picker')
    // Inheriting: opens on the new-chat default backend, shows "Default"
    expect(picker.dataset.backend).toBe('codex')
    expect(picker.dataset.model).toBe(AGENT_DEFAULT_OPTION)
    expect(picker.dataset.defaultOption).toBe(AGENT_DEFAULT_OPTION)
    expect(picker.dataset.installed).toBe('claude,codex')
    expect(picker.dataset.shortcuts).toBe('false')
    expect(picker).toHaveTextContent('Default · same as a new chat')
  })

  it('pins the shown backend when a model is picked while inheriting', async () => {
    const onChange = renderFields(EMPTY_AGENT_RUN)
    await userEvent.click(screen.getByText('pick model on shown backend'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'codex', model: 'gpt-5.5' })
    )
  })

  it('switches backend and clears overrides of the old one', async () => {
    const onChange = renderFields({
      ...EMPTY_AGENT_RUN,
      backend: 'claude',
      model: 'claude-opus-5',
      effort: 'max',
      thinkingLevel: 'ultrathink',
    })
    await userEvent.click(screen.getByText('pick codex gpt'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'codex',
        model: 'gpt-5.5',
        effort: '',
        thinkingLevel: '',
      })
    )
  })

  it('saves "Default model" as a null model', async () => {
    const onChange = renderFields({
      ...EMPTY_AGENT_RUN,
      backend: 'claude',
      model: 'claude-opus-5',
    })
    await userEvent.click(screen.getByText('pick default model'))
    const next = onChange.mock.calls[0]?.[0] as AgentRunDraft
    expect(agentRunPatch(next)).toMatchObject({
      backend: 'claude',
      model: null,
    })
  })

  it('resets every override with Use default', async () => {
    const onChange = renderFields({
      ...EMPTY_AGENT_RUN,
      backend: 'claude',
      model: 'claude-opus-5',
      effort: 'max',
      thinkingLevel: 'ultrathink',
    })
    await userEvent.click(screen.getByRole('button', { name: /use default/i }))
    const next = onChange.mock.calls[0]?.[0] as AgentRunDraft
    expect(agentRunPatch(next)).toMatchObject({
      backend: null,
      model: null,
      effort: null,
      thinkingLevel: null,
    })
  })

  it('shows effort and thinking pickers with Default for Claude', async () => {
    const onChange = renderFields({ ...EMPTY_AGENT_RUN, backend: 'claude' })
    expect(
      screen.getByRole('button', { name: 'Effort: Default' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Thinking: Default' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /use default/i })
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Effort: Default' })
    )
    await userEvent.click(
      await screen.findByRole('menuitemradio', { name: /^High/ })
    )
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'claude', effort: 'high' })
    )
  })

  it('hides reasoning pickers and Use default while inheriting', () => {
    renderFields(EMPTY_AGENT_RUN, 'this agent')
    expect(screen.queryByRole('button', { name: /^Effort/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /use default/i })).toBeNull()
    expect(screen.getByTestId('shared-picker')).toHaveTextContent(
      'same as this agent'
    )
  })
})
