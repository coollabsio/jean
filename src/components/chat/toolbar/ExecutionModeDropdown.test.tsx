import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ExecutionModeDropdown } from './ExecutionModeDropdown'

describe('ExecutionModeDropdown', () => {
  it.each([
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

  it('shows Plan as the workflow while planning', () => {
    render(
      <ExecutionModeDropdown executionMode="plan" onSetExecutionMode={vi.fn()} />
    )

    expect(
      screen.getByRole('button', { name: 'Workflow: Plan' })
    ).toBeInTheDocument()
  })

  it('enters Plan from the mode menu', async () => {
    const user = userEvent.setup()
    const onSetExecutionMode = vi.fn()

    render(
      <ExecutionModeDropdown
        executionMode="yolo"
        onSetExecutionMode={onSetExecutionMode}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Permissions: Full access' }))
    await user.click(screen.getByRole('menuitemradio', { name: /^Plan/ }))
    expect(onSetExecutionMode).toHaveBeenCalledWith('plan')
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

    await user.click(screen.getByRole('button', { name: 'Workflow: Plan' }))
    await user.click(screen.getByRole('menuitemradio', { name: /Supervised/ }))
    expect(onSetExecutionMode).toHaveBeenCalledWith('supervised')
  })
})
