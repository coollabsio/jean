import { useMemo } from 'react'
import type { CustomCliProfile } from '@/types/preferences'
import {
  buildUnifiedModelOptions,
  type ModelOption,
} from '@/components/chat/toolbar/toolbar-options'

interface UseToolbarDerivedStateArgs {
  selectedBackend: 'claude' | 'codex' | 'opencode'
  selectedProvider: string | null
  selectedModel: string
  opencodeModelOptions?: ModelOption[]
  installedBackends: ('claude' | 'codex' | 'opencode')[]
  customCliProfiles: CustomCliProfile[]
  availableMcpServers: { name: string; disabled?: boolean }[]
  enabledMcpServers: string[]
}

export function useToolbarDerivedState({
  selectedBackend,
  selectedProvider,
  selectedModel,
  opencodeModelOptions,
  installedBackends,
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
    return buildUnifiedModelOptions({
      installedBackends,
      selectedProvider,
      customCliProfiles,
      opencodeModelOptions,
    })
  }, [
    installedBackends,
    selectedProvider,
    customCliProfiles,
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
