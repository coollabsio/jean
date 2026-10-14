import { SettingsSection } from '@/components/preferences/SettingsSection'
import { useEffect, useMemo } from 'react'
import {
  CheckCircle,
  Loader2,
  ShieldAlert,
  XCircle,
} from '@/components/icons/reicon'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { BackendLabel } from '@/components/ui/backend-label'
import { cn } from '@/lib/utils'
import { useProjects, useUpdateProjectSettings } from '@/services/projects'
import {
  useAllBackendsMcpServers,
  invalidateAllMcpServers,
  getNewServersToAutoEnable,
  useAllBackendsMcpHealth,
  groupServersByBackend,
  mcpKey,
  isRequiredMcpServer,
  migrateLegacyMcpKeys,
} from '@/services/mcp'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { parseServerResourceKey } from '@/lib/server-resource'
import { McpSignInButton } from '@/components/mcp/McpSignInButton'
import type { McpHealthStatus } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'

function mcpAuthHint(backend: CliBackend): string {
  switch (backend) {
    case 'codex':
      return 'Use Sign in to connect this server'
    case 'opencode':
      return "Run 'opencode mcp auth' in your terminal to authenticate"
    case 'cursor':
      return "Run 'cursor-agent mcp login <server>' in your terminal to authenticate"
    case 'grok':
      return "Run 'grok mcp doctor <server>' or open /mcps in the Grok TUI to authenticate"
    default:
      return 'Use Sign in to connect this server'
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
    return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  }
  if (!status) return null

  switch (status) {
    case 'authenticated':
    case 'connected':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={
                status === 'authenticated' ? 'Signed in' : 'Connected'
              }
            >
              <CheckCircle className="size-3.5 text-success" />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {status === 'authenticated'
              ? 'Signed in. The connection is checked when a chat starts.'
              : 'Server is connected and ready'}
          </TooltipContent>
        </Tooltip>
      )
    case 'needsAuthentication':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span role="img" aria-label="Needs authentication">
              <ShieldAlert className="size-3.5 text-warning" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{mcpAuthHint(backend)}</TooltipContent>
        </Tooltip>
      )
    case 'couldNotConnect':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span role="img" aria-label="Connection failed">
              <XCircle className="size-3.5 text-destructive" />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Could not connect -- check that the server is running
          </TooltipContent>
        </Tooltip>
      )
    default:
      return null
  }
}

export function McpServersPane({
  projectId,
  projectPath,
}: {
  projectId: string
  projectPath: string
}) {
  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === projectId)
  const serverId = parseServerResourceKey(projectId)?.serverId ?? 'local'
  const { installedBackends } = useInstalledBackends({ serverId })

  const { data: mcpServers = [], isLoading: mcpLoading } =
    useAllBackendsMcpServers(projectPath, installedBackends, serverId)

  const {
    statuses: healthStatuses,
    isFetching: isHealthChecking,
    refetchAll: checkHealth,
  } = useAllBackendsMcpHealth(installedBackends, projectPath, serverId)

  const updateSettings = useUpdateProjectSettings()

  // Re-read MCP config and trigger health check on mount / backend change
  useEffect(() => {
    invalidateAllMcpServers(projectPath, installedBackends)
    checkHealth()
  }, [projectPath, checkHealth, installedBackends])

  // Auto-enable newly discovered servers (but not ones the user has previously disabled)
  const enabledServers = useMemo(
    () => project?.enabled_mcp_servers ?? [],
    [project?.enabled_mcp_servers]
  )
  const knownServers = useMemo(
    () => project?.known_mcp_servers ?? [],
    [project?.known_mcp_servers]
  )

  useEffect(() => {
    if (!mcpServers.length) return

    // Migrate legacy bare-name keys to composite keys
    let currentEnabled = enabledServers
    let currentKnown = knownServers
    const enabledMigration = migrateLegacyMcpKeys(enabledServers, mcpServers)
    const knownMigration = migrateLegacyMcpKeys(knownServers, mcpServers)
    if (enabledMigration.changed) currentEnabled = enabledMigration.migrated
    if (knownMigration.changed) currentKnown = knownMigration.migrated

    const allServerKeys = mcpServers.flatMap(s =>
      s.disabled ? [] : [mcpKey(s.backend, s.name)]
    )
    const newServers = getNewServersToAutoEnable(
      mcpServers,
      currentEnabled,
      currentKnown
    )
    // Always update known servers to include all current server keys
    const updatedKnown = [...new Set([...currentKnown, ...allServerKeys])]
    const knownChanged = updatedKnown.length !== currentKnown.length

    // Don't auto-enable if user explicitly disabled all servers (empty array).
    // null/undefined = not configured yet (inherit global), [] = explicitly all off.
    const hasExplicitEmpty =
      Array.isArray(project?.enabled_mcp_servers) &&
      project.enabled_mcp_servers.length === 0
    const serversToAdd = hasExplicitEmpty ? [] : newServers

    if (
      serversToAdd.length > 0 ||
      enabledMigration.changed ||
      knownMigration.changed
    ) {
      updateSettings.mutate({
        projectId,
        enabledMcpServers: [...currentEnabled, ...serversToAdd],
        knownMcpServers: updatedKnown,
      })
    } else if (knownChanged) {
      updateSettings.mutate({
        projectId,
        knownMcpServers: updatedKnown,
      })
    }
  }, [mcpServers]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = (backend: CliBackend, serverName: string) => {
    const current = project?.enabled_mcp_servers ?? []
    const key = mcpKey(backend, serverName)
    const updated = current.includes(key)
      ? current.filter(n => n !== key)
      : [...current, key]
    updateSettings.mutate({ projectId, enabledMcpServers: updated })
  }

  const selectedServersSet = useMemo(
    () => new Set(project?.enabled_mcp_servers ?? []),
    [project?.enabled_mcp_servers]
  )
  const grouped = groupServersByBackend(mcpServers)
  const backendsWithServers = installedBackends.filter(
    b => grouped[b] && grouped[b].length > 0
  )
  const showSectionHeaders = backendsWithServers.length > 1

  return (
    <div className="space-y-6">
      <SettingsSection title="MCP Servers">
        <p className="text-xs text-muted-foreground">
          Servers enabled by default for sessions in this project. Antigravity
          loads its configured servers automatically.
        </p>

        {mcpLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading servers...
          </div>
        ) : mcpServers.length === 0 ? (
          <div className="py-2 text-sm text-muted-foreground">
            No MCP servers found
          </div>
        ) : (
          <div className="space-y-3">
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
                      'flex flex-wrap items-center gap-3 rounded-md border px-3 py-2',
                      server.disabled && 'opacity-50'
                    )}
                  >
                    <Checkbox
                      id={`proj-mcp-${backend}-${server.name}`}
                      checked={
                        !server.disabled &&
                        (backend === 'antigravity' ||
                          selectedServersSet.has(mcpKey(backend, server.name)))
                      }
                      onCheckedChange={() => handleToggle(backend, server.name)}
                      disabled={
                        server.disabled ||
                        backend === 'antigravity' ||
                        isRequiredMcpServer(server.name)
                      }
                    />
                    <Label
                      htmlFor={`proj-mcp-${backend}-${server.name}`}
                      className={cn(
                        'min-w-0 flex-1 break-words text-sm',
                        server.disabled ? 'cursor-default' : 'cursor-pointer'
                      )}
                    >
                      {server.name}
                    </Label>
                    <HealthIndicator
                      status={healthStatuses[mcpKey(backend, server.name)]}
                      isChecking={isHealthChecking}
                      backend={backend}
                    />
                    {!server.disabled &&
                      healthStatuses[mcpKey(backend, server.name)] ===
                        'needsAuthentication' && (
                        <McpSignInButton
                          backend={backend}
                          serverName={server.name}
                          worktreePath={projectPath}
                          serverId={serverId}
                        />
                      )}
                    <span className="text-xs text-muted-foreground">
                      {server.disabled
                        ? 'disabled'
                        : backend === 'antigravity' ||
                            isRequiredMcpServer(server.name)
                          ? 'automatic'
                          : server.scope}
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
