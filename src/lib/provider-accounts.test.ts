import { describe, expect, it } from 'vitest'
import {
  accountLabel,
  accountsForBackend,
  providerAccountSupportsBackend,
  withDefaultAccount,
} from './provider-accounts'
import type { ProviderAccount } from '@/types/preferences'

const accounts: ProviderAccount[] = [
  { id: 'work-acct', backend: 'codex', label: 'Work' },
  { id: 'personal1', backend: 'claude', label: 'Personal' },
]

describe('provider accounts', () => {
  it('keeps accounts with the backend that will use them', () => {
    expect(
      accountsForBackend(accounts, 'codex').map(account => account.label)
    ).toEqual(['Work'])
    expect(accountsForBackend(undefined, 'claude')).toEqual([])
    expect(providerAccountSupportsBackend('claude')).toBe(true)
    expect(providerAccountSupportsBackend('pi')).toBe(false)
  })

  it('labels the CLI login and a saved account', () => {
    expect(accountLabel(accounts, null)).toBe('CLI login')
    expect(accountLabel(accounts, 'work-acct')).toBe('Work')
    expect(accountLabel(accounts, 'missing')).toBe('Account')
  })

  it('stores a default account and clears it back to the CLI login', () => {
    const withWork = withDefaultAccount({}, 'codex', 'work-acct')
    expect(withWork).toEqual({ codex: 'work-acct' })
    expect(withDefaultAccount(withWork, 'claude', 'personal1')).toEqual({
      codex: 'work-acct',
      claude: 'personal1',
    })
    expect(withDefaultAccount(withWork, 'codex', null)).toEqual({})
  })
})
