import { useQuery } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { hasBackend } from '@/lib/environment'
import type { RtkGainSnapshot } from '@/types/rtk'

const RTK_REFRESH_MS = 1000 * 60 * 5

export const rtkQueryKeys = {
  all: ['rtk'] as const,
  gain: () => [...rtkQueryKeys.all, 'gain'] as const,
}

function getRtkStaleTime(snapshot?: RtkGainSnapshot): number {
  if (!snapshot?.fetchedAt) return 0
  const expiresAtMs = snapshot.fetchedAt * 1000 + RTK_REFRESH_MS
  return Math.max(0, expiresAtMs - Date.now())
}

function getRtkRefetchInterval(snapshot?: RtkGainSnapshot): number {
  if (!snapshot?.fetchedAt) return RTK_REFRESH_MS
  const expiresAtMs = snapshot.fetchedAt * 1000 + RTK_REFRESH_MS
  return Math.max(1_000, expiresAtMs - Date.now())
}

export function useRtkGain(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: rtkQueryKeys.gain(),
    queryFn: async (): Promise<RtkGainSnapshot> => {
      if (!hasBackend()) {
        throw new Error(
          'RTK savings are only available when a Jean backend is connected'
        )
      }
      return invoke<RtkGainSnapshot>('get_rtk_gain')
    },
    enabled: options?.enabled ?? true,
    staleTime: query => getRtkStaleTime(query.state.data),
    gcTime: 1000 * 60 * 10,
    refetchInterval: query => getRtkRefetchInterval(query.state.data),
  })
}
