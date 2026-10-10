import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  extractClaudeAgents,
  extractCodexAgents,
  formatSubagentModel,
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

    expect(extractCodexAgents(tools, true)).toMatchObject([
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

  it('collects the full prompt and related tool calls per agent', () => {
    const spawn = toolCall('SpawnAgent', {
      prompt: 'x'.repeat(100),
      receiver_thread_ids: ['agent-a'],
    })
    const wait = toolCall('WaitForAgents', {
      receiver_thread_ids: ['agent-a', 'agent-b'],
      agents_states: { 'agent-a': { status: 'completed', message: 'done' } },
    })

    const [agentA, agentB] = extractCodexAgents([spawn, wait], true)
    expect(agentA?.fullPrompt).toBe('x'.repeat(100))
    expect(agentA?.toolCalls).toEqual([spawn, wait])
    expect(agentB?.toolCalls).toEqual([wait])
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

    expect(extractCodexAgents(tools, true)).toMatchObject([
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

    expect(extractCodexAgents(tools, false)).toMatchObject([
      {
        id: 'agent-a',
        prompt: 'Still working',
        status: 'completed',
        message: undefined,
      },
    ])

    // While parent is still sending, leave as in_progress
    expect(extractCodexAgents(tools, true)[0]?.status).toBe('in_progress')

    expect(extractCodexAgents(tools, false, true)).toMatchObject([
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

describe('extractClaudeAgents', () => {
  const tools: ToolCall[] = [
    toolCall('Agent', {
      id: 'agent-1',
      description: 'Review snapshot stills',
      prompt: 'Long prompt',
      subagent_type: 'Explore',
    }),
    toolCall(
      'Task',
      { id: 'task-2', prompt: 'Fix caption overlap' },
      'Report: fixed'
    ),
    {
      ...toolCall('Agent', { id: 'agent-3', description: 'Broken' }, 'boom'),
      is_error: true,
    },
    { ...toolCall('Read', { id: 'read-1' }), parent_tool_use_id: 'agent-1' },
    { ...toolCall('Grep', { id: 'grep-1' }), parent_tool_use_id: 'agent-1' },
  ]

  it('maps Task/Agent calls with status, label and tool count', () => {
    expect(extractClaudeAgents(tools, true)).toMatchObject([
      {
        id: 'agent-1',
        prompt: 'Review snapshot stills',
        status: 'in_progress',
        label: 'Explore',
        toolCount: 2,
      },
      {
        id: 'task-2',
        prompt: 'Fix caption overlap',
        status: 'completed',
        label: 'Task',
        toolCount: 0,
      },
      {
        id: 'agent-3',
        prompt: 'Broken',
        status: 'errored',
        label: 'Agent',
        toolCount: 0,
      },
    ])
  })

  it('exposes full prompt, report and sub-tool calls for the detail view', () => {
    const [agent1, task2] = extractClaudeAgents(tools, true)
    expect(agent1?.fullPrompt).toBe('Long prompt')
    expect(agent1?.toolCalls?.map(tc => tc.id)).toEqual(['read-1', 'grep-1'])
    expect(agent1?.allToolCalls).toBe(tools)
    expect(task2?.report).toBe('Report: fixed')
  })

  it('reads tokens, tool count and time from subagent usage', () => {
    const withUsage: ToolCall = {
      ...toolCall('Agent', { id: 'agent-u', description: 'Usage' }),
      subagent_usage: { total_tokens: 48804, tool_uses: 8, duration_ms: 61421 },
    }
    expect(extractClaudeAgents([withUsage], true)[0]).toMatchObject({
      toolCount: 8,
      tokens: 48804,
      durationMs: 61421,
    })
  })

  it('labels the agent with its model when known', () => {
    const base = toolCall('Agent', {
      id: 'agent-m',
      description: 'Model',
      subagent_type: 'general-purpose',
    })
    expect(extractClaudeAgents([base], true)[0]?.label).toBe('general-purpose')
    const withModel: ToolCall = {
      ...base,
      subagent_usage: {
        total_tokens: 0,
        tool_uses: 0,
        duration_ms: 0,
        model: 'claude-opus-5-5',
      },
    }
    expect(extractClaudeAgents([withModel], true)[0]?.label).toBe('Opus 5.5')
  })

  it('formats Claude model ids', () => {
    expect(formatSubagentModel('claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6')
    expect(formatSubagentModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(formatSubagentModel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(formatSubagentModel('gpt-5')).toBe('gpt-5')
  })

  it('marks agents without output done or interrupted after the turn', () => {
    expect(extractClaudeAgents(tools, false)[0]?.status).toBe('completed')
    expect(extractClaudeAgents(tools, false, true)[0]?.status).toBe(
      'interrupted'
    )
  })
})
