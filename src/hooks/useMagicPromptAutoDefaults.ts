import { useEffect, useRef } from 'react'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  useBackendAuthStatuses,
  useInstalledBackends,
} from '@/hooks/useInstalledBackends'
import {
  CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
  OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  PI_DEFAULT_MAGIC_PROMPT_MODELS,
  PI_DEFAULT_MAGIC_PROMPT_BACKENDS,
  COMMANDCODE_DEFAULT_MAGIC_PROMPT_MODELS,
  COMMANDCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  GROK_DEFAULT_MAGIC_PROMPT_MODELS,
  GROK_DEFAULT_MAGIC_PROMPT_BACKENDS,
  KIMI_DEFAULT_MAGIC_PROMPT_MODELS,
  KIMI_DEFAULT_MAGIC_PROMPT_BACKENDS,
  ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_MODELS,
  ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_BACKENDS,
  DEFAULT_MAGIC_PROMPT_MODELS,
  DEFAULT_MAGIC_PROMPT_BACKENDS,
  type CliBackend,
  type MagicPromptBackends,
  type MagicPromptModels,
} from '@/types/preferences'

const MAGIC_DEFAULTS: Partial<
  Record<
    CliBackend,
    { models: MagicPromptModels; backends: MagicPromptBackends }
  >
> = {
  codex: {
    models: CODEX_DEFAULT_MAGIC_PROMPT_MODELS,
    backends: CODEX_DEFAULT_MAGIC_PROMPT_BACKENDS,
  },
  opencode: {
    models: OPENCODE_DEFAULT_MAGIC_PROMPT_MODELS,
    backends: OPENCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  },
  pi: {
    models: PI_DEFAULT_MAGIC_PROMPT_MODELS,
    backends: PI_DEFAULT_MAGIC_PROMPT_BACKENDS,
  },
  commandcode: {
    models: COMMANDCODE_DEFAULT_MAGIC_PROMPT_MODELS,
    backends: COMMANDCODE_DEFAULT_MAGIC_PROMPT_BACKENDS,
  },
  grok: {
    models: GROK_DEFAULT_MAGIC_PROMPT_MODELS,
    backends: GROK_DEFAULT_MAGIC_PROMPT_BACKENDS,
  },
  kimi: {
    models: KIMI_DEFAULT_MAGIC_PROMPT_MODELS,
    backends: KIMI_DEFAULT_MAGIC_PROMPT_BACKENDS,
  },
  antigravity: {
    models: ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_MODELS,
    backends: ANTIGRAVITY_DEFAULT_MAGIC_PROMPT_BACKENDS,
  },
}

export function getFirstInstalledMagicDefaults(
  installedBackends: CliBackend[]
) {
  for (const backend of installedBackends) {
    const defaults = MAGIC_DEFAULTS[backend]
    if (defaults) return defaults
    if (backend === 'claude') return null
  }
  return null
}

export function getReadyBackends(
  installedBackends: CliBackend[],
  authByBackend: Partial<Record<CliBackend, boolean | undefined>>
) {
  return installedBackends.filter(backend => authByBackend[backend] === true)
}

export function hasUntouchedClaudeMagicDefaults(
  models: MagicPromptModels,
  backends: MagicPromptBackends
) {
  return (
    Object.keys(DEFAULT_MAGIC_PROMPT_MODELS).every(
      key =>
        models[key as keyof MagicPromptModels] ===
        DEFAULT_MAGIC_PROMPT_MODELS[key as keyof MagicPromptModels]
    ) &&
    Object.keys(DEFAULT_MAGIC_PROMPT_BACKENDS).every(
      key =>
        backends[key as keyof MagicPromptBackends] ===
        DEFAULT_MAGIC_PROMPT_BACKENDS[key as keyof MagicPromptBackends]
    )
  )
}

/** Set magic prompts from the first installed AI CLI after detection completes. */
export function useMagicPromptAutoDefaults() {
  const { data: preferences } = usePreferences()
  const { installedBackends, isLoading: isStatusLoading } =
    useInstalledBackends()
  const { authByBackend, isLoading: isAuthLoading } = useBackendAuthStatuses()
  const patchPreferences = usePatchPreferences()
  const didRun = useRef(false)

  useEffect(() => {
    if (!preferences || isStatusLoading || isAuthLoading || didRun.current)
      return

    const readyBackends = getReadyBackends(installedBackends, authByBackend)

    // Do not finalize detection before onboarding installs a CLI. The status
    // queries will refresh after installation and this effect can then select it.
    if (readyBackends.length === 0) return

    // Repair onboarding from older versions that finalized detection before a
    // CLI was installed, leaving untouched Claude choices without Claude.
    if (
      preferences.magic_models_auto_initialized &&
      (readyBackends.includes('claude') ||
        !hasUntouchedClaudeMagicDefaults(
          preferences.magic_prompt_models,
          preferences.magic_prompt_backends
        ))
    ) {
      return
    }

    didRun.current = true
    const [firstBackend] = readyBackends
    const defaults = getFirstInstalledMagicDefaults(readyBackends)
    patchPreferences.mutate({
      default_backend: firstBackend,
      ...(defaults
        ? {
            magic_prompt_models: defaults.models,
            magic_prompt_backends: defaults.backends,
          }
        : {}),
      magic_models_auto_initialized: true,
    })
  }, [
    preferences,
    installedBackends,
    authByBackend,
    isStatusLoading,
    isAuthLoading,
    patchPreferences,
  ])
}
