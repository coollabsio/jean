import { useState, useCallback } from 'react'
import { FileIcon, FolderIcon, Loader2 } from 'lucide-react'
import { invoke } from '@/lib/transport'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import { cn } from '@/lib/utils'
import { getExtension, getExtensionColor } from '@/lib/file-colors'
import { getFilename } from '@/lib/path-utils'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

/** Check if file is markdown based on extension */
function isMarkdownFile(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename)
}

interface FileMentionBadgeProps {
  /** Relative path to the file or directory (from @ mention) */
  path: string
  /** Worktree path to resolve absolute path */
  worktreePath: string
  /** Whether this is a directory mention */
  isDirectory?: boolean
}

/**
 * Displays a file mention as a clickable badge that opens a preview dialog
 * Used in chat messages to show @mentioned files
 */
export function FileMentionBadge({
  path,
  worktreePath,
  isDirectory = false,
}: FileMentionBadgeProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filename = getFilename(path)
  const extension = getExtension(path)

  const handleOpen = useCallback(async () => {
    // Directories don't have a preview dialog
    if (isDirectory) return

    setIsOpen(true)

    // Load content on-demand if not already loaded
    if (content === null && !isLoading) {
      setIsLoading(true)
      setError(null)
      try {
        // Resolve absolute path from worktree + relative path
        const absolutePath = `${worktreePath}/${path}`
        const fileContent = await invoke<string>('read_file_content', {
          path: absolutePath,
        })
        setContent(fileContent)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setIsLoading(false)
      }
    }
  }, [content, isLoading, isDirectory, path, worktreePath])

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleOpen}
            className={cn(
              'flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border/50 bg-muted/50 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
              isDirectory ? 'cursor-default' : 'cursor-pointer hover:border-primary/50'
            )}
          >
            {isDirectory ? (
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            ) : (
              <FileIcon
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  getExtensionColor(extension)
                )}
              />
            )}
            <span className="text-xs font-medium truncate max-w-[120px]">
              {isDirectory ? `${filename}/` : filename}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{path}</TooltipContent>
      </Tooltip>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-auto sm:max-h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm">
          <DialogTitle className="text-sm font-medium flex items-center gap-2">
            {isDirectory ? (
              <FolderIcon className="h-4 w-4 text-blue-400" />
            ) : (
              <FileIcon className={cn('h-4 w-4', getExtensionColor(extension))} />
            )}
            {path}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Preview of file {path}.
          </DialogDescription>
          <ScrollArea className="h-[calc(85vh-6rem)] mt-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="text-sm text-destructive p-3">
                Failed to load file: {error}
              </div>
            ) : isMarkdownFile(filename) ? (
              <div className="p-3">
                <Markdown className="text-sm">{content ?? ''}</Markdown>
              </div>
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap break-words p-3 bg-muted rounded-md">
                {content}
              </pre>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  )
}
