import {
  LOCAL_SERVER_ID,
  type ServerId,
  type ServerOwned,
  type ServerResourceRef,
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

/**
 * Strip a `local:` scope. Local IDs are raw, but versions before 1.0.7 could
 * persist scoped base-session IDs that no longer match session lists.
 */
export function toRawLocalResourceId(key: string): string {
  const reference = parseServerResourceKey(key)
  return reference?.serverId === LOCAL_SERVER_ID ? reference.resourceId : key
}

export function withServerId<T extends object>(
  serverId: ServerId,
  resource: T
): ServerOwned<T> {
  return { ...resource, serverId }
}
