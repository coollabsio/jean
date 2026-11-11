import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, LogIn } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { invokeForOptionalServer } from '@/lib/transport'
import { useOptionalSettingsTargetServerId } from '@/lib/settings-target'
import { useUIStore } from '@/store/ui-store'

export type CliproxyProvider = 'claude' | 'codex'

interface AccountLoginLaunch {
  binary: string
  args: string[]
  message: string
}

const PROVIDER_LABEL: Record<CliproxyProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

/**
 * Opens the CLIProxyAPI account login in the CLI login modal. When the modal
 * closes, it refreshes the proxy models and calls `onFinished`.
 */
export function useCliproxyAccountLogin(onFinished?: () => void) {
  const serverId = useOptionalSettingsTargetServerId()
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)
  const modalOpen = useUIStore(state => state.cliLoginModalOpen)
  const [loggingIn, setLoggingIn] = useState<CliproxyProvider | null>(null)
  const pending = useRef(false)
  const onFinishedRef = useRef(onFinished)
  onFinishedRef.current = onFinished

  useEffect(() => {
    if (modalOpen || !pending.current) return
    pending.current = false
    onFinishedRef.current?.()
    invokeForOptionalServer(serverId, 'refresh_cliproxyapi_models').catch(
      () => undefined
    )
  }, [modalOpen, serverId])

  const login = useCallback(
    async (provider: CliproxyProvider) => {
      setLoggingIn(provider)
      const label = PROVIDER_LABEL[provider]
      const toastId = toast.loading(`Opening ${label} account login...`)
      try {
        const launch = await invokeForOptionalServer<AccountLoginLaunch>(
          serverId,
          'prepare_cliproxyapi_account_login',
          { provider }
        )
        toast.success(launch.message, { id: toastId })
        pending.current = true
        openCliLoginModal(
          'cliproxyapi',
          launch.binary,
          launch.args,
          undefined,
          undefined,
          serverId
        )
      } catch (error) {
        toast.error(`Failed to open ${label} account login: ${error}`, {
          id: toastId,
        })
      } finally {
        setLoggingIn(null)
      }
    },
    [openCliLoginModal, serverId]
  )

  return { loggingIn, login }
}

export function CliproxyAddAccountButton({
  provider,
  loading,
  disabled,
  onClick,
  label = `Add ${PROVIDER_LABEL[provider]} account`,
}: {
  provider: CliproxyProvider
  loading: boolean
  disabled?: boolean
  onClick: () => void
  label?: string
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <LogIn className="h-4 w-4" />
      )}
      {label}
    </Button>
  )
}

/** "Add to CLIProxyAPI" button for a backend's CLI section. Hidden when the proxy is not installed. */
export function CliproxyBackendAccountAction({
  provider,
}: {
  provider: CliproxyProvider
}) {
  const serverId = useOptionalSettingsTargetServerId()
  const { data: installed } = useQuery({
    queryKey: ['opinionated-plugin-status', 'cliproxyapi', serverId],
    queryFn: async () =>
      (
        await invokeForOptionalServer<{ installed: boolean }>(
          serverId,
          'check_opinionated_plugin_status',
          { pluginName: 'cliproxyapi' }
        )
      ).installed,
    staleTime: 60_000,
  })
  const { loggingIn, login } = useCliproxyAccountLogin()
  if (!installed) return null
  return (
    <CliproxyAddAccountButton
      provider={provider}
      loading={loggingIn === provider}
      disabled={loggingIn !== null}
      onClick={() => login(provider)}
      label="Add to CLIProxyAPI"
    />
  )
}
