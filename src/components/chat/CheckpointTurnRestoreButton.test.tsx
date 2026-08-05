import { describe, expect, it } from 'vitest'
import {
  isUserTurnFinished,
  messageHasFileEdits,
  turnHasFileEdits,
} from './CheckpointTurnRestoreButton'
import type { ChatMessage, ToolCall } from '@/types/chat'

function msg(
  id: string,
  role: ChatMessage['role'],
  toolCalls: ToolCall[] = []
): ChatMessage {
  return {
    id,
    role,
    content: role === 'user' ? 'prompt' : 'reply',
    timestamp: Date.now(),
    session_id: 's1',
    tool_calls: toolCalls,
  }
}

describe('CheckpointTurnRestoreButton helpers', () => {
  it('detects Edit and FileChange tool calls', () => {
    expect(
      messageHasFileEdits([
        {
          id: '1',
          name: 'Edit',
          input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
        },
      ])
    ).toBe(true)
    expect(
      messageHasFileEdits([
        {
          id: '2',
          name: 'FileChange',
          input: [{ path: 'b.ts', diff: '+x' }],
        },
      ])
    ).toBe(true)
    expect(
      messageHasFileEdits([
        {
          id: '4',
          name: 'Write',
          input: { file_path: 'c.ts', content: 'x' },
        },
      ])
    ).toBe(true)
    expect(
      messageHasFileEdits([{ id: '3', name: 'Bash', input: { command: 'ls' } }])
    ).toBe(false)
  })

  it('detects file edits only within the same turn after a user message', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', [
        {
          id: 't1',
          name: 'FileChange',
          input: [{ path: 'a.ts', diff: '+x' }],
        },
      ]),
      msg('u2', 'user'),
      msg('a2', 'assistant'),
    ]
    expect(turnHasFileEdits(messages, 0)).toBe(true)
    expect(turnHasFileEdits(messages, 2)).toBe(false)
  })

  it('treats a turn as finished when a later user message exists', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', [
        {
          id: 't1',
          name: 'FileChange',
          input: [{ path: 'a.ts', diff: '+x' }],
        },
      ]),
      msg('u2', 'user'),
    ]
    expect(isUserTurnFinished(messages, 0, true)).toBe(true)
    expect(isUserTurnFinished(messages, 0, false)).toBe(true)
  })

  it('hides unfinished open turns while the session is still sending', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant', [
        {
          id: 't1',
          name: 'Write',
          input: { file_path: 'a.ts', content: 'x' },
        },
      ]),
    ]
    expect(isUserTurnFinished(messages, 0, true)).toBe(false)
    expect(isUserTurnFinished(messages, 0, false)).toBe(true)
  })

  it('treats a lone user message as unfinished while sending', () => {
    const messages = [msg('u1', 'user')]
    expect(isUserTurnFinished(messages, 0, true)).toBe(false)
    expect(isUserTurnFinished(messages, 0, false)).toBe(true)
  })
})
