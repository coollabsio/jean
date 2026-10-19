import { createElement, type PropsWithChildren } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chatQueryKeys,
  upsertTurnAssistantMessage,
  useSendMessage,
} from './chat'
import { useChatStore } from '@/store/chat-store'
import type { ChatMessage, Session } from '@/types/chat'

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))

vi.mock('@/lib/transport', () => ({ invoke: mockInvoke }))
vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  projectsQueryKeys: { all: ['projects'] },
}))

const message = (
  id: string,
  role: 'user' | 'assistant',
  content: string
): ChatMessage => ({
  id,
  session_id: 'session-1',
  role,
  content,
  timestamp: 1,
  tool_calls: [],
  content_blocks: [],
  cancelled: false,
  plan_approved: false,
  recovered: false,
})

const contents = (messages: ChatMessage[] | undefined) =>
  messages?.map(item => item.content)

// Callers mark the session as sending before they call mutate().
const SEND_STARTED_AT = 1_000

function setup(messages: ChatMessage[]) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  queryClient.setQueryData<Session>(chatQueryKeys.session('session-1'), {
    id: 'session-1',
    name: 'Test',
    order: 0,
    created_at: 1,
    updated_at: 1,
    messages,
  })
  useChatStore.setState({
    sendingSessionIds: { 'session-1': true },
    sendStartedAt: { 'session-1': SEND_STARTED_AT },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const hook = renderHook(() => useSendMessage(), { wrapper })
  const session = () =>
    queryClient.getQueryData<Session>(chatQueryKeys.session('session-1'))
  return { queryClient, hook, session }
}

/** Start a send whose invoke resolves only when `finish` is called. */
async function startSend(hook: ReturnType<typeof setup>['hook']) {
  let finish!: (reply: ChatMessage) => void
  mockInvoke.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  let send!: Promise<ChatMessage>
  await act(async () => {
    send = hook.result.current.mutateAsync({
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      message: 'second question',
      backend: 'claude',
    })
    await Promise.resolve()
  })
  return async (reply: ChatMessage) => {
    await act(async () => {
      finish(reply)
      await send
    })
  }
}

describe('upsertTurnAssistantMessage', () => {
  const reply = message('reply-2', 'assistant', 'second answer')

  it('appends when the current turn has no reply yet', () => {
    const messages = [
      message('question-1', 'user', 'first question'),
      message('reply-1', 'assistant', 'first answer'),
      message('question-2', 'user', 'second question'),
    ]
    expect(contents(upsertTurnAssistantMessage(messages, reply))).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ])
  })

  it('replaces only the reply of the current turn', () => {
    const messages = [
      message('question-1', 'user', 'first question'),
      message('reply-1', 'assistant', 'first answer'),
      message('question-2', 'user', 'second question'),
      message('optimistic-2', 'assistant', 'partial answer'),
    ]
    expect(contents(upsertTurnAssistantMessage(messages, reply))).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ])
  })
})

describe('useSendMessage completion', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    useChatStore.setState({
      sendingSessionIds: {},
      streamingContents: {},
      streamingContentBlocks: {},
      activeToolCalls: {},
      sendStartedAt: {},
      inputDrafts: {},
    })
  })

  it('keeps the earlier reply and ends the turn when chat:done is lost', async () => {
    const { hook, session } = setup([
      message('question-1', 'user', 'first question'),
      message('reply-1', 'assistant', 'first answer'),
    ])
    useChatStore.setState({
      streamingContents: { 'session-1': 'second answer' },
    })
    const finish = await startSend(hook)

    await finish(message('reply-2', 'assistant', 'second answer'))

    expect(contents(session()?.messages)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ])
    const state = useChatStore.getState()
    expect(state.sendingSessionIds['session-1']).toBeUndefined()
    expect(state.streamingContents['session-1']).toBeUndefined()
  })

  it('replaces the optimistic reply that chat:done added', async () => {
    const { queryClient, hook, session } = setup([
      message('question-1', 'user', 'first question'),
      message('reply-1', 'assistant', 'first answer'),
    ])
    const finish = await startSend(hook)
    // chat:done: add the optimistic reply and clear the running state.
    queryClient.setQueryData<Session>(
      chatQueryKeys.session('session-1'),
      old =>
        old && {
          ...old,
          messages: [
            ...old.messages,
            message('optimistic-2', 'assistant', 'partial answer'),
          ],
        }
    )
    useChatStore.setState({ sendingSessionIds: {}, sendStartedAt: {} })

    await finish(message('reply-2', 'assistant', 'full answer'))

    expect(contents(session()?.messages)).toEqual([
      'first question',
      'first answer',
      'second question',
      'full answer',
    ])
  })

  it('does not touch a queued turn that started before the invoke resolved', async () => {
    const { queryClient, hook, session } = setup([
      message('question-1', 'user', 'first question'),
      message('reply-1', 'assistant', 'first answer'),
    ])
    const finish = await startSend(hook)
    // chat:done for this turn, then chat:sending for the queued prompt.
    queryClient.setQueryData<Session>(
      chatQueryKeys.session('session-1'),
      old =>
        old && {
          ...old,
          messages: [
            ...old.messages,
            message('optimistic-2', 'assistant', 'second answer'),
            message('question-3', 'user', 'third question'),
          ],
        }
    )
    useChatStore.setState({
      sendingSessionIds: { 'session-1': true },
      sendStartedAt: { 'session-1': SEND_STARTED_AT + 1 },
    })

    await finish(message('reply-2', 'assistant', 'second answer'))

    expect(contents(session()?.messages)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
      'third question',
    ])
    expect(useChatStore.getState().sendingSessionIds['session-1']).toBe(true)
  })

  it.each(['', 'newer draft'])(
    'preserves text after a rejected send (newer draft: %s)',
    async newerDraft => {
      const { hook, session } = setup([
        message('question-1', 'user', 'first question'),
        message('reply-1', 'assistant', 'first answer'),
      ])
      useChatStore.getState().setInputDraft('session-1', newerDraft)
      mockInvoke.mockRejectedValue('Session not found: session-1')

      await act(async () => {
        await expect(
          hook.result.current.mutateAsync({
            sessionId: 'session-1',
            worktreeId: 'worktree-1',
            worktreePath: '/tmp/worktree-1',
            message: 'do not lose this text',
            backend: 'claude',
          })
        ).rejects.toBe('Session not found: session-1')
      })

      expect(useChatStore.getState().inputDrafts['session-1']).toBe(
        newerDraft || 'do not lose this text'
      )
      expect(contents(session()?.messages)).toEqual([
        'first question',
        'first answer',
      ])
    }
  )

  it('restores typed text and attachments after a rejected send', async () => {
    const { hook } = setup([])
    const image = { id: 'img-1', path: '/tmp/img.png', filename: 'img.png' }
    const file = {
      id: 'file-1',
      relativePath: 'src/a.ts',
      extension: 'ts',
    }
    useChatStore.setState({
      inputDrafts: {},
      pendingImages: {},
      pendingFiles: {},
      lastSentMessages: { 'session-1': 'check this' },
      lastSentAttachments: {
        'session-1': {
          images: [image],
          files: [file],
          textFiles: [],
          skills: [],
        },
      },
    } as never)
    mockInvoke.mockRejectedValue('Codex could not start: login required')

    await act(async () => {
      await expect(
        hook.result.current.mutateAsync({
          sessionId: 'session-1',
          worktreeId: 'worktree-1',
          worktreePath: '/tmp/worktree-1',
          message:
            'check this\n\n[File: src/a.ts - Use the Read tool to view this file]\n\n[Image attached: /tmp/img.png - Use the Read tool to view this image]',
          backend: 'codex',
        })
      ).rejects.toBe('Codex could not start: login required')
    })

    const state = useChatStore.getState()
    expect(state.inputDrafts['session-1']).toBe('check this')
    expect(state.pendingImages['session-1']).toEqual([image])
    expect(state.pendingFiles['session-1']).toEqual([file])
    expect(state.lastSentAttachments['session-1']).toBeUndefined()
    expect(state.lastSentMessages['session-1']).toBeUndefined()
  })

  it('keeps newer typing and drops stale attachments after a rejected send', async () => {
    const { hook } = setup([])
    useChatStore.setState({
      inputDrafts: { 'session-1': 'newer draft' },
      pendingImages: {},
      lastSentMessages: { 'session-1': 'old' },
      lastSentAttachments: {
        'session-1': {
          images: [{ id: 'img-1', path: '/tmp/img.png', filename: 'img.png' }],
          files: [],
          textFiles: [],
          skills: [],
        },
      },
    } as never)
    mockInvoke.mockRejectedValue('boom')

    await act(async () => {
      await expect(
        hook.result.current.mutateAsync({
          sessionId: 'session-1',
          worktreeId: 'worktree-1',
          worktreePath: '/tmp/worktree-1',
          message: 'old\n\n[Image attached: /tmp/img.png]',
          backend: 'claude',
        })
      ).rejects.toBe('boom')
    })

    const state = useChatStore.getState()
    expect(state.inputDrafts['session-1']).toBe('newer draft')
    expect(state.pendingImages['session-1']).toBeUndefined()
    expect(state.lastSentAttachments['session-1']).toBeUndefined()
  })
})
