import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { hasBackendTransport } from '@/lib/environment'
import type { ServerCapabilitiesEnvelope } from '@/types/server-capabilities'

export const serverCapabilitiesQueryKey = ['server-capabilities'] as const

export function useServerCapabilities() {
  return useQuery({
    queryKey: serverCapabilitiesQueryKey,
    queryFn: () => invoke<ServerCapabilitiesEnvelope>('get_server_capabilities'),
    enabled: hasBackendTransport(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}
