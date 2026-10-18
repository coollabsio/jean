import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { CommitsTabView } from './CommitsTabView'
import { CheckpointsTabView } from './CheckpointsTabView'

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }))
vi.mock('@/hooks/use-theme', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))
vi.mock('./MemoizedFileDiff', () => ({
  MemoizedFileDiff: ({ fileName }: { fileName: string }) => (
    <div>{fileName}</div>
  ),
  getStatusColor: () => '',
}))
vi.mock('./CheckpointRestoreDialog', () => ({
  CheckpointRestoreDialog: () => null,
}))

const getCommitHistory = vi.fn()
const getCommitDiff = vi.fn()
vi.mock('@/services/git-status', () => ({
  getCommitHistory: (...args: unknown[]) => getCommitHistory(...args),
  getCommitDiff: (...args: unknown[]) => getCommitDiff(...args),
  getRepoBranches: vi.fn(async () => ['main']),
  triggerImmediateGitPoll: vi.fn(),
}))

const listAiCheckpoints = vi.fn()
const getAiCheckpointDiff = vi.fn()
vi.mock('@/services/checkpoints', () => ({
  checkpointQueryKeys: { worktree: (id: string) => ['checkpoints', id] },
  listAiCheckpoints: (...args: unknown[]) => listAiCheckpoints(...args),
  getAiCheckpointDiff: (...args: unknown[]) => getAiCheckpointDiff(...args),
  deleteAiCheckpoint: vi.fn(),
  restoreAiCheckpointFile: vi.fn(),
}))

describe('mobile history views', () => {
  beforeEach(() => {
    getCommitHistory.mockResolvedValue({
      commits: [
        {
          sha: 'abcdef123',
          shortSha: 'abcdef1',
          message: 'Improve mobile layout',
          authorName: 'Jean',
          authorDate: new Date().toISOString(),
          additions: 12,
          deletions: 3,
        },
      ],
      hasMore: false,
      totalCount: 1,
    })
    getCommitDiff.mockResolvedValue({
      diff_type: 'commit',
      base_ref: 'a',
      target_ref: 'b',
      total_additions: 0,
      total_deletions: 0,
      raw_patch: '',
      files: [],
    })
    listAiCheckpoints.mockResolvedValue([
      {
        id: 'cp-1',
        worktreeId: 'wt-1',
        sessionId: 'session-1',
        userMessagePreview: 'Fix the mobile navigation',
        createdAt: Date.now() / 1000,
        startCommit: 'abcdef123',
        status: 'finalized',
        filesChanged: [],
        totalAdditions: 4,
        totalDeletions: 1,
        worktreePath: '/tmp/repo',
      },
    ])
    getAiCheckpointDiff.mockResolvedValue({
      diff_type: 'commit',
      base_ref: 'a',
      target_ref: 'b',
      total_additions: 0,
      total_deletions: 0,
      raw_patch: '',
      files: [],
    })
  })

  it('opens one commit detail panel and provides a back action', async () => {
    const user = userEvent.setup()
    render(
      <CommitsTabView
        worktreePath="/tmp/repo"
        worktreeId="wt-1"
        baseBranch="main"
        diffStyle="split"
        onClose={vi.fn()}
      />
    )

    await user.click(
      await screen.findByRole('button', { name: /Improve mobile layout/i })
    )

    expect(
      screen.getByRole('button', { name: 'Back to commits' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('listbox', { name: 'Commits' })
    ).not.toBeInTheDocument()
  })

  it('opens one checkpoint detail panel and provides a back action', async () => {
    const user = userEvent.setup()
    render(
      <CheckpointsTabView
        worktreeId="wt-1"
        worktreePath="/tmp/repo"
        diffStyle="split"
      />
    )

    await user.click(
      await screen.findByRole('button', { name: /Fix the mobile navigation/i })
    )

    expect(
      screen.getByRole('button', { name: 'Back to checkpoints' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('No file changes in this checkpoint')
    ).toBeInTheDocument()
  })
})
