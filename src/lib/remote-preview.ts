/**
 * Point the desktop embedded browser at a remote host's ports.
 *
 * The webview runs on this computer. Loopback URLs (`localhost`, `127.0.0.1`,
 * `::1`, `0.0.0.0`) would otherwise open a server on the laptop. An SSH
 * profile forwards the remote loopback through the existing tunnel. A direct
 * Web Access profile rewrites the host to the remote connection's hostname.
 * The local connection is left unchanged.
 */

import { invoke } from '@/lib/transport'
import {
  getActiveRemoteConnection,
  subscribeRemoteConnections,
  type RemoteConnection,
} from '@/lib/remote-connections'
import { getSshTunnelRuntime } from '@/lib/ssh-tunnel'

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
])

export class RemotePreviewError extends Error {
  readonly remotePreview = true as const

  constructor(message: string) {
    super(message)
    this.name = 'RemotePreviewError'
  }
}

export function isRemotePreviewError(
  error: unknown
): error is RemotePreviewError {
  return (
    error instanceof Error &&
    (error as Partial<RemotePreviewError>).remotePreview === true
  )
}

export interface EmbeddedPreview {
  url: string
  /** Shown in the browser toolbar while the webview is aimed at the remote host. */
  note: string | null
}

export type PreviewPlan =
  | { kind: 'unchanged' }
  | { kind: 'direct'; url: string; note: string }
  | {
      kind: 'ssh'
      profileId: string
      sshHost: string
      remotePort: number
    }
  | { kind: 'error'; message: string }

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/\.$/, '')
  return LOOPBACK_HOSTS.has(value) || value.startsWith('127.')
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

export function previewUrlForLocalForward(
  raw: string,
  localPort: number
): string {
  return withHost(raw, '127.0.0.1', localPort)
}

export function sshPreviewNote(
  sshHost: string,
  remotePort: number,
  localPort: number
): string {
  return `Remote preview via SSH forward: ${sshHost} port ${remotePort} → 127.0.0.1:${localPort}.`
}

export function remotePreviewLoadError(
  url: string,
  note: string | null | undefined
): string | null {
  if (!note) return null
  return `Could not load ${url}. ${note} Start the server on the remote host, or confirm the port in jean.json.`
}

export function planRemotePreview(
  rawUrl: string,
  connection: RemoteConnection | null,
  tunnelStatus: string | null
): PreviewPlan {
  const parsed = parseHttpUrl(rawUrl)
  if (!parsed || !connection || !isLoopbackHost(parsed.hostname)) {
    return { kind: 'unchanged' }
  }

  if (connection.transport === 'ssh') {
    const tunnel = connection.sshTunnel
    if (!tunnel) {
      return {
        kind: 'error',
        message:
          'This SSH connection is missing tunnel settings, so Jean cannot preview the remote host.',
      }
    }
    const blocked = sshPreviewBlockedMessage(tunnelStatus, tunnel.host)
    if (blocked) return { kind: 'error', message: blocked }
    const remotePort = portOf(parsed)
    if (remotePort == null) {
      return {
        kind: 'error',
        message: 'Jean could not read a port from this preview URL.',
      }
    }
    return {
      kind: 'ssh',
      profileId: connection.id,
      sshHost: tunnel.host,
      remotePort,
    }
  }

  return planDirectPreview(rawUrl, parsed, connection)
}

export async function resolveEmbeddedPreviewUrl(
  rawUrl: string
): Promise<EmbeddedPreview> {
  const connection = getActiveRemoteConnection()
  const tunnelStatus =
    connection?.transport === 'ssh'
      ? (getSshTunnelRuntime(connection.id)?.status ?? null)
      : null
  const plan = planRemotePreview(rawUrl, connection, tunnelStatus)

  if (plan.kind === 'error') throw new RemotePreviewError(plan.message)

  if (plan.kind === 'ssh') {
    await releasePreviewForwards(plan.profileId)
    let forwarded: { localPort?: number }
    try {
      forwarded = await invoke<{ localPort?: number }>(
        'ensure_ssh_preview_forward',
        {
          profileId: plan.profileId,
          remotePort: plan.remotePort,
        }
      )
    } catch (error) {
      throw new RemotePreviewError(
        errorText(error) || `Could not forward remote port ${plan.remotePort}.`
      )
    }
    const localPort = forwarded?.localPort
    if (!Number.isInteger(localPort) || localPort == null || localPort < 1) {
      throw new RemotePreviewError(
        `Could not forward remote port ${plan.remotePort}.`
      )
    }
    return {
      url: previewUrlForLocalForward(rawUrl, localPort),
      note: sshPreviewNote(plan.sshHost, plan.remotePort, localPort),
    }
  }

  if (plan.kind === 'direct') {
    await releasePreviewForwards(null)
    return { url: plan.url, note: plan.note }
  }

  if (isLoopbackUrl(rawUrl)) {
    await releasePreviewForwards(null)
  }
  return { url: rawUrl, note: null }
}

export async function releasePreviewForwards(
  keepProfileId: string | null
): Promise<void> {
  try {
    await invoke('release_ssh_preview_forwards', { keepProfileId })
  } catch (error) {
    throw new RemotePreviewError(
      errorText(error) || 'Could not close the remote preview forward.'
    )
  }
}

/** Free preview forwards when the desktop leaves the SSH profile that owns them. */
export function watchRemotePreviewForwards(): () => void {
  let current = activeSshProfileId()
  return subscribeRemoteConnections(() => {
    const next = activeSshProfileId()
    if (next === current) return
    current = next
    void releasePreviewForwards(next).catch(error => {
      console.warn('[browser] failed to release remote preview forwards', error)
    })
  })
}

function activeSshProfileId(): string | null {
  const connection = getActiveRemoteConnection()
  if (connection?.transport !== 'ssh' || !connection.sshTunnel) return null
  return connection.id
}

function planDirectPreview(
  rawUrl: string,
  parsed: URL,
  connection: RemoteConnection
): PreviewPlan {
  let remote: URL
  try {
    remote = new URL(connection.url)
  } catch {
    return {
      kind: 'error',
      message:
        'This remote connection has an invalid URL, so Jean cannot choose a preview host.',
    }
  }
  if (isLoopbackHost(remote.hostname)) return { kind: 'unchanged' }
  const rewritten = withHost(rawUrl, remote.hostname, portOf(parsed))
  let shown = remote.hostname
  try {
    shown = new URL(rewritten).host
  } catch {
    shown = remote.hostname
  }
  const name = connection.name.trim() || remote.hostname
  return {
    kind: 'direct',
    url: rewritten,
    note: `Remote preview of ${name} at ${shown}.`,
  }
}

function sshPreviewBlockedMessage(
  status: string | null,
  host: string
): string | null {
  if (status === 'ready') return null
  if (status === 'connecting') {
    return `The SSH tunnel to ${host} is still connecting, so Jean cannot preview the remote host yet.`
  }
  if (status === 'reconnecting') {
    return `The SSH tunnel to ${host} is reconnecting, so Jean cannot preview the remote host yet. Try again when the tunnel is ready.`
  }
  return `The SSH tunnel to ${host} is not connected, so Jean cannot preview the remote host's localhost. Reconnect the tunnel and try again.`
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

function portOf(url: URL): number | null {
  if (url.port) {
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return port
  }
  if (url.protocol === 'http:') return 80
  if (url.protocol === 'https:') return 443
  return null
}

function withHost(raw: string, hostname: string, port: number | null): string {
  const url = new URL(raw)
  const keepSlash = raw.endsWith('/') || url.pathname !== '/'
  url.hostname = hostname
  if (port != null) url.port = String(port)
  const next = url.toString()
  if (!keepSlash && next.endsWith('/')) return next.slice(0, -1)
  return next
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error && error.message) return error.message
  if (error == null) return ''
  return String(error)
}
