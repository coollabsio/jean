import React, { useCallback, useState } from 'react'
import { invoke } from '@/lib/transport'
import { openExternal } from '@/lib/platform'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  ExternalLink,
  Download,
  CheckCircle,
  Loader2,
  RefreshCw,
  ChevronRight,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { SettingsSection } from '../SettingsSection'

interface UsageStep {
  label?: string
  command?: string
  note?: string
}

interface PluginDefinition {
  id: string
  name: string
  description: string
  githubUrl: string
  usage: UsageStep[]
  scope: 'system-wide' | 'ai-backends' | 'claude-cli'
  backends: string[]
}

const PLUGINS: PluginDefinition[] = [
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
        note: "Installs through Caveman's unified installer where supported, then mirrors skills into each backend's CLI path (including ~/.grok/skills for Grok) plus Jean-global mirrors.",
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
]

interface PluginStatus {
  installed: boolean
  version: string | null
  install_supported?: boolean
  unsupported_reason?: string
  backends?: BackendPluginStatus[]
}

interface BackendPluginStatus {
  id: string
  label: string
  installed: boolean
}

function PluginCard({ plugin }: { plugin: PluginDefinition }) {
  const [status, setStatus] = useState<PluginStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const checkStatus = useCallback(async () => {
    setChecking(true)
    try {
      const result = await invoke<PluginStatus>(
        'check_opinionated_plugin_status',
        { pluginName: plugin.id }
      )
      setStatus(result)
    } catch {
      setStatus({ installed: false, version: null })
    } finally {
      setChecking(false)
    }
  }, [plugin.id])

  React.useEffect(() => {
    checkStatus()
  }, [checkStatus])

  const handleInstall = useCallback(async () => {
    setInstalling(true)
    const toastId = toast.loading(`Installing ${plugin.name}...`)

    try {
      const message = await invoke<string>('install_opinionated_plugin', {
        pluginName: plugin.id,
      })
      toast.success(message, { id: toastId })
      await checkStatus()
    } catch (error) {
      toast.error(`Failed to install ${plugin.name}: ${error}`, {
        id: toastId,
      })
    } finally {
      setInstalling(false)
    }
  }, [plugin.id, plugin.name, checkStatus])

  const hasMissingBackend =
    plugin.scope === 'ai-backends' &&
    (status?.backends?.some(backend => !backend.installed) ?? false)
  const statusLabel = hasMissingBackend ? 'Partial' : 'Installed'
  const installUnsupported = status?.install_supported === false

  const handleUninstall = useCallback(async () => {
    setUninstalling(true)
    const toastId = toast.loading(`Uninstalling ${plugin.name}...`)

    try {
      const message = await invoke<string>('uninstall_opinionated_plugin', {
        pluginName: plugin.id,
      })
      toast.success(message, { id: toastId })
      await checkStatus()
    } catch (error) {
      toast.error(`Failed to uninstall ${plugin.name}: ${error}`, {
        id: toastId,
      })
    } finally {
      setUninstalling(false)
    }
  }, [plugin.id, plugin.name, checkStatus])

  return (
    <div className="rounded-lg border">
      <div className="flex flex-col gap-2 px-3 py-2 hover:bg-muted/40 rounded-lg sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          className="min-w-0 w-full flex-1 flex flex-wrap items-center gap-2 text-left cursor-pointer"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
          />
          <Label className="text-sm font-medium text-foreground cursor-pointer">
            {plugin.name}
          </Label>
          {!checking && status?.installed && (
            <Badge
              variant="secondary"
              className="min-w-0 max-w-full gap-1 text-xs"
            >
              <CheckCircle className="h-3 w-3 text-green-500" />
              <span>{statusLabel}</span>
              {status.version &&
                (plugin.scope === 'ai-backends' ? (
                  <span className="hidden truncate sm:inline">
                    {' '}
                    ({status.version})
                  </span>
                ) : (
                  <span className="truncate"> (v{status.version})</span>
                ))}
            </Badge>
          )}
          {!checking && installUnsupported && (
            <Badge variant="outline" className="text-xs">
              Unsupported
            </Badge>
          )}
          <Badge variant="outline" className="max-w-full truncate text-xs">
            {plugin.scope === 'system-wide'
              ? 'System-wide (shell)'
              : plugin.scope === 'ai-backends'
                ? 'AI backend skills'
                : 'Claude CLI plugin'}
          </Badge>
        </button>
        <span className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0">
          {checking ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : status?.installed ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Refresh ${plugin.name} status`}
                onClick={checkStatus}
                disabled={installing || uninstalling}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              {plugin.scope === 'ai-backends' && (
                <Button
                  variant={hasMissingBackend ? 'default' : 'outline'}
                  size="sm"
                  onClick={handleInstall}
                  disabled={installing || uninstalling}
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
              {plugin.scope === 'ai-backends' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUninstall}
                  disabled={installing || uninstalling}
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
          ) : (
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={installing || uninstalling || installUnsupported}
              title={status?.unsupported_reason}
              className="w-full sm:w-auto"
            >
              {installUnsupported ? null : installing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {installUnsupported ? 'Unsupported' : 'Install'}
            </Button>
          )}
        </span>
      </div>
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t">
          <div className="pt-3 space-y-1">
            <div className="text-[11px] text-muted-foreground">
              Applies to:{' '}
              <span className="text-foreground/70">
                {plugin.backends.join(', ')}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {plugin.description}
            </p>
            {status?.unsupported_reason && (
              <p className="text-xs text-destructive">
                {status.unsupported_reason}
              </p>
            )}
            <button
              type="button"
              onClick={() => openExternal(plugin.githubUrl)}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline underline-offset-2 cursor-pointer"
            >
              <ExternalLink className="h-3 w-3" />
              GitHub
            </button>
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
                      <code className="block rounded bg-muted px-2 py-1 font-mono text-[11px] text-foreground">
                        {step.command}
                      </code>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const OpinionatedPane: React.FC = () => {
  return (
    <div className="space-y-6">
      <SettingsSection
        title="Recommended Plugins"
        description="Curated tools that enhance your development workflow across Jean AI backends."
        anchorId="pref-opinionated-section-recommended-plugins"
      >
        <div className="space-y-3">
          {PLUGINS.map(plugin => (
            <PluginCard key={plugin.id} plugin={plugin} />
          ))}
        </div>
      </SettingsSection>
    </div>
  )
}
