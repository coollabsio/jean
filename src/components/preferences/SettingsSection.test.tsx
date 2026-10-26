// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { BackendPaneHeader, SettingsSection } from './SettingsSection'

describe('SettingsSection', () => {
  it('renders a backend pane header with its description', () => {
    render(
      <BackendPaneHeader
        backend="claude"
        description="Configure native Claude sessions."
      />
    )

    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(
      screen.getByText('Configure native Claude sessions.')
    ).toBeInTheDocument()
  })

  it('shows non-collapsible sections immediately', () => {
    render(
      <SettingsSection title="Jean MCP Server">
        <p>Required · Automatic</p>
      </SettingsSection>
    )

    expect(
      screen.queryByRole('button', { name: 'Jean MCP Server' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Required · Automatic')).toBeVisible()
  })

  it('hides collapsible section content until opened', async () => {
    const user = userEvent.setup()
    render(
      <SettingsSection title="Optional setup" collapsible defaultOpen={false}>
        <p>CLI merge instructions</p>
      </SettingsSection>
    )

    const toggle = screen.getByRole('button', { name: 'Optional setup' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const details = screen.queryByText('CLI merge instructions')
    if (details) expect(details).not.toBeVisible()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('CLI merge instructions')).toBeVisible()
  })
})
