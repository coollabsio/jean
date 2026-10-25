import { toast } from 'sonner'
import {
  Archive,
  Copy,
  Pencil,
  Play,
  RefreshCw,
  Tag,
  Trash2,
} from '@/components/icons/reicon'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { copyToClipboard } from '@/lib/clipboard'
import { canReconnectSession } from '@/services/chat'
import type { Session } from '@/types/chat'

interface SessionContextMenuItemsProps {
  session: Session
  hasLabel: boolean
  resumeCommand: string | null
  nativeClientPending?: boolean
  onRename: () => void
  onToggleLabel: () => void
  onOpenInNativeClient?: () => void
  onReconnect?: () => void
  onArchive: () => void
  onDelete: () => void
}

/**
 * Session right-click actions shared by the worktree tab bar and the sidebar
 * session rows. Keep this as the only item list so the two menus stay aligned.
 */
export function SessionContextMenuItems({
  session,
  hasLabel,
  resumeCommand,
  nativeClientPending = false,
  onRename,
  onToggleLabel,
  onOpenInNativeClient,
  onReconnect,
  onArchive,
  onDelete,
}: SessionContextMenuItemsProps) {
  return (
    <>
      <ContextMenuItem onSelect={onRename}>
        <Pencil className="mr-2 h-4 w-4" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={onToggleLabel}>
        <Tag className="mr-2 h-4 w-4" />
        {hasLabel ? 'Remove Label' : 'Add Label'}
      </ContextMenuItem>
      {resumeCommand && onOpenInNativeClient && (
        <>
          <ContextMenuItem
            disabled={nativeClientPending}
            onSelect={onOpenInNativeClient}
          >
            <Play className="mr-2 h-4 w-4" />
            Open in Native Client
          </ContextMenuItem>
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
      {onReconnect && canReconnectSession(session) && (
        <ContextMenuItem onSelect={onReconnect}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Reconnect
        </ContextMenuItem>
      )}
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
      <ContextMenuItem onSelect={onArchive}>
        <Archive className="mr-2 h-4 w-4" />
        Archive Session
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 className="mr-2 h-4 w-4" />
        Delete Session
      </ContextMenuItem>
    </>
  )
}
