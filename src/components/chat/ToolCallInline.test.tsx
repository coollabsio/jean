import { fireEvent, render, screen } from '@/test/test-utils'
import { describe, expect, it } from 'vitest'
import { ToolCallInline } from './ToolCallInline'

describe('ToolCallInline', () => {
  it('renders OpenCode ToolSearch calls without the unhandled fallback', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-1',
          name: 'ToolSearch',
          input: {
            query: 'selectExitPlanMode',
            max_results: 1,
          },
        }}
      />
    )

    expect(screen.getByText('Tool Search')).toBeInTheDocument()
    expect(screen.getByText('selectExitPlanMode')).toBeInTheDocument()
    expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))

    const expandedContent = screen.getByText((_, element) =>
      Boolean(
        element?.classList.contains('whitespace-pre-wrap') &&
        element.textContent === 'Query: selectExitPlanMode\nMax results: 1'
      )
    )

    expect(expandedContent).toBeInTheDocument()
  })
})
