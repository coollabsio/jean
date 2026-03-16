import { useState, useCallback } from 'react'
import { FileText, Loader2, Copy } from 'lucide-react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import type { ReadTextResponse } from '@/types/chat'
import { getFilename } from '@/lib/path-utils'

/** Check if file is markdown based on extension */
function isMarkdownFile(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename)
}

/** Format bytes to human readable string */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface TextFileLightboxProps {
  /** Full path to the text file */
  path: string
  /** Optional file size in bytes */
  size?: number
}

/**
 * Displays a text file as a clickable pill that opens a preview dialog
 * Content is loaded on-demand when the dialog is opened
 */
export function TextFileLightbox({ path, size }: TextFileLightboxProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filename = getFilename(path)

  const handleOpen = useCallback(async () => {
    setIsOpen(true)

    // Load content on-demand if not already loaded
    if (content === null && !isLoading) {
      setIsLoading(true)
      setError(null)
      try {
        const response = await invoke<ReadTextResponse>('read_pasted_text', {
          path,
        })
        setContent(response.content)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setIsLoading(false)
      }
    }
  }, [content, isLoading, path])

  const handleCopy = useCallback(() => {
    if (content) {
      copyToClipboard(content)
      toast.success('Copied to clipboard')
    }
  }, [content])

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="flex items-center gap-2 h-8 px-3 rounded-md border border-border/50 bg-muted cursor-pointer hover:border-primary/50 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium truncate max-w-[120px]">
          {filename}
        </span>
        {size !== undefined && (
          <span className="text-xs text-muted-foreground">
            {formatBytes(size)}
          </span>
        )}
      </button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-auto sm:max-h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm">
          <DialogTitle className="text-sm font-medium flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {filename}
            {size !== undefined && (
              <span className="text-muted-foreground font-normal">
                ({formatBytes(size)})
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Preview of text file content for {filename}.
          </DialogDescription>
          <ScrollArea className="h-[calc(85vh-8rem)] mt-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="text-sm text-destructive p-3">
                Failed to load file: {error}
              </div>
            ) : isMarkdownFile(filename) ? (
              <div className="p-3 select-text cursor-text">
                <Markdown className="text-sm">{content ?? ''}</Markdown>
              </div>
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap break-words p-3 bg-muted rounded-md select-text cursor-text">
                {content}
              </pre>
            )}
          </ScrollArea>
          {content && (
            <div className="flex items-center gap-1 pt-2 border-t border-border/50">
              <button
                type="button"
                onClick={handleCopy}
                className="px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5 text-xs"
                title="Copy to clipboard"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
