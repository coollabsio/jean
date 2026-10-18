import { useQueries } from '@tanstack/react-query'
import {
  loadPreferencesForServer,
  preferencesQueryKeys,
  usePreferences,
} from '@/services/preferences'
import { useSessionServerSources } from '@/services/multi-server-sessions'
import { useUIStore } from '@/store/ui-store'
import { LOCAL_SERVER_ID } from '@/types/server-resource'

// Kept apart from agents.ts so layout code (tab rail, sidebar) does not load
// the agents service.

/** Server IDs with Agents on, local first. Remote settings that are still
 * loading (undefined) count as off. */
export function enabledAgentServers(
  localEnabled: boolean | undefined,
  remotes: { serverId: string; agentsEnabled: boolean | undefined }[]
): string[] {
  return [
    ...(localEnabled ? [LOCAL_SERVER_ID] : []),
    ...remotes.filter(r => r.agentsEnabled).map(r => r.serverId),
  ]
}

/**
 * Servers whose Agents setting (Experimental, off by default) is on: the
 * local server and, in the native app, every online remote server. Each
 * server keeps its own agents, so one enabled server is enough to show them.
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
    localPreferences?.agents_enabled,
    remotes.map((source, index) => ({
      serverId: source.serverId,
      agentsEnabled: remotePreferences[index]?.data?.agents_enabled,
    }))
  )
}

/** Agents are on for at least one server. */
export function useAgentsEnabled(): boolean {
  return useAgentsEnabledServers().length > 0
}

/** Agents page is open: section selected and feature enabled. */
export function useShowAgents(): boolean {
  const agentsSelected = useUIStore(state => state.railSection === 'agents')
  return useAgentsEnabled() && agentsSelected
}
