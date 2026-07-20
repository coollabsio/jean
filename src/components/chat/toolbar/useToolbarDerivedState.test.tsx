import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type * as ModelCatalogService from '@/services/model-catalog'
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

    expect(result.current.backendModelSections).toEqual([
      {
        backend: 'claude',
        label: 'Claude',
        options: [{ value: 'claude-remote', label: 'Remote' }],
      },
      {
        backend: 'codex',
        label: 'Codex',
        options: [{ value: 'gpt-remote', label: 'GPT Remote' }],
      },
    ])
    expect(result.current.selectedModelLabel).toBe('Remote')
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
    expect(result.current.selectedModelReasoning).toEqual({
      type: 'effort',
      default: 'max',
      levels: [{ value: 'max', label: 'Maximum' }],
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
