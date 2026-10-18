import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('RecentWorktreesList structure', () => {
  const source = readFileSync(
    'src/components/projects/RecentWorktreesList.tsx',
    'utf8'
  )

  it('loads ten rows first and adds older rows in pages of 25', () => {
    expect(source).toContain('const INITIAL_RECENT_LIMIT = 10')
    expect(source).toContain('const RECENT_PAGE_SIZE = 25')
    expect(source).toContain('{Math.min(hiddenCount, RECENT_PAGE_SIZE)} more')
    expect(source).toContain('setLimit(value => value + RECENT_PAGE_SIZE)')
    expect(source).toContain('Show snoozed sessions')
    expect(source).toContain(
      'createPortal(footerActions, footerActionsContainer)'
    )
    expect(source).toContain('Snoozed · inactive for 24 hours')
    expect(source).toContain('isSnoozedSession(row.lastActivityAt)')
  })

  it('shows session, project, worktree, activity, and Git diff information', () => {
    expect(source).toContain('{row.session.name}')
    expect(source).toContain('namingSessionIds[row.session.id]')
    expect(source).toContain("'Generating…'")
    expect(source).toContain('{row.projectName} · {row.worktree.name}')
    expect(source).toContain('formatRecentActivity(row.lastActivityAt)')
    expect(source).toContain('+{row.added}')
    expect(source).toContain('-{row.removed}')
    expect(source).toContain('fetchWorktreesStatus(projectId)')
    expect(source).toContain('text-[13px] font-medium')
    expect(source).toContain('text-[11px]')
  })

  it('aligns status, activity, and optional Git changes in grid rows', () => {
    expect(source).toContain('flex w-full flex-col gap-y-1')
    expect(source).toContain('min-w-0 flex-1 truncate text-[13px]')
    expect(source).not.toContain('min-w-14')
    expect(source).toContain('<WorkingWaveform />')
    expect(source).toContain(
      'className="flex shrink-0 items-center justify-end gap-2 text-[10px] tabular-nums"'
    )
    expect(source).toContain('@container flex flex-col')
    expect(source).toContain('hidden gap-1 font-medium @[15rem]:flex')
    expect(source).not.toContain('pt-4')
    expect(source).not.toContain('absolute right-3 top-2')
  })

  it('shows the finished-session bell on unread recent sessions', () => {
    expect(source).toContain(
      "import { isUnreadSession } from '@/components/unread/unread-utils'"
    )
    expect(source).toContain('const isUnread = isUnreadSession(row.session)')
    expect(source).toContain('{isUnread && (')
    expect(source).toContain('aria-label="Unread session"')
    expect(source).toContain('text-warning')
  })

  it('uses fully rounded rows and a full background for the current row', () => {
    expect(source).toContain(
      '@container flex flex-col gap-2 px-2 pt-2'
    )
    expect(source).toContain('rounded-lg border py-2.5 pl-3 pr-3')
    expect(source).toContain(
      "isCurrent ? 'border-border bg-muted/50 text-foreground shadow'"
    )
    expect(source).toContain(
      ": 'border-transparent bg-transparent text-muted-foreground'"
    )
    expect(source).not.toContain('rounded-r-lg')
    expect(source).not.toContain('border-l-2')
    expect(source).not.toContain('bg-card/40')
    expect(source).not.toContain('shadow-sm')
    expect(source).not.toContain('divide-y divide-border/30')
  })

  it('keeps current-row, keyboard, partial failure, and accessibility behavior', () => {
    expect(source).toContain('event.metaKey')
    expect(source).toContain("['ArrowUp', 'ArrowDown']")
    expect(source).toContain('getAdjacentRecentRow(')
    expect(source).toContain('displayedRows,')
    expect(source).not.toContain('ignoresNavigationShortcut')
    expect(source).toContain('event.stopPropagation()')
    expect(source).toContain('{ capture: true }')
    expect(source).toContain("aria-current={isCurrent ? 'page' : undefined}")
    expect(source).toContain('aria-label="Recent sessions"')
    expect(source).toContain('Some recent sessions could')
    expect(source).toContain('selectedSessionId')
    expect(source).toContain('getRecentSessionStatus(row.session')
    expect(source).toContain("const isWorking = status.tone === 'working'")
    expect(source).toContain('{isWorking ? (')
    expect(source).not.toContain('vibing')
    expect(source).not.toContain('planning')
    expect(source).not.toContain('executingModes[row.session.id]')
    expect(source).not.toContain('executionModes[row.session.id]')
    expect(source).not.toContain('border-l-destructive')
    expect(source).not.toContain('border-l-yellow-500')
    expect(source).not.toContain('border-l-green-500')
    expect(source).toContain("status.tone !== 'completed'")
  })

  it('fetches pinned sessions without creating a list for each selected session', () => {
    expect(source).toContain(
      "queryKey: ['recent-worktrees', projectKey, limit, pinnedSessionIds]"
    )
    expect(source).toContain(
      'fetchRecentWorktrees(projects, limit, pinnedSessionIds)'
    )
    expect(source).not.toContain(
      "queryKey: ['recent-worktrees', projectKey, limit, selectedSessionId]"
    )
  })

  it('keeps the snoozed footer stable during background refreshes', () => {
    expect(source).not.toContain('query.isFetching')
    expect(source).not.toContain('Updating…')
  })

  it('pins sessions above recent rows and keeps the pin visible on small screens', () => {
    expect(source).toContain('<Thumbtack')
    expect(source).toContain("weight={isPinned ? 'Filled' : 'Outline'}")
    expect(source).toContain('void setRecentSessionPinned(')
    expect(source).toContain('pinned.has(row.session.id)')
    expect(source).toContain('return sortRecentRows(')
    expect(source).toContain('opacity-100')
    expect(source).toContain('md:opacity-0')
    expect(source).toContain('md:group-hover:opacity-100')
    expect(source).toContain('relative flex w-full cursor-pointer')
    expect(source).toContain('absolute -left-1.5 -top-1.5 z-10')
    expect(source).not.toContain('absolute right-full')
    expect(source).not.toContain('absolute right-1 top-1')
    expect(source).not.toContain('pr-9')
    const projectName = source.indexOf(
      '{row.projectName} · {row.worktree.name}'
    )
    const pinLabel = source.indexOf(
      "isPinned ? 'Unpin session' : 'Pin session'"
    )
    const gitAdded = source.indexOf('+{row.added}')
    expect(pinLabel).toBeGreaterThan(-1)
    expect(projectName).toBeGreaterThan(pinLabel)
    expect(gitAdded).toBeGreaterThan(projectName)
    expect(source).toContain("isPinned ? 'Unpin session' : 'Pin session'")
    expect(source).toContain('!isPinned &&')
    expect(source).toContain('showPinnedSeparator')
    expect(source).toContain('role="separator"')
    expect(source).toContain('border-t border-border/70')
  })

  it('opens a session from the full card without treating the pin as an open action', () => {
    expect(source).toContain('cursor-pointer flex-col')
    expect(source).toContain('onClick={() => handleOpen(row)}')
    expect(source).toContain('onClick={event => {')
    expect(source).toContain('event.stopPropagation()')
  })
})
