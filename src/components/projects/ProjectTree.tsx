import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  attachInstruction,
  extractInstruction,
  type Instruction,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item'
import { ChevronDown, ChevronUp } from '@/components/icons/reicon'
import { isFolder, type Project } from '@/types/projects'
import { ProjectTreeItem } from './ProjectTreeItem'
import { FolderTreeItem } from './FolderTreeItem'
import { useReorderItems, useMoveItem } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import {
  isProjectTreeDragData,
  isProjectTreeDropTargetData,
  ROOT_DROP_TARGET_ID,
} from '@/lib/drag-and-drop/types'
import { reorderWithClosestEdge } from '@/lib/drag-and-drop/reorder'
import { announceDrag } from '@/lib/drag-and-drop/live-region'
import { DropIndicator } from '@/components/drag-and-drop/DropIndicator'
import { groupProjectsByServer } from './project-server-sections'
import { RemoteServerRefreshButton } from '@/components/remote/RemoteServerRefreshButton'
import { haveSameProjectServer } from './project-tree-drag'
import {
  SECTION_HEADER_CLASS,
  SECTION_LABEL_CLASS,
  SECTION_TOGGLE_CLASS,
} from './section-header'

const MAX_NESTING_DEPTH = 3

function getDepth(projects: Project[], itemId: string): number {
  const projectById = new Map(projects.map(p => [p.id, p]))
  let depth = 0
  let current = projectById.get(itemId)
  while (current?.parent_id) {
    depth++
    current = projectById.get(current.parent_id)
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
  groupByServer?: boolean
  searchQuery?: string
}

function canMoveIntoFolder({
  projects,
  activeId,
  folderId,
}: {
  projects: Project[]
  activeId: string
  folderId: string
}): boolean {
  if (activeId === folderId) return false

  const projectById = new Map(projects.map(p => [p.id, p]))
  const activeItem = projectById.get(activeId)
  const folder = projectById.get(folderId)
  if (!activeItem || !folder || !isFolder(folder)) return false
  if (!haveSameProjectServer(activeItem, folder)) return false

  const folderDepth = getDepth(projects, folderId)
  const subtreeDepth = isFolder(activeItem)
    ? getMaxSubtreeDepth(projects, activeId)
    : 0
  if (folderDepth + 1 + subtreeDepth > MAX_NESTING_DEPTH) return false

  if (isFolder(activeItem)) {
    let currentParent = folder.parent_id
    while (currentParent) {
      if (currentParent === activeId) return false
      const parent = projectById.get(currentParent)
      currentParent = parent?.parent_id
    }
  }

  return true
}

function instructionToInsertBeforeId(
  targetId: string,
  instruction: Instruction | null
): string | null {
  if (!instruction || instruction.blocked) return null
  if (instruction.operation === 'reorder-before') return targetId
  if (instruction.operation === 'reorder-after') return `after:${targetId}`
  return null
}

function instructionToClosestEdge(instruction: Instruction | null) {
  if (!instruction || instruction.blocked) return null
  if (instruction.operation === 'reorder-before') return 'top' as const
  if (instruction.operation === 'reorder-after') return 'bottom' as const
  return null
}

function getSortedSiblings(
  projects: Project[],
  parentId: string | undefined,
  excludeId?: string
) {
  return projects
    .filter(p => p.parent_id === parentId && p.id !== excludeId)
    .sort((a, b) => {
      if (isFolder(a) && !isFolder(b)) return -1
      if (!isFolder(a) && isFolder(b)) return 1
      return a.order - b.order
    })
}

interface SortableItemProps {
  item: Project
  allProjects: Project[]
  depth: number
  isOverFolder: boolean
  expandedFolderIds: Set<string>
  overFolderId: string | null
  insertBeforeId: string | null
  activeId: string | null
  searchQuery: string
}

function SortableItem({
  item,
  allProjects,
  depth,
  isOverFolder,
  expandedFolderIds,
  overFolderId,
  insertBeforeId,
  activeId,
  searchQuery,
}: SortableItemProps) {
  const elementRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element || item.offline || searchQuery) return

    return combine(
      draggable({
        element,
        getInitialData: () => ({
          type: 'project-tree-item',
          itemId: item.id,
        }),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => {
          if (!isProjectTreeDragData(source.data)) return false
          const sourceItem = allProjects.find(
            project => project.id === source.data.itemId
          )
          return (
            source.data.itemId !== item.id &&
            haveSameProjectServer(sourceItem, item)
          )
        },
        getData: ({ input, element, source }) => {
          const sourceId = isProjectTreeDragData(source.data)
            ? source.data.itemId
            : null
          const canCombine =
            sourceId != null &&
            isFolder(item) &&
            canMoveIntoFolder({
              projects: allProjects,
              activeId: sourceId,
              folderId: item.id,
            })

          return attachInstruction(
            {
              type: 'project-tree-item',
              targetId: item.id,
            },
            {
              input,
              element,
              axis: 'vertical',
              operations: {
                'reorder-before': 'available',
                'reorder-after': 'available',
                combine: canCombine ? 'available' : 'not-available',
              },
            }
          )
        },
      })
    )
  }, [allProjects, item, searchQuery])

  const style: React.CSSProperties = {
    opacity: activeId === item.id ? 0.35 : 1,
    paddingLeft: depth > 0 ? `${depth * 12}px` : undefined,
  }

  const closestEdge =
    insertBeforeId === item.id
      ? ('top' as const)
      : insertBeforeId === `after:${item.id}`
        ? ('bottom' as const)
        : null

  if (isFolder(item)) {
    const isExpanded = Boolean(searchQuery) || expandedFolderIds.has(item.id)

    return (
      <div
        ref={elementRef}
        data-pdnd-tree-id={item.id}
        style={style}
        className={cn(
          'relative transition-opacity',
          !item.offline &&
            (activeId === item.id ? 'cursor-grabbing' : 'cursor-grab')
        )}
      >
        <DropIndicator edge={closestEdge} insetClassName="left-2 right-2" />
        <FolderTreeItem
          folder={item}
          depth={depth}
          childCount={
            allProjects.filter(project => project.parent_id === item.id).length
          }
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
              activeId={activeId}
              searchQuery={searchQuery}
            />
          )}
        </FolderTreeItem>
      </div>
    )
  }

  return (
    <div
      ref={elementRef}
      data-pdnd-tree-id={item.id}
      style={style}
      className={cn(
        'relative transition-opacity',
        !item.offline &&
          (activeId === item.id ? 'cursor-grabbing' : 'cursor-grab')
      )}
    >
      <DropIndicator edge={closestEdge} insetClassName="left-2 right-2" />
      <ProjectTreeItem project={item} searchQuery={searchQuery} />
    </div>
  )
}

// Renders nested items (children of a folder)
interface NestedItemsProps {
  projects: Project[]
  parentId: string
  depth: number
  expandedFolderIds: Set<string>
  overFolderId: string | null
  insertBeforeId: string | null
  activeId: string | null
  searchQuery: string
}

function NestedItems({
  projects,
  parentId,
  depth,
  expandedFolderIds,
  overFolderId,
  insertBeforeId,
  activeId,
  searchQuery,
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
          activeId={activeId}
          searchQuery={searchQuery}
        />
      ))}
    </>
  )
}

// Drop zone at the bottom to move items to root level
function RootDropZone({ isOver }: { isOver: boolean }) {
  const elementRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    return dropTargetForElements({
      element,
      canDrop: ({ source }) => isProjectTreeDragData(source.data),
      getData: () => ({
        type: 'project-tree-item',
        targetId: ROOT_DROP_TARGET_ID,
        root: true,
      }),
    })
  }, [])

  return (
    <div
      ref={elementRef}
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

export function ProjectTree({
  projects,
  groupByServer = false,
  searchQuery = '',
}: ProjectTreeProps) {
  const reorderItems = useReorderItems()
  const moveItem = useMoveItem()
  const expandFolder = useProjectsStore(state => state.expandFolder)
  const expandedFolderIds = useProjectsStore(state => state.expandedFolderIds)
  const expandedProjectIds = useProjectsStore(state => state.expandedProjectIds)
  const expandAllFolders = useProjectsStore(state => state.expandAllFolders)
  const collapseAllFolders = useProjectsStore(state => state.collapseAllFolders)
  const setProjectExpanded = useProjectsStore(state => state.setProjectExpanded)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overFolderId, setOverFolderId] = useState<string | null>(null)
  const [isOverRoot, setIsOverRoot] = useState(false)
  const [insertBeforeId, setInsertBeforeId] = useState<string | null>(null)
  const [foldersSectionCollapsed, setFoldersSectionCollapsed] = useState(false)
  const latestDropTargetRef = useRef<{
    targetId: string | null
    instruction: Instruction | null
  }>({ targetId: null, instruction: null })
  const activeIdRef = useRef(activeId)

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  // Root level items split into folders and standalone projects
  const rootItems = projects.filter(p => p.parent_id === undefined)
  const rootFolders = rootItems
    .filter(isFolder)
    .sort((a, b) => a.order - b.order)
  const rootProjects = rootItems
    .filter(p => !isFolder(p))
    .sort((a, b) => a.order - b.order)
  const projectSections =
    rootProjects.length === 0
      ? []
      : groupByServer
        ? groupProjectsByServer(rootProjects)
        : [{ id: 'all', title: 'Projects', projects: rootProjects }]
  const hasBothTypes = rootFolders.length > 0 && rootProjects.length > 0

  // IDs for bulk expand/collapse actions (across all nesting levels)
  const allFolderIds = useMemo(
    () => projects.flatMap(p => (isFolder(p) ? [p.id] : [])),
    [projects]
  )
  const showFolders = !foldersSectionCollapsed || Boolean(searchQuery)
  const clearDragState = useCallback(() => {
    setActiveId(null)
    setOverFolderId(null)
    setIsOverRoot(false)
    setInsertBeforeId(null)
    latestDropTargetRef.current = { targetId: null, instruction: null }
  }, [])

  const getSiblings = useCallback(
    (parentId: string | undefined, excludeId?: string) =>
      getSortedSiblings(projects, parentId, excludeId),
    [projects]
  )

  const updateDragTargetState = useCallback(
    (
      targetId: string | null,
      instruction: Instruction | null,
      sourceId: string | null
    ) => {
      latestDropTargetRef.current = { targetId, instruction }
      if (!targetId) {
        setOverFolderId(null)
        setIsOverRoot(false)
        setInsertBeforeId(null)
        return
      }

      if (targetId === ROOT_DROP_TARGET_ID) {
        setOverFolderId(null)
        setIsOverRoot(true)
        setInsertBeforeId(null)
        return
      }

      setIsOverRoot(false)
      const target = projects.find(p => p.id === targetId)
      if (
        target &&
        isFolder(target) &&
        instruction?.operation === 'combine' &&
        !instruction.blocked &&
        sourceId &&
        canMoveIntoFolder({ projects, activeId: sourceId, folderId: target.id })
      ) {
        setOverFolderId(target.id)
        setInsertBeforeId(null)
        return
      }

      setOverFolderId(null)
      setInsertBeforeId(instructionToInsertBeforeId(targetId, instruction))
    },
    [projects]
  )

  const performTreeDrop = useCallback(
    (activeId: string, targetId: string, instruction: Instruction | null) => {
      const activeItem = projects.find(p => p.id === activeId)
      if (!activeItem) return

      if (targetId === ROOT_DROP_TARGET_ID) {
        if (activeItem.parent_id !== undefined) {
          moveItem.mutate({ itemId: activeId, newParentId: undefined })
          announceDrag('Item moved to root level')
        }
        return
      }

      const overItem = projects.find(p => p.id === targetId)
      if (!overItem || activeId === targetId) return

      if (
        instruction?.operation === 'combine' &&
        !instruction.blocked &&
        canMoveIntoFolder({ projects, activeId, folderId: targetId })
      ) {
        moveItem.mutate({ itemId: activeId, newParentId: targetId })
        expandFolder(targetId)
        announceDrag(`Item moved into ${overItem.name}`)
        return
      }

      const closestEdge = instructionToClosestEdge(instruction)
      if (!closestEdge) return

      if (activeItem.parent_id !== overItem.parent_id) {
        const targetParentId = overItem.parent_id
        const siblings = getSiblings(targetParentId, activeId)
        const overIndex = siblings.findIndex(p => p.id === targetId)
        if (overIndex === -1) return
        const targetIndex = closestEdge === 'bottom' ? overIndex + 1 : overIndex

        moveItem.mutate({
          itemId: activeId,
          newParentId: targetParentId,
          targetIndex,
        })
        announceDrag('Item moved')
        return
      }

      const parentId = activeItem.parent_id
      const siblings = getSiblings(parentId)
      const oldIndex = siblings.findIndex(p => p.id === activeId)
      const newIndex = siblings.findIndex(p => p.id === targetId)
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return

      const reorderedItems = reorderWithClosestEdge({
        items: siblings,
        startIndex: oldIndex,
        indexOfTarget: newIndex,
        closestEdgeOfTarget: closestEdge,
      })
      reorderItems.mutate({
        itemIds: reorderedItems.map(p => p.id),
        parentId,
      })
      announceDrag('Items reordered')
    },
    [expandFolder, getSiblings, moveItem, projects, reorderItems]
  )

  const nativeTreeDropHandledRef = useRef(false)

  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) => isProjectTreeDragData(source.data),
      onDragStart: ({ source }) => {
        if (!isProjectTreeDragData(source.data)) return
        setActiveId(source.data.itemId)
        announceDrag('Started dragging item')
      },
      onDropTargetChange: ({ source, location }) => {
        if (!isProjectTreeDragData(source.data)) return
        const target = location.current.dropTargets.find(dropTarget =>
          isProjectTreeDropTargetData(dropTarget.data)
        )
        const instruction = target ? extractInstruction(target.data) : null
        const targetId =
          typeof target?.data.targetId === 'string'
            ? target.data.targetId
            : null
        updateDragTargetState(targetId, instruction, source.data.itemId)
      },
      onDrag: ({ source, location }) => {
        if (!isProjectTreeDragData(source.data)) return
        const target = location.current.dropTargets.find(dropTarget =>
          isProjectTreeDropTargetData(dropTarget.data)
        )
        const instruction = target ? extractInstruction(target.data) : null
        const targetId =
          typeof target?.data.targetId === 'string'
            ? target.data.targetId
            : null
        updateDragTargetState(targetId, instruction, source.data.itemId)
      },
      onDrop: ({ source, location }) => {
        if (nativeTreeDropHandledRef.current) {
          nativeTreeDropHandledRef.current = false
          return
        }
        if (!isProjectTreeDragData(source.data)) {
          clearDragState()
          return
        }
        const target = location.current.dropTargets.find(dropTarget =>
          isProjectTreeDropTargetData(dropTarget.data)
        )
        const fallback = latestDropTargetRef.current
        const targetId = target
          ? String(target.data.targetId)
          : fallback.targetId
        const instruction = target
          ? extractInstruction(target.data)
          : fallback.instruction
        clearDragState()
        if (!targetId) {
          announceDrag('Item move cancelled')
          return
        }
        performTreeDrop(source.data.itemId, targetId, instruction)
      },
    })
  }, [clearDragState, performTreeDrop, updateDragTargetState])

  const handleNativeTreeDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!activeId) return
      const target = (event.target as HTMLElement | null)?.closest(
        '[data-pdnd-tree-id]'
      ) as HTMLElement | null
      const targetId = target?.dataset.pdndTreeId ?? null
      if (!target || !targetId || targetId === activeId) return

      const targetProject = projects.find(p => p.id === targetId)
      if (!targetProject) return

      event.preventDefault()
      const rect = target.getBoundingClientRect()
      const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1)
      let instruction: Instruction | null
      if (
        isFolder(targetProject) &&
        ratio > 0.25 &&
        ratio < 0.75 &&
        canMoveIntoFolder({ projects, activeId, folderId: targetId })
      ) {
        instruction = { operation: 'combine', blocked: false, axis: 'vertical' }
      } else {
        instruction = {
          operation: ratio < 0.5 ? 'reorder-before' : 'reorder-after',
          blocked: false,
          axis: 'vertical',
        }
      }

      updateDragTargetState(targetId, instruction, activeId)
    },
    [activeId, projects, updateDragTargetState]
  )

  const handleNativeTreeDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!activeId) return
      event.preventDefault()
      event.stopPropagation()
      const fallback = latestDropTargetRef.current
      nativeTreeDropHandledRef.current = true
      clearDragState()
      if (fallback.targetId) {
        performTreeDrop(activeId, fallback.targetId, fallback.instruction)
      }
    },
    [activeId, clearDragState, performTreeDrop]
  )

  const handleNativeTreeDragEnd = useCallback(() => {
    clearDragState()
  }, [clearDragState])

  const onDocumentDragOver = useEffectEvent((event: DragEvent) => {
    const getDocumentTarget = () => {
      const element = document.elementFromPoint(
        event.clientX,
        event.clientY
      ) as HTMLElement | null
      return element?.closest('[data-pdnd-tree-id]') as HTMLElement | null
    }

    const draggingId = activeIdRef.current
    if (!draggingId) return
    const target = getDocumentTarget()
    const targetId = target?.dataset.pdndTreeId ?? null
    if (!target || !targetId || targetId === draggingId) return

    const targetProject = projects.find(p => p.id === targetId)
    if (!targetProject) return

    event.preventDefault()
    const rect = target.getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1)
    let instruction: Instruction | null
    if (
      isFolder(targetProject) &&
      ratio > 0.25 &&
      ratio < 0.75 &&
      canMoveIntoFolder({
        projects,
        activeId: draggingId,
        folderId: targetId,
      })
    ) {
      instruction = {
        operation: 'combine',
        blocked: false,
        axis: 'vertical',
      }
    } else {
      instruction = {
        operation: ratio < 0.5 ? 'reorder-before' : 'reorder-after',
        blocked: false,
        axis: 'vertical',
      }
    }

    updateDragTargetState(targetId, instruction, draggingId)
  })

  const onDocumentDrop = useEffectEvent((event: DragEvent) => {
    const draggingId = activeIdRef.current
    if (!draggingId) return
    const fallback = latestDropTargetRef.current
    if (!fallback.targetId) return
    event.preventDefault()
    event.stopPropagation()
    nativeTreeDropHandledRef.current = true
    clearDragState()
    performTreeDrop(draggingId, fallback.targetId, fallback.instruction)
  })

  const onDocumentDragEnd = useEffectEvent(() => {
    const draggingId = activeIdRef.current
    if (!draggingId) return
    clearDragState()
  })

  useEffect(() => {
    const handleDocumentDragOver = (event: DragEvent) =>
      onDocumentDragOver(event)
    const handleDocumentDrop = (event: DragEvent) => onDocumentDrop(event)
    const handleDocumentDragEnd = () => onDocumentDragEnd()

    document.addEventListener('dragover', handleDocumentDragOver, true)
    document.addEventListener('drop', handleDocumentDrop, true)
    document.addEventListener('dragend', handleDocumentDragEnd, true)

    return () => {
      document.removeEventListener('dragover', handleDocumentDragOver, true)
      document.removeEventListener('drop', handleDocumentDrop, true)
      document.removeEventListener('dragend', handleDocumentDragEnd, true)
    }
  }, [])

  useEffect(() => {
    if (!overFolderId || expandedFolderIds.has(overFolderId)) return
    const timeoutId = window.setTimeout(() => {
      expandFolder(overFolderId)
      announceDrag('Folder expanded')
    }, 500)

    return () => window.clearTimeout(timeoutId)
  }, [expandFolder, expandedFolderIds, overFolderId])

  return (
    <div
      className="py-1"
      onDragOver={handleNativeTreeDragOver}
      onDrop={handleNativeTreeDrop}
      onDragEnd={handleNativeTreeDragEnd}
    >
      {rootFolders.length > 0 && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className={`group/header ${SECTION_HEADER_CLASS}`}>
              <span className={SECTION_LABEL_CLASS}>Folders</span>
              <button
                type="button"
                className={SECTION_TOGGLE_CLASS}
                onClick={() => setFoldersSectionCollapsed(value => !value)}
                aria-label={showFolders ? 'Hide folders' : 'Show folders'}
                aria-expanded={showFolders}
                disabled={Boolean(searchQuery)}
              >
                {showFolders ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onClick={() => {
                setFoldersSectionCollapsed(false)
                expandAllFolders(allFolderIds)
              }}
            >
              Expand all folders
            </ContextMenuItem>
            <ContextMenuItem onClick={collapseAllFolders}>
              Collapse all folders
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {showFolders &&
        rootFolders.map(item => (
          <SortableItem
            key={item.id}
            item={item}
            allProjects={projects}
            depth={0}
            isOverFolder={overFolderId === item.id}
            expandedFolderIds={expandedFolderIds}
            overFolderId={overFolderId}
            insertBeforeId={insertBeforeId}
            activeId={activeId}
            searchQuery={searchQuery}
          />
        ))}
      {hasBothTypes && (
        <div className="px-3 py-2">
          <Separator />
        </div>
      )}
      {projectSections.map(section => {
        const areAllProjectsExpanded = section.projects.every(item =>
          expandedProjectIds.has(item.id)
        )
        const actionLabel = areAllProjectsExpanded ? 'Collapse' : 'Expand'

        return (
          <div key={section.id}>
            <div className={`group/header ${SECTION_HEADER_CLASS}`}>
              <span className={`min-w-0 truncate ${SECTION_LABEL_CLASS}`}>
                {section.title}
              </span>
              <div
                className="flex shrink-0 items-center gap-1"
                data-testid="instance-title-actions"
              >
                {groupByServer && section.id !== 'local' && (
                  <RemoteServerRefreshButton
                    serverId={section.id}
                    serverName={section.title}
                  />
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={SECTION_TOGGLE_CLASS}
                      onClick={() =>
                        section.projects.forEach(item =>
                          setProjectExpanded(item.id, !areAllProjectsExpanded)
                        )
                      }
                      aria-label={
                        section.title === 'Projects'
                          ? `${actionLabel} all projects`
                          : `${actionLabel} all projects on ${section.title}`
                      }
                    >
                      {areAllProjectsExpanded ? (
                        <ChevronUp className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{actionLabel} all</TooltipContent>
                </Tooltip>
              </div>
            </div>
            {section.projects.map(item => (
              <SortableItem
                key={item.id}
                item={item}
                allProjects={projects}
                depth={0}
                isOverFolder={false}
                expandedFolderIds={expandedFolderIds}
                overFolderId={overFolderId}
                insertBeforeId={insertBeforeId}
                activeId={activeId}
                searchQuery={searchQuery}
              />
            ))}
          </div>
        )
      })}

      {/* Root drop zone - visible when dragging an item that's inside a folder */}
      {activeId &&
        projects.find(p => p.id === activeId)?.parent_id !== undefined && (
          <RootDropZone isOver={isOverRoot} />
        )}
    </div>
  )
}
