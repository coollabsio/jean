import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Session } from '@/types/chat'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { SessionContextMenuItems } from './SessionContextMenuItems'

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  canReconnectSession: vi.fn(() => false),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: mocks.copyToClipboard,
}))

vi.mock('@/services/chat', () => ({
  canReconnectSession: mocks.canReconnectSession,
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const session = {
  id: 'session-1',
  name: 'Session 2',
  order: 0,
  created_at: 0,
  updated_at: 0,
  messages: [],
} as Session

function renderMenu(
  props: Partial<React.ComponentProps<typeof SessionContextMenuItems>> = {}
) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>Session 2</ContextMenuTrigger>
      <ContextMenuContent>
        <SessionContextMenuItems
          session={session}
          hasLabel={false}
          resumeCommand={null}
          onRename={vi.fn()}
          onToggleLabel={vi.fn()}
          onArchive={vi.fn()}
          onDelete={vi.fn()}
          {...props}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByText('Session 2'))
}

describe('SessionContextMenuItems', () => {
  beforeEach(() => {
    mocks.copyToClipboard.mockReset()
    mocks.copyToClipboard.mockResolvedValue(undefined)
    mocks.canReconnectSession.mockReturnValue(false)
  })

  it('lists the same actions as the worktree session tab menu', () => {
    renderMenu()

    const labels = screen.getAllByRole('menuitem').map(item => item.textContent)
    expect(labels).toEqual([
      'Rename',
      'Add Label',
      'Copy Session ID',
      'Archive Session',
      'Delete Session',
    ])
  })

  it('adds native-client and reconnect actions when the session supports them', () => {
    mocks.canReconnectSession.mockReturnValue(true)
    renderMenu({
      resumeCommand: 'codex resume thread-1',
      onOpenInNativeClient: vi.fn(),
      onReconnect: vi.fn(),
      hasLabel: true,
    })

    const labels = screen.getAllByRole('menuitem').map(item => item.textContent)
    expect(labels).toEqual([
      'Rename',
      'Remove Label',
      'Open in Native Client',
      'Native Resume Command',
      'Reconnect',
      'Copy Session ID',
      'Archive Session',
      'Delete Session',
    ])
  })

  it('is the menu used by both the tab bar and the sidebar', () => {
    for (const path of [
      'src/components/chat/SessionChatModal.tsx',
      'src/components/projects/SidebarSessionContextMenu.tsx',
    ]) {
      expect(readFileSync(path, 'utf8')).toContain('<SessionContextMenuItems')
    }
  })

  it('copies the session id', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('menuitem', { name: 'Copy Session ID' }))
    expect(mocks.copyToClipboard).toHaveBeenCalledWith('session-1')
  })
})
