import { useMemo } from 'react'
import type {
  ClaudeModel,
  CliBackend,
  CustomCliProfile,
} from '@/types/preferences'
import {
  CURSOR_MODEL_OPTIONS,
  COMMANDCODE_MODEL_OPTIONS,
  GROK_MODEL_OPTIONS,
  KIMI_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { sortModelOptionsByRawModel } from '@/components/chat/toolbar/toolbar-utils'
import {
  getCatalogModelFastInfo,
  getCatalogModelOptions,
  getCatalogModelReasoning,
  useModelCatalog,
} from '@/services/model-catalog'
import { resolvePiDefaultModel } from '@/lib/session-defaults'

interface UseToolbarDerivedStateArgs {
  selectedBackend: CliBackend
  selectedProvider: string | null
  selectedModel: string
  opencodeModelOptions?: { value: string; label: string }[]
  cursorModelOptions?: { value: string; label: string }[]
  piModelOptions?: { value: string; label: string }[]
  commandcodeModelOptions?: { value: string; label: string }[]
  grokModelOptions?: { value: string; label: string }[]
  kimiModelOptions?: { value: string; label: string }[]
  customCliProfiles: CustomCliProfile[]
  installedBackends?: CliBackend[]
  availableMcpServers?: { name: string; backend?: string; disabled?: boolean }[]
  enabledMcpServers?: string[]
}

function mergeCatalogOptions(
  catalog: Parameters<typeof getCatalogModelOptions>[0],
  backend: CliBackend,
  localOptions: { value: string; label: string }[]
) {
  const catalogOptions = getCatalogModelOptions(catalog, backend)
  const catalogIds = new Set(catalogOptions.map(option => option.value))
  return [
    ...catalogOptions,
    ...localOptions.filter(option => !catalogIds.has(option.value)),
  ]
}

export interface BackendModelSection {
  backend: CliBackend
  label: string
  options: { value: string; label: string }[]
}

export function buildBackendModelSections({
  installedBackends,
  claudeModelOptions,
  codexModelOptions,
  opencodeModelOptions,
  cursorModelOptions,
  piModelOptions,
  commandcodeModelOptions,
  grokModelOptions,
  kimiModelOptions,
}: {
  installedBackends: CliBackend[]
  claudeModelOptions: { value: string; label: string }[]
  codexModelOptions: { value: string; label: string }[]
  opencodeModelOptions: { value: string; label: string }[]
  cursorModelOptions: { value: string; label: string }[]
  piModelOptions?: { value: string; label: string }[]
  commandcodeModelOptions?: { value: string; label: string }[]
  grokModelOptions?: { value: string; label: string }[]
  kimiModelOptions?: { value: string; label: string }[]
}): BackendModelSection[] {
  const sections: BackendModelSection[] = []

  for (const backend of installedBackends) {
    if (backend === 'claude') {
      sections.push({ backend, label: 'Claude', options: claudeModelOptions })
    } else if (backend === 'codex') {
      sections.push({ backend, label: 'Codex', options: codexModelOptions })
    } else if (backend === 'opencode') {
      sections.push({
        backend,
        label: 'OpenCode',
        options: opencodeModelOptions,
      })
    } else if (backend === 'cursor') {
      sections.push({ backend, label: 'Cursor', options: cursorModelOptions })
    } else if (backend === 'pi') {
      sections.push({
        backend,
        label: 'PI',
        options: piModelOptions ?? PI_MODEL_OPTIONS,
      })
    } else if (backend === 'commandcode') {
      sections.push({
        backend,
        label: 'Command Code',
        options: commandcodeModelOptions ?? COMMANDCODE_MODEL_OPTIONS,
      })
    } else if (backend === 'grok') {
      sections.push({
        backend,
        label: 'Grok',
        options: grokModelOptions ?? GROK_MODEL_OPTIONS,
      })
    } else if (backend === 'kimi') {
      sections.push({
        backend,
        label: 'Kimi Code',
        options: kimiModelOptions ?? KIMI_MODEL_OPTIONS,
      })
    }
  }

  return sections
}

export function useToolbarDerivedState({
  selectedBackend,
  selectedProvider,
  selectedModel,
  opencodeModelOptions,
  cursorModelOptions,
  piModelOptions,
  commandcodeModelOptions,
  customCliProfiles,
  grokModelOptions,
  kimiModelOptions,
  installedBackends = [
    'claude',
    'codex',
    'opencode',
    'cursor',
    'pi',
    'commandcode',
    'grok',
    'kimi',
  ],
  availableMcpServers = [],
  enabledMcpServers = [],
}: UseToolbarDerivedStateArgs) {
  const isCodex = selectedBackend === 'codex'
  const isOpencode = selectedBackend === 'opencode'
  const isCursor = selectedBackend === 'cursor'
  const isPi = selectedBackend === 'pi'
  const isCommandCode = selectedBackend === 'commandcode'
  const isGrok = selectedBackend === 'grok'
  const isKimi = selectedBackend === 'kimi'

  const { data: modelCatalog } = useModelCatalog()

  const activeMcpCount = useMemo(() => {
    const availableNames = new Set<string>()
    for (const server of availableMcpServers) {
      if (server.disabled) continue
      availableNames.add(server.name)
      availableNames.add(`${server.backend || 'claude'}:${server.name}`)
    }
    return enabledMcpServers.filter(name => availableNames.has(name)).length
  }, [availableMcpServers, enabledMcpServers])

  const claudeModelOptions = useMemo(() => {
    if (!selectedProvider || selectedProvider === '__anthropic__') {
      return getCatalogModelOptions(modelCatalog, 'claude').map(option => ({
        ...option,
        label: option.label.replace(/^Claude\s+/, ''),
      }))
    }

    const profile = customCliProfiles.find(p => p.name === selectedProvider)
    let opusModel: string | undefined
    let sonnetModel: string | undefined
    let haikuModel: string | undefined
    if (profile?.settings_json) {
      try {
        const settings = JSON.parse(profile.settings_json)
        const env = settings?.env
        if (env) {
          opusModel = env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL
          sonnetModel =
            env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL
          haikuModel = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL
        }
      } catch {
        // ignore parse errors
      }
    }

    const suffix = (model?: string) => (model ? ` (${model})` : '')
    return [
      { value: 'opus' as ClaudeModel, label: `Opus${suffix(opusModel)}` },
      { value: 'sonnet' as ClaudeModel, label: `Sonnet${suffix(sonnetModel)}` },
      { value: 'haiku' as ClaudeModel, label: `Haiku${suffix(haikuModel)}` },
    ]
  }, [selectedProvider, customCliProfiles, modelCatalog])

  const codexModelOptions = sortModelOptionsByRawModel(
    getCatalogModelOptions(modelCatalog, 'codex')
  )
  const resolvedOpencodeModelOptions = sortModelOptionsByRawModel(
    mergeCatalogOptions(
      modelCatalog,
      'opencode',
      opencodeModelOptions ?? OPENCODE_MODEL_OPTIONS
    )
  )
  const resolvedCursorModelOptions = sortModelOptionsByRawModel(
    mergeCatalogOptions(
      modelCatalog,
      'cursor',
      cursorModelOptions ?? CURSOR_MODEL_OPTIONS
    )
  )
  const resolvedPiModelOptions = sortModelOptionsByRawModel(
    mergeCatalogOptions(modelCatalog, 'pi', piModelOptions ?? PI_MODEL_OPTIONS)
  )
  const resolvedCommandCodeModelOptions = mergeCatalogOptions(
    modelCatalog,
    'commandcode',
    commandcodeModelOptions ?? COMMANDCODE_MODEL_OPTIONS
  )
  const resolvedGrokModelOptions = mergeCatalogOptions(
    modelCatalog,
    'grok',
    grokModelOptions ?? GROK_MODEL_OPTIONS
  )
  const resolvedKimiModelOptions = mergeCatalogOptions(
    modelCatalog,
    'kimi',
    kimiModelOptions ?? KIMI_MODEL_OPTIONS
  )

  const backendModelSections = useMemo(
    () =>
      buildBackendModelSections({
        installedBackends,
        claudeModelOptions,
        codexModelOptions,
        opencodeModelOptions: resolvedOpencodeModelOptions,
        cursorModelOptions: resolvedCursorModelOptions,
        piModelOptions: resolvedPiModelOptions,
        commandcodeModelOptions: resolvedCommandCodeModelOptions,
        grokModelOptions: resolvedGrokModelOptions,
        kimiModelOptions: resolvedKimiModelOptions,
      }),
    [
      claudeModelOptions,
      codexModelOptions,
      installedBackends,
      resolvedCursorModelOptions,
      resolvedCommandCodeModelOptions,
      resolvedGrokModelOptions,
      resolvedKimiModelOptions,
      resolvedOpencodeModelOptions,
      resolvedPiModelOptions,
    ]
  )

  const filteredModelOptions = useMemo(() => {
    if (isCodex) return codexModelOptions
    if (isOpencode) return resolvedOpencodeModelOptions
    if (isCursor) return resolvedCursorModelOptions
    if (isPi) return resolvedPiModelOptions
    if (isCommandCode) return resolvedCommandCodeModelOptions
    if (isGrok) return resolvedGrokModelOptions
    if (isKimi) return resolvedKimiModelOptions
    return claudeModelOptions
  }, [
    claudeModelOptions,
    codexModelOptions,
    isCodex,
    isCursor,
    isPi,
    isCommandCode,
    isGrok,
    isKimi,
    isOpencode,
    resolvedCommandCodeModelOptions,
    resolvedCursorModelOptions,
    resolvedGrokModelOptions,
    resolvedKimiModelOptions,
    resolvedOpencodeModelOptions,
    resolvedPiModelOptions,
  ])

  // Fast variants share a label with their base model (the Zap indicator
  // distinguishes them visually). Applies to both Codex and Claude.
  const effectiveSelectedModel = isPi
    ? resolvePiDefaultModel(selectedModel, resolvedPiModelOptions)
    : selectedModel

  const fastInfo = getCatalogModelFastInfo(
    modelCatalog,
    selectedBackend,
    effectiveSelectedModel
  )
  const labelLookupKey = fastInfo.isFast
    ? fastInfo.baseModel
    : effectiveSelectedModel

  const selectedModelLabel =
    filteredModelOptions.find(o => o.value === labelLookupKey)?.label ??
    labelLookupKey
  const selectedModelReasoning = getCatalogModelReasoning(
    modelCatalog,
    selectedBackend,
    effectiveSelectedModel
  )

  return {
    isCodex,
    isCursor,
    isPi,
    isCommandCode,
    isOpencode,
    activeMcpCount,
    backendModelSections,
    claudeModelOptions,
    cursorModelOptions: resolvedCursorModelOptions,
    commandcodeModelOptions: resolvedCommandCodeModelOptions,
    filteredModelOptions,
    opencodeModelOptions: resolvedOpencodeModelOptions,
    piModelOptions: resolvedPiModelOptions,
    grokModelOptions: resolvedGrokModelOptions,
    kimiModelOptions: resolvedKimiModelOptions,
    isGrok,
    isKimi,
    selectedModelLabel,
    selectedModelReasoning,
  }
}
