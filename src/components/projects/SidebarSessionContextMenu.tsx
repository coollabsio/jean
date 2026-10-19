import { useState, type ReactNode } from 'react'
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useOpenInNativeClient } from '@/components/chat/hooks/useOpenInNativeClient'
import { getResumeCommand } from '@/components/chat/session-card-utils'
import { canReconnectSession, reconnectNativeCliSession } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import { copyToClipboard } from '@/lib/clipboard'
import type { Session } from '@/types/chat'

interface SidebarSessionContextMenuProps {
  session: Session
  worktreeId: string
  worktreePath: string
  onRename: (session: Session) => void
  onLabel: (sessionId: string) => void
  onArchive: (session: Session) => void
  onDelete: (session: Session) => void
  children: ReactNode
}

/** Session context menu for sidebar rows; mirrors the session tab menu. */
export function SidebarSessionContextMenu({
  children,
  ...props
}: SidebarSessionContextMenuProps) {
  const [open, setOpen] = useState(false)
  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {open && <SidebarSessionContextMenuContent {...props} />}
    </ContextMenu>
  )
}

// Mounted only while open so collapsed rows don't run per-row hooks.
function SidebarSessionContextMenuContent({
  session,
  worktreeId,
  worktreePath,
  onRename,
  onLabel,
  onArchive,
  onDelete,
}: Omit<SidebarSessionContextMenuProps, 'children'>) {
  const hasLabel = useChatStore(state => !!state.sessionLabels[session.id])
  const { openInNativeClient, isPending } = useOpenInNativeClient(
    worktreeId,
    worktreePath
  )
  const resumeCommand = getResumeCommand(session)

  return (
    <ContextMenuContent className="w-64">
      <ContextMenuItem onSelect={() => onRename(session)}>
        <Pencil className="mr-2 h-4 w-4" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onLabel(session.id)}>
        <Tag className="mr-2 h-4 w-4" />
        {hasLabel ? 'Remove Label' : 'Add Label'}
      </ContextMenuItem>
      {resumeCommand && (
        <>
          <ContextMenuItem
            disabled={isPending}
            onSelect={() => openInNativeClient(session)}
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
      {canReconnectSession(session) && (
        <ContextMenuItem
          onSelect={() => void reconnectNativeCliSession(session, worktreeId)}
        >
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
      <ContextMenuItem onSelect={() => onArchive(session)}>
        <Archive className="mr-2 h-4 w-4" />
        Archive Session
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => onDelete(session)}>
        <Trash2 className="mr-2 h-4 w-4" />
        Delete Session
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
