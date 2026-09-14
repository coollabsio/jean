import { render, screen } from '@/test/test-utils'
import { describe, expect, it } from 'vitest'
import {
  BackendLabel,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'

describe('backend labels', () => {
  it('marks only Antigravity as beta in plain labels', () => {
    expect(getBackendPlainLabel('cursor')).toBe('Cursor')
    expect(getBackendPlainLabel('pi')).toBe('PI')
    expect(getBackendPlainLabel('commandcode')).toBe('Command Code')
    expect(getBackendPlainLabel('grok')).toBe('Grok')
    expect(getBackendPlainLabel('kimi')).toBe('Kimi Code')
    expect(getBackendPlainLabel('antigravity')).toBe('Antigravity CLI (Beta)')
  })

  it('renders the beta badge only on Antigravity', () => {
    const { rerender } = render(<BackendLabel backend="cursor" />)

    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).toBeNull()

    rerender(<BackendLabel backend="commandcode" />)

    expect(screen.getByText('Command Code')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).toBeNull()

    rerender(<BackendLabel backend="grok" />)

    expect(screen.getByText('Grok')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).toBeNull()

    rerender(<BackendLabel backend="kimi" />)

    expect(screen.getByText('Kimi Code')).toBeInTheDocument()
    expect(screen.queryByText('Beta')).toBeNull()

    rerender(<BackendLabel backend="antigravity" />)

    expect(screen.getByText('Antigravity CLI')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })
})
