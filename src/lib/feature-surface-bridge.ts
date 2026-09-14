import type { FeatureSurfaceManifestEntry } from '@/types/server-capabilities'

export const FEATURE_BRIDGE_VERSION = 1
export const MAX_FEATURE_MESSAGE_BYTES = 16_384

export type FeatureBridgePermission =
  | 'clipboard.write'
  | 'notification.show'
  | 'external.open'
  | 'navigation.open'
  | 'context.read'

export interface FeatureBridgeRequest {
  type: 'jean:bridge'
  channel: string
  requestId: string
  permission: FeatureBridgePermission
  payload: Record<string, unknown>
}

const KNOWN_PERMISSIONS = new Set<FeatureBridgePermission>([
  'clipboard.write',
  'notification.show',
  'external.open',
  'navigation.open',
  'context.read',
])

export function validateFeatureManifest(
  surface: FeatureSurfaceManifestEntry,
  serverOrigin: string
): string | null {
  if (!surface.id || !surface.label || surface.bridgeVersion < 1) return null
  if (surface.bridgeVersion > FEATURE_BRIDGE_VERSION) return null
  if (
    !surface.permissions.every(item =>
      KNOWN_PERMISSIONS.has(item as FeatureBridgePermission)
    )
  ) {
    return null
  }
  try {
    const url = new URL(surface.entryUrl, serverOrigin)
    if (url.origin !== new URL(serverOrigin).origin) return null
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url.toString()
  } catch {
    return null
  }
}

export function validateFeatureBridgeRequest(
  value: unknown,
  surface: FeatureSurfaceManifestEntry,
  channel: string
): FeatureBridgeRequest | null {
  if (!value || typeof value !== 'object') return null
  if (JSON.stringify(value).length > MAX_FEATURE_MESSAGE_BYTES) return null
  const request = value as Partial<FeatureBridgeRequest>
  if (
    request.type !== 'jean:bridge' ||
    request.channel !== channel ||
    typeof request.requestId !== 'string' ||
    !request.requestId ||
    typeof request.permission !== 'string' ||
    !surface.permissions.includes(request.permission) ||
    !request.payload ||
    typeof request.payload !== 'object' ||
    Array.isArray(request.payload)
  ) {
    return null
  }
  return request as FeatureBridgeRequest
}

export function validateExternalFeatureUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
