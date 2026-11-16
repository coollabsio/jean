import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { SessionUsageChip, contextTokenCount } from './SessionUsageChip'

const usage = {
  input_tokens: 12_000,
  output_tokens: 3_000,
  cache_read_input_tokens: 150_000,
  cache_creation_input_tokens: 18_000,
}

describe('SessionUsageChip', () => {
  it('treats input plus cache tokens as the context size', () => {
    expect(contextTokenCount(usage)).toBe(180_000)
    expect(contextTokenCount(null)).toBe(0)
  })

  it('shows the last turn context size', () => {
    render(<SessionUsageChip latest={usage} total={usage} />)

    expect(screen.getByText('180.0k ctx')).toBeInTheDocument()
    expect(screen.getByLabelText('Context 180.0k tokens')).toBeInTheDocument()
  })

  it('stays hidden until a run reports usage', () => {
    const { container } = render(
      <SessionUsageChip latest={null} total={null} />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('stays hidden when a run reported zero context', () => {
    const { container } = render(
      <SessionUsageChip
        latest={{
          input_tokens: 0,
          output_tokens: 12,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }}
        total={usage}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
