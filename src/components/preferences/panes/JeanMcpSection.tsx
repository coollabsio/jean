import React, { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle,
  Loader2,
  PlugZap,
  XCircle,
} from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { invoke, listen } from '@/lib/transport'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { invalidateAllMcpServers } from '@/services/mcp'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import type { McpServerInfo } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'

interface JeanMcpSnippet {
  enabled: boolean
  serverRunning: boolean
  mode: 'dev' | 'prod'
  serverName: string
  url: string | null
  token: string | null
  claude: string | null
  cursor: string | null
  codexToml: string | null
  grokToml: string | null
  kimi: string | null
  opencodeJson: string | null
}

interface JeanMcpInstallResult {
  backend: CliBackend
  status: 'installed' | 'error'
  path: string | null
  backupPath: string | null
  serverName: string
  mode: 'dev' | 'prod'
  message: string
}

type InstallState = 'idle' | 'installing' | 'success' | 'error'

/** Backends that support persistent Jean MCP config install. */
const INSTALLABLE_BACKENDS = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'grok',
  'kimi',
  'antigravity',
] as const satisfies readonly CliBackend[]

const BACKEND_LABELS: Record<(typeof INSTALLABLE_BACKENDS)[number], string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  grok: 'Grok',
  kimi: 'Kimi',
  antigravity: 'Antigravity',
}

function installButtonContent(state: InstallState, message: string) {
  switch (state) {
    case 'installing':
      return (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          <span>Adding...</span>
        </>
      )
    case 'success':
      return (
        <>
          <CheckCircle className="size-3.5" />
          <span className="truncate">{message || 'Added'}</span>
        </>
      )
    case 'error':
      return (
        <>
          <XCircle className="size-3.5" />
          <span className="truncate">{message}</span>
        </>
      )
    default:
      return null
  }
}

interface JeanMcpSectionProps {
  mcpServers: McpServerInfo[]
}

export const JeanMcpSection: React.FC<JeanMcpSectionProps> = ({
  mcpServers,
}) => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const { installedBackends } = useInstalledBackends()
  const queryClient = useQueryClient()
  const [installState, setInstallState] = useState<InstallState>('idle')
  const [installMessage, setInstallMessage] = useState('')
  const {
    data: snippet,
    refetch: refreshSnippet,
    isLoading: isSnippetLoading,
    isFetching: isSnippetFetching,
  } = useQuery<JeanMcpSnippet>({
    queryKey: ['jeanMcpSnippet'],
    queryFn: () => invoke<JeanMcpSnippet>('get_jean_mcp_config_snippet'),
  })

  const serverRunning = snippet?.serverRunning ?? false
  const checkingServer = !snippet && (isSnippetLoading || isSnippetFetching)
  const installableBackends = installedBackends.filter(
    (backend): backend is (typeof INSTALLABLE_BACKENDS)[number] =>
      (INSTALLABLE_BACKENDS as readonly CliBackend[]).includes(backend)
  )
  const configuredBackends = installableBackends.filter(backend =>
    mcpServers.some(
      server =>
        server.backend === backend && server.name === snippet?.serverName
    )
  )
  const setTemporaryInstallState = useCallback(
    (state: InstallState, message = '') => {
      setInstallState(state)
      setInstallMessage(message)
      if (state === 'success' || state === 'error') {
        window.setTimeout(() => {
          setInstallState('idle')
          setInstallMessage('')
        }, 5000)
      }
    },
    []
  )

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    listen('jean-mcp-socket-status', () => {
      queryClient.invalidateQueries({ queryKey: ['jeanMcpSnippet'] })
    }).then(fn => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [queryClient])

  const handleInstall = useCallback(async () => {
    if (!serverRunning) {
      setTemporaryInstallState('error', 'Jean MCP socket is not running')
      return
    }
    if (installableBackends.length === 0) {
      setTemporaryInstallState(
        'error',
        'Install a supported CLI first (Claude, Codex, Cursor, Grok, Kimi, Antigravity, or OpenCode)'
      )
      return
    }

    setTemporaryInstallState('installing')
    try {
      const results = await invoke<JeanMcpInstallResult[]>(
        'install_jean_mcp_config',
        {
          backends: installableBackends,
          mode: 'current',
        }
      )
      const successes = results.filter(r => r.status === 'installed')
      const failures = results.filter(r => r.status === 'error')
      invalidateAllMcpServers(undefined, installableBackends)
      await refreshSnippet()
      setTemporaryInstallState(
        failures.length > 0 ? 'error' : 'success',
        failures.length > 0
          ? `Added ${successes.length}/${results.length}; ${failures.length} failed`
          : 'Added'
      )
    } catch (e) {
      setTemporaryInstallState('error', 'Failed to add Jean MCP')
      console.error('Failed to add Jean MCP config', e)
    }
  }, [
    installableBackends,
    refreshSnippet,
    serverRunning,
    setTemporaryInstallState,
  ])

  const transientButton = installButtonContent(installState, installMessage)

  return (
    <>
      <SettingsSection title="Jean MCP Server" anchorId="pref-mcp-section-jean">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
            <CheckCircle className="size-4 text-success" />
            Required · Automatic
          </div>
          {checkingServer && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              Checking MCP socket…
            </span>
          )}
          {!checkingServer && !serverRunning && (
            <span className="flex items-center gap-1.5 text-xs text-warning">
              <PlugZap className="size-3.5 shrink-0" />
              MCP socket not running
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {configuredBackends.length > 0 && (
            <span>
              Active in{' '}
              {configuredBackends
                .map(backend => BACKEND_LABELS[backend])
                .join(', ')}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleInstall()}
            disabled={
              installState === 'installing' ||
              installState === 'success' ||
              !serverRunning ||
              installableBackends.length === 0
            }
            className={cn(
              'h-7',
              installState === 'success' &&
                'border-success bg-success text-success-foreground hover:bg-success/90'
            )}
            aria-live="polite"
            title={installMessage}
          >
            {transientButton ?? <span>Repair config</span>}
          </Button>
        </div>

        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            Advanced limits
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="jean-mcp-max-depth" className="text-xs">
                Max recursion depth
              </Label>
              <Input
                id="jean-mcp-max-depth"
                type="number"
                min={0}
                max={10}
                value={preferences?.jean_mcp_max_depth ?? 3}
                onChange={e =>
                  patchPreferences.mutate({
                    jean_mcp_max_depth: Math.max(
                      0,
                      Math.min(10, Number(e.target.value) || 0)
                    ),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jean-mcp-rate-limit" className="text-xs">
                Spawn rate limit (per minute)
              </Label>
              <Input
                id="jean-mcp-rate-limit"
                type="number"
                min={0}
                max={1000}
                value={preferences?.jean_mcp_rate_limit_per_minute ?? 20}
                onChange={e =>
                  patchPreferences.mutate({
                    jean_mcp_rate_limit_per_minute: Math.max(
                      0,
                      Math.min(1000, Number(e.target.value) || 0)
                    ),
                  })
                }
              />
            </div>
          </div>
        </details>
      </SettingsSection>
    </>
  )
}
