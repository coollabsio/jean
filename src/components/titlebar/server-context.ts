import { parseServerResourceKey } from '@/lib/server-resource'
import type { RemoteConnection } from '@/lib/remote-connections'

export function resolveHeaderServerLabel(
  selectedProjectId: string | null,
  connections: RemoteConnection[]
): string {
  if (!selectedProjectId) {
    return connections.some(connection => connection.enabled !== false)
      ? 'All servers'
      : 'Local'
  }

  const reference = parseServerResourceKey(selectedProjectId)
  if (!reference || reference.serverId === 'local') return 'Local'
  return (
    connections.find(connection => connection.id === reference.serverId)
      ?.name ?? reference.serverId
  )
}
