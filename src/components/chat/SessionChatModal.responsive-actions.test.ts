import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('SessionChatModal responsive header actions', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, 'SessionChatModal.tsx'),
    'utf8'
  )

  it('does not duplicate GitHub status badges in the desktop header', () => {
    expect(source).not.toContain('@/components/shared/NewIssuesBadge')
    expect(source).not.toContain('@/components/shared/OpenPRsBadge')
    expect(source).not.toContain('@/components/shared/FailedRunsBadge')
  })

  it('does not duplicate terminal, browser, or run actions in the desktop header', () => {
    expect(source).not.toContain('aria-label="Toggle terminal"')
    expect(source).not.toContain('aria-label="Toggle browser"')
    expect(source).not.toContain('aria-label="Run"')
    expect(source).not.toContain('aria-label="Run first command"')
    expect(source).not.toContain('aria-label="Choose run command"')
  })

  it('routes compact terminal and browser actions through the worktree menu', () => {
    expect(source).toContain('onToggleTerminal={handleToggleModalTerminal}')
    expect(source).toMatch(
      /onToggleBrowser=\{\s*isNativeApp\(\) \? handleToggleModalBrowser : undefined\s*\}/
    )
  })
})
