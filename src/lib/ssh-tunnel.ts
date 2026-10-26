/**
 * Desktop supervisor client for Jean-managed SSH local forwards.
 *
 * The Rust process owns `ssh -N` lifetime, reconnect, and cleanup. This module
 * hydrates tokens into memory, starts tunnels for enabled profiles, and
 * publishes the loopback URL the WebSocket transport should use.
 */

import { isNativeApp } from './environment'
import {
  getRemoteConnections,
  isSshConnection,
  rememberSshToken,
  setSshProfileLifecycle,
  setSshTunnelLocalPort,
  type RemoteConnection,
  type SshTunnelSettings,
} from './remote-connections'
import {
  setSshTransportEndpoint,
  type SshTransportEndpoint,
} from './ssh-tunnel-endpoint'

export type SshTunnelPhase =
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'stopped'

export interface SshTunnelRuntime {
  profileId: string
  status: SshTunnelPhase | string
  localUrl: string | null
  localPort: number | null
  error: string | null
  attempt: number
}

export interface SshHostKeyPreview {
  host: string
  canonicalHost: string
  port: number
  keyType: string
  publicKey: string
  fingerprint: string
}

const subscribers = new Set<() => void>()
const statuses = new Map<string, SshTunnelRuntime>()
const failedSpecKeys = new Map<string, string>()
let eventsStarted = false
let unlistenEvents: (() => void) | undefined
let reconcileQueue: Promise<void> = Promise.resolve()

function notify(): void {
  publishEndpoints()
  for (const subscriber of subscribers) subscriber()
}

export function subscribeSshTunnels(callback: () => void): () => void {
  subscribers.add(callback)
  return () => subscribers.delete(callback)
}

export function getSshTunnelRuntime(
  profileId: string
): SshTunnelRuntime | undefined {
  return statuses.get(profileId)
}

export function getSshTunnelRuntimes(): SshTunnelRuntime[] {
  return [...statuses.values()]
}

function applyStatus(status: SshTunnelRuntime): void {
  statuses.set(status.profileId, status)
  if (status.localPort && status.localPort > 0) {
    setSshTunnelLocalPort(status.profileId, status.localPort)
  }
  if (status.status === 'failed') {
    const profile = getRemoteConnections().find(
      connection => connection.id === status.profileId
    )
    if (
      profile &&
      isSshConnection(profile) &&
      !failedSpecKeys.has(profile.id)
    ) {
      failedSpecKeys.set(profile.id, specKey(profile.sshTunnel))
    }
    return
  }
  if (status.status !== 'stopped') failedSpecKeys.delete(status.profileId)
}

function publishEndpoints(): void {
  const live = new Set<string>()
  for (const connection of getRemoteConnections()) {
    if (!isSshConnection(connection)) continue
    const endpoint = endpointFor(connection)
    if (!endpoint) continue
    live.add(connection.id)
    setSshTransportEndpoint(connection.id, endpoint)
  }
  for (const [id] of statuses) {
    if (!live.has(id)) setSshTransportEndpoint(id, null)
  }
}

function endpointFor(
  connection: RemoteConnection & { sshTunnel: SshTunnelSettings }
): SshTransportEndpoint | null {
  const status = statuses.get(connection.id)
  if (!status?.localUrl || !connection.token) return null
  if (status.status !== 'ready' && status.status !== 'reconnecting') return null
  return { url: status.localUrl, token: connection.token }
}

export function getTransportConnections(): RemoteConnection[] {
  return getRemoteConnections().flatMap(connection => {
    if (connection.enabled === false) return []
    if (!isSshConnection(connection)) return [connection]
    const endpoint = endpointFor(connection)
    if (!endpoint) return []
    return [{ ...connection, url: endpoint.url, token: endpoint.token }]
  })
}

function specKey(tunnel: SshTunnelSettings): string {
  return JSON.stringify([
    tunnel.user,
    tunnel.host,
    tunnel.port ?? 22,
    tunnel.identityFile ?? '',
    tunnel.remoteHost ?? '127.0.0.1',
    tunnel.remotePort ?? 3456,
    tunnel.hostKeyFingerprint,
  ])
}

function startArgs(connection: RemoteConnection & { sshTunnel: SshTunnelSettings }) {
  const tunnel = connection.sshTunnel
  return {
    profileId: connection.id,
    user: tunnel.user,
    host: tunnel.host,
    sshPort: tunnel.port ?? 22,
    identityFile: tunnel.identityFile ?? null,
    remoteHost: tunnel.remoteHost ?? '127.0.0.1',
    remotePort: tunnel.remotePort ?? 3456,
    localPort: tunnel.localPort ?? null,
    hostKeyFingerprint: tunnel.hostKeyFingerprint,
  }
}

async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export async function hydrateSshSecrets(profileIds?: string[]): Promise<void> {
  if (!isNativeApp()) return
  const ids =
    profileIds ??
    getRemoteConnections()
      .filter(isSshConnection)
      .map(connection => connection.id)
  if (ids.length === 0) return
  const loaded = await invokeDesktop<{ profileId: string; token: string }[]>(
    'load_ssh_profile_secrets',
    { profileIds: ids }
  )
  for (const secret of loaded) {
    rememberSshToken(secret.profileId, secret.token)
  }
  publishEndpoints()
}

export async function refreshSshTunnelStatus(): Promise<void> {
  if (!isNativeApp()) return
  const listed = await invokeDesktop<SshTunnelRuntime[]>('list_ssh_tunnel_status')
  statuses.clear()
  for (const status of listed) applyStatus(status)
  notify()
}

export async function reconcileSshTunnels(): Promise<void> {
  reconcileQueue = reconcileQueue.then(reconcileOnce).catch(() => undefined)
  return reconcileQueue
}

async function reconcileOnce(): Promise<void> {
  if (!isNativeApp()) return
  const profileIds = new Set(
    getRemoteConnections().filter(isSshConnection).map(profile => profile.id)
  )
  let listed: SshTunnelRuntime[] = []
  try {
    listed = await invokeDesktop<SshTunnelRuntime[]>('list_ssh_tunnel_status')
  } catch {
    listed = [...statuses.values()]
  }
  for (const status of listed) {
    applyStatus(status)
    const profile = getRemoteConnections().find(
      item => item.id === status.profileId
    )
    if (
      !profile ||
      !isSshConnection(profile) ||
      profile.enabled === false ||
      profile.sshTunnel.autoConnect === false
    ) {
      if (!profile) failedSpecKeys.delete(status.profileId)
      try {
        await invokeDesktop('stop_ssh_tunnel', { profileId: status.profileId })
      } catch {
        // The supervisor is already stopped.
      }
      if (!profile) {
        try {
          await invokeDesktop('delete_ssh_profile_secret', {
            profileId: status.profileId,
          })
        } catch {
          // Missing secrets are already gone.
        }
        statuses.delete(status.profileId)
        setSshTransportEndpoint(status.profileId, null)
      }
    }
  }

  for (const profileId of profileIds) {
    const profile = getRemoteConnections().find(
      connection => connection.id === profileId
    )
    if (!profile || !isSshConnection(profile)) continue
    if (profile.enabled === false || profile.sshTunnel.autoConnect === false) {
      continue
    }
    const key = specKey(profile.sshTunnel)
    if (failedSpecKeys.get(profile.id) === key) continue
    try {
      const status = await invokeDesktop<SshTunnelRuntime>(
        'start_ssh_tunnel',
        startArgs(profile)
      )
      applyStatus(status)
    } catch {
      failedSpecKeys.set(profile.id, key)
    }
  }

  for (const id of [...statuses.keys()]) {
    if (!profileIds.has(id)) statuses.delete(id)
  }
  notify()
}

export async function retrySshTunnel(profileId: string): Promise<void> {
  failedSpecKeys.delete(profileId)
  await reconcileSshTunnels()
}

async function forgetSshProfile(profileId: string): Promise<void> {
  failedSpecKeys.delete(profileId)
  statuses.delete(profileId)
  setSshTransportEndpoint(profileId, null)
  notify()
  if (!isNativeApp()) return
  try {
    await invokeDesktop('stop_ssh_tunnel', { profileId })
  } catch {
    // Already stopped.
  }
  try {
    await invokeDesktop('delete_ssh_profile_secret', { profileId })
  } catch {
    // Already deleted.
  }
}

export async function startSshTunnelEvents(): Promise<void> {
  if (!isNativeApp() || eventsStarted) return
  eventsStarted = true
  const { listen } = await import('@tauri-apps/api/event')
  unlistenEvents = await listen<SshTunnelRuntime>('ssh-tunnel:status', event => {
    applyStatus(event.payload)
    notify()
  })
}

export function stopSshTunnelEvents(): void {
  eventsStarted = false
  unlistenEvents?.()
  unlistenEvents = undefined
}

setSshProfileLifecycle({
  onRemoved: id => {
    void forgetSshProfile(id)
  },
})
