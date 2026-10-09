import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { Markdown, headingBefore } from './markdown'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'

const { mockSetRow, mockReadImage } = vi.hoisted(() => ({
  mockSetRow: vi.fn(),
  mockReadImage: vi.fn(),
}))
vi.mock('@/lib/transport', async importOriginal => ({
  ...(await importOriginal<object>()),
  invokeForOptionalServer: mockReadImage,
}))
vi.mock('@/lib/remote-connections', () => ({
  getActiveRemoteConnection: () => null,
  getRemoteConnections: () => [
    { id: 'remote-1', url: 'https://jean.example', token: 'image-token' },
  ],
}))
vi.mock('@/lib/table-rows-prompt', async importOriginal => ({
  ...(await importOriginal<object>()),
  setTableRowInPrompt: mockSetRow,
}))

describe('Markdown', () => {
  it('pins a table with its exact markdown source and shares state by key', () => {
    useChatStore.setState({ pinnedTables: {} })
    const table = '| Name | Value |\n| --- | --- |\n| **a** | `1` |'
    const content = `Intro text\n\n${table}\n\nOutro`

    const { unmount } = render(
      <Markdown messageId="msg-1" sessionId="session-1">
        {content}
      </Markdown>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pin table' }))

    const pins = useChatStore.getState().pinnedTables['session-1']
    expect(pins).toEqual([
      { key: `msg-1:${content.indexOf(table)}`, markdown: table },
    ])
    unmount()

    // Rendered alone (pinned view), the fixed key keeps it pinned.
    render(
      <Markdown sessionId="session-1" tableKey={pins?.[0]?.key}>
        {table}
      </Markdown>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Unpin table' }))
    expect(useChatStore.getState().pinnedTables['session-1']).toBeUndefined()
  })

  it('adds a row to the prompt on row click, but not on link clicks', async () => {
    mockSetRow.mockReset()
    const table =
      '| Name | Link |\n| --- | --- |\n| a | [docs](https://x.dev) |'
    render(
      <Markdown sessionId="s1" tableKey="t1">
        {table}
      </Markdown>
    )
    expect(screen.getByText('Click a row to add it to the prompt')).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'docs' }))
    expect(mockSetRow).not.toHaveBeenCalled()

    const focusChat = vi.fn()
    window.addEventListener('focus-chat-input', focusChat)
    fireEvent.click(screen.getByText('a'))
    expect(mockSetRow).toHaveBeenCalledWith(
      's1',
      't1',
      0,
      expect.any(Array),
      ''
    )
    // One click adds the row and opens the note form with focus in it.
    const note = screen.getByLabelText(/row 1/i)
    await waitFor(() => expect(document.activeElement).toBe(note))
    expect(focusChat).not.toHaveBeenCalled()

    // Enter saves the note, then focus goes on to the chat input.
    fireEvent.change(note, { target: { value: 'fix it' } })
    fireEvent.keyDown(note, { key: 'Enter' })
    expect(mockSetRow).toHaveBeenLastCalledWith(
      's1',
      't1',
      0,
      expect.any(Array),
      'fix it'
    )
    await waitFor(() => expect(focusChat).toHaveBeenCalledTimes(1))
    window.removeEventListener('focus-chat-input', focusChat)
  })

  it('checks the checklist row when the row is added to the prompt', () => {
    mockSetRow.mockReset()
    useChatStore.setState({ tableCheckedRows: {} })
    useChatStore.getState().enableTableChecklist('s2', 't2')
    render(
      <Markdown sessionId="s2" tableKey="t2">
        {'| Name |\n| --- |\n| a |\n| b |'}
      </Markdown>
    )

    fireEvent.click(screen.getByText('b'))
    expect(
      useChatStore.getState().tableCheckedRows.s2?.t2 ?? new Set()
    ).toEqual(new Set([1]))
  })

  it('checks the row in the background when checklist mode is off', () => {
    mockSetRow.mockReset()
    useChatStore.setState({ tableCheckedRows: {}, hiddenTableChecklists: {} })
    render(
      <Markdown sessionId="s3" tableKey="t3">
        {'| Name |\n| --- |\n| a |\n| b |'}
      </Markdown>
    )

    fireEvent.click(screen.getByText('b'))
    // No checklist column while checklist mode is off.
    expect(screen.queryByLabelText(/Toggle row/)).toBeNull()

    act(() => useChatStore.getState().enableTableChecklist('s3', 't3'))
    expect(
      (screen.getByLabelText('Toggle row 2') as HTMLElement).dataset.state
    ).toBe('checked')
  })

  it('supports keyboard row navigation, add with note, and removal', () => {
    mockSetRow.mockReset()
    const table = '| Name |\n| --- |\n| a |\n| b |'
    const { rerender } = render(
      <Markdown sessionId="s2" tableKey="t2">
        {table}
      </Markdown>
    )
    const rowA = screen.getByText('a').closest('tr') as HTMLElement
    const rowB = screen.getByText('b').closest('tr') as HTMLElement

    rowA.focus()
    fireEvent.keyDown(rowA, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rowB)
    fireEvent.keyDown(rowB, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rowA)

    // Enter opens the note form without adding the row yet.
    fireEvent.keyDown(rowA, { key: 'Enter' })
    expect(mockSetRow).not.toHaveBeenCalled()
    const note = screen.getByLabelText(/Add row 1 to the prompt/)
    fireEvent.change(note, { target: { value: 'first' } })
    fireEvent.keyDown(note, { key: 'Enter' })
    expect(mockSetRow).toHaveBeenCalledWith(
      's2',
      't2',
      0,
      expect.any(Array),
      'first'
    )

    // Delete does nothing for a row not in the prompt.
    mockSetRow.mockReset()
    fireEvent.keyDown(rowB, { key: 'Delete' })
    expect(mockSetRow).not.toHaveBeenCalled()

    // Backspace removes a row that is in the prompt.
    useChatStore.setState({
      pendingTextFiles: {
        s2: [
          {
            id: 'tf',
            tableRows: { tableKey: 't2', rows: [0], notes: { 0: 'first' } },
          },
        ],
      },
    } as never)
    rerender(
      <Markdown sessionId="s2" tableKey="t2">
        {table}
      </Markdown>
    )
    fireEvent.keyDown(rowA, { key: 'Backspace' })
    expect(mockSetRow).toHaveBeenCalledWith(
      's2',
      't2',
      0,
      expect.any(Array),
      null
    )
  })

  it('keeps focus on the next note form when one form closes another', async () => {
    useChatStore.setState({
      pendingTextFiles: {
        s4: [{ id: 'tf', tableRows: { tableKey: 't4', rows: [0, 1] } }],
      },
    } as never)
    render(
      <Markdown sessionId="s4" tableKey="t4">
        {'| Name |\n| --- |\n| a |\n| b |'}
      </Markdown>
    )

    fireEvent.click(screen.getByText('a'))
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText(/Row 1 is in the prompt/)
      )
    )

    // A click on the next row closes the first form and opens the next one.
    // The first form's deferred close must not pull focus back to its row.
    const rowB = screen.getByText('b')
    fireEvent.pointerDown(rowB)
    fireEvent.click(rowB)
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    expect(screen.queryByLabelText(/Row 1 is in the prompt/)).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByLabelText(/Row 2 is in the prompt/)
    )
  })

  it('keeps a typed note when the user clicks its row or outside the form', async () => {
    mockSetRow.mockReset()
    useChatStore.setState({
      pendingTextFiles: {
        s5: [{ id: 'tf', tableRows: { tableKey: 't5', rows: [0] } }],
      },
    } as never)
    render(
      <Markdown sessionId="s5" tableKey="t5">
        {'| Name |\n| --- |\n| a |\n| b |'}
      </Markdown>
    )
    const rowA = screen.getByText('a')
    const noteLabel = /Row 1 is in the prompt/

    fireEvent.click(rowA)
    fireEvent.change(screen.getByLabelText(noteLabel), {
      target: { value: 'draft' },
    })
    // Radix starts to listen for outside clicks one tick after it opens.
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))

    // A click on the row of the open form keeps the form and the draft.
    fireEvent.pointerDown(rowA)
    fireEvent.click(rowA)
    const note = screen.getByLabelText(noteLabel) as HTMLTextAreaElement
    expect(note.value).toBe('draft')
    expect(document.activeElement).toBe(note)

    // Escape discards the draft and returns focus to the row.
    fireEvent.keyDown(note, { key: 'Escape' })
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    expect(screen.queryByLabelText(noteLabel)).toBeNull()
    expect(mockSetRow).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(rowA.closest('tr'))

    // A click outside the form saves a changed note.
    fireEvent.click(rowA)
    fireEvent.change(screen.getByLabelText(noteLabel), {
      target: { value: 'kept' },
    })
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    fireEvent.pointerDown(document.body)
    expect(mockSetRow).toHaveBeenCalledWith(
      's5',
      't5',
      0,
      expect.any(Array),
      'kept'
    )
  })

  it('opens relative file links in the active worktree viewer', () => {
    useChatStore.setState({ activeWorktreePath: '/repo/worktree' })
    useUIStore.getState().setViewingFilePath(null)

    render(<Markdown>{'[screenshot](coolify-sponsors.png)'}</Markdown>)
    fireEvent.click(screen.getByRole('link', { name: 'screenshot' }))

    expect(useUIStore.getState().viewingFilePath).toBe(
      '/repo/worktree/coolify-sponsors.png'
    )
  })

  it('opens inline-code file paths in the viewer on click', () => {
    useChatStore.setState({ activeWorktreePath: '/repo/worktree' })
    useUIStore.getState().setViewingFilePath(null)

    render(<Markdown>{'See `docs/hello.txt` and `bun run dev`.'}</Markdown>)
    fireEvent.click(screen.getByText('bun run dev'))
    expect(useUIStore.getState().viewingFilePath).toBeNull()

    fireEvent.click(screen.getByText('docs/hello.txt'))
    expect(useUIStore.getState().viewingFilePath).toBe(
      '/repo/worktree/docs/hello.txt'
    )
  })

  it('preserves ordered-list start attributes from parsed markdown', () => {
    const { container } = render(
      <Markdown>{'1. First\n\nInterlude\n\n2. Second'}</Markdown>
    )

    const orderedLists = Array.from(container.querySelectorAll('ol'))

    expect(orderedLists).toHaveLength(2)
    expect(orderedLists[0]?.getAttribute('start')).toBeNull()
    expect(orderedLists[1]?.getAttribute('start')).toBe('2')
  })

  it('continues top-level numbering when 2nd-level bullets interrupt the list (issue #200)', () => {
    // LLMs often emit unindented sub-bullets and restart every parent at "1."
    const md = `1. **Define architecture**
- Pick default backend
- Decide on fallbacks

1. **Centralize resolution**
- Create helper
- Replace call sites

1. **Make migrations**
- Apply to all
- Ensure consistency`

    const { container } = render(<Markdown>{md}</Markdown>)

    const orderedLists = Array.from(container.querySelectorAll('ol'))
    // One continuous ordered list — browser markers are 1, 2, 3
    expect(orderedLists).toHaveLength(1)

    const topLevelItems = Array.from(orderedLists[0]?.children ?? []).filter(
      el => el.tagName === 'LI'
    )
    expect(topLevelItems).toHaveLength(3)

    // Each top-level item nests its bullet children
    for (const li of topLevelItems) {
      const nestedUl = li.querySelector(':scope > ul')
      expect(nestedUl).not.toBeNull()
      expect(nestedUl?.querySelectorAll(':scope > li').length).toBe(2)
    }

    expect(container.textContent).toContain('Define architecture')
    expect(container.textContent).toContain('Centralize resolution')
    expect(container.textContent).toContain('Make migrations')
  })

  it('keeps properly indented nested lists as a single ordered list', () => {
    const md = `1. First
   - a
   - b
2. Second
   - c
3. Third`

    const { container } = render(<Markdown>{md}</Markdown>)
    const orderedLists = Array.from(container.querySelectorAll('ol'))

    expect(orderedLists).toHaveLength(1)
    const topLevelItems = Array.from(orderedLists[0]?.children ?? []).filter(
      el => el.tagName === 'LI'
    )
    expect(topLevelItems).toHaveLength(3)
  })

  it('keeps list marker gutters inside the markdown box', () => {
    const { container } = render(
      <div className="overflow-x-hidden">
        <Markdown>{'1. First\n2. Second\n\n- Bullet'}</Markdown>
      </div>
    )

    const orderedList = container.querySelector('ol')
    const unorderedList = container.querySelector('ul')

    // Ordered lists need pl-8 so two-digit markers ("10.") are not clipped by
    // overflow-x-hidden ancestors (issue #542). Unordered bullets stay pl-6.
    expect(orderedList?.className).toContain('pl-8')
    expect(orderedList?.className).not.toContain('ml-6')
    expect(orderedList?.className).not.toMatch(/(?:^|\s)pl-6(?:\s|$)/)
    expect(unorderedList?.className).toContain('pl-6')
    expect(unorderedList?.className).not.toContain('ml-6')
  })

  it('uses a wide enough ordered-list gutter for double-digit markers (issue #542)', () => {
    const md = Array.from(
      { length: 12 },
      (_, i) => `${i + 1}. Item ${i + 1}`
    ).join('\n')

    const { container } = render(
      <div className="overflow-x-hidden">
        <Markdown>{md}</Markdown>
      </div>
    )

    const orderedList = container.querySelector('ol')

    expect(orderedList?.className).toContain('pl-8')
    expect(orderedList?.className).not.toMatch(/(?:^|\s)pl-6(?:\s|$)/)
    expect(screen.getByText('Item 10')).toBeInTheDocument()
    expect(screen.getByText('Item 11')).toBeInTheDocument()
    expect(screen.getByText('Item 12')).toBeInTheDocument()
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
    expect(orderedList?.className).not.toMatch(/(?:^|\s)pl-6(?:\s|$)/)
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

  it('routes app-data images through the session owner, not the local transport', () => {
    const path = '/root/.local/share/com.jean.desktop/pasted-images/shot.png'
    const { container, rerender } = render(
      <Markdown sessionId="remote-1:session-1">{`![Shot](${path})`}</Markdown>
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      `https://jean.example/api/files/${encodeURIComponent(path)}?token=image-token`
    )

    rerender(
      <Markdown sessionId="local:session-1">{`![Shot](${path})`}</Markdown>
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/files/pasted-images/shot.png'
    )
  })

  it.each([undefined, 'local:session-1', 'remote-1:session-1'])(
    'loads screenshots outside app data from their owner (%s)',
    async sessionId => {
      mockReadImage.mockReset()
      mockReadImage.mockResolvedValue({
        mimeType: 'image/png',
        data: 'c2hvdA==',
      })
      const { container } = render(
        <Markdown sessionId={sessionId}>
          {'![Shot](/tmp/browser-shot.png)'}
        </Markdown>
      )
      await waitFor(() => {
        expect(container.querySelector('img')?.getAttribute('src')).toBe(
          'data:image/png;base64,c2hvdA=='
        )
      })
      expect(mockReadImage).toHaveBeenCalledWith(
        sessionId?.split(':')[0],
        'read_file_base64',
        { path: '/tmp/browser-shot.png' }
      )
    }
  )

  it('does not display the previous server image after switching sessions', async () => {
    mockReadImage.mockReset()
    let completeFirst!: (result: { mimeType: string; data: string }) => void
    mockReadImage
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            completeFirst = resolve
          })
      )
      .mockResolvedValueOnce({ mimeType: 'image/png', data: 'bmV3' })
    const content = '![Shot](/tmp/browser-shot.png)'
    const { container, rerender } = render(
      <Markdown sessionId="remote-1:session-1">{content}</Markdown>
    )
    rerender(<Markdown sessionId="remote-2:session-2">{content}</Markdown>)
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,bmV3'
      )
    })
    completeFirst({ mimeType: 'image/png', data: 'b2xk' })
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,bmV3'
      )
    })
  })

  it('keeps HTTPS images unchanged without reading them as files', () => {
    mockReadImage.mockReset()
    const url = 'https://example.com/screenshot.png'
    const { container } = render(
      <Markdown sessionId="remote-1:session-1">{`![Shot](${url})`}</Markdown>
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(url)
    expect(mockReadImage).not.toHaveBeenCalled()
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

describe('headingBefore', () => {
  it('returns the nearest heading above the table', () => {
    const source =
      '## Report\n\n### Storage, databases, DNS, proxy\n\nSome text.\n\n| a |\n| - |'
    expect(headingBefore(source, source.indexOf('| a |'))).toBe(
      'Storage, databases, DNS, proxy'
    )
  })

  it('accepts a bold-only line as a heading', () => {
    const source = '**High (fix before release):**\n\n| a |\n| - |'
    expect(headingBefore(source, source.indexOf('| a |'))).toBe(
      'High (fix before release)'
    )
  })

  it('returns null when there is no heading', () => {
    const source = 'Plain **bold** text.\n\n| a |\n| - |'
    expect(headingBefore(source, source.indexOf('| a |'))).toBeNull()
  })
})
