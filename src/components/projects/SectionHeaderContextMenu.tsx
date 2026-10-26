import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

interface SectionHeaderContextMenuProps {
  children: React.ReactNode
  onExpandAll: () => void
  onCollapseAll: () => void
  onExpandCategory: () => void
  onCollapseCategory: () => void
  /** Search forces the section open, so hide/show would not stick. */
  categoryDisabled?: boolean
}

/** Right-click menu for a Folders or Projects section header. */
export function SectionHeaderContextMenu({
  children,
  onExpandAll,
  onCollapseAll,
  onExpandCategory,
  onCollapseCategory,
  categoryDisabled = false,
}: SectionHeaderContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onExpandAll}>Expand all</ContextMenuItem>
        <ContextMenuItem onSelect={onCollapseAll}>Collapse all</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={onExpandCategory}
          disabled={categoryDisabled}
        >
          Expand category
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={onCollapseCategory}
          disabled={categoryDisabled}
        >
          Collapse category
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
