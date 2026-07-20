import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

import { useChatStore } from '@/store/chat-store'
import type { ChatMessage } from '@/types/chat'
import { hydrateRunningSnapshot } from './hydrate-running-snapshot'

const assistantMessage = (
  overrides: Partial<ChatMessage> = {}
): ChatMessage => ({
  id: 'running-session-1',
  session_id: 'session-1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  tool_calls: [],
  content_blocks: [],
  ...overrides,
})

describe('hydrateRunningSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)

    useChatStore.setState({
      sendingSessionIds: {},
      streamingContents: {},
      streamingContentBlocks: {},
      streamingReplayContentBlocks: {},
      activeToolCalls: {},
    })
  })

  it('skips hydration while sending by default', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [{ type: 'text', text: 'partial output' }],
      })
    )

    expect(
      useChatStore.getState().streamingContentBlocks['session-1']
    ).toBeUndefined()
  })

  it('hydrates running snapshots during bootstrap when explicitly allowed', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
        ],
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status' },
          },
        ],
      }),
      { allowWhileSending: true }
    )

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
      ]
    )
    expect(useChatStore.getState().activeToolCalls['session-1']).toEqual([
      {
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'rtk git status' },
      },
    ])
  })

  it('keeps snapshot tool calls when live events arrive before hydration', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      streamingContentBlocks: {
        'session-1': [{ type: 'tool_use', tool_call_id: 'tool-2' }],
      },
      activeToolCalls: {
        'session-1': [
          {
            id: 'tool-2',
            name: 'Read',
            input: { file_path: 'src/new.ts' },
          },
        ],
      },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status' },
            output: 'clean',
          },
        ],
      }),
      { allowWhileSending: true }
    )

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'tool_use', tool_call_id: 'tool-1' },
        { type: 'tool_use', tool_call_id: 'tool-2' },
      ]
    )
    expect(useChatStore.getState().activeToolCalls['session-1']).toEqual([
      {
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'rtk git status' },
        output: 'clean',
      },
      {
        id: 'tool-2',
        name: 'Read',
        input: { file_path: 'src/new.ts' },
      },
    ])
  })

  it('does not duplicate snapshot events already received live', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      streamingContentBlocks: {
        'session-1': [
          { type: 'tool_use', tool_call_id: 'tool-2' },
          { type: 'tool_use', tool_call_id: 'tool-3' },
        ],
      },
      activeToolCalls: {
        'session-1': [
          { id: 'tool-2', name: 'Read', input: { file_path: 'src/two.ts' } },
          {
            id: 'tool-3',
            name: 'Read',
            input: { file_path: 'src/three.ts' },
          },
        ],
      },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'tool_use', tool_call_id: 'tool-2' },
        ],
        tool_calls: [
          { id: 'tool-1', name: 'Bash', input: { command: 'first' } },
          { id: 'tool-2', name: 'Read', input: { file_path: 'src/two.ts' } },
        ],
      }),
      { allowWhileSending: true }
    )

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'tool_use', tool_call_id: 'tool-1' },
        { type: 'tool_use', tool_call_id: 'tool-2' },
        { type: 'tool_use', tool_call_id: 'tool-3' },
      ]
    )
    expect(
      useChatStore.getState().activeToolCalls['session-1']?.map(tool => tool.id)
    ).toEqual(['tool-1', 'tool-2', 'tool-3'])
  })

  it('seeds replay dedupe when requested, even if snapshot was already hydrated', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      streamingContentBlocks: {
        'session-1': [{ type: 'text', text: 'old content' }],
      },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [
          { type: 'text', text: 'old content' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
        ],
      }),
      { allowWhileSending: true, dedupeReplayedOutput: true }
    )

    expect(
      useChatStore.getState().streamingReplayContentBlocks['session-1']
    ).toEqual([
      { type: 'text', text: 'old content' },
      { type: 'tool_use', tool_call_id: 'tool-1' },
    ])
  })
})
