import { Button } from '@/components/ui/button'
import { Loader2, WifiOff } from '@/components/icons/reicon'
import {
  reconnectRemoteServer,
  useServerConnectionSnapshots,
  type ServerConnectionSnapshot,
} from '@/lib/server-connections'
import { parseServerResourceKey } from '@/lib/server-resource'

/** Snapshot of the remote server that owns `resourceKey`, if it is not reachable. */
export function useUnreachableServer(
  resourceKey: string | null | undefined
): ServerConnectionSnapshot | null {
  const snapshots = useServerConnectionSnapshots()
  const serverId = resourceKey
    ? parseServerResourceKey(resourceKey)?.serverId
    : undefined
  const snapshot = serverId ? snapshots.get(serverId) : undefined
  if (!snapshot) return null
  return snapshot.status === 'local' || snapshot.status === 'online'
    ? null
    : snapshot
}

export function ServerOfflineView({
  server,
}: {
  server: ServerConnectionSnapshot
}) {
  const neverConnected =
    server.status === 'connecting' && server.lastConnectedAt === null
  const detail =
    server.status === 'auth-error'
      ? (server.error ?? 'Authentication failed.')
      : server.status === 'incompatible'
        ? 'This server runs an incompatible Jean version.'
        : neverConnected
          ? 'Waiting for the server to respond.'
          : 'Its projects, worktrees, and chats are not available until it reconnects.'

  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center font-sans"
      role="status"
      data-testid="server-offline-view"
    >
      {neverConnected ? (
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      ) : (
        <WifiOff className="size-8 text-warning" />
      )}
      <h1 className="text-2xl font-bold text-foreground">
        {neverConnected
          ? `Connecting to ${server.name}…`
          : `${server.name} is offline`}
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">{detail}</p>
      {!neverConnected && server.status !== 'incompatible' && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => reconnectRemoteServer(server.serverId)}
        >
          Reconnect
        </Button>
      )}
    </div>
  )
}
