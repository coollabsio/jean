import type { AppPreferences, CliBackend } from '@/types/preferences'

/** One entry of the Default backend select: a backend, optionally with a provider. */
export interface DefaultBackendChoice {
  value: string
  backend: CliBackend
  provider: string | null
}

const SEPARATOR = '::'

/** Backends whose default provider is stored in preferences. */
const PROVIDER_FIELD = {
  claude: 'default_provider',
  codex: 'default_codex_provider',
} as const

type ProviderBackend = keyof typeof PROVIDER_FIELD

function hasProviders(backend: CliBackend): backend is ProviderBackend {
  return backend in PROVIDER_FIELD
}

function providerNames(
  backend: ProviderBackend,
  preferences: AppPreferences | undefined
): string[] {
  const profiles =
    backend === 'claude'
      ? preferences?.custom_cli_profiles
      : preferences?.custom_codex_providers
  return (profiles ?? []).map(profile => profile.name)
}

/** Each installed backend, followed by one entry per custom provider it has. */
export function defaultBackendChoices(
  backends: CliBackend[],
  preferences: AppPreferences | undefined
): DefaultBackendChoice[] {
  return backends.flatMap(backend => [
    { value: backend, backend, provider: null },
    ...(hasProviders(backend) ? providerNames(backend, preferences) : []).map(
      provider => ({
        value: `${backend}${SEPARATOR}${provider}`,
        backend,
        provider,
      })
    ),
  ])
}

/** Select value for the stored backend and its default provider. */
export function currentDefaultBackendChoice(
  backend: CliBackend,
  preferences: AppPreferences | undefined
): string {
  if (!hasProviders(backend)) return backend
  const provider = preferences?.[PROVIDER_FIELD[backend]]
  return provider && providerNames(backend, preferences).includes(provider)
    ? `${backend}${SEPARATOR}${provider}`
    : backend
}

/** Preference patch that selects `choice`. */
export function patchForDefaultBackendChoice(
  choice: DefaultBackendChoice
): Partial<AppPreferences> {
  if (!hasProviders(choice.backend)) return { default_backend: choice.backend }
  return {
    default_backend: choice.backend,
    [PROVIDER_FIELD[choice.backend]]: choice.provider,
  }
}
