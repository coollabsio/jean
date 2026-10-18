import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubAgent } from '@/types/chat'
import { AgentWidget } from './AgentWidget'

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

function agent(overrides: Partial<SubAgent>): SubAgent {
  return {
    id: 'agent-1',
    prompt: 'Explore the code',
    status: 'in_progress',
    label: 'Explore',
    toolCount: 3,
    ...overrides,
  }
}

describe('AgentWidget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks the elapsed time of a running agent', () => {
    render(<AgentWidget agents={[agent({ id: 'tick-agent' })]} open />)
    expect(screen.getByText('3 tools')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(screen.getByText('3 tools • 2s')).toBeInTheDocument()
  })

  it('freezes the elapsed time when the agent finishes', () => {
    const running = agent({ id: 'done-agent' })
    const { rerender } = render(<AgentWidget agents={[running]} open />)

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    rerender(
      <AgentWidget agents={[{ ...running, status: 'completed' }]} open />
    )
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(screen.getByText('3 tools • 3s')).toBeInTheDocument()
  })

  it('prefers the CLI-reported duration once done', () => {
    render(
      <AgentWidget
        agents={[
          agent({ id: 'cli-agent', status: 'completed', durationMs: 75_000 }),
        ]}
        open
      />
    )

    expect(screen.getByText('3 tools • 1m 15s')).toBeInTheDocument()
  })
})
