import { useEffect, useState } from 'react'
import { FileText, Loader2, Copy } from '@/components/icons/reicon'
import { invokeForOptionalServer } from '@/lib/transport'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import {
  DialogContent,
  DialogDescription,
  DialogTitle,
  PREVIEW_DIALOG_BODY_CLASS,
  PREVIEW_DIALOG_CONTENT_CLASS,
  PREVIEW_DIALOG_FOOTER_CLASS,
  PREVIEW_DIALOG_HEADER_CLASS,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Markdown } from '@/components/ui/markdown'
import { MessageThreadContextMenu } from './message-thread-context-menu'
import type { ReadTextResponse } from '@/types/chat'
import { getFilename } from '@/lib/path-utils'
import { usePreviewStore } from '@/store/preview-store'

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
  /** Owning remote server for persisted attachment paths. */
  serverId?: string
}

/** Preview dialog content; loads the file when it opens. */
function TextFileLightboxContent({
  path,
  size,
  serverId,
}: TextFileLightboxProps) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isLoading = content === null && error === null
  const filename = getFilename(path)

  useEffect(() => {
    let cancelled = false
    invokeForOptionalServer<ReadTextResponse>(serverId, 'read_pasted_text', {
      path,
    })
      .then(response => {
        if (!cancelled) setContent(response.content)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path, serverId])

  const handleCopy = () => {
    if (content) {
      copyToClipboard(content)
      toast.success('Copied to clipboard')
    }
  }

  return (
    <DialogContent className={PREVIEW_DIALOG_CONTENT_CLASS}>
      <DialogTitle className={PREVIEW_DIALOG_HEADER_CLASS}>
        <FileText className="h-4 w-4 shrink-0" />
        <span className="truncate">{filename}</span>
        {size !== undefined && (
          <span className="shrink-0 text-muted-foreground font-normal">
            ({formatBytes(size)})
          </span>
        )}
      </DialogTitle>
      <DialogDescription className="sr-only">
        Preview of text file content for {filename}.
      </DialogDescription>
      <ScrollArea className={PREVIEW_DIALOG_BODY_CLASS}>
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
            <MessageThreadContextMenu
              messageText={content ?? ''}
              copyMessageLabel="Copy file"
            >
              <div>
                <Markdown className="text-sm">{content ?? ''}</Markdown>
              </div>
            </MessageThreadContextMenu>
          </div>
        ) : (
          <pre className="text-xs font-mono whitespace-pre-wrap break-words p-3 bg-muted rounded-md select-text cursor-text">
            {content}
          </pre>
        )}
      </ScrollArea>
      {content && (
        <div className={PREVIEW_DIALOG_FOOTER_CLASS}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopy}
                className="min-h-10 sm:min-h-0 px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1.5 text-xs"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-sm:hidden">
              Copy to clipboard
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </DialogContent>
  )
}

/**
 * Displays a text file as a clickable pill that opens a preview dialog
 * Content is loaded on-demand when the dialog is opened
 */
export function TextFileLightbox({
  path,
  size,
  serverId,
}: TextFileLightboxProps) {
  const filename = getFilename(path)

  return (
    <button
      type="button"
      onClick={() =>
        usePreviewStore
          .getState()
          .openPreview(
            <TextFileLightboxContent
              path={path}
              size={size}
              serverId={serverId}
            />
          )
      }
      className="flex items-center gap-2 h-8 px-3 rounded-md border border-border/50 bg-muted cursor-pointer hover:border-foreground/20 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
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
  )
}
