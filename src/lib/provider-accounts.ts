import type { ProviderAccount } from '@/types/preferences'

export const PROVIDER_ACCOUNT_BACKENDS = ['claude', 'codex'] as const

export function providerAccountSupportsBackend(backend: string): boolean {
  return (PROVIDER_ACCOUNT_BACKENDS as readonly string[]).includes(backend)
}

export function accountsForBackend(
  accounts: ProviderAccount[] | undefined,
  backend: string
): ProviderAccount[] {
  return (accounts ?? []).filter(account => account.backend === backend)
}

export function accountLabel(
  accounts: ProviderAccount[] | undefined,
  accountId: string | null | undefined
): string {
  if (!accountId) return 'CLI login'
  return accounts?.find(account => account.id === accountId)?.label ?? 'Account'
}

/** Replace one backend's default. A null id means new sessions use the CLI login. */
export function withDefaultAccount(
  defaults: Record<string, string> | undefined,
  backend: string,
  accountId: string | null
): Record<string, string> {
  const next = { ...(defaults ?? {}) }
  if (!accountId) {
    return Object.fromEntries(
      Object.entries(next).filter(([key]) => key !== backend)
    )
  }
  return { ...next, [backend]: accountId }
}
