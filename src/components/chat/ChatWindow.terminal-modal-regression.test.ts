import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('terminal primary surface modal regression', () => {
  it('preserves model-catalog effort levels selected for Codex', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).toContain(
      'const selectedEffortLevel: EffortLevel = rawSelectedEffortLevel'
    )
    expect(source).not.toContain("rawSelectedEffortLevel === 'max'")
    expect(source).not.toContain("rawSelectedEffortLevel === 'ultracode'")
  })

  it('keeps ChatWindow global modals mounted when terminal is primary surface', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).not.toContain(
      "if (primarySurface === 'terminal' && activeSessionId && sessionTerminalId)"
    )

    const terminalSurfaceIndex = source.indexOf('{isTerminalPrimarySurface ? (')
    const gitDiffModalIndex = source.indexOf('<GitDiffModal')

    expect(terminalSurfaceIndex).toBeGreaterThan(-1)
    expect(gitDiffModalIndex).toBeGreaterThan(terminalSurfaceIndex)
  })

  it('keeps ChatWindow mounted in session modals when terminal is primary surface', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).not.toContain("primarySurface !== 'terminal'")
    expect(source).not.toContain("primarySurface === 'terminal' &&")
    expect(source).toContain('{currentSessionId ? (')
    expect(source).toContain('<ChatWindow')
  })

  it('auto-restores terminal sessions silently without marking them opened', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).toMatch(
      /reconnectNativeCliSession\s*\(\s*session\s*,\s*activeWorktreeId/
    )
    expect(source).toMatch(/openModal:\s*false/)
    expect(source).toMatch(/showToast:\s*false/)
    expect(source).toMatch(/markOpened:\s*false/)
    expect(source).toContain("session.primary_surface === 'terminal'")
  })

  it('guards terminal auto-restore against session switches and duplicate spawns', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).toMatch(/if\s*\(\s*isSessionSwitching\s*\)\s*return/)
    // Guard uses a local `autoReconnecting` alias of the lazy-init ref set.
    expect(source).toMatch(
      /if\s*\(\s*autoReconnecting\.has\s*\(\s*deferredSessionId\s*\)\s*\)\s*return/
    )
    expect(source).toMatch(/autoReconnecting\.add\s*\(\s*sessionId\s*\)/)
    expect(source).toMatch(/autoReconnecting\.delete\s*\(\s*sessionId\s*\)/)
  })

  it('shows a safe recovery state instead of an empty chat for legacy sessions', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')

    expect(source).toContain('isTerminalAwaitingReconnect')
    expect(source).toContain('Terminal session needs to be reconnected')
    expect(source).toContain('Choose native session')
  })

  it('starts review fix sessions in the background without switching tabs', () => {
    const source = readSource('src/components/chat/ChatWindow.tsx')
    const start = source.indexOf('const handleReviewFix = useCallback')
    const end = source.indexOf('// Note: Streaming event listeners', start)
    const handleReviewFixSource = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(handleReviewFixSource).toContain('createSession.mutateAsync')
    expect(handleReviewFixSource).toContain('sendMessage.mutate')
    // Must not switch the active tab (background fix sessions)
    expect(handleReviewFixSource).not.toContain('setActiveSession')
    // Issue #630: custom MiniMax/etc. profiles must ride along with the fix turn
    expect(handleReviewFixSource).toContain('resolveMagicPromptProvider')
    expect(handleReviewFixSource).toContain('code_review_provider')
    expect(handleReviewFixSource).toContain('customProfileName')
    // Prefer multi-review selected reviewer backend/model when provided
    expect(handleReviewFixSource).toContain('options?.backend')
    expect(handleReviewFixSource).toContain('options?.model')
  })
})
