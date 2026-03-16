import { useState, useCallback, useRef } from 'react'
import { X, FileText, Copy, Pencil, Check } from 'lucide-react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import type { PendingTextFile } from '@/types/chat'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import { useChatStore } from '@/store/chat-store'

function isMarkdownFile(filename: string | undefined): boolean {
  if (!filename) return false
  return /\.(md|markdown)$/i.test(filename)
}

interface TextFilePreviewProps {
  /** Array of pending text files to display */
  textFiles: PendingTextFile[]
  /** Callback when user removes a text file */
  onRemove: (textFileId: string) => void
  /** Whether removal is disabled (e.g., while sending) */
  disabled?: boolean
  /** Session ID for updating text file content */
  sessionId?: string
}

/** Format bytes to human readable string */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Displays previews of pending text file attachments before sending
 * Renders above the chat input area alongside image previews
 */
export function TextFilePreview({
  textFiles,
  onRemove,
  disabled,
  sessionId,
}: TextFilePreviewProps) {
  const [openFileId, setOpenFileId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleRemove = useCallback(
    async (e: React.MouseEvent, textFile: PendingTextFile) => {
      // Prevent the click from bubbling to the preview dialog
      e.stopPropagation()

      if (disabled) return

      // Delete the file from disk
      try {
        await invoke('delete_pasted_text', { path: textFile.path })
      } catch (error) {
        console.error('Failed to delete text file:', error)
        // Still remove from UI even if delete fails
      }

      // Remove from store
      onRemove(textFile.id)
    },
    [disabled, onRemove]
  )

  const handleCopy = useCallback((content: string) => {
    copyToClipboard(content)
    toast.success('Copied to clipboard')
  }, [])

  const handleStartEdit = useCallback((content: string) => {
    setEditContent(content)
    setIsEditing(true)
    // Focus textarea after render
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }, [])

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false)
    setEditContent('')
  }, [])

  const handleSaveEdit = useCallback(
    async (textFile: PendingTextFile) => {
      if (!sessionId || isSaving) return

      setIsSaving(true)
      try {
        const newSize = await invoke<number>('update_pasted_text', {
          path: textFile.path,
          content: editContent,
        })

        const { updatePendingTextFile } = useChatStore.getState()
        updatePendingTextFile(sessionId, textFile.id, editContent, newSize)

        setIsEditing(false)
        setEditContent('')
        toast.success('Text file updated')
      } catch (error) {
        console.error('Failed to update text file:', error)
        toast.error('Failed to update text file', {
          description: String(error),
        })
      } finally {
        setIsSaving(false)
      }
    },
    [sessionId, editContent, isSaving]
  )

  const handleDialogClose = useCallback(() => {
    setOpenFileId(null)
    setIsEditing(false)
    setEditContent('')
  }, [])

  const openFile = textFiles.find(tf => tf.id === openFileId)

  if (textFiles.length === 0) return null

  return (
    <>
      <div className="flex flex-wrap gap-2 px-4 py-2 md:px-6">
        {textFiles.map(textFile => (
          <div key={textFile.id} className="relative group">
            <button
              type="button"
              onClick={() => setOpenFileId(textFile.id)}
              className="flex items-center gap-2 h-16 px-3 rounded-md border border-border/50 bg-muted cursor-pointer hover:border-primary/50 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
              <div className="flex flex-col items-start text-left min-w-0">
                <span className="text-xs font-medium truncate max-w-[120px]">
                  {textFile.filename}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatBytes(textFile.size)}
                </span>
              </div>
            </button>
            {!disabled && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={e => handleRemove(e, textFile)}
                    className="absolute -top-1.5 -right-1.5 p-0.5 bg-destructive text-destructive-foreground rounded-full opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shadow-sm hover:bg-destructive/90 z-10"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove text file</TooltipContent>
              </Tooltip>
            )}
          </div>
        ))}
      </div>

      {/* Preview dialog */}
      <Dialog
        open={!!openFileId}
        onOpenChange={open => !open && handleDialogClose()}
      >
        <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-auto sm:max-h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm">
          <DialogTitle className="text-sm font-medium flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {openFile?.filename}
            <span className="text-muted-foreground font-normal">
              ({openFile ? formatBytes(openFile.size) : ''})
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Preview of pending text file content before sending.
          </DialogDescription>
          <ScrollArea className="h-[calc(85vh-8rem)] mt-2">
            {isEditing ? (
              <textarea
                ref={textareaRef}
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="w-full h-full min-h-[calc(85vh-10rem)] text-xs font-mono whitespace-pre-wrap break-words p-3 bg-muted rounded-md border-none outline-none resize-none"
              />
            ) : isMarkdownFile(openFile?.filename) ? (
              <div className="p-3 select-text cursor-text">
                <Markdown className="text-sm">
                  {openFile?.content ?? ''}
                </Markdown>
              </div>
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap break-words p-3 bg-muted rounded-md select-text cursor-text">
                {openFile?.content}
              </pre>
            )}
          </ScrollArea>
          <div className="flex items-center gap-1 pt-2 border-t border-border/50">
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  className="px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-xs"
                  title="Cancel editing"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => openFile && handleSaveEdit(openFile)}
                  disabled={isSaving}
                  className="px-3 py-1.5 rounded-md text-primary-foreground bg-primary hover:bg-primary/90 transition-colors flex items-center gap-1 text-xs"
                  title="Save changes"
                >
                  <Check className="h-3.5 w-3.5" />
                  Save
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() =>
                    openFile?.content && handleCopy(openFile.content)
                  }
                  className="px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5 text-xs"
                  title="Copy to clipboard"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
                {!disabled && sessionId && (
                  <button
                    type="button"
                    onClick={() =>
                      openFile?.content !== undefined &&
                      handleStartEdit(openFile.content)
                    }
                    className="px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5 text-xs"
                    title="Edit content"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </button>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
