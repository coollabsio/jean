import React, { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle,
  Copy,
  Globe,
  Loader2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { copyToClipboard } from '@/lib/clipboard'
import { invoke } from '@/lib/transport'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { invalidateAllMcpServers } from '@/services/mcp'
import type { CliBackend } from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'

interface AgentBrowserStatus {
  installed: boolean
  binaryPath: string | null
  version: string | null
  profilePath: string
  profileExists: boolean
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

type InstallState = 'idle' | 'installing' | 'success' | 'error'
type BinaryInstallState = 'idle' | 'installing' | 'success' | 'error'

export const AgentBrowserSection: React.FC = () => {
  const queryClient = useQueryClient()
  const { installedBackends } = useInstalledBackends()
  const [installState, setInstallState] = useState<InstallState>('idle')
  const [installMessage, setInstallMessage] = useState('')
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

  const handleEnsureProfile = useCallback(async () => {
    try {
      await invoke<AgentBrowserStatus>('ensure_agent_browser_profile')
      await refetch()
      toast.success('Agent browser profile ready')
    } catch (e) {
      toast.error(`Failed to create profile: ${e}`)
    }
  }, [refetch])

  const handleInstallBinary = useCallback(async () => {
    setBinaryInstallState('installing')
    setBinaryInstallMessage(
      'Installing agent-browser (npm) and Chromium — this may take a few minutes…'
    )
    const toastId = toast.loading(
      'Installing agent-browser and Chromium…'
    )
    try {
      const next = await invoke<AgentBrowserStatus>('install_agent_browser')
      queryClient.setQueryData(['agentBrowserStatus'], next)
      await refetch()
      setBinaryInstallState('success')
      setBinaryInstallMessage(
        next.version
          ? `Installed agent-browser ${next.version}`
          : 'Installed agent-browser and Chromium'
      )
      toast.success('agent-browser installed', { id: toastId })
    } catch (e) {
      setBinaryInstallState('error')
      setBinaryInstallMessage(`Install failed: ${e}`)
      toast.error(`agent-browser install failed: ${e}`, { id: toastId })
    }
  }, [queryClient, refetch])

  const handleInstall = useCallback(async () => {
    if (installableBackends.length === 0) {
      setInstallState('error')
      setInstallMessage(
        'Install a supported CLI first (Claude, Codex, Cursor, Grok, Kimi, Antigravity, or OpenCode)'
      )
      return
    }
    setInstallState('installing')
    setInstallMessage('')
    try {
      const results = await invoke<AgentBrowserInstallResult[]>(
        'install_agent_browser_mcp',
        { backends: installableBackends }
      )
      const successes = results.filter(r => r.status === 'installed')
      const failures = results.filter(r => r.status === 'error')
      invalidateAllMcpServers(undefined, installableBackends)
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
      await refetch()
      if (failures.length > 0) {
        setInstallState('error')
        setInstallMessage(
          `Added ${successes.length}/${results.length}; ${failures.length} failed`
        )
      } else {
        setInstallState('success')
        setInstallMessage(
          `Added agent-browser MCP to ${successes.length} backend${successes.length === 1 ? '' : 's'}`
        )
        toast.success('Agent browser MCP installed')
      }
    } catch (e) {
      setInstallState('error')
      setInstallMessage('Failed to install agent-browser MCP')
      toast.error(`Install failed: ${e}`)
    }
  }, [installableBackends, queryClient, refetch])

  const handleCopy = (label: string, content: string | undefined) => {
    if (!content) {
      toast.error(`No ${label} snippet available`)
      return
    }
    copyToClipboard(content)
    toast.success(`${label} snippet copied`)
  }

  return (
    <SettingsSection
      title="Agent Browser"
      anchorId="pref-mcp-section-agent-browser"
    >
      <p className="text-sm text-muted-foreground">
        Give coding agents a real Chromium browser with a Jean-managed login
        profile (Vercel agent-browser). Log in manually once; sessions reuse
        cookies. Works on jean-server and desktop.
      </p>

      <div className="space-y-3 rounded-md border px-4 py-3">
        {isLoading || isFetching ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Checking agent-browser…
          </span>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {status?.installed ? (
                <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                  <CheckCircle className="size-3.5" />
                  agent-browser
                  {status.version ? ` ${status.version}` : ''} installed
                  {status.managedInstall ? ' (Jean-managed)' : ''}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <XCircle className="size-3.5" />
                  agent-browser not installed
                </span>
              )}
              {status?.profileExists && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Globe className="size-3.5" />
                  Profile ready
                </span>
              )}
            </div>

            {status && (
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="break-all">
                  <span className="font-medium text-foreground">Profile: </span>
                  {status.profilePath}
                </div>
                {status.binaryPath && (
                  <div className="break-all">
                    <span className="font-medium text-foreground">Binary: </span>
                    {status.binaryPath}
                  </div>
                )}
                {!status.installed && (
                  <div className="rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px]">
                    {status.installHint}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleInstallBinary()}
            disabled={binaryInstallState === 'installing'}
          >
            {binaryInstallState === 'installing' ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Installing agent-browser…
              </>
            ) : status?.installed ? (
              'Reinstall / update agent-browser'
            ) : (
              'Install agent-browser'
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void handleEnsureProfile()}
          >
            Create profile
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void handleInstall()}
            disabled={
              installState === 'installing' || status?.installed === false
            }
          >
            {installState === 'installing' ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Installing MCP…
              </>
            ) : installState === 'success' ? (
              <>
                <CheckCircle className="size-3.5" />
                MCP installed
              </>
            ) : (
              'Install MCP into backends'
            )}
          </Button>
          {status && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleCopy('Claude', status.claudeSnippet)}
              >
                <Copy className="size-3.5" />
                Claude snippet
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleCopy('Codex', status.codexSnippet)}
              >
                <Copy className="size-3.5" />
                Codex snippet
              </Button>
            </>
          )}
        </div>

        {binaryInstallMessage && (
          <p
            className={
              binaryInstallState === 'error'
                ? 'text-xs text-red-600 dark:text-red-400'
                : 'text-xs text-muted-foreground'
            }
          >
            {binaryInstallMessage}
          </p>
        )}
        {installMessage && (
          <p
            className={
              installState === 'error'
                ? 'text-xs text-red-600 dark:text-red-400'
                : 'text-xs text-muted-foreground'
            }
          >
            {installMessage}
          </p>
        )}

        <div className="space-y-1 text-xs text-muted-foreground">
          <Label className="text-xs text-foreground">How to use</Label>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              Click <strong>Install agent-browser</strong> (npm package +
              Chromium into Jean app data). Requires <code>npm</code> on PATH.
            </li>
            <li>Click Install MCP into backends (or paste a snippet).</li>
            <li>
              First login: run headed (or under VNC) and sign in manually.
            </li>
            <li>
              In chat, ask the agent to use the browser; it reuses the Jean
              profile.
            </li>
          </ol>
        </div>
      </div>
    </SettingsSection>
  )
}
