import { useMemo } from 'react'
import { useAgentsList } from '@/services/agents'
import { useAgentsEnabledServers } from '@/components/agents/agents-feature'
import { useAppDataDir, useProjects } from '@/services/projects'
import { useRemoteConnections } from '@/lib/remote-connections'
import { isNativeApp } from '@/lib/environment'
import { projectAvatarUrl } from '@/lib/project-avatar'
import {
  buildMentionCandidates,
  type MentionCandidate,
} from '../agent-mentions'

const NO_SERVERS: string[] = []

/**
 * `@` mention candidates for an agent chat, or undefined when `enabled` is
 * false (project chats keep the file picker).
 */
export function useAgentMentionCandidates(
  enabled: boolean,
  chatServerId: string
): MentionCandidate[] | undefined {
  const agentServers = useAgentsEnabledServers()
  const { data: agents } = useAgentsList(enabled ? agentServers : NO_SERVERS)
  const { data: projects } = useProjects()
  const { data: appDataDir } = useAppDataDir()
  const connections = useRemoteConnections()

  return useMemo(() => {
    if (!enabled) return undefined
    return buildMentionCandidates({
      chatServerId,
      agents: agents ?? [],
      // Web Access has only its own server; remote Jeans are native-only
      remoteJeans: isNativeApp()
        ? connections.filter(connection => connection.enabled !== false)
        : [],
      projects: projects ?? [],
      projectAvatar: project => projectAvatarUrl(project, appDataDir),
    })
  }, [enabled, chatServerId, agents, connections, projects, appDataDir])
}
