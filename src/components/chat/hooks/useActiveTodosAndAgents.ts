import { useEffect, useMemo, useState } from 'react'
import { getTodoWriteTodos, isPlanToolCall } from '@/types/chat'
import type {
  ToolCall,
  ChatMessage,
  CodexAgent,
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
): CodexAgent['status'] {
  if (agentStatus === 'completed' || agentStatus === 'shutdown') {
    return 'completed'
  }
  if (
    agentStatus === 'errored' ||
    agentStatus === 'interrupted' ||
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
  isSending: boolean
): CodexAgent[] {
  const agents = new Map<string, CodexAgent>()

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

    if (tc.name === 'SpawnAgent') {
      const prompt = stringField(input, 'prompt', 'prompt') ?? ''
      const threadId = receiverThreadIds[0] ?? tc.id
      const state = agentsStates[threadId]
      agents.set(threadId, {
        id: threadId,
        prompt: truncateAgentPrompt(prompt),
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
        id: existing?.id ?? threadId,
        prompt: existing?.prompt ?? threadId,
        status: normalizeCodexAgentStatus(state.status, toolCallStatus),
        message:
          typeof state.message === 'string' ? state.message : existing?.message,
      })
    }
  }

  return Array.from(agents.values()).map(agent => {
    if (isSending || agent.status !== 'in_progress') return agent
    return { ...agent, status: 'completed' }
  })
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
      // Prefer TodoWrite tool calls (Claude TodoWrite, Grok todo_write / TodoWrite)
      for (let i = currentToolCalls.length - 1; i >= 0; i--) {
        const tc = currentToolCalls[i]
        if (!tc) continue
        const todos = getTodoWriteTodos(tc)
        if (todos.length > 0) {
          return {
            todos,
            sourceMessageId: null,
            isFromStreaming: true,
          }
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
      // Prefer TodoWrite tool calls (Claude TodoWrite, Grok todo_write / TodoWrite)
      for (let i = lastAssistantMessage.tool_calls.length - 1; i >= 0; i--) {
        const tc = lastAssistantMessage.tool_calls[i]
        if (!tc) continue
        const todos = getTodoWriteTodos(tc)
        if (todos.length > 0) {
          return {
            todos,
            sourceMessageId: lastAssistantMessage.id,
            isFromStreaming: false,
          }
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

  // Get active agents from Codex collab tool calls
  const {
    agents: activeAgents,
    sourceMessageId: agentSourceMessageId,
    isFromStreaming: agentIsFromStreaming,
  } = useMemo(() => {
    if (!activeSessionId)
      return { agents: [], sourceMessageId: null, isFromStreaming: false }

    const toolCalls =
      isSending && currentToolCalls.length > 0
        ? currentToolCalls
        : (lastAssistantMessage?.tool_calls ?? [])

    const agents = extractCodexAgents(toolCalls, isSending)

    const sourceId =
      isSending && currentToolCalls.length > 0
        ? null
        : (lastAssistantMessage?.id ?? null)
    return {
      agents,
      sourceMessageId: sourceId,
      isFromStreaming: isSending && currentToolCalls.length > 0,
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
