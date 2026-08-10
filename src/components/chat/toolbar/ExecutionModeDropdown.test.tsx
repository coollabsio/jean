import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ExecutionModeDropdown } from './ExecutionModeDropdown'

describe('ExecutionModeDropdown', () => {
  it.each([
    ['plan', 'Plan'],
    ['build', 'Build'],
    ['auto', 'Auto'],
    ['yolo', 'Yolo'],
  ] as const)('shows %s label in the trigger', (mode, label) => {
    render(
      <ExecutionModeDropdown
        executionMode={mode}
        onSetExecutionMode={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })
    ).toBeInTheDocument()
  })

  it('keeps mode options selectable from the dropdown', async () => {
    const user = userEvent.setup()
    const onSetExecutionMode = vi.fn()

    render(
      <ExecutionModeDropdown
        executionMode="plan"
        onSetExecutionMode={onSetExecutionMode}
      />
    )

    await user.click(screen.getByRole('button', { name: /^plan$/i }))
    await user.click(
      await screen.findByRole('menuitemradio', { name: /build/i })
    )

    expect(onSetExecutionMode).toHaveBeenCalledWith('build')
  })

  it('only lists the modes the backend supports', async () => {
    const user = userEvent.setup()

    render(
      <ExecutionModeDropdown
        executionMode="plan"
        availableModes={['plan', 'build', 'yolo']}
        onSetExecutionMode={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /^plan$/i }))

    expect(
      await screen.findByRole('menuitemradio', { name: /build/i })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitemradio', { name: /^Auto Safety-checked$/ })
    ).not.toBeInTheDocument()
  })
})
