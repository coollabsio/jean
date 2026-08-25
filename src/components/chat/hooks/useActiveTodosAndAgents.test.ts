import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  extractCodexAgents,
  useActiveTodosAndAgents,
} from './useActiveTodosAndAgents'
import type { ChatMessage, ToolCall } from '@/types/chat'

function toolCall(
  name: string,
  input: Record<string, unknown>,
  output?: string
): ToolCall {
  return {
    id: String(input.id ?? `${name}-${Math.random()}`),
    name,
    input,
    output,
  }
}

describe('extractCodexAgents', () => {
  it('updates spawned agent statuses from Codex collab agentsStates', () => {
    const tools = [
      toolCall('SpawnAgent', {
        id: 'call-a',
        type: 'collab_tool_call',
        tool: 'spawnAgent',
        prompt: 'Batch A investigate advisories',
        receiverThreadIds: ['agent-a'],
        status: 'completed',
        agentsStates: {
          'agent-a': { status: 'pendingInit', message: null },
        },
      }),
      toolCall('SpawnAgent', {
        id: 'call-b',
        type: 'collab_tool_call',
        tool: 'spawnAgent',
        prompt: 'Batch B investigate advisories',
        receiver_thread_ids: ['agent-b'],
        status: 'completed',
        agents_states: {
          'agent-b': { status: 'running', message: null },
        },
      }),
      toolCall('WaitForAgents', {
        id: 'wait-1',
        type: 'collab_tool_call',
        tool: 'wait',
        receiverThreadIds: ['agent-a', 'agent-b'],
        status: 'completed',
        agentsStates: {
          'agent-a': { status: 'completed', message: 'A done' },
          'agent-b': { status: 'errored', message: 'B failed' },
        },
      }),
    ]

    expect(extractCodexAgents(tools, true)).toEqual([
      {
        id: 'agent-a',
        prompt: 'Batch A investigate advisories',
        status: 'completed',
        message: 'A done',
      },
      {
        id: 'agent-b',
        prompt: 'Batch B investigate advisories',
        status: 'errored',
        message: 'B failed',
      },
    ])
  })

  it('marks interrupted v2 agents as interrupted (not completed/errored)', () => {
    const tools = [
      toolCall('SpawnAgent', {
        receiver_thread_ids: ['agent-a'],
        prompt: '/root/reviewer',
        agents_states: {
          'agent-a': { status: 'running', message: null },
        },
      }),
      toolCall('CloseAgent', {
        receiver_thread_ids: ['agent-a'],
        agents_states: {
          'agent-a': { status: 'interrupted', message: null },
        },
      }),
    ]

    expect(extractCodexAgents(tools, true)).toEqual([
      {
        id: 'agent-a',
        prompt: '/root/reviewer',
        status: 'interrupted',
        message: undefined,
      },
    ])
  })

  it('completes unresolved agents when the parent turn finishes normally', () => {
    const tools = [
      toolCall('SpawnAgent', {
        receiver_thread_ids: ['agent-a'],
        prompt: 'Still working',
        agents_states: {
          'agent-a': { status: 'running', message: null },
        },
      }),
    ]

    expect(extractCodexAgents(tools, false)).toEqual([
      {
        id: 'agent-a',
        prompt: 'Still working',
        status: 'completed',
        message: undefined,
      },
    ])

    // While parent is still sending, leave as in_progress
    expect(extractCodexAgents(tools, true)[0]?.status).toBe('in_progress')

    expect(extractCodexAgents(tools, false, true)).toEqual([
      {
        id: 'agent-a',
        prompt: 'Still working',
        status: 'interrupted',
        message: 'Interrupted before completion',
      },
    ])
  })
})

describe('useActiveTodosAndAgents', () => {
  it('clears agents from the finished turn when a new prompt starts', () => {
    const lastAssistantMessage = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Finished',
      tool_calls: [
        toolCall('SpawnAgent', {
          receiver_thread_ids: ['agent-a'],
          prompt: 'Investigate the bug',
          agents_states: {
            'agent-a': { status: 'running', message: null },
          },
        }),
      ],
    } as ChatMessage

    const { result, rerender } = renderHook(
      ({ isSending }) =>
        useActiveTodosAndAgents({
          activeSessionId: 'session-1',
          isSending,
          currentToolCalls: [],
          lastAssistantMessage,
        }),
      { initialProps: { isSending: false } }
    )

    expect(result.current.activeAgents[0]?.status).toBe('completed')

    rerender({ isSending: true })

    expect(result.current.activeAgents).toEqual([])
  })
})
