import { describe, expect, it, vi } from 'vitest'
import {
  MODEL_CATALOG_URL,
  clearCachedModelCatalog,
  fetchModelCatalog,
  getCatalogDefaultModelOptions,
  getCatalogModelFastInfo,
  getCatalogModelOptions,
  getCatalogModelReasoning,
  readCachedModelCatalog,
} from './model-catalog'

function createStorage() {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
  } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

describe('model catalog', () => {
  it('fetches the GitHub CDN catalog without HTTP cache and caches it', async () => {
    const storage = createStorage()
    const fetchImpl = vi.fn(
      async (
        url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        expect(String(url)).toBe(MODEL_CATALOG_URL)
        expect(init?.cache).toBe('no-store')
        return new Response(
          JSON.stringify({
            version: 1,
            updated_at: '2026-06-09T00:00:00Z',
            defaults: { claude: 'claude-fable-5', codex: 'gpt-5.5' },
            backends: {
              claude: {
                models: [
                  {
                    id: 'claude-fable-5',
                    label: 'Claude Fable 5',
                    supports_fast: false,
                  },
                ],
              },
              codex: {
                models: [
                  {
                    id: 'gpt-5.5',
                    label: 'GPT 5.5',
                    fast_id: 'gpt-5.5-fast',
                    supports_fast: true,
                  },
                ],
              },
            },
          }),
          { status: 200 }
        )
      }
    )

    const catalog = await fetchModelCatalog({ fetchImpl, storage })

    expect(getCatalogModelOptions(catalog, 'claude')).toEqual([
      { value: 'claude-fable-5', label: 'Claude Fable 5' },
    ])
    expect(getCatalogDefaultModelOptions(catalog, 'codex')).toEqual([
      { value: 'gpt-5.5', label: 'GPT 5.5' },
      { value: 'gpt-5.5-fast', label: 'GPT 5.5 Fast' },
    ])
    expect(getCatalogModelFastInfo(catalog, 'codex', 'gpt-5.5')).toEqual({
      supportsFast: true,
      isFast: false,
      baseModel: 'gpt-5.5',
      fastModel: 'gpt-5.5-fast',
    })
    expect(readCachedModelCatalog(storage)?.defaults.claude).toBe(
      'claude-fable-5'
    )
  })

  it('cache-busts the CDN URL when explicitly refreshing the catalog', async () => {
    const storage = createStorage()
    const fetchImpl = vi.fn(
      async (
        url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        const parsedUrl = new URL(String(url))
        expect(`${parsedUrl.origin}${parsedUrl.pathname}`).toBe(
          MODEL_CATALOG_URL
        )
        expect(parsedUrl.searchParams.get('t')).toMatch(/^\d+$/)
        expect(init?.cache).toBe('no-store')

        return new Response(
          JSON.stringify({
            version: 1,
            updated_at: '2026-06-10T00:00:00Z',
            defaults: { claude: 'claude-fresh' },
            backends: {
              claude: {
                models: [{ id: 'claude-fresh', label: 'Claude Fresh' }],
              },
            },
          }),
          { status: 200 }
        )
      }
    )

    const catalog = await fetchModelCatalog({
      fetchImpl,
      storage,
      cacheBust: true,
    })

    expect(getCatalogModelOptions(catalog, 'claude')).toEqual([
      { value: 'claude-fresh', label: 'Claude Fresh' },
    ])
  })

  it('returns the previously fetched catalog when the network fetch fails', async () => {
    const storage = createStorage()
    await fetchModelCatalog({
      storage,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              updated_at: '2026-06-09T00:00:00Z',
              defaults: { claude: 'claude-fable-5', codex: 'gpt-5.5' },
              backends: {
                claude: {
                  models: [{ id: 'claude-fable-5', label: 'Claude Fable 5' }],
                },
                codex: { models: [{ id: 'gpt-5.5', label: 'GPT 5.5' }] },
              },
            }),
            { status: 200 }
          )
      ),
    })

    const catalog = await fetchModelCatalog({
      storage,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    expect(getCatalogModelOptions(catalog, 'claude')[0]).toEqual({
      value: 'claude-fable-5',
      label: 'Claude Fable 5',
    })
  })

  it('falls back to bundled models when neither fetch nor cache is available', async () => {
    const storage = createStorage()
    clearCachedModelCatalog(storage)

    const catalog = await fetchModelCatalog({
      storage,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    expect(getCatalogModelOptions(catalog, 'claude')).toEqual(
      expect.arrayContaining([
        { value: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
        { value: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8 (1M)' },
      ])
    )
    expect(getCatalogModelOptions(catalog, 'codex')).toContainEqual({
      value: 'gpt-5.5',
      label: 'GPT 5.5',
    })
  })

  it('uses Codex native Ultra effort for bundled GPT 5.6 Sol and Terra', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra']) {
      const reasoning = getCatalogModelReasoning(null, 'codex', model)

      expect(reasoning?.default).toBe('medium')
      expect(reasoning?.levels.map(level => level.value)).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ])
    }
  })

  it('uses the documented effort levels for bundled GPT 6 Astra', () => {
    const reasoning = getCatalogModelReasoning(null, 'codex', 'gpt-6-astra')

    expect(reasoning?.default).toBe('medium')
    expect(reasoning?.levels.map(level => level.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
  })

  it('does not expose Ultra effort for bundled GPT 5.6 Luna', () => {
    const reasoning = getCatalogModelReasoning(
      null,
      'codex',
      'gpt-5.6-luna'
    )

    expect(reasoning?.default).toBe('medium')
    expect(reasoning?.levels.map(level => level.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('loads model reasoning capabilities and arbitrary levels from the CDN', async () => {
    const catalog = await fetchModelCatalog({
      storage: createStorage(),
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              updated_at: '2026-07-10T00:00:00Z',
              defaults: { codex: 'gpt-5.6-sol' },
              backends: {
                codex: {
                  models: [
                    {
                      id: 'gpt-5.6-sol',
                      label: 'GPT 5.6 Sol',
                      fast_id: 'gpt-5.6-sol-fast',
                      reasoning: {
                        type: 'effort',
                        default: 'medium',
                        levels: [
                          { value: 'low', label: 'Low' },
                          { value: 'medium', label: 'Medium' },
                          {
                            value: 'ultra',
                            label: 'Ultra',
                            description: 'Automatic delegation',
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            }),
            { status: 200 }
          )
      ),
    })

    expect(
      getCatalogModelReasoning(catalog, 'codex', 'gpt-5.6-sol-fast')
    ).toEqual({
      type: 'effort',
      default: 'medium',
      levels: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        {
          value: 'ultra',
          label: 'Ultra',
          description: 'Automatic delegation',
        },
      ],
    })
  })

  it('accepts catalog models and reasoning metadata for every Jean backend', async () => {
    const catalog = await fetchModelCatalog({
      storage: createStorage(),
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              updated_at: '2026-07-10T00:00:00Z',
              defaults: { grok: 'grok/future' },
              backends: {
                grok: {
                  models: [
                    {
                      id: 'grok/future',
                      label: 'Grok Future',
                      reasoning: {
                        type: 'effort',
                        default: 'medium',
                        levels: [{ value: 'medium', label: 'Medium' }],
                      },
                    },
                  ],
                },
              },
            }),
            { status: 200 }
          )
      ),
    })

    expect(getCatalogModelOptions(catalog, 'grok')).toEqual([
      { value: 'grok/future', label: 'Grok Future' },
    ])
    expect(getCatalogModelReasoning(catalog, 'grok', 'grok/future')?.type).toBe(
      'effort'
    )
  })

  it('ignores invalid reasoning metadata without rejecting the model', async () => {
    const catalog = await fetchModelCatalog({
      storage: createStorage(),
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              updated_at: '2026-07-10T00:00:00Z',
              defaults: { claude: 'claude-invalid' },
              backends: {
                claude: {
                  models: [
                    {
                      id: 'claude-invalid',
                      label: 'Claude Invalid',
                      reasoning: {
                        type: 'thinking',
                        default: 'missing',
                        levels: [{ value: 'think', label: 'Think' }],
                      },
                    },
                  ],
                },
              },
            }),
            { status: 200 }
          )
      ),
    })

    expect(getCatalogModelOptions(catalog, 'claude')).toContainEqual({
      value: 'claude-invalid',
      label: 'Claude Invalid',
    })
    expect(
      getCatalogModelReasoning(catalog, 'claude', 'claude-invalid')
    ).toBeUndefined()
  })
})
