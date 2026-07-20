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

  it('renders Cursor EnterPlanMode banner before streaming text', () => {
    render(
      <StreamingMessage
        {...baseProps}
        contentBlocks={[
          { type: 'tool_use', tool_call_id: 'enter-plan-1' },
          { type: 'text', text: 'Plan:\n- Inspect code\n- Patch parser' },
        ]}
        toolCalls={[
          {
            id: 'enter-plan-1',
            name: 'EnterPlanMode',
            input: {
              title: 'Plan mode instructions',
              instructions: [
                'Read/analyze only; do not write, edit, or create files.',
                'Do not run mutating commands.',
              ],
            },
          },
        ]}
      />
    )

    expect(screen.getByText('Entered plan mode')).toBeVisible()
    expect(screen.getByText('Plan:')).toBeVisible()
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

  it('renders intro text from streamingContent when content blocks only contain plan tools', () => {
    render(
      <StreamingMessage
        {...baseProps}
        streamingContent="I’ll draft a concise, actionable plan."
        contentBlocks={[
          { type: 'tool_use', tool_call_id: 'enter-plan-1' },
          { type: 'tool_use', tool_call_id: 'plan-1' },
        ]}
        toolCalls={[
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
        ]}
      />
    )

    expect(
      screen.getByText('I’ll draft a concise, actionable plan.')
    ).toBeVisible()
    expect(screen.getByText('Inspect birds')).toBeVisible()
  })

  it('does not render streaming content as intro when it exactly matches the Codex plan', () => {
    render(
      <StreamingMessage
        {...baseProps}
        streamingContent="Short answer: goal is separate from plan mode."
        contentBlocks={[{ type: 'tool_use', tool_call_id: 'plan-1' }]}
        toolCalls={[
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              plan: 'Short answer: goal is separate from plan mode.',
            },
          },
        ]}
      />
    )

    expect(
      screen.getAllByText('Short answer: goal is separate from plan mode.')
    ).toHaveLength(1)
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
    expect(screen.getByText('Clarify scope')).toBeVisible()
    expect(screen.getByText('Implement changes')).toBeVisible()
    expect(screen.getByText('In progress:')).toBeVisible()
  })

  it('parses markdown for streaming text blocks without waiting for a trailing newline', () => {
    const { container } = render(
      <StreamingMessage
        {...baseProps}
        contentBlocks={[
          {
            type: 'text',
            text: '### Blog Post Plan\n1. Pick a clear angle\n2. Choose a title with `birds`',
          },
        ]}
      />
    )

    expect(screen.getByText('Blog Post Plan')).toBeVisible()
    expect(container.querySelectorAll('ol')).toHaveLength(1)
    expect(screen.getByText('Pick a clear angle')).toBeVisible()
    expect(screen.getByText('Choose a title with')).toBeVisible()
    expect(screen.getByText('birds')).toHaveClass('rounded-md')
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

  it('parses markdown across fragmented streaming text blocks', () => {
    const { container } = render(
      <StreamingMessage
        {...baseProps}
        contentBlocks={[
          { type: 'text', text: '### Blog Post Plan\n1. Pick a clear angle' },
          {
            type: 'text',
            text: '\n2. Choose a title\n- Keep it approachable',
          },
        ]}
      />
    )

    expect(screen.getByText('Blog Post Plan')).toBeVisible()
    expect(container.querySelectorAll('ol').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('ul')).toHaveLength(1)
    expect(screen.getByText('Pick a clear angle')).toBeVisible()
    expect(screen.getByText('Choose a title')).toBeVisible()
    expect(screen.getByText('Keep it approachable')).toBeVisible()
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

  it('shows a visual Working row after a steered prompt until new activity arrives', () => {
    render(
      <StreamingMessage
        {...baseProps}
        contentBlocks={[{ type: 'user_input', text: 'please also test this' }]}
      />
    )

    expect(screen.getByText('please also test this')).toBeVisible()
    expect(screen.getByText('Working…')).toBeVisible()
  })

  it('copies steered prompts while streaming', () => {
    const onCopySteeredText = vi.fn()

    render(
      <StreamingMessage
        {...baseProps}
        onCopySteeredText={onCopySteeredText}
        contentBlocks={[
          { type: 'text', text: 'Before steer' },
          { type: 'user_input', text: 'copy the live steer' },
        ]}
      />
    )

    screen.getByRole('button', { name: 'Copy steered prompt' }).click()

    expect(onCopySteeredText).toHaveBeenCalledTimes(1)
    expect(onCopySteeredText).toHaveBeenCalledWith('copy the live steer')
  })
})
