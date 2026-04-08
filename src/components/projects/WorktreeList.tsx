import { useCallback, useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { isBaseSession, type Worktree } from '@/types/projects'
import { useReorderWorktrees } from '@/services/projects'
import { WorktreeItem } from './WorktreeItem'
import { WorktreeItemSkeleton } from './WorktreeItemSkeleton'

interface SortableWorktreeProps {
  worktree: Worktree
  projectId: string
  projectPath: string
  defaultBranch: string
  disabled: boolean
}

function SortableWorktree({
  worktree,
  projectId,
  projectPath,
  defaultBranch,
  disabled,
}: SortableWorktreeProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: worktree.id,
    disabled,
  })

  const style: React.CSSProperties = {
    // Use Translate instead of Transform to avoid scale which affects text rendering
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
  }

  // Pending or deleting worktrees show skeleton
  if (worktree.status === 'pending' || worktree.status === 'deleting') {
    return <WorktreeItemSkeleton worktree={worktree} />
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={disabled ? '' : isDragging ? 'cursor-grabbing' : 'cursor-grab'}
    >
      <WorktreeItem
        worktree={worktree}
        projectId={projectId}
        projectPath={projectPath}
        defaultBranch={defaultBranch}
      />
    </div>
  )
}

interface WorktreeListProps {
  projectId: string
  projectPath: string
  worktrees: Worktree[]
  defaultBranch: string
}

export function WorktreeList({
  projectId,
  projectPath,
  worktrees,
  defaultBranch,
}: WorktreeListProps) {
  const reorderWorktrees = useReorderWorktrees()

  // Sort: base sessions first (order 0), then by order field, then by created_at for items without order
  const sortedWorktrees = useMemo(() => {
    return [...worktrees].sort((a, b) => {
      const aIsBase = isBaseSession(a)
      const bIsBase = isBaseSession(b)
      const aIsPending = a.status === 'pending'
      const bIsPending = b.status === 'pending'

      // Base sessions always come first
      if (aIsBase && !bIsBase) return -1
      if (!aIsBase && bIsBase) return 1

      // Pending worktrees come next (at top for visibility)
      if (aIsPending && !bIsPending) return -1
      if (!aIsPending && bIsPending) return 1

      // Sort by order field (lower = higher in list)
      // If orders are equal, fall back to created_at (newest first)
      if (a.order !== b.order) {
        return a.order - b.order
      }
      return b.created_at - a.created_at
    })
  }, [worktrees])

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

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return

      // Only consider draggable worktrees (not base sessions, pending, or deleting)
      const draggableWorktrees = sortedWorktrees.filter(
        w =>
          !isBaseSession(w) && w.status !== 'pending' && w.status !== 'deleting'
      )

      const oldIndex = draggableWorktrees.findIndex(w => w.id === active.id)
      const newIndex = draggableWorktrees.findIndex(w => w.id === over.id)

      if (oldIndex === -1 || newIndex === -1) return

      const reorderedWorktrees = arrayMove(
        draggableWorktrees,
        oldIndex,
        newIndex
      )
      const worktreeIds = reorderedWorktrees.map(w => w.id)

      reorderWorktrees.mutate({ projectId, worktreeIds })
    },
    [sortedWorktrees, projectId, reorderWorktrees]
  )

  // Get only the draggable worktree IDs for SortableContext
  const draggableIds = sortedWorktrees
    .filter(
      w =>
        !isBaseSession(w) && w.status !== 'pending' && w.status !== 'deleting'
    )
    .map(w => w.id)

  return (
    <div className="ml-2 border-l border-border/40 py-0.5">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={draggableIds}
          strategy={verticalListSortingStrategy}
        >
          {sortedWorktrees.map(worktree => {
            const isDisabled =
              isBaseSession(worktree) ||
              worktree.status === 'pending' ||
              worktree.status === 'deleting'

            return (
              <SortableWorktree
                key={worktree.id}
                worktree={worktree}
                projectId={projectId}
                projectPath={projectPath}
                defaultBranch={defaultBranch}
                disabled={isDisabled}
              />
            )
          })}
        </SortableContext>
      </DndContext>
    </div>
  )
}
