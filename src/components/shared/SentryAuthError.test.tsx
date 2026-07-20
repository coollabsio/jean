import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SentryAuthError } from './SentryAuthError'

describe('SentryAuthError', () => {
  it('renders a native Tauri string rejection without crashing', () => {
    render(
      <SentryAuthError
        projectId="project-1"
        error="Sentry auth token is invalid or missing the org:read scope."
      />
    )

    expect(
      screen.getByRole('button', { name: 'Open Integrations' })
    ).toBeInTheDocument()
  })
})
