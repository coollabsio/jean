import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { UsagePane } from './UsagePane'

const mocks = vi.hoisted(() => ({
  useClaudeCliStatus: vi.fn(),
  useClaudeCliAuth: vi.fn(),
  useClaudeUsage: vi.fn(),
  useCodexCliStatus: vi.fn(),
  useCodexCliAuth: vi.fn(),
  useCodexUsage: vi.fn(),
  useGrokCliStatus: vi.fn(),
  useGrokCliAuth: vi.fn(),
  useGrokUsage: vi.fn(),
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliStatus: () => mocks.useClaudeCliStatus(),
  useClaudeCliAuth: () => mocks.useClaudeCliAuth(),
  useClaudeUsage: () => mocks.useClaudeUsage(),
}))

vi.mock('@/services/codex-cli', () => ({
  useCodexCliStatus: () => mocks.useCodexCliStatus(),
  useCodexCliAuth: () => mocks.useCodexCliAuth(),
  useCodexUsage: () => mocks.useCodexUsage(),
}))

vi.mock('@/services/grok-cli', () => ({
  useGrokCliStatus: () => mocks.useGrokCliStatus(),
  useGrokCliAuth: () => mocks.useGrokCliAuth(),
  useGrokUsage: () => mocks.useGrokUsage(),
}))

function idleQuery(data: unknown = undefined) {
  return {
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }
}

describe('UsagePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useClaudeCliStatus.mockReturnValue(
      idleQuery({ installed: true, version: '1.0.0', path: '/usr/bin/claude' })
    )
    mocks.useClaudeCliAuth.mockReturnValue(
      idleQuery({ authenticated: true, error: null })
    )
    mocks.useClaudeUsage.mockReturnValue(idleQuery())
    mocks.useCodexCliStatus.mockReturnValue(
      idleQuery({ installed: true, version: '1.0.0', path: '/usr/bin/codex' })
    )
    mocks.useCodexCliAuth.mockReturnValue(
      idleQuery({ authenticated: true, error: null })
    )
    mocks.useCodexUsage.mockReturnValue(idleQuery())
    mocks.useGrokCliStatus.mockReturnValue(
      idleQuery({ installed: true, version: '0.2.103', path: '/usr/bin/grok' })
    )
    mocks.useGrokCliAuth.mockReturnValue(
      idleQuery({ authenticated: true, error: null, timedOut: false })
    )
    mocks.useGrokUsage.mockReturnValue(idleQuery())
  })

  it('renders Claude plan summary and usage windows', () => {
    mocks.useClaudeUsage.mockReturnValue(
      idleQuery({
        planType: 'pro',
        session: {
          usedPercent: 22,
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
        },
        weekly: {
          usedPercent: 55,
          resetsAt: Math.floor(Date.now() / 1000) + 86_400,
        },
        sonnetWeekly: {
          usedPercent: 10,
          resetsAt: Math.floor(Date.now() / 1000) + 86_400,
        },
        extraUsageSpent: 1.5,
        extraUsageLimit: 50,
        fetchedAt: Math.floor(Date.now() / 1000) - 30,
      })
    )

    render(<UsagePane />)

    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('pro')).toBeInTheDocument()
    expect(screen.getByText('Extra: 1.5 / 50')).toBeInTheDocument()
    expect(screen.getByText('Session')).toBeInTheDocument()
    expect(screen.getByText('Sonnet')).toBeInTheDocument()
  })

  it('renders Codex plan summary and usage windows', () => {
    mocks.useCodexUsage.mockReturnValue(
      idleQuery({
        planType: 'pro',
        session: {
          usedPercent: 12.5,
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
          limitWindowSeconds: 3600,
        },
        weekly: {
          usedPercent: 40,
          resetsAt: Math.floor(Date.now() / 1000) + 86_400,
          limitWindowSeconds: 604_800,
        },
        reviews: null,
        creditsRemaining: 3,
        rateLimitReachedType: null,
        modelLimits: [],
        fetchedAt: Math.floor(Date.now() / 1000) - 30,
      })
    )

    render(<UsagePane />)

    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Credits remaining: 3')).toBeInTheDocument()
    expect(screen.getByText('12.5%')).toBeInTheDocument()
  })

  it('hides backends that are not installed or not authenticated', () => {
    mocks.useClaudeCliStatus.mockReturnValue(
      idleQuery({ installed: false, version: null, path: null })
    )
    mocks.useClaudeCliAuth.mockReturnValue(
      idleQuery({ authenticated: false, error: null })
    )
    mocks.useCodexCliAuth.mockReturnValue(
      idleQuery({ authenticated: false, error: null })
    )
    mocks.useGrokUsage.mockReturnValue(
      idleQuery({
        planType: 'X Premium+',
        session: { usedPercent: 10, resetsAt: null, limitWindowSeconds: null },
        weekly: { usedPercent: 20, resetsAt: null, limitWindowSeconds: null },
        products: [],
        frequentUsed: null,
        frequentLimit: null,
        occasionalUsed: null,
        occasionalLimit: null,
        hasGrokCodeAccess: true,
        periodStart: null,
        periodEnd: null,
        fetchedAt: Math.floor(Date.now() / 1000),
      })
    )

    render(<UsagePane />)

    expect(screen.queryByText('Claude')).not.toBeInTheDocument()
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    expect(screen.queryByText(/not authenticated/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/not installed/i)).not.toBeInTheDocument()
    expect(screen.getByText('Grok')).toBeInTheDocument()
    expect(screen.getByText('X Premium+')).toBeInTheDocument()
  })

  it('shows empty guidance when no ready backends exist', () => {
    mocks.useClaudeCliStatus.mockReturnValue(
      idleQuery({ installed: false, version: null, path: null })
    )
    mocks.useClaudeCliAuth.mockReturnValue(
      idleQuery({ authenticated: false, error: null })
    )
    mocks.useCodexCliStatus.mockReturnValue(
      idleQuery({ installed: false, version: null, path: null })
    )
    mocks.useCodexCliAuth.mockReturnValue(
      idleQuery({ authenticated: false, error: null })
    )
    mocks.useGrokCliStatus.mockReturnValue(
      idleQuery({ installed: false, version: null, path: null })
    )
    mocks.useGrokCliAuth.mockReturnValue(
      idleQuery({ authenticated: false, error: null, timedOut: false })
    )

    render(<UsagePane />)

    expect(
      screen.getByText(/No AI backends with usage are installed and signed in/i)
    ).toBeInTheDocument()
    expect(screen.queryByText('Claude')).not.toBeInTheDocument()
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    expect(screen.queryByText('Grok')).not.toBeInTheDocument()
  })

  it('renders Grok build and weekly usage', () => {
    mocks.useGrokUsage.mockReturnValue(
      idleQuery({
        planType: 'X Premium+',
        session: {
          usedPercent: 68,
          resetsAt: Math.floor(Date.now() / 1000) + 86_400,
          limitWindowSeconds: null,
        },
        weekly: {
          usedPercent: 72,
          resetsAt: Math.floor(Date.now() / 1000) + 86_400,
          limitWindowSeconds: null,
        },
        products: [
          { product: 'GrokBuild', usedPercent: 68 },
          { product: 'GrokChat', usedPercent: 4 },
        ],
        frequentUsed: 1,
        frequentLimit: 10,
        occasionalUsed: 2,
        occasionalLimit: 30,
        hasGrokCodeAccess: true,
        periodStart: '2026-07-13T06:53:23Z',
        periodEnd: '2026-07-20T06:53:23Z',
        fetchedAt: Math.floor(Date.now() / 1000),
      })
    )

    render(<UsagePane />)

    expect(screen.getByText('Grok')).toBeInTheDocument()
    expect(screen.getByText('X Premium+')).toBeInTheDocument()
    expect(screen.getByText('Grok Build')).toBeInTheDocument()
    expect(screen.getByText('Weekly credits')).toBeInTheDocument()
    expect(screen.getByText('Grok Code access: Yes')).toBeInTheDocument()
    expect(screen.getByText(/Frequent: 1 \/ 10/)).toBeInTheDocument()
  })

  it('retries Claude usage on error', async () => {
    const user = userEvent.setup()
    const refetch = vi.fn()
    mocks.useClaudeUsage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: true,
      error: new Error('network down'),
      refetch,
    })

    render(<UsagePane />)

    expect(screen.getByText('network down')).toBeInTheDocument()
    const retryButton = screen.getByRole('button', { name: /Retry/i })
    await user.click(retryButton)
    expect(refetch).toHaveBeenCalled()
  })
})
