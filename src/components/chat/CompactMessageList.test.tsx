import { createRef } from 'react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@/test/test-utils'
import type * as transport from '@/lib/transport'
import { invoke } from '@/lib/transport'
import { CompactMessageList } from './CompactMessageList'
import { formatLocalTime } from './time-utils'

vi.mock('@/lib/transport', async importOriginal => ({
  ...(await importOriginal<typeof transport>()),
  invoke: vi.fn(),
}))
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'

const noopQuestionAnswer = (
  _toolCallId: string,
  _answers: QuestionAnswer[],
  _questions: Question[]
) => undefined

const noopFixFinding = async (_finding: ReviewFinding, _suggestion?: string) =>
  undefined

const noopFixAllFindings = async (
  _findings: { finding: ReviewFinding; suggestion?: string }[]
) => undefined

function message(
  id: string,
  role: ChatMessage['role'],
  timestamp: number,
  content: string,
  overrides: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    session_id: 'session-1',
    role,
    content,
    timestamp,
    tool_calls: [],
    content_blocks: [],
    ...overrides,
  }
}

function compactProps(
  messages: ChatMessage[],
  props: Partial<ComponentProps<typeof CompactMessageList>> = {}
): ComponentProps<typeof CompactMessageList> {
  return {
    messages,
    scrollContainerRef: createRef<HTMLDivElement>(),
    totalMessages: messages.length,
    lastPlanMessageIndex: -1,
    sessionId: 'session-1',
    worktreePath: '/tmp/worktree',
    approveShortcut: 'Cmd+Enter',
    isSending: false,
    onPlanApproval: vi.fn(),
    onQuestionAnswer: noopQuestionAnswer,
    onQuestionSkip: vi.fn(),
    onFileClick: vi.fn(),
    onFixFinding: noopFixFinding,
    onFixAllFindings: noopFixAllFindings,
    isQuestionAnswered: vi.fn(() => false),
    getSubmittedAnswers: vi.fn(() => undefined),
    areQuestionsSkipped: vi.fn(() => false),
    isFindingFixed: vi.fn(() => false),
    ...props,
  }
}

function renderCompact(
  messages: ChatMessage[],
  props: Partial<ComponentProps<typeof CompactMessageList>> = {}
) {
  return render(<CompactMessageList {...compactProps(messages, props)} />)
}

describe('CompactMessageList', () => {
  it('pins the scroll container to its full height when a prompt is sent', () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'scrollHeight', {
      configurable: true,
      value: 1800,
    })
    const scrollContainerRef = { current: container }
    const onScrollToBottomHandled = vi.fn()
    const first = [
      message('user-1', 'user', 100, 'hello'),
      message('assistant-1', 'assistant', 104, 'Hello!'),
    ]
    const props = {
      scrollContainerRef,
      shouldScrollToBottom: true,
      onScrollToBottomHandled,
    }
    const { rerender } = renderCompact(first, props)

    const next = [...first, message('user-2', 'user', 200, 'next prompt')]
    rerender(<CompactMessageList {...compactProps(next, props)} />)

    expect(container.scrollTop).toBe(1800)
    expect(onScrollToBottomHandled).toHaveBeenCalledTimes(1)
  })

  it('renders a single pure text assistant response once instead of as activity plus text', () => {
    renderCompact([
      message('user-1', 'user', 100, 'hello'),
      message('assistant-1', 'assistant', 104, 'Hello!', {
        content_blocks: [{ type: 'text', text: 'Hello!' }],
      }),
    ])

    expect(screen.getAllByText('Hello!')).toHaveLength(1)
    expect(screen.queryByText('1 msg')).not.toBeInTheDocument()
  })

  it('still compacts assistant messages that contain actual tool activity', () => {
    renderCompact([
      message('user-1', 'user', 100, 'check status'),
      message('assistant-1', 'assistant', 104, '', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status --short' },
            output: 'clean',
          },
        ],
        content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
      }),
    ])

    expect(screen.getByText('Bash')).toBeVisible()
    expect(screen.getByText('1 step')).toBeVisible()
  })

  it('renders Command Code read_file activity with normalized labels', () => {
    renderCompact([
      message('user-1', 'user', 100, 'read files'),
      message('assistant-1', 'assistant', 104, 'I read files.', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'read_file',
            input: { absolutePath: '/tmp/package.json' },
          },
          {
            id: 'tool-2',
            name: 'read_file',
            input: { absolutePath: '/tmp/README.md' },
          },
          {
            id: 'tool-3',
            name: 'read_file',
            input: { absolutePath: '/tmp/AGENTS.md', limit: 20 },
          },
        ],
        content_blocks: [
          { type: 'text', text: 'Reading files.' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'tool_use', tool_call_id: 'tool-2' },
          { type: 'tool_use', tool_call_id: 'tool-3' },
          { type: 'text', text: 'I read files.' },
        ],
      }),
    ])

    expect(screen.getByRole('button', { name: /3 steps/ })).toBeVisible()
    expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /3 steps/ }))

    expect(screen.getByRole('button', { name: /3 Read/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /3 Read/ }))

    expect(screen.getAllByText('Read')).toHaveLength(2)
    expect(screen.getByText('Read 20 lines')).toBeVisible()
    expect(screen.getByText('package.json')).toBeVisible()
  })

  it('keeps the activity-row receive time hidden until the row is hovered', () => {
    const sentAt = 1_700_000_000
    const receivedAt = sentAt + 4
    renderCompact([
      message('user-1', 'user', sentAt, 'check status'),
      message('assistant-1', 'assistant', receivedAt, '', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status --short' },
            output: 'clean',
          },
        ],
        content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
      }),
    ])

    const receiveTime = screen.getByText(
      (_, element) =>
        element?.textContent === ` · ${formatLocalTime(receivedAt)}`
    )

    expect(receiveTime).toHaveClass(
      'opacity-0',
      '[@media(pointer:fine)]:group-hover/message:opacity-100'
    )
    expect(receiveTime.closest('[class~="group/message"]')).not.toBeNull()
    expect(screen.getByText('4s').parentElement).toContainElement(receiveTime)
  })

  it('shows the turn duration once after the activity row is expanded', () => {
    const sentAt = 1_700_000_000
    renderCompact([
      message('user-1', 'user', sentAt, 'check status'),
      message(
        'assistant-1',
        'assistant',
        sentAt + 4,
        'Working tree is clean.',
        {
          tool_calls: [
            {
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'git status' },
              output: 'clean',
            },
          ],
          content_blocks: [
            { type: 'tool_use', tool_call_id: 'tool-1' },
            { type: 'text', text: 'Working tree is clean.' },
          ],
        }
      ),
    ])

    expect(screen.getAllByText('4s')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /1 step/ }))
    expect(screen.getAllByText('4s')).toHaveLength(1)
  })

  it('keeps a question reply receive time hidden until that message is hovered', () => {
    const sentAt = 1_700_000_000
    const receivedAt = sentAt + 4
    renderCompact([
      message('user-1', 'user', sentAt, 'ask me'),
      message('assistant-1', 'assistant', receivedAt, '', {
        tool_calls: [
          {
            id: 'question-1',
            name: 'question',
            input: {
              questions: [
                {
                  header: 'Bird Type',
                  question: 'What is your favorite type of bird?',
                  multiple: false,
                  options: [
                    { label: 'Raptors', description: 'Eagles, hawks, falcons' },
                  ],
                },
              ],
            },
          },
        ],
        content_blocks: [{ type: 'tool_use', tool_call_id: 'question-1' }],
      }),
    ])

    const receiveTime = screen.getByText(
      (_, element) =>
        element?.textContent === ` · ${formatLocalTime(receivedAt)}`
    )

    expect(
      screen.getByText('What is your favorite type of bird?')
    ).toBeVisible()
    expect(receiveTime).toHaveClass('opacity-0')
    expect(receiveTime.closest('[class~="group/message"]')).not.toBeNull()
    expect(screen.getByText('4s').parentElement).toContainElement(receiveTime)
  })

  it('renders cancelled marker outside the compact activity card', () => {
    renderCompact([
      message('user-1', 'user', 100, 'check status'),
      message('assistant-1', 'assistant', 104, '', {
        cancelled: true,
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status --short' },
            output: 'clean',
          },
        ],
        content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
      }),
    ])

    const compactTrigger = screen.getByRole('button', { name: /Bash/ })
    fireEvent.click(compactTrigger)

    const cancelledMarker = screen.getByText('(cancelled)')

    expect(compactTrigger.closest('[data-slot="collapsible"]')).not.toBeNull()
    expect(
      cancelledMarker.closest('[data-slot="collapsible-content"]')
    ).toBeNull()
  })

  it('keeps cancelled intermediate assistant text inside the collapsed activity row', () => {
    renderCompact([
      message('user-1', 'user', 100, 'reset the env'),
      message(
        'assistant-1',
        'assistant',
        104,
        'Starting reset.Polling VM.Final partial status.',
        {
          cancelled: true,
          tool_calls: [
            {
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'rtk ./scripts/dev.sh fresh' },
              output: 'running',
            },
            {
              id: 'tool-2',
              name: 'Bash',
              input: { command: 'rtk limactl list' },
              output: 'running',
            },
          ],
          content_blocks: [
            { type: 'text', text: 'Starting reset.' },
            { type: 'tool_use', tool_call_id: 'tool-1' },
            { type: 'text', text: 'Polling VM.' },
            { type: 'tool_use', tool_call_id: 'tool-2' },
            { type: 'text', text: 'Final partial status.' },
          ],
        }
      ),
    ])

    const compactTrigger = screen.getByRole('button', {
      name: /Final partial status/,
    })

    expect(compactTrigger).toBeVisible()
    expect(screen.getByText('2 steps')).toBeVisible()
    expect(screen.getByText('(cancelled)')).toBeVisible()
    expect(screen.queryByText('Starting reset.')).not.toBeInTheDocument()
    expect(screen.queryByText('Polling VM.')).not.toBeInTheDocument()

    fireEvent.click(compactTrigger)

    expect(screen.getByText('Starting reset.')).toBeVisible()
    expect(screen.getByText('Polling VM.')).toBeVisible()
  })

  it('surfaces only the latest text for non-cancelled compact activity groups', () => {
    renderCompact([
      message('user-1', 'user', 100, 'reset the env'),
      message(
        'assistant-1',
        'assistant',
        104,
        'Starting reset.Polling VM.Final status.',
        {
          tool_calls: [
            {
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'rtk ./scripts/dev.sh fresh' },
              output: 'running',
            },
            {
              id: 'tool-2',
              name: 'Bash',
              input: { command: 'rtk limactl list' },
              output: 'running',
            },
          ],
          content_blocks: [
            { type: 'text', text: 'Starting reset.' },
            { type: 'tool_use', tool_call_id: 'tool-1' },
            { type: 'text', text: 'Polling VM.' },
            { type: 'tool_use', tool_call_id: 'tool-2' },
            { type: 'text', text: 'Final status.' },
          ],
        }
      ),
    ])

    expect(screen.getAllByText('Final status.').length).toBeGreaterThanOrEqual(
      1
    )
    expect(screen.queryByText('Starting reset.')).not.toBeInTheDocument()
    expect(screen.queryByText('Polling VM.')).not.toBeInTheDocument()
  })

  it('shows only assistant prose when tool activity is hidden', () => {
    renderCompact(
      [
        message('user-1', 'user', 100, 'check status'),
        message('assistant-1', 'assistant', 104, '', {
          tool_calls: [
            {
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'git status --short' },
              output: 'clean',
            },
          ],
          content_blocks: [
            { type: 'text', text: 'Checking the repo.' },
            { type: 'tool_use', tool_call_id: 'tool-1' },
            { type: 'text', text: 'The tree is clean.' },
          ],
        }),
        message('user-2', 'user', 200, 'again'),
        message('assistant-2', 'assistant', 204, '', {
          tool_calls: [
            { id: 'tool-2', name: 'Bash', input: {}, output: 'clean' },
          ],
          content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-2' }],
        }),
      ],
      { hideToolActivity: true }
    )

    expect(screen.getByText('Checking the repo.')).toBeVisible()
    expect(screen.getByText('The tree is clean.')).toBeVisible()
    expect(screen.queryByText('Bash')).not.toBeInTheDocument()
    expect(screen.queryByText(/\d+ steps?/)).not.toBeInTheDocument()
  })

  it('keeps pre-tool assistant prose in its timeline position after reload', () => {
    renderCompact([
      message('user-1', 'user', 100, 'fix the terminal'),
      message(
        'assistant-1',
        'assistant',
        104,
        'I will trace the remote terminal command.',
        {
          tool_calls: [
            {
              id: 'tool-1',
              name: 'FileChange',
              input: [{ path: 'src/store/terminal-store.ts' }],
              output: 'done',
            },
          ],
          content_blocks: [
            {
              type: 'text',
              text: 'I will trace the remote terminal command.',
            },
            { type: 'tool_use', tool_call_id: 'tool-1' },
          ],
        }
      ),
    ])

    expect(
      screen.queryByText('I will trace the remote terminal command.')
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /FileChange/ }))

    expect(
      screen.getAllByText('I will trace the remote terminal command.')
    ).toHaveLength(1)
    expect(
      screen.getByText('I will trace the remote terminal command.')
    ).toBeVisible()
  })

  it('shows options of a question in a text-only reply as buttons', () => {
    const onSendAnswer = vi.fn()
    const text =
      'Pick a name now.\n\n## Recap\n\nPick a name now.\n\nWhat do you want to do next?\nReply with a number:\n1. Suggest names\n2. Keep the name'
    renderCompact(
      [
        message('user-1', 'user', 100, 'rename the app'),
        message('assistant-1', 'assistant', 104, text, {
          content_blocks: [{ type: 'text', text }],
        }),
      ],
      { onSendAnswer }
    )

    fireEvent.click(
      screen.getByRole('button', { name: /^2\.\s?Keep the name$/ })
    )
    expect(onSendAnswer).toHaveBeenCalledWith('2. Keep the name')
  })

  it('shows options of a question in the recap as buttons', () => {
    const onSendAnswer = vi.fn()
    const text =
      'I read the code.\n\n## Recap\n\nWhich mode do you want?\n\nReply with a number:\n\n1. Grid\n2. List'
    const messages = [
      message('user-1', 'user', 100, 'add modes'),
      message('assistant-1', 'assistant', 104, text, {
        tool_calls: [{ id: 'tool-1', name: 'Read', input: { path: 'a.ts' } }],
        content_blocks: [
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'text', text },
        ],
      }),
    ]
    const { rerender } = renderCompact(messages, { onSendAnswer })

    const block = screen.getByRole('region', { name: 'Question' })
    const question = within(block).getByText('Which mode do you want?')
    expect(screen.getAllByText('Which mode do you want?')).toHaveLength(1)
    const option = screen.getByRole('button', { name: /^2\.\s?List$/ })
    expect(screen.queryByText('Reply with a number:')).not.toBeInTheDocument()
    expect(
      question.compareDocumentPosition(option) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^2\.\s?List$/ }))
    expect(onSendAnswer).toHaveBeenCalledWith('2. List')

    const answered = [...messages, message('user-2', 'user', 110, '2. List')]
    rerender(
      <CompactMessageList
        messages={answered}
        scrollContainerRef={createRef<HTMLDivElement>()}
        totalMessages={answered.length}
        lastPlanMessageIndex={-1}
        sessionId="session-1"
        worktreePath="/tmp/worktree"
        approveShortcut="Cmd+Enter"
        isSending={false}
        onPlanApproval={vi.fn()}
        onQuestionAnswer={noopQuestionAnswer}
        onQuestionSkip={vi.fn()}
        onFileClick={vi.fn()}
        onFixFinding={noopFixFinding}
        onFixAllFindings={noopFixAllFindings}
        isQuestionAnswered={vi.fn(() => false)}
        getSubmittedAnswers={vi.fn(() => undefined)}
        areQuestionsSkipped={vi.fn(() => false)}
        isFindingFixed={vi.fn(() => false)}
        onSendAnswer={onSendAnswer}
      />
    )
    expect(
      screen.queryByRole('button', { name: /^1\.\s?Grid$/ })
    ).not.toBeInTheDocument()
  })

  it('summarizes fragmented PI text deltas as one meaningful line', () => {
    renderCompact([
      message('user-1', 'user', 100, 'create and edit a file'),
      message(
        'assistant-1',
        'assistant',
        104,
        'Yes — created and edited `tmp/test.txt`.',
        {
          tool_calls: [
            {
              id: 'tool-1',
              name: 'Write',
              input: { file_path: 'tmp/test.txt' },
              output: 'wrote file',
            },
            {
              id: 'tool-2',
              name: 'Edit',
              input: { file_path: 'tmp/test.txt' },
              output: 'edited file',
            },
          ],
          content_blocks: [
            { type: 'tool_use', tool_call_id: 'tool-1' },
            { type: 'tool_use', tool_call_id: 'tool-2' },
            { type: 'text', text: 'Yes — created and edited `' },
            { type: 'text', text: 'tmp/test.txt' },
            { type: 'text', text: '`.' },
          ],
        }
      ),
    ])

    expect(
      screen.getByRole('button', {
        name: /Yes — created and edited `tmp\/test\.txt`\./,
      })
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /^`\./ })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('`.')).not.toBeInTheDocument()
  })

  it('surfaces steered user prompts as separate visible rows', () => {
    renderCompact([
      message('user-1', 'user', 100, 'do the work'),
      message('assistant-1', 'assistant', 104, 'Done', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status' },
            output: 'clean',
          },
        ],
        content_blocks: [
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'user_input', text: 'also check the tests' },
          { type: 'text', text: 'Done' },
        ],
      }),
    ])

    // Steered prompt visible without expanding the collapsed activity row
    expect(screen.getByText('also check the tests')).toBeVisible()
    // Activity after the steer renders after the bubble (pure text segment)
    expect(screen.getByText('Done')).toBeVisible()
  })

  it('renders steered prompts with the same attachment UI as normal user prompts', () => {
    renderCompact([
      message('user-1', 'user', 100, 'do the work'),
      message('assistant-1', 'assistant', 104, 'Done', {
        content_blocks: [
          {
            type: 'user_input',
            text: 'check this\n\n[Image attached: /tmp/screenshot.png - Use the Read tool to view this image]',
          },
          { type: 'text', text: 'Done' },
        ],
      }),
    ])

    expect(screen.getByText('check this')).toBeVisible()
    expect(screen.getByAltText('Attached image 1')).toBeVisible()
    expect(screen.queryByText(/Image attached:/)).not.toBeInTheDocument()
  })

  it('keeps steered prompts in chronological order around activity', () => {
    renderCompact([
      message('user-1', 'user', 100, 'hello'),
      message('assistant-1', 'assistant', 104, 'All received', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'rtk git status' },
            output: 'clean',
          },
        ],
        content_blocks: [
          { type: 'user_input', text: 'whatsup' },
          { type: 'user_input', text: 'is it?' },
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'text', text: 'All received' },
        ],
      }),
    ])

    const whatsup = screen.getByText('whatsup')
    const isIt = screen.getByText('is it?')
    const activity = screen.getAllByText('All received')[0]

    // Consecutive steered prompts render inside ONE connected group card.
    expect(whatsup.closest('.divide-y')).toBe(isIt.closest('.divide-y'))
    expect(whatsup.closest('.divide-y')).not.toBeNull()

    // Steered prompts come BEFORE the activity that followed them.
    expect(
      whatsup.compareDocumentPosition(isIt) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      activity &&
        isIt.compareDocumentPosition(activity) &
          Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})

describe('CompactMessageList request_secret', () => {
  const secretMessages = [
    message('user-1', 'user', 100, 'join the tailnet'),
    message('assistant-1', 'assistant', 104, '', {
      tool_calls: [
        {
          id: 'tool-1',
          name: 'mcp__jean__request_secret',
          input: { label: 'Tailscale auth key', reason: 'Create it in admin.' },
        },
      ],
      content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
    }),
  ]

  const mockSecretCommands = (saved: unknown) =>
    vi.mocked(invoke).mockImplementation((async (command: string) => {
      if (command === 'secret_request_status') return saved
      if (command === 'save_secret_request')
        return { path: '/data/secrets/abc-24h', retention: 'day' }
      return null
    }) as typeof invoke)

  it('saves the value with the chosen retention and sends only the path', async () => {
    mockSecretCommands(null)
    const onSendAnswer = vi.fn()
    renderCompact(secretMessages, { onSendAnswer })

    fireEvent.change(screen.getByLabelText('Tailscale auth key'), {
      target: { value: 'tskey-auth-123' },
    })
    fireEvent.click(screen.getByRole('radio', { name: '24 hours' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save securely' }))

    expect(
      await screen.findByText(
        'Tailscale auth key · saved, deleted after 24 hours'
      )
    ).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('save_secret_request', {
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      label: 'Tailscale auth key',
      secret: 'tskey-auth-123',
      retention: 'day',
    })
    expect(onSendAnswer).toHaveBeenCalledTimes(1)
    const sent = onSendAnswer.mock.calls[0]?.[0] as string
    expect(sent).toContain('/data/secrets/abc-24h')
    expect(sent).not.toContain('tskey-auth-123')
  })

  it('keeps secrets until forgotten by default', async () => {
    mockSecretCommands(null)
    renderCompact(secretMessages, { onSendAnswer: vi.fn() })
    fireEvent.change(screen.getByLabelText('Tailscale auth key'), {
      target: { value: 'tskey-auth-123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save securely' }))
    await screen.findByRole('button', { name: 'Forget' })
    expect(invoke).toHaveBeenCalledWith(
      'save_secret_request',
      expect.objectContaining({ retention: 'forever' })
    )
  })

  it('forgets a saved secret of an answered request', async () => {
    mockSecretCommands({ path: '/data/secrets/abc', retention: 'forever' })
    renderCompact([...secretMessages, message('user-2', 'user', 110, 'ok')])

    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }))

    expect(
      await screen.findByText('Tailscale auth key · not saved')
    ).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('forget_secret_request', {
      sessionId: 'session-1',
      toolCallId: 'tool-1',
    })
  })

  it('closes the card once a user message follows it', async () => {
    mockSecretCommands(null)
    renderCompact([
      ...secretMessages,
      message('user-2', 'user', 110, 'skip that'),
    ])
    expect(
      await screen.findByText('Tailscale auth key · not saved')
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Save securely' })
    ).not.toBeInTheDocument()
  })
})

describe('CompactMessageList list_secrets', () => {
  const entry = (id: string, label: string, ownerId: string) => ({
    id: id.repeat(32),
    label,
    sessionId: 's1',
    toolCallId: 't1',
    ownerId,
    ownerName: ownerId === 'agent:a1' ? 'Ops' : 'jean',
    retention: 'forever',
    savedAt: 1_700_000_000,
  })

  it('lists this owner by default, all owners on demand, and deletes', async () => {
    let secrets = [
      entry('a', 'Tailscale auth key', 'project:jean'),
      entry('b', 'Cloudflare token', 'project:jean'),
      entry('c', 'Hetzner token', 'agent:a1'),
    ]
    vi.mocked(invoke).mockImplementation((async (
      command: string,
      args?: Record<string, unknown>
    ) => {
      if (command === 'list_secrets')
        return args?.allOwners
          ? secrets
          : secrets.filter(item => item.ownerId === 'project:jean')
      if (command === 'delete_secret') {
        secrets = secrets.filter(item => item.id !== args?.id)
      }
      return null
    }) as typeof invoke)

    renderCompact([
      message('user-1', 'user', 100, 'show my secrets'),
      message('assistant-1', 'assistant', 104, '', {
        tool_calls: [
          { id: 'tool-1', name: 'mcp__jean__list_secrets', input: {} },
        ],
        content_blocks: [{ type: 'tool_use', tool_call_id: 'tool-1' }],
      }),
    ])

    const card = await screen.findByRole('region', { name: 'Saved secrets' })
    expect(await within(card).findByText('Tailscale auth key')).toBeVisible()
    expect(within(card).queryByText('Hetzner token')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('list_secrets', {
      sessionId: 'session-1',
      allOwners: false,
    })

    fireEvent.click(within(card).getByRole('radio', { name: 'All' }))
    expect(await within(card).findByText('Hetzner token')).toBeVisible()
    expect(within(card).getByText(/^Agent Ops · Saved/)).toBeVisible()

    fireEvent.click(
      within(card).getByRole('button', { name: 'Delete Cloudflare token' })
    )
    await waitFor(() =>
      expect(within(card).queryByText('Cloudflare token')).toBeNull()
    )
    expect(invoke).toHaveBeenCalledWith('delete_secret', {
      sessionId: 'session-1',
      id: 'b'.repeat(32),
    })
  })
})
