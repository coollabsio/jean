import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'
import { toast } from 'sonner'
import { MessageItem } from './MessageItem'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
  },
}))

type MessageItemProps = ComponentProps<typeof MessageItem>

const createAssistantMessage = (content: string): ChatMessage => ({
  id: 'msg-1',
  session_id: 'session-1',
  role: 'assistant',
  content,
  timestamp: Date.now(),
  tool_calls: [],
})

const createProps = (
  overrides: Partial<MessageItemProps> = {}
): MessageItemProps => ({
  message: createAssistantMessage('Assistant response text'),
  messageIndex: 0,
  totalMessages: 1,
  lastPlanMessageIndex: -1,
  hasFollowUpMessage: false,
  sessionId: 'session-1',
  worktreePath: '/tmp/worktree',
  approveShortcut: 'Cmd+Enter',
  isSending: false,
  onPlanApproval: vi.fn(),
  onQuestionAnswer: vi.fn<
    (_toolCallId: string, _answers: QuestionAnswer[], _questions: Question[]) => void
  >(),
  onQuestionSkip: vi.fn<(_toolCallId: string) => void>(),
  onFileClick: vi.fn<(_path: string) => void>(),
  onEditedFileClick: vi.fn<(_path: string) => void>(),
  onFixFinding: vi.fn<
    (_finding: ReviewFinding, _suggestion?: string) => Promise<void>
  >().mockResolvedValue(undefined),
  onFixAllFindings: vi.fn<
    (_findings: { finding: ReviewFinding; suggestion?: string }[]) => Promise<void>
  >().mockResolvedValue(undefined),
  isQuestionAnswered: (_sessionId: string, _toolCallId: string) => false,
  getSubmittedAnswers: (_sessionId: string, _toolCallId: string) => undefined,
  areQuestionsSkipped: (_sessionId: string) => false,
  isFindingFixed: (_sessionId: string, _key: string) => false,
  ...overrides,
})

describe('MessageItem assistant response copy button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a copy response button for assistant messages with content', () => {
    render(<MessageItem {...createProps()} />)

    expect(
      screen.getByRole('button', { name: /copy response/i })
    ).toBeInTheDocument()
  })

  it('copies assistant response text when copy response button is clicked', async () => {
    const user = userEvent.setup()
    const writeTextMock = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)

    render(<MessageItem {...createProps()} />)

    await user.click(screen.getByRole('button', { name: /copy response/i }))

    expect(writeTextMock).toHaveBeenCalledWith('Assistant response text')
    expect(toast.success).toHaveBeenCalledWith('Copied to clipboard')
  })

  it('does not render copy response button when assistant content is empty', () => {
    render(
      <MessageItem
        {...createProps({ message: createAssistantMessage('   ') })}
      />
    )

    expect(
      screen.queryByRole('button', { name: /copy response/i })
    ).not.toBeInTheDocument()
  })
})
