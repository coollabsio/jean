import { render, screen } from '@/test/test-utils'
import { describe, expect, it } from 'vitest'
import {
  BackendLabel,
  getBackendIcon,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'

describe('backend labels', () => {
  it('uses the Devin icon for Devin backends', () => {
    expect(getBackendIcon('devin').displayName).toBe('DevinIcon')
  })

  it('marks only Devin and Antigravity as beta in plain labels', () => {
    expect(getBackendPlainLabel('cursor')).toBe('Cursor')
    expect(getBackendPlainLabel('pi')).toBe('PI')
    expect(getBackendPlainLabel('commandcode')).toBe('Command Code')
    expect(getBackendPlainLabel('grok')).toBe('Grok')
    expect(getBackendPlainLabel('kimi')).toBe('Kimi Code')
    expect(getBackendPlainLabel('antigravity')).toBe('Antigravity CLI (Beta)')
    expect(getBackendPlainLabel('devin')).toBe('Devin (Beta)')
  })

  it('renders the beta badge only on Devin and Antigravity', () => {
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

    rerender(<BackendLabel backend="devin" />)

    expect(screen.getByText('Devin')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })
})
