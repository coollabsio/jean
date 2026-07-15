import { describe, expect, it } from 'vitest'
import type { ChatMessage, CodexUserInputRequest, ToolCall } from '@/types/chat'
import {
  findCodexUserInputRequestByToolCallId,
  resolveCodexUserInputResponseToolCallId,
  shouldRenderCodexUserInputFallback,
  upsertCodexUserInputRequest,
} from './codex-user-input-utils'

function createRequest(
  overrides: Partial<CodexUserInputRequest> = {}
): CodexUserInputRequest {
  return {
    rpc_id: 42,
    item_id: 'item-42',
    questions: [
      {
        id: 'choice',
        question: 'Which option?',
        options: [{ label: 'One' }, { label: 'Two' }],
      },
    ],
    ...overrides,
  }
}

function createQuestionToolCall(id: string): ToolCall {
  return {
    id,
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Which option?',
          multiSelect: false,
          options: [{ label: 'One' }, { label: 'Two' }],
        },
      ],
    },
  }
}

function createAssistantMessage(toolCalls: ToolCall[]): ChatMessage {
  return {
    id: 'assistant-1',
    session_id: 'session-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    tool_calls: toolCalls,
  }
}

describe('upsertCodexUserInputRequest', () => {
  it('returns the existing array for an identical replay', () => {
    const request = createRequest()
    const requests = [request]

    expect(upsertCodexUserInputRequest(requests, createRequest())).toBe(
      requests
    )
  })

  it('replaces a matching item_id replay with the latest request', () => {
    const request = createRequest()

    expect(
      upsertCodexUserInputRequest([request], createRequest({ rpc_id: 99 }))
    ).toEqual([expect.objectContaining({ item_id: 'item-42', rpc_id: 99 })])
  })

  it('keeps different non-empty item IDs even when rpc_id matches', () => {
    const request = createRequest()

    expect(
      upsertCodexUserInputRequest(
        [request],
        createRequest({ item_id: 'different-item' })
      )
    ).toHaveLength(2)
  })

  it('falls back to rpc_id when item_id is absent', () => {
    const request = createRequest({ item_id: '' })

    expect(
      upsertCodexUserInputRequest(
        [request],
        createRequest({ item_id: '', questions: [] })
      )
    ).toEqual([expect.objectContaining({ rpc_id: 42, questions: [] })])
  })
})

describe('shouldRenderCodexUserInputFallback', () => {
  it('hides the fallback when the active streaming tool calls represent the request', () => {
    const request = createRequest()

    expect(
      shouldRenderCodexUserInputFallback(
        request,
        [createQuestionToolCall(request.item_id)],
        []
      )
    ).toBe(false)
  })

  it('hides the fallback when a persisted assistant tool call represents the request', () => {
    const request = createRequest({ item_id: '' })

    expect(
      shouldRenderCodexUserInputFallback(
        request,
        [],
        [
          createAssistantMessage([
            createQuestionToolCall(`codex-user-input-${request.rpc_id}`),
          ]),
        ]
      )
    ).toBe(false)
  })

  it('keeps the fallback for hydrated pending state without a matching tool call', () => {
    const request = createRequest()

    expect(
      shouldRenderCodexUserInputFallback(
        request,
        [createQuestionToolCall('unrelated-tool')],
        [createAssistantMessage([createQuestionToolCall('older-request')])]
      )
    ).toBe(true)
  })
})

describe('findCodexUserInputRequestByToolCallId', () => {
  it('resolves the pending request used to route represented-card answer and skip actions', () => {
    const request = createRequest()

    expect(
      findCodexUserInputRequestByToolCallId([request], request.item_id)
    ).toBe(request)
    expect(
      findCodexUserInputRequestByToolCallId([request], 'unrelated-tool')
    ).toBeUndefined()
  })
})

describe('resolveCodexUserInputResponseToolCallId', () => {
  it('keeps the clicked rpc-only rendered ID after the request gains an item_id', () => {
    const enrichedRequest = createRequest({ item_id: 'item-42' })

    expect(
      resolveCodexUserInputResponseToolCallId(
        enrichedRequest,
        'codex-user-input-42'
      )
    ).toBe('codex-user-input-42')
    expect(resolveCodexUserInputResponseToolCallId(enrichedRequest)).toBe(
      'item-42'
    )
  })
})
