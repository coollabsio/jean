import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { act } from '@testing-library/react'
import { render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
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

beforeEach(() => {
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

    await user.click(screen.getByRole('button', { name: /thread details/i }))

    expect(screen.getByText('feature-x')).toBeInTheDocument()
    expect(screen.getByText('↑2')).toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: /thread details/i }))
    await user.click(screen.getByRole('menuitem', { name: '#7 Broken login' }))

    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('toggles from the quick menu shortcut event', async () => {
    renderDetails()

    act(() => {
      window.dispatchEvent(new CustomEvent('toggle-quick-menu'))
    })

    expect(await screen.findByText('Context')).toBeInTheDocument()
  })

  it('hides MCP Servers on mobile and shows community links', async () => {
    environment.mobile = true
    const user = userEvent.setup()
    renderDetails()

    await user.click(screen.getByRole('button', { name: /thread details/i }))

    expect(screen.queryByRole('menuitem', { name: /mcp servers/i })).toBeNull()
    expect(
      screen.getByRole('menuitem', { name: /jean on github/i })
    ).toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: /thread details/i }))
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

    await user.click(screen.getByRole('button', { name: /thread details/i }))

    expect(screen.getByText('· Max 5x')).toBeInTheDocument()
    expect(screen.getByText('9%')).toBeInTheDocument()
    expect(screen.getByText('resets in 3d 11h')).toBeInTheDocument()
  })
})
