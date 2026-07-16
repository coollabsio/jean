import { act, render, screen } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import type { Worktree } from '@/types/projects'
import type { QuestionAnswer, Session } from '@/types/chat'
import { WorktreeItem } from './WorktreeItem'

const sessionMocks = vi.hoisted(() => ({
  sessions: [] as unknown[],
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/hooks/useRemotePicker', () => ({
  pushNeedsRemotePicker: () => false,
  useRemotePicker: () => vi.fn(),
}))

vi.mock('@/hooks/useWorktreeTerminalStatus', () => ({
  TerminalStatusIndicator: () => null,
}))

vi.mock('@/components/ui/status-indicator', () => ({
  StatusIndicator: ({ status }: { status: string }) => (
    <span data-testid="worktree-status" data-status={status} />
  ),
}))

vi.mock('./WorktreeContextMenu', () => ({
  WorktreeContextMenu: ({ children }: { children: React.ReactNode }) =>
    children,
}))

vi.mock('./useWorktreeMenuActions', () => ({
  useWorktreeMenuActions: () => ({
    handleArchiveOrClose: vi.fn(),
    preferences: {},
  }),
}))

vi.mock('@/components/chat/hooks/useSessionArchive', () => ({
  useSessionArchive: () => ({ handleDeleteSession: vi.fn() }),
}))

vi.mock('@/components/chat/CloseWorktreeDialog', () => ({
  CloseWorktreeDialog: () => null,
}))

vi.mock('@/components/chat/hooks/useCanvasStoreState', () => ({
  useCanvasStoreState: () => ({}),
}))

vi.mock('@/components/layout/SidebarWidthContext', () => ({
  useSidebarWidth: () => 250,
}))

vi.mock('@/services/projects', () => ({
  useRenameWorktree: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/services/chat', () => ({
  useSessions: () => ({
    data: {
      worktree_id: 'worktree-1',
      sessions: sessionMocks.sessions,
      active_session_id: 'session-1',
      version: 2,
    },
  }),
}))

vi.mock('@/services/git-status', () => ({
  useGitStatus: () => ({ data: undefined }),
  gitPush: vi.fn(),
  fetchWorktreesStatus: vi.fn(),
  triggerImmediateGitPoll: vi.fn(),
  performGitPull: vi.fn(),
}))

const worktree: Worktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'feature-question-state',
  path: '/tmp/project/feature-question-state',
  branch: 'feature-question-state',
  base_branch: 'main',
  created_at: 1,
  order: 0,
}

const questionSession: Session = {
  id: 'session-1',
  name: 'Question session',
  order: 0,
  created_at: 1,
  updated_at: 1,
  messages: [
    {
      id: 'message-1',
      session_id: 'session-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      tool_calls: [
        {
          id: 'question-1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Continue?',
                multiSelect: false,
                options: [{ label: 'Yes' }, { label: 'No' }],
              },
            ],
          },
        },
      ],
    },
  ],
}

function renderWorktreeItem() {
  render(
    <WorktreeItem
      worktree={worktree}
      projectId="project-1"
      projectPath="/tmp/project"
      defaultBranch="main"
    />
  )
}

describe('WorktreeItem question indicator', () => {
  beforeEach(() => {
    sessionMocks.sessions = [questionSession]
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
      expandedWorktreeIds: new Set(),
    })
    useChatStore.setState({
      sendingSessionIds: {},
      sessionWorktreeMap: { 'session-1': 'worktree-1' },
      activeToolCalls: {},
      answeredQuestions: {},
      waitingForInputSessionIds: {},
      reviewingSessions: {},
      executingModes: {},
      executionModes: {},
      worktreeLoadingOperations: {},
    })
  })

  it('clears the waiting indicator after the question is answered', () => {
    renderWorktreeItem()
    expect(screen.getByTestId('worktree-status')).toHaveAttribute(
      'data-status',
      'waiting'
    )

    const answers: QuestionAnswer[] = [
      { questionIndex: 0, selectedOptions: [0] },
    ]
    act(() => {
      useChatStore
        .getState()
        .markQuestionAnswered('session-1', 'question-1', answers)
    })

    expect(screen.getByTestId('worktree-status')).toHaveAttribute(
      'data-status',
      'idle'
    )
  })

  it('clears the waiting indicator after the question is skipped', () => {
    renderWorktreeItem()
    expect(screen.getByTestId('worktree-status')).toHaveAttribute(
      'data-status',
      'waiting'
    )

    act(() => {
      useChatStore
        .getState()
        .markQuestionAnswered('session-1', 'question-1', [])
    })

    expect(screen.getByTestId('worktree-status')).toHaveAttribute(
      'data-status',
      'idle'
    )
  })

  it('keeps an inactive persisted question answered after reload', () => {
    sessionMocks.sessions = [
      {
        ...questionSession,
        id: 'session-2',
        name: 'Inactive answered question',
        answered_questions: ['question-1'],
      },
    ]

    renderWorktreeItem()

    expect(screen.getByTestId('worktree-status')).toHaveAttribute(
      'data-status',
      'idle'
    )
  })
})
