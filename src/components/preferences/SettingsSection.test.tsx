// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { BackendPaneHeader, SettingsSection } from './SettingsSection'

describe('SettingsSection', () => {
  it('renders the card layout used by backend panes', () => {
    const { container } = render(
      <SettingsSection title="Default model" anchorId="model" variant="card">
        <span>Model picker</span>
      </SettingsSection>
    )

    expect(container.querySelector('#model')).toHaveClass(
      'rounded-lg',
      'border',
      'sm:[&_.settings-inline-field]:justify-between'
    )
    expect(container.querySelector('[data-slot="separator"]')).toBeNull()
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
