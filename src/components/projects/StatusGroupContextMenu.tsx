import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface StatusGroupContextMenuProps {
  allExpanded: boolean
  onToggleAll: () => void
  children: React.ReactNode
}

/**
 * Right-click a session status header (Running, Review, …) to expand or
 * collapse every worktree in the project. Archive/Delete all is intentionally
 * absent: there is no existing bulk session removal that confirms safely.
 */
export function StatusGroupContextMenu({
  allExpanded,
  onToggleAll,
  children,
}: StatusGroupContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={onToggleAll}>
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
