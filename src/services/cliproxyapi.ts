import { useQuery } from '@tanstack/react-query'
import { invokeForOptionalServer } from '@/lib/transport'
import { hasBackendTransport } from '@/lib/environment'
import { useOptionalSettingsTargetServerId } from '@/lib/settings-target'
import type { CliproxyAccountUsage } from '@/types/cliproxyapi'

const USAGE_REFRESH_MS = 5 * 60 * 1000

export const cliproxyapiQueryKeys = {
  usage: () => ['cliproxyapi', 'usage'] as const,
}

/** Usage of every CLIProxyAPI account. Empty when the proxy is not running. */
export function useCliproxyapiUsage(options?: { enabled?: boolean }) {
  const serverId = useOptionalSettingsTargetServerId()
  return useQuery({
    queryKey: [...cliproxyapiQueryKeys.usage(), serverId ?? 'local'],
    queryFn: async (): Promise<CliproxyAccountUsage[]> => {
      if (!hasBackendTransport()) return []
      return invokeForOptionalServer<CliproxyAccountUsage[]>(
        serverId,
        'get_cliproxyapi_usage'
      )
    },
    staleTime: USAGE_REFRESH_MS,
    gcTime: 1000 * 60 * 10,
    refetchInterval: USAGE_REFRESH_MS,
    enabled: options?.enabled ?? true,
  })
}
