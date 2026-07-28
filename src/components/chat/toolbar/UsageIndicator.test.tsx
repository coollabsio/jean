import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act } from 'react'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { UsageIndicator } from './UsageIndicator'

const openPreferencesPane = vi.fn()

vi.mock('@/store/ui-store', () => ({
  useUIStore: Object.assign(
    vi.fn(() => ({})),
    {
      getState: () => ({
        openPreferencesPane,
      }),
    }
  ),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      keybindings: { open_usage_dropdown: 'mod+u' },
    },
  }),
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliStatus: () => ({ data: { installed: true } }),
  useClaudeCliAuth: () => ({ data: { authenticated: true } }),
  useClaudeUsage: () => ({
    data: {
      planType: 'Pro',
      session: { usedPercent: 22.4, resetsAt: null },
      weekly: { usedPercent: 55.1, resetsAt: null },
    },
  }),
}))

vi.mock('@/services/codex-cli', () => ({
  useCodexCliStatus: () => ({ data: { installed: true } }),
  useCodexCliAuth: () => ({ data: { authenticated: true } }),
  useCodexUsage: () => ({
    data: {
      planType: 'Plus',
      session: { usedPercent: 10, resetsAt: null },
      weekly: { usedPercent: 80, resetsAt: null },
    },
  }),
}))

vi.mock('@/services/grok-cli', () => ({
  useGrokCliStatus: () => ({ data: { installed: false } }),
  useGrokCliAuth: () => ({ data: { authenticated: false } }),
  useGrokUsage: () => ({ data: undefined }),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => true,
  isTauri: () => true,
}))

describe('UsageIndicator', () => {
  beforeEach(() => {
    openPreferencesPane.mockClear()
  })

  it('shows session|weekly for the selected backend', () => {
    render(<UsageIndicator selectedBackend="claude" />)

    expect(
      screen.getByRole('button', { name: /claude usage 22\|55%/i })
    ).toBeInTheDocument()
  })

  it('prefers the selected backend over the first available entry', () => {
    render(<UsageIndicator selectedBackend="codex" />)

    expect(
      screen.getByRole('button', { name: /codex usage 10\|80%/i })
    ).toBeInTheDocument()
  })

  it('opens usage details from the dropdown', async () => {
    const user = userEvent.setup()
    render(<UsageIndicator selectedBackend="claude" />)

    await user.click(
      screen.getByRole('button', { name: /claude usage 22\|55%/i })
    )
    await user.click(
      await screen.findByRole('menuitem', { name: /open usage details/i })
    )

    expect(openPreferencesPane).toHaveBeenCalledWith('usage')
  })

  it('toggles from the global usage menu event', async () => {
    render(<UsageIndicator selectedBackend="claude" />)

    act(() => {
      window.dispatchEvent(new CustomEvent('toggle-usage-menu'))
    })

    await waitFor(() => {
      expect(
        screen.getByRole('menuitem', { name: /open usage details/i })
      ).toBeInTheDocument()
    })
  })
})
