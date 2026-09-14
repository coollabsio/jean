// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { BackendPaneHeader, SettingsSection } from './SettingsSection'

describe('SettingsSection', () => {
  it('renders the Antigravity-style section layout used by backend panes', () => {
    const { container } = render(
      <SettingsSection title="Default model" anchorId="model" variant="card">
        <span>Model picker</span>
      </SettingsSection>
    )

    expect(container.querySelector('#model')).toHaveClass(
      '[&_.settings-inline-field]:rounded-lg',
      '[&_.settings-inline-field]:border',
      '[&_.settings-inline-field]:p-4'
    )
    expect(container.querySelector('[data-slot="separator"]')).not.toBeNull()
  })

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
})
