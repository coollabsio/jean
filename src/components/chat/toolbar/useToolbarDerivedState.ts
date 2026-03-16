import { useMemo } from 'react'
import type { ClaudeModel, CustomCliProfile } from '@/types/preferences'
import {
  CODEX_MODEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'

interface UseToolbarDerivedStateArgs {
  selectedBackend: 'claude' | 'codex' | 'opencode'
  selectedProvider: string | null
  selectedModel: string
  opencodeModelOptions?: { value: string; label: string }[]
  customCliProfiles: CustomCliProfile[]
  availableMcpServers: { name: string; disabled?: boolean }[]
  enabledMcpServers: string[]
}

export function useToolbarDerivedState({
  selectedBackend,
  selectedProvider,
  selectedModel,
  opencodeModelOptions,
  customCliProfiles,
  availableMcpServers,
  enabledMcpServers,
}: UseToolbarDerivedStateArgs) {
  const isCodex = selectedBackend === 'codex'
  const isOpencode = selectedBackend === 'opencode'

  const activeMcpCount = useMemo(() => {
    const availableNames = new Set(
      availableMcpServers.filter(s => !s.disabled).map(s => s.name)
    )
    return enabledMcpServers.filter(name => availableNames.has(name)).length
  }, [availableMcpServers, enabledMcpServers])

  const filteredModelOptions = useMemo(() => {
    if (isCodex)
      return CODEX_MODEL_OPTIONS as { value: string; label: string }[]
    if (isOpencode) return opencodeModelOptions ?? OPENCODE_MODEL_OPTIONS
    if (!selectedProvider || selectedProvider === '__anthropic__') {
      return MODEL_OPTIONS
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
  }, [
    selectedProvider,
    customCliProfiles,
    isCodex,
    isOpencode,
    opencodeModelOptions,
  ])

  const selectedModelLabel =
    filteredModelOptions.find(o => o.value === selectedModel)?.label ??
    selectedModel

  return {
    isCodex,
    isOpencode,
    activeMcpCount,
    filteredModelOptions,
    selectedModelLabel,
  }
}
