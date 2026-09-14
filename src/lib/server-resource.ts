import type {
  ServerId,
  ServerOwned,
  ServerResourceRef,
} from '@/types/server-resource'

export function serverResourceKey(reference: ServerResourceRef): string {
  return `${encodeURIComponent(reference.serverId)}:${encodeURIComponent(reference.resourceId)}`
}

export function parseServerResourceKey(key: string): ServerResourceRef | null {
  const separator = key.indexOf(':')
  if (separator <= 0 || separator === key.length - 1) return null

  try {
    const serverId = decodeURIComponent(key.slice(0, separator))
    const resourceId = decodeURIComponent(key.slice(separator + 1))
    return serverId && resourceId ? { serverId, resourceId } : null
  } catch {
    return null
  }
}

export function withServerId<T extends object>(
  serverId: ServerId,
  resource: T
): ServerOwned<T> {
  return { ...resource, serverId }
}
