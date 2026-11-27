import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { act } from '@testing-library/react'
import { render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import type * as PlatformModule from '@/lib/platform'
import { ThreadDetailsButton } from './ThreadDetailsButton'

const environment = vi.hoisted(() => ({
  mobile: false,
  claudeReady: false,
  claudeUsage: undefined as unknown,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => environment.mobile,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliStatus: () => ({
    data: { installed: environment.claudeReady },
  }),
  useClaudeCliAuth: () => ({
    data: { authenticated: environment.claudeReady },
  }),
  useClaudeUsage: () => ({ data: environment.claudeUsage }),
}))
vi.mock('@/services/codex-cli', () => ({
  useCodexCliStatus: () => ({ data: { installed: false } }),
  useCodexCliAuth: () => ({ data: { authenticated: false } }),
  useCodexUsage: () => ({ data: undefined }),
}))
vi.mock('@/services/grok-cli', () => ({
  useGrokCliStatus: () => ({ data: { installed: false } }),
  useGrokCliAuth: () => ({ data: { authenticated: false } }),
  useGrokUsage: () => ({ data: undefined }),
}))

const platform = vi.hoisted(() => ({ openExternal: vi.fn() }))
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof PlatformModule>()),
  openExternal: platform.openExternal,
}))

beforeEach(() => {
  platform.openExternal.mockClear()
  environment.mobile = false
  environment.claudeReady = false
  environment.claudeUsage = undefined
})
const git = vi.hoisted(() => ({
  status: undefined as unknown,
}))

vi.mock('@/services/projects', () => ({
  useWorktree: () => ({
    data: { id: 'wt-1', session_type: 'worktree', branch: 'feature-x' },
  }),
}))
vi.mock('@/services/git-status', () => ({
  useGitStatus: () => ({ data: git.status }),
}))

const server = (name: string, disabled = false) => ({
  name,
  config: {},
  scope: 'user' as const,
  disabled,
  backend: 'claude',
})

function renderDetails(
  props: Partial<React.ComponentProps<typeof ThreadDetailsButton>> = {}
) {
  return render(
    <ThreadDetailsButton
      worktreeId="wt-1"
      contexts={[]}
      availableMcpServers={[]}
      enabledMcpServers={[]}
      onManageContexts={() => undefined}
      {...props}
    />
  )
}

describe('ThreadDetailsButton', () => {
  beforeEach(() => {
    git.status = {
      current_branch: 'feature-x',
      base_branch: 'main',
      ahead_count: 2,
      behind_count: 0,
      uncommitted_added: 5,
      uncommitted_removed: 1,
      branch_diff_added: 40,
      branch_diff_removed: 3,
    }
  })

  it('shows branch and diff counts, and opens the diff on click', async () => {
    const user = userEvent.setup()
    const onDiff = vi.fn()
    window.addEventListener('open-git-diff', onDiff)
    renderDetails()

    await user.click(screen.getByRole('button', { name: /^details/i }))

    expect(screen.getByText('feature-x')).toBeInTheDocument()
    expect(screen.getByText('↑ 2')).toBeInTheDocument()
    const uncommitted = screen.getByRole('menuitem', { name: /uncommitted/i })
    expect(uncommitted).toHaveTextContent('+5 −1')
    expect(
      screen.getByRole('menuitem', { name: /vs main/i })
    ).toHaveTextContent('+40 −3')

    await user.click(uncommitted)
    expect((onDiff.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      type: 'uncommitted',
    })
    window.removeEventListener('open-git-diff', onDiff)
  })

  it('shows the linked PR with its status and opens it on click', async () => {
    const user = userEvent.setup()
    renderDetails({
      prUrl: 'https://github.com/o/r/pull/42',
      prNumber: 42,
      prDisplayStatus: 'merged',
    })

    await user.click(screen.getByRole('button', { name: /^details/i }))
    const pr = screen.getByRole('menuitem', { name: /PR #42/ })
    expect(pr).toHaveTextContent('Merged')

    await user.click(pr)
    expect(platform.openExternal).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/42'
    )
  })

  it('hides the PR row when no PR is linked', async () => {
    const user = userEvent.setup()
    renderDetails()

    await user.click(screen.getByRole('button', { name: /^details/i }))
    expect(
      screen.queryByRole('menuitem', { name: /PR #/ })
    ).not.toBeInTheDocument()
  })

  it('shows the last turn context and session token totals', async () => {
    const user = userEvent.setup()
    const usage = {
      input_tokens: 12_000,
      output_tokens: 3_000,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 18_000,
    }
    renderDetails({
      latestUsage: usage,
      totalUsage: { ...usage, input_tokens: 40_000, output_tokens: 9_000 },
    })

    await user.click(screen.getByRole('button', { name: /^details/i }))

    const tokens = screen.getByTestId('thread-details-tokens')
    // Context = input + cache read + cache write of the last turn
    expect(tokens).toHaveTextContent('Context (last turn)180.0k')
    expect(tokens).toHaveTextContent('Session40.0k in · 9.0k out')
    expect(tokens).toHaveTextContent('Cache150.0k read · 18.0k write')
  })

  it('hides token usage until a run reports context tokens', async () => {
    const user = userEvent.setup()
    renderDetails({
      latestUsage: {
        input_tokens: 0,
        output_tokens: 12,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    })

    await user.click(screen.getByRole('button', { name: /^details/i }))

    expect(screen.getByText('feature-x')).toBeInTheDocument()
    expect(
      screen.queryByTestId('thread-details-tokens')
    ).not.toBeInTheDocument()
  })

  it('marks the button with a dot only while there are uncommitted changes', () => {
    const { unmount } = renderDetails()
    expect(
      screen.getByTestId('thread-details-uncommitted-dot')
    ).toBeInTheDocument()
    unmount()

    git.status = {
      ...(git.status as object),
      uncommitted_added: 0,
      uncommitted_removed: 0,
    }
    renderDetails()
    expect(
      screen.queryByTestId('thread-details-uncommitted-dot')
    ).not.toBeInTheDocument()
  })

  it('lists attached contexts and runs their action', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderDetails({
      contexts: [
        {
          key: 'issue-7',
          label: '#7 Broken login',
          Icon: () => null,
          iconClassName: '',
          onSelect,
        },
      ],
    })

    await user.click(screen.getByRole('button', { name: /^details/i }))
    await user.click(screen.getByRole('menuitem', { name: '#7 Broken login' }))

    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('toggles from the quick menu shortcut event', async () => {
    renderDetails()

    act(() => {
      window.dispatchEvent(new CustomEvent('toggle-quick-menu'))
    })

    expect(await screen.findByText('Attach Context...')).toBeInTheDocument()
  })

  it('hides MCP Servers and community links on mobile', async () => {
    environment.mobile = true
    const user = userEvent.setup()
    renderDetails()

    await user.click(screen.getByRole('button', { name: /^details/i }))

    expect(screen.queryByRole('menuitem', { name: /mcp servers/i })).toBeNull()
    expect(
      screen.queryByRole('menuitem', { name: /jean on github|sponsor jean/i })
    ).toBeNull()
  })

  it('counts enabled MCP servers without listing them, and opens their settings pane', async () => {
    const user = userEvent.setup()
    renderDetails({
      availableMcpServers: [
        server('alpha'),
        server('beta'),
        server('off', true),
      ],
      enabledMcpServers: ['claude:alpha', 'claude:off'],
    })

    await user.click(screen.getByRole('button', { name: /^details/i }))
    const item = screen.getByRole('menuitem', { name: /mcp servers/i })
    expect(item).toHaveTextContent('1')
    expect(screen.queryByText('alpha')).toBeNull()

    await user.click(item)
    expect(useUIStore.getState().preferencesPane).toBe('mcp-servers')
  })

  it('shows plan name and reset countdowns for usage', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    environment.claudeReady = true
    environment.claudeUsage = {
      planType: 'max',
      planTier: 'default_claude_max_5x',
      session: { usedPercent: 9.4, resetsAt: nowSeconds + 4 * 3600 + 30 },
      weekly: {
        usedPercent: 10.6,
        resetsAt: nowSeconds + 3 * 86_400 + 11 * 3600 + 30,
      },
      sonnetWeekly: null,
      extraUsageSpent: null,
      extraUsageLimit: null,
      fetchedAt: nowSeconds,
    }
    const user = userEvent.setup()
    renderDetails()

    await user.click(screen.getByRole('button', { name: /^details/i }))

    expect(screen.getByText('· Max 5x')).toBeInTheDocument()
    expect(screen.getByText('9%')).toBeInTheDocument()
    expect(screen.getByText('resets in 3d 11h')).toBeInTheDocument()
  })
})
