import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileIcon, FolderIcon } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { useWorktreeFiles, fileQueryKeys } from '@/services/files'
import type { WorktreeFile, PendingFile } from '@/types/chat'
import { cn } from '@/lib/utils'
import { generateId } from '@/lib/uuid'
import { getExtensionColor } from '@/lib/file-colors'
import { fuzzySearchFiles } from '@/lib/fuzzy-search'

export interface FileMentionPopoverHandle {
  moveUp: () => void
  moveDown: () => void
  selectCurrent: () => void
}

interface FileMentionPopoverProps {
  /** Worktree path for file listing */
  worktreePath: string | null
  /** Whether the popover is open */
  open: boolean
  /** Callback when popover should close */
  onOpenChange: (open: boolean) => void
  /** Callback when a file is selected */
  onSelectFile: (file: PendingFile) => void
  /** Current search query (text after @) */
  searchQuery: string
  /** Position for the anchor (relative to textarea container) */
  anchorPosition: { top: number; left: number } | null
  /** Width of the container (textarea) for popover sizing */
  containerWidth?: number
  /** Ref to expose navigation methods to parent */
  handleRef?: React.RefObject<FileMentionPopoverHandle | null>
}

export function FileMentionPopover({
  worktreePath,
  open,
  onOpenChange,
  onSelectFile,
  searchQuery,
  anchorPosition,
  containerWidth,
  handleRef,
}: FileMentionPopoverProps) {
  const queryClient = useQueryClient()
  const { data: files = [] } = useWorktreeFiles(worktreePath)
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Refetch file list each time the popover opens so newly added files appear
  useEffect(() => {
    if (open && worktreePath) {
      queryClient.invalidateQueries({
        queryKey: fileQueryKeys.worktreeFiles(worktreePath),
      })
    }
  }, [open, worktreePath, queryClient])

  // Filter files based on search query (fuzzy match)
  const filteredFiles = useMemo(
    () => fuzzySearchFiles(files, searchQuery, 15),
    [files, searchQuery]
  )

  // Clamp selectedIndex to valid range (handles case when filter reduces results)
  const clampedSelectedIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredFiles.length - 1)
  )

  const handleSelect = useCallback(
    (file: WorktreeFile) => {
      const pendingFile: PendingFile = {
        id: generateId(),
        relativePath: file.relative_path,
        extension: file.extension,
        isDirectory: file.is_dir,
      }
      onSelectFile(pendingFile)
      onOpenChange(false)
    },
    [onSelectFile, onOpenChange]
  )

  // Expose navigation methods via ref for parent to call
  useImperativeHandle(handleRef, () => {
    return {
      moveUp: () => {
        setSelectedIndex(i => Math.max(i - 1, 0))
      },
      moveDown: () => {
        setSelectedIndex(i => Math.min(i + 1, filteredFiles.length - 1))
      },
      selectCurrent: () => {
        if (filteredFiles[clampedSelectedIndex]) {
          handleSelect(filteredFiles[clampedSelectedIndex])
        }
      },
    }
  }, [filteredFiles, clampedSelectedIndex, handleSelect])

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    const selectedItem = list.querySelector(
      `[data-index="${clampedSelectedIndex}"]`
    )
    selectedItem?.scrollIntoView({ block: 'nearest' })
  }, [clampedSelectedIndex])

  if (!open || !anchorPosition) return null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor
        className="-mx-4 md:-mx-6"
        style={{
          position: 'absolute',
          top: anchorPosition.top,
          left: 0,
          right: 0,
          pointerEvents: 'none',
        }}
      />
      <PopoverContent
        className="p-0"
        style={containerWidth ? { width: containerWidth } : undefined}
        align="start"
        collisionPadding={0}
        side="top"
        sideOffset={12}
        onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList ref={listRef} className="max-h-[200px]">
            {filteredFiles.length === 0 ? (
              <CommandEmpty>No files found</CommandEmpty>
            ) : (
              <CommandGroup>
                {filteredFiles.map((file, index) => {
                  const isSelected = index === clampedSelectedIndex
                  return (
                    <CommandItem
                      key={file.relative_path}
                      data-index={index}
                      value={file.relative_path}
                      onSelect={() => handleSelect(file)}
                      className={cn(
                        'flex items-center gap-2 cursor-pointer',
                        // Override cmdk's internal selection styling - we manage selection ourselves
                        'data-[selected=true]:bg-transparent data-[selected=true]:text-foreground',
                        isSelected && '!bg-accent !text-accent-foreground'
                      )}
                    >
                      {file.is_dir ? (
                        <FolderIcon className="h-4 w-4 shrink-0 text-blue-400" />
                      ) : (
                        <FileIcon
                          className={cn(
                            'h-4 w-4 shrink-0',
                            getExtensionColor(file.extension)
                          )}
                        />
                      )}
                      <span className="truncate text-sm">
                        {file.is_dir
                          ? `${file.relative_path}/`
                          : file.relative_path}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
