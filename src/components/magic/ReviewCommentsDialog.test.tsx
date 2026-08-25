import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { ReviewCommentsDialog } from './ReviewCommentsDialog'

const mocks = vi.hoisted(() => {
  let reviewCommentsModalOpen = true
  let reviewCommentsMode: 'plan' | 'yolo' = 'yolo'

  return {
    getReviewCommentsModalOpen: () => reviewCommentsModalOpen,
    setReviewCommentsModalOpen: vi.fn((open: boolean) => {
      reviewCommentsModalOpen = open
    }),
    resetReviewCommentsModalOpen: (open = true) => {
      reviewCommentsModalOpen = open
    },
    setReviewCommentsMode: (mode: 'plan' | 'yolo') => {
      reviewCommentsMode = mode
    },
    getReviewCommentsMode: () => reviewCommentsMode,
    setPendingMagicCommand: vi.fn(),
    invokeMock: vi.fn(),
  }
})

vi.mock('@/store/ui-store', () => ({
  useUIStore: () => ({
    reviewCommentsModalOpen: mocks.getReviewCommentsModalOpen(),
    setReviewCommentsModalOpen: mocks.setReviewCommentsModalOpen,
  }),
}))

vi.mock('@/store/projects-store', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) =>
    selector({
      selectedProjectId: 'project-1',
      selectedWorktreeId: 'wt-1',
    }),
}))

vi.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => ({
      activeWorktreePath: '/repo/worktree',
      setPendingMagicCommand: mocks.setPendingMagicCommand,
    }),
  },
}))

vi.mock('@/services/projects', () => ({
  useWorktrees: () => ({
    data: [
      {
        id: 'wt-1',
        path: '/repo/worktree',
        pr_number: 123,
      },
    ],
  }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      magic_prompt_modes: {
        review_comments_mode: mocks.getReviewCommentsMode(),
      },
    },
  }),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invokeMock }))

const inlineComments = [
  {
    path: 'src/file.ts',
    line: 12,
    body: 'Please fix this',
    diffHunk: '@@ -1 +1 @@',
    createdAt: '2026-05-25T10:00:00Z',
    author: { login: 'reviewer' },
    isOutdated: false,
    isResolved: false,
  },
  {
    path: 'src/other.ts',
    line: 34,
    body: 'Second comment body\nExpanded details only',
    diffHunk: '@@ -2 +2 @@',
    createdAt: '2026-05-24T10:00:00Z',
    author: { login: 'second-reviewer' },
    isOutdated: false,
    isResolved: false,
  },
  {
    path: 'src/resolved.ts',
    line: 5,
    body: 'Already fixed finding',
    diffHunk: '@@ -3 +3 @@',
    createdAt: '2026-05-23T10:00:00Z',
    author: { login: 'bot' },
    isOutdated: false,
    isResolved: true,
  },
  {
    path: 'src/outdated.ts',
    line: 8,
    body: 'Line moved away',
    diffHunk: '@@ -4 +4 @@',
    createdAt: '2026-05-22T10:00:00Z',
    author: { login: 'bot' },
    isOutdated: true,
    isResolved: false,
  },
]

describe('ReviewCommentsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resetReviewCommentsModalOpen()
    mocks.setReviewCommentsMode('yolo')
    mocks.invokeMock.mockImplementation(
      (command: string, _args: Record<string, unknown>) => {
        if (command === 'get_pr_review_comments') {
          return Promise.resolve(inlineComments)
        }

        if (command === 'get_github_pr') {
          return Promise.resolve({
            comments: [
              {
                body: 'Conversation comment body',
                created_at: '2026-05-23T10:00:00Z',
                author: { login: 'commenter' },
              },
            ],
            reviews: [
              {
                state: 'COMMENTED',
                body: 'Review summary body',
                submittedAt: '2026-05-22T10:00:00Z',
                author: { login: 'reviewer' },
              },
            ],
          })
        }

        return Promise.reject(new Error(`unexpected command: ${command}`))
      }
    )
  })

  it('clears send loading state when reopened after sending comments to chat', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ReviewCommentsDialog />)

    const sendButton = await screen.findByRole('button', {
      name: /send to chat/i,
    })
    expect(sendButton).toBeEnabled()

    await user.click(sendButton)

    await waitFor(() => {
      expect(mocks.setReviewCommentsModalOpen).toHaveBeenCalledWith(false)
    })

    mocks.resetReviewCommentsModalOpen()
    rerender(<ReviewCommentsDialog />)

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /send to chat/i })
      ).toBeEnabled()
    })
  })

  it('supports keyboard navigation, expand, and selection in the active comments tab', async () => {
    const user = userEvent.setup()
    render(<ReviewCommentsDialog />)

    const firstRow = await screen.findByTestId('review-comment-row-inline-0')
    const secondRow = await screen.findByTestId('review-comment-row-inline-1')

    expect(firstRow).toHaveAttribute('data-active', 'true')
    expect(secondRow).toHaveAttribute('data-active', 'false')

    await user.keyboard('{ArrowDown}')
    expect(firstRow).toHaveAttribute('data-active', 'false')
    expect(secondRow).toHaveAttribute('data-active', 'true')

    expect(screen.queryByText('Diff context')).not.toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Diff context')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(screen.queryByText('Diff context')).not.toBeInTheDocument()

    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
    await user.keyboard(' ')
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument()

    await user.keyboard('{ArrowUp}')
    expect(firstRow).toHaveAttribute('data-active', 'true')
    expect(secondRow).toHaveAttribute('data-active', 'false')
  })

  it('uses cmd+enter to send selected comments separately', async () => {
    const user = userEvent.setup()
    const magicCommand = vi.fn()
    window.addEventListener('magic-command', magicCommand)

    try {
      render(<ReviewCommentsDialog />)
      await screen.findByRole('button', { name: /send to chat/i })

      await user.keyboard('{Meta>}{Enter}{/Meta}')

      await waitFor(() => {
        expect(magicCommand).toHaveBeenCalledTimes(1)
      })
      const detail = (magicCommand.mock.calls[0]?.[0] as CustomEvent).detail
      expect(detail).toMatchObject({
        command: 'review-comments',
        executionMode: 'yolo',
      })
      expect(detail.prompts).toHaveLength(2)
      expect(detail.prompts[0]).toContain('Please fix this')
      expect(detail.prompts[1]).toContain('Second comment body')
      expect(detail.prompt).toBeUndefined()
    } finally {
      window.removeEventListener('magic-command', magicCommand)
    }
  })

  it('uses the configured review comments execution mode', async () => {
    const user = userEvent.setup()
    const magicCommand = vi.fn()
    window.addEventListener('magic-command', magicCommand)
    mocks.setReviewCommentsMode('plan')

    try {
      render(<ReviewCommentsDialog />)
      await screen.findByRole('button', { name: /send to chat/i })

      await user.keyboard('{Meta>}{Enter}{/Meta}')

      await waitFor(() => {
        expect(magicCommand).toHaveBeenCalledTimes(1)
      })
      const detail = (magicCommand.mock.calls[0]?.[0] as CustomEvent).detail
      expect(detail).toMatchObject({
        command: 'review-comments',
        executionMode: 'plan',
      })
    } finally {
      window.removeEventListener('magic-command', magicCommand)
    }
  })

  it('uses shift+cmd+enter to send selected comments to chat', async () => {
    const user = userEvent.setup()
    const magicCommand = vi.fn()
    window.addEventListener('magic-command', magicCommand)

    try {
      render(<ReviewCommentsDialog />)
      await screen.findByRole('button', { name: /send separately/i })

      await user.keyboard('{Shift>}{Meta>}{Enter}{/Meta}{/Shift}')

      await waitFor(() => {
        expect(magicCommand).toHaveBeenCalledTimes(1)
      })
      const detail = (magicCommand.mock.calls[0]?.[0] as CustomEvent).detail
      expect(detail).toMatchObject({
        command: 'review-comments',
        executionMode: 'yolo',
      })
      expect(detail.prompt).toContain('Please fix this')
      expect(detail.prompt).toContain('Second comment body')
      expect(detail.prompt).toContain('resolveReviewThread')
      expect(detail.prompt).toContain('coderabbitai')
      expect(detail.prompt).toContain('implemented and verified')
      expect(detail.prompts).toBeUndefined()
    } finally {
      window.removeEventListener('magic-command', magicCommand)
    }
  })

  it('shows keyboard hints on actions and omits the cancel button', async () => {
    render(<ReviewCommentsDialog />)

    await screen.findByRole('button', { name: /send to chat/i })

    expect(
      screen.getAllByRole('button', { name: /send (to chat|separately)/i })
    ).toEqual([
      screen.getByRole('button', { name: /send to chat/i }),
      screen.getByRole('button', { name: /send separately/i }),
    ])

    expect(
      screen.queryByRole('button', { name: /cancel/i })
    ).not.toBeInTheDocument()
    expect(screen.getByText('↑/↓')).toBeInTheDocument()
    expect(screen.getByText('Space')).toBeInTheDocument()
    expect(screen.getByText('⌘')).toBeInTheDocument()
    expect(screen.getAllByText('↵')).not.toHaveLength(0)
    expect(screen.getByText('⇧')).toBeInTheDocument()
  })

  it('defaults to open review comments and hides resolved/outdated', async () => {
    const user = userEvent.setup()
    render(<ReviewCommentsDialog />)

    await screen.findByText('Please fix this')

    // Open filter is default — resolved/outdated bodies stay hidden
    expect(screen.getByText('2 of 2 selected')).toBeInTheDocument()
    expect(screen.getByText('Please fix this')).toBeInTheDocument()
    expect(screen.getByText('Second comment body')).toBeInTheDocument()
    expect(screen.queryByText('Already fixed finding')).not.toBeInTheDocument()
    expect(screen.queryByText('Line moved away')).not.toBeInTheDocument()
    expect(screen.getByTestId('review-filter-open')).toBeInTheDocument()

    // All filter reveals resolved/outdated with status badges
    await user.click(screen.getByTestId('review-filter-all'))
    expect(screen.getByText('Already fixed finding')).toBeInTheDocument()
    expect(screen.getByText('Line moved away')).toBeInTheDocument()
    expect(screen.getByText('Resolved')).toBeInTheDocument()
    expect(screen.getByText('Outdated')).toBeInTheDocument()
    // Only open comments stay pre-selected
    expect(screen.getByText('2 of 4 selected')).toBeInTheDocument()
  })
})
