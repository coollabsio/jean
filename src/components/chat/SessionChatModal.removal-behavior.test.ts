import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')

describe('SessionChatModal removal behavior', () => {
  it('opens the sidebar on a worktree swipe without closing the session or terminal', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')
    const start = source.indexOf('const swipeOpenSidebar = useCallback(')
    const end = source.indexOf('const { data: sessionsData }', start)
    const gesture = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(gesture).toContain('setLeftSidebarVisible(true)')
    expect(gesture).toContain('onSwipeBack: swipeOpenSidebar')
    expect(gesture).toContain(
      'enabled: isTouch && isOpen && !leftSidebarVisible'
    )
    expect(gesture).toContain('animateToEnd: false')
    expect(gesture).not.toContain('onClose()')
    expect(gesture).not.toContain('closeChatTerminal')
    expect(source).not.toContain(
      'transform: `translateX(${swipe.translateX}px)`'
    )
  })

  it('publishes swipe progress so the mobile sidebar follows the gesture', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain('setLeftSidebarSwipe({')
    expect(source).toContain('dragOffset: swipe.translateX')
    expect(source).toContain('dragTransition: swipe.transitionStyle')
  })

  it('receives complete header data from the loaded project canvas', () => {
    const modalSource = readSource('src/components/chat/SessionChatModal.tsx')
    const canvasSource = readSource(
      'src/components/dashboard/ProjectCanvasView.tsx'
    )
    const mainWindowSource = readSource(
      'src/components/layout/MainWindowContent.tsx'
    )

    expect(modalSource).toMatch(
      /interface SessionChatModalProps \{[\s\S]*worktree: Worktree/
    )
    expect(modalSource).toMatch(
      /interface SessionChatModalProps \{[\s\S]*project: Project/
    )
    expect(modalSource).not.toContain('useWorktree(worktreeId)')
    expect(modalSource).not.toContain('useProjects()')
    expect(canvasSource).toContain('worktree={selectedModalWorktree}')
    expect(canvasSource).toContain('project={project ?? null}')
    expect(canvasSource).not.toContain('useProjects()')
    expect(mainWindowSource).toContain('project={selectedProject}')
  })

  it('listens for command-palette session rename requests', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toMatch(
      /window\.addEventListener\(\s*'command:rename-session'/
    )
    expect(source).toMatch(
      /window\.removeEventListener\(\s*'command:rename-session'/
    )
  })

  it('does not open the file browser or terminal on a right-edge swipe', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).not.toContain('swipeOpenFileBrowserCallback')
    expect(source).not.toContain("edge: 'right'")
    expect(source).not.toContain('swipeOpenTerminalCallback')
    expect(source).not.toContain("openChatTerminal(worktreeId, 'modal')")
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

  it('confirms non-empty session tab close even when other tabs remain (issue #56)', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')
    const start = source.indexOf('const removeSessionTab = useCallback(')
    const end = source.indexOf('\n  const handleTabAuxClick', start)
    const removeSessionTab =
      start === -1 || end === -1 ? '' : source.slice(start, end)

    expect(removeSessionTab).toContain('needsConfirm')
    expect(removeSessionTab).toContain(
      'preferences?.confirm_session_close !== false && !sessionIsEmpty'
    )
    // Confirm gate wraps the action for every non-empty tab (not only last).
    expect(removeSessionTab).toMatch(
      /if \(needsConfirm\) \{[\s\S]*?pendingCloseAction\.current = action/
    )
    // Neighbor select happens inside the deferred action, not as a bypass.
    expect(removeSessionTab).toMatch(
      /const action = \(\) => \{[\s\S]*activeSessions\.length > 1[\s\S]*handleDeleteSession/
    )
  })

  it('waits for last-session removal success before leaving the modal', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')
    const start = source.indexOf('const removeSessionTab = useCallback(')
    const end = source.indexOf('\n  const handleTabAuxClick', start)
    const removeSessionTab =
      start === -1 || end === -1 ? '' : source.slice(start, end)

    expect(removeSessionTab).toContain('handleDeleteSession(session.id)')
    expect(removeSessionTab).not.toContain('onClose()')
    expect(removeSessionTab).not.toContain('navigateToProjectPicker(')
  })

  it('creates and opens an empty session after the last session is removed', () => {
    const commandSource = readSource('jean-core/src/chat/commands.rs')
    const closeStart = commandSource.indexOf('pub async fn close_session(')
    const closeEnd = commandSource.indexOf(
      'pub async fn archive_session(',
      closeStart
    )
    const archiveEnd = commandSource.indexOf(
      'pub async fn unarchive_session(',
      closeEnd
    )
    const closeSession = commandSource.slice(closeStart, closeEnd)
    const archiveSession = commandSource.slice(closeEnd, archiveEnd)

    for (const command of [closeSession, archiveSession]) {
      expect(command).toContain('if new_active.is_none()')
      expect(command).toContain('let session = create_session(')
      expect(command).toContain('return Ok(Some(session.id))')
    }
  })

  it('asks to close the worktree when Cmd+W is pressed with no sessions', () => {
    const modalSource = readSource('src/components/chat/SessionChatModal.tsx')
    const canvasSource = readSource(
      'src/components/dashboard/ProjectCanvasView.tsx'
    )

    expect(modalSource).toContain("setCloseConfirmMode('worktree')")
    expect(modalSource).toContain('onRequestCloseWorktree')
    expect(modalSource).toContain('mode={closeConfirmMode}')
    expect(canvasSource).toContain(
      'onRequestCloseWorktree={handleRequestCloseModalWorktree}'
    )
    expect(canvasSource).toContain(
      'closeWorktreeDirectlyRef.current(modal.worktreeId)'
    )
  })

  it('hides session tabs and top action chrome when zen mode is active', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain('state => state.zenMode')
    expect(source).toContain('data-testid="toggle-zen-mode"')
    expect(source).not.toContain('{!(zenMode && isMobile) && (')
    expect(source).toContain('{!zenMode && showSessionTabs && (')
    expect(source).toMatch(/sessionsForTabBar\(\s*sessions,/)
    expect(source).toContain('{!zenMode && (')
    expect(source).toContain('<ModalCloseButton')
    expect(source).toContain('onClick={handleClose}')
  })

  it('uses terminal-like square tab styling for session header tabs', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain('flex min-w-max items-center gap-0 py-0 px-0')
    expect(source).toContain(
      'group/tab flex shrink-0 items-center gap-1.5 border-r border-border/40 px-3 py-1.5 text-xs transition-colors whitespace-nowrap'
    )
    expect(source).not.toContain('group/tab flex rounded items-center')
  })

  it('keeps the new session button after the tabs until they overflow on desktop', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain(
      '<ScrollArea\n                className="min-w-0 flex-1 sm:flex-initial"'
    )
  })

  it('reattaches horizontal tab scrolling after leaving zen mode', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toMatch(
      /viewport\.addEventListener\('wheel',[\s\S]*\}, \[showSessionTabs, zenMode\]\)/
    )
  })

  it('keeps only the zen control in the mobile header', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain('useClearSessionHistory')
    expect(source).toContain('handleClearContext')
    expect(source).toContain('data-testid="toggle-zen-mode"')
    expect(source).toContain('<Minimize className="size-2.5" />')
    expect(source).toContain('<Maximize className="size-2.5" />')
    expect(source).not.toContain('aria-label="Clear context"')
    expect(source).not.toContain('data-testid="clear-session-context"')
    expect(source).toMatch(
      /onSuccess:\s*\(\)\s*=>\s*window\.dispatchEvent\(new CustomEvent\('focus-chat-input'\)\)/
    )
  })

  it('uses the muted icon color without moving the mobile header actions', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain(
      'h-7 px-2 text-xs text-muted-foreground hover:text-foreground'
    )
    expect(source).toContain(
      "isMobile &&\n                            'text-muted-foreground hover:text-foreground'"
    )
    expect(source).toContain(
      "? 'h-7 w-7 text-muted-foreground hover:text-foreground'"
    )
    expect(source).toContain('aria-label="New session"')
  })

  it('falls back to a real session when restored active session state is stale', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toMatch(
      /resolveModalSessionId\(\s*activeSessionId,\s*sessions\.map\(session => session\.id\),\s*sessionsData\?\.active_session_id,\s*activeSessionGone\s*\)/
    )
    expect(source).toContain(
      'const activeSessionGone = !!sessionsData && missingActiveSessionFailed'
    )
  })

  it('refreshes the session list when the modal opens', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toMatch(
      /useSessions\(\s*worktreeId \|\| null,\s*worktreePath \|\| null,\s*\{ refetchOnMount: 'always' \}\s*\)/
    )
  })

  it('keeps a warning background on waiting session tabs', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain('isActionableWaitingStatus(status)')
    expect(source).toContain("'bg-warning/10")
  })

  it('uses a subtle grey background only for inactive unread session tabs', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain('isUnreadSession(session)')
    expect(source).toContain('!isActive')
    expect(source).toContain('!isActionableWaitingStatus(status)')
    expect(source).toContain("'bg-muted/60")
    expect(source).not.toContain("'bg-success/10")
  })

  it('offers to open resumable chat sessions in a separate native client session', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')

    expect(source).toContain('buildNativeClientSessionInput')
    expect(source).toContain('handleOpenInNativeClient')
    expect(source).toContain('Open in Native Client')
    expect(source).toMatch(
      /reconnectNativeCliSession\(nativeSession, worktreeId, \{[\s\S]*?openModal: false/
    )
  })

  it('ignores Escape that cancels an IME composition instead of closing the modal', () => {
    const source = readSource('src/components/chat/SessionChatModal.tsx')
    const start = source.indexOf('const onEscapeClose = useEffectEvent(')
    const end = source.indexOf('handleClose()', start)
    const onEscapeClose =
      start === -1 || end === -1 ? '' : source.slice(start, end)

    expect(onEscapeClose).toBeTruthy()
    expect(onEscapeClose).toContain('if (isImeComposingEvent(e)) return')
  })
})
