import { useCallback, useEffect, useMemo, useState } from 'react'
import { foldTodoWriteToolCalls, isPlanToolCall } from '@/types/chat'
import type {
  ToolCall,
  ChatMessage,
  SubAgent,
  Todo,
  PlanToolInput,
  PlanStep,
} from '@/types/chat'

/** Convert plan steps to Todo format for display in TodoWidget */
function planStepsToTodos(steps: PlanStep[]): Todo[] {
  return steps.map(step => ({
    content: step.step,
    activeForm: step.step,
    status:
      step.status === 'completed'
        ? 'completed'
        : step.status === 'in_progress'
          ? 'in_progress'
          : 'pending',
  }))
}

/** Extract todos from plan tool call steps (fallback when no TodoWrite exists) */
function extractPlanTodos(toolCalls: ToolCall[]): Todo[] {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i]
    if (tc && isPlanToolCall(tc)) {
      const input = tc.input as PlanToolInput | undefined
      if (input?.steps?.length) {
        return planStepsToTodos(input.steps)
      }
    }
  }
  return []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function stringField(
  input: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): string | undefined {
  const value = input[snakeKey] ?? input[camelKey]
  return typeof value === 'string' ? value : undefined
}

function stringArrayField(
  input: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): string[] {
  const value = input[snakeKey] ?? input[camelKey]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function agentStatesField(
  input: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  const value = input.agents_states ?? input.agentsStates
  const record = asRecord(value)
  if (!record) return {}

  const states: Record<string, Record<string, unknown>> = {}
  for (const [threadId, state] of Object.entries(record)) {
    const stateRecord = asRecord(state)
    if (stateRecord) states[threadId] = stateRecord
  }
  return states
}

function normalizeCodexAgentStatus(
  agentStatus: unknown,
  toolCallStatus?: unknown
): SubAgent['status'] {
  if (agentStatus === 'completed' || agentStatus === 'shutdown') {
    return 'completed'
  }
  if (agentStatus === 'interrupted') {
    // Authoritative interrupted terminal state — do not conflate with error
    return 'interrupted'
  }
  if (
    agentStatus === 'errored' ||
    agentStatus === 'notFound' ||
    toolCallStatus === 'failed'
  ) {
    return 'errored'
  }
  return 'in_progress'
}

function truncateAgentPrompt(prompt: string): string {
  return prompt.length > 80 ? prompt.substring(0, 80) + '...' : prompt
}

/** Codex agent paths look like `/root/reviewer` or `/root/reviewer/helper`. */
export function isCodexAgentPath(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return false
  if (/\s/.test(trimmed)) return false
  return trimmed.split('/').filter(Boolean).length >= 2
}

/** `/root/reviewer/helper` → `reviewer / helper`. */
export function codexAgentCodename(path: string): string {
  const parts = path.trim().split('/').filter(Boolean)
  const named = parts[0] === 'root' ? parts.slice(1) : parts
  if (named.length === 0) return path.trim()
  return named.join(' / ')
}

function codexAgentPath(input: Record<string, unknown>): string | undefined {
  const explicit = stringField(input, 'agent_path', 'agentPath')
  if (explicit && isCodexAgentPath(explicit)) return explicit
  const prompt = stringField(input, 'prompt', 'prompt')
  if (prompt && isCodexAgentPath(prompt)) return prompt
  return undefined
}

function codexTaskPrompt(input: Record<string, unknown>): string | undefined {
  const prompt = stringField(input, 'prompt', 'prompt')
  if (!prompt || isCodexAgentPath(prompt)) return undefined
  return prompt
}

function codexModel(input: Record<string, unknown>): string | undefined {
  const model = stringField(input, 'model', 'model')?.trim()
  return model || undefined
}

/**
 * One-line Codex subagent label for tool rows and the compact ticker.
 * Uses the codename (not `/root/<codename>`) and the model when Codex sent one.
 */
export function codexSubagentDetail(
  input: Record<string, unknown>
): string | undefined {
  const path = codexAgentPath(input)
  const task = codexTaskPrompt(input)
  const name = path ? codexAgentCodename(path) : undefined
  const model = codexModel(input)
  const modelLabel = model ? formatSubagentModel(model) : undefined
  const primary = task ?? name
  if (primary && modelLabel) {
    return `${truncateAgentPrompt(primary)} · ${modelLabel}`
  }
  if (primary) return truncateAgentPrompt(primary)
  return modelLabel ?? stringField(input, 'agent_id', 'agentId')
}

function describeCodexAgent(
  existing: SubAgent | undefined,
  input: Record<string, unknown>,
  threadId: string
): Pick<SubAgent, 'prompt' | 'fullPrompt' | 'label' | 'model'> {
  const path = codexAgentPath(input)
  const task = codexTaskPrompt(input)
  const codename = path ? codexAgentCodename(path) : undefined
  const previousTask =
    existing?.fullPrompt && !isCodexAgentPath(existing.fullPrompt)
      ? existing.fullPrompt
      : undefined
  const description = task ?? previousTask
  const name =
    codename ??
    (existing?.label && !isCodexAgentPath(existing.label)
      ? existing.label
      : undefined)
  const previousPrompt =
    existing?.prompt &&
    existing.prompt !== existing.id &&
    !isCodexAgentPath(existing.prompt)
      ? existing.prompt
      : undefined
  const prompt = description || name || previousPrompt || threadId

  return {
    label: description && name ? name : undefined,
    prompt: truncateAgentPrompt(prompt),
    fullPrompt: description,
    model: codexModel(input) ?? existing?.model,
  }
}

export function extractCodexAgents(
  toolCalls: ToolCall[],
  isSending: boolean,
  parentTurnCancelled = false
): SubAgent[] {
  const agents = new Map<string, SubAgent>()
  const agentToolCalls = new Map<string, ToolCall[]>()

  for (const tc of toolCalls) {
    const input = asRecord(tc.input)
    if (!input) continue

    const receiverThreadIds = stringArrayField(
      input,
      'receiver_thread_ids',
      'receiverThreadIds'
    )
    const agentsStates = agentStatesField(input)
    const toolCallStatus = input.status

    const threadIds = new Set([
      ...receiverThreadIds,
      ...Object.keys(agentsStates),
    ])
    if (tc.name === 'SpawnAgent') threadIds.add(receiverThreadIds[0] ?? tc.id)
    for (const threadId of threadIds) {
      const calls = agentToolCalls.get(threadId) ?? []
      calls.push(tc)
      agentToolCalls.set(threadId, calls)
    }

    if (tc.name === 'SpawnAgent') {
      const threadId = receiverThreadIds[0] ?? tc.id
      const state = agentsStates[threadId]
      const described = describeCodexAgent(
        agents.get(threadId),
        input,
        threadId
      )
      agents.set(threadId, {
        id: threadId,
        ...described,
        status: normalizeCodexAgentStatus(state?.status, toolCallStatus),
        message: typeof state?.message === 'string' ? state.message : undefined,
      })
    }

    for (const threadId of receiverThreadIds) {
      if (!agents.has(threadId)) {
        agents.set(threadId, {
          id: threadId,
          prompt: threadId,
          status: 'in_progress',
        })
      }
    }

    for (const [threadId, state] of Object.entries(agentsStates)) {
      const existing = agents.get(threadId)
      const described = describeCodexAgent(existing, input, threadId)
      agents.set(threadId, {
        ...existing,
        ...described,
        id: existing?.id ?? threadId,
        status: normalizeCodexAgentStatus(state.status, toolCallStatus),
        message:
          typeof state.message === 'string' ? state.message : existing?.message,
      })
    }
  }

  // Codex sub_agent_activity has no "completed" kind. A normal parent turn end
  // is therefore the terminal completion signal for agents that still have a
  // running state. Keep cancellation distinct so abandoned work is not green.
  return Array.from(agents.values()).map(rawAgent => {
    const agent = { ...rawAgent, toolCalls: agentToolCalls.get(rawAgent.id) }
    if (isSending || agent.status !== 'in_progress') return agent
    return {
      ...agent,
      status: parentTurnCancelled
        ? ('interrupted' as const)
        : ('completed' as const),
      message: parentTurnCancelled
        ? (agent.message ?? 'Interrupted before completion')
        : agent.message,
    }
  })
}

/** `claude-opus-5-5` / `claude-haiku-4-5-20251001` → `Opus 5.5` / `Haiku 4.5` */
export function formatSubagentModel(model: string): string {
  const match =
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/.exec(model)
  if (!match) return model
  const [, family = '', major, minor] = match
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return `${name} ${major}${minor ? `.${minor}` : ''}`
}

/**
 * Extract Claude subagents from Task/Agent tool calls. The tool call stays in
 * the timeline; this only feeds the Subagents panel above the input.
 */
export function extractClaudeAgents(
  toolCalls: ToolCall[],
  isSending: boolean,
  parentTurnCancelled = false
): SubAgent[] {
  const subToolCalls = new Map<string, ToolCall[]>()
  for (const tc of toolCalls) {
    if (tc.parent_tool_use_id) {
      const calls = subToolCalls.get(tc.parent_tool_use_id) ?? []
      calls.push(tc)
      subToolCalls.set(tc.parent_tool_use_id, calls)
    }
  }

  const agents: SubAgent[] = []
  for (const tc of toolCalls) {
    if (tc.name !== 'Task' && tc.name !== 'Agent') continue
    const input = asRecord(tc.input) ?? {}
    const description =
      stringField(input, 'description', 'description') ??
      stringField(input, 'prompt', 'prompt') ??
      ''

    let status: SubAgent['status']
    if (tc.is_error) status = 'errored'
    else if (tc.output?.trim()) status = 'completed'
    else if (isSending) status = 'in_progress'
    else status = parentTurnCancelled ? 'interrupted' : 'completed'

    const calls = subToolCalls.get(tc.id) ?? []
    const usage = tc.subagent_usage
    agents.push({
      id: tc.id,
      prompt: truncateAgentPrompt(description),
      status,
      label: usage?.model
        ? formatSubagentModel(usage.model)
        : (stringField(input, 'subagent_type', 'subagentType') ?? tc.name),
      toolCount: Math.max(calls.length, usage?.tool_uses ?? 0),
      tokens: usage?.total_tokens,
      durationMs: usage?.duration_ms || undefined,
      fullPrompt: stringField(input, 'prompt', 'prompt'),
      report: tc.output?.trim() || undefined,
      toolCalls: calls,
      allToolCalls: toolCalls,
    })
  }
  return agents
}

function mergeSubagent(prev: SubAgent, next: SubAgent): SubAgent {
  const nextPromptIsWeak =
    !next.prompt || next.prompt === next.id || isCodexAgentPath(next.prompt)
  const prevPromptIsReal =
    !!prev.prompt && prev.prompt !== prev.id && !isCodexAgentPath(prev.prompt)
  const toolCount = Math.max(prev.toolCount ?? 0, next.toolCount ?? 0)
  return {
    ...prev,
    ...next,
    label:
      next.label ??
      prev.label ??
      (!next.fullPrompt &&
      prev.fullPrompt &&
      next.prompt &&
      next.prompt !== next.id &&
      next.prompt !== prev.prompt
        ? next.prompt
        : undefined),
    model: next.model ?? prev.model,
    // A later path-only update (`/root/reviewer` → reviewer) must not replace
    // the task the agent was actually given.
    prompt: next.fullPrompt
      ? next.prompt
      : prev.fullPrompt
        ? prev.prompt
        : nextPromptIsWeak && prevPromptIsReal
          ? prev.prompt
          : next.prompt,
    fullPrompt: next.fullPrompt ?? prev.fullPrompt,
    message: next.message ?? prev.message,
    toolCount: toolCount || undefined,
    tokens: next.tokens ?? prev.tokens,
    durationMs: next.durationMs ?? prev.durationMs,
    report: next.report ?? prev.report,
    toolCalls:
      next.toolCalls && next.toolCalls.length > 0
        ? next.toolCalls
        : prev.toolCalls,
    status: next.status,
  }
}

function mergeSubagents(settled: SubAgent[], live: SubAgent[]): SubAgent[] {
  const byId = new Map<string, SubAgent>()
  for (const agent of settled) {
    const prev = byId.get(agent.id)
    byId.set(agent.id, prev ? mergeSubagent(prev, agent) : agent)
  }
  for (const agent of live) {
    const prev = byId.get(agent.id)
    byId.set(agent.id, prev ? mergeSubagent(prev, agent) : agent)
  }
  return Array.from(byId.values())
}

function agentsFromToolCalls(
  toolCalls: ToolCall[],
  isSending: boolean,
  parentTurnCancelled: boolean
): SubAgent[] {
  return [
    ...extractCodexAgents(toolCalls, isSending, parentTurnCancelled),
    ...extractClaudeAgents(toolCalls, isSending, parentTurnCancelled),
  ]
}

interface UseActiveTodosAndAgentsParams {
  activeSessionId: string | null | undefined
  isSending: boolean
  currentToolCalls: ToolCall[]
  lastAssistantMessage: ChatMessage | undefined
  /** Full session transcript. Earlier turns stay visible with settled status. */
  messages?: ChatMessage[]
}

/**
 * Extracts active todos and agents from streaming tool calls or last assistant message.
 * Includes dismissal state management for both.
 */
export function useActiveTodosAndAgents({
  activeSessionId,
  isSending,
  currentToolCalls,
  lastAssistantMessage,
  messages,
}: UseActiveTodosAndAgentsParams) {
  // Track which message's todos were dismissed
  const [dismissedTodoMessageId, setDismissedTodoMessageId] = useState<
    string | null
  >(null)

  // Get active todos from streaming tool calls OR last assistant message
  const {
    todos: activeTodos,
    sourceMessageId: todoSourceMessageId,
    isFromStreaming: todoIsFromStreaming,
  } = useMemo(() => {
    if (!activeSessionId)
      return { todos: [], sourceMessageId: null, isFromStreaming: false }

    if (isSending && currentToolCalls.length > 0) {
      // Fold TodoWrite calls chronologically so Grok merge:true patches update
      // the full list instead of sticking on the first snapshot.
      const todos = foldTodoWriteToolCalls(currentToolCalls)
      if (todos.length > 0) {
        return {
          todos,
          sourceMessageId: null,
          isFromStreaming: true,
        }
      }
      // Fall back to plan steps (Codex plans surface steps as todos)
      const planTodos = extractPlanTodos(currentToolCalls)
      if (planTodos.length > 0) {
        return {
          todos: planTodos,
          sourceMessageId: null,
          isFromStreaming: true,
        }
      }
    }

    if (lastAssistantMessage?.tool_calls) {
      const todos = foldTodoWriteToolCalls(lastAssistantMessage.tool_calls)
      if (todos.length > 0) {
        return {
          todos,
          sourceMessageId: lastAssistantMessage.id,
          isFromStreaming: false,
        }
      }
      // Fall back to plan steps
      const planTodos = extractPlanTodos(lastAssistantMessage.tool_calls)
      if (planTodos.length > 0) {
        return {
          todos: planTodos,
          sourceMessageId: lastAssistantMessage.id,
          isFromStreaming: false,
        }
      }
    }

    return { todos: [], sourceMessageId: null, isFromStreaming: false }
  }, [activeSessionId, isSending, currentToolCalls, lastAssistantMessage])

  // Agent ids shown when the panel was dismissed. Agent ids stay the same
  // from streaming to the persisted message, but message ids do not.
  const [dismissedAgentKey, setDismissedAgentKey] = useState<string | null>(
    null
  )

  // Finished turns settle here. A new prompt must not replay their persisted
  // "running" state as a spinner, and cancel must not leave them loading.
  const settledAgents = useMemo(() => {
    if (!activeSessionId) {
      return { agents: [] as SubAgent[], toolIds: new Set<string>() }
    }

    const history = messages
      ? messages.filter(message => message.role === 'assistant')
      : lastAssistantMessage
        ? [lastAssistantMessage]
        : []
    const toolIds = new Set<string>()
    const settled: SubAgent[] = []
    for (const message of history) {
      const toolCalls = message.tool_calls ?? []
      for (const toolCall of toolCalls) toolIds.add(toolCall.id)
      settled.push(
        ...agentsFromToolCalls(toolCalls, false, message.cancelled === true)
      )
    }
    return { agents: mergeSubagents(settled, []), toolIds }
  }, [activeSessionId, lastAssistantMessage, messages])

  // Get active agents from Codex collab tool calls and Claude Task/Agent calls.
  // Only tool calls that are not already in a persisted turn can be in progress.
  const activeAgents = useMemo((): SubAgent[] => {
    if (!activeSessionId) return []

    const freshToolCalls = isSending
      ? currentToolCalls.filter(
          toolCall => !settledAgents.toolIds.has(toolCall.id)
        )
      : []
    const live = agentsFromToolCalls(freshToolCalls, true, false)
    return mergeSubagents(settledAgents.agents, live)
  }, [activeSessionId, isSending, currentToolCalls, settledAgents])

  const agentKey = activeAgents.map(agent => agent.id).join('\n')
  // New agents change the key, so the panel shows again. Running agents keep it
  // visible for live status.
  const isAgentWidgetDismissed =
    dismissedAgentKey === agentKey &&
    !activeAgents.some(agent => agent.status === 'in_progress')
  const dismissAgentWidget = useCallback(
    () => setDismissedAgentKey(agentKey),
    [agentKey]
  )

  // Auto-clear todo dismissal on new streaming todos
  useEffect(() => {
    if (isSending && activeTodos.length > 0 && todoSourceMessageId === null) {
      if (dismissedTodoMessageId !== '__streaming__') {
        queueMicrotask(() => setDismissedTodoMessageId(null))
      }
    }
    if (
      !isSending &&
      todoSourceMessageId !== null &&
      dismissedTodoMessageId === '__streaming__'
    ) {
      queueMicrotask(() => setDismissedTodoMessageId(todoSourceMessageId))
    }
  }, [
    isSending,
    activeTodos.length,
    todoSourceMessageId,
    dismissedTodoMessageId,
  ])

  return {
    activeTodos,
    todoSourceMessageId,
    todoIsFromStreaming,
    dismissedTodoMessageId,
    setDismissedTodoMessageId,
    activeAgents,
    isAgentWidgetDismissed,
    dismissAgentWidget,
  }
}
