import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, Trash2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { loginArgsForBackend } from '@/lib/cli-auth'
import { accountsForBackend, withDefaultAccount } from '@/lib/provider-accounts'
import { useSettingsTargetServerId } from '@/lib/settings-target'
import { invoke, invokeForServer } from '@/lib/transport'
import { useClaudeCliStatus } from '@/services/claude-cli'
import { useCodexCliStatus } from '@/services/codex-cli'
import {
  preferencesQueryKeys,
  usePatchPreferences,
  usePreferences,
} from '@/services/preferences'
import { useUIStore } from '@/store/ui-store'
import type { AppPreferences, ProviderAccount } from '@/types/preferences'
import { LOCAL_SERVER_ID, type ServerId } from '@/types/server-resource'
import { SettingsSection } from '../SettingsSection'

const CLI_LOGIN = '__cli_login__'

async function invokeOnServer<T>(
  serverId: ServerId,
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  if (serverId === LOCAL_SERVER_ID) {
    return invoke<T>(command, args)
  }
  return invokeForServer<T>(serverId, command, args)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown error'
}

export function ProviderAccountsSection() {
  const serverId = useSettingsTargetServerId()
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const claudeStatus = useClaudeCliStatus({ serverId })
  const codexStatus = useCodexCliStatus({ serverId })
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)

  const accounts = preferences?.provider_accounts ?? []
  const defaults = preferences?.default_provider_accounts ?? {}
  const [backend, setBackend] = useState<'claude' | 'codex'>('claude')
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  const updateAccountCache = (
    update: (current: AppPreferences) => AppPreferences
  ) => {
    queryClient.setQueryData<AppPreferences>(
      preferencesQueryKeys.preferences(serverId),
      current => (current ? update(current) : current)
    )
  }

  const addAccount = async () => {
    const name = label.trim()
    if (!name || pending) return
    setPending('create')
    try {
      const created = await invokeOnServer<ProviderAccount>(
        serverId,
        'create_provider_account',
        { backend, label: name }
      )
      updateAccountCache(current => ({
        ...current,
        provider_accounts: [...(current.provider_accounts ?? []), created],
      }))
      setLabel('')
      void queryClient.invalidateQueries({
        queryKey: preferencesQueryKeys.preferences(serverId),
      })
    } catch (error) {
      toast.error('Failed to add account', { description: errorMessage(error) })
    } finally {
      setPending(null)
    }
  }

  const deleteAccount = async (account: ProviderAccount) => {
    setPending(account.id)
    try {
      await invokeOnServer(serverId, 'delete_provider_account', {
        id: account.id,
      })
      updateAccountCache(current => ({
        ...current,
        provider_accounts: (current.provider_accounts ?? []).filter(
          item => item.id !== account.id
        ),
        default_provider_accounts: Object.fromEntries(
          Object.entries(current.default_provider_accounts ?? {}).filter(
            ([, id]) => id !== account.id
          )
        ),
      }))
      void queryClient.invalidateQueries({
        queryKey: preferencesQueryKeys.preferences(serverId),
      })
    } catch (error) {
      toast.error('Failed to delete account', {
        description: errorMessage(error),
      })
    } finally {
      setPending(null)
    }
  }

  const saveLogin = async (account: ProviderAccount) => {
    setPending(account.id)
    try {
      const copied = await invokeOnServer<string[]>(
        serverId,
        'capture_provider_account_auth',
        { id: account.id }
      )
      toast.success(`Saved ${account.label}`, {
        description: copied.length > 0 ? copied.join(', ') : undefined,
      })
    } catch (error) {
      toast.error(`Could not save ${account.label}`, {
        description: errorMessage(error),
      })
    } finally {
      setPending(null)
    }
  }

  const signIn = (account: ProviderAccount) => {
    const status =
      account.backend === 'codex' ? codexStatus.data : claudeStatus.data
    const cliName = account.backend === 'codex' ? 'Codex' : 'Claude'
    if (!status?.path) {
      toast.error(
        `Install the ${cliName} CLI in Settings → General before signing in`
      )
      return
    }
    const args =
      account.backend === 'claude'
        ? loginArgsForBackend(
            'claude',
            claudeStatus.data?.supports_auth_command ?? true
          )
        : loginArgsForBackend('codex')
    openCliLoginModal(
      account.backend === 'codex' ? 'codex' : 'claude',
      status.path,
      args
    )
  }

  const setDefault = (accountBackend: 'claude' | 'codex', value: string) => {
    patchPreferences.mutate({
      default_provider_accounts: withDefaultAccount(
        defaults,
        accountBackend,
        value === CLI_LOGIN ? null : value
      ),
    })
  }

  return (
    <SettingsSection
      title="Accounts"
      description="Keep a personal login and a work login for Claude or Codex. Sign in on an account, then save that login into it. New sessions start on the default below, and the chat toolbar can switch the account for the open session."
      anchorId="pref-providers-section-accounts"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={backend}
          onValueChange={value => setBackend(value as 'claude' | 'codex')}
        >
          <SelectTrigger className="w-32" aria-label="Account backend">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={label}
          onChange={event => setLabel(event.target.value)}
          placeholder="Work"
          aria-label="Account name"
          className="h-8 w-full sm:w-48"
          onKeyDown={event => {
            if (event.key === 'Enter') void addAccount()
          }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void addAccount()}
          disabled={!label.trim() || pending === 'create'}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No saved accounts yet.</p>
      ) : (
        <div className="space-y-2">
          {accounts.map(account => (
            <div
              key={account.id}
              className="flex flex-wrap items-center gap-2 py-1"
            >
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{account.label}</span>
                <p className="text-xs text-muted-foreground capitalize">
                  {account.backend}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => signIn(account)}
                aria-label={`Sign in ${account.label}`}
              >
                Sign in
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending === account.id}
                onClick={() => void saveLogin(account)}
                aria-label={`Save current login for ${account.label}`}
              >
                Save current login
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                disabled={pending === account.id}
                onClick={() => void deleteAccount(account)}
                aria-label={`Delete ${account.label}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {(['claude', 'codex'] as const).map(accountBackend => {
        const backendAccounts = accountsForBackend(accounts, accountBackend)
        if (backendAccounts.length === 0) return null
        const selected = backendAccounts.some(
          account => account.id === defaults[accountBackend]
        )
          ? defaults[accountBackend]
          : CLI_LOGIN
        const title = accountBackend === 'claude' ? 'Claude' : 'Codex'
        return (
          <div
            key={accountBackend}
            className="flex items-center justify-between gap-4"
          >
            <div>
              <p className="text-sm font-medium">Default {title} account</p>
              <p className="text-xs text-muted-foreground">
                Used for new {title} sessions
              </p>
            </div>
            <Select
              value={selected}
              onValueChange={value => setDefault(accountBackend, value)}
            >
              <SelectTrigger
                className="w-full sm:w-80"
                aria-label={`Default ${title} account`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CLI_LOGIN}>CLI login</SelectItem>
                {backendAccounts.map(account => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </SettingsSection>
  )
}
