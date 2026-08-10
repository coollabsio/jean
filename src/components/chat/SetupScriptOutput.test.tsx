import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SetupScriptOutput } from './SetupScriptOutput'

const baseResult = {
  worktreeName: 'calm-otter',
  worktreePath: '/tmp/calm-otter',
  script: 'bun install',
  output: 'packages installed',
}

describe('SetupScriptOutput', () => {
  it('keeps successful setup quiet and details collapsed', () => {
    render(
      <SetupScriptOutput
        result={{ ...baseResult, success: true }}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getByText('Workspace ready')).toBeVisible()
    expect(screen.getByText(/project setup completed/i)).toBeVisible()
    expect(screen.queryByText('packages installed')).toBeNull()
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull()
  })

  it('explains a failed setup, expands its output, and remains dismissible', () => {
    const onDismiss = vi.fn()
    render(
      <SetupScriptOutput
        result={{ ...baseResult, success: false, output: 'exit code 42' }}
        onDismiss={onDismiss}
      />
    )

    expect(screen.getByText('Workspace setup failed')).toBeVisible()
    expect(
      screen.getByText(
        /conversation can continue, but the workspace may be incomplete/i
      )
    ).toBeVisible()
    expect(screen.getByText('exit code 42')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
