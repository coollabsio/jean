// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { BackendPaneHeader } from './SettingsSection'

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
})
