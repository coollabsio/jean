import { useSyncExternalStore } from 'react'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import { generateId } from './uuid'

export const LOCAL_CONNECTION_ID = LOCAL_SERVER_ID

const CONNECTIONS_KEY = 'jean-remote-connections'
const ACTIVE_CONNECTION_KEY = 'jean-active-connection'
const SWITCHING_CONNECTION_KEY = 'jean-switching-connection-at'
const LOCAL_DASHBOARD_ENABLED_KEY = 'jean-local-dashboard-enabled'

/**
 * Persisted URL for SSH-tunnel profiles. Traffic uses the runtime local
 * forward (`http://127.0.0.1:<port>`) and must never fetch this placeholder.
 */
export const SSH_TUNNEL_PLACEHOLDER_URL = 'http://127.0.0.1'

export type RemoteTransport = 'direct' | 'ssh'

export interface SshTunnelSettings {
  user: string
  host: string
  /** SSH port. Omitted when it is the default 22. */
  port?: number
  identityFile?: string
  /** Remote bind address the forward targets. Default 127.0.0.1. */
  remoteHost?: string
  /** jean-server port on the remote loopback. Default 3456. */
  remotePort?: number
  hostKeyFingerprint: string
  /** Local port reserved for this profile. Omitted until the tunnel allocates one. */
  localPort?: number
  /** Missing means reconnect on startup. */
  autoConnect?: boolean
}

export interface RemoteConnection {
  id: string
  name: string
  url: string
  token: string
  /** Missing on legacy profiles; missing means enabled. */
  enabled?: boolean
  /** Missing means a direct Web Access URL. */
  transport?: RemoteTransport
  sshTunnel?: SshTunnelSettings
  /** SSH profiles keep the access token in the OS secret store. */
  tokenInSecretStore?: boolean
  /** SSH user for local editors that open remote paths (Zed `ssh://`). */
  sshUser?: string
  /** SSH host/IP; falls back to Web Access URL hostname when omitted. */
  sshHost?: string
  /** SSH port (default 22 when omitted). */
  sshPort?: number
}

export interface SshRemoteConnectionInput {
  id?: string
  name: string
  /** Kept in memory only. The OS secret store is the persisted copy. */
  token?: string
  user: string
  host: string
  sshPort?: number
  identityFile?: string
  remoteHost?: string
  remotePort?: number
  hostKeyFingerprint: string
  localPort?: number
  autoConnect?: boolean
}

export interface RemoteConnectionInput {
  name: string
  url: string
  token: string
  sshUser?: string
  sshHost?: string
  sshPort?: number
}

/** Parse a user-entered SSH port string; empty → undefined. Throws on invalid. */
export function parseOptionalSshPort(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH port must be an integer between 1 and 65535.')
  }
  return port
}

const subscribers = new Set<() => void>()
const sshTokens = new Map<string, string>()

interface SshProfileLifecycle {
  onRemoved?: (id: string) => void
}

let sshProfileLifecycle: SshProfileLifecycle = {}

/** Desktop tunnel supervisor hooks profile removal without a module cycle. */
export function setSshProfileLifecycle(next: SshProfileLifecycle): void {
  sshProfileLifecycle = next
}

export function rememberSshToken(id: string, token: string): void {
  if (!token) return
  sshTokens.set(id, token)
  let changed = false
  const next = connectionsSnapshot.map(connection => {
    if (connection.id !== id || connection.transport !== 'ssh') return connection
    if (connection.token === token) return connection
    changed = true
    return { ...connection, token }
  })
  if (!changed) return
  connectionsSnapshot = next
  for (const subscriber of subscribers) subscriber()
}

export function isSshConnection(
  connection: RemoteConnection
): connection is RemoteConnection & { sshTunnel: SshTunnelSettings } {
  return connection.transport === 'ssh' && connection.sshTunnel !== undefined
}

let connectionsSnapshot: RemoteConnection[] = readConnections()
const savedActiveConnection =
  storage()?.getItem(ACTIVE_CONNECTION_KEY) || LOCAL_CONNECTION_ID
let activeConnectionSnapshot =
  savedActiveConnection === LOCAL_CONNECTION_ID ||
  connectionsSnapshot.some(
    connection => connection.id === savedActiveConnection
  )
    ? savedActiveConnection
    : LOCAL_CONNECTION_ID
let localDashboardEnabledSnapshot =
  storage()?.getItem(LOCAL_DASHBOARD_ENABLED_KEY) !== 'false'

function storage(): Storage | null {
  return typeof globalThis.localStorage === 'undefined'
    ? null
    : globalThis.localStorage
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeOptionalPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < 1 || value > 65535) return undefined
  return value
}

function normalizeSshTunnel(
  value: unknown
): SshTunnelSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const user = normalizeOptionalString(record.user)
  const host = normalizeOptionalString(record.host)
  const hostKeyFingerprint = normalizeOptionalString(record.hostKeyFingerprint)
  if (!user || !host || !hostKeyFingerprint) return undefined

  const tunnel: SshTunnelSettings = { user, host, hostKeyFingerprint }
  const port = normalizeOptionalPort(record.port)
  const identityFile = normalizeOptionalString(record.identityFile)
  const remoteHost = normalizeOptionalString(record.remoteHost)
  const remotePort = normalizeOptionalPort(record.remotePort)
  const localPort = normalizeOptionalPort(record.localPort)
  if (port && port !== 22) tunnel.port = port
  if (identityFile) tunnel.identityFile = identityFile
  if (remoteHost) tunnel.remoteHost = remoteHost
  if (remotePort) tunnel.remotePort = remotePort
  if (localPort) tunnel.localPort = localPort
  if (record.autoConnect === false) tunnel.autoConnect = false
  return tunnel
}

function normalizeConnection(item: unknown): RemoteConnection | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.url !== 'string' ||
    typeof record.token !== 'string'
  ) {
    return null
  }

  const connection: RemoteConnection = {
    id: record.id,
    name: record.name,
    url: record.url,
    token: record.token,
    enabled: record.enabled !== false,
  }

  if (record.transport === 'ssh') {
    const sshTunnel = normalizeSshTunnel(record.sshTunnel)
    if (!sshTunnel) return null
    connection.transport = 'ssh'
    connection.sshTunnel = sshTunnel
    connection.tokenInSecretStore = true
    connection.token = sshTokens.get(connection.id) ?? ''
    connection.url = SSH_TUNNEL_PLACEHOLDER_URL
    connection.sshUser = sshTunnel.user
    connection.sshHost = sshTunnel.host
    if (sshTunnel.port) connection.sshPort = sshTunnel.port
    return connection
  }

  const sshUser = normalizeOptionalString(record.sshUser)
  const sshHost = normalizeOptionalString(record.sshHost)
  const sshPort = normalizeOptionalPort(record.sshPort)
  if (sshUser) connection.sshUser = sshUser
  if (sshHost) connection.sshHost = sshHost
  if (sshPort) connection.sshPort = sshPort

  return connection
}

function readConnections(): RemoteConnection[] {
  const raw = storage()?.getItem(CONNECTIONS_KEY)
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeConnection)
      .filter((item): item is RemoteConnection => item !== null)
  } catch {
    return []
  }
}

function sshFieldsFromInput(input: RemoteConnectionInput): {
  sshUser?: string
  sshHost?: string
  sshPort?: number
} {
  const fields: {
    sshUser?: string
    sshHost?: string
    sshPort?: number
  } = {}
  const sshUser = normalizeOptionalString(input.sshUser)
  const sshHost = normalizeOptionalString(input.sshHost)
  const sshPort = normalizeOptionalPort(input.sshPort)
  if (sshUser) fields.sshUser = sshUser
  if (sshHost) fields.sshHost = sshHost
  // Only persist non-default ports; 22 is implied when omitted.
  if (sshPort && sshPort !== 22) fields.sshPort = sshPort
  return fields
}

function persistedConnection(connection: RemoteConnection): RemoteConnection {
  if (connection.transport !== 'ssh') return connection
  return {
    ...connection,
    token: '',
    url: SSH_TUNNEL_PLACEHOLDER_URL,
    tokenInSecretStore: true,
  }
}

function writeConnections(connections: RemoteConnection[]): void {
  connectionsSnapshot = connections.map(connection => {
    if (connection.transport !== 'ssh') return connection
    const token = connection.token || sshTokens.get(connection.id) || ''
    if (token) sshTokens.set(connection.id, token)
    return {
      ...connection,
      token,
      url: SSH_TUNNEL_PLACEHOLDER_URL,
      tokenInSecretStore: true,
    }
  })
  storage()?.setItem(
    CONNECTIONS_KEY,
    JSON.stringify(connectionsSnapshot.map(persistedConnection))
  )
  for (const subscriber of subscribers) subscriber()
}

function sshSettingsFromInput(
  input: SshRemoteConnectionInput
): SshTunnelSettings {
  const user = input.user.trim()
  const host = input.host.trim()
  const fingerprint = input.hostKeyFingerprint.trim()
  if (!user || !host) {
    throw new Error('SSH user and host are required.')
  }
  if (!fingerprint) {
    throw new Error('Confirm the SSH host key before saving this connection.')
  }
  const sshPort = normalizeOptionalPort(input.sshPort)
  const remotePort = normalizeOptionalPort(input.remotePort)
  const localPort = normalizeOptionalPort(input.localPort)
  const identityFile = normalizeOptionalString(input.identityFile)
  const remoteHost = normalizeOptionalString(input.remoteHost)
  const tunnel: SshTunnelSettings = {
    user,
    host,
    hostKeyFingerprint: fingerprint,
  }
  if (sshPort && sshPort !== 22) tunnel.port = sshPort
  if (identityFile) tunnel.identityFile = identityFile
  if (remoteHost && remoteHost !== '127.0.0.1') tunnel.remoteHost = remoteHost
  if (remotePort && remotePort !== 3456) tunnel.remotePort = remotePort
  if (localPort) tunnel.localPort = localPort
  if (input.autoConnect === false) tunnel.autoConnect = false
  return tunnel
}

function connectionFromSshInput(
  id: string,
  input: SshRemoteConnectionInput,
  enabled: boolean
): RemoteConnection {
  const sshTunnel = sshSettingsFromInput(input)
  return {
    id,
    name: input.name.trim() || sshTunnel.host,
    url: SSH_TUNNEL_PLACEHOLDER_URL,
    token: input.token?.trim() || sshTokens.get(id) || '',
    enabled,
    transport: 'ssh',
    tokenInSecretStore: true,
    sshTunnel,
    sshUser: sshTunnel.user,
    sshHost: sshTunnel.host,
    ...(sshTunnel.port ? { sshPort: sshTunnel.port } : {}),
  }
}

export function parseRemoteConnectionInput(
  rawUrl: string,
  rawToken: string
): { url: string; token: string } {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS URL.')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Enter an HTTP or HTTPS URL.')
  }

  const token =
    rawToken.trim() || parsed.searchParams.get('token')?.trim() || ''
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  return { url: parsed.toString().replace(/\/$/, ''), token }
}

export function getRemoteConnections(): RemoteConnection[] {
  return connectionsSnapshot
}

export function addRemoteConnection(
  input: RemoteConnectionInput
): RemoteConnection {
  const normalized = parseRemoteConnectionInput(input.url, input.token)
  const connection: RemoteConnection = {
    id: generateId(),
    name: input.name.trim() || new URL(normalized.url).hostname,
    enabled: true,
    ...normalized,
    ...sshFieldsFromInput(input),
  }
  writeConnections([...getRemoteConnections(), connection])
  return connection
}

export function addSshRemoteConnection(
  input: SshRemoteConnectionInput
): RemoteConnection {
  const id = input.id?.trim() || generateId()
  const connection = connectionFromSshInput(id, input, true)
  writeConnections([...getRemoteConnections(), connection])
  return (
    getRemoteConnections().find(item => item.id === id) ?? connection
  )
}

export function updateSshRemoteConnection(
  id: string,
  input: SshRemoteConnectionInput
): RemoteConnection {
  const existing = getRemoteConnections().find(
    connection => connection.id === id
  )
  if (!existing) {
    throw new Error('Remote connection not found.')
  }
  const updated = connectionFromSshInput(
    id,
    input,
    existing.enabled !== false
  )
  writeConnections(
    getRemoteConnections().map(connection =>
      connection.id === id ? updated : connection
    )
  )
  return getRemoteConnections().find(item => item.id === id) ?? updated
}

export function setSshTunnelLocalPort(id: string, localPort: number): void {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    return
  }
  const existing = getRemoteConnections().find(
    connection => connection.id === id
  )
  if (!existing?.sshTunnel || existing.sshTunnel.localPort === localPort) return
  writeConnections(
    getRemoteConnections().map(connection =>
      connection.id === id && connection.sshTunnel
        ? {
            ...connection,
            sshTunnel: { ...connection.sshTunnel, localPort },
          }
        : connection
    )
  )
}

export function updateRemoteConnection(
  id: string,
  input: RemoteConnectionInput
): RemoteConnection {
  const normalized = parseRemoteConnectionInput(input.url, input.token)
  const existing = getRemoteConnections().find(
    connection => connection.id === id
  )
  if (!existing) {
    throw new Error('Remote connection not found.')
  }
  const updated: RemoteConnection = {
    id,
    name: input.name.trim() || new URL(normalized.url).hostname,
    enabled: existing.enabled !== false,
    ...normalized,
    ...sshFieldsFromInput(input),
  }
  const connections = getRemoteConnections()
  writeConnections(
    connections.map(connection => (connection.id === id ? updated : connection))
  )
  return updated
}

export function getEnabledServerConnections(): RemoteConnection[] {
  return getRemoteConnections().filter(
    connection => connection.enabled !== false
  )
}

export function setRemoteConnectionEnabled(id: string, enabled: boolean): void {
  const connections = getRemoteConnections()
  if (!connections.some(connection => connection.id === id)) {
    throw new Error('Remote connection not found.')
  }
  writeConnections(
    connections.map(connection =>
      connection.id === id ? { ...connection, enabled } : connection
    )
  )
  if (!enabled && getActiveConnectionId() === id) {
    selectConnection(LOCAL_CONNECTION_ID)
  }
}

export function getLocalDashboardEnabled(): boolean {
  return localDashboardEnabledSnapshot
}

export function setLocalDashboardEnabled(enabled: boolean): void {
  storage()?.setItem(LOCAL_DASHBOARD_ENABLED_KEY, String(enabled))
  if (localDashboardEnabledSnapshot === enabled) return
  localDashboardEnabledSnapshot = enabled
  for (const subscriber of subscribers) subscriber()
}

export function removeRemoteConnection(id: string): void {
  const existing = getRemoteConnections().find(
    connection => connection.id === id
  )
  writeConnections(
    getRemoteConnections().filter(connection => connection.id !== id)
  )
  sshTokens.delete(id)
  if (existing?.transport === 'ssh') sshProfileLifecycle.onRemoved?.(id)
  if (getActiveConnectionId() === id) selectConnection(LOCAL_CONNECTION_ID)
}

export function getActiveConnectionId(): string {
  return activeConnectionSnapshot
}

export function getActiveRemoteConnection(): RemoteConnection | null {
  const activeId = getActiveConnectionId()
  if (activeId === LOCAL_CONNECTION_ID) return null
  return (
    getRemoteConnections().find(connection => connection.id === activeId) ??
    null
  )
}

export function selectConnection(id: string): void {
  const selected =
    id === LOCAL_CONNECTION_ID ||
    getRemoteConnections().some(connection => connection.id === id)
      ? id
      : LOCAL_CONNECTION_ID
  activeConnectionSnapshot = selected
  storage()?.setItem(ACTIVE_CONNECTION_KEY, selected)
  for (const subscriber of subscribers) subscriber()
}

/** Native Jean always uses its local core; remote profiles are parallel adapters. */
export function selectLocalConnectionForNativeClient(native: boolean): void {
  if (native && getActiveConnectionId() !== LOCAL_CONNECTION_ID) {
    selectConnection(LOCAL_CONNECTION_ID)
  }
}

export function markConnectionSwitch(): void {
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem(SWITCHING_CONNECTION_KEY, String(Date.now()))
  }
}

export function isConnectionSwitchPending(): boolean {
  if (typeof window === 'undefined') return false
  const switchedAt = Number(
    window.sessionStorage.getItem(SWITCHING_CONNECTION_KEY) ?? 0
  )
  return switchedAt > 0 && Date.now() - switchedAt < 30_000
}

export function clearConnectionSwitch(): void {
  if (typeof window !== 'undefined') {
    window.sessionStorage.removeItem(SWITCHING_CONNECTION_KEY)
  }
}

export function useRemoteConnections(): RemoteConnection[] {
  return useSyncExternalStore(
    callback => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    () => connectionsSnapshot,
    () => []
  )
}

export function useActiveConnectionId(): string {
  return useSyncExternalStore(
    callback => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    () => activeConnectionSnapshot,
    () => LOCAL_CONNECTION_ID
  )
}

export function useLocalDashboardEnabled(): boolean {
  return useSyncExternalStore(
    callback => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    () => localDashboardEnabledSnapshot,
    () => true
  )
}

export function subscribeRemoteConnections(callback: () => void): () => void {
  subscribers.add(callback)
  return () => subscribers.delete(callback)
}
