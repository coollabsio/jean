import React, { useEffect, useMemo } from 'react'
import { CheckCircle, Loader2, ShieldAlert, XCircle } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useProjects, useUpdateProjectSettings } from '@/services/projects'
import {
  useAllBackendsMcpServers,
  invalidateAllMcpServers,
  getNewServersToAutoEnable,
  useAllBackendsMcpHealth,
  groupServersByBackend,
  BACKEND_LABELS,
} from '@/services/mcp'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
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
    return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  }
  if (!status) return null

  switch (status) {
    case 'connected':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <CheckCircle className="size-3.5 text-green-600 dark:text-green-400" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Server is connected and ready</TooltipContent>
        </Tooltip>
      )
    case 'needsAuthentication':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-400" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{mcpAuthHint(backend)}</TooltipContent>
        </Tooltip>
      )
    case 'couldNotConnect':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <XCircle className="size-3.5 text-red-600 dark:text-red-400" />
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
  const { installedBackends } = useInstalledBackends()

  const { data: mcpServers = [], isLoading: mcpLoading } =
    useAllBackendsMcpServers(projectPath, installedBackends)

  const {
    statuses: healthStatuses,
    isFetching: isHealthChecking,
    refetchAll: checkHealth,
  } = useAllBackendsMcpHealth(installedBackends)

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
    const allServerNames = mcpServers.filter(s => !s.disabled).map(s => s.name)
    const newServers = getNewServersToAutoEnable(
      mcpServers,
      enabledServers,
      knownServers
    )
    // Always update known servers to include all current server names
    const updatedKnown = [...new Set([...knownServers, ...allServerNames])]
    const knownChanged = updatedKnown.length !== knownServers.length

    // Don't auto-enable if user explicitly disabled all servers (empty array).
    // null/undefined = not configured yet (inherit global), [] = explicitly all off.
    const hasExplicitEmpty =
      Array.isArray(project?.enabled_mcp_servers) &&
      project.enabled_mcp_servers.length === 0
    const serversToAdd = hasExplicitEmpty ? [] : newServers

    if (serversToAdd.length > 0) {
      updateSettings.mutate({
        projectId,
        enabledMcpServers: [...enabledServers, ...serversToAdd],
        knownMcpServers: updatedKnown,
      })
    } else if (knownChanged) {
      updateSettings.mutate({
        projectId,
        knownMcpServers: updatedKnown,
      })
    }
  }, [mcpServers]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = (serverName: string) => {
    const current = project?.enabled_mcp_servers ?? []
    const updated = current.includes(serverName)
      ? current.filter(n => n !== serverName)
      : [...current, serverName]
    updateSettings.mutate({ projectId, enabledMcpServers: updated })
  }

  const selectedServers = project?.enabled_mcp_servers ?? []
  const grouped = groupServersByBackend(mcpServers)
  const backendsWithServers = installedBackends.filter(
    b => grouped[b] && grouped[b].length > 0
  )
  const showSectionHeaders = backendsWithServers.length > 1

  return (
    <div className="space-y-6">
      <SettingsSection title="MCP Servers">
        <p className="text-xs text-muted-foreground">
          Servers enabled by default for sessions in this project
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
                      {BACKEND_LABELS[backend]}
                    </span>
                    <Separator className="flex-1" />
                  </div>
                )}
                {(grouped[backend] ?? []).map(server => (
                  <div
                    key={`${backend}-${server.name}`}
                    className={cn(
                      'flex items-center gap-3 rounded-md border px-3 py-2',
                      server.disabled && 'opacity-50'
                    )}
                  >
                    <Checkbox
                      id={`proj-mcp-${backend}-${server.name}`}
                      checked={
                        !server.disabled &&
                        selectedServers.includes(server.name)
                      }
                      onCheckedChange={() => handleToggle(server.name)}
                      disabled={server.disabled}
                    />
                    <Label
                      htmlFor={`proj-mcp-${backend}-${server.name}`}
                      className={cn(
                        'flex-1 text-sm',
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
