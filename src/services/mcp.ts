import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { isTauri } from '@/services/projects'
import { queryClient } from '@/lib/query-client'
import type {
  McpServerInfo,
  McpHealthResult,
  McpHealthStatus,
} from '@/types/chat'
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
 * - Cursor:   ~/.cursor/mcp.json + .cursor/mcp.json
 * - Grok:     ~/.grok/config.toml + project .grok/config.toml (+ Claude/Cursor/.mcp.json compat)
 * - Kimi:     ~/.kimi-code/mcp.json + project .kimi-code/mcp.json
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
  const claude = useMcpServers(worktreePath, 'claude')
  const codex = useMcpServers(worktreePath, 'codex')
  const opencode = useMcpServers(worktreePath, 'opencode')
  const cursor = useMcpServers(worktreePath, 'cursor')
  const grok = useMcpServers(worktreePath, 'grok')
  const kimi = useMcpServers(worktreePath, 'kimi')

  const has = useMemo(() => new Set(installedBackends), [installedBackends])

  const servers = useMemo(() => {
    const result: McpServerInfo[] = []
    if (has.has('claude') && claude.data) result.push(...claude.data)
    if (has.has('codex') && codex.data) result.push(...codex.data)
    if (has.has('opencode') && opencode.data) result.push(...opencode.data)
    if (has.has('cursor') && cursor.data) result.push(...cursor.data)
    if (has.has('grok') && grok.data) result.push(...grok.data)
    if (has.has('kimi') && kimi.data) result.push(...kimi.data)
    return result
  }, [has, claude.data, codex.data, cursor.data, grok.data, kimi.data, opencode.data])

  const isLoading =
    (has.has('claude') && claude.isLoading) ||
    (has.has('codex') && codex.isLoading) ||
    (has.has('opencode') && opencode.isLoading) ||
    (has.has('cursor') && cursor.isLoading) ||
    (has.has('grok') && grok.isLoading) ||
    (has.has('kimi') && kimi.isLoading)

  return { data: servers, isLoading }
}

/** Query key for MCP health check */
export const MCP_HEALTH_KEY = 'mcp-health'

/**
 * Check health status of all MCP servers via the backend's CLI.
 * Manual trigger only (enabled: false) — call refetch() to run.
 * Results are cached for 30s to avoid redundant health checks.
 */
export function useMcpHealthCheck(
  backend: CliBackend = 'claude',
  worktreePath?: string | null
) {
  return useQuery({
    queryKey: [MCP_HEALTH_KEY, backend, worktreePath ?? ''],
    queryFn: async () => {
      if (!isTauri()) return { statuses: {} } as McpHealthResult
      return invoke<McpHealthResult>('check_mcp_health', {
        backend,
        worktreePath: worktreePath ?? null,
      })
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
export function useAllBackendsMcpHealth(
  installedBackends: CliBackend[],
  worktreePath?: string | null
) {
  const claude = useMcpHealthCheck('claude', worktreePath)
  const codex = useMcpHealthCheck('codex', worktreePath)
  const opencode = useMcpHealthCheck('opencode', worktreePath)
  const cursor = useMcpHealthCheck('cursor', worktreePath)
  const grok = useMcpHealthCheck('grok', worktreePath)
  const kimi = useMcpHealthCheck('kimi', worktreePath)

  const has = useMemo(() => new Set(installedBackends), [installedBackends])

  const statuses = useMemo(() => {
    const merged: Record<string, McpHealthStatus> = {}
    const entries: [CliBackend, typeof claude][] = [
      ['claude', claude],
      ['codex', codex],
      ['opencode', opencode],
      ['cursor', cursor],
      ['grok', grok],
      ['kimi', kimi],
    ]
    for (const [backend, query] of entries) {
      if (has.has(backend) && query.data?.statuses) {
        for (const [name, status] of Object.entries(query.data.statuses)) {
          merged[mcpKey(backend, name)] = status
        }
      }
    }
    return merged
  }, [has, claude.data, codex.data, cursor.data, grok.data, kimi.data, opencode.data])

  const isFetching =
    (has.has('claude') && claude.isFetching) ||
    (has.has('codex') && codex.isFetching) ||
    (has.has('opencode') && opencode.isFetching) ||
    (has.has('cursor') && cursor.isFetching) ||
    (has.has('grok') && grok.isFetching) ||
    (has.has('kimi') && kimi.isFetching)

  const refetchAll = useMemo(
    () => () => {
      if (has.has('claude')) claude.refetch()
      if (has.has('codex')) codex.refetch()
      if (has.has('opencode')) opencode.refetch()
      if (has.has('cursor')) cursor.refetch()
      if (has.has('grok')) grok.refetch()
      if (has.has('kimi')) kimi.refetch()
    },
    [has, claude.refetch, codex.refetch, cursor.refetch, grok.refetch, kimi.refetch, opencode.refetch] // eslint-disable-line react-hooks/exhaustive-deps
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
    .filter(s => {
      const key = mcpKey(s.backend, s.name)
      return !s.disabled && !enabledSet.has(key) && !knownSet.has(key)
    })
    .map(s => mcpKey(s.backend, s.name))
}

/**
 * Build the --mcp-config JSON string from enabled server names.
 * Returns undefined if no servers are enabled.
 *
 * When `backend` is provided, only servers belonging to that backend are included.
 * This prevents cross-backend server configs from being sent to the wrong CLI
 * (e.g., a Codex server config being passed to Claude's --mcp-config).
 * Cursor consumes the enabled server names indirectly from this JSON and syncs
 * its own CLI approval state before launch.
 */
export function buildMcpConfigJson(
  allServers: McpServerInfo[],
  enabledNames: string[],
  backend?: string
): string | undefined {
  if (enabledNames.length === 0) return undefined

  const mcpServers: Record<string, unknown> = {}
  for (const key of enabledNames) {
    const parsed = parseMcpKey(key)
    const serverName = parsed.name
    // If composite key specifies a backend, skip if it doesn't match the target
    if (parsed.backend && backend && parsed.backend !== backend) continue
    const server = allServers.find(
      s => s.name === serverName && (!backend || s.backend === backend)
    )
    if (server) mcpServers[serverName] = server.config
  }

  if (Object.keys(mcpServers).length === 0) return undefined
  return JSON.stringify({ mcpServers })
}

// ── Composite key helpers ──────────────────────────────────────────────
// MCP servers are identified by "backend:name" composite keys to avoid
// collisions when different backends have servers with the same name.

/** Create a composite key for an MCP server: "backend:name" */
export function mcpKey(backend: string, name: string): string {
  return `${backend}:${name}`
}

/** Parse a composite key back into backend + name. Legacy bare names return empty backend. */
export function parseMcpKey(key: string): { backend: string; name: string } {
  const idx = key.indexOf(':')
  if (idx === -1) return { backend: '', name: key }
  return { backend: key.slice(0, idx), name: key.slice(idx + 1) }
}

/**
 * Migrate legacy bare-name keys to composite keys.
 * For each bare name, expands to all backends that have a server with that name.
 * Returns the migrated array and whether any changes were made.
 */
export function migrateLegacyMcpKeys(
  keys: string[],
  allServers: McpServerInfo[]
): { migrated: string[]; changed: boolean } {
  const result: string[] = []
  let changed = false
  for (const key of keys) {
    if (key.includes(':')) {
      result.push(key)
      continue
    }
    // Legacy bare name — expand to all backends that have this server
    const matches = allServers.filter(s => s.name === key)
    if (matches.length > 0) {
      for (const s of matches) result.push(mcpKey(s.backend, s.name))
    } else {
      result.push(mcpKey('claude', key)) // fallback: assume claude
    }
    changed = true
  }
  return { migrated: [...new Set(result)], changed }
}

/** Backend display labels */
export const BACKEND_LABELS: Record<CliBackend, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  pi: 'PI',
  commandcode: 'Command Code',
  grok: 'Grok',
  kimi: 'Kimi Code',
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
