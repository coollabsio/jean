import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  codexModelOptions,
  getModelFastInfo,
  modelOptions,
  type CliBackend,
} from '@/types/preferences'

export const MODEL_CATALOG_URL =
  'https://raw.githubusercontent.com/coollabsio/coollabs-cdn/main/json/jean/models.json'

const MODEL_CATALOG_CACHE_KEY = 'jean:model-catalog:v1'
const MODEL_CATALOG_REFRESH_MS = 1000 * 60 * 60
const MODEL_CATALOG_TIMEOUT_MS = 8000

type CatalogBackend = CliBackend

export interface ModelReasoningLevel {
  value: string
  label: string
  description?: string
}

export interface ModelReasoningCapability {
  type: 'effort' | 'thinking'
  default: string
  levels: ModelReasoningLevel[]
}

export interface ModelCatalogModel {
  id: string
  label: string
  fast_id?: string
  supports_fast?: boolean
  supports_images?: boolean
  supports_thinking?: boolean
  reasoning?: ModelReasoningCapability | null
  recommended?: boolean
  deprecated?: boolean
  hidden?: boolean
}

export interface ModelCatalogBackend {
  models: ModelCatalogModel[]
}

export interface ModelCatalog {
  version: 1
  updated_at: string
  defaults: Partial<Record<CatalogBackend, string>>
  backends: Partial<Record<CatalogBackend, ModelCatalogBackend>>
}

interface CachedModelCatalog {
  fetched_at: string
  catalog: ModelCatalog
}

interface FetchModelCatalogOptions {
  fetchImpl?: typeof fetch
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  cacheBust?: boolean
}

export const modelCatalogQueryKeys = {
  all: ['model-catalog'] as const,
}

const THINKING_LEVELS: ModelReasoningLevel[] = [
  { value: 'off', label: 'Off', description: 'Disabled' },
  { value: 'think', label: 'Think', description: '4K' },
  { value: 'megathink', label: 'Megathink', description: '10K' },
  { value: 'ultrathink', label: 'Ultrathink', description: '32K' },
]

const STANDARD_EFFORT_LEVELS: ModelReasoningLevel[] = [
  { value: 'low', label: 'Low', description: 'Light' },
  { value: 'medium', label: 'Medium', description: 'Moderate' },
  { value: 'high', label: 'High', description: 'Deep' },
  { value: 'xhigh', label: 'Extra high', description: 'Extra deep' },
]

const BASIC_EFFORT_LEVELS = STANDARD_EFFORT_LEVELS.filter(
  level => level.value !== 'xhigh'
)

const GPT_5_6_EFFORT_LEVELS: ModelReasoningLevel[] = [
  { value: 'low', label: 'Low', description: 'Fast responses' },
  { value: 'medium', label: 'Medium', description: 'Balanced' },
  { value: 'high', label: 'High', description: 'Greater depth' },
  { value: 'xhigh', label: 'Extra high', description: 'Complex problems' },
  { value: 'max', label: 'Max', description: 'Maximum depth' },
  {
    value: 'ultra',
    label: 'Ultra',
    description: 'Automatic delegation',
  },
]

const GPT_5_6_LUNA_EFFORT_LEVELS = GPT_5_6_EFFORT_LEVELS.filter(
  level => level.value !== 'ultra'
)

const CLAUDE_EFFORT_LEVELS: ModelReasoningLevel[] = [
  ...STANDARD_EFFORT_LEVELS,
  { value: 'max', label: 'Max', description: 'No limits' },
  {
    value: 'ultracode',
    label: 'Ultracode',
    description: 'Extra high + workflows',
  },
]

function getBundledReasoning(
  backend: CatalogBackend,
  model: string
): ModelReasoningCapability | undefined {
  if (backend === 'codex') {
    const isGpt56 = model.startsWith('gpt-5.6')
    const levels = isGpt56
      ? model.includes('luna')
        ? GPT_5_6_LUNA_EFFORT_LEVELS
        : GPT_5_6_EFFORT_LEVELS
      : STANDARD_EFFORT_LEVELS
    return {
      type: 'effort',
      default: isGpt56 ? 'medium' : 'high',
      levels,
    }
  }

  if (backend !== 'claude' || model === 'haiku') return undefined
  const usesEffort =
    model.includes('fable-5') ||
    model.includes('sonnet-5') ||
    model.includes('opus-4-8') ||
    model.includes('opus-4-7') ||
    model.includes('opus-4-6') ||
    model.includes('sonnet-4-6') ||
    model.includes('opus-4-5')
  if (!usesEffort) {
    return { type: 'thinking', default: 'ultrathink', levels: THINKING_LEVELS }
  }
  const levels = model.includes('4-6')
    ? [
        ...BASIC_EFFORT_LEVELS,
        { value: 'max', label: 'Max', description: 'No limits' },
      ]
    : model.includes('opus-4-5')
      ? BASIC_EFFORT_LEVELS
      : CLAUDE_EFFORT_LEVELS
  return { type: 'effort', default: 'high', levels }
}

function fastMetadataFor(backend: CatalogBackend, model: string) {
  const info = getModelFastInfo(backend, model)
  return info.supportsFast && info.fastModel
    ? { supports_fast: true, fast_id: info.fastModel }
    : { supports_fast: false }
}

const fallbackModelCatalog: ModelCatalog = {
  version: 1,
  updated_at: 'bundled',
  defaults: {
    claude: 'claude-opus-4-8[1m]',
    codex: 'gpt-5.6-sol',
    opencode: 'opencode/gpt-5.6-sol',
    grok: 'grok/grok-4.5',
  },
  backends: {
    claude: {
      models: modelOptions.map(option => ({
        id: option.value,
        label: option.label,
        ...fastMetadataFor('claude', option.value),
        reasoning: getBundledReasoning('claude', option.value),
      })),
    },
    codex: {
      models: codexModelOptions.map(option => ({
        id: option.value,
        label: option.label,
        ...fastMetadataFor('codex', option.value),
        reasoning: getBundledReasoning('codex', option.value),
      })),
    },
  },
}

function getDefaultStorage() {
  if (typeof window === 'undefined') return undefined
  return window.localStorage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReasoning(
  value: unknown
): ModelReasoningCapability | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (value.type !== 'effort' && value.type !== 'thinking') return undefined
  if (typeof value.default !== 'string' || !Array.isArray(value.levels)) {
    return undefined
  }

  const seen = new Set<string>()
  const levels: ModelReasoningLevel[] = []
  for (const level of value.levels) {
    if (!isRecord(level)) return undefined
    if (
      typeof level.value !== 'string' ||
      !level.value.trim() ||
      typeof level.label !== 'string' ||
      !level.label.trim() ||
      seen.has(level.value)
    ) {
      return undefined
    }
    seen.add(level.value)
    levels.push({
      value: level.value,
      label: level.label,
      ...(typeof level.description === 'string'
        ? { description: level.description }
        : {}),
    })
  }
  if (!levels.length || !seen.has(value.default)) return undefined
  return { type: value.type, default: value.default, levels }
}

function parseModelCatalog(value: unknown): ModelCatalog | null {
  if (!isRecord(value)) return null
  if (value.version !== 1) return null
  if (typeof value.updated_at !== 'string') return null
  if (!isRecord(value.backends)) return null
  if (!isRecord(value.defaults)) return null

  const backends: Partial<Record<CatalogBackend, ModelCatalogBackend>> = {}
  for (const backend of [
    'claude',
    'codex',
    'opencode',
    'cursor',
    'pi',
    'commandcode',
    'grok',
  ] as const) {
    const rawBackend = value.backends[backend]
    if (!isRecord(rawBackend)) continue
    const rawModels = rawBackend.models
    if (!Array.isArray(rawModels)) continue
    const models = rawModels.flatMap(model => {
      if (!isRecord(model)) return []
      if (typeof model.id !== 'string' || typeof model.label !== 'string') {
        return []
      }
      const parsed: ModelCatalogModel = {
        id: model.id,
        label: model.label,
      }
      if (typeof model.fast_id === 'string') parsed.fast_id = model.fast_id
      if (typeof model.supports_fast === 'boolean') {
        parsed.supports_fast = model.supports_fast
      }
      if (typeof model.supports_images === 'boolean') {
        parsed.supports_images = model.supports_images
      }
      if (typeof model.supports_thinking === 'boolean') {
        parsed.supports_thinking = model.supports_thinking
      }
      if ('reasoning' in model) {
        const reasoning = parseReasoning(model.reasoning)
        if (reasoning !== undefined) parsed.reasoning = reasoning
      }
      if (typeof model.recommended === 'boolean') {
        parsed.recommended = model.recommended
      }
      if (typeof model.deprecated === 'boolean')
        parsed.deprecated = model.deprecated
      if (typeof model.hidden === 'boolean') parsed.hidden = model.hidden
      return [parsed]
    })
    if (models.length > 0) backends[backend] = { models }
  }

  const defaults: Partial<Record<CatalogBackend, string>> = {}
  for (const backend of [
    'claude',
    'codex',
    'opencode',
    'cursor',
    'pi',
    'commandcode',
    'grok',
  ] as const) {
    const rawDefault = value.defaults[backend]
    if (typeof rawDefault === 'string') defaults[backend] = rawDefault
  }

  return {
    version: 1,
    updated_at: value.updated_at,
    defaults,
    backends,
  }
}

function cacheModelCatalog(
  catalog: ModelCatalog,
  storage?: Pick<Storage, 'setItem'>
) {
  if (!storage) return
  const cached: CachedModelCatalog = {
    fetched_at: new Date().toISOString(),
    catalog,
  }
  storage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify(cached))
}

export function readCachedModelCatalog(
  storage: Pick<Storage, 'getItem'> | undefined = getDefaultStorage()
): ModelCatalog | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(MODEL_CATALOG_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return null
    return parseModelCatalog(parsed.catalog)
  } catch {
    return null
  }
}

export function clearCachedModelCatalog(
  storage: Pick<Storage, 'removeItem'> | undefined = getDefaultStorage()
) {
  storage?.removeItem(MODEL_CATALOG_CACHE_KEY)
}

function getModelCatalogUrl(cacheBust: boolean): string {
  if (!cacheBust) return MODEL_CATALOG_URL
  const separator = MODEL_CATALOG_URL.includes('?') ? '&' : '?'
  return `${MODEL_CATALOG_URL}${separator}t=${Date.now()}`
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  cacheBust: boolean
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_TIMEOUT_MS)
  try {
    return await fetchImpl(getModelCatalogUrl(cacheBust), {
      signal: controller.signal,
      cache: 'no-store',
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchModelCatalog({
  fetchImpl = fetch,
  storage = getDefaultStorage(),
  cacheBust = false,
}: FetchModelCatalogOptions = {}): Promise<ModelCatalog> {
  try {
    const response = await fetchWithTimeout(fetchImpl, cacheBust)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed = parseModelCatalog(await response.json())
    if (!parsed) throw new Error('Invalid model catalog')
    cacheModelCatalog(parsed, storage)
    return parsed
  } catch {
    return readCachedModelCatalog(storage) ?? fallbackModelCatalog
  }
}

export function refreshModelCatalog(
  options: Omit<FetchModelCatalogOptions, 'cacheBust'> = {}
): Promise<ModelCatalog> {
  return fetchModelCatalog({ ...options, cacheBust: true })
}

export function useModelCatalog() {
  return useQuery({
    queryKey: modelCatalogQueryKeys.all,
    queryFn: () => fetchModelCatalog(),
    staleTime: MODEL_CATALOG_REFRESH_MS,
    refetchInterval: MODEL_CATALOG_REFRESH_MS,
    refetchOnWindowFocus: false,
  })
}

export function useRefreshModelCatalog() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => refreshModelCatalog(),
    onSuccess: catalog => {
      queryClient.setQueryData(modelCatalogQueryKeys.all, catalog)
    },
  })
}

export function getCatalogModelOptions(
  catalog: ModelCatalog | null | undefined,
  backend: CatalogBackend
): { value: string; label: string }[] {
  const source = catalog ?? fallbackModelCatalog
  const models = source.backends[backend]?.models
  if (!models?.length) {
    return source === fallbackModelCatalog
      ? []
      : getCatalogModelOptions(fallbackModelCatalog, backend)
  }
  return models
    .filter(model => !model.hidden)
    .map(model => ({ value: model.id, label: model.label }))
}

export function getCatalogDefaultModelOptions(
  catalog: ModelCatalog | null | undefined,
  backend: CatalogBackend
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = []
  const source = catalog ?? fallbackModelCatalog
  const models = source.backends[backend]?.models
  if (!models?.length) {
    return source === fallbackModelCatalog
      ? []
      : getCatalogDefaultModelOptions(fallbackModelCatalog, backend)
  }

  for (const model of models) {
    if (model.hidden) continue
    options.push({ value: model.id, label: model.label })
    if (model.fast_id) {
      options.push({
        value: model.fast_id,
        label: `${model.label} Fast`,
      })
    }
  }

  return options
}

export function getCatalogModelFastInfo(
  catalog: ModelCatalog | null | undefined,
  backend: CatalogBackend | CliBackend,
  model: string
) {
  const source = catalog ?? fallbackModelCatalog
  const models = source.backends[backend]?.models ?? []
  const base = models.find(entry => entry.id === model)
  if (base) {
    if (base.fast_id || base.supports_fast) {
      return {
        supportsFast: true,
        isFast: false,
        baseModel: base.id,
        fastModel: base.fast_id,
      }
    }
    return { supportsFast: false, isFast: false, baseModel: model }
  }

  const fastBase = models.find(entry => entry.fast_id === model)
  if (fastBase) {
    return {
      supportsFast: true,
      isFast: true,
      baseModel: fastBase.id,
      fastModel: model,
    }
  }

  return getModelFastInfo(backend, model)
}

export function getCatalogModelReasoning(
  catalog: ModelCatalog | null | undefined,
  backend: CatalogBackend,
  model: string
): ModelReasoningCapability | null | undefined {
  const find = (source: ModelCatalog) => {
    const models = source.backends[backend]?.models ?? []
    return models.find(entry => entry.id === model || entry.fast_id === model)
  }
  const remoteModel = catalog ? find(catalog) : undefined
  if (remoteModel && 'reasoning' in remoteModel) {
    return remoteModel.reasoning ?? null
  }
  return find(fallbackModelCatalog)?.reasoning ?? undefined
}
