import React, { useEffect } from 'react'
import { CheckCircle, Loader2, ShieldAlert, XCircle } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { BackendLabel } from '@/components/ui/backend-label'
import { cn } from '@/lib/utils'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  useAllBackendsMcpServers,
  invalidateAllMcpServers,
  getNewServersToAutoEnable,
  useAllBackendsMcpHealth,
  groupServersByBackend,
  mcpKey,
  migrateLegacyMcpKeys,
} from '@/services/mcp'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useChatStore } from '@/store/chat-store'
import type { McpHealthStatus } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'
import { JeanMcpSection } from './JeanMcpSection'

function mcpAuthHint(backend: CliBackend): string {
  switch (backend) {
    case 'codex':
      return "Run 'codex mcp auth' in your terminal to authenticate"
    case 'opencode':
      return "Run 'opencode mcp auth' in your terminal to authenticate"
    case 'cursor':
      return "Run 'cursor-agent mcp login <server>' in your terminal to authenticate"
    case 'grok':
      return "Run 'grok mcp doctor <server>' or open /mcps in the Grok TUI to authenticate"
    default:
      return "Run 'claude /mcp' in your terminal to authenticate"
  }
}

function HealthIndicator({
  status,
  isChecking,
  backend,
}: {
  status: McpHealthStatus | undefined
  isChecking: boolean
  backend: CliBackend
}) {
  if (isChecking) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        checking...
      </span>
    )
  }

  if (!status) return null

  switch (status) {
    case 'connected':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="size-3.5" />
              connected
            </span>
          </TooltipTrigger>
          <TooltipContent>Server is connected and ready</TooltipContent>
        </Tooltip>
      )
    case 'needsAuthentication':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <ShieldAlert className="size-3.5" />
              needs auth
            </span>
          </TooltipTrigger>
          <TooltipContent>{mcpAuthHint(backend)}</TooltipContent>
        </Tooltip>
      )
    case 'couldNotConnect':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
              <XCircle className="size-3.5" />
              connection failed
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Could not connect -- check that the server is running
          </TooltipContent>
        </Tooltip>
      )
    case 'disabled':
      return null
    default:
      return null
  }
}

function jeanMcpMode(
  serverName: string,
  config: unknown
): 'dev' | 'prod' | null {
  if (serverName === 'jean-dev') return 'dev'
  if (serverName === 'jean') return 'prod'
  if (!config || typeof config !== 'object') return null
  const record = config as Record<string, unknown>
  const env =
    record.env && typeof record.env === 'object'
      ? (record.env as Record<string, unknown>)
      : record.environment && typeof record.environment === 'object'
        ? (record.environment as Record<string, unknown>)
        : null
  const mode = env?.JEAN_MCP_MODE
  return mode === 'dev' || mode === 'prod' ? mode : null
}

export const McpServersPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const { installedBackends } = useInstalledBackends()

  // Get worktree path for project-scope discovery
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const { data: mcpServers, isLoading } = useAllBackendsMcpServers(
    activeWorktreePath,
    installedBackends
  )

  // Health check — triggered on mount and when backends change
  const {
    statuses: healthStatuses,
    isFetching: isHealthChecking,
    refetchAll: checkHealth,
  } = useAllBackendsMcpHealth(installedBackends, activeWorktreePath)

  // Re-read MCP config from disk and trigger health check every time this pane is opened
  useEffect(() => {
    invalidateAllMcpServers(undefined, installedBackends)
    checkHealth()
  }, [checkHealth, installedBackends])

  const enabledServers = preferences?.default_enabled_mcp_servers ?? []
  const knownServers = preferences?.known_mcp_servers ?? []

  // Auto-enable newly discovered (non-disabled) servers, but not ones the user has previously disabled
  useEffect(() => {
    if (!preferences || !mcpServers) return

    // Migrate legacy bare-name keys to composite keys
    let currentEnabled = enabledServers
    let currentKnown = knownServers
    const enabledMigration = migrateLegacyMcpKeys(enabledServers, mcpServers)
    const knownMigration = migrateLegacyMcpKeys(knownServers, mcpServers)
    if (enabledMigration.changed) currentEnabled = enabledMigration.migrated
    if (knownMigration.changed) currentKnown = knownMigration.migrated

    const allServerKeys = mcpServers
      .filter(s => !s.disabled)
      .map(s => mcpKey(s.backend, s.name))
    const newServers = getNewServersToAutoEnable(
      mcpServers,
      currentEnabled,
      currentKnown
    )
    const updatedKnown = [...new Set([...currentKnown, ...allServerKeys])]
    const knownChanged = updatedKnown.length !== currentKnown.length

    if (
      newServers.length > 0 ||
      knownChanged ||
      enabledMigration.changed ||
      knownMigration.changed
    ) {
      patchPreferences.mutate({
        default_enabled_mcp_servers: [...currentEnabled, ...newServers],
        known_mcp_servers: updatedKnown,
      })
    }
  }, [mcpServers]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = (backend: CliBackend, serverName: string) => {
    if (!preferences) return
    const key = mcpKey(backend, serverName)
    const updated = enabledServers.includes(key)
      ? enabledServers.filter(n => n !== key)
      : [...enabledServers, key]
    patchPreferences.mutate({ default_enabled_mcp_servers: updated })
  }

  const grouped = groupServersByBackend(mcpServers ?? [])
  const backendsWithServers = installedBackends.filter(
    b => grouped[b] && grouped[b].length > 0
  )
  const showSectionHeaders = backendsWithServers.length > 1

  return (
    <div className="space-y-6">
      <JeanMcpSection />
      <SettingsSection
        title="Default MCP Servers"
        anchorId="pref-mcp-section-default-servers"
      >
        <p className="text-sm text-muted-foreground">
          Selected servers will be enabled by default in new sessions. You can
          override per-session from the toolbar.
        </p>

        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading MCP servers...
          </div>
        ) : !mcpServers || mcpServers.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground">
            No MCP servers found across installed backends.
          </div>
        ) : (
          <div className="space-y-4">
            {backendsWithServers.map(backend => (
              <div key={backend} className="space-y-2">
                {showSectionHeaders && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <BackendLabel backend={backend} />
                    </span>
                    <Separator className="flex-1" />
                  </div>
                )}
                {(grouped[backend] ?? []).map(server => (
                  <div
                    key={`${backend}-${server.name}`}
                    className={cn(
                      'flex items-center gap-3 rounded-md border px-4 py-3',
                      server.disabled && 'opacity-50'
                    )}
                  >
                    <Checkbox
                      id={`mcp-${backend}-${server.name}`}
                      checked={
                        !server.disabled &&
                        enabledServers.includes(mcpKey(backend, server.name))
                      }
                      onCheckedChange={() => handleToggle(backend, server.name)}
                      disabled={server.disabled}
                    />
                    <Label
                      htmlFor={`mcp-${backend}-${server.name}`}
                      className={cn(
                        'flex-1 text-sm font-medium',
                        server.disabled ? 'cursor-default' : 'cursor-pointer'
                      )}
                    >
                      {server.name}
                    </Label>
                    {jeanMcpMode(server.name, server.config) && (
                      <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                        {jeanMcpMode(server.name, server.config)}
                      </span>
                    )}
                    <HealthIndicator
                      status={healthStatuses[mcpKey(backend, server.name)]}
                      isChecking={isHealthChecking}
                      backend={backend}
                    />
                    <span className="text-xs text-muted-foreground">
                      {server.disabled ? 'disabled' : server.scope}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
