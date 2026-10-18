import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { DockBurgerButton } from './DockBurgerButton'

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

describe('DockBurgerButton', () => {
  it('hides MCP Servers on mobile', async () => {
    environment.mobile = true
    const user = userEvent.setup()
    render(<DockBurgerButton />)

    await user.click(screen.getByRole('button', { name: /menu/i }))

    expect(screen.queryByRole('menuitem', { name: /mcp servers/i })).toBeNull()
  })

  it('hides MCP Servers on desktop', async () => {
    const user = userEvent.setup()
    render(<DockBurgerButton />)

    await user.click(screen.getByRole('button', { name: /menu/i }))

    expect(screen.queryByRole('menuitem', { name: /mcp servers/i })).toBeNull()
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
    render(<DockBurgerButton />)

    await user.click(screen.getByRole('button', { name: /menu/i }))

    expect(screen.getByText('· Max 5x')).toBeInTheDocument()
    expect(screen.getByText('9%')).toBeInTheDocument()
    expect(screen.getByText('11%')).toBeInTheDocument()
    expect(screen.getByText('resets in 4h')).toBeInTheDocument()
    expect(screen.getByText('resets in 3d 11h')).toBeInTheDocument()
  })
})
