import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { WorktreeDropdownMenu } from './WorktreeDropdownMenu'
import type { Worktree } from '@/types/projects'
import type * as EnvironmentModule from '@/lib/environment'

const envMocks = vi.hoisted(() => ({
  isNativeApp: false,
  isLocalBackend: false,
  canOpenNativeApps: false,
  canOpenInEditor: false,
  isMobile: true,
}))

const actionMocks = vi.hoisted(() => ({
  handleRun: vi.fn(),
  handleRunCommand: vi.fn(),
  runScripts: ['bun run dev'] as string[],
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => envMocks.isNativeApp,
  isLocalBackend: () => envMocks.isLocalBackend,
  canOpenNativeApps: () => envMocks.canOpenNativeApps,
  canOpenInEditor: () => envMocks.canOpenInEditor,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => envMocks.isMobile,
}))

vi.mock('@/services/gh-cli', () => ({
  ghCliQueryKeys: { auth: () => ['gh-cli', 'auth'] },
  useGhCliAuth: () => ({}),
}))

vi.mock('@/services/github', () => ({
  useDependabotAlerts: () => ({ data: [] }),
  useGitHubIssues: () => ({ data: { totalCount: 0 } }),
  useGitHubPRs: () => ({ data: [] }),
  useRepositoryAdvisories: () => ({ data: [] }),
  useWorkflowRuns: () => ({ data: { runs: [], failedCount: 0 } }),
}))

vi.mock('./useWorktreeMenuActions', () => ({
  useWorktreeMenuActions: () => ({
    showDeleteConfirm: false,
    setShowDeleteConfirm: vi.fn(),
    isBase: false,
    runScripts: actionMocks.runScripts,
    preferences: {},
    handleRun: actionMocks.handleRun,
    handleRunCommand: actionMocks.handleRunCommand,
    handleOpenInFinder: vi.fn(),
    handleOpenInTerminal: vi.fn(),
    handleOpenInEditor: vi.fn(),
    handleArchiveOrClose: vi.fn(),
    handleDelete: vi.fn(),
  }),
}))

const worktree: Worktree = {
  id: 'wt-1',
  name: 'feature',
  path: '/tmp/project/feature',
  branch: 'feature',
  base_branch: 'main',
  project_id: 'project-1',
  created_at: 1767225600000,
  order: 0,
}

describe('WorktreeDropdownMenu', () => {
  beforeEach(() => {
    envMocks.isNativeApp = false
    envMocks.isLocalBackend = false
    envMocks.canOpenNativeApps = false
    envMocks.canOpenInEditor = false
    envMocks.isMobile = true
    actionMocks.runScripts = ['bun run dev']
    actionMocks.handleRun.mockClear()
    actionMocks.handleRunCommand.mockClear()
  })

  it('hides the jean.json run command in mobile web access', async () => {
    const user = userEvent.setup()

    render(
      <WorktreeDropdownMenu
        worktree={worktree}
        projectId="project-1"
        projectPath="/tmp/project"
      />
    )

    await user.click(screen.getByRole('button'))

    expect(screen.queryByRole('menuitem', { name: /run/i })).toBeNull()
    expect(actionMocks.handleRun).not.toHaveBeenCalled()
  })

  it('hides open-in editor/terminal/finder on remote connections without native open', async () => {
    const user = userEvent.setup()
    envMocks.isNativeApp = true
    envMocks.isLocalBackend = false
    envMocks.canOpenNativeApps = false
    envMocks.canOpenInEditor = false
    envMocks.isMobile = false

    render(
      <WorktreeDropdownMenu
        worktree={worktree}
        projectId="project-1"
        projectPath="/tmp/project"
      />
    )

    await user.click(screen.getByRole('button'))

    expect(screen.queryByRole('menuitem', { name: /open in/i })).toBeNull()
  })

  it('shows open-in editor when the native shell can open remote paths in Zed', async () => {
    const user = userEvent.setup()
    envMocks.isNativeApp = true
    envMocks.isLocalBackend = false
    envMocks.canOpenNativeApps = false
    envMocks.canOpenInEditor = true
    envMocks.isMobile = false

    render(
      <WorktreeDropdownMenu
        worktree={worktree}
        projectId="project-1"
        projectPath="/tmp/project"
      />
    )

    await user.click(screen.getByRole('button'))

    expect(
      screen.getByRole('menuitem', { name: /open in/i })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: /finder/i })
    ).toBeNull()
  })

  it('shows open-in editor/terminal/finder when the remote backend allows native open', async () => {
    const user = userEvent.setup()
    envMocks.isNativeApp = true
    envMocks.isLocalBackend = false
    envMocks.canOpenNativeApps = true
    envMocks.canOpenInEditor = true
    envMocks.isMobile = false

    render(
      <WorktreeDropdownMenu
        worktree={worktree}
        projectId="project-1"
        projectPath="/tmp/project"
      />
    )

    await user.click(screen.getByRole('button'))

    const openItems = screen.getAllByRole('menuitem', { name: /open in/i })
    expect(openItems.length).toBeGreaterThanOrEqual(1)
  })
})
