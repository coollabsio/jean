import { useSyncExternalStore } from 'react'
import { isNativeApp } from './environment'
import type { RemoteConnection } from './remote-connections'
import { WsTransport } from './transport'
import { decorateServerEvent } from './server-command-routing'
import type { ServerId } from '@/types/server-resource'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import type {
  FeatureSurfaceManifestEntry,
  ServerCapabilitiesEnvelope,
} from '@/types/server-capabilities'

const CLIENT_API_PROTOCOL = 1

export type ServerConnectionStatus =
  | 'local'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'auth-error'
  | 'incompatible'

export interface ServerConnectionSnapshot {
  serverId: ServerId
  name: string
  status: ServerConnectionStatus
  lastConnectedAt: number | null
  error: string | null
  appVersion: string | null
  capabilities: Readonly<Record<string, number>>
  featureSurfaces: readonly FeatureSurfaceManifestEntry[]
}

export interface ServerAdapter {
  readonly connected: boolean
  readonly authError: string | null
  enableConnect(): void
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>
  listen<T>(event: string, handler: (event: { payload: T }) => void): () => void
  subscribe(callback: () => void): () => void
  dispose(): void
}

interface ManagerDependencies {
  isNative: () => boolean
  invokeLocal: (
    command: string,
    args?: Record<string, unknown>
  ) => Promise<unknown>
  createRemote: (connection: RemoteConnection) => ServerAdapter
}

interface ManagedRemote {
  adapter: ServerAdapter
  signature: string
  connection: RemoteConnection
  unsubscribe: () => void
  lastConnectedAt: number | null
  externallyManaged: boolean
  compatibility: 'unchecked' | 'legacy' | 'compatible' | 'incompatible'
  capabilities: ServerCapabilitiesEnvelope | null
  probing: boolean
}

export interface ExistingServerAdapter {
  serverId: ServerId
  adapter: ServerAdapter
}

async function invokeLocalCore(
  command: string,
  args?: Record<string, unknown>
): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke('dispatch_core_command', { command, args: args ?? {} })
}

function createRemoteAdapter(connection: RemoteConnection): ServerAdapter {
  return new WsTransport({
    serverId: connection.id,
    baseUrl: connection.url,
    getToken: () => connection.token,
    syncGlobalState: false,
  })
}

const defaultDependencies: ManagerDependencies = {
  isNative: () => isNativeApp(),
  invokeLocal: invokeLocalCore,
  createRemote: createRemoteAdapter,
}

export class ServerConnectionManager {
  private readonly remotes = new Map<ServerId, ManagedRemote>()
  private readonly subscribers = new Set<() => void>()
  private snapshot: ReadonlyMap<ServerId, ServerConnectionSnapshot> = new Map()
  private readonly listenerRefreshers = new Set<() => void>()

  constructor(private readonly dependencies = defaultDependencies) {}

  sync(
    connections: RemoteConnection[],
    existingAdapter?: ExistingServerAdapter
  ): void {
    if (!this.dependencies.isNative()) {
      this.dispose()
      return
    }

    const enabled = new Map(
      connections
        .filter(connection => connection.enabled !== false)
        .map(connection => [connection.id, connection])
    )
    for (const [serverId, managed] of this.remotes) {
      const connection = enabled.get(serverId)
      if (connection && managed.signature === this.signature(connection)) {
        enabled.delete(serverId)
        continue
      }
      managed.unsubscribe()
      if (!managed.externallyManaged) managed.adapter.dispose()
      this.remotes.delete(serverId)
    }

    for (const connection of enabled.values()) {
      const externallyManaged = existingAdapter?.serverId === connection.id
      const adapter = externallyManaged
        ? existingAdapter.adapter
        : this.dependencies.createRemote(connection)
      const managed: ManagedRemote = {
        adapter,
        signature: this.signature(connection),
        connection,
        unsubscribe: () => undefined,
        lastConnectedAt: null,
        externallyManaged,
        compatibility: 'unchecked',
        capabilities: null,
        probing: false,
      }
      managed.unsubscribe = adapter.subscribe(() => {
        if (adapter.connected) managed.lastConnectedAt = Date.now()
        this.rebuildSnapshot()
        if (adapter.connected) void this.negotiate(connection.id, managed)
      })
      this.remotes.set(connection.id, managed)
      if (!externallyManaged) adapter.enableConnect()
      if (adapter.connected) void this.negotiate(connection.id, managed)
    }
    this.rebuildSnapshot()
    for (const refresh of this.listenerRefreshers) refresh()
  }

  async invoke<T>(
    serverId: ServerId,
    command: string,
    args?: Record<string, unknown>
  ): Promise<T> {
    if (serverId === LOCAL_SERVER_ID) {
      return this.dependencies.invokeLocal(command, args) as Promise<T>
    }
    const managed = this.remotes.get(serverId)
    if (!managed) throw new Error(`Jean server '${serverId}' is not connected`)
    if (managed.compatibility === 'incompatible') {
      throw new Error(
        `Jean server '${serverId}' uses an incompatible API protocol`
      )
    }
    return managed.adapter.invoke(command, args) as Promise<T>
  }

  listen<T>(
    serverId: ServerId,
    event: string,
    handler: (event: { payload: T }) => void
  ): () => void {
    const managed = this.remotes.get(serverId)
    if (!managed) throw new Error(`Jean server '${serverId}' is not connected`)
    return managed.adapter.listen(event, handler)
  }

  /** Listen on every current and future remote adapter. */
  listenAllRemotes<T>(
    event: string,
    handler: (event: { payload: T; serverId: ServerId }) => void
  ): () => void {
    const unlisteners = new Map<ServerId, () => void>()
    const refresh = () => {
      for (const [serverId, unlisten] of unlisteners) {
        if (!this.remotes.has(serverId)) {
          unlisten()
          unlisteners.delete(serverId)
        }
      }
      for (const [serverId, managed] of this.remotes) {
        if (unlisteners.has(serverId)) continue
        const unlisten = managed.adapter.listen<T>(event, incoming => {
          handler({
            serverId,
            payload: decorateServerEvent(serverId, incoming.payload),
          })
        })
        unlisteners.set(serverId, unlisten)
      }
    }
    refresh()
    this.listenerRefreshers.add(refresh)
    return () => {
      this.listenerRefreshers.delete(refresh)
      for (const unlisten of unlisteners.values()) unlisten()
      unlisteners.clear()
    }
  }

  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  getSnapshot = (): ReadonlyMap<ServerId, ServerConnectionSnapshot> =>
    this.snapshot

  dispose(): void {
    for (const managed of this.remotes.values()) {
      managed.unsubscribe()
      if (!managed.externallyManaged) managed.adapter.dispose()
    }
    this.remotes.clear()
    for (const refresh of this.listenerRefreshers) refresh()
    if (this.snapshot.size > 0) {
      this.snapshot = new Map()
      this.notify()
    }
  }

  private signature(connection: RemoteConnection): string {
    return JSON.stringify([
      connection.name,
      connection.url,
      connection.token,
      connection.enabled !== false,
    ])
  }

  private rebuildSnapshot(): void {
    const next = new Map<ServerId, ServerConnectionSnapshot>()
    next.set(LOCAL_SERVER_ID, {
      serverId: LOCAL_SERVER_ID,
      name: 'Local',
      status: 'local',
      lastConnectedAt: null,
      error: null,
      appVersion: null,
      capabilities: {},
      featureSurfaces: [],
    })
    for (const [serverId, managed] of this.remotes) {
      const error = managed.adapter.authError
      next.set(serverId, {
        serverId,
        name: managed.connection.name,
        status:
          managed.compatibility === 'incompatible'
            ? 'incompatible'
            : managed.adapter.connected
              ? 'online'
              : error
                ? 'auth-error'
                : 'connecting',
        lastConnectedAt: managed.lastConnectedAt,
        error,
        appVersion: managed.capabilities?.appVersion ?? null,
        capabilities: managed.capabilities?.capabilities ?? {},
        featureSurfaces: managed.capabilities?.featureSurfaces ?? [],
      })
    }
    if (JSON.stringify([...this.snapshot]) === JSON.stringify([...next])) return
    this.snapshot = next
    this.notify()
  }

  private notify(): void {
    for (const subscriber of this.subscribers) subscriber()
  }

  private async negotiate(
    serverId: ServerId,
    managed: ManagedRemote
  ): Promise<void> {
    if (managed.probing || managed.compatibility !== 'unchecked') return
    managed.probing = true
    try {
      const value = (await managed.adapter.invoke(
        'get_server_capabilities'
      )) as Partial<ServerCapabilitiesEnvelope>
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.apiProtocol !== 'number' ||
        typeof value.apiProtocolMin !== 'number'
      ) {
        managed.compatibility = 'legacy'
      } else {
        managed.capabilities = {
          schemaVersion: value.schemaVersion ?? 1,
          appVersion: value.appVersion ?? '',
          apiProtocol: value.apiProtocol,
          apiProtocolMin: value.apiProtocolMin,
          capabilities: value.capabilities ?? {},
          featureSurfaces: value.featureSurfaces ?? [],
          magicPrompts: value.magicPrompts ?? [],
        }
        managed.compatibility =
          CLIENT_API_PROTOCOL >= value.apiProtocolMin &&
          CLIENT_API_PROTOCOL <= value.apiProtocol
            ? 'compatible'
            : 'incompatible'
      }
    } catch {
      // Servers before the capability contract continue through the legacy path.
      managed.compatibility = 'legacy'
    } finally {
      managed.probing = false
      if (this.remotes.get(serverId) === managed) this.rebuildSnapshot()
    }
  }
}

export const serverConnectionManager = new ServerConnectionManager()

export function invokeOnServer<T>(
  serverId: ServerId,
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return serverConnectionManager.invoke<T>(serverId, command, args)
}

export function listenOnServer<T>(
  serverId: ServerId,
  event: string,
  handler: (event: { payload: T }) => void
): () => void {
  return serverConnectionManager.listen(serverId, event, handler)
}

export function listenOnRemoteServers<T>(
  event: string,
  handler: (event: { payload: T; serverId: ServerId }) => void
): () => void {
  return serverConnectionManager.listenAllRemotes(event, handler)
}

export function useServerConnectionSnapshots(): ReadonlyMap<
  ServerId,
  ServerConnectionSnapshot
> {
  return useSyncExternalStore(
    serverConnectionManager.subscribe,
    serverConnectionManager.getSnapshot,
    serverConnectionManager.getSnapshot
  )
}
