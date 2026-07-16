import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import { Markdown } from './markdown'

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  useSyntaxHighlighting: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: mocks.copyToClipboard,
}))

vi.mock('@/hooks/useSyntaxHighlighting', () => ({
  useSyntaxHighlighting: mocks.useSyntaxHighlighting,
}))

beforeEach(() => {
  mocks.copyToClipboard.mockReset()
  mocks.useSyntaxHighlighting.mockReset()
  mocks.useSyntaxHighlighting.mockImplementation(
    (code: string, language: string) => ({
      html: `<pre class="shiki"><code><span data-language="${language}">${code}</span></code></pre>`,
      isLoading: false,
      error: null,
    })
  )
})

describe('Markdown', () => {
  it('preserves ordered-list start attributes from parsed markdown', () => {
    const { container } = render(
      <Markdown>{'1. First\n\nInterlude\n\n2. Second'}</Markdown>
    )

    const orderedLists = Array.from(container.querySelectorAll('ol'))

    expect(orderedLists).toHaveLength(2)
    expect(orderedLists[0]?.getAttribute('start')).toBeNull()
    expect(orderedLists[1]?.getAttribute('start')).toBe('2')
  })

  it('keeps list marker gutters inside the markdown box', () => {
    const { container } = render(
      <div className="overflow-x-hidden">
        <Markdown>{'1. First\n2. Second\n\n- Bullet'}</Markdown>
      </div>
    )

    const orderedList = container.querySelector('ol')
    const unorderedList = container.querySelector('ul')

    expect(orderedList?.className).toContain('pl-6')
    expect(orderedList?.className).not.toContain('ml-6')
    expect(unorderedList?.className).toContain('pl-6')
    expect(unorderedList?.className).not.toContain('ml-6')
  })

  it('uses a wider ordered-list gutter for tool-call markdown', () => {
    const { container } = render(
      <Markdown variant="tool-call">
        {
          '1. First\n2. Second\n3. Third\n4. Fourth\n5. Fifth\n6. Sixth\n7. Seventh\n8. Eighth\n9. Ninth\n10. Tenth\n11. Eleventh'
        }
      </Markdown>
    )

    const orderedList = container.querySelector('ol')

    expect(orderedList?.className).toContain('pl-8')
    expect(orderedList?.className).not.toContain('pl-6')
    expect(screen.getByText('Tenth')).toBeInTheDocument()
    expect(screen.getByText('Eleventh')).toBeInTheDocument()
  })

  it('auto-completes incomplete markdown while streaming', () => {
    const { container } = render(
      <Markdown streaming>{'### Birds\n1. Sparrow\n2. Robin\n```ts'}</Markdown>
    )

    expect(container.querySelectorAll('ol')).toHaveLength(1)
    expect(container.querySelector('pre')).not.toBeNull()
  })

  it.each(['csharp', 'cs'])(
    'highlights completed C# fences using the %s info string',
    infoString => {
      const { container } = render(
        <Markdown>{`\`\`\`${infoString}\npublic class Bird {}\n\`\`\``}</Markdown>
      )

      expect(mocks.useSyntaxHighlighting).toHaveBeenCalledWith(
        'public class Bird {}\n',
        'csharp',
        'github-light'
      )
      expect(container.querySelector('.shiki')).not.toBeNull()
      expect(
        container.querySelector('[data-language="csharp"]')
      ).toHaveTextContent('public class Bird {}')
    }
  )

  it('keeps C# fences plain and skips highlighting while streaming', () => {
    const { container } = render(
      <Markdown streaming>{'```cs\npublic class Bird {}'}</Markdown>
    )

    expect(mocks.useSyntaxHighlighting).not.toHaveBeenCalled()
    expect(container.querySelector('.shiki')).toBeNull()
    expect(container.querySelector('pre')).toHaveTextContent(
      'public class Bird {}'
    )
  })

  it('copies the original code text after highlighting', () => {
    render(<Markdown>{'```csharp\npublic class Bird {}\n```'}</Markdown>)

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

    expect(mocks.copyToClipboard).toHaveBeenCalledWith('public class Bird {}\n')
  })

  it('renders raw HTML in completed messages', () => {
    const { container } = render(
      <Markdown>{'before <b>bold</b> after'}</Markdown>
    )

    expect(container.querySelector('b')).not.toBeNull()
    expect(container.querySelector('b')?.textContent).toBe('bold')
  })

  it('skips the rehype-raw HTML pass while streaming', () => {
    const { container } = render(
      <Markdown streaming>{'before <b>bold</b> after'}</Markdown>
    )

    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>bold</b>')
  })

  it('converts app-data image paths into loadable file URLs', () => {
    const { container } = render(
      <Markdown>
        {
          '![Linear screenshot](</Users/me/Library/Application Support/com.jean.desktop/linear-context-images/ENG-123/image.png>)'
        }
      </Markdown>
    )

    const image = container.querySelector('img')

    expect(image?.getAttribute('src')).toBe(
      '/api/files/linear-context-images/ENG-123/image.png'
    )
  })
})
