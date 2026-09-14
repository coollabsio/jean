import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { hasBackendTransport } from '@/lib/environment'
import type {
  ServerCapabilitiesEnvelope,
  ServerCompatibility,
} from '@/types/server-capabilities'

export const serverCapabilitiesQueryKey = ['server-capabilities'] as const

export function normalizeServerCompatibility(
  envelope: ServerCapabilitiesEnvelope
): ServerCompatibility {
  return {
    apiProtocol: envelope.apiProtocol ?? 1,
    apiProtocolMin: envelope.apiProtocolMin ?? 1,
    capabilities: envelope.capabilities ?? {},
    featureSurfaces: envelope.featureSurfaces ?? [],
  }
}

export function isCoreProtocolCompatible(
  compatibility: Pick<ServerCompatibility, 'apiProtocol' | 'apiProtocolMin'>,
  clientProtocol = 1
): boolean {
  return (
    clientProtocol >= compatibility.apiProtocolMin &&
    clientProtocol <= compatibility.apiProtocol
  )
}

export function useServerCapabilities() {
  return useQuery({
    queryKey: serverCapabilitiesQueryKey,
    queryFn: () =>
      invoke<ServerCapabilitiesEnvelope>('get_server_capabilities'),
    enabled: hasBackendTransport(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}
