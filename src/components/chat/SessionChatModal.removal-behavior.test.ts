import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('SessionChatModal removal behavior', () => {
  it('listens for command-palette session rename requests', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toMatch(
      /window\.addEventListener\(\s*'command:rename-session'/
    )
    expect(source).toMatch(
      /window\.removeEventListener\(\s*'command:rename-session'/
    )
  })

  it('keeps rename input out of the clickable tab button to avoid accidental close/cancel', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).not.toMatch(/<button\s+data-session-id=/)
    expect(source).toMatch(/<div\s+data-session-id=/)
    expect(source).toContain('onPointerDown={e => e.stopPropagation()}')
  })

  it('uses the delete-aware handler when removing non-last tabs', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')
    const start = source.indexOf('const removeSessionTab = useCallback(')
    const end = source.indexOf('\n  const handleTabAuxClick', start)
    const removeSessionTab =
      start === -1 || end === -1 ? '' : source.slice(start, end)

    expect(removeSessionTab).toBeTruthy()
    expect(removeSessionTab).toContain('handleDeleteSession(session.id)')
    expect(removeSessionTab).not.toMatch(
      /else\s*\{[\s\S]*?selectVisualNeighbor\(session\.id\)[\s\S]*?handleArchiveSession\(session\.id\)/
    )
  })

  it('uses terminal-like square tab styling for session header tabs', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain('flex min-w-max items-center gap-0 py-0 px-0')
    expect(source).toContain(
      'group/tab flex shrink-0 items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs transition-colors whitespace-nowrap'
    )
    expect(source).not.toContain('group/tab flex rounded items-center')
  })

  it('keeps a yellow background on waiting session tabs', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain(
      "status === 'waiting' &&\n                                'bg-yellow-500/10"
    )
  })
})
