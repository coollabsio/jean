/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { SetupScriptOutput } from './SetupScriptOutput'

const result = {
  success: true,
  worktreeName: 'a-worktree-name-that-is-wider-than-a-mobile-viewport',
  worktreePath: '/tmp/worktree',
  script: 'bun install',
  output: 'Done',
}

describe('SetupScriptOutput', () => {
  it('shrinks the status text and keeps the dismiss button visible', async () => {
    const onDismiss = vi.fn()
    render(<SetupScriptOutput result={result} onDismiss={onDismiss} />)

    const dismissButton = screen.getByRole('button', {
      name: 'Dismiss setup script status',
    })
    const statusTrigger = screen.getByText(
      `Setup script completed for ${result.worktreeName}`
    ).parentElement

    expect(statusTrigger).toHaveClass('min-w-0', 'flex-1')
    expect(dismissButton).toHaveClass('shrink-0')

    await userEvent.click(dismissButton)
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
