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
import { cn } from '@/lib/utils'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  useAllBackendsMcpServers,
  invalidateAllMcpServers,
  getNewServersToAutoEnable,
  useAllBackendsMcpHealth,
  groupServersByBackend,
  BACKEND_LABELS,
} from '@/services/mcp'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useChatStore } from '@/store/chat-store'
import type { McpHealthStatus } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

function mcpAuthHint(backend: CliBackend): string {
  switch (backend) {
    case 'codex':
      return "Run 'codex mcp auth' in your terminal to authenticate"
    case 'opencode':
      return "Run 'opencode mcp auth' in your terminal to authenticate"
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
  } = useAllBackendsMcpHealth(installedBackends)

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
    const allServerNames = mcpServers.filter(s => !s.disabled).map(s => s.name)
    const newServers = getNewServersToAutoEnable(
      mcpServers,
      enabledServers,
      knownServers
    )
    const updatedKnown = [...new Set([...knownServers, ...allServerNames])]
    const knownChanged = updatedKnown.length !== knownServers.length
    if (newServers.length > 0 || knownChanged) {
      patchPreferences.mutate({
        default_enabled_mcp_servers: [...enabledServers, ...newServers],
        known_mcp_servers: updatedKnown,
      })
    }
  }, [mcpServers]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = (serverName: string) => {
    if (!preferences) return
    const updated = enabledServers.includes(serverName)
      ? enabledServers.filter(n => n !== serverName)
      : [...enabledServers, serverName]
    patchPreferences.mutate({ default_enabled_mcp_servers: updated })
  }

  const grouped = groupServersByBackend(mcpServers ?? [])
  const backendsWithServers = installedBackends.filter(
    b => grouped[b] && grouped[b].length > 0
  )
  const showSectionHeaders = backendsWithServers.length > 1

  return (
    <div className="space-y-6">
      <SettingsSection title="Default MCP Servers">
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
                      {BACKEND_LABELS[backend]}
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
                        !server.disabled && enabledServers.includes(server.name)
                      }
                      onCheckedChange={() => handleToggle(server.name)}
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
                    <HealthIndicator
                      status={healthStatuses[server.name]}
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
