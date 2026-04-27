import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { MessageItem } from './MessageItem'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({
      svg: `<svg data-testid="${id}"><g>mermaid-svg</g></svg>`,
      bindFunctions: undefined,
    })),
  },
}))
import type {
  ChatMessage,
  ReviewFinding,
  QuestionAnswer,
  Question,
} from '@/types/chat'

describe('MessageItem', () => {
  const noopQuestionAnswer = (
    _toolCallId: string,
    _answers: QuestionAnswer[],
    _questions: Question[]
  ) => undefined

  const noopFixFinding = async (
    _finding: ReviewFinding,
    _suggestion?: string
  ) => undefined

  const noopFixAllFindings = async (
    _findings: { finding: ReviewFinding; suggestion?: string }[]
  ) => undefined

  const baseMessage: ChatMessage = {
    id: 'assistant-1',
    session_id: 'session-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    tool_calls: [
      {
        id: 'plan-1',
        name: 'CodexPlan',
        input: { plan_preview: 'Persisted preview plan' },
      },
    ],
    content_blocks: [
      { type: 'text', text: 'Intro text' },
      { type: 'tool_use', tool_call_id: 'plan-1' },
      { type: 'text', text: 'Text after tool' },
    ],
  }

  const baseProps = {
    message: baseMessage,
    messageIndex: 0,
    totalMessages: 1,
    lastPlanMessageIndex: 0,
    hasFollowUpMessage: false,
    sessionId: 'session-1',
    worktreePath: '/tmp/worktree',
    approveShortcut: 'Cmd+Enter',
    isSending: false,
    onPlanApproval: vi.fn(),
    onQuestionAnswer: noopQuestionAnswer,
    onQuestionSkip: vi.fn(),
    onFileClick: vi.fn(),
    onEditedFileClick: vi.fn(),
    onFixFinding: noopFixFinding,
    onFixAllFindings: noopFixAllFindings,
    isQuestionAnswered: vi.fn(() => false),
    getSubmittedAnswers: vi.fn(() => undefined),
    areQuestionsSkipped: vi.fn(() => false),
    isFindingFixed: vi.fn(() => false),
  }

  it('renders assistant text blocks even when a Codex plan is present', () => {
    render(<MessageItem {...baseProps} />)

    expect(screen.getByText('Intro text')).toBeVisible()
    expect(screen.getByText('Text after tool')).toBeVisible()
    expect(screen.getByText('Persisted preview plan')).toBeVisible()
  })

  it('renders explanation-only Codex plans from persisted messages', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          tool_calls: [
            {
              id: 'plan-1',
              name: 'CodexPlan',
              input: {
                explanation: 'Repo inspected. Native plan had no prose body.',
                steps: [{ step: 'Clarify scope', status: 'in_progress' }],
              },
            },
          ],
        }}
      />
    )

    expect(
      screen.getByText('Repo inspected. Native plan had no prose body.')
    ).toBeVisible()
  })

  it('prefers final plan text over explanation-only fallback and hides duplicate text block', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: '',
          tool_calls: [
            {
              id: 'plan-1',
              name: 'CodexPlan',
              input: {
                explanation: 'Repo inspected. Native plan had no prose body.',
                steps: [{ step: 'Clarify scope', status: 'in_progress' }],
              },
            },
          ],
          content_blocks: [
            { type: 'tool_use', tool_call_id: 'plan-1' },
            {
              type: 'text',
              text: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
            },
          ],
        }}
      />
    )

    expect(
      screen.queryByText('Repo inspected. Native plan had no prose body.')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Plan:')).toBeVisible()
    expect(screen.getAllByText('Implement changes')).toHaveLength(1)
    expect(screen.getAllByText('Add tests')).toHaveLength(1)
  })

  it('renders fragmented persisted Codex plan text instead of explanation fallback', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: '',
          tool_calls: [
            {
              id: 'plan-1',
              name: 'CodexPlan',
              input: {
                plan: [{ step: 'Wrong runtime shape' }],
                explanation: 'Summary only',
                steps: [{ step: 'Clarify scope', status: 'in_progress' }],
              },
            },
          ],
          content_blocks: [
            { type: 'tool_use', tool_call_id: 'plan-1' },
            { type: 'text', text: 'Repo inspected.\n\n' },
            { type: 'text', text: 'Plan:\n- Remove auto-continue' },
            { type: 'text', text: '\n- Add tests' },
          ],
        }}
      />
    )

    expect(screen.queryByText('Summary only')).not.toBeInTheDocument()
    expect(screen.getByText('Plan:')).toBeVisible()
    expect(screen.getAllByText('Remove auto-continue')).toHaveLength(1)
    expect(screen.getAllByText('Add tests')).toHaveLength(1)
  })

  it('renders fallback PlanDisplay for old-format assistant messages', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
          tool_calls: [
            {
              id: 'plan-1',
              name: 'CodexPlan',
              input: {
                explanation: 'Repo inspected. Native plan had no prose body.',
                steps: [{ step: 'Clarify scope', status: 'in_progress' }],
              },
            },
          ],
          content_blocks: [],
        }}
      />
    )

    expect(screen.getByText('Plan:')).toBeVisible()
    expect(screen.getAllByText('Implement changes')).toHaveLength(1)
    expect(screen.getAllByText('Add tests')).toHaveLength(1)
    expect(
      screen.queryByText('Repo inspected. Native plan had no prose body.')
    ).not.toBeInTheDocument()
  })

  it('renders fallback PlanDisplay when Codex plan text exists but timeline lacks a plan tool block', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
          tool_calls: [
            {
              id: 'plan-1',
              name: 'CodexPlan',
              input: {
                explanation: 'Fallback explanation',
              },
            },
          ],
          content_blocks: [{ type: 'text', text: 'Repo inspected.' }],
        }}
      />
    )

    expect(screen.getByText('Plan:')).toBeVisible()
    expect(screen.getAllByText('Implement changes')).toHaveLength(1)
    expect(screen.getAllByText('Add tests')).toHaveLength(1)
  })

  it('renders intro text from message content when persisted content blocks only contain plan tools', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: 'I’ll draft a concise, actionable plan.',
          tool_calls: [
            {
              id: 'enter-plan-1',
              name: 'EnterPlanMode',
              input: { title: 'Plan mode instructions', instructions: [] },
            },
            {
              id: 'plan-1',
              name: 'ExitPlanMode',
              input: { plan: 'Plan:\n- Inspect birds' },
            },
          ],
          content_blocks: [
            { type: 'tool_use', tool_call_id: 'enter-plan-1' },
            { type: 'tool_use', tool_call_id: 'plan-1' },
          ],
        }}
      />
    )

    expect(
      screen.getByText('I’ll draft a concise, actionable plan.')
    ).toBeVisible()
    expect(screen.getByText('Inspect birds')).toBeVisible()
  })

  it('renders prose before the fallback plan above tool calls', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
          tool_calls: [
            {
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/tmp/demo.ts' },
              output: 'done',
            },
            {
              id: 'plan-1',
              name: 'CodexPlan',
              input: {
                explanation: 'Repo inspected. Native plan had no prose body.',
                steps: [{ step: 'Clarify scope', status: 'in_progress' }],
              },
            },
          ],
          content_blocks: [],
        }}
      />
    )

    const prose = screen.getByText('Repo inspected.')
    const toolsToggle = screen.getByRole('button', { name: /1 tool used/i })
    expect(prose.compareDocumentPosition(toolsToggle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.getByText('Plan:')).toBeVisible()
  })

  it('renders answered OpenCode questions with the same persisted summary styling', () => {
    render(
      <MessageItem
        {...baseProps}
        hasFollowUpMessage={false}
        isQuestionAnswered={vi.fn(() => true)}
        message={{
          ...baseMessage,
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
                      {
                        label: 'Raptors',
                        description: 'Eagles, hawks, falcons',
                      },
                      {
                        label: 'Songbirds',
                        description: 'Robins, sparrows, warblers',
                      },
                    ],
                  },
                ],
              },
              output: JSON.stringify([
                { questionIndex: 0, selectedOptions: [0] },
              ]),
            },
          ],
          content_blocks: [{ type: 'tool_use', tool_call_id: 'question-1' }],
        }}
      />
    )

    expect(screen.getByText('Raptors')).toBeVisible()
  })

  it('renders mermaid code blocks with a Render toggle and SVG output', async () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: '',
          tool_calls: [],
          content_blocks: [
            {
              type: 'text',
              text: '```mermaid\ngraph TD\n  A-->B\n```',
            },
          ],
        }}
      />
    )

    const toggle = await screen.findByRole('switch', {
      name: /toggle mermaid rendering/i,
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByText('mermaid-svg')).toBeInTheDocument()
  })

  it('shows raw mermaid source when the Render toggle is turned off', async () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: '',
          tool_calls: [],
          content_blocks: [
            {
              type: 'text',
              text: '```mermaid\ngraph TD\n  A-->B\n```',
            },
          ],
        }}
      />
    )

    const toggle = await screen.findByRole('switch', {
      name: /toggle mermaid rendering/i,
    })
    await userEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/A-->B/)).toBeInTheDocument()
  })

  it('does not render a mermaid toggle for non-mermaid code blocks', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: '',
          tool_calls: [],
          content_blocks: [
            {
              type: 'text',
              text: '```ts\nconst x = 1\n```',
            },
          ],
        }}
      />
    )

    expect(
      screen.queryByRole('switch', { name: /toggle mermaid rendering/i })
    ).not.toBeInTheDocument()
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument()
  })
})
