import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { isTauri } from '@/services/projects'
import { queryClient } from '@/lib/query-client'
import type { McpServerInfo, McpHealthResult, McpHealthStatus } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'

/** Query key prefix for MCP server queries */
export const MCP_SERVERS_KEY = 'mcp-servers'

/**
 * Invalidate MCP server queries so they are re-fetched from disk.
 * If worktreePath is provided, only that specific query is invalidated.
 * Otherwise all mcp-servers queries are invalidated.
 */
export function invalidateMcpServers(
  worktreePath?: string | null,
  backend?: CliBackend
) {
  if (worktreePath && backend) {
    queryClient.invalidateQueries({
      queryKey: [MCP_SERVERS_KEY, worktreePath, backend],
    })
  } else if (worktreePath) {
    queryClient.invalidateQueries({
      queryKey: [MCP_SERVERS_KEY, worktreePath],
    })
  } else {
    queryClient.invalidateQueries({ queryKey: [MCP_SERVERS_KEY] })
  }
}

/** Invalidate all MCP server queries for all given backends */
export function invalidateAllMcpServers(
  worktreePath?: string | null,
  backends?: CliBackend[]
) {
  if (backends && worktreePath) {
    for (const b of backends) {
      invalidateMcpServers(worktreePath, b)
    }
  } else {
    queryClient.invalidateQueries({ queryKey: [MCP_SERVERS_KEY] })
  }
}

/**
 * Fetch available MCP servers for the given backend.
 * Reads from backend-specific config files:
 * - Claude:   ~/.claude.json + .mcp.json
 * - Codex:    ~/.codex/config.toml + .codex/config.toml
 * - OpenCode: ~/.config/opencode/opencode.json + opencode.json
 */
export function useMcpServers(
  worktreePath: string | null | undefined,
  backend: CliBackend = 'claude'
) {
  return useQuery({
    queryKey: [MCP_SERVERS_KEY, worktreePath ?? '', backend],
    queryFn: async () => {
      if (!isTauri()) return []
      return invoke<McpServerInfo[]>('get_mcp_servers', {
        backend,
        worktreePath: worktreePath ?? null,
      })
    },
    enabled: isTauri(),
    staleTime: 1000 * 60 * 5, // 5 min cache
  })
}

/**
 * Fetch MCP servers from ALL installed backends and merge results.
 * Each server has a `backend` field indicating which backend it belongs to.
 */
export function useAllBackendsMcpServers(
  worktreePath: string | null | undefined,
  installedBackends: CliBackend[]
) {
  const claude = useMcpServers(
    worktreePath,
    'claude'
  )
  const codex = useMcpServers(
    worktreePath,
    'codex'
  )
  const opencode = useMcpServers(
    worktreePath,
    'opencode'
  )

  const has = useMemo(
    () => new Set(installedBackends),
    [installedBackends]
  )

  const servers = useMemo(() => {
    const result: McpServerInfo[] = []
    if (has.has('claude') && claude.data) result.push(...claude.data)
    if (has.has('codex') && codex.data) result.push(...codex.data)
    if (has.has('opencode') && opencode.data) result.push(...opencode.data)
    return result
  }, [has, claude.data, codex.data, opencode.data])

  const isLoading =
    (has.has('claude') && claude.isLoading) ||
    (has.has('codex') && codex.isLoading) ||
    (has.has('opencode') && opencode.isLoading)

  return { data: servers, isLoading }
}

/** Query key for MCP health check */
export const MCP_HEALTH_KEY = 'mcp-health'

/**
 * Check health status of all MCP servers via the backend's CLI.
 * Manual trigger only (enabled: false) — call refetch() to run.
 * Results are cached for 30s to avoid redundant health checks.
 */
export function useMcpHealthCheck(backend: CliBackend = 'claude') {
  return useQuery({
    queryKey: [MCP_HEALTH_KEY, backend],
    queryFn: async () => {
      if (!isTauri()) return { statuses: {} } as McpHealthResult
      return invoke<McpHealthResult>('check_mcp_health', { backend })
    },
    enabled: false,
    staleTime: 30_000,
    retry: 1,
  })
}

/**
 * Check health across ALL installed backends, merging statuses.
 * Returns merged statuses and a combined refetch function.
 */
export function useAllBackendsMcpHealth(installedBackends: CliBackend[]) {
  const claude = useMcpHealthCheck('claude')
  const codex = useMcpHealthCheck('codex')
  const opencode = useMcpHealthCheck('opencode')

  const has = useMemo(
    () => new Set(installedBackends),
    [installedBackends]
  )

  const statuses = useMemo(() => {
    const merged: Record<string, McpHealthStatus> = {}
    if (has.has('claude') && claude.data?.statuses) {
      Object.assign(merged, claude.data.statuses)
    }
    if (has.has('codex') && codex.data?.statuses) {
      Object.assign(merged, codex.data.statuses)
    }
    if (has.has('opencode') && opencode.data?.statuses) {
      Object.assign(merged, opencode.data.statuses)
    }
    return merged
  }, [has, claude.data, codex.data, opencode.data])

  const isFetching =
    (has.has('claude') && claude.isFetching) ||
    (has.has('codex') && codex.isFetching) ||
    (has.has('opencode') && opencode.isFetching)

  const refetchAll = useMemo(
    () => () => {
      if (has.has('claude')) claude.refetch()
      if (has.has('codex')) codex.refetch()
      if (has.has('opencode')) opencode.refetch()
    },
    [has, claude.refetch, codex.refetch, opencode.refetch] // eslint-disable-line react-hooks/exhaustive-deps
  )

  return { statuses, isFetching, refetchAll }
}

/**
 * Find newly discovered MCP servers that should be auto-enabled.
 * Returns server names that are: (1) not disabled in config,
 * (2) not already in the current enabled list, and
 * (3) not in the known servers list (i.e., truly new, not user-disabled).
 *
 * This allows newly added MCP servers to be automatically activated
 * without requiring the user to manually enable each one, while
 * respecting servers the user has explicitly disabled.
 */
export function getNewServersToAutoEnable(
  allServers: McpServerInfo[],
  currentEnabled: string[],
  knownServers: string[]
): string[] {
  const enabledSet = new Set(currentEnabled)
  const knownSet = new Set(knownServers)
  return allServers
    .filter(
      s => !s.disabled && !enabledSet.has(s.name) && !knownSet.has(s.name)
    )
    .map(s => s.name)
}

/**
 * Build the --mcp-config JSON string from enabled server names.
 * Returns undefined if no servers are enabled.
 *
 * When `backend` is provided, only servers belonging to that backend are included.
 * This prevents cross-backend server configs from being sent to the wrong CLI
 * (e.g., a Codex server config being passed to Claude's --mcp-config).
 */
export function buildMcpConfigJson(
  allServers: McpServerInfo[],
  enabledNames: string[],
  backend?: string
): string | undefined {
  if (enabledNames.length === 0) return undefined

  const mcpServers: Record<string, unknown> = {}
  for (const name of enabledNames) {
    const server = allServers.find(
      s => s.name === name && (!backend || s.backend === backend)
    )
    if (server) mcpServers[name] = server.config
  }

  if (Object.keys(mcpServers).length === 0) return undefined
  return JSON.stringify({ mcpServers })
}

/** Backend display labels */
export const BACKEND_LABELS: Record<CliBackend, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
}

/** Group servers by their backend field */
export function groupServersByBackend(
  servers: McpServerInfo[]
): Record<string, McpServerInfo[]> {
  const groups: Record<string, McpServerInfo[]> = {}
  for (const server of servers) {
    const key = server.backend || 'claude'
    if (!groups[key]) groups[key] = []
    groups[key].push(server)
  }
  return groups
}
