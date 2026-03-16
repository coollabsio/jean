import { memo } from 'react'
import type { ToolCall } from '@/types/chat'
import { Badge } from '@/components/ui/badge'
import { getFilename } from '@/lib/path-utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

/** Type guard to check if a tool call is Edit */
function isEditTool(
  toolCall: ToolCall
): toolCall is ToolCall & { input: { file_path: string } } {
  return (
    toolCall.name === 'Edit' &&
    typeof toolCall.input === 'object' &&
    toolCall.input !== null &&
    'file_path' in toolCall.input
  )
}

interface EditedFilesDisplayProps {
  toolCalls: ToolCall[] | undefined
  onFileClick: (path: string) => void
}

/**
 * Display edited files at the bottom of assistant messages
 * Collects all Edit tool calls and shows unique file paths
 * Clicking a file opens it in the file content modal
 * Memoized to prevent re-renders when parent state changes
 */
export const EditedFilesDisplay = memo(function EditedFilesDisplay({
  toolCalls,
  onFileClick,
}: EditedFilesDisplayProps) {
  if (!toolCalls) return null

  const editTools = toolCalls.filter(isEditTool)
  if (editTools.length === 0) return null

  // Deduplicate by file path
  const uniqueFilePaths = Array.from(
    new Set(editTools.map(t => t.input.file_path))
  )

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/70">
      <span>
        Edited {uniqueFilePaths.length} file
        {uniqueFilePaths.length === 1 ? '' : 's'}:
      </span>
      {uniqueFilePaths.map(filePath => (
        <Tooltip key={filePath}>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="cursor-pointer"
              onClick={() => onFileClick(filePath)}
            >
              {getFilename(filePath)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{filePath}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
})
