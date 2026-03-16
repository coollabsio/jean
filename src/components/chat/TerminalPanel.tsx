import { memo, useMemo } from 'react'
import { useTerminalStore } from '@/store/terminal-store'
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
 * Container that renders terminals for ALL worktrees, showing only the active one.
 * This keeps terminals mounted across worktree switches, preserving:
 * - xterm.js output buffer
 * - Running processes
 * - Scroll position
 */
export function TerminalPanel({ isCollapsed, onExpand }: TerminalPanelProps) {
  // Subscribe to terminals object (stable reference when unchanged)
  const terminals = useTerminalStore(state => state.terminals)
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const activeWorktreePath = useChatStore(state => state.activeWorktreePath)
  const worktreePaths = useChatStore(state => state.worktreePaths)

  // Memoize worktree IDs to render - include active even if no terminals yet
  // (TerminalView auto-creates first terminal on mount)
  const worktreeIdsToRender = useMemo(() => {
    const ids = new Set(Object.keys(terminals))
    if (activeWorktreeId) {
      ids.add(activeWorktreeId)
    }
    return Array.from(ids)
  }, [terminals, activeWorktreeId])

  return (
    <div className="relative h-full w-full overflow-hidden">
      {worktreeIdsToRender.map(worktreeId => {
        const path =
          worktreePaths[worktreeId] ??
          (worktreeId === activeWorktreeId ? activeWorktreePath : undefined)
        if (!path) return null

        return (
          <WorktreeTerminals
            key={worktreeId}
            worktreeId={worktreeId}
            worktreePath={path}
            isActive={worktreeId === activeWorktreeId}
            isCollapsed={isCollapsed}
            onExpand={onExpand}
          />
        )
      })}
    </div>
  )
}
