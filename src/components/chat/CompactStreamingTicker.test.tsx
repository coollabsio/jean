import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { CompactStreamingTicker } from './CompactStreamingTicker'
import type { Question, QuestionAnswer } from '@/types/chat'

describe('CompactStreamingTicker', () => {
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

  it('keeps plan-mode tool batches compact while rendering the Codex plan', () => {
    render(
      <CompactStreamingTicker
        {...baseProps}
        contentBlocks={[
          { type: 'tool_use', tool_call_id: 'bash-1' },
          { type: 'tool_use', tool_call_id: 'bash-2' },
          { type: 'text', text: 'Repo inspected.' },
          { type: 'tool_use', tool_call_id: 'bash-3' },
          { type: 'tool_use', tool_call_id: 'plan-1' },
        ]}
        toolCalls={[
          {
            id: 'bash-1',
            name: 'Bash',
            input: { command: 'rtk cat CLAUDE.md' },
            output: 'ok',
          },
          {
            id: 'bash-2',
            name: 'Bash',
            input: { command: 'rtk rg compact src' },
            output: 'ok',
          },
          {
            id: 'bash-3',
            name: 'Bash',
            input: { command: 'rtk sed -n 1,80p file' },
          },
          {
            id: 'plan-1',
            name: 'CodexPlan',
            input: {
              plan_preview: 'Plan:\n- Patch compact ticker\n- Add tests',
            },
          },
        ]}
      />
    )

    expect(screen.getByText('3 steps')).toBeVisible()
    expect(screen.getByText('Plan')).toBeVisible()
    expect(screen.getByText('Patch compact ticker')).toBeVisible()

    // Regression: CodexPlan used to force full StreamingMessage, exposing
    // multiple StackedGroup headers like "2 Bash" while the run was active.
    expect(screen.queryByText('2 Bash')).not.toBeInTheDocument()
    expect(screen.queryByText('3 Bash')).not.toBeInTheDocument()
  })

  it('splits compact activity around steered user prompts', () => {
    render(
      <CompactStreamingTicker
        {...baseProps}
        contentBlocks={[
          { type: 'tool_use', tool_call_id: 'bash-1' },
          { type: 'user_input', text: 'also update the docs' },
          { type: 'tool_use', tool_call_id: 'read-1' },
        ]}
        toolCalls={[
          {
            id: 'bash-1',
            name: 'Bash',
            input: { command: 'rtk git status' },
            output: 'ok',
          },
          {
            id: 'read-1',
            name: 'Read',
            input: { file_path: 'docs/developer/architecture-guide.md' },
          },
        ]}
      />
    )

    const beforeSteer = screen.getByRole('button', { name: /Bash/ })
    const steeredPrompt = screen.getByText('also update the docs')
    const afterSteer = screen.getByRole('button', { name: /Read/ })

    expect(
      beforeSteer.compareDocumentPosition(steeredPrompt) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      steeredPrompt.compareDocumentPosition(afterSteer) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('summarizes fragmented PI text deltas as one meaningful line while streaming', () => {
    render(
      <CompactStreamingTicker
        {...baseProps}
        contentBlocks={[
          { type: 'tool_use', tool_call_id: 'write-1' },
          { type: 'text', text: 'Created `' },
          { type: 'text', text: 'tmp/test.txt' },
          { type: 'text', text: '`.' },
        ]}
        toolCalls={[
          {
            id: 'write-1',
            name: 'Write',
            input: { file_path: 'tmp/test.txt' },
            output: 'ok',
          },
        ]}
      />
    )

    expect(
      screen.getByRole('button', { name: /Created `tmp\/test\.txt`\./ })
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /^`\./ })
    ).not.toBeInTheDocument()
  })

  it('surfaces edited files outside the collapsed streaming ticker', () => {
    render(
      <CompactStreamingTicker
        {...baseProps}
        worktreePath="/tmp/worktree"
        contentBlocks={[{ type: 'tool_use', tool_call_id: 'change-1' }]}
        toolCalls={[
          {
            id: 'change-1',
            name: 'FileChange',
            input: [
              {
                path: 'src/components/chat/CompactStreamingTicker.tsx',
                diff: '@@ -1 +1 @@\n-old\n+new\n',
              },
            ],
          },
        ]}
      />
    )

    const ticker = screen.getByRole('button', { name: /FileChange/ })
    const editedFiles = screen.getByText('Edited 1 file:')

    expect(editedFiles).toBeVisible()
    expect(ticker.closest('.rounded-md.border')).not.toContainElement(
      editedFiles
    )
    expect(
      screen.getByRole('button', {
        name: /View changes to CompactStreamingTicker\.tsx/,
      })
    ).toBeVisible()
  })
})
