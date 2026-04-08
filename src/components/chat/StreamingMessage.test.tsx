import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { StreamingMessage } from './StreamingMessage'
import type { QuestionAnswer, Question } from '@/types/chat'

describe('StreamingMessage', () => {
  const noopQuestionAnswer = (
    _toolCallId: string,
    _answers: QuestionAnswer[],
    _questions: Question[]
  ) => undefined

  const baseProps = {
    sessionId: 'session-1',
    contentBlocks: [],
    toolCalls: [],
    streamingContent: '',
    onQuestionAnswer: noopQuestionAnswer,
    onQuestionSkip: vi.fn(),
    onFileClick: vi.fn(),
    onEditedFileClick: vi.fn(),
    isQuestionAnswered: vi.fn(() => false),
    getSubmittedAnswers: vi.fn(() => undefined),
    areQuestionsSkipped: vi.fn(() => false),
  }

  it('renders no text before the first streaming chunk arrives', () => {
    render(<StreamingMessage {...baseProps} />)

    expect(screen.queryByText('Plan')).not.toBeInTheDocument()
    expect(screen.queryByText('Working on it...')).not.toBeInTheDocument()
  })

  it('hides the placeholder once streaming text is available', () => {
    render(
      <StreamingMessage {...baseProps} streamingContent="Working on it..." />
    )

    expect(
      screen.queryByTestId('streaming-response-placeholder')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Working on it...')).toBeVisible()
  })

  it('shows Codex plan_preview content while streaming', () => {
    render(
      <StreamingMessage
        {...baseProps}
        contentBlocks={[{ type: 'tool_use', tool_call_id: 'plan-1' }]}
        toolCalls={[
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: { plan_preview: 'Partial plan from stream' },
          },
        ]}
      />
    )

    expect(screen.getByText('Plan')).toBeVisible()
    expect(screen.getByText('Partial plan from stream')).toBeVisible()
    expect(screen.queryByText('Approve')).not.toBeInTheDocument()
  })

  it('keeps assistant text visible alongside a Codex plan', () => {
    render(
      <StreamingMessage
        {...baseProps}
        contentBlocks={[
          { type: 'text', text: 'Before tools' },
          { type: 'tool_use', tool_call_id: 'plan-1' },
          { type: 'text', text: 'After tools' },
        ]}
        toolCalls={[
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: { plan_preview: 'Plan body' },
          },
        ]}
      />
    )

    expect(screen.getByText('Before tools')).toBeVisible()
    expect(screen.getByText('After tools')).toBeVisible()
    expect(screen.getByText('Plan body')).toBeVisible()
  })

  it('shows Codex explanation-only native plans', () => {
    render(
      <StreamingMessage
        {...baseProps}
        contentBlocks={[{ type: 'tool_use', tool_call_id: 'plan-1' }]}
        toolCalls={[
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              explanation:
                'Repo inspected. No implementation target was provided.',
              steps: [
                { step: 'Clarify scope', status: 'in_progress' },
                { step: 'Implement changes', status: 'pending' },
              ],
            },
          },
        ]}
      />
    )

    expect(
      screen.getByText('Repo inspected. No implementation target was provided.')
    ).toBeVisible()
  })

  it('prefers streamed plan text over explanation-only fallback and hides duplicate text block', () => {
    render(
      <StreamingMessage
        {...baseProps}
        streamingContent={
          'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests'
        }
        contentBlocks={[
          { type: 'tool_use', tool_call_id: 'plan-1' },
          {
            type: 'text',
            text: 'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests',
          },
        ]}
        toolCalls={[
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              explanation: 'Repo inspected. No implementation target given.',
              steps: [{ step: 'Clarify scope', status: 'in_progress' }],
            },
          },
        ]}
      />
    )

    expect(
      screen.queryByText('Repo inspected. No implementation target given.')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Plan:')).toBeVisible()
    expect(screen.getAllByText('Implement changes')).toHaveLength(1)
    expect(screen.getAllByText('Add tests')).toHaveLength(1)
  })

  it('renders fragmented streamed Codex plan text instead of explanation fallback', () => {
    render(
      <StreamingMessage
        {...baseProps}
        contentBlocks={[
          { type: 'tool_use', tool_call_id: 'plan-1' },
          { type: 'text', text: 'Repo inspected.\n\n' },
          { type: 'text', text: 'Plan:\n- Remove auto-continue' },
          { type: 'text', text: '\n- Add tests' },
        ]}
        toolCalls={[
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              plan: [{ step: 'Wrong runtime shape' }],
              explanation: 'Summary only',
              steps: [{ step: 'Clarify scope', status: 'in_progress' }],
            },
          },
        ]}
      />
    )

    expect(screen.queryByText('Summary only')).not.toBeInTheDocument()
    expect(screen.getByText('Plan:')).toBeVisible()
    expect(screen.getAllByText('Remove auto-continue')).toHaveLength(1)
    expect(screen.getAllByText('Add tests')).toHaveLength(1)
  })

  it('renders fallback PlanDisplay for old-format streaming messages', () => {
    render(
      <StreamingMessage
        {...baseProps}
        streamingContent={
          'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests'
        }
        toolCalls={[
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              explanation: 'Repo inspected. No implementation target given.',
              steps: [{ step: 'Clarify scope', status: 'in_progress' }],
            },
          },
        ]}
      />
    )

    expect(screen.getByText('Plan:')).toBeVisible()
    expect(screen.getAllByText('Implement changes')).toHaveLength(1)
    expect(screen.getAllByText('Add tests')).toHaveLength(1)
    expect(
      screen.queryByText('Repo inspected. No implementation target given.')
    ).not.toBeInTheDocument()
  })

  it('renders fallback PlanDisplay when streaming timeline lacks a plan tool block', () => {
    render(
      <StreamingMessage
        {...baseProps}
        streamingContent={
          'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests'
        }
        contentBlocks={[{ type: 'text', text: 'Repo inspected.' }]}
        toolCalls={[
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              explanation: 'Fallback explanation',
            },
          },
        ]}
      />
    )

    expect(screen.getByText('Plan:')).toBeVisible()
    expect(screen.getAllByText('Implement changes')).toHaveLength(1)
    expect(screen.getAllByText('Add tests')).toHaveLength(1)
  })

  it('renders prose before the fallback streaming plan above tool calls', () => {
    render(
      <StreamingMessage
        {...baseProps}
        streamingContent={
          'Repo inspected.\n\nPlan:\n- Implement changes\n- Add tests'
        }
        toolCalls={[
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
              explanation: 'Repo inspected. No implementation target given.',
              steps: [{ step: 'Clarify scope', status: 'in_progress' }],
            },
          },
        ]}
      />
    )

    const prose = screen.getByText('Repo inspected.')
    const toolsToggle = screen.getByRole('button', { name: /1 tool used/i })
    expect(prose.compareDocumentPosition(toolsToggle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.getByText('Plan:')).toBeVisible()
  })

  it('renders answered OpenCode questions with persisted tool output while streaming', () => {
    render(
      <StreamingMessage
        {...baseProps}
        isQuestionAnswered={vi.fn(() => true)}
        contentBlocks={[{ type: 'tool_use', tool_call_id: 'question-1' }]}
        toolCalls={[
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
        ]}
      />
    )

    expect(screen.getByText('Raptors')).toBeVisible()
  })
})
