import {
  Archive,
  Copy,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Tag,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { useChatStore } from '@/store/chat-store'
import { copyToClipboard } from '@/lib/clipboard'
import { canReconnectSession, reconnectNativeCliSession } from '@/services/chat'
import type { Session } from '@/types/chat'
import { SessionStatusMenu } from './SessionStatusMenu'
import {
  getResumeCommand,
  type ManualSessionStatus,
  type SessionCardData,
} from './session-card-utils'

interface SessionContextMenuItemsProps {
  card: SessionCardData
  worktreeId: string
  onRename: (sessionId: string, currentName: string) => void
  onToggleLabel: (sessionId: string) => void
  onArchive: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  /** Optional host-provided native-client launcher (canvas tab bar only). */
  onOpenInNativeClient?: (session: Session) => void
  /** Disables the native-client item while the host is creating a session. */
  openInNativeClientDisabled?: boolean
  /** Tailwind width class for the menu content (defaults to w-64). */
  contentClassName?: string
}

/**
 * Canonical session context menu — shared by the canvas session tab bar
 * (SessionChatModal) and the sidebar worktree session rows (WorktreeItem).
 * Status/Pause/Resume/Reconnect are self-contained; rename/label/archive/delete
 * are delegated to the host so each surface can wire its own UI (inline rename,
 * label modal, archive confirmation, etc.).
 */
export function SessionContextMenuItems({
  card,
  worktreeId,
  onRename,
  onToggleLabel,
  onArchive,
  onDelete,
  onOpenInNativeClient,
  openInNativeClientDisabled = false,
  contentClassName = 'w-64',
}: SessionContextMenuItemsProps) {
  const session = card.session
  const isPausedOverride = card.statusOverride === 'paused'
  const hasLabel = useChatStore(state => !!state.sessionLabels[session.id])
  const resumeCommand = getResumeCommand(session)

  return (
    <ContextMenuContent className={contentClassName}>
      <ContextMenuItem onSelect={() => onRename(session.id, session.name)}>
        <Pencil className="mr-2 h-4 w-4" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onToggleLabel(session.id)}>
        <Tag className="mr-2 h-4 w-4" />
        {hasLabel ? 'Remove Label' : 'Add Label'}
      </ContextMenuItem>
      <SessionStatusMenu
        statusOverride={card.statusOverride}
        automaticStatus={card.automaticStatus}
        onSetStatusOverride={(next: ManualSessionStatus | null) => {
          useChatStore.getState().setSessionStatusOverride(session.id, next)
        }}
      />
      <ContextMenuItem
        // Quick toggle for the 'paused' override that the Set Status submenu
        // also exposes. Live states still outrank it visually, but the override
        // is remembered and applies once the session goes idle.
        onSelect={() => {
          useChatStore
            .getState()
            .setSessionPaused(session.id, !isPausedOverride)
        }}
      >
        {isPausedOverride ? (
          <>
            <Play className="mr-2 h-4 w-4" />
            Unpause
          </>
        ) : (
          <>
            <Pause className="mr-2 h-4 w-4" />
            Mark as Paused
          </>
        )}
      </ContextMenuItem>
      {resumeCommand && (
        <>
          {onOpenInNativeClient && (
            <ContextMenuItem
              disabled={openInNativeClientDisabled}
              onSelect={() => onOpenInNativeClient(session)}
            >
              <Play className="mr-2 h-4 w-4" />
              Open in Native Client
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onSelect={() => {
              void copyToClipboard(resumeCommand)
                .then(() => toast.success('Resume command copied'))
                .catch(() => toast.error('Failed to copy resume command'))
            }}
          >
            <Copy className="mr-2 h-4 w-4" />
            Native Resume Command
          </ContextMenuItem>
        </>
      )}
      {canReconnectSession(session) && (
        <ContextMenuItem
          onSelect={() => void reconnectNativeCliSession(session, worktreeId)}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Reconnect
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onArchive(session.id)}>
        <Archive className="mr-2 h-4 w-4" />
        Archive Session
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          void copyToClipboard(session.id)
            .then(() => toast.success('Session ID copied'))
            .catch(() => toast.error('Failed to copy session ID'))
        }}
      >
        <Copy className="mr-2 h-4 w-4" />
        Copy Session ID
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => onDelete(session.id)}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        Delete Session
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/**
 * Dismiss any open Radix context menu before a new one opens. Radix
 * `ContextMenu.Root` is uncontrolled (no `open` prop), so we cannot force-close
 * a sibling menu directly. Dispatching a primary-button `pointerdown` on the
 * document fires every open DismissableLayer's `onPointerDownOutside`, closing
 * them — without triggering Escape handlers (which would close the host modal).
 * Wire to `onContextMenuCapture` on each trigger so it runs before the new
 * menu's contextmenu handler.
 */
export function closeOpenSessionContextMenus() {
  document.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 })
  )
}
