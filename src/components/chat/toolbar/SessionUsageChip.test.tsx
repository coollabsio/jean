import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import type { UsageData } from '@/types/chat'
import { getContextTokenCount, SessionUsageChip } from './SessionUsageChip'

const latestUsage: UsageData = {
  input_tokens: 30_000,
  output_tokens: 2_500,
  cache_read_input_tokens: 150_000,
  cache_creation_input_tokens: 5_000,
}

const totalUsage: UsageData = {
  input_tokens: 60_000,
  output_tokens: 8_000,
  cache_read_input_tokens: 240_000,
  cache_creation_input_tokens: 10_000,
}

describe('SessionUsageChip', () => {
  it('adds every input-side counter for the current context size', () => {
    expect(getContextTokenCount(latestUsage)).toBe(185_000)
  })

  it('stays hidden when no run has reported usage', () => {
    const { container, rerender } = render(<SessionUsageChip />)

    expect(container).toBeEmptyDOMElement()

    rerender(
      <SessionUsageChip latestUsage={{ input_tokens: 0, output_tokens: 1 }} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a compact context chip only at wide container breakpoints', () => {
    render(
      <SessionUsageChip latestUsage={latestUsage} totalUsage={totalUsage} />
    )

    const chip = screen.getByRole('status', {
      name: '185.0k context tokens',
    })
    expect(chip).toHaveTextContent('185.0k ctx')
    expect(chip).toHaveClass('hidden', '@xl:flex')
  })

  it('shows last-turn context and additive session totals in the tooltip', async () => {
    const user = userEvent.setup()
    render(
      <SessionUsageChip latestUsage={latestUsage} totalUsage={totalUsage} />
    )

    await user.hover(
      screen.getByRole('status', { name: '185.0k context tokens' })
    )

    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('Last-turn context')).toBeVisible()
    expect(within(tooltip).getByText('185.0k')).toBeVisible()
    expect(within(tooltip).getByText('Session totals')).toBeVisible()
    expect(within(tooltip).getByText('60.0k')).toBeVisible()
    expect(within(tooltip).getByText('8.0k')).toBeVisible()
    expect(within(tooltip).getByText('240.0k')).toBeVisible()
    expect(within(tooltip).getByText('10.0k')).toBeVisible()
  })

  it('falls back to latest usage when an aggregate is unavailable', async () => {
    const user = userEvent.setup()
    render(<SessionUsageChip latestUsage={latestUsage} />)

    await user.hover(
      screen.getByRole('status', { name: '185.0k context tokens' })
    )

    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('30.0k')).toBeVisible()
    expect(within(tooltip).getByText('2.5k')).toBeVisible()
    expect(within(tooltip).getByText('150.0k')).toBeVisible()
    expect(within(tooltip).getByText('5.0k')).toBeVisible()
  })
})
