import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UsagePane } from './UsagePane'

const codexRefetch = vi.fn()
const rtkRefetch = vi.fn()

const codexStatusMock = vi.fn()
const codexAuthMock = vi.fn()
const codexUsageMock = vi.fn()
const rtkGainMock = vi.fn()
const preferencesMock = vi.fn()

vi.mock('@/services/codex-cli', () => ({
  useCodexCliStatus: () => codexStatusMock(),
  useCodexCliAuth: () => codexAuthMock(),
  useCodexUsage: () => codexUsageMock(),
}))

vi.mock('@/services/rtk', () => ({
  useRtkGain: () => rtkGainMock(),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => preferencesMock(),
}))

describe('UsagePane', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    codexStatusMock.mockReturnValue({
      data: { installed: true },
    })
    preferencesMock.mockReturnValue({
      data: { rtk_ai_enabled: true },
    })
    codexAuthMock.mockReturnValue({
      isLoading: false,
      isFetching: false,
      data: { authenticated: true },
    })
    codexUsageMock.mockReturnValue({
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: codexRefetch,
      data: {
        planType: 'Pro',
        session: { usedPercent: 25, resetsAt: null },
        weekly: null,
        reviews: null,
        creditsRemaining: 12,
        modelLimits: [],
        fetchedAt: 1710000000,
      },
    })
    rtkGainMock.mockReturnValue({
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: rtkRefetch,
      data: {
        summary: {
          totalCommands: 42,
          totalInput: 12000,
          totalOutput: 3000,
          totalSaved: 9000,
          avgSavingsPct: 75.5,
          totalTimeMs: 123456,
          avgTimeMs: 2939,
        },
        daily: [
          {
            label: '2026-03-14',
            commands: 10,
            input: 5000,
            output: 1000,
            saved: 4000,
            savingsPct: 80,
            timeMs: 25000,
          },
        ],
        weekly: [],
        monthly: [],
        fetchedAt: 1710000000,
      },
    })
  })

  it('renders RTK summary metrics and periods', () => {
    render(<UsagePane />)

    expect(screen.getByText('RTK')).toBeInTheDocument()
    expect(screen.getByText('Tokens Saved')).toBeInTheDocument()
    expect(screen.getByText('9,000')).toBeInTheDocument()
    expect(screen.getByText('Average Reduction')).toBeInTheDocument()
    expect(screen.getByText('75.5%')).toBeInTheDocument()
    expect(screen.getByText('Commands Rewritten')).toBeInTheDocument()
    expect(screen.getByText('Daily')).toBeInTheDocument()
    expect(screen.getByText('2026-03-14')).toBeInTheDocument()
  })

  it('retries RTK gain fetch when loading fails', async () => {
    const user = userEvent.setup()
    rtkGainMock.mockReturnValue({
      isLoading: false,
      isFetching: false,
      isError: true,
      error: new Error('rtk unavailable'),
      refetch: rtkRefetch,
      data: undefined,
    })

    render(<UsagePane />)

    expect(screen.getByText('rtk unavailable')).toBeInTheDocument()
    const retryButtons = screen.getAllByRole('button', { name: /retry/i })
    await user.click(retryButtons[0]!)

    expect(rtkRefetch).toHaveBeenCalledTimes(1)
  })

  it('shows an empty state when RTK has no recorded commands', () => {
    rtkGainMock.mockReturnValue({
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: rtkRefetch,
      data: {
        summary: {
          totalCommands: 0,
          totalInput: 0,
          totalOutput: 0,
          totalSaved: 0,
          avgSavingsPct: 0,
          totalTimeMs: 0,
          avgTimeMs: 0,
        },
        daily: [],
        weekly: [],
        monthly: [],
        fetchedAt: 1710000000,
      },
    })

    render(<UsagePane />)

    expect(screen.getByText('No RTK savings yet')).toBeInTheDocument()
  })

  it('hides RTK usage when global RTK is disabled', () => {
    preferencesMock.mockReturnValue({
      data: { rtk_ai_enabled: false },
    })

    render(<UsagePane />)

    expect(screen.queryByText('Tokens Saved')).not.toBeInTheDocument()
    expect(screen.queryByText('RTK')).not.toBeInTheDocument()
  })
})
