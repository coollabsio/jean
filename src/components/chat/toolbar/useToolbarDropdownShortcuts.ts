import { useEffect } from 'react'

interface UseToolbarDropdownShortcutsArgs {
  enabled?: boolean
  setProviderDropdownOpen?: (open: boolean) => void
  setModelDropdownOpen?: (open: boolean) => void
  setThinkingDropdownOpen?: (open: boolean) => void
}

export function useToolbarDropdownShortcuts({
  enabled = true,
  setProviderDropdownOpen,
  setModelDropdownOpen,
  setThinkingDropdownOpen,
}: UseToolbarDropdownShortcutsArgs) {
  useEffect(() => {
    if (!enabled) return

    const onProvider = setProviderDropdownOpen
      ? () => setProviderDropdownOpen(true)
      : null
    const onModel = setModelDropdownOpen
      ? () => setModelDropdownOpen(true)
      : null
    const onThinking = setThinkingDropdownOpen
      ? () => setThinkingDropdownOpen(true)
      : null

    if (onProvider) {
      window.addEventListener('open-provider-dropdown', onProvider)
    }
    if (onModel) {
      window.addEventListener('open-model-dropdown', onModel)
    }
    if (onThinking) {
      window.addEventListener('open-thinking-dropdown', onThinking)
    }

    return () => {
      if (onProvider) {
        window.removeEventListener('open-provider-dropdown', onProvider)
      }
      if (onModel) {
        window.removeEventListener('open-model-dropdown', onModel)
      }
      if (onThinking) {
        window.removeEventListener('open-thinking-dropdown', onThinking)
      }
    }
  }, [
    enabled,
    setModelDropdownOpen,
    setProviderDropdownOpen,
    setThinkingDropdownOpen,
  ])
}
