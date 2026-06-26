import { fireEvent, render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallInline } from './ToolCallInline'
import type { ComponentProps } from 'react'
import type * as InlineFileDiffModule from './InlineFileDiff'

const inlineFileDiffProps = vi.hoisted(() => [] as Record<string, unknown>[])
type InlineFileDiffProps = ComponentProps<
  typeof InlineFileDiffModule.InlineFileDiff
>

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: undefined }),
}))

vi.mock('./InlineFileDiff', async importOriginal => {
  const actual = (await importOriginal()) as typeof InlineFileDiffModule

  return {
    ...actual,
    InlineFileDiff: (props: InlineFileDiffProps) => {
      inlineFileDiffProps.push(props as unknown as Record<string, unknown>)
      return actual.InlineFileDiff(props)
    },
  }
})

describe('ToolCallInline', () => {
  it('renders Cursor EnterPlanMode instructions', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-enter-plan-1',
          name: 'EnterPlanMode',
          input: {
            title: 'Plan mode instructions',
            instructions: [
              'Read/analyze only; do not write, edit, or create files.',
              'Do not run mutating commands.',
            ],
          },
        }}
      />
    )

    expect(screen.getByText('Entered plan mode')).toBeInTheDocument()
    expect(
      screen.getByText('Read-only analysis instructions')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('Plan mode instructions:')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Read/analyze only; do not write, edit, or create files.'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText('Do not run mutating commands.')
    ).toBeInTheDocument()
  })

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

  it('renders FileChange diffs without duplicate raw output', () => {
    const { container } = render(
      <ToolCallInline
        toolCall={{
          id: 'tool-file-change-1',
          name: 'FileChange',
          input: [
            {
              path: '/tmp/chat-store.ts',
              kind: { type: 'update', move_path: null },
              diff: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
          output:
            '[{"diff":"@@ -1 +1 @@\\n-old\\n+new","kind":{"type":"update","move_path":null},"path":"/tmp/chat-store.ts"}]',
        }}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('chat-store.ts')).toBeInTheDocument()
    expect(screen.getByText('update')).toBeInTheDocument()
    expect(inlineFileDiffProps.at(-1)).toMatchObject({
      patch: '@@ -1 +1 @@\n-old\n+new',
      filePath: '/tmp/chat-store.ts',
    })
    expect(inlineFileDiffProps.at(-1)).not.toHaveProperty('neutral')
    // <FileDiff> renders its diff inside a <diffs-container> custom element
    expect(container.querySelector('diffs-container')).not.toBeNull()
    expect(screen.queryByText('Output:')).not.toBeInTheDocument()
  })

  it('falls back to parsing legacy FileChange output when input is empty', () => {
    const { container } = render(
      <ToolCallInline
        toolCall={{
          id: 'tool-file-change-2',
          name: 'FileChange',
          input: null,
          output:
            '[{"diff":"@@ -2 +2 @@\\n-before\\n+after","kind":{"type":"update","move_path":null},"path":"/tmp/legacy.ts"}]',
        }}
      />
    )

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getAllByText('legacy.ts')).toHaveLength(2)
    expect(container.querySelector('diffs-container')).not.toBeNull()
    expect(screen.queryByText('Output:')).not.toBeInTheDocument()
  })

  it('renders image artifacts from Canva tool output', () => {
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-canva-1',
          name: 'mcp:canva:generate_design',
          input: {},
          output: JSON.stringify({
            job: {
              result: {
                generated_designs: [
                  {
                    candidate_id: 'dg-1',
                    url: 'https://www.canva.com/d/example',
                    thumbnail: {
                      url: 'https://design.canva.ai/preview-token',
                    },
                  },
                ],
              },
            },
          }),
        }}
      />
    )

    expect(screen.getByText('mcp:canva:generate_design')).toBeInTheDocument()
    expect(screen.queryByText(/unhandled tool/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button'))

    const image = screen.getByAltText('Preview')
    expect(image).toHaveAttribute('src', 'https://design.canva.ai/preview-token')
    expect(screen.getByText('Raw output:')).toBeInTheDocument()
    expect(screen.queryByText(/design\.canva\.ai\/preview-token/)).toBeNull()
  })

  it('renders local file artifacts as clickable file cards', () => {
    const onFileClick = vi.fn()
    render(
      <ToolCallInline
        toolCall={{
          id: 'tool-file-artifact-1',
          name: 'Write',
          input: {},
          output: 'Saved report to /tmp/report.pdf',
        }}
        onFileClick={onFileClick}
      />
    )

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))

    expect(onFileClick).toHaveBeenCalledWith('/tmp/report.pdf')
  })
})
