import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { BackendUsageLimits } from './BackendUsageLimits'

describe('BackendUsageLimits', () => {
  it('shows Codex five-hour and seven-day remaining limits', () => {
    const fetchedAt = Date.parse('2026-06-18T12:00:00Z') / 1000

    render(
      <BackendUsageLimits
        backend="codex"
        className="flex"
        usage={{
          session: {
            usedPercent: 42,
            resetsAt: fetchedAt + 60 * 60,
            limitWindowSeconds: 60 * 60 * 5,
          },
          weekly: {
            usedPercent: 17.2,
            resetsAt: fetchedAt + 60 * 60 * 24 * 3,
            limitWindowSeconds: 60 * 60 * 24 * 7,
          },
          fetchedAt,
        }}
      />
    )

    expect(screen.getByText('5h')).toBeInTheDocument()
    expect(screen.getByText('58%')).toBeInTheDocument()
    expect(screen.getByText('7d')).toBeInTheDocument()
    expect(screen.getByText('83%')).toBeInTheDocument()
    expect(
      screen.getByRole('status', {
        name: /Codex limits: 5h 58% remaining/i,
      })
    ).toBeInTheDocument()
  })

  it('uses the same compact labels for Claude limits', () => {
    render(
      <BackendUsageLimits
        backend="claude"
        className="flex"
        usage={{
          session: { usedPercent: 5, resetsAt: null },
          weekly: { usedPercent: 99.6, resetsAt: null },
          fetchedAt: Date.parse('2026-06-18T12:00:00Z') / 1000,
        }}
      />
    )

    expect(screen.getByText('5h')).toBeInTheDocument()
    expect(screen.getByText('95%')).toBeInTheDocument()
    expect(screen.getByText('7d')).toBeInTheDocument()
    expect(screen.getByText('<1%')).toBeInTheDocument()
    expect(
      screen.getByRole('status', {
        name: /Claude limits: 5h 95% remaining/i,
      })
    ).toBeInTheDocument()
  })

  it('keeps an error visible instead of silently hiding the limits', () => {
    render(
      <BackendUsageLimits
        backend="codex"
        className="flex"
        error={new Error('usage unavailable')}
      />
    )

    expect(screen.getByText('limits failed')).toBeInTheDocument()
    expect(
      screen.getByRole('status', {
        name: /Codex limits failed: usage unavailable/i,
      })
    ).toBeInTheDocument()
  })
})
