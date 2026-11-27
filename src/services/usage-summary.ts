import { useQuery } from '@tanstack/react-query'
import { invokeForOptionalServer } from '@/lib/transport'
import { hasBackendTransport } from '@/lib/environment'
import { useOptionalSettingsTargetServerId } from '@/lib/settings-target'
import type { UsageSummaryRow } from '@/lib/model-pricing'

/** Token usage per backend + model over the last `days` days (null = all time). */
export function useUsageSummary(days: number | null) {
  const serverId = useOptionalSettingsTargetServerId()
  return useQuery({
    queryKey: ['usage-summary', days ?? 'all', serverId ?? 'local'],
    queryFn: () =>
      invokeForOptionalServer<UsageSummaryRow[]>(
        serverId,
        'get_usage_summary',
        {
          days,
        }
      ),
    enabled: hasBackendTransport(),
    staleTime: 1000 * 60,
  })
}
