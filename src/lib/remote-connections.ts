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
}

export interface RemoteConnectionInput {
  name: string
  url: string
  token: string
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

function readConnections(): RemoteConnection[] {
  const raw = storage()?.getItem(CONNECTIONS_KEY)
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is RemoteConnection =>
        typeof item?.id === 'string' &&
        typeof item?.name === 'string' &&
        typeof item?.url === 'string' &&
        typeof item?.token === 'string'
    )
  } catch {
    return []
  }
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
