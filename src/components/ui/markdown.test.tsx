import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { Markdown } from './markdown'

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

  it('preserves spaces from Grok-style word-boundary stream deltas', () => {
    const chunks = [
      "I'll",
      ' add',
      ' SQ',
      'Lite',
      ' backup',
      ' encryption',
      ' using',
      ' a',
      ' key',
      ' from',
      ' `.',
      'env',
      '`',
      ' (',
      'Bun',
      ' crypto',
      ',',
      ' no',
      ' `',
      'age',
      '`',
      ' dependency',
      ').',
      ' Checking',
      ' the',
      ' project',
    ]
    let acc = ''
    for (const c of chunks) {
      acc += c
      const { container } = render(<Markdown streaming>{acc}</Markdown>)
      const text = container.textContent ?? ''
      expect(text.includes("I'lladd")).toBe(false)
      if (acc.includes(' add')) {
        expect(text).toMatch(/I'll\s+add/)
      }
    }
    const { container } = render(<Markdown streaming>{acc}</Markdown>)
    expect(container.textContent).toContain("I'll add SQLite backup")
    expect(container.textContent).toContain('Bun crypto')
    expect(container.textContent).not.toContain('Buncrypto')
  })

  it('keeps mid-string spaces after remend when content ends with a single space', () => {
    // remend strips one trailing space for incomplete-markdown heuristics.
    // We restore it; HTML may still collapse the visual trailing space, but
    // mid-word spaces must remain so the next delta does not look glued on.
    const { container } = render(
      <Markdown streaming>{"I'll add SQLite "}</Markdown>
    )
    expect(container.textContent).toContain("I'll add SQLite")
    expect(container.textContent).not.toContain("I'lladd")
  })
})
