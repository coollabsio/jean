import React, { useCallback, useState } from 'react'
import { invoke } from '@/lib/transport'
import { openExternal } from '@/lib/platform'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  ExternalLink,
  Download,
  CheckCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'

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
  scope: 'system-wide' | 'claude-cli'
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
      'Claude Code skill that reduces output tokens by ~65-75% through terse, caveman-style communication while maintaining technical accuracy.',
    githubUrl: 'https://github.com/JuliusBrussee/caveman',
    scope: 'claude-cli',
    backends: ['Claude'],
    usage: [
      {
        note: 'Auto-activates in Claude Code. Takes effect on your next prompt — each new prompt spawns a fresh Claude process that picks up the plugin.',
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
]

interface PluginStatus {
  installed: boolean
  version: string | null
}

const SettingsSection: React.FC<{
  title: string
  description?: string
  children: React.ReactNode
}> = ({ title, description, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground mt-1">{description}</p>
      )}
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

function PluginCard({ plugin }: { plugin: PluginDefinition }) {
  const [status, setStatus] = useState<PluginStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)

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

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-start gap-4">
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Label className="text-sm font-medium text-foreground">
              {plugin.name}
            </Label>
            {!checking && status?.installed && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <CheckCircle className="h-3 w-3 text-green-500" />
                Installed
                {status.version && ` (v${status.version})`}
              </Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {plugin.scope === 'system-wide'
                ? 'System-wide (shell)'
                : 'Claude CLI plugin'}
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Applies to:{' '}
            <span className="text-foreground/70">
              {plugin.backends.join(', ')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{plugin.description}</p>
          <button
            onClick={() => openExternal(plugin.githubUrl)}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline underline-offset-2 cursor-pointer"
          >
            <ExternalLink className="h-3 w-3" />
            GitHub
          </button>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {checking ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : status?.installed ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={checkStatus}
              disabled={installing}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="sm" onClick={handleInstall} disabled={installing}>
              {installing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Install
            </Button>
          )}
        </div>
      </div>

      {plugin.usage.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          <div className="text-xs font-medium text-foreground/80">
            How to use
          </div>
          <ul className="space-y-1.5">
            {plugin.usage.map((step, idx) => (
              <li key={idx} className="text-xs text-muted-foreground space-y-1">
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
  )
}

export const OpinionatedPane: React.FC = () => {
  return (
    <div className="space-y-6">
      <SettingsSection
        title="Recommended Plugins"
        description="Curated tools that enhance your development workflow with Claude."
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
