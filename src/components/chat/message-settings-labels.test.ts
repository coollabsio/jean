import { describe, expect, it } from 'vitest'
import type { Backend, ChatMessage } from '@/types/chat'
import {
  getProviderChangeBeforeMessage,
  inferBackendFromModel,
} from './message-settings-labels'

function userMessage(
  id: string,
  model: string | undefined,
  timestamp = 1,
  backend?: Backend
): ChatMessage {
  return {
    id,
    session_id: 'session-1',
    role: 'user',
    content: `msg ${id}`,
    timestamp,
    tool_calls: [],
    model,
    backend,
  } as ChatMessage
}

function assistantMessage(id: string, timestamp = 2): ChatMessage {
  return {
    id,
    session_id: 'session-1',
    role: 'assistant',
    content: `reply ${id}`,
    timestamp,
    tool_calls: [],
  }
}

describe('inferBackendFromModel', () => {
  it('classifies known backends from model ids', () => {
    expect(inferBackendFromModel('claude-sonnet-4-6[1m]')).toBe('claude')
    expect(inferBackendFromModel('sonnet')).toBe('claude')
    expect(inferBackendFromModel('gpt-5.4')).toBe('codex')
    expect(inferBackendFromModel('cursor/auto')).toBe('cursor')
    expect(inferBackendFromModel('opencode/gpt-5.2')).toBe('opencode')
    expect(inferBackendFromModel('pi/sonnet')).toBe('pi')
    expect(inferBackendFromModel('commandcode/deepseek/x')).toBe('commandcode')
    expect(inferBackendFromModel('grok/grok-4.5')).toBe('grok')
    expect(inferBackendFromModel('kimi/k2')).toBe('kimi')
    expect(inferBackendFromModel('antigravity/auto')).toBe('antigravity')
    expect(inferBackendFromModel('antigravity/gemini-3.1-pro-high')).toBe(
      'antigravity'
    )
  })

  it('returns null for missing model', () => {
    expect(inferBackendFromModel(undefined)).toBeNull()
    expect(inferBackendFromModel(null)).toBeNull()
    expect(inferBackendFromModel('')).toBeNull()
  })
})

describe('getProviderChangeBeforeMessage', () => {
  it('returns null when there is no previous user model', () => {
    const messages = [
      userMessage('u1', 'claude-sonnet-4-6[1m]'),
      assistantMessage('a1'),
    ]
    expect(getProviderChangeBeforeMessage(messages, 0)).toBeNull()
  })

  it('returns null when provider stays the same', () => {
    const messages = [
      userMessage('u1', 'claude-sonnet-4-6[1m]'),
      assistantMessage('a1'),
      userMessage('u2', 'claude-opus-4-8[1m]', 3),
    ]
    expect(getProviderChangeBeforeMessage(messages, 2)).toBeNull()
  })

  it('detects a Claude → Codex provider switch', () => {
    const messages = [
      userMessage('u1', 'claude-sonnet-4-6[1m]'),
      assistantMessage('a1'),
      userMessage('u2', 'gpt-5.4', 3),
    ]
    expect(getProviderChangeBeforeMessage(messages, 2)).toEqual({
      from: 'claude',
      to: 'codex',
      fromLabel: 'Claude',
      toLabel: 'Codex',
    })
  })

  it('uses the backend recorded for the prompt when its model is stale', () => {
    const messages = [
      userMessage('u1', 'gpt-5.4'),
      assistantMessage('a1'),
      userMessage('u2', 'gpt-5.4', 3, 'claude'),
    ]

    expect(getProviderChangeBeforeMessage(messages, 2)).toEqual({
      from: 'codex',
      to: 'claude',
      fromLabel: 'Codex',
      toLabel: 'Claude',
    })
  })

  it('detects Codex → Grok switches and skips assistant-only rows', () => {
    const messages = [
      userMessage('u1', 'gpt-5.4'),
      assistantMessage('a1'),
      assistantMessage('a2', 3),
      userMessage('u2', 'grok/grok-4.5', 4),
    ]
    expect(getProviderChangeBeforeMessage(messages, 3)).toEqual({
      from: 'codex',
      to: 'grok',
      fromLabel: 'Codex',
      toLabel: 'Grok',
    })
  })

  it('detects Grok → Antigravity switches', () => {
    const messages = [
      userMessage('u1', 'grok/grok-4.5'),
      assistantMessage('a1'),
      userMessage('u2', 'antigravity/auto', 3),
    ]
    expect(getProviderChangeBeforeMessage(messages, 2)).toEqual({
      from: 'grok',
      to: 'antigravity',
      fromLabel: 'Grok',
      toLabel: 'Antigravity CLI',
    })
  })

  it('returns null for assistant messages', () => {
    const messages = [
      userMessage('u1', 'claude-sonnet-4-6[1m]'),
      assistantMessage('a1'),
    ]
    expect(getProviderChangeBeforeMessage(messages, 1)).toBeNull()
  })

  it('skips previous user messages that lack a model', () => {
    const messages = [
      userMessage('u1', 'claude-sonnet-4-6[1m]'),
      assistantMessage('a1'),
      userMessage('u2', undefined, 3),
      assistantMessage('a2', 4),
      userMessage('u3', 'gpt-5.4', 5),
    ]
    // Previous user message has no model; walk further back to u1
    expect(getProviderChangeBeforeMessage(messages, 4)).toEqual({
      from: 'claude',
      to: 'codex',
      fromLabel: 'Claude',
      toLabel: 'Codex',
    })
  })
})
