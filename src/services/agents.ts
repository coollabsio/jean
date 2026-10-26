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

export type AgentStatus = 'idle' | 'working' | 'waiting'

/** A skill file discovered for one backend and selected for this agent. */
export interface AgentSkill {
  name: string
  path: string
  /** Backend the skill was discovered for */
  backend?: string | null
}

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
  /**
   * Backend this agent's sessions use. Null keeps the current session and
   * user default.
   */
  backend: string | null
  /** Model id for that backend. Null keeps the backend's current default. */
  model: string | null
  /** Effort level (`low`, `high`, …). Null leaves effort unset. */
  effort: string | null
  /** Thinking level (`off`, `think`, `ultrathink`, …). Null leaves it unset. */
  thinkingLevel: string | null
  /** Skill files injected into this agent's prompt and wake-ups. */
  skills: AgentSkill[]
  /**
   * MCP servers this agent may use. Null means no saved limit (today's
   * behavior). An empty list allows no user MCP servers.
   */
  mcpServers?: AgentConnector[] | null
  /**
   * Jean MCP tool names this agent may call. Null allows every tool.
   */
  jeanTools?: string[] | null
}

/** One discovered MCP server selected for an agent. */
export interface AgentConnector {
  backend: string
  name: string
}

/** A named worker this agent can spawn. `agentId` null means it is shared. */
export interface SubagentType {
  id: number
  agentId: string | null
  shared: boolean
  name: string
  description: string
  instructions: string
  backend: string | null
  model: string | null
  effort: string | null
  thinkingLevel: string | null
  skills: AgentSkill[]
  /** plan | build | yolo, or null to keep the normal wake mode */
  permissionMode: string | null
  /** read_only, or null for the agent's normal tools */
  toolMode: string | null
}

export interface AgentTask {
  id: number
  agentId: string
  sessionId: string
  title: string
  /** schedule | delegation | message | approval | subagent */
  kind: string
  /** Set when this task was spawned from a subagent type. */
  subagentTypeName?: string | null
  spawnDepth?: number
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

export type ScheduleKind = 'once' | 'interval' | 'cron' | 'event'

/** Events a routine can listen for. Matches `EVENT_TRIGGERS` in agents/db.rs. */
export type ScheduleEvent =
  | 'session_finished'
  | 'session_failed'
  | 'worktree_archived'
  | 'pr_merged'
  | 'approval_resolved'

export interface AgentSchedule {
  id: number
  agentId: string
  name: string
  prompt: string
  everySecs: number | null
  nextRunAt: number
  lastRunAt: number | null
  cron: string | null
  timezone: string | null
  event: ScheduleEvent | string | null
  paused: boolean
}

export interface ScheduleInput {
  name: string
  prompt: string
  kind: ScheduleKind
  everySecs?: number | null
  runAt?: string | null
  cron?: string | null
  timezone?: string | null
  event?: string | null
  paused?: boolean
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

/** agent = private. shared = cross-agent working memory. user = facts about the user. */
export type MemoryScope = 'agent' | 'shared' | 'user'

export interface AgentMemory {
  id: number
  /** null for shared and user scopes */
  agentId: string | null
  projectId: string | null
  kind: MemoryKind
  content: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  scope: MemoryScope
  /** Set when a newer fact replaced this one. */
  supersededBy: number | null
  supersededAt: number | null
}

export interface AgentJournalEntry {
  id: number
  agentId: string
  projectId: string | null
  content: string
  /** Unix seconds for when this happened. */
  occurredAt: number
  createdAt: number
  /** user | agent | rotation */
  source: string
  sourceSessionId: string | null
}

export interface AgentMemoryChange {
  id: number
  memoryId: number
  /** null when the user made the change in the Memory view */
  actorAgentId: string | null
  /** null for shared and user scopes */
  ownerAgentId: string | null
  /** create | update | forget | supersede */
  action: string
  scope: string
  kind: string
  beforeContent: string | null
  afterContent: string | null
  createdAt: number
}

export interface AgentChange {
  id: number
  actorAgentId: string
  targetAgentId: string
  /** create | update | delete | revert | schedule_create | schedule_update | schedule_cancel */
  action: string
  summary: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  sessionId: string | null
  createdAt: number
  revertedChangeId: number | null
}

export interface AgentDetails {
  delegations: AgentDelegation[]
  schedules: AgentSchedule[]
  approvals: AgentApproval[]
  memories: AgentMemory[]
  journal: AgentJournalEntry[]
  memoryChanges: AgentMemoryChange[]
  tasks: AgentTask[]
  notifications: AgentNotification[]
  subagentTypes: SubagentType[]
  /** Self-management audit, newest first. */
  changes: AgentChange[]
}

export interface AgentPatch {
  name?: string
  description?: string
  icon?: string
  rolePrompt?: string
  maxWakesPerHour?: number
  /** Null clears the field so the agent uses current defaults again. */
  backend?: string | null
  model?: string | null
  effort?: string | null
  thinkingLevel?: string | null
  /** Replaces the selected skills. An empty list clears them. */
  skills?: AgentSkill[]
  /** Null clears a saved connector limit. An empty list allows none. */
  mcpServers?: AgentConnector[] | null
  /** Null allows every Jean tool. An empty list allows none. */
  jeanTools?: string[] | null
}

/** A schedule copied onto an agent when a template is installed. */
export interface AgentTemplateSchedule {
  name: string
  prompt: string
  /** cron | interval | event */
  kind: string
  everySecs?: number | null
  cron?: string | null
  timezone?: string | null
  event?: string | null
}

/**
 * A repo-shipped role. Installing it creates a normal custom agent.
 * `skillHints` are names to attach later, not skill files.
 */
export interface AgentTemplate {
  id: string
  name: string
  description: string
  icon: string
  rolePrompt: string
  skillHints: string[]
  schedules: AgentTemplateSchedule[]
}

export const agentsQueryKeys = {
  all: ['agents'] as const,
  list: () => [...agentsQueryKeys.all, 'list'] as const,
  details: (agentId: string) =>
    [...agentsQueryKeys.all, 'details', agentId] as const,
  workdir: (agentId: string) =>
    [...agentsQueryKeys.all, 'workdir', agentId] as const,
  templates: (serverId: string) =>
    [...agentsQueryKeys.all, 'templates', serverId] as const,
}

type AgentRunKeys = 'backend' | 'model' | 'effort' | 'thinkingLevel' | 'skills'

/** `list_agents` result. Older servers do not send the run configuration. */
type RawAgentSummary = Omit<
  AgentSummary,
  'serverId' | 'serverName' | AgentRunKeys
> &
  Partial<Pick<AgentSummary, AgentRunKeys>>

/** Tag an agent with its server; remote IDs become server-scoped keys so
 * commands and chat sessions route to that server. */
export function scopeAgentSummary(
  serverId: string,
  serverName: string,
  raw: RawAgentSummary
): AgentSummary {
  const agent = {
    ...raw,
    backend: raw.backend ?? null,
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    thinkingLevel: raw.thinkingLevel ?? null,
    skills: raw.skills ?? [],
  }
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
      backend?: string | null
      model?: string | null
      effort?: string | null
      thinkingLevel?: string | null
      skills?: AgentSkill[]
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

/** Predefined roles on one server. The catalog is static for a server build. */
export function useAgentTemplates(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: agentsQueryKeys.templates(serverId),
    queryFn: () =>
      invokeForServer<AgentTemplate[]>(serverId, 'list_agent_templates'),
    enabled,
    staleTime: Infinity,
  })
}

/** Install a template as a custom agent on `serverId`. */
export function useInstallAgentTemplate() {
  return useAgentsMutation(
    async ({
      serverId,
      templateId,
    }: {
      serverId: string
      templateId: string
    }): Promise<{ key: string; name: string }> => {
      const agent = await invokeForServer<{ id: string; name: string }>(
        serverId,
        'install_agent_template',
        { templateId }
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

export function useRevertAgentChange() {
  return useAgentsMutation(
    ({ agentId, changeId }: { agentId: string; changeId: number }) =>
      invokeAgent<AgentChange>(agentId, 'revert_agent_change', { changeId })
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

export function useCreateAgentSchedule() {
  return useAgentsMutation((args: { agentId: string } & ScheduleInput) => {
    const payload: Record<string, unknown> = { ...args }
    return invoke<AgentSchedule>('create_agent_schedule', payload)
  })
}

export function useUpdateAgentSchedule() {
  return useAgentsMutation(
    (
      args: { agentId: string; scheduleId: number } & Partial<ScheduleInput>
    ) => {
      const payload: Record<string, unknown> = { ...args }
      return invoke<AgentSchedule>('update_agent_schedule', payload)
    }
  )
}

export function useSaveAgentMemory() {
  return useAgentsMutation(
    (args: {
      agentId: string
      content: string
      kind: MemoryKind
      scope: MemoryScope
      pinned: boolean
      projectId?: string | null
    }) => invoke<AgentMemory>('save_agent_memory', args)
  )
}

export interface AgentMemoryQuery {
  query?: string
  kind?: MemoryKind
  scope?: MemoryScope
  projectId?: string
  pinned?: boolean
  from?: number
  to?: number
}

export function useSearchAgentMemory(
  agentId: string,
  request: AgentMemoryQuery,
  enabled: boolean
) {
  return useQuery({
    queryKey: [...agentsQueryKeys.details(agentId), 'memory-search', request],
    queryFn: () =>
      invoke<AgentMemory[]>('search_agent_memory', { agentId, ...request }),
    enabled: enabled && !!agentId,
  })
}

export function useSupersedeAgentMemory() {
  return useAgentsMutation(
    (args: { agentId: string; memoryId: number; content: string }) =>
      invoke<AgentMemory>('supersede_agent_memory', args)
  )
}

export function useSaveAgentJournal() {
  return useAgentsMutation(
    (args: {
      agentId: string
      content: string
      occurredAt?: number | null
      projectId?: string | null
    }) => invoke<AgentJournalEntry>('save_agent_journal', args)
  )
}

export function useSearchAgentJournal(
  agentId: string,
  request: AgentMemoryQuery,
  enabled: boolean
) {
  return useQuery({
    queryKey: [...agentsQueryKeys.details(agentId), 'journal-search', request],
    queryFn: () =>
      invoke<AgentJournalEntry[]>('search_agent_journal', {
        agentId,
        ...request,
      }),
    enabled: enabled && !!agentId,
  })
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

export interface SubagentTypeInput {
  id?: number
  name: string
  description: string
  instructions: string
  shared: boolean
  backend: string | null
  model: string | null
  effort: string | null
  thinkingLevel: string | null
  skills: AgentSkill[]
  permissionMode: string | null
  toolMode: string | null
}

export function useSaveSubagentType() {
  return useAgentsMutation(
    ({ agentId, ...input }: { agentId: string } & SubagentTypeInput) =>
      invokeAgent<SubagentType>(agentId, 'save_agent_subagent_type', input)
  )
}

export function useDeleteSubagentType() {
  return useAgentsMutation((args: { agentId: string; typeId: number }) =>
    invokeAgent<null>(args.agentId, 'delete_agent_subagent_type', {
      typeId: args.typeId,
    })
  )
}

export function useSpawnSubagent() {
  return useAgentsMutation(
    (args: { agentId: string; typeName: string; task: string }) =>
      invokeAgent<AgentTask>(args.agentId, 'spawn_agent_subagent', {
        typeName: args.typeName,
        task: args.task,
      })
  )
}
