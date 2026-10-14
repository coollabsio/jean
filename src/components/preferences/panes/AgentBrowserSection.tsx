import React, { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle, Loader2, XCircle } from '@/components/icons/reicon'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { invoke } from '@/lib/transport'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { invalidateAllMcpServers } from '@/services/mcp'
import type { CliBackend } from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'

interface AgentBrowserStatus {
  installed: boolean
  binaryPath: string | null
  version: string | null
  managedDir: string
  managedInstall: boolean
  claudeSnippet: string
  codexSnippet: string
  installHint: string
}

interface AgentBrowserInstallResult {
  backend: string
  status: 'installed' | 'error' | string
  path: string | null
  backupPath: string | null
  serverName: string
  message: string
}

const INSTALLABLE_BACKENDS = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'grok',
  'kimi',
  'antigravity',
] as const satisfies readonly CliBackend[]

type BinaryInstallState = 'idle' | 'installing' | 'success' | 'error'

export const AgentBrowserSection: React.FC = () => {
  const queryClient = useQueryClient()
  const { installedBackends } = useInstalledBackends()
  const [binaryInstallState, setBinaryInstallState] =
    useState<BinaryInstallState>('idle')
  const [binaryInstallMessage, setBinaryInstallMessage] = useState('')

  const {
    data: status,
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['agentBrowserStatus'],
    queryFn: () => invoke<AgentBrowserStatus>('get_agent_browser_status'),
    staleTime: 15_000,
  })

  const installableBackends = INSTALLABLE_BACKENDS.filter(b =>
    installedBackends.includes(b)
  )

  const handleInstallBinary = useCallback(async () => {
    setBinaryInstallState('installing')
    setBinaryInstallMessage(
      'Installing agent-browser (npm) and Chromium — this may take a few minutes…'
    )
    const toastId = toast.loading('Installing agent-browser and Chromium…')
    try {
      const next = await invoke<AgentBrowserStatus>('install_agent_browser')
      queryClient.setQueryData(['agentBrowserStatus'], next)
      const results = await invoke<AgentBrowserInstallResult[]>(
        'install_agent_browser_mcp',
        { backends: installableBackends }
      )
      const failures = results.filter(result => result.status === 'error')
      if (failures.length > 0) {
        throw new Error(
          `Installed the browser, but MCP setup failed for ${failures.length} backend${failures.length === 1 ? '' : 's'}`
        )
      }

      invalidateAllMcpServers(undefined, installableBackends)
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
      await refetch()
      setBinaryInstallState('success')
      setBinaryInstallMessage(
        `${next.version ? `Installed agent-browser ${next.version}` : 'Installed agent-browser and Chromium'}${results.length > 0 ? ` and added MCP to ${results.length} backend${results.length === 1 ? '' : 's'}` : ''}`
      )
      toast.success('Agent browser ready', { id: toastId })
    } catch (e) {
      setBinaryInstallState('error')
      setBinaryInstallMessage(`Setup failed: ${e}`)
      toast.error(`Agent browser setup failed: ${e}`, { id: toastId })
    }
  }, [installableBackends, queryClient, refetch])

  return (
    <SettingsSection
      title="Agent Browser"
      anchorId="pref-mcp-section-agent-browser"
    >
      <p className="text-sm text-muted-foreground">
        Managed Chromium access for agents. Installed automatically.
      </p>

      <div className="space-y-2">
        {isLoading || isFetching ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Checking agent-browser…
          </span>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {status?.installed ? (
                <span className="flex items-center gap-1.5 text-success">
                  <CheckCircle className="size-3.5" />
                  Installed{status.version ? ` · ${status.version}` : ''}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-warning">
                  <XCircle className="size-3.5" />
                  Automatic agent-browser setup is not complete
                </span>
              )}
            </div>
          </>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => void handleInstallBinary()}
            disabled={binaryInstallState === 'installing'}
          >
            {binaryInstallState === 'installing' ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Installing agent-browser…
              </>
            ) : status?.installed ? (
              'Update / repair'
            ) : (
              'Retry automatic setup'
            )}
          </Button>
        </div>

        {binaryInstallMessage && (
          <p
            className={
              binaryInstallState === 'error'
                ? 'text-xs text-destructive'
                : 'text-xs text-muted-foreground'
            }
          >
            {binaryInstallMessage}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}
