import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ReasoningLevelDropdown } from './ReasoningLevelDropdown'

const OPTIONS = [
  { value: 'low', label: 'Low', description: 'Fast' },
  { value: 'high', label: 'High', description: 'Deep' },
  { value: 'think', label: 'Think', tokens: '4K' },
]

describe('ReasoningLevelDropdown', () => {
  it('shows the selected label and picks another level', async () => {
    const onValueChange = vi.fn()
    render(
      <ReasoningLevelDropdown
        value="low"
        options={OPTIONS}
        onValueChange={onValueChange}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Low' }))
    expect(
      screen.getByRole('menuitemradio', { name: /Think4K/ })
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitemradio', { name: /^High/ }))
    expect(onValueChange).toHaveBeenCalledWith('high')
  })

  it('prefixes the label in forms and hides shortcut hints by default', async () => {
    render(
      <ReasoningLevelDropdown
        label="Effort"
        showLabel
        value="high"
        options={OPTIONS}
        onValueChange={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Effort: High' })
    expect(trigger).toHaveTextContent('EffortHigh')
    await userEvent.click(trigger)
    expect(screen.queryByText('1')).toBeNull()
  })

  it('numbers the options for the toolbar shortcuts', async () => {
    render(
      <ReasoningLevelDropdown
        value="low"
        options={OPTIONS}
        onValueChange={vi.fn()}
        showShortcuts
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Low' }))
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})
