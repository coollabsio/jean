import type { AgentConnector } from '@/services/agents'

/** Backends that take a per-session MCP server list. */
export const PER_SESSION_MCP_BACKENDS = ['claude', 'grok'] as const

/**
 * Backends whose `get_mcp_servers` reads that CLI's own files.
 * Pi and Command Code fall through to Claude's files, so they are omitted.
 */
export const OWN_MCP_DISCOVERY_BACKENDS = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'grok',
  'kimi',
  'antigravity',
  'muse',
] as const

export function hasOwnMcpDiscovery(backend: string): boolean {
  return (OWN_MCP_DISCOVERY_BACKENDS as readonly string[]).includes(backend)
}

export type McpSessionSupport = 'per-session' | 'unsupported' | 'unknown'

export type ConnectorStatus =
  | 'default'
  | 'enabled'
  | 'off'
  | 'needs-sign-in'
  | 'unsupported'

export function mcpSessionSupport(backend: string): McpSessionSupport {
  if (!backend) return 'unknown'
  return (PER_SESSION_MCP_BACKENDS as readonly string[]).includes(backend)
    ? 'per-session'
    : 'unsupported'
}

export function connectorKey(connector: AgentConnector): string {
  return `${connector.backend}\0${connector.name}`
}

function sortConnectors(
  list: AgentConnector[] | null
): AgentConnector[] | null {
  if (!list) return null
  return [...list].sort((left, right) =>
    connectorKey(left).localeCompare(connectorKey(right))
  )
}

export function sameConnectors(
  left: AgentConnector[] | null,
  right: AgentConnector[] | null
): boolean {
  return (
    JSON.stringify(sortConnectors(left)) ===
    JSON.stringify(sortConnectors(right))
  )
}

export function sameJeanTools(
  left: string[] | null,
  right: string[] | null
): boolean {
  const sort = (list: string[] | null) => (list ? [...list].sort() : null)
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right))
}

/**
 * `null` means no saved limit, so nothing is selected.
 * Turning a server on starts an allowlist with that server.
 * Turning the last server off keeps `[]`, which is a saved limit of none.
 */
export function toggleConnector(
  current: AgentConnector[] | null,
  server: AgentConnector,
  on: boolean
): AgentConnector[] | null {
  if (current === null && !on) return null
  const without = (current ?? []).filter(
    item => connectorKey(item) !== connectorKey(server)
  )
  if (!on) return without
  return [...without, { backend: server.backend, name: server.name }]
}

export function connectorSelected(
  current: AgentConnector[] | null,
  server: AgentConnector
): boolean {
  if (!current) return false
  return current.some(item => connectorKey(item) === connectorKey(server))
}

export function connectorStatus(options: {
  support: McpSessionSupport
  limited: boolean
  selected: boolean
  health?: string
}): ConnectorStatus {
  if (options.support === 'unsupported') return 'unsupported'
  if (options.health === 'needsAuthentication') return 'needs-sign-in'
  if (!options.limited) return 'default'
  return options.selected ? 'enabled' : 'off'
}

export function connectorStatusLabel(status: ConnectorStatus): string {
  switch (status) {
    case 'enabled':
      return 'Enabled'
    case 'off':
      return 'Off'
    case 'needs-sign-in':
      return 'Needs sign-in'
    case 'unsupported':
      return 'Unsupported on this backend'
    case 'default':
      return 'Default'
  }
}

export function connectorSectionNote(
  support: McpSessionSupport,
  backend: string,
  reason?: string
): string {
  if (support === 'unknown') {
    return 'No backend is saved for this agent. A connector limit is applied only when the session backend is Claude or Grok. Other backends keep their own MCP config.'
  }
  if (support === 'per-session') {
    return 'Saving a limit makes this backend pass only the connectors you turn on, plus Jean MCP, on every turn including background wakes. With no saved limit, those wakes do not add these connectors, and a chat can still send the session’s own MCP servers.'
  }
  const why = reason?.trim()
  return why
    ? `${why} The switches are saved and are not applied on ${backend}.`
    : `${backend} cannot apply a per-agent connector limit. The switches are saved and are not applied.`
}

/** `null` allows every tool, including ones added later. */
export function jeanToolSelected(
  current: string[] | null,
  tool: string
): boolean {
  if (current === null) return true
  return current.includes(tool)
}

/**
 * Turning a tool off while the limit is unset snapshots the catalog minus
 * that tool. Selecting every catalog tool again clears the limit.
 */
export function toggleJeanTool(
  current: string[] | null,
  tool: string,
  catalog: readonly string[],
  on: boolean
): string[] | null {
  const base = new Set(current ?? catalog)
  if (on) base.add(tool)
  else base.delete(tool)
  const catalogSet = new Set(catalog)
  const selected = catalog.filter(name => base.has(name))
  const extras = [...base].filter(name => !catalogSet.has(name)).sort()
  if (selected.length === catalog.length && extras.length === 0) return null
  return [...selected, ...extras]
}
