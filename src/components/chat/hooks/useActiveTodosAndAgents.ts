import { useEffect, useMemo, useState } from 'react'
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
      const prompt = stringField(input, 'prompt', 'prompt') ?? ''
      const threadId = receiverThreadIds[0] ?? tc.id
      const state = agentsStates[threadId]
      agents.set(threadId, {
        id: threadId,
        prompt: truncateAgentPrompt(prompt),
        fullPrompt: prompt,
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
      agents.set(threadId, {
        ...existing,
        id: existing?.id ?? threadId,
        prompt: existing?.prompt ?? threadId,
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

interface UseActiveTodosAndAgentsParams {
  activeSessionId: string | null | undefined
  isSending: boolean
  currentToolCalls: ToolCall[]
  lastAssistantMessage: ChatMessage | undefined
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

  // Track which message's agents were dismissed
  const [dismissedAgentMessageId, setDismissedAgentMessageId] = useState<
    string | null
  >(null)

  // Get active agents from Codex collab tool calls and Claude Task/Agent calls
  const {
    agents: activeAgents,
    sourceMessageId: agentSourceMessageId,
    isFromStreaming: agentIsFromStreaming,
  } = useMemo(() => {
    if (!activeSessionId)
      return { agents: [], sourceMessageId: null, isFromStreaming: false }

    // A new turn starts with no tool calls. Do not reuse the previous turn's
    // agents in that gap, or their persisted running state appears active again.
    const toolCalls = isSending
      ? currentToolCalls
      : (lastAssistantMessage?.tool_calls ?? [])

    const cancelled = lastAssistantMessage?.cancelled === true
    const agents = [
      ...extractCodexAgents(toolCalls, isSending, cancelled),
      ...extractClaudeAgents(toolCalls, isSending, cancelled),
    ]

    const sourceId = isSending ? null : (lastAssistantMessage?.id ?? null)
    return {
      agents,
      sourceMessageId: sourceId,
      isFromStreaming: isSending && agents.length > 0,
    }
  }, [activeSessionId, isSending, currentToolCalls, lastAssistantMessage])

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

  // Auto-clear agent dismissal on new streaming agents
  useEffect(() => {
    if (isSending && activeAgents.length > 0 && agentSourceMessageId === null) {
      if (dismissedAgentMessageId !== '__streaming__') {
        queueMicrotask(() => setDismissedAgentMessageId(null))
      }
    } else if (
      !isSending &&
      agentSourceMessageId !== null &&
      dismissedAgentMessageId === '__streaming__'
    ) {
      queueMicrotask(() => setDismissedAgentMessageId(agentSourceMessageId))
    }
  }, [
    isSending,
    activeAgents.length,
    agentSourceMessageId,
    dismissedAgentMessageId,
  ])

  return {
    activeTodos,
    todoSourceMessageId,
    todoIsFromStreaming,
    dismissedTodoMessageId,
    setDismissedTodoMessageId,
    activeAgents,
    agentSourceMessageId,
    agentIsFromStreaming,
    dismissedAgentMessageId,
    setDismissedAgentMessageId,
  }
}
