import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { MessageItem } from './MessageItem'
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
    expect(screen.getByText('Clarify scope')).toBeVisible()
    expect(screen.getByText('In progress:')).toBeVisible()
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

  it('does not render message content as intro when it exactly matches the Codex plan', () => {
    render(
      <MessageItem
        {...baseProps}
        message={{
          ...baseMessage,
          content: 'Short answer: goal is separate from plan mode.',
          tool_calls: [
            {
              id: 'plan-1',
              name: 'CodexPlan',
              input: {
                plan: 'Short answer: goal is separate from plan mode.',
              },
            },
          ],
          content_blocks: [{ type: 'tool_use', tool_call_id: 'plan-1' }],
        }}
      />
    )

    expect(
      screen.getAllByText('Short answer: goal is separate from plan mode.')
    ).toHaveLength(1)
  })

  it('renders prose before the fallback plan above tool calls', () => {
    render(
      <MessageItem
        {...baseProps}
        durationMs={23_000}
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
    const duration = screen.getByText('23s')
    const toolsToggle = screen.getByRole('button', { name: /1 tool used/i })
    expect(prose.compareDocumentPosition(toolsToggle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(duration.compareDocumentPosition(toolsToggle)).toBe(
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

  it('renders assistant duration in mm:ss format when minutes are non-zero', () => {
    render(<MessageItem {...baseProps} durationMs={145_000} />)

    expect(screen.getByText('02:25')).toBeVisible()
  })

  it('renders assistant duration as seconds only when under a minute', () => {
    render(<MessageItem {...baseProps} durationMs={23_000} />)

    expect(screen.getByText('23s')).toBeVisible()
  })

  it('copies steered prompts rendered in full native messages', () => {
    const onCopyToInput = vi.fn()

    render(
      <MessageItem
        {...baseProps}
        onCopyToInput={onCopyToInput}
        message={{
          ...baseMessage,
          id: 'assistant-steered',
          content: '',
          tool_calls: [],
          content_blocks: [
            { type: 'text', text: 'Before steer' },
            { type: 'user_input', text: 'copy this steered prompt' },
            { type: 'text', text: 'After steer' },
          ],
        }}
      />
    )

    screen.getByRole('button', { name: 'Copy steered prompt' }).click()

    expect(onCopyToInput).toHaveBeenCalledTimes(1)
    expect(onCopyToInput).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: 'copy this steered prompt',
      })
    )
  })
})
