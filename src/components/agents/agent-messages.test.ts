import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/types/chat'
import type { AgentDelegation } from '@/services/agents'
import {
  messageSnippet,
  agentApprovalId,
  agentMessageLink,
  agentQuestion,
  assistantReplyItems,
  nextUserAnswers,
  questionAnswerText,
  selectedOptions,
  conversationEntries,
  parseAgentRequest,
  parseAgentSentMessage,
  spawnDelegationStatus,
} from './agent-messages'

describe('spawnDelegationStatus', () => {
  const delegation = (
    id: number,
    sessionId: string,
    worktreeId: string,
    status: string
  ): AgentDelegation => ({
    id,
    agentId: 'coord_p1',
    sessionId,
    worktreeId,
    hop: 0,
    status,
    lastEvent: null,
    lastError: null,
    lastSummary: null,
    checkAfter: null,
    updatedAt: 0,
  })
  const delegations = [
    delegation(1, 's1', 'w1', 'done'),
    delegation(3, 's1', 'w1', 'waiting'),
    delegation(2, 's2', 'w1', 'failed'),
  ]

  it('uses the newest delegation to the sent session', () => {
    expect(
      spawnDelegationStatus(
        { kind: 'session', toolId: 't', sessionId: 's1', message: 'go' },
        delegations
      )
    ).toBe('waiting')
    expect(
      spawnDelegationStatus(
        { kind: 'session', toolId: 't', sessionId: 's2', message: 'go' },
        delegations
      )
    ).toBe('failed')
  })

  it('uses the newest delegation on the created worktree', () => {
    expect(
      spawnDelegationStatus(
        { kind: 'worktree', toolId: 't', name: 'x', worktreeId: 'w1' },
        delegations
      )
    ).toBe('waiting')
  })

  it('shows nothing without a matching delegation', () => {
    expect(
      spawnDelegationStatus(
        { kind: 'session', toolId: 't', sessionId: 's9', message: 'go' },
        delegations
      )
    ).toBeNull()
    expect(
      spawnDelegationStatus(
        { kind: 'worktree', toolId: 't', name: 'x' },
        delegations
      )
    ).toBeNull()
    expect(
      spawnDelegationStatus(
        { kind: 'session', toolId: 't', sessionId: 's1', message: 'go' },
        undefined
      )
    ).toBeNull()
  })
})

function assistant(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'a1',
    session_id: 's1',
    role: 'assistant',
    content: '',
    timestamp: 100,
    content_blocks: [],
    tool_calls: [],
    ...partial,
  }
}

function user(content: string, id = 'u1'): ChatMessage {
  return assistant({ id, role: 'user', content })
}

// Same text as `compose_update` + `message_agent` in jean-core
const REQUEST_UPDATE =
  '[Jean agent update] Automatic message from Jean, not from the user.\n\n' +
  '### 1. message\nRequest from agent Haruvo (`ag-1`):\n\nCheck the build.\n\n' +
  'Your final reply in this turn is sent back to Haruvo automatically.\n\n' +
  'Decide the next step.'

describe('messageSnippet', () => {
  it('keeps the first line and cuts long text', () => {
    expect(messageSnippet('  Fix the OAuth login\nDetails…')).toBe(
      'Fix the OAuth login'
    )
    expect(
      messageSnippet('Fix the OAuth callback so it keeps the state', 20)
    ).toBe('Fix the OAuth callb…')
  })
})

describe('agentMessageLink', () => {
  it('reads message_agent calls', () => {
    expect(
      agentMessageLink({
        id: 't1',
        name: 'mcp__jean__message_agent',
        input: { agentId: 'ag-2', message: 'hi' },
      })
    ).toEqual({ kind: 'agent', toolId: 't1', agentId: 'ag-2', message: 'hi' })
  })

  it('reads send_chat_message calls with the target name from the result', () => {
    expect(
      agentMessageLink({
        id: 't2',
        name: 'mcp__jean__send_chat_message',
        input: { sessionId: 's9', message: 'go' },
        output: JSON.stringify({
          sessionId: 's9',
          status: 'started',
          worktreeId: 'w9',
          worktreePath: '/tmp/w9',
          sessionName: 'integrate Beacon',
          worktreeName: 'Haruvo',
        }),
      })
    ).toEqual({
      kind: 'session',
      toolId: 't2',
      sessionId: 's9',
      message: 'go',
      worktreeId: 'w9',
      worktreePath: '/tmp/w9',
      name: 'Haruvo: integrate Beacon',
    })
  })

  it('reads create_worktree calls from the worktree in the MCP result', () => {
    const worktree = { id: 'w7', name: 'fix-login', path: '/w/fix-login' }
    const call = (output?: string) => ({
      id: 't7',
      name: 'mcp__jean__create_worktree',
      input: { projectId: 'p1', customName: 'login-fix' },
      output,
    })
    const expected = {
      kind: 'worktree',
      toolId: 't7',
      name: 'fix-login',
      worktreeId: 'w7',
      worktreePath: '/w/fix-login',
    }
    expect(agentMessageLink(call(JSON.stringify(worktree)))).toEqual(expected)
    expect(
      agentMessageLink(
        call(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify(worktree) }],
          })
        )
      )
    ).toEqual(expected)
    expect(
      agentMessageLink(
        call(JSON.stringify([{ type: 'text', text: JSON.stringify(worktree) }]))
      )
    ).toEqual(expected)
    expect(agentMessageLink(call('not json'))).toEqual({
      kind: 'worktree',
      toolId: 't7',
      name: 'login-fix',
      worktreeId: undefined,
      worktreePath: undefined,
    })
    expect(agentMessageLink(call())).toBeNull()
  })

  it('ignores failed calls and other tools', () => {
    expect(
      agentMessageLink({
        id: 't3',
        name: 'mcp__jean__message_agent',
        input: { agentId: 'x', message: 'm' },
        is_error: true,
      })
    ).toBeNull()
    expect(
      agentMessageLink({ id: 't4', name: 'Bash', input: { command: 'ls' } })
    ).toBeNull()
  })
})

describe('assistantReplyItems', () => {
  it('keeps text and message links in order', () => {
    const message = assistant({
      timestamp: 42,
      content_blocks: [
        { type: 'text', text: 'Asking Grok.' },
        { type: 'tool_use', tool_call_id: 'read' },
        { type: 'tool_use', tool_call_id: 'msg' },
        { type: 'text', text: 'Done.' },
      ],
      tool_calls: [
        { id: 'read', name: 'Read', input: {} },
        {
          id: 'msg',
          name: 'mcp__jean__message_agent',
          input: { agentId: 'grok', message: 'help' },
        },
      ],
    })
    expect(assistantReplyItems([{ message }])).toEqual([
      { type: 'text', texts: ['Asking Grok.'] },
      {
        type: 'link',
        sentAt: 42,
        link: {
          kind: 'agent',
          toolId: 'msg',
          agentId: 'grok',
          message: 'help',
        },
      },
      { type: 'text', texts: ['Done.'] },
    ])
  })
})

describe('agentApprovalId', () => {
  const tool = (output: string, is_error = false) => ({
    id: 't1',
    name: 'mcp__jean__push_worktree',
    input: {},
    output,
    is_error,
  })

  it('reads the approval gate result in raw and wrapped forms', () => {
    // Same shape as `approval_gate` in jean-core
    const gate = JSON.stringify({
      approvalRequired: true,
      approvalId: 7,
      status: 'waiting_for_user',
    })
    expect(agentApprovalId(tool(gate))).toBe(7)
    expect(
      agentApprovalId(tool(JSON.stringify([{ type: 'text', text: gate }])))
    ).toBe(7)
  })

  it('ignores normal results, other tools, save failures and errors', () => {
    expect(agentApprovalId(tool('{"pushed":true}'))).toBeNull()
    expect(
      agentApprovalId({
        ...tool('{"approvalRequired":true,"approvalId":7}'),
        name: 'Read',
      })
    ).toBeNull()
    expect(
      agentApprovalId(tool('{"approvalRequired":true,"status":"error"}'))
    ).toBeNull()
    expect(
      agentApprovalId(tool('{"approvalRequired":true,"approvalId":7}', true))
    ).toBeNull()
  })

  it('becomes a reply item in tool order', () => {
    const message = assistant({
      content_blocks: [
        { type: 'text', text: 'Pushing.' },
        { type: 'tool_use', tool_call_id: 'push' },
      ],
      tool_calls: [
        {
          id: 'push',
          name: 'mcp__jean__push_worktree',
          input: {},
          output: '{"approvalRequired":true,"approvalId":3}',
        },
      ],
    })
    expect(assistantReplyItems([{ message }])).toEqual([
      { type: 'text', texts: ['Pushing.'] },
      { type: 'approval', toolId: 'push', approvalId: 3 },
    ])
  })
})

describe('ask_user questions', () => {
  const askTool = (input: Record<string, unknown>) => ({
    id: 'q1',
    name: 'mcp__jean__ask_user',
    input,
    output: '{"status":"shown"}',
  })
  const single = { question: 'Which?', options: ['A', 'B'], multiple: false }
  const multi = { ...single, multiple: true }

  it('reads the question from the tool input', () => {
    expect(
      agentQuestion(askTool({ question: 'Which?', options: ['A', 'B'] }))
    ).toEqual(single)
    expect(
      agentQuestion(askTool({ question: 'Which?', options: ['A'] }))
    ).toBeNull()
    expect(
      agentQuestion({
        ...askTool({ question: 'Which?', options: ['A', 'B'] }),
        is_error: true,
      })
    ).toBeNull()
  })

  it('becomes a reply item', () => {
    const tool = askTool({
      question: 'Which?',
      options: ['A', 'B'],
      multiple: true,
    })
    const message = assistant({
      content_blocks: [{ type: 'tool_use', tool_call_id: 'q1' }],
      tool_calls: [tool],
    })
    expect(assistantReplyItems([{ message }])).toEqual([
      { type: 'question', toolId: 'q1', question: multi },
    ])
  })

  it('round-trips answers to selected options', () => {
    expect(questionAnswerText(single, ['B'])).toBe('B')
    // Option order, not click order
    const text = questionAnswerText(multi, ['B', 'A'])
    expect(text).toBe('- A\n- B')
    expect(selectedOptions(multi, text)).toEqual(['A', 'B'])
    expect(selectedOptions(single, 'B')).toEqual(['B'])
    expect(selectedOptions(single, 'Neither, use C')).toEqual([])
  })

  it('answers with the next message the user wrote, not updates', () => {
    expect(
      nextUserAnswers([
        assistant({ id: 'a1' }),
        user('[Jean agent update] Automatic message\n\nx', 'u1'),
        assistant({ id: 'a2' }),
        user('B', 'u2'),
        assistant({ id: 'a3' }),
      ])
    ).toEqual(['B', 'B', 'B', undefined, undefined])
  })
})

describe('parseAgentSentMessage', () => {
  it('reads the marker that agent_message_text writes', () => {
    expect(
      parseAgentSentMessage(
        '[Message from agent Grok Bot (`ag-1`)]\n\nPull main.'
      )
    ).toEqual({ agentName: 'Grok Bot', agentId: 'ag-1', text: 'Pull main.' })
    expect(parseAgentSentMessage('Pull main.')).toBeNull()
  })
})

describe('parseAgentRequest', () => {
  it('reads a message_agent request inside an update', () => {
    expect(parseAgentRequest(REQUEST_UPDATE)).toEqual({
      agentName: 'Haruvo',
      agentId: 'ag-1',
      text: 'Check the build.',
    })
    expect(parseAgentRequest('Request from agent X (`y`):\n\nz')).toBeNull()
  })
})

describe('conversationEntries', () => {
  it('labels agent requests, user prompts and replies; drops other updates', () => {
    const entries = conversationEntries([
      user(REQUEST_UPDATE, 'u1'),
      assistant({ id: 'a1', content: 'Build is green.' }),
      user(
        '[Jean agent update] Automatic message\n\n### 1. delegation\nx',
        'u2'
      ),
      assistant({ id: 'a2', content: 'Noted.' }),
      user('Also check lint', 'u3'),
    ])
    expect(entries.map(e => [e.from, e.text])).toEqual([
      ['sender', 'Check the build.'],
      ['target', 'Build is green.'],
      ['target', 'Noted.'],
      ['user', 'Also check lint'],
    ])
  })
})
