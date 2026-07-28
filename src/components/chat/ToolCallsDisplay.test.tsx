import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { QuestionAnswer, ToolCall } from '@/types/chat'
import { ToolCallsDisplay } from './ToolCallsDisplay'

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: { expand_tool_calls_by_default: false } }),
}))

describe('ToolCallsDisplay', () => {
  const baseProps = {
    sessionId: 'session-1',
    isQuestionAnswered: () => false,
    getSubmittedAnswers: () => undefined,
  }

  it('shows bash tool stdout when expanded (issue #572)', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'cd /blah; command; command2' },
        output: 'hello from bash\nline 2\n',
      },
    ]

    render(<ToolCallsDisplay {...baseProps} toolCalls={toolCalls} />)

    // Collapsed by default — expand the tools list
    fireEvent.click(screen.getByRole('button', { name: /1 tool used/i }))

    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('Output:')).toBeInTheDocument()
    expect(screen.getByText(/hello from bash/)).toBeInTheDocument()
    expect(screen.getByText(/line 2/)).toBeInTheDocument()
  })

  it.each(['completed', 'ok', 'success', 'context compacted'])(
    'hides placeholder tool output "%s"',
    output => {
      const toolCalls: ToolCall[] = [
        {
          id: 'tool-1',
          name: 'ExampleTool',
          input: { value: 'test' },
          output,
        },
      ]

      render(<ToolCallsDisplay {...baseProps} toolCalls={toolCalls} />)
      fireEvent.click(screen.getByRole('button', { name: /1 tool used/i }))

      expect(screen.queryByText('Output:')).not.toBeInTheDocument()
      expect(screen.queryByText(output)).not.toBeInTheDocument()
    }
  )

  it('renders native Codex request_user_input as an interactive question card', () => {
    const onQuestionAnswer =
      vi.fn<
        (
          toolCallId: string,
          answers: QuestionAnswer[],
          questions: unknown[]
        ) => void
      >()
    const toolCalls: ToolCall[] = [
      {
        id: 'codex-user-input-1',
        name: 'request_user_input',
        input: {
          questions: [
            {
              id: 'scope',
              header: 'Scope',
              question: 'Which scope?',
              options: [{ label: 'Backend' }, { label: 'Frontend' }],
            },
          ],
        },
      },
    ]

    render(
      <ToolCallsDisplay
        {...baseProps}
        toolCalls={toolCalls}
        onQuestionAnswer={onQuestionAnswer}
      />
    )

    expect(screen.getByText('Scope')).toBeInTheDocument()
    expect(screen.getByText('Which scope?')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Frontend'))
    fireEvent.click(screen.getByText('Answer'))

    expect(onQuestionAnswer).toHaveBeenCalledWith(
      'codex-user-input-1',
      [{ questionIndex: 0, selectedOptions: [1], customText: undefined }],
      [
        expect.objectContaining({
          header: 'Scope',
          question: 'Which scope?',
          options: [{ label: 'Backend' }, { label: 'Frontend' }],
        }),
      ]
    )
  })
})
