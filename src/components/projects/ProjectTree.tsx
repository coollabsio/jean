import { useCallback, useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { Folder } from 'lucide-react'
import { isFolder, type Project } from '@/types/projects'
import { ProjectTreeItem } from './ProjectTreeItem'
import { FolderTreeItem } from './FolderTreeItem'
import { useReorderItems, useMoveItem } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

const MAX_NESTING_DEPTH = 3

function getDepth(projects: Project[], itemId: string): number {
  let depth = 0
  let current = projects.find(p => p.id === itemId)
  while (current?.parent_id) {
    depth++
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    current = projects.find(p => p.id === current!.parent_id)
  }
  return depth
}

function getMaxSubtreeDepth(projects: Project[], itemId: string): number {
  const children = projects.filter(p => p.parent_id === itemId)
  if (children.length === 0) return 0
  return 1 + Math.max(...children.map(c => getMaxSubtreeDepth(projects, c.id)))
}

interface ProjectTreeProps {
  projects: Project[]
}

// Helper to flatten all items for a single SortableContext
function flattenItems(projects: Project[]): string[] {
  const result: string[] = []

  function addItems(parentId: string | undefined) {
    const items = projects
      .filter(p => p.parent_id === parentId)
      .sort((a, b) => {
        if (isFolder(a) && !isFolder(b)) return -1
        if (!isFolder(a) && isFolder(b)) return 1
        return a.order - b.order
      })

    for (const item of items) {
      result.push(item.id)
      if (isFolder(item)) {
        addItems(item.id)
      }
    }
  }

  addItems(undefined)
  return result
}

// Insertion line shown above an item to indicate reorder drop position
function InsertionIndicator() {
  return <div className="h-0.5 mx-2 bg-primary/60 rounded-full" />
}

interface SortableItemProps {
  item: Project
  allProjects: Project[]
  depth: number
  isOverFolder: boolean
  expandedFolderIds: Set<string>
  overFolderId: string | null
  insertBeforeId: string | null
}

function SortableItem({
  item,
  allProjects,
  depth,
  isOverFolder,
  expandedFolderIds,
  overFolderId,
  insertBeforeId,
}: SortableItemProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: item.id,
  })

  const style: React.CSSProperties = {
    opacity: isDragging ? 0.3 : 1,
    paddingLeft: depth > 0 ? `${depth * 12}px` : undefined,
  }

  const showInsertBefore = insertBeforeId === item.id
  const showInsertAfter = insertBeforeId === `after:${item.id}`

  if (isFolder(item)) {
    const isExpanded = expandedFolderIds.has(item.id)

    return (
      <>
        {showInsertBefore && <InsertionIndicator />}
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          className={isDragging ? 'cursor-grabbing' : 'cursor-grab'}
        >
          <FolderTreeItem
            folder={item}
            depth={depth}
            isDropTarget={isOverFolder}
          >
            {isExpanded && (
              <NestedItems
                projects={allProjects}
                parentId={item.id}
                depth={depth + 1}
                expandedFolderIds={expandedFolderIds}
                overFolderId={overFolderId}
                insertBeforeId={insertBeforeId}
              />
            )}
          </FolderTreeItem>
        </div>
        {showInsertAfter && <InsertionIndicator />}
      </>
    )
  }

  return (
    <>
      {showInsertBefore && <InsertionIndicator />}
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className={isDragging ? 'cursor-grabbing' : 'cursor-grab'}
      >
        <ProjectTreeItem project={item} />
      </div>
      {showInsertAfter && <InsertionIndicator />}
    </>
  )
}

// Renders nested items (children of a folder) - they are draggable via the parent SortableContext
interface NestedItemsProps {
  projects: Project[]
  parentId: string
  depth: number
  expandedFolderIds: Set<string>
  overFolderId: string | null
  insertBeforeId: string | null
}

function NestedItems({
  projects,
  parentId,
  depth,
  expandedFolderIds,
  overFolderId,
  insertBeforeId,
}: NestedItemsProps) {
  const items = projects
    .filter(p => p.parent_id === parentId)
    .sort((a, b) => {
      if (isFolder(a) && !isFolder(b)) return -1
      if (!isFolder(a) && isFolder(b)) return 1
      return a.order - b.order
    })

  return (
    <>
      {items.map(item => (
        <SortableItem
          key={item.id}
          item={item}
          allProjects={projects}
          depth={depth}
          isOverFolder={overFolderId === item.id}
          expandedFolderIds={expandedFolderIds}
          overFolderId={overFolderId}
          insertBeforeId={insertBeforeId}
        />
      ))}
    </>
  )
}

// Drop zone at the bottom to move items to root level
function RootDropZone({ isOver }: { isOver: boolean }) {
  const { setNodeRef } = useDroppable({ id: 'root-drop-zone' })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mx-2 mt-1 rounded border-2 border-dashed transition-colors flex items-center justify-center py-2',
        isOver ? 'border-primary/50 bg-primary/5' : 'border-muted-foreground/25'
      )}
    >
      <span className="text-[11px] text-muted-foreground/50 select-none">
        Drop here to move to root level
      </span>
    </div>
  )
}

export function ProjectTree({ projects }: ProjectTreeProps) {
  const reorderItems = useReorderItems()
  const moveItem = useMoveItem()
  const { expandFolder, expandedFolderIds } = useProjectsStore()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overFolderId, setOverFolderId] = useState<string | null>(null)
  const [isOverRoot, setIsOverRoot] = useState(false)
  const [insertBeforeId, setInsertBeforeId] = useState<string | null>(null)

  const activeItem = useMemo(
    () => (activeId ? projects.find(p => p.id === activeId) : null),
    [activeId, projects]
  )

  // Root level items split into folders and standalone projects
  const rootItems = projects.filter(p => p.parent_id === undefined)
  const rootFolders = rootItems
    .filter(isFolder)
    .sort((a, b) => a.order - b.order)
  const rootProjects = rootItems
    .filter(p => !isFolder(p))
    .sort((a, b) => a.order - b.order)
  const hasBothTypes = rootFolders.length > 0 && rootProjects.length > 0

  // All items flattened for the SortableContext
  const allItemIds = flattenItems(projects)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }, [])

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { over, active } = event
      if (!over) {
        setOverFolderId(null)
        setIsOverRoot(false)
        setInsertBeforeId(null)
        return
      }

      // Check if over the root drop zone
      if (over.id === 'root-drop-zone') {
        setOverFolderId(null)
        setIsOverRoot(true)
        setInsertBeforeId(null)
        return
      }

      setIsOverRoot(false)

      const overItem = projects.find(p => p.id === over.id)
      const activeItemObj = projects.find(p => p.id === activeId)

      // Check if dragging over a folder (skip if at max depth)
      if (overItem && isFolder(overItem) && activeId !== over.id) {
        const folderDepth = getDepth(projects, overItem.id)
        const subtreeDepth =
          activeItemObj && isFolder(activeItemObj)
            ? getMaxSubtreeDepth(projects, activeItemObj.id)
            : 0
        if (folderDepth + 1 + subtreeDepth <= MAX_NESTING_DEPTH) {
          setOverFolderId(over.id as string)
          setInsertBeforeId(null)
        } else {
          setOverFolderId(null)
          setInsertBeforeId(null)
        }
        return
      }

      setOverFolderId(null)

      // Show insertion indicator for same-level reorder
      if (
        overItem &&
        activeItemObj &&
        over.id !== active.id &&
        !isFolder(overItem)
      ) {
        // Determine insert position based on dragged item center vs over item center
        const activeRect = active.rect.current.translated
        const overRect = over.rect
        const activeCenter = activeRect
          ? activeRect.top + activeRect.height / 2
          : 0
        const overCenter = overRect.top + overRect.height / 2

        // Get siblings at the over item's level
        const siblings = projects
          .filter(p => p.parent_id === overItem.parent_id && p.id !== active.id)
          .sort((a, b) => {
            if (isFolder(a) && !isFolder(b)) return -1
            if (!isFolder(a) && isFolder(b)) return 1
            return a.order - b.order
          })
        const overIndex = siblings.findIndex(p => p.id === over.id)

        if (activeCenter < overCenter) {
          // Insert before the over item
          setInsertBeforeId(over.id as string)
        } else {
          // Insert after: show indicator after this item
          const nextItem = siblings[overIndex + 1]
          setInsertBeforeId(nextItem ? nextItem.id : `after:${over.id}`)
        }
      } else if (!overItem || !isFolder(overItem)) {
        setInsertBeforeId(null)
      }
    },
    [projects, activeId]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      setOverFolderId(null)
      setIsOverRoot(false)
      setInsertBeforeId(null)

      if (!over) return

      const activeItem = projects.find(p => p.id === active.id)
      if (!activeItem) return

      // Dropping on root drop zone = move to root
      if (over.id === 'root-drop-zone') {
        if (activeItem.parent_id !== undefined) {
          moveItem.mutate({
            itemId: active.id as string,
            newParentId: undefined,
          })
        }
        return
      }

      const overItem = projects.find(p => p.id === over.id)

      // Helper to get sorted siblings at a level (excluding item being moved)
      const getSiblings = (parentId: string | undefined, excludeId: string) =>
        projects
          .filter(p => p.parent_id === parentId && p.id !== excludeId)
          .sort((a, b) => {
            if (isFolder(a) && !isFolder(b)) return -1
            if (!isFolder(a) && isFolder(b)) return 1
            return a.order - b.order
          })

      // Dropping onto a folder = move into it (at the end)
      if (
        overItem &&
        isFolder(overItem) &&
        active.id !== over.id &&
        activeItem.parent_id !== over.id
      ) {
        // Prevent exceeding max nesting depth
        const folderDepth = getDepth(projects, overItem.id)
        const subtreeDepth = isFolder(activeItem)
          ? getMaxSubtreeDepth(projects, activeItem.id)
          : 0
        if (folderDepth + 1 + subtreeDepth > MAX_NESTING_DEPTH) return

        // Prevent moving folder into itself or descendants
        if (isFolder(activeItem)) {
          let currentParent = overItem.parent_id
          while (currentParent) {
            if (currentParent === active.id) {
              return
            }
            const parent = projects.find(p => p.id === currentParent)
            currentParent = parent?.parent_id
          }
        }

        moveItem.mutate({
          itemId: active.id as string,
          newParentId: over.id as string,
          // No targetIndex = append at end
        })
        expandFolder(over.id as string)
        return
      }

      // Same item - no action
      if (active.id === over.id) return

      // If dropping on an item at a different level, move to that level at the drop position
      if (overItem && activeItem.parent_id !== overItem.parent_id) {
        const targetParentId = overItem.parent_id
        const siblings = getSiblings(targetParentId, active.id as string)
        const overIndex = siblings.findIndex(p => p.id === over.id)
        const targetIndex = overIndex === -1 ? siblings.length : overIndex

        moveItem.mutate({
          itemId: active.id as string,
          newParentId: targetParentId,
          targetIndex,
        })
        return
      }

      // Same-level reorder
      if (overItem && activeItem.parent_id === overItem.parent_id) {
        // Recalculate insert position based on center-point (same logic as handleDragOver)
        const activeRect = active.rect.current.translated
        const overRect = over.rect
        const activeCenter = activeRect
          ? activeRect.top + activeRect.height / 2
          : 0
        const overCenter = overRect.top + overRect.height / 2
        const insertAfter = activeCenter >= overCenter

        const parentId = activeItem.parent_id
        const siblings = projects
          .filter(p => p.parent_id === parentId)
          .sort((a, b) => {
            if (isFolder(a) && !isFolder(b)) return -1
            if (!isFolder(a) && isFolder(b)) return 1
            return a.order - b.order
          })

        const oldIndex = siblings.findIndex(p => p.id === active.id)
        let newIndex = siblings.findIndex(p => p.id === over.id)

        if (oldIndex === -1 || newIndex === -1) return

        // Adjust for insert-after when dragging UP (oldIndex > newIndex)
        // arrayMove places item AT newIndex, but indicator showed AFTER the target
        if (insertAfter && oldIndex > newIndex) {
          newIndex += 1
        }

        if (oldIndex === newIndex) return

        const reorderedItems = arrayMove(siblings, oldIndex, newIndex)
        const itemIds = reorderedItems.map(p => p.id)

        reorderItems.mutate({ itemIds, parentId })
      }
    },
    [projects, reorderItems, moveItem, expandFolder]
  )

  return (
    <div className="py-1">
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {rootFolders.length > 0 && (
          <div className="px-3 pb-1 pt-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
              Folders
            </span>
          </div>
        )}
        <SortableContext
          items={allItemIds}
          strategy={verticalListSortingStrategy}
        >
          {rootFolders.map(item => (
            <SortableItem
              key={item.id}
              item={item}
              allProjects={projects}
              depth={0}
              isOverFolder={overFolderId === item.id}
              expandedFolderIds={expandedFolderIds}
              overFolderId={overFolderId}
              insertBeforeId={insertBeforeId}
            />
          ))}
          {hasBothTypes && (
            <div className="px-3 py-2">
              <Separator />
            </div>
          )}
          {rootProjects.length > 0 && (
            <div className="px-3 pb-1 pt-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                Projects
              </span>
            </div>
          )}
          {rootProjects.map(item => (
            <SortableItem
              key={item.id}
              item={item}
              allProjects={projects}
              depth={0}
              isOverFolder={false}
              expandedFolderIds={expandedFolderIds}
              overFolderId={overFolderId}
              insertBeforeId={insertBeforeId}
            />
          ))}
        </SortableContext>

        {/* Root drop zone - visible when dragging an item that's inside a folder */}
        {activeId &&
          projects.find(p => p.id === activeId)?.parent_id !== undefined && (
            <RootDropZone isOver={isOverRoot} />
          )}

        <DragOverlay dropAnimation={null}>
          {activeItem && (
            <div className="rounded bg-accent px-3 py-1.5 text-sm font-medium shadow-md flex items-center gap-1.5 opacity-90">
              {isFolder(activeItem) && (
                <Folder className="size-3.5 text-muted-foreground" />
              )}
              {!isFolder(activeItem) && (
                <div className="flex size-4 shrink-0 items-center justify-center rounded bg-muted-foreground/20">
                  <span className="text-[10px] font-medium uppercase">
                    {activeItem.name[0]}
                  </span>
                </div>
              )}
              <span className="truncate">{activeItem.name}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
