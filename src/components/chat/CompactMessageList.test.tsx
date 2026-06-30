import { createRef } from 'react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { CompactMessageList } from './CompactMessageList'
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

function renderCompact(
  messages: ChatMessage[],
  props: Partial<ComponentProps<typeof CompactMessageList>> = {}
) {
  return render(
    <CompactMessageList
      messages={messages}
      scrollContainerRef={createRef<HTMLDivElement>()}
      totalMessages={messages.length}
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
      {...props}
    />
  )
}

describe('CompactMessageList', () => {
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

    const activityCard = compactTrigger.closest('.rounded-md.border')
    const cancelledMarker = screen.getByText('(cancelled)')

    expect(activityCard).not.toBeNull()
    expect(activityCard).not.toContainElement(cancelledMarker)
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

  it('shows edited files after an externally surfaced recap', () => {
    renderCompact([
      message('user-1', 'user', 100, 'make the change'),
      message(
        'assistant-1',
        'assistant',
        104,
        'Done.\n\n## Recap\n\nChanged chat UI.',
        {
          tool_calls: [
            {
              id: 'tool-1',
              name: 'FileChange',
              input: [
                {
                  path: 'src/components/chat/CompactMessageList.tsx',
                  diff: '@@ -1 +1 @@\n-old\n+new\n',
                },
              ],
            },
          ],
          content_blocks: [
            { type: 'tool_use', tool_call_id: 'tool-1' },
            { type: 'text', text: 'Done.\n\n## Recap\n\nChanged chat UI.' },
          ],
        }
      ),
    ])

    const recapHeading = screen.getByText('Recap')
    const editedFiles = screen.getByText('Edited 1 file:')

    expect(editedFiles).toBeVisible()
    expect(
      recapHeading.compareDocumentPosition(editedFiles) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('shows edited files after surfaced latest text when recap is absent', () => {
    renderCompact([
      message('user-1', 'user', 100, 'make the change'),
      message('assistant-1', 'assistant', 104, 'Changed chat UI.', {
        tool_calls: [
          {
            id: 'tool-1',
            name: 'FileChange',
            input: [
              {
                path: 'src/components/chat/CompactMessageList.tsx',
                diff: '@@ -1 +1 @@\n-old\n+new\n',
              },
            ],
          },
        ],
        content_blocks: [
          { type: 'tool_use', tool_call_id: 'tool-1' },
          { type: 'text', text: 'Changed chat UI.' },
        ],
      }),
    ])

    const latestText = screen.getAllByText('Changed chat UI.').at(-1)
    const editedFiles = screen.getByText('Edited 1 file:')

    expect(editedFiles).toBeVisible()
    expect(latestText).toBeDefined()
    if (!latestText) throw new Error('Expected changed chat UI text to render')
    expect(
      latestText.compareDocumentPosition(editedFiles) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
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

  it('copies each steered prompt', () => {
    const onCopyToInput = vi.fn()

    renderCompact(
      [
        message('user-1', 'user', 100, 'hello'),
        message('assistant-1', 'assistant', 104, 'All received', {
          content_blocks: [
            { type: 'user_input', text: 'first queued prompt' },
            { type: 'user_input', text: 'second queued prompt' },
          ],
        }),
      ],
      { onCopyToInput }
    )

    const copyButtons = screen.getAllByRole('button', {
      name: 'Copy steered prompt',
    })

    expect(copyButtons).toHaveLength(2)

    const secondCopyButton = copyButtons[1]
    if (!secondCopyButton) {
      throw new Error('Expected second copy button')
    }
    fireEvent.click(secondCopyButton)

    expect(onCopyToInput).toHaveBeenCalledTimes(1)
    expect(onCopyToInput).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: 'second queued prompt',
      })
    )
  })
})
