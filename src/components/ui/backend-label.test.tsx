import { render, screen } from '@/test/test-utils'
import { describe, expect, it } from 'vitest'
import {
  BackendLabel,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'

describe('backend labels', () => {
  it('marks Command Code, Grok, and Kimi as beta, not Cursor, in plain labels', () => {
    expect(getBackendPlainLabel('cursor')).toBe('Cursor')
    expect(getBackendPlainLabel('commandcode')).toBe('Command Code (Beta)')
    expect(getBackendPlainLabel('grok')).toBe('Grok (Beta)')
    expect(getBackendPlainLabel('kimi')).toBe('Kimi Code (Beta)')
  })

  it('renders the beta badge on Command Code and Grok, not Cursor', () => {
    const { rerender } = render(<BackendLabel backend="cursor" />)

    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).toBeNull()

    rerender(<BackendLabel backend="commandcode" />)

    expect(screen.getByText('Command Code')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()

    rerender(<BackendLabel backend="grok" />)

    expect(screen.getByText('Grok')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()

    rerender(<BackendLabel backend="kimi" />)

    expect(screen.getByText('Kimi Code')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })
})
