import React, { useCallback, useEffect, useRef, useState } from 'react'
import { invokeForOptionalServer } from '@/lib/transport'
import { useOptionalSettingsTargetServerId } from '@/lib/settings-target'
import { openExternal } from '@/lib/platform'
import { useUIStore } from '@/store/ui-store'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import {
  ExternalLink,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
  Play,
  Square,
  LogIn,
} from '@/components/icons/reicon'
import { toast } from 'sonner'
import { SettingsSection } from '../SettingsSection'
import { ExtensionGroup, ExtensionLink, ExtensionRow } from '../ExtensionRow'

interface UsageStep {
  label?: string
  command?: string
  note?: string
}

interface PluginLink {
  label: string
  url: string
}

interface PluginDefinition {
  id: string
  name: string
  description: string
  githubUrl: string
  links?: PluginLink[]
  usage: UsageStep[]
  scope: 'system-wide' | 'ai-backends' | 'claude-cli' | 'local-proxy'
  backends: string[]
}

const PLUGINS: PluginDefinition[] = [
  {
    id: 'cliproxyapi',
    name: 'CLIProxyAPI',
    description:
      'Local proxy that pools several Claude and Codex subscription accounts. Jean installs it and runs it on 127.0.0.1:8317.',
    githubUrl: 'https://github.com/router-for-me/CLIProxyAPI',
    links: [
      {
        label: 'MIT license',
        url: 'https://github.com/router-for-me/CLIProxyAPI/blob/main/LICENSE',
      },
      {
        label: 'CLIProxyAPI docs',
        url: 'https://help.router-for.me/',
      },
    ],
    scope: 'local-proxy',
    backends: ['Claude', 'Codex'],
    usage: [
      {
        note: 'Add accounts with the buttons above. The logins stay in CLIProxyAPI, not in Jean.',
      },
      {
        note: 'Select the CLIProxyAPI provider for a Claude, Codex, or PI session (Preferences → Providers). Jean adds it to each backend automatically.',
      },
      {
        note: 'Files are in ~/.jean/opinionated/cliproxyapi. The proxy listens on localhost only.',
      },
      {
        note: 'The management page asks for the management key. Jean keeps it in ~/.jean/opinionated/cliproxyapi/management-key. To show it, run on the machine where CLIProxyAPI runs:',
        command: 'cat ~/.jean/opinionated/cliproxyapi/management-key',
      },
      {
        note: 'When Jean runs on a remote server, forward the proxy port over SSH. Run this on your local machine, then open http://127.0.0.1:8317/management.html:',
        command: 'ssh -N -L 8317:127.0.0.1:8317 user@remote-host',
      },
    ],
  },
  {
    id: 'rtk',
    name: 'RTK',
    description:
      'CLI proxy that reduces LLM token consumption by 60-90% on common dev commands. Filters and compresses command outputs before they reach your AI assistant.',
    githubUrl: 'https://github.com/rtk-ai/rtk',
    scope: 'system-wide',
    backends: ['Claude', 'Codex', 'OpenCode', 'Cursor', 'all CLIs'],
    usage: [
      {
        note: "On Linux and macOS, installs through RTK's documented curl installer into ~/.local/bin.",
      },
      {
        note: 'Runs transparently — once installed, use your normal CLI commands (git, npm, docker, cargo, etc.) and RTK auto-rewrites them to token-optimized versions.',
      },
      {
        label: 'Verify hooks active',
        command: 'rtk status',
      },
      {
        label: 'Re-run setup if hooks missing',
        command: 'rtk init -g',
      },
      {
        label: 'Configure filters per-command',
        command: 'rtk config',
      },
    ],
  },
  {
    id: 'caveman',
    name: 'Caveman',
    description:
      'Cross-backend skill/plugin that reduces output tokens by ~65-75% through terse, caveman-style communication while maintaining technical accuracy.',
    githubUrl: 'https://github.com/JuliusBrussee/caveman',
    scope: 'ai-backends',
    backends: [
      'Claude',
      'Codex',
      'OpenCode',
      'Cursor',
      'Pi',
      'Command Code',
      'Grok',
    ],
    usage: [
      {
        note: "On Linux and macOS, installs through Caveman's documented curl installer. Jean then mirrors skills into each backend's CLI path (including ~/.grok/skills for Grok) plus Jean-global mirrors.",
      },
      {
        note: 'Claude and OpenCode can auto-activate. Codex and Cursor expose skills for per-session activation with /caveman; Cursor also gets an always-on rule when the installer can write one.',
      },
      {
        label: 'Switch intensity level',
        command: '/caveman lite|full|ultra',
      },
      {
        label: 'Disable',
        command: 'stop caveman',
      },
      {
        label: 'Specialized commands',
        command: '/caveman-commit, /caveman-review, /caveman-compress',
      },
    ],
  },
  {
    id: 'superpowers',
    name: 'Superpowers',
    description:
      'Cross-backend skill pack. Adds brainstorming, TDD, systematic debugging, code review, plan writing/execution, parallel agent dispatch, and git worktree workflows.',
    githubUrl: 'https://github.com/obra/superpowers',
    scope: 'ai-backends',
    backends: [
      'Claude',
      'Codex',
      'OpenCode',
      'Cursor',
      'Pi',
      'Command Code',
      'Grok',
    ],
    usage: [
      {
        note: 'Installs through Claude when available, then mirrors Superpowers skills into each backend CLI path (including ~/.grok/skills for Grok) plus Jean-global mirrors. Without Claude, Jean fetches the Superpowers repo directly.',
      },
      {
        label: 'Brainstorm a feature',
        command: '/superpowers:brainstorm',
      },
      {
        label: 'Write an implementation plan',
        command: '/superpowers:writing-plans',
      },
      {
        label: 'Execute a plan',
        command: '/superpowers:executing-plans',
      },
      {
        label: 'Request code review',
        command: '/superpowers:requesting-code-review',
      },
    ],
  },
  {
    id: 'pstack',
    name: 'pstack',
    description:
      "Poteto's cross-backend engineering skill pack. Adds Poteto Mode, architecture and investigation workflows, TDD, concise writing, verification, and focused parallel work.",
    githubUrl: 'https://github.com/michael-denyer/pstack-claude',
    scope: 'ai-backends',
    backends: [
      'Claude',
      'Codex',
      'OpenCode',
      'Cursor',
      'Pi',
      'Command Code',
      'Grok',
    ],
    usage: [
      {
        note: 'Uses the pstack-claude port of the Cursor pstack. Claude and Codex get the native pstack@pstack-claude plugin (skills, routing hook; Claude also gets subagents, Codex asks you to trust the hook via /hooks). Other backends, and Codex if its plugin install fails, get the skills copied into each backend path and Jean-global mirror, without setup-pstack.',
      },
      {
        label: 'Start rigorous engineering mode',
        command: '/poteto-mode',
      },
    ],
  },
  {
    id: 'tstack',
    name: 'tstack',
    description:
      "Theo's everyday engineering skill pack. Adds full send and full stop, council multi-model review, file a PR, babysit a PR, takeover, and modernize.",
    githubUrl: 'https://github.com/t3dotgg/tstack',
    scope: 'ai-backends',
    backends: [
      'Claude',
      'Codex',
      'OpenCode',
      'Cursor',
      'Pi',
      'Command Code',
      'Grok',
    ],
    usage: [
      {
        note: 'Installs the upstream t3dotgg/tstack skills as-is into each backend path and the Jean-global mirror. Some skills mention T3 Code tools (watch_pull_request, delegate_task) and fall back to gh or native tools elsewhere.',
      },
      {
        label: 'Ship a change through merge',
        command: 'full send',
      },
      {
        label: 'Stop when the PR is ready to merge',
        command: 'full stop',
      },
      {
        label: 'Multi-model review',
        command: 'council',
      },
      {
        label: 'File a short PR',
        command: 'file a PR',
      },
      {
        label: 'Watch CI and review bots',
        command: 'babysit',
      },
      {
        label: "Finish someone else's PR",
        command: 'take over',
      },
      {
        label: 'Rebase an old PR',
        command: 'modernize',
      },
    ],
  },
  {
    id: 'security-audit',
    name: 'Security Audit',
    description:
      "Cloudflare's source-first security audit skill. It maps trust boundaries, hunts by coverage, checks each candidate with a fresh verifier, and writes structured findings.",
    githubUrl: 'https://github.com/cloudflare/security-audit-skill',
    scope: 'ai-backends',
    backends: [
      'Claude',
      'Codex',
      'OpenCode',
      'Cursor',
      'Pi',
      'Command Code',
      'Grok',
    ],
    usage: [
      {
        note: 'Installs the upstream cloudflare/security-audit-skill pack as-is into each backend path and the Jean-global mirror. A full audit needs Node.js for the findings validators. The skill runs target code only inside an OS sandbox. Without that sandbox it keeps the lead as needs_validation.',
      },
      {
        label: 'Audit a codebase',
        command: 'security audit this codebase',
      },
      {
        label: 'Review one area',
        command: 'find security vulnerabilities in ./src',
      },
    ],
  },
]

interface PluginStatus {
  installed: boolean
  version: string | null
  install_supported?: boolean
  unsupported_reason?: string
  backends?: BackendPluginStatus[]
  running?: boolean
  endpoint?: string | null
  management_url?: string | null
  lan_exposed?: boolean
  auth_file_count?: number | null
  host?: string | null
}

interface AccountLoginLaunch {
  provider: string
  binary: string
  args: string[]
  started_proxy: boolean
  message: string
}

interface BackendPluginStatus {
  id: string
  label: string
  installed: boolean
}

// The backend reports `installed` only when every detected CLI has the pack.
// A pack that some backends have is still present (shown as Partial).
function isPluginPresent(status: PluginStatus): boolean {
  return (
    status.installed ||
    (status.backends?.some(backend => backend.installed) ?? false)
  )
}

function PluginCard({
  plugin,
  onInstalledChange,
}: {
  plugin: PluginDefinition
  onInstalledChange: (pluginId: string, installed: boolean) => void
}) {
  const [status, setStatus] = useState<PluginStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [controlling, setControlling] = useState(false)
  const [loggingIn, setLoggingIn] = useState<'claude' | 'codex' | null>(null)
  const loginPending = useRef(false)
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)
  const serverId = useOptionalSettingsTargetServerId()
  const cliLoginOpen = useUIStore(state => state.cliLoginModalOpen)

  const checkStatus = useCallback(async () => {
    setChecking(true)
    try {
      const result = await invokeForOptionalServer<PluginStatus>(
        serverId,
        'check_opinionated_plugin_status',
        { pluginName: plugin.id }
      )
      setStatus(result)
      onInstalledChange(plugin.id, isPluginPresent(result))
    } catch {
      setStatus({ installed: false, version: null })
      onInstalledChange(plugin.id, false)
    } finally {
      setChecking(false)
    }
  }, [plugin.id, onInstalledChange, serverId])

  React.useEffect(() => {
    checkStatus()
  }, [checkStatus])

  const handleInstall = useCallback(async () => {
    setInstalling(true)
    const toastId = toast.loading(`Installing ${plugin.name}...`)

    try {
      const message = await invokeForOptionalServer<string>(
        serverId,
        'install_opinionated_plugin',
        {
          pluginName: plugin.id,
        }
      )
      toast.success(message, { id: toastId })
    } catch (error) {
      toast.error(`Failed to install ${plugin.name}: ${error}`, {
        id: toastId,
      })
    } finally {
      setInstalling(false)
      await checkStatus()
    }
  }, [plugin.id, plugin.name, checkStatus, serverId])

  const handleControl = useCallback(
    async (action: 'start' | 'stop') => {
      setControlling(true)
      const toastId = toast.loading(
        action === 'start'
          ? `Starting ${plugin.name}...`
          : `Stopping ${plugin.name}...`
      )
      try {
        const message = await invokeForOptionalServer<string>(
          serverId,
          action === 'start'
            ? 'start_opinionated_plugin'
            : 'stop_opinionated_plugin',
          { pluginName: plugin.id }
        )
        toast.success(message, { id: toastId })
      } catch (error) {
        toast.error(`Failed to ${action} ${plugin.name}: ${error}`, {
          id: toastId,
        })
      } finally {
        setControlling(false)
        await checkStatus()
      }
    },
    [plugin.id, plugin.name, checkStatus, serverId]
  )

  const present = status ? isPluginPresent(status) : false
  const hasMissingBackend =
    plugin.scope === 'ai-backends' &&
    (status?.backends?.some(backend => !backend.installed) ?? false)
  const supervises = plugin.scope === 'local-proxy'
  const statusLabel = hasMissingBackend
    ? 'Partial'
    : supervises && status?.installed
      ? status.running
        ? 'Running'
        : 'Stopped'
      : 'Installed'
  const installUnsupported = status?.install_supported === false
  const canUninstall = plugin.scope === 'ai-backends' || supervises
  const busy = installing || uninstalling || controlling || loggingIn !== null
  const versionText =
    present && status?.version
      ? plugin.scope === 'ai-backends'
        ? ` (${status.version})`
        : ` (v${status.version.replace(/^v/, '')})`
      : null

  const handleRefreshModels = useCallback(
    async (quiet = false) => {
      const toastId = quiet ? undefined : toast.loading('Reading models...')
      try {
        const models = await invokeForOptionalServer<{
          opus: string | null
          sonnet: string | null
          haiku: string | null
        }>(serverId, 'refresh_cliproxyapi_models')
        const names = [models.opus, models.sonnet, models.haiku].filter(Boolean)
        toast.success(`Models from CLIProxyAPI: ${names.join(', ')}`, {
          id: toastId,
        })
      } catch (error) {
        toast.error(`${error}`, { id: toastId })
      }
    },
    [serverId]
  )

  useEffect(() => {
    if (plugin.id !== 'cliproxyapi') return
    if (!cliLoginOpen && loginPending.current) {
      loginPending.current = false
      void checkStatus()
      void handleRefreshModels(true)
    }
  }, [cliLoginOpen, checkStatus, handleRefreshModels, plugin.id])

  const handleAccountLogin = useCallback(
    async (provider: 'claude' | 'codex') => {
      setLoggingIn(provider)
      const label = provider === 'claude' ? 'Claude' : 'Codex'
      const toastId = toast.loading(`Opening ${label} account login...`)
      try {
        const launch = await invokeForOptionalServer<AccountLoginLaunch>(
          serverId,
          'prepare_cliproxyapi_account_login',
          { provider }
        )
        toast.success(launch.message, { id: toastId })
        loginPending.current = true
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
        await checkStatus()
      }
    },
    [checkStatus, openCliLoginModal, serverId]
  )

  const handleOpenManagement = useCallback(async () => {
    const url = status?.management_url
    if (!url) return
    if (status?.running) {
      openExternal(url)
      return
    }
    setControlling(true)
    const toastId = toast.loading(`Starting ${plugin.name}...`)
    try {
      const message = await invokeForOptionalServer<string>(
        serverId,
        'start_opinionated_plugin',
        {
          pluginName: plugin.id,
        }
      )
      toast.success(message, { id: toastId })
      openExternal(url)
    } catch (error) {
      toast.error(`Failed to start ${plugin.name}: ${error}`, {
        id: toastId,
      })
    } finally {
      setControlling(false)
      await checkStatus()
    }
  }, [
    checkStatus,
    serverId,
    plugin.id,
    plugin.name,
    status?.management_url,
    status?.running,
  ])

  const handleUninstall = useCallback(async () => {
    setUninstalling(true)
    const toastId = toast.loading(`Uninstalling ${plugin.name}...`)

    try {
      const message = await invokeForOptionalServer<string>(
        serverId,
        'uninstall_opinionated_plugin',
        {
          pluginName: plugin.id,
        }
      )
      toast.success(message, { id: toastId })
    } catch (error) {
      toast.error(`Failed to uninstall ${plugin.name}: ${error}`, {
        id: toastId,
      })
    } finally {
      setUninstalling(false)
      await checkStatus()
    }
  }, [plugin.id, plugin.name, checkStatus, serverId])

  return (
    <ExtensionRow
      name={plugin.name}
      status={
        checking ? null : present ? (
          <Badge
            variant="success"
            title={`${statusLabel}${versionText ?? ''}`}
            className="w-auto min-w-0 max-w-full shrink justify-start gap-1 overflow-hidden"
          >
            <span className="shrink-0">{statusLabel}</span>
            {versionText && (
              <span className="min-w-0 truncate">{versionText}</span>
            )}
          </Badge>
        ) : (
          <Badge variant="subtle" className="max-w-full shrink">
            <span className="truncate">
              {installUnsupported ? 'Unsupported' : 'Not installed'}
            </span>
          </Badge>
        )
      }
      actions={
        checking ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : present ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Refresh ${plugin.name} status`}
              onClick={checkStatus}
              disabled={busy}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            {supervises && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  handleControl(status?.running ? 'stop' : 'start')
                }
                disabled={busy}
                className="flex-1 sm:flex-none"
              >
                {controlling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : status?.running ? (
                  <Square className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {status?.running ? 'Stop' : 'Start'}
              </Button>
            )}
            {plugin.scope === 'ai-backends' && (
              <Button
                variant={hasMissingBackend ? 'default' : 'outline'}
                size="sm"
                onClick={handleInstall}
                disabled={busy}
                className="flex-1 sm:flex-none"
              >
                {installing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {hasMissingBackend ? 'Reinstall' : 'Install again'}
              </Button>
            )}
            {canUninstall && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUninstall}
                disabled={busy}
                className="flex-1 sm:flex-none"
              >
                {uninstalling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Uninstall
              </Button>
            )}
          </>
        ) : installUnsupported && status?.unsupported_reason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex w-full cursor-not-allowed sm:w-auto">
                <Button
                  size="sm"
                  onClick={handleInstall}
                  disabled
                  className="pointer-events-none w-full sm:w-auto"
                >
                  Unsupported
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              {status.unsupported_reason}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            size="sm"
            onClick={handleInstall}
            disabled={busy || installUnsupported}
            className="w-full sm:w-auto"
          >
            {installUnsupported ? null : installing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {installUnsupported ? 'Unsupported' : 'Install'}
          </Button>
        )
      }
    >
      <div className="pt-1 space-y-1">
        <div className="text-2xs text-muted-foreground">
          Applies to:{' '}
          <span className="text-foreground/70">
            {plugin.backends.join(', ')}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{plugin.description}</p>
        {status?.unsupported_reason && (
          <p className="text-xs text-destructive">
            {status.unsupported_reason}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <ExtensionLink url={plugin.githubUrl} label="GitHub" />
          {plugin.links?.map(link => (
            <ExtensionLink key={link.url} url={link.url} label={link.label} />
          ))}
        </div>
        {supervises && status?.installed && (
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleAccountLogin('claude')}
                disabled={busy}
              >
                {loggingIn === 'claude' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                Add Claude account
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleAccountLogin('codex')}
                disabled={busy}
              >
                {loggingIn === 'codex' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                Add Codex account
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => handleRefreshModels()}
                disabled={busy}
              >
                <RefreshCw className="h-4 w-4" />
                Refresh models
              </Button>
              {status.management_url && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleOpenManagement}
                  disabled={busy}
                >
                  <ExternalLink className="h-4 w-4" />
                  Open management
                </Button>
              )}
            </div>
            {status.host && (
              <p className="text-xs text-muted-foreground">
                Runs on {status.host}. Chats on this machine connect to it at
                127.0.0.1.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {typeof status.auth_file_count === 'number'
                ? `${status.auth_file_count} account${
                    status.auth_file_count === 1 ? '' : 's'
                  } added.`
                : ''}
            </p>
          </div>
        )}
        {status?.lan_exposed && (
          <p className="text-xs text-destructive">
            This config is not bound to localhost. Jean will not widen the bind;
            edit config.yaml only if you intend to expose the proxy.
          </p>
        )}
      </div>

      {plugin.scope === 'ai-backends' && status?.backends && (
        <div className="border-t pt-3 space-y-2">
          <div className="text-xs font-medium text-foreground/80">
            Backend status
          </div>
          <div className="grid gap-1.5">
            {status.backends.map(backend => (
              <div
                key={backend.id}
                className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1.5 text-xs"
              >
                <span className="text-foreground/80">{backend.label}</span>
                <Badge
                  variant={backend.installed ? 'secondary' : 'outline'}
                  className="text-xs"
                >
                  {backend.installed ? 'Installed' : 'Not installed'}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {plugin.usage.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          <div className="text-xs font-medium text-foreground/80">
            How to use
          </div>
          <ul className="space-y-1.5">
            {plugin.usage.map(step => (
              <li
                key={step.command ?? step.label ?? step.note}
                className="text-xs text-muted-foreground space-y-1"
              >
                {step.note && <div>{step.note}</div>}
                {step.label && (
                  <div className="text-foreground/70">{step.label}:</div>
                )}
                {step.command && (
                  <code className="block rounded bg-muted px-2 py-1 font-mono text-2xs text-foreground">
                    {step.command}
                  </code>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </ExtensionRow>
  )
}

const PLUGIN_SECTIONS: {
  scope: PluginDefinition['scope']
  title: string
}[] = [
  { scope: 'local-proxy', title: 'Local proxy' },
  { scope: 'system-wide', title: 'System-wide (shell)' },
  { scope: 'ai-backends', title: 'AI backend skills' },
  { scope: 'claude-cli', title: 'Claude CLI plugin' },
]

export const OpinionatedPane: React.FC = () => {
  const [installedIds, setInstalledIds] = useState<Record<string, boolean>>({})
  const handleInstalledChange = useCallback(
    (pluginId: string, installed: boolean) =>
      setInstalledIds(prev =>
        prev[pluginId] === installed ? prev : { ...prev, [pluginId]: installed }
      ),
    []
  )

  // Installed plugins first; Array.sort is stable, so PLUGINS order is kept otherwise.
  const sections = PLUGIN_SECTIONS.map(section => ({
    ...section,
    plugins: PLUGINS.filter(plugin => plugin.scope === section.scope).sort(
      (a, b) => Number(!!installedIds[b.id]) - Number(!!installedIds[a.id])
    ),
  })).filter(section => section.plugins.length > 0)

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Recommended Plugins"
        description="Curated tools that enhance your development workflow across Jean AI backends."
        anchorId="pref-opinionated-section-recommended-plugins"
      >
        <div className="space-y-4">
          {sections.map(section => (
            <ExtensionGroup
              key={section.scope}
              id={`opinionated-plugins-${section.scope}`}
              title={section.title}
            >
              {section.plugins.map(plugin => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  onInstalledChange={handleInstalledChange}
                />
              ))}
            </ExtensionGroup>
          ))}
        </div>
      </SettingsSection>
    </div>
  )
}
