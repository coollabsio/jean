import { useSyncExternalStore } from 'react'
import { generateId } from './uuid'

export const LOCAL_CONNECTION_ID = 'local'

const CONNECTIONS_KEY = 'jean-remote-connections'
const ACTIVE_CONNECTION_KEY = 'jean-active-connection'
const SWITCHING_CONNECTION_KEY = 'jean-switching-connection-at'

export interface RemoteConnection {
  id: string
  name: string
  url: string
  token: string
  /** SSH user for local editors that open remote paths (Zed `ssh://`). */
  sshUser?: string
  /** SSH host/IP; falls back to Web Access URL hostname when omitted. */
  sshHost?: string
  /** SSH port (default 22 when omitted). */
  sshPort?: number
}

export interface RemoteConnectionInput {
  name: string
  url: string
  token: string
  sshUser?: string
  sshHost?: string
  sshPort?: number
}

const subscribers = new Set<() => void>()
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

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage
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

function writeConnections(connections: RemoteConnection[]): void {
  connectionsSnapshot = connections
  storage()?.setItem(CONNECTIONS_KEY, JSON.stringify(connections))
  for (const subscriber of subscribers) subscriber()
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
    ...normalized,
    ...sshFieldsFromInput(input),
  }
  writeConnections([...getRemoteConnections(), connection])
  return connection
}

export function updateRemoteConnection(
  id: string,
  input: RemoteConnectionInput
): RemoteConnection {
  const normalized = parseRemoteConnectionInput(input.url, input.token)
  const updated: RemoteConnection = {
    id,
    name: input.name.trim() || new URL(normalized.url).hostname,
    ...normalized,
    ...sshFieldsFromInput(input),
  }
  const connections = getRemoteConnections()
  if (!connections.some(connection => connection.id === id)) {
    throw new Error('Remote connection not found.')
  }
  writeConnections(
    connections.map(connection => (connection.id === id ? updated : connection))
  )
  return updated
}

export function removeRemoteConnection(id: string): void {
  writeConnections(
    getRemoteConnections().filter(connection => connection.id !== id)
  )
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
