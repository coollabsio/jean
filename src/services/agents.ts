import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isNativeApp } from '@/lib/environment'
import { decorateServerEvent } from '@/lib/server-command-routing'
import {
  parseServerResourceKey,
  serverResourceKey,
} from '@/lib/server-resource'
import { invoke, invokeForServer } from '@/lib/transport'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import {
  useSessionServerSources,
  type SessionServerSource,
} from './multi-server-sessions'

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'paused'

export interface AgentSummary {
  /** Agent key: raw ID on the local server, `serverId:id` on a remote one */
  id: string
  /** Jean server that runs this agent */
  serverId: string
  serverName: string
  name: string
  description: string
  icon: string
  rolePrompt: string
  worktreeId: string
  paused: boolean
  maxWakesPerHour: number
  builtin: boolean
  status: AgentStatus
  homeSessionId: string | null
  pendingUpdates: number
  pendingApprovals: number
  activeDelegations: number
  nextScheduleAt: number | null
  budgetReached: boolean
  /** Worktree ID of the agent's background task sessions */
  tasksWorktreeId: string
  runningTasks: number
  unreadNotifications: number
  /** One line about the latest activity (chat reply, notification, task) */
  activity: string | null
}

export interface AgentTask {
  id: number
  agentId: string
  sessionId: string
  title: string
  /** schedule | delegation | message | approval */
  kind: string
  /** running | waiting | done | failed | cancelled */
  status: string
  summary: string | null
  createdAt: number
  updatedAt: number
}

export interface AgentNotification {
  id: number
  agentId: string
  sessionId: string | null
  /** info | action | error */
  level: string
  message: string
  createdAt: number
  readAt: number | null
}

export interface AgentDelegation {
  id: number
  agentId: string
  sessionId: string
  worktreeId: string
  hop: number
  /** active | waiting | done | failed | cancelled */
  status: string
  lastEvent: string | null
  lastError: string | null
  lastSummary: string | null
  checkAfter: number | null
  updatedAt: number
}

export interface AgentSchedule {
  id: number
  agentId: string
  name: string
  prompt: string
  everySecs: number | null
  nextRunAt: number
  lastRunAt: number | null
}

export interface AgentApproval {
  id: number
  agentId: string
  tool: string
  args: Record<string, unknown>
  /** pending | approved | denied | failed */
  status: string
  result: string | null
  createdAt: number
}

export type MemoryKind = 'rule' | 'fact' | 'open_work'

export interface AgentMemory {
  id: number
  /** null = shared by all agents */
  agentId: string | null
  projectId: string | null
  kind: MemoryKind
  content: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  expiresAt: number | null
}

export interface AgentDetails {
  delegations: AgentDelegation[]
  schedules: AgentSchedule[]
  approvals: AgentApproval[]
  memories: AgentMemory[]
  tasks: AgentTask[]
  notifications: AgentNotification[]
}

export interface AgentPatch {
  name?: string
  description?: string
  icon?: string
  rolePrompt?: string
  paused?: boolean
  maxWakesPerHour?: number
}

export const agentsQueryKeys = {
  all: ['agents'] as const,
  list: () => [...agentsQueryKeys.all, 'list'] as const,
  details: (agentId: string) =>
    [...agentsQueryKeys.all, 'details', agentId] as const,
  workdir: (agentId: string) =>
    [...agentsQueryKeys.all, 'workdir', agentId] as const,
}

type RawAgentSummary = Omit<AgentSummary, 'serverId' | 'serverName'>

/** Tag an agent with its server; remote IDs become server-scoped keys so
 * commands and chat sessions route to that server. */
export function scopeAgentSummary(
  serverId: string,
  serverName: string,
  agent: RawAgentSummary
): AgentSummary {
  if (serverId === LOCAL_SERVER_ID) return { ...agent, serverId, serverName }
  const scope = (resourceId: string) =>
    serverResourceKey({ serverId, resourceId })
  return {
    ...agent,
    id: scope(agent.id),
    worktreeId: scope(agent.worktreeId),
    tasksWorktreeId: scope(agent.tasksWorktreeId),
    homeSessionId: agent.homeSessionId ? scope(agent.homeSessionId) : null,
    serverId,
    serverName,
  }
}

/** Agents of every online server. Servers without agents support (older
 * Jean) or with errors are skipped. */
export async function loadAgentsForServers(
  sources: SessionServerSource[],
  invokeServer: (
    serverId: string,
    command: string
  ) => Promise<RawAgentSummary[]>
): Promise<AgentSummary[]> {
  const results = await Promise.allSettled(
    sources
      .filter(source => source.online)
      .map(async source => ({
        source,
        agents: await invokeServer(source.serverId, 'list_agents'),
      }))
  )
  return results.flatMap(result =>
    result.status === 'fulfilled'
      ? result.value.agents.map(agent =>
          scopeAgentSummary(
            result.value.source.serverId,
            result.value.source.name,
            agent
          )
        )
      : []
  )
}

/** Server of an agent key. */
export function agentServerId(agentKey: string): string {
  return parseServerResourceKey(agentKey)?.serverId ?? LOCAL_SERVER_ID
}

/** Run an agent command on the agent's server (routed by `agentId`).
 * IDs in a remote server's result are scoped like the agent key. */
async function invokeAgent<T>(
  agentKey: string,
  command: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await invoke<T>(command, { ...args, agentId: agentKey })
  const ref = parseServerResourceKey(agentKey)
  return ref ? decorateServerEvent(ref.serverId, result) : result
}

/** Agents of the servers that have Agents turned on (see
 * `useAgentsEnabledServers`). */
export function useAgentsList(enabledServerIds: string[]) {
  const native = isNativeApp()
  const sources = useSessionServerSources().filter(source =>
    enabledServerIds.includes(source.serverId)
  )
  const enabled = sources.length > 0
  const sourceKey = sources
    .map(source => `${source.serverId}:${source.online}`)
    .join('|')
  const query = useQuery({
    queryKey: agentsQueryKeys.list(),
    queryFn: () =>
      native
        ? loadAgentsForServers(sources, (serverId, command) =>
            invokeForServer<RawAgentSummary[]>(serverId, command)
          )
        : invoke<RawAgentSummary[]>('list_agents').then(agents =>
            agents.map(agent =>
              scopeAgentSummary(LOCAL_SERVER_ID, 'This server', agent)
            )
          ),
    enabled,
    staleTime: 10_000,
  })
  // A server came online or went away: load its agents.
  const { refetch } = query
  useEffect(() => {
    if (enabled) void refetch()
  }, [sourceKey, enabled, refetch])
  return query
}

export function useAgentDetails(agentId: string | null) {
  return useQuery({
    queryKey: agentsQueryKeys.details(agentId ?? ''),
    queryFn: () =>
      invokeAgent<AgentDetails>(agentId ?? '', 'get_agent_details'),
    enabled: !!agentId,
    staleTime: 10_000,
  })
}

export function useAgentWorkdir(agentId: string | null) {
  return useQuery({
    queryKey: agentsQueryKeys.workdir(agentId ?? ''),
    queryFn: () => invokeAgent<string>(agentId ?? '', 'get_agent_workdir'),
    enabled: !!agentId,
    staleTime: Infinity,
  })
}

/** Mutation that refreshes all agent data when it succeeds. */
function useAgentsMutation<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: agentsQueryKeys.all }),
  })
}

export function useCreateAgent() {
  return useAgentsMutation(
    async ({
      serverId,
      ...args
    }: {
      /** Jean server that runs the new agent */
      serverId: string
      name: string
      description: string
      icon: string
      rolePrompt: string
    }): Promise<{ key: string; name: string }> => {
      const agent = await invokeForServer<{ id: string; name: string }>(
        serverId,
        'create_agent',
        args
      )
      const key =
        serverId === LOCAL_SERVER_ID
          ? agent.id
          : serverResourceKey({ serverId, resourceId: agent.id })
      return { key, name: agent.name }
    }
  )
}

export function useUpdateAgent() {
  return useAgentsMutation((args: { agentId: string; patch: AgentPatch }) =>
    invoke<AgentSummary>('update_agent', args)
  )
}

export function useDeleteAgent() {
  return useAgentsMutation((args: { agentId: string }) =>
    invoke<null>('delete_agent', args)
  )
}

export function useDecideAgentApproval() {
  return useAgentsMutation(
    ({
      agentId,
      ...args
    }: {
      /** Routes the decision to the agent's server */
      agentId: string
      approvalId: number
      approve: boolean
    }) => invokeAgent<AgentApproval>(agentId, 'decide_agent_approval', args)
  )
}

export function useCancelAgentSchedule() {
  return useAgentsMutation((args: { agentId: string; scheduleId: number }) =>
    invoke<null>('cancel_agent_schedule', args)
  )
}

export function useSaveAgentMemory() {
  return useAgentsMutation(
    (args: {
      agentId: string
      content: string
      kind: MemoryKind
      shared: boolean
      pinned: boolean
    }) => invoke<AgentMemory>('save_agent_memory', args)
  )
}

export function useUpdateAgentMemory() {
  return useAgentsMutation(
    (args: {
      agentId: string
      memoryId: number
      patch: { content?: string; kind?: MemoryKind; pinned?: boolean }
    }) => invoke<AgentMemory>('update_agent_memory', args)
  )
}

export function useDeleteAgentMemory() {
  return useAgentsMutation((args: { agentId: string; memoryId: number }) =>
    invoke<null>('delete_agent_memory', args)
  )
}

export function useMarkAgentNotificationsRead() {
  return useAgentsMutation((args: { agentId: string }) =>
    invoke<null>('mark_agent_notifications_read', args)
  )
}

export function exportAgentMemory(agentId: string): Promise<string> {
  return invoke<string>('export_agent_memory', { agentId })
}
