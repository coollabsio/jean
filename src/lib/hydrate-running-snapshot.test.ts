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
      answeredQuestions: {},
    })
  })

  it('ignores empty thinking blocks so live blocks are not duplicated', () => {
    // Live streaming skips Claude's empty thinking placeholder.
    useChatStore.setState({
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Checking the card.' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
        ],
      },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Checking the card.' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Sending the purchase.' },
        ],
      })
    )

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [
        { type: 'text', text: 'Checking the card.' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
        { type: 'text', text: 'Sending the purchase.' },
      ]
    )
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

  it('does not append an older live prefix to a newer snapshot', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Windows 10 LTSC helps.' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
        ],
      },
    })

    const snapshot = assistantMessage({
      content_blocks: [
        { type: 'text', text: 'Windows 10 LTSC helps.' },
        { type: 'tool_use', tool_call_id: 'tool-1' },
        { type: 'text', text: 'On native Windows, Claude writes' },
      ],
    })
    hydrateRunningSnapshot('session-1', snapshot, { allowWhileSending: true })
    hydrateRunningSnapshot('session-1', snapshot, { allowWhileSending: true })

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      snapshot.content_blocks
    )
  })

  it('keeps live blocks that extend beyond an older snapshot', () => {
    const liveBlocks = [
      { type: 'text' as const, text: 'Looking for Windows-only paths.' },
      { type: 'tool_use' as const, tool_call_id: 'tool-1' },
      { type: 'text' as const, text: 'Found the issue.' },
    ]
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      streamingContentBlocks: { 'session-1': liveBlocks },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({ content_blocks: liveBlocks.slice(0, 2) }),
      { allowWhileSending: true }
    )

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      liveBlocks
    )
  })

  it('uses the longer text block when a snapshot and live stream share a prefix', () => {
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      streamingContentBlocks: {
        'session-1': [{ type: 'text', text: 'Windows 10' }],
      },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [{ type: 'text', text: 'Windows 10 LTSC helps.' }],
      }),
      { allowWhileSending: true }
    )

    expect(useChatStore.getState().streamingContentBlocks['session-1']).toEqual(
      [{ type: 'text', text: 'Windows 10 LTSC helps.' }]
    )
  })

  it('drops answered live-only tool calls from an earlier paused turn (#779)', () => {
    useChatStore.setState({
      answeredQuestions: { 'session-1': new Set(['old-question']) },
      streamingContentBlocks: {
        'session-1': [
          { type: 'text', text: 'Which option?' },
          { type: 'tool_use', tool_call_id: 'old-question' },
        ],
      },
      activeToolCalls: {
        'session-1': [
          {
            id: 'old-question',
            name: 'AskUserQuestion',
            input: { questions: [] },
          },
        ],
      },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
        tool_calls: [{ id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
      })
    )

    const state = useChatStore.getState()
    expect(state.activeToolCalls['session-1']?.map(tool => tool.id)).toEqual([
      'tool-1',
    ])
    expect(
      state.streamingContentBlocks['session-1']?.some(
        block =>
          block.type === 'tool_use' && block.tool_call_id === 'old-question'
      )
    ).toBe(false)
  })

  it('keeps unanswered live-only tool calls', () => {
    useChatStore.setState({
      answeredQuestions: { 'session-1': new Set(['other-question']) },
      streamingContentBlocks: {
        'session-1': [{ type: 'tool_use', tool_call_id: 'live-question' }],
      },
      activeToolCalls: {
        'session-1': [
          {
            id: 'live-question',
            name: 'AskUserQuestion',
            input: { questions: [] },
          },
        ],
      },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
        tool_calls: [{ id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
      })
    )

    const state = useChatStore.getState()
    expect(state.activeToolCalls['session-1']?.map(tool => tool.id)).toEqual([
      'tool-1',
      'live-question',
    ])
    expect(state.streamingContentBlocks['session-1']).toEqual([
      { type: 'tool_use', tool_call_id: 'tool-1' },
      { type: 'tool_use', tool_call_id: 'live-question' },
    ])
  })

  it('keeps answered tool calls that are part of the snapshot', () => {
    useChatStore.setState({
      answeredQuestions: { 'session-1': new Set(['question-1']) },
      activeToolCalls: {
        'session-1': [
          {
            id: 'question-1',
            name: 'AskUserQuestion',
            input: { questions: [] },
          },
        ],
      },
    })

    hydrateRunningSnapshot(
      'session-1',
      assistantMessage({
        content_blocks: [{ type: 'tool_use', tool_call_id: 'question-1' }],
        tool_calls: [
          {
            id: 'question-1',
            name: 'AskUserQuestion',
            input: { questions: [] },
          },
        ],
      })
    )

    expect(
      useChatStore.getState().activeToolCalls['session-1']?.map(tool => tool.id)
    ).toEqual(['question-1'])
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
