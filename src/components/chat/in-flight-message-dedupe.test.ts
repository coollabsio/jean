import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/types/chat'
import { dedupeInFlightAssistantMessage } from './in-flight-message-dedupe'

function createMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? 'message-id',
    session_id: overrides.session_id ?? 'session-1',
    role: overrides.role ?? 'assistant',
    content: overrides.content ?? '',
    timestamp: overrides.timestamp ?? 1,
    tool_calls: overrides.tool_calls ?? [],
    content_blocks: overrides.content_blocks,
    cancelled: overrides.cancelled,
    plan_approved: overrides.plan_approved,
    model: overrides.model,
    execution_mode: overrides.execution_mode,
    thinking_level: overrides.thinking_level,
    effort_level: overrides.effort_level,
    recovered: overrides.recovered,
    usage: overrides.usage,
  }
}

describe('dedupeInFlightAssistantMessage', () => {
  it('keeps messages unchanged when the session is not sending', () => {
    const messages = [
      createMessage({ id: 'user-1', role: 'user', content: 'Prompt' }),
      createMessage({
        id: 'running-123',
        role: 'assistant',
        content: 'Partial response',
      }),
    ]

    expect(
      dedupeInFlightAssistantMessage(messages, {
        isSending: false,
        streamingContent: 'Partial response',
        streamingContentBlocks: [],
        streamingToolCalls: [],
      })
    ).toEqual(messages)
  })

  it('hides a trailing running snapshot while live streaming is active', () => {
    const messages = [
      createMessage({ id: 'user-1', role: 'user', content: 'Prompt' }),
      createMessage({
        id: 'running-123',
        role: 'assistant',
        content: 'Partial response',
      }),
    ]

    expect(
      dedupeInFlightAssistantMessage(messages, {
        isSending: true,
        streamingContent: 'Partial response with more text',
        streamingContentBlocks: [],
        streamingToolCalls: [],
      })
    ).toEqual([messages[0]])
  })

  it('hides a persisted trailing assistant that matches the current stream', () => {
    const messages = [
      createMessage({ id: 'user-1', role: 'user', content: 'Prompt' }),
      createMessage({
        id: 'assistant-1',
        role: 'assistant',
        content: 'Working on it',
      }),
    ]

    expect(
      dedupeInFlightAssistantMessage(messages, {
        isSending: true,
        streamingContent: 'Working on it',
        streamingContentBlocks: [],
        streamingToolCalls: [],
      })
    ).toEqual([messages[0]])
  })

  it('hides a trailing assistant when streaming blocks match the persisted prefix', () => {
    const messages = [
      createMessage({ id: 'user-1', role: 'user', content: 'Prompt' }),
      createMessage({
        id: 'assistant-1',
        role: 'assistant',
        content_blocks: [
          { type: 'text', text: 'Plan:' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
        ],
        tool_calls: [{ id: 'tool-1', name: 'Write', input: { file: 'a.ts' } }],
      }),
    ]

    expect(
      dedupeInFlightAssistantMessage(messages, {
        isSending: true,
        streamingContent: '',
        streamingContentBlocks: [
          { type: 'text', text: 'Plan:\n1. Edit file' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
        ],
        streamingToolCalls: [
          { id: 'tool-1', name: 'Write', input: { file: 'a.ts' } },
        ],
      })
    ).toEqual([messages[0]])
  })

  it('hides a trailing assistant even before streaming starts (prevents flicker)', () => {
    const messages = [
      createMessage({ id: 'user-1', role: 'user', content: 'Prompt' }),
      createMessage({
        id: 'assistant-1',
        role: 'assistant',
        content: 'Completed response',
      }),
    ]

    expect(
      dedupeInFlightAssistantMessage(messages, {
        isSending: true,
        streamingContent: '',
        streamingContentBlocks: [],
        streamingToolCalls: [],
      })
    ).toEqual([messages[0]])
  })
})
