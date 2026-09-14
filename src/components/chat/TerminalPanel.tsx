import { memo } from 'react'
import { useChatStore } from '@/store/chat-store'
import { TerminalView } from './TerminalView'

interface TerminalPanelProps {
  isCollapsed?: boolean
  onExpand?: () => void
}

/**
 * Memoized wrapper per worktree - prevents re-render when other worktrees change.
 * Uses absolute positioning with visibility for smooth worktree switching.
 * Note: xterm instances persist in terminal-instances.ts module even if components unmount.
 */
const WorktreeTerminals = memo(function WorktreeTerminals({
  worktreeId,
  worktreePath,
  isActive,
  isCollapsed,
  onExpand,
}: {
  worktreeId: string
  worktreePath: string
  isActive: boolean
  isCollapsed?: boolean
  onExpand?: () => void
}) {
  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{
        visibility: isActive ? 'visible' : 'hidden',
        zIndex: isActive ? 1 : 0,
      }}
    >
      <TerminalView
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isCollapsed={isCollapsed}
        isWorktreeActive={isActive}
        onExpand={onExpand}
      />
    </div>
  )
})

/**
 * Container that renders the active worktree's terminal surface only.
 * Switching worktrees detaches the previous renderer; the terminal instance
 * module preserves it when possible and applies a bounded LRU to old stopped
 * renderers, keeping inactive projects from retaining a full xterm DOM tree.
 */
export function TerminalPanel({ isCollapsed, onExpand }: TerminalPanelProps) {
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const worktreePaths = useChatStore(state => state.worktreePaths)
  const activePath = activeWorktreeId
    ? (worktreePaths[activeWorktreeId] ?? activeWorktreePath)
    : null

  return (
    <div className="relative h-full w-full overflow-hidden">
      {activeWorktreeId && activePath ? (
        <WorktreeTerminals
          key={activeWorktreeId}
          worktreeId={activeWorktreeId}
          worktreePath={activePath}
          isActive
          isCollapsed={isCollapsed}
          onExpand={onExpand}
        />
      ) : null}
    </div>
  )
}
