import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  attachClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
import { isBaseSession, type Worktree } from '@/types/projects'
import type { WorktreeSessions } from '@/types/chat'
import { invoke } from '@/lib/transport'
import { cn } from '@/lib/utils'
import { chatQueryKeys } from '@/services/chat'
import { isTauri, useReorderWorktrees } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import {
  compareWorktreesForCanvasSort,
  getWorktreeLastActivity,
} from './worktree-sort-utils'
import { WorktreeItem } from './WorktreeItem'
import { WorktreeItemSkeleton } from './WorktreeItemSkeleton'
import {
  DRAG_SCOPE_WORKTREE_LIST,
  isWorktreeDragData,
} from '@/lib/drag-and-drop/types'
import { reorderWithClosestEdge } from '@/lib/drag-and-drop/reorder'
import { announceDrag } from '@/lib/drag-and-drop/live-region'
import { DropIndicator } from '@/components/drag-and-drop/DropIndicator'
import {
  applyWorktreeDropSnapshot,
  emptyWorktreeDropSnapshot,
  getSnapshotFromWorktreeDropTarget,
  getSnapshotFromWorktreeElement,
  getWorktreeDropTargetForScope,
  getWorktreeElementFromEventTarget,
  getWorktreeElementFromPoint,
  type WorktreeDropSnapshot,
  type WorktreeReorderDragState,
} from '@/lib/drag-and-drop/worktree-reorder-ux'

interface SortableWorktreeProps {
  worktree: Worktree
  projectId: string
  projectPath: string
  defaultBranch: string
  disabled: boolean
  isDragging: boolean
  closestEdge: Edge | null
}

function SortableWorktree({
  worktree,
  projectId,
  projectPath,
  defaultBranch,
  disabled,
  isDragging,
  closestEdge,
}: SortableWorktreeProps) {
  const elementRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (
      !element ||
      worktree.status === 'pending' ||
      worktree.status === 'deleting'
    ) {
      return
    }

    const cleanupFns = [
      dropTargetForElements({
        element,
        canDrop: ({ source }) => {
          return (
            !disabled &&
            isWorktreeDragData(source.data) &&
            source.data.projectId === projectId &&
            source.data.scope === DRAG_SCOPE_WORKTREE_LIST &&
            source.data.worktreeId !== worktree.id
          )
        },
        getData: ({ input, element }) => {
          return attachClosestEdge(
            {
              type: 'worktree-section',
              projectId,
              worktreeId: worktree.id,
              scope: DRAG_SCOPE_WORKTREE_LIST,
            },
            {
              input,
              element,
              allowedEdges: ['top', 'bottom'],
            }
          )
        },
      }),
    ]

    if (!disabled) {
      cleanupFns.push(
        draggable({
          element,
          canDrag: () => !disabled,
          getInitialData: () => ({
            type: 'worktree-section',
            projectId,
            worktreeId: worktree.id,
            scope: DRAG_SCOPE_WORKTREE_LIST,
          }),
        })
      )
    }

    return combine(...cleanupFns)
  }, [disabled, projectId, worktree.id, worktree.status])

  // Pending or deleting worktrees show skeleton
  if (worktree.status === 'pending' || worktree.status === 'deleting') {
    return <WorktreeItemSkeleton worktree={worktree} />
  }

  return (
    <div
      ref={elementRef}
      data-pdnd-worktree-id={worktree.id}
      data-pdnd-worktree-scope={DRAG_SCOPE_WORKTREE_LIST}
      className={cnWorktreeDragClass(disabled, isDragging)}
    >
      <DropIndicator edge={closestEdge} insetClassName="left-2 right-2" />
      <WorktreeItem
        worktree={worktree}
        projectId={projectId}
        projectPath={projectPath}
        defaultBranch={defaultBranch}
      />
    </div>
  )
}

function cnWorktreeDragClass(disabled: boolean, isDragging: boolean) {
  return cn(
    'relative transition-opacity',
    disabled
      ? undefined
      : isDragging
        ? 'cursor-grabbing opacity-40'
        : 'cursor-grab'
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
  const worktreeSortMode = useProjectsStore(
    state =>
      state.projectCanvasSettings[projectId]?.worktreeSortMode ?? 'created'
  )

  const pendingWorktrees = useMemo(
    () => worktrees.filter(w => w.status === 'pending'),
    [worktrees]
  )
  const readyWorktrees = useMemo(
    () =>
      worktrees.filter(
        w => !w.status || w.status === 'ready' || w.status === 'error'
      ),
    [worktrees]
  )

  const sessionQueries = useQueries({
    queries: readyWorktrees.map(wt => ({
      queryKey: [...chatQueryKeys.sessions(wt.id), 'with-counts'],
      queryFn: async (): Promise<WorktreeSessions> => {
        if (!isTauri() || !wt.id || !wt.path) {
          return {
            worktree_id: wt.id,
            sessions: [],
            active_session_id: null,
            version: 2,
          }
        }
        return invoke<WorktreeSessions>('get_sessions', {
          worktreeId: wt.id,
          worktreePath: wt.path,
          includeMessageCounts: true,
        })
      },
      enabled: !!wt.id && !!wt.path,
      // Prefer bootstrap/init-seeded cache; avoid N-way WS refetch on open
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 5,
    })),
  })

  const sessionsFingerprint = sessionQueries
    .map(q => `${q.data?.worktree_id}:${q.dataUpdatedAt}:${q.isLoading}`)
    .join('|')

  const sessionsByWorktreeId = useMemo(() => {
    const map = new Map<string, WorktreeSessions>()
    for (const query of sessionQueries) {
      if (query.data?.worktree_id) {
        map.set(query.data.worktree_id, query.data)
      }
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsFingerprint])

  // Match ProjectCanvasView ordering: pending first, then base session first,
  // then selected canvas sort mode using session last activity when requested.
  const sortedWorktrees = useMemo(() => {
    const latestActivityByWorktreeId = new Map<string, number>()
    for (const worktree of pendingWorktrees) {
      latestActivityByWorktreeId.set(worktree.id, worktree.created_at)
    }
    for (const worktree of readyWorktrees) {
      const sessions = sessionsByWorktreeId.get(worktree.id)?.sessions ?? []
      latestActivityByWorktreeId.set(
        worktree.id,
        getWorktreeLastActivity(sessions, worktree.created_at)
      )
    }

    const sortedPending = [...pendingWorktrees].sort(
      (a, b) => b.created_at - a.created_at
    )
    const sortedReady = [...readyWorktrees].sort((a, b) =>
      compareWorktreesForCanvasSort(
        a,
        b,
        latestActivityByWorktreeId,
        worktreeSortMode
      )
    )

    return [...sortedPending, ...sortedReady]
  }, [pendingWorktrees, readyWorktrees, sessionsByWorktreeId, worktreeSortMode])

  const canReorderWorktree = useCallback((worktree: Worktree) => {
    return (
      !isBaseSession(worktree) &&
      (!worktree.status ||
        worktree.status === 'ready' ||
        worktree.status === 'error')
    )
  }, [])

  const worktreeById = useMemo(
    () => new Map(sortedWorktrees.map(worktree => [worktree.id, worktree])),
    [sortedWorktrees]
  )

  const draggableIds = useMemo(
    () =>
      sortedWorktrees.flatMap(worktree =>
        canReorderWorktree(worktree) ? [worktree.id] : []
      ),
    [canReorderWorktree, sortedWorktrees]
  )

  const draggableIdSet = useMemo(() => new Set(draggableIds), [draggableIds])
  const [dragState, setDragState] = useState<WorktreeReorderDragState>({
    draggingId: null,
    targetId: null,
    closestEdge: null,
  })
  const latestDropTargetRef = useRef<WorktreeDropSnapshot>(
    emptyWorktreeDropSnapshot
  )
  const dragStateRef = useRef(dragState)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  const getWorktreeDropTarget = useCallback(
    (dropTargets: { data: Record<string | symbol, unknown> }[]) =>
      getWorktreeDropTargetForScope(dropTargets, DRAG_SCOPE_WORKTREE_LIST),
    []
  )

  const reorderFromDrop = useCallback(
    (activeId: string, overId: string, closestEdge: Edge | null) => {
      if (activeId === overId) return

      const oldIndex = draggableIds.indexOf(activeId)
      const newIndex = draggableIds.indexOf(overId)

      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return

      const reorderedDraggableIds = reorderWithClosestEdge({
        items: draggableIds,
        startIndex: oldIndex,
        indexOfTarget: newIndex,
        closestEdgeOfTarget: closestEdge,
      })
      const nextDraggableIds = [...reorderedDraggableIds]
      const fullOrderedIds = sortedWorktrees.map(worktree => {
        if (!draggableIdSet.has(worktree.id)) return worktree.id
        return nextDraggableIds.shift() ?? worktree.id
      })

      reorderWorktrees.mutate({
        projectId,
        worktreeIds: fullOrderedIds.filter(id => {
          const worktree = worktreeById.get(id)
          return (
            worktree != null &&
            (isBaseSession(worktree) || canReorderWorktree(worktree))
          )
        }),
        switchToManualSort: worktreeSortMode !== 'manual',
      })

      announceDrag('Worktree reordered')
    },
    [
      canReorderWorktree,
      draggableIdSet,
      draggableIds,
      projectId,
      reorderWorktrees,
      sortedWorktrees,
      worktreeById,
      worktreeSortMode,
    ]
  )

  const nativeDropHandledRef = useRef(false)

  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) =>
        isWorktreeDragData(source.data) &&
        source.data.projectId === projectId &&
        source.data.scope === DRAG_SCOPE_WORKTREE_LIST,
      onDragStart: ({ source }) => {
        if (!isWorktreeDragData(source.data)) return
        latestDropTargetRef.current = emptyWorktreeDropSnapshot
        setDragState({
          draggingId: source.data.worktreeId,
          targetId: null,
          closestEdge: null,
        })
        announceDrag('Started dragging worktree')
      },
      onDropTargetChange: ({ location }) => {
        const snapshot = getSnapshotFromWorktreeDropTarget(
          getWorktreeDropTarget(location.current.dropTargets)
        )
        latestDropTargetRef.current = snapshot
        setDragState(state => applyWorktreeDropSnapshot(state, snapshot))
      },
      onDrag: ({ location }) => {
        const snapshot = getSnapshotFromWorktreeDropTarget(
          getWorktreeDropTarget(location.current.dropTargets)
        )
        latestDropTargetRef.current = snapshot
        setDragState(state => applyWorktreeDropSnapshot(state, snapshot))
      },
      onDrop: ({ source, location }) => {
        if (nativeDropHandledRef.current) {
          nativeDropHandledRef.current = false
          return
        }
        setDragState({ draggingId: null, targetId: null, closestEdge: null })
        if (!isWorktreeDragData(source.data)) return
        const targetSnapshot = getSnapshotFromWorktreeDropTarget(
          getWorktreeDropTarget(location.current.dropTargets)
        )
        const fallback = latestDropTargetRef.current
        const snapshot = targetSnapshot.targetId ? targetSnapshot : fallback
        latestDropTargetRef.current = emptyWorktreeDropSnapshot
        const { targetId, closestEdge } = snapshot
        if (!targetId) {
          announceDrag('Worktree move cancelled')
          return
        }
        reorderFromDrop(source.data.worktreeId, targetId, closestEdge)
      },
    })
  }, [getWorktreeDropTarget, projectId, reorderFromDrop])

  const handleNativeDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dragState.draggingId) return
      const target = getWorktreeElementFromEventTarget({
        eventTarget: event.target,
        scope: DRAG_SCOPE_WORKTREE_LIST,
      })
      const snapshot = getSnapshotFromWorktreeElement({
        element: target,
        draggingId: dragState.draggingId,
        clientY: event.clientY,
      })
      if (!snapshot.targetId) return

      event.preventDefault()
      latestDropTargetRef.current = snapshot
      setDragState(state => applyWorktreeDropSnapshot(state, snapshot))
    },
    [dragState.draggingId]
  )

  const handleNativeDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dragState.draggingId) return
      event.preventDefault()
      event.stopPropagation()
      const fallback = latestDropTargetRef.current
      nativeDropHandledRef.current = true
      setDragState({ draggingId: null, targetId: null, closestEdge: null })
      latestDropTargetRef.current = emptyWorktreeDropSnapshot
      if (fallback.targetId) {
        reorderFromDrop(
          dragState.draggingId,
          fallback.targetId,
          fallback.closestEdge
        )
      }
    },
    [dragState.draggingId, reorderFromDrop]
  )

  const handleNativeDragEnd = useCallback(() => {
    latestDropTargetRef.current = emptyWorktreeDropSnapshot
    setDragState({ draggingId: null, targetId: null, closestEdge: null })
  }, [])

  useEffect(() => {
    const handleDocumentDragOver = (event: DragEvent) => {
      const draggingId = dragStateRef.current.draggingId
      if (!draggingId) return
      const target = getWorktreeElementFromPoint({
        clientX: event.clientX,
        clientY: event.clientY,
        scope: DRAG_SCOPE_WORKTREE_LIST,
      })
      const snapshot = getSnapshotFromWorktreeElement({
        element: target,
        draggingId,
        clientY: event.clientY,
      })
      if (!snapshot.targetId) return

      event.preventDefault()
      latestDropTargetRef.current = snapshot
      setDragState(state => applyWorktreeDropSnapshot(state, snapshot))
    }

    const handleDocumentDrop = (event: DragEvent) => {
      const draggingId = dragStateRef.current.draggingId
      if (!draggingId) return
      const fallback = latestDropTargetRef.current
      if (!fallback.targetId) return
      event.preventDefault()
      event.stopPropagation()
      nativeDropHandledRef.current = true
      setDragState({ draggingId: null, targetId: null, closestEdge: null })
      latestDropTargetRef.current = emptyWorktreeDropSnapshot
      reorderFromDrop(draggingId, fallback.targetId, fallback.closestEdge)
    }

    const handleDocumentDragEnd = () => {
      if (!dragStateRef.current.draggingId) return
      latestDropTargetRef.current = emptyWorktreeDropSnapshot
      setDragState({ draggingId: null, targetId: null, closestEdge: null })
    }

    document.addEventListener('dragover', handleDocumentDragOver, true)
    document.addEventListener('drop', handleDocumentDrop, true)
    document.addEventListener('dragend', handleDocumentDragEnd, true)

    return () => {
      document.removeEventListener('dragover', handleDocumentDragOver, true)
      document.removeEventListener('drop', handleDocumentDrop, true)
      document.removeEventListener('dragend', handleDocumentDragEnd, true)
    }
  }, [reorderFromDrop])

  return (
    <div
      className="ml-4 border-l border-border/40 py-0.5"
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onDragOver={handleNativeDragOver}
      onDrop={handleNativeDrop}
      onDragEnd={handleNativeDragEnd}
    >
      {sortedWorktrees.map(worktree => {
        const isTarget = dragState.targetId === worktree.id
        return (
          <SortableWorktree
            key={worktree.id}
            worktree={worktree}
            projectId={projectId}
            projectPath={projectPath}
            defaultBranch={defaultBranch}
            disabled={
              reorderWorktrees.isPending || !canReorderWorktree(worktree)
            }
            isDragging={dragState.draggingId === worktree.id}
            closestEdge={isTarget ? dragState.closestEdge : null}
          />
        )
      })}
    </div>
  )
}
