import { useMemo } from 'react'
import type { CliBackend, CustomCliProfile } from '@/types/preferences'
import { usePreferences } from '@/services/preferences'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { useAvailableCursorModels } from '@/services/cursor-cli'
import { useAvailablePiModels } from '@/services/pi-cli'
import { useAvailableCommandCodeModels } from '@/services/commandcode-cli'
import { useAvailableGrokModels } from '@/services/grok-cli'
import { useAvailableKimiModels } from '@/services/kimi-cli'
import { useAvailableDevinModels } from '@/services/devin-cli'
import { useAvailableAntigravityModels } from '@/services/antigravity-cli'
import { useAvailableMuseModels } from '@/services/muse-cli'
import {
  formatCursorModelLabel,
  formatOpencodeModelLabel,
  formatPiModelLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import { useToolbarDerivedState } from '@/components/chat/toolbar/useToolbarDerivedState'

/**
 * Model options per installed backend, from the same sources as the toolbar
 * picker (CLI-reported models, catalog, static fallbacks).
 */
export function useBackendModelSections({
  selectedBackend,
  selectedProvider,
  selectedModel,
  installedBackends,
  customCliProfiles,
}: {
  selectedBackend: CliBackend
  selectedProvider: string | null
  selectedModel: string
  installedBackends: CliBackend[]
  customCliProfiles: CustomCliProfile[]
}) {
  const { data: prefs } = usePreferences()

  const { data: availableOpencodeModels, isError: opencodeModelsError } =
    useAvailableOpencodeModels({
      enabled: installedBackends.includes('opencode'),
    })
  const { data: availableCursorModels } = useAvailableCursorModels({
    enabled: installedBackends.includes('cursor'),
  })
  const { data: availablePiModels } = useAvailablePiModels({
    enabled: installedBackends.includes('pi'),
  })
  const { data: availableCommandCodeModels } = useAvailableCommandCodeModels({
    enabled: installedBackends.includes('commandcode'),
  })
  const { data: availableGrokModels } = useAvailableGrokModels({
    enabled: installedBackends.includes('grok'),
  })
  const { data: availableKimiModels } = useAvailableKimiModels({
    enabled: installedBackends.includes('kimi'),
  })
  const { data: availableDevinModels } = useAvailableDevinModels({
    enabled: installedBackends.includes('devin'),
  })
  const { data: availableAntigravityModels } = useAvailableAntigravityModels({
    enabled: installedBackends.includes('antigravity'),
  })
  const { data: availableMuseModels } = useAvailableMuseModels({
    enabled: installedBackends.includes('muse'),
  })

  const opencodeModelOptions = useMemo(() => {
    if (opencodeModelsError) return []
    return availableOpencodeModels?.map(model => ({
      value: model,
      label: formatOpencodeModelLabel(model),
    }))
  }, [availableOpencodeModels, opencodeModelsError])
  const cursorModelOptions = useMemo(
    () =>
      availableCursorModels?.length
        ? availableCursorModels.map(model => ({
            value: `cursor/${model.id}`,
            label: model.label || formatCursorModelLabel(model.id),
          }))
        : undefined,
    [availableCursorModels]
  )
  const piModelOptions = useMemo(
    () =>
      availablePiModels?.map(model => ({
        value: `pi/${model.id}`,
        label: model.label || formatPiModelLabel(model.id),
        is_default: model.is_default,
      })),
    [availablePiModels]
  )
  const commandcodeModelOptions = useMemo(
    () =>
      availableCommandCodeModels?.map(model => ({
        value: `commandcode/${model.id}`,
        label: model.label,
      })),
    [availableCommandCodeModels]
  )
  const grokModelOptions = useMemo(
    () =>
      availableGrokModels?.map(model => ({
        value: `grok/${model.id}`,
        label: model.label,
      })),
    [availableGrokModels]
  )
  const kimiModelOptions = useMemo(
    () =>
      availableKimiModels?.map(model => ({
        value: `kimi/${model.id}`,
        label: model.label,
      })),
    [availableKimiModels]
  )
  const devinModelOptions = useMemo(
    () =>
      availableDevinModels?.map(model => ({
        value: `devin/${model.id}`,
        label: model.label,
      })),
    [availableDevinModels]
  )
  const antigravityModelOptions = useMemo(
    () =>
      availableAntigravityModels?.map(model => ({
        value: `antigravity/${model.id}`,
        label: model.label,
      })),
    [availableAntigravityModels]
  )
  const museModelOptions = useMemo(
    () =>
      availableMuseModels?.map(model => ({
        value: model.id,
        label: model.label,
      })),
    [availableMuseModels]
  )

  const { backendModelSections: baseBackendModelSections } =
    useToolbarDerivedState({
      selectedBackend,
      selectedProvider,
      selectedModel,
      opencodeModelOptions,
      cursorModelOptions,
      piModelOptions,
      commandcodeModelOptions,
      grokModelOptions,
      kimiModelOptions,
      museModelOptions,
      devinModelOptions,
      customCliProfiles,
      customClaudeModels: prefs?.custom_claude_models,
      installedBackends,
    })

  const backendModelSections = useMemo(() => {
    let sections = baseBackendModelSections
    // useToolbarDerivedState only knows the static Antigravity fallback list;
    // surface CLI-reported models first and keep static entries as fallbacks.
    if (antigravityModelOptions?.length) {
      const dynamicValues = new Set(
        antigravityModelOptions.map(option => option.value)
      )
      sections = sections.map(section =>
        section.backend === 'antigravity'
          ? {
              ...section,
              options: [
                ...antigravityModelOptions,
                ...section.options.filter(
                  option => !dynamicValues.has(option.value)
                ),
              ],
            }
          : section
      )
    }
    return sections
  }, [antigravityModelOptions, baseBackendModelSections])

  return backendModelSections
}
