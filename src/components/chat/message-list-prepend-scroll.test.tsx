import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@/test/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompactMessageList } from './CompactMessageList'
import type {
  ChatMessage,
  Question,
  QuestionAnswer,
  ReviewFinding,
} from '@/types/chat'

vi.mock('./MessageItem', () => ({
  MessageItem: ({ message }: { message: ChatMessage }) => (
    <div>{message.content}</div>
  ),
}))

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

function message(id: string, content = id): ChatMessage {
  return {
    id,
    session_id: 'session-1',
    role: id.startsWith('user') ? 'user' : 'assistant',
    content,
    timestamp: 100,
    tool_calls: [],
    content_blocks: [{ type: 'text', text: content }],
  }
}

const baseProps = {
  totalMessages: 2,
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
}

const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect
let rectTopByMessageId = new Map<string, number>()

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  rectTopByMessageId = new Map()
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.getAttribute('data-testid') === 'scroll-container') {
      return rect(100, 500)
    }
    const messageId = this.dataset.messageAnchorId
    if (messageId && rectTopByMessageId.has(messageId)) {
      const top = rectTopByMessageId.get(messageId) ?? 0
      return rect(top, top + 80)
    }
    return originalGetBoundingClientRect.call(this)
  }
})

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

function ScrollContainer({ children }: { children: ReactNode }) {
  return (
    <div data-testid="scroll-container" style={{ height: 400 }}>
      {children}
    </div>
  )
}

describe('older message prepend scroll restoration', () => {
  it('keeps the same compact-list message at the same viewport offset after loading older runs', () => {
    const scrollContainerRef = { current: null as HTMLDivElement | null }
    const onLoadOlderRuns = vi.fn()
    const currentMessages = [
      message('user-current'),
      message('assistant-current'),
    ]

    const { rerender } = render(
      <ScrollContainer>
        <CompactMessageList
          {...baseProps}
          messages={currentMessages}
          scrollContainerRef={scrollContainerRef}
          totalMessages={currentMessages.length}
          hasOlderOnDisk
          onLoadOlderRuns={onLoadOlderRuns}
          loadedRunStartIndex={1}
        />
      </ScrollContainer>
    )
    const container = screen.getByTestId('scroll-container') as HTMLDivElement
    scrollContainerRef.current = container
    container.scrollTop = 250
    rectTopByMessageId.set('user-current', 140)
    rectTopByMessageId.set('assistant-current', 230)

    fireEvent.click(screen.getByRole('button', { name: /load old prompts/i }))

    expect(onLoadOlderRuns).toHaveBeenCalledTimes(1)

    rectTopByMessageId.set('user-current', 360)
    rectTopByMessageId.set('assistant-current', 450)
    const prependedMessages = [
      message('user-older'),
      message('assistant-older'),
      ...currentMessages,
    ]

    rerender(
      <ScrollContainer>
        <CompactMessageList
          {...baseProps}
          messages={prependedMessages}
          scrollContainerRef={scrollContainerRef}
          totalMessages={prependedMessages.length}
          hasOlderOnDisk={false}
          onLoadOlderRuns={onLoadOlderRuns}
          loadedRunStartIndex={0}
        />
      </ScrollContainer>
    )

    expect(container.scrollTop).toBe(470)
  })
})
