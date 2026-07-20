import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { DockBurgerButton } from './DockBurgerButton'

const environment = vi.hoisted(() => ({ mobile: false }))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => environment.mobile,
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliStatus: () => ({ data: { installed: false } }),
  useClaudeCliAuth: () => ({ data: { authenticated: false } }),
  useClaudeUsage: () => ({ data: undefined }),
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
})
