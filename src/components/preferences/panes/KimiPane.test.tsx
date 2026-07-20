import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { KimiPane } from './KimiPane'

vi.mock('./GeneralPane', () => ({
  GeneralPane: ({ scope }: { scope?: string }) => (
    <div data-testid="kimi-general-pane">{scope}</div>
  ),
}))

describe('KimiPane', () => {
  it('renders GeneralPane with the kimi scope', () => {
    render(<KimiPane />)

    expect(screen.getByTestId('kimi-general-pane')).toHaveTextContent('kimi')
  })
})
