import { useCallback, useState, useRef, useEffect } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/projects'
import { useProjectsStore } from '@/store/projects-store'
import { useRenameFolder } from '@/services/projects'
import { FolderContextMenu } from './FolderContextMenu'

interface FolderTreeItemProps {
  folder: Project
  children: React.ReactNode
  depth: number
  isDropTarget?: boolean
}

export function FolderTreeItem({
  folder,
  children,
  depth,
  isDropTarget,
}: FolderTreeItemProps) {
  const {
    expandedFolderIds,
    toggleFolderExpanded,
    editingFolderId,
    setEditingFolderId,
  } = useProjectsStore()
  const isExpanded = expandedFolderIds.has(folder.id)

  // Derive editing state from store - survives re-renders from query invalidation
  const isEditing = editingFolderId === folder.id
  const [editName, setEditName] = useState(folder.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const editStartTimeRef = useRef<number>(0)
  const renameFolder = useRenameFolder()

  // Sync editName when folder name changes or editing starts
  useEffect(() => {
    if (isEditing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditName(folder.name)
      editStartTimeRef.current = Date.now()
    }
  }, [isEditing, folder.name])

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleClick = useCallback(() => {
    toggleFolderExpanded(folder.id)
  }, [folder.id, toggleFolderExpanded])

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      toggleFolderExpanded(folder.id)
    },
    [folder.id, toggleFolderExpanded]
  )

  const startEditing = useCallback(() => {
    setEditName(folder.name)
    setEditingFolderId(folder.id)
  }, [folder.name, folder.id, setEditingFolderId])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      startEditing()
    },
    [startEditing]
  )

  const handleSubmitRename = useCallback(
    (fromBlur = false) => {
      // Ignore blur events within 300ms of edit start (prevents re-render blur issues)
      if (fromBlur && Date.now() - editStartTimeRef.current < 300) {
        // Re-focus since blur was caused by DnD-Kit/ContextMenu re-render
        inputRef.current?.focus()
        return
      }

      const trimmedName = editName.trim()
      if (trimmedName && trimmedName !== folder.name) {
        renameFolder.mutate({ folderId: folder.id, name: trimmedName })
      }
      setEditingFolderId(null)
    },
    [editName, folder.name, folder.id, renameFolder, setEditingFolderId]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Stop propagation for all keys to prevent drag handlers from capturing them
      e.stopPropagation()

      if (e.key === 'Enter') {
        handleSubmitRename(false)
      } else if (e.key === 'Escape') {
        setEditName(folder.name)
        setEditingFolderId(null)
      }
    },
    [handleSubmitRename, folder.name, setEditingFolderId]
  )

  return (
    <FolderContextMenu folder={folder}>
      <div>
        {/* Folder Row */}
        <div
          className={cn(
            'group flex cursor-pointer items-center gap-1 px-3 py-1.5 transition-colors duration-150',
            'text-[13px] font-medium text-muted-foreground/70 hover:bg-accent/50 hover:text-muted-foreground',
            isDropTarget && 'bg-primary/10 text-primary'
          )}
          style={{ paddingLeft: `${12 + depth * 12}px` }}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
        >
          {/* Folder Icon */}
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-accent-foreground/10"
            onClick={handleChevronClick}
          >
            {isExpanded ? (
              <FolderOpen className="size-3.5" />
            ) : (
              <Folder className="size-3.5" />
            )}
          </button>

          {/* Name (editable) */}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={() => handleSubmitRename(true)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent text-sm outline-none ring-1 ring-primary/50 rounded px-1"
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="flex-1 truncate text-sm">{folder.name}</span>
          )}
        </div>

        {/* Children (nested projects/folders) */}
        {isExpanded && children}
      </div>
    </FolderContextMenu>
  )
}
