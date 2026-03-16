import { useEffect, useRef } from 'react'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import {
  CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
} from '@/types/preferences'

/**
 * One-time auto-detection: if magic prompt models haven't been initialized yet,
 * detect installed backends and apply the appropriate defaults.
 * Runs once per app lifetime (guarded by magic_models_auto_initialized flag).
 */
export function useMagicPromptAutoDefaults() {
  const { data: preferences } = usePreferences()
  const { installedBackends, isLoading } = useInstalledBackends()
  const patchPreferences = usePatchPreferences()
  const didRun = useRef(false)

  useEffect(() => {
    if (!preferences || isLoading || didRun.current) return
    if (preferences.magic_models_auto_initialized) return
    didRun.current = true

    const hasClaude = installedBackends.includes('claude')
    const hasCodex = installedBackends.includes('codex')
    const hasOpencode = installedBackends.includes('opencode')

    // If claude is installed (or nothing detected yet), keep Claude defaults
    if (hasClaude || installedBackends.length === 0) {
      patchPreferences.mutate({ magic_models_auto_initialized: true })
      return
    }

    // Only non-Claude backends installed — pick the first one
    if (hasCodex) {
      patchPreferences.mutate({
        magic_prompt_models: CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_backends: CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_models_auto_initialized: true,
      })
    } else if (hasOpencode) {
      patchPreferences.mutate({
        magic_prompt_models: OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
        magic_prompt_backends: OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
        magic_models_auto_initialized: true,
      })
    }
  }, [preferences, installedBackends, isLoading, patchPreferences])
}
