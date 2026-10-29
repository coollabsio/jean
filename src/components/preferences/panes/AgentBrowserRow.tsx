import React, { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Loader2, RefreshCw, Square } from '@/components/icons/reicon'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { invoke } from '@/lib/transport'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { invalidateAllMcpServers } from '@/services/mcp'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import type { CliBackend } from '@/types/preferences'
import { ExtensionLink, ExtensionRow } from '../ExtensionRow'

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
  'devin',
  'antigravity',
] as const satisfies readonly CliBackend[]

const BACKEND_LABELS: Record<(typeof INSTALLABLE_BACKENDS)[number], string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  grok: 'Grok',
  kimi: 'Kimi',
  devin: 'Devin',
  antigravity: 'Antigravity',
}

type BinaryInstallState = 'idle' | 'installing' | 'success' | 'error'

export const AgentBrowserRow: React.FC = () => {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const enabled = preferences?.agent_browser_enabled ?? false
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
    enabled,
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

  const handleToggle = useCallback(
    async (checked: boolean) => {
      // Save first: MCP install also writes the preferences file.
      await patchPreferences.mutateAsync({ agent_browser_enabled: checked })
      if (checked) {
        await handleInstallBinary()
        return
      }
      setBinaryInstallState('idle')
      setBinaryInstallMessage('')
      try {
        const results = await invoke<AgentBrowserInstallResult[]>(
          'remove_agent_browser_mcp'
        )
        const failures = results.filter(result => result.status === 'error')
        if (failures.length > 0) {
          throw new Error(failures.map(f => f.message).join('; '))
        }
        invalidateAllMcpServers()
        toast.success('Agent browser turned off')
      } catch (e) {
        toast.error(`Failed to remove agent browser MCP: ${e}`)
      }
    },
    [handleInstallBinary, patchPreferences]
  )

  const installing = binaryInstallState === 'installing'
  const checking = enabled && (isLoading || isFetching)
  const busy = installing || patchPreferences.isPending

  return (
    <ExtensionRow
      name="Agent Browser"
      anchorId="pref-mcp-section-agent-browser"
      status={
        !enabled ? (
          <Badge variant="subtle" className="max-w-full shrink">
            <span className="truncate">Not installed</span>
          </Badge>
        ) : checking ? null : status?.installed ? (
          <Badge
            variant="success"
            className="w-auto min-w-0 max-w-full shrink justify-start gap-1 overflow-hidden"
          >
            <span className="shrink-0">Installed</span>
            {status.version && (
              <span className="min-w-0 truncate">({status.version})</span>
            )}
          </Badge>
        ) : (
          <Badge variant="warning" className="max-w-full shrink">
            <span className="truncate">Setup incomplete</span>
          </Badge>
        )
      }
      iconAction={
        !enabled ? undefined : checking && !installing ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh Agent Browser status"
            onClick={() => void refetch()}
            disabled={busy}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )
      }
      actions={
        !enabled ? (
          <Button
            size="sm"
            onClick={() => void handleToggle(true)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Install
          </Button>
        ) : checking && !installing ? null : (
          <>
            <Button
              variant={status?.installed ? 'outline' : 'default'}
              size="sm"
              onClick={() => void handleInstallBinary()}
              disabled={busy}
              className="flex-1 sm:flex-none"
            >
              {installing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {status?.installed ? 'Update / repair' : 'Retry setup'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleToggle(false)}
              disabled={busy}
              className="flex-1 sm:flex-none"
            >
              <Square className="h-4 w-4" />
              Turn off
            </Button>
          </>
        )
      }
    >
      <div className="space-y-1 pt-1">
        <div className="text-2xs text-muted-foreground">
          Applies to:{' '}
          <span className="text-foreground/70">
            {installableBackends.length > 0
              ? installableBackends.map(b => BACKEND_LABELS[b]).join(', ')
              : 'No supported CLI installed'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Give agents managed Chromium access through MCP. Install sets up
          agent-browser and Chromium and adds the MCP server to your CLIs. Turn
          off removes the MCP server from your CLIs.
        </p>
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
        <div className="flex flex-wrap items-center gap-3">
          <ExtensionLink
            url="https://github.com/vercel-labs/agent-browser"
            label="GitHub"
          />
        </div>
      </div>
    </ExtensionRow>
  )
}
