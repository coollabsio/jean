import { useMemo } from 'react'
import { useAgentsList, type AgentSummary } from '@/services/agents'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useAgentsEnabledServers } from './agents-feature'

/** Colors offered for new agents (`jean` is reserved for the boss). */
export const AGENT_COLOR_CHOICES = [
  'blue',
  'green',
  'pink',
  'purple',
  'orange',
  'yellow',
] as const

/** Colors Jean can pick: its crowned default first, then the others. */
export const JEAN_COLOR_CHOICES = ['jean', ...AGENT_COLOR_CHOICES] as const

/** Agent by ID, or the first agent (Jean) when the ID is unknown. */
export function findAgent(
  agents: AgentSummary[] | undefined,
  id: string | null | undefined
): AgentSummary | undefined {
  return agents?.find(agent => agent.id === id) ?? agents?.[0]
}

/** Marks agents whose home chat runs in this client as working. The backend
 * list does not refresh when a chat starts, so the run would not show. */
export function withRunningAgents(
  agents: AgentSummary[] | undefined,
  runningSessionIds: ReadonlySet<string>
): AgentSummary[] | undefined {
  if (!agents || runningSessionIds.size === 0) return agents
  return agents.map(agent =>
    agent.status !== 'working' &&
    agent.homeSessionId &&
    runningSessionIds.has(agent.homeSessionId)
      ? { ...agent, status: 'working' }
      : agent
  )
}

/** The agent selected in the Agents sidebar (from the backend list). */
export function useSelectedAgent(): {
  agent: AgentSummary | undefined
  agents: AgentSummary[] | undefined
  isLoading: boolean
  error: unknown
} {
  const enabledServers = useAgentsEnabledServers()
  const { data: listed, isLoading, error } = useAgentsList(enabledServers)
  const selectedAgentId = useUIStore(state => state.selectedAgentId)
  // Home chats running now, as a string so the selector stays stable
  const runningKey = useChatStore(state =>
    (listed ?? [])
      .flatMap(agent =>
        agent.homeSessionId && state.sendingSessionIds[agent.homeSessionId]
          ? [agent.homeSessionId]
          : []
      )
      .join('\n')
  )
  const agents = useMemo(
    () =>
      withRunningAgents(
        listed,
        new Set(runningKey ? runningKey.split('\n') : [])
      ),
    [listed, runningKey]
  )
  return {
    agent: findAgent(agents, selectedAgentId),
    agents,
    isLoading,
    error,
  }
}

/** Short status text for an agent row and header; null when idle. */
export function agentStatusLabel(agent: AgentSummary): string | null {
  if (agent.unreadNotifications > 0)
    return `${agent.unreadNotifications} new notification${agent.unreadNotifications === 1 ? '' : 's'}`
  if (agent.status === 'working') return 'Working'
  if (agent.status === 'waiting') return 'Waiting for you'
  if (agent.budgetReached) return 'Hourly limit reached'
  return null
}

/** Sections of the agent side panel (the chat is always shown). */
export type AgentTab =
  | 'inbox'
  | 'schedules'
  | 'activity'
  | 'memory'
  | 'settings'

const ALL_AGENT_TABS: AgentTab[] = [
  'inbox',
  'schedules',
  'activity',
  'memory',
  'settings',
]

/**
 * Sections of the agent side panel. Without Advanced: Schedules, plus Inbox
 * while it has unread messages or is open (reading them must not hide it).
 */
export function visibleAgentTabs(
  advanced: boolean,
  agent: Pick<AgentSummary, 'unreadNotifications'>,
  current: AgentTab
): AgentTab[] {
  if (advanced) return ALL_AGENT_TABS
  return ALL_AGENT_TABS.filter(
    tab =>
      tab === 'schedules' ||
      (tab === 'inbox' &&
        (agent.unreadNotifications > 0 || current === 'inbox'))
  )
}
