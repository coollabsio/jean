import { useQueries } from '@tanstack/react-query'
import {
  loadPreferencesForServer,
  preferencesQueryKeys,
  usePreferences,
} from '@/services/preferences'
import { useSessionServerSources } from '@/services/multi-server-sessions'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

// Kept apart from agents.ts so layout code does not load the agents service.

/** Server IDs with the coordinator on, local first. Remote settings that are still
 * loading (undefined) count as off. */
export function enabledAgentServers(
  localEnabled: boolean | undefined,
  remotes: { serverId: string; coordinatorEnabled: boolean | undefined }[]
): string[] {
  return [
    ...(localEnabled ? [LOCAL_SERVER_ID] : []),
    ...remotes.filter(r => r.coordinatorEnabled).map(r => r.serverId),
  ]
}

/**
 * Servers whose Project Coordinator setting (Experimental, off by default) is
 * on: the local server and, in the native app, every online remote server.
 * Each server keeps its own coordinators, so one enabled server is enough.
 */
export function useAgentsEnabledServers(): string[] {
  const { data: localPreferences } = usePreferences(LOCAL_SERVER_ID)
  const remotes = useSessionServerSources().filter(
    source => source.serverId !== LOCAL_SERVER_ID && source.online
  )
  const remotePreferences = useQueries({
    queries: remotes.map(source => ({
      // Same key as usePreferences(serverId): one cache per server
      queryKey: preferencesQueryKeys.preferences(source.serverId),
      queryFn: () => loadPreferencesForServer(source.serverId),
      staleTime: 1000 * 60 * 5,
    })),
  })
  return enabledAgentServers(
    localPreferences?.coordinator_enabled,
    remotes.map((source, index) => ({
      serverId: source.serverId,
      coordinatorEnabled: remotePreferences[index]?.data?.coordinator_enabled,
    }))
  )
}

/** Agents are on for at least one server. */
export function useAgentsEnabled(): boolean {
  return useAgentsEnabledServers().length > 0
}
