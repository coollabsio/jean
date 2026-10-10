import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { Markdown } from './markdown'

vi.mock('./mermaid-block', () => ({
  MermaidBlock: ({ source }: { source: string }) => (
    <div role="img" aria-label="Mermaid diagram">
      {source}
    </div>
  ),
}))

const source = 'flowchart TD\nA["Step"] --> B["Done"]'
const fenced = `\`\`\`mermaid\n${source}\n\`\`\``

describe('Markdown Mermaid integration', () => {
  it.each([{}, { compact: true }, { variant: 'tool-call' as const }])(
    'renders fenced diagrams in shared message views %j',
    async props => {
      render(<Markdown {...props}>{fenced}</Markdown>)
      expect(
        await screen.findByRole('img', { name: 'Mermaid diagram' })
      ).toHaveTextContent('flowchart TD')
    }
  )

  it('shows streaming source until the message completes', async () => {
    const { rerender } = render(<Markdown streaming>{fenced}</Markdown>)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(/flowchart TD/)).toBeTruthy()
    rerender(<Markdown>{fenced}</Markdown>)
    expect(await screen.findByRole('img')).toBeTruthy()
  })

  it('does not transform ordinary code or unfenced text', () => {
    render(<Markdown>{`\`\`\`text\n${source}\n\`\`\`\n\n${source}`}</Markdown>)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
  })
})
