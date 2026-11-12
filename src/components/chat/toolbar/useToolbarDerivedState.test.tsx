import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type * as ModelCatalogService from '@/services/model-catalog'
import { ANTIGRAVITY_MODEL_OPTIONS } from './toolbar-options'
import { useToolbarDerivedState } from './useToolbarDerivedState'

vi.mock('@/services/model-catalog', async importOriginal => {
  const actual = await importOriginal<typeof ModelCatalogService>()
  return {
    ...actual,
    useModelCatalog: () => ({
      data: {
        version: 1,
        updated_at: '2026-06-09T00:00:00Z',
        defaults: { claude: 'claude-remote', codex: 'gpt-remote' },
        backends: {
          claude: {
            models: [{ id: 'claude-remote', label: 'Claude Remote' }],
          },
          codex: {
            models: [{ id: 'gpt-remote', label: 'GPT Remote' }],
          },
          grok: {
            models: [
              {
                id: 'grok/remote',
                label: 'Grok Remote',
                reasoning: {
                  type: 'effort',
                  default: 'max',
                  levels: [{ value: 'max', label: 'Maximum' }],
                },
              },
            ],
          },
        },
      },
    }),
  }
})

describe('useToolbarDerivedState', () => {
  it('uses remote Claude and Codex model catalog options', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'claude',
        selectedProvider: null,
        selectedModel: 'claude-remote',
        customCliProfiles: [],
        installedBackends: ['claude', 'codex'],
      })
    )

    const sections = result.current.backendModelSections
    expect(sections.map(section => section.backend)).toEqual([
      'claude',
      'codex',
    ])
    expect(sections[0]?.options).toContainEqual({
      value: 'claude-remote',
      label: 'Remote',
    })
    // Regression: a CDN catalog that predates a release must not hide a model
    // bundled in this build.
    expect(sections[0]?.options).toContainEqual({
      value: 'claude-fable-5-2',
      label: 'Fable 5.2',
    })
    expect(sections[1]?.options).toEqual([
      { value: 'gpt-remote', label: 'GPT Remote' },
    ])
    expect(result.current.selectedModelLabel).toBe('Remote')
  })

  it('shows custom Claude model ids before catalog options', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'claude',
        selectedProvider: null,
        selectedModel: 'claude-fable-6',
        customCliProfiles: [],
        customClaudeModels: ['claude-fable-6'],
        installedBackends: ['claude'],
      })
    )

    expect(result.current.backendModelSections[0]?.options[0]).toEqual({
      value: 'claude-fable-6',
      label: 'claude-fable-6 (custom)',
    })
  })

  it('adds CDN models and reasoning metadata for non-Codex backends', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'grok',
        selectedProvider: null,
        selectedModel: 'grok/remote',
        customCliProfiles: [],
        installedBackends: ['grok'],
        grokModelOptions: [{ value: 'grok/local', label: 'Grok Local' }],
      })
    )

    expect(result.current.filteredModelOptions).toEqual([
      { value: 'grok/remote', label: 'Grok Remote' },
      { value: 'grok/local', label: 'Grok Local' },
    ])
    expect(result.current.selectedModelLabel).toBe('Remote')
    expect(result.current.selectedModelReasoning).toEqual({
      type: 'effort',
      default: 'max',
      levels: [{ value: 'max', label: 'Maximum' }],
    })
  })

  it('shows a short name for the Grok fast build model', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'grok',
        selectedProvider: null,
        selectedModel: 'grok/grok-4.7-build-fast',
        customCliProfiles: [],
        installedBackends: ['grok'],
        grokModelOptions: [
          {
            value: 'grok/grok-4.7-build-fast',
            label: 'grok/grok-4.7-build-fast',
          },
          { value: 'grok/future', label: 'Studio Grok' },
        ],
      })
    )

    expect(result.current.selectedModelLabel).toBe('4.7 Fast')
    expect(result.current.filteredModelOptions).toContainEqual({
      value: 'grok/grok-4.7-build-fast',
      label: 'Grok 4.7 Fast',
    })
    expect(result.current.filteredModelOptions).toContainEqual({
      value: 'grok/future',
      label: 'Studio Grok',
    })
  })

  it('keeps provider-specific Claude aliases instead of remote catalog options', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'claude',
        selectedProvider: 'custom',
        selectedModel: 'opus',
        customCliProfiles: [{ name: 'custom', settings_json: '{}' }],
        installedBackends: ['claude'],
      })
    )

    expect(
      result.current.claudeModelOptions.map(option => option.value)
    ).toEqual(['opus', 'sonnet', 'haiku'])
  })

  it('labels a full Claude id that a custom provider does not list', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'claude',
        selectedProvider: 'custom',
        selectedModel: 'claude-opus-5-5',
        customCliProfiles: [{ name: 'custom', settings_json: '{}' }],
        installedBackends: ['claude'],
      })
    )

    expect(result.current.selectedModelLabel).toBe('Opus 5.5')
  })

  it('exposes Kimi Code as an installed backend with its configured default', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'kimi',
        selectedProvider: null,
        selectedModel: 'kimi/default',
        customCliProfiles: [],
        installedBackends: ['kimi'],
        kimiModelOptions: [
          { value: 'kimi/default', label: 'Configured default' },
        ],
      })
    )

    expect(result.current.backendModelSections).toEqual([
      {
        backend: 'kimi',
        label: 'Kimi Code',
        options: [{ value: 'kimi/default', label: 'Configured default' }],
      },
    ])
    expect(result.current.selectedModelLabel).toBe('Configured default')
  })

  it('exposes Devin as an installed backend with its configured default', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'devin',
        selectedProvider: null,
        selectedModel: 'devin/default',
        customCliProfiles: [],
        installedBackends: ['devin'],
        devinModelOptions: [
          { value: 'devin/default', label: 'Configured default' },
        ],
      })
    )

    expect(result.current.backendModelSections).toEqual([
      {
        backend: 'devin',
        label: 'Devin (Beta)',
        options: [{ value: 'devin/default', label: 'Configured default' }],
      },
    ])
    expect(result.current.selectedModelLabel).toBe('Configured default')
    expect(result.current.isDevin).toBe(true)
  })

  it('exposes Antigravity as an installed backend with its static model options', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'antigravity',
        selectedProvider: null,
        selectedModel: 'antigravity/auto',
        customCliProfiles: [],
        installedBackends: ['antigravity'],
      })
    )

    expect(result.current.backendModelSections).toEqual([
      {
        backend: 'antigravity',
        label: 'Antigravity CLI (Beta)',
        options: ANTIGRAVITY_MODEL_OPTIONS,
      },
    ])
  })

  it('lists Muse models and labels the selected Muse model', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'muse',
        selectedProvider: null,
        selectedModel: 'muse/muse-spark-1.2',
        customCliProfiles: [],
        installedBackends: ['claude', 'muse'],
      })
    )

    expect(result.current.backendModelSections[1]).toEqual({
      backend: 'muse',
      label: 'Muse (Beta)',
      options: [
        { value: 'muse/default', label: 'Default' },
        { value: 'muse/muse-spark-1.2', label: 'Muse Spark 1.2' },
      ],
    })
    expect(result.current.selectedModelLabel).toBe('Muse Spark 1.2')
  })

  it('prefers CLI-reported Muse models over the static list', () => {
    const museModelOptions = [
      { value: 'muse/default', label: 'Default' },
      { value: 'muse/muse-spark-2', label: 'Muse Spark 2' },
    ]
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'muse',
        selectedProvider: null,
        selectedModel: 'muse/muse-spark-2',
        museModelOptions,
        customCliProfiles: [],
        installedBackends: ['muse'],
      })
    )

    expect(result.current.backendModelSections).toEqual([
      { backend: 'muse', label: 'Muse (Beta)', options: museModelOptions },
    ])
    expect(result.current.selectedModelLabel).toBe('Muse Spark 2')
  })

  it('counts enabled MCP servers identified by backend-prefixed keys', () => {
    const { result } = renderHook(() =>
      useToolbarDerivedState({
        selectedBackend: 'codex',
        selectedProvider: null,
        selectedModel: 'gpt-5.1-codex',
        customCliProfiles: [],
        availableMcpServers: [
          { name: 'jean', disabled: false, backend: 'codex' },
          { name: 'chrome_devtools', disabled: false, backend: 'codex' },
        ],
        enabledMcpServers: ['codex:jean', 'codex:chrome_devtools'],
      })
    )

    expect(result.current.activeMcpCount).toBe(2)
  })
})
