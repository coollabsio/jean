import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { StreamingMessage } from './StreamingMessage'
import type { QuestionAnswer, Question } from '@/types/chat'

describe('StreamingMessage', () => {
  const noopQuestionAnswer = (
    _toolCallId: string,
    _answers: QuestionAnswer[],
    _questions: Question[]
  ) => {}

  const baseProps = {
    sessionId: 'session-1',
    contentBlocks: [],
    toolCalls: [],
    streamingContent: '',
    selectedThinkingLevel: 'think' as const,
    approveShortcut: 'Cmd+Enter',
    onQuestionAnswer: noopQuestionAnswer,
    onQuestionSkip: vi.fn(),
    onFileClick: vi.fn(),
    onEditedFileClick: vi.fn(),
    isQuestionAnswered: vi.fn(() => false),
    getSubmittedAnswers: vi.fn(() => undefined),
    areQuestionsSkipped: vi.fn(() => false),
    isStreamingPlanApproved: vi.fn(() => false),
    onStreamingPlanApproval: vi.fn(),
  }

  it('shows a response placeholder before the first streaming chunk arrives', () => {
    render(<StreamingMessage {...baseProps} />)

    expect(screen.getByTestId('streaming-response-placeholder')).toBeVisible()
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
})
