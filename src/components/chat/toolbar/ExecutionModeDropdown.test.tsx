import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ExecutionModeDropdown } from './ExecutionModeDropdown'

describe('ExecutionModeDropdown', () => {
  it.each([
    ['plan', 'Full access'],
    ['build', 'Auto-accept edits'],
    ['yolo', 'Full access'],
  ] as const)('shows %s label in the trigger', (mode, label) => {
    render(
      <ExecutionModeDropdown
        executionMode={mode}
        onSetExecutionMode={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: new RegExp(`^Permissions: ${label}$`, 'i') })
    ).toBeInTheDocument()
  })

  it('leaves Plan when a permission is selected', async () => {
    const user = userEvent.setup()
    const onSetExecutionMode = vi.fn()

    render(
      <ExecutionModeDropdown
        executionMode="plan"
        onSetExecutionMode={onSetExecutionMode}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Permissions: Full access' }))
    await user.click(screen.getByRole('menuitemradio', { name: /Supervised/ }))
    expect(onSetExecutionMode).toHaveBeenCalledWith('supervised')
  })
})
