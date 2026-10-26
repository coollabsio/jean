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

/** Second line of an agent row: what needs the user, else the latest
 * activity, else the description. */
export function agentSubtitle(agent: AgentSummary): string {
  if (agent.pendingApprovals > 0) return 'Needs your approval'
  if (agent.status === 'waiting') return 'Waiting for your answer'
  if (agent.status === 'working') return 'Working…'
  return agent.activity ?? (agent.description || 'No activity yet')
}

/** Short status text for an agent row and header; null when idle. */
export function agentStatusLabel(agent: AgentSummary): string | null {
  if (agent.pendingApprovals > 0)
    return `Needs approval (${agent.pendingApprovals})`
  if (agent.unreadNotifications > 0)
    return `${agent.unreadNotifications} new notification${agent.unreadNotifications === 1 ? '' : 's'}`
  if (agent.status === 'working')
    return agent.runningTasks > 0
      ? `Working (${agent.runningTasks} task${agent.runningTasks === 1 ? '' : 's'})`
      : 'Working'
  if (agent.status === 'waiting') return 'Waiting for you'
  if (agent.budgetReached) return 'Hourly limit reached'
  if (agent.activeDelegations > 0)
    return `Following ${agent.activeDelegations} session${agent.activeDelegations === 1 ? '' : 's'}`
  return null
}

/** Sections of the agent side panel (the chat is always shown). */
export type AgentTab =
  | 'inbox'
  | 'tasks'
  | 'subagents'
  | 'schedules'
  | 'activity'
  | 'memory'
  | 'settings'

const ALL_AGENT_TABS: AgentTab[] = [
  'inbox',
  'tasks',
  'subagents',
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
