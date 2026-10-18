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

  it('shows terminal and browser toggles in the desktop header', () => {
    expect(source).toContain('label="Terminal"')
    expect(source).toContain('label="Browser"')
    expect(source).toContain('onClick={handleToggleModalTerminal}')
    expect(source).toContain('onClick={handleToggleModalBrowser}')
  })

  it('does not duplicate run actions in the desktop header', () => {
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

  it('shows Open In and Scripts on smaller desktop windows', () => {
    expect(source).toContain(
      '<div className="hidden lg:flex items-center gap-1">'
    )
    expect(source).not.toContain('hidden 2xl:flex items-center gap-1')
  })

  it('shows git diff stats beside the title at mobile and desktop widths', () => {
    expect(source).toContain('diffAdded={uncommittedAdded}')
    expect(source).toContain('diffRemoved={uncommittedRemoved}')
    expect(source).toContain('branchDiffAdded={isBase ? 0 : branchDiffAdded}')
    expect(source).toContain(
      'branchDiffRemoved={isBase ? 0 : branchDiffRemoved}'
    )
    expect(source).not.toContain('diffAdded={isMobile ? 0 : uncommittedAdded}')
    expect(source).not.toContain('isBase || isMobile')
  })
})

describe('GitDiffModal responsive header actions', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, 'GitDiffModal.tsx'),
    'utf8'
  )

  it('keeps the mobile refresh and close actions together in the top row', () => {
    expect(source).toContain('data-testid="mobile-diff-header-actions"')
    expect(source).toMatch(
      /data-testid="mobile-diff-header-actions"[\s\S]*aria-label="Refresh diff"[\s\S]*<ModalCloseButton onClick=\{onClose\}/
    )
  })

  it('only shows refresh on diff tabs that can refresh', () => {
    expect(source).toMatch(
      /activeDiffType !== 'commits' &&[\s\S]*activeDiffType !== 'checkpoints'/
    )
  })
})
