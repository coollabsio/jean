import { describe, expect, it } from 'vitest'
import { extractCodexAgents } from './useActiveTodosAndAgents'
import type { ToolCall } from '@/types/chat'

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

  it('marks interrupted v2 agents as errored', () => {
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
        status: 'errored',
        message: undefined,
      },
    ])
  })
})
