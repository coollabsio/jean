import { useEffect } from 'react'

interface UseToolbarDropdownShortcutsArgs {
  setProviderDropdownOpen: (open: boolean) => void
  setModelDropdownOpen: (open: boolean) => void
  setThinkingDropdownOpen: (open: boolean) => void
}

export function useToolbarDropdownShortcuts({
  setProviderDropdownOpen,
  setModelDropdownOpen,
  setThinkingDropdownOpen,
}: UseToolbarDropdownShortcutsArgs) {
  useEffect(() => {
    const onProvider = () => setProviderDropdownOpen(true)
    const onModel = () => setModelDropdownOpen(true)
    const onThinking = () => setThinkingDropdownOpen(true)
    window.addEventListener('open-provider-dropdown', onProvider)
    window.addEventListener('open-model-dropdown', onModel)
    window.addEventListener('open-thinking-dropdown', onThinking)
    return () => {
      window.removeEventListener('open-provider-dropdown', onProvider)
      window.removeEventListener('open-model-dropdown', onModel)
      window.removeEventListener('open-thinking-dropdown', onThinking)
    }
  }, [setModelDropdownOpen, setProviderDropdownOpen, setThinkingDropdownOpen])
}
