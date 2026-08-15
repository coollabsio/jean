import { useState, useCallback } from 'react'
import { FileText, Copy, Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getFilename } from '@/lib/path-utils'
import { copyToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { InlineFileDiff } from './InlineFileDiff'

export interface FileEdit {
  oldString: string
  newString: string
}

interface FileEditsDiffModalProps {
  filePath: string | null
  edits: FileEdit[]
  onClose: () => void
}

/**
 * Modal showing the diff(s) produced by Edit tool calls in a single assistant turn.
 * Stacks one InlineFileDiff per Edit so multiple edits to the same file remain
 * individually inspectable (combining old/new strings would mis-render when edits
 * don't compose linearly).
 */
export function FileEditsDiffModal({
  filePath,
  edits,
  onClose,
}: FileEditsDiffModalProps) {
  const filename = filePath ? getFilename(filePath) : null
  const [copiedPath, setCopiedPath] = useState(false)

  const handleCopyPath = useCallback(() => {
    if (filePath) {
      void copyToClipboard(filePath)
      toast.success('Copied file path to clipboard')
      setCopiedPath(true)
      setTimeout(() => setCopiedPath(false), 2000)
    }
  }, [filePath])

  return (
    <Dialog open={!!filePath} onOpenChange={open => !open && onClose()}>
      <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none p-0 sm:!w-[calc(100vw-4rem)] sm:!max-w-[calc(100vw-4rem)] sm:!h-auto sm:max-h-[85vh] sm:!rounded-lg sm:p-4 bg-background/95 backdrop-blur-sm">
        <DialogTitle className="flex flex-col gap-1 px-4 pt-4 pr-14 sm:px-0 sm:pt-0 sm:pr-8">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate">{filename}</span>
            {edits.length > 1 && (
              <span className="text-xs text-muted-foreground font-normal">
                {edits.length} edits
              </span>
            )}
          </div>
          {filePath && (
            <div className="flex items-center gap-1.5 mt-0.5 select-text group/path min-w-0">
              <span className="text-muted-foreground font-normal text-xs truncate select-text">
                {filePath}
              </span>
              <button
                type="button"
                onClick={handleCopyPath}
                className="inline-flex items-center justify-center h-5 w-5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0 cursor-pointer"
                title="Copy file path"
              >
                {copiedPath ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span className="sr-only">Copy file path</span>
              </button>
            </div>
          )}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Diff of edits applied to {filename ?? 'the selected file'}.
        </DialogDescription>

        <ScrollArea className="h-[calc(100dvh-7rem)] sm:h-auto sm:max-h-[calc(85vh-6rem)] mt-2 px-4 pb-4 sm:px-0 sm:pb-0">
          {edits.length === 0 || !filePath ? (
            <div className="rounded border border-border/30 px-3 py-4 text-xs text-muted-foreground/70 italic text-center">
              No diff available
            </div>
          ) : (
            <div className="space-y-3">
              {edits.map((edit, idx) => (
                <div
                  key={`${edit.oldString.length}:${edit.newString.length}:${edit.oldString.slice(0, 96)}→${edit.newString.slice(0, 96)}`}
                >
                  {edits.length > 1 && (
                    <div className="text-[0.625rem] uppercase tracking-wide text-muted-foreground/60 mb-1">
                      Edit {idx + 1}
                    </div>
                  )}
                  <InlineFileDiff
                    filePath={filePath}
                    oldString={edit.oldString}
                    newString={edit.newString}
                    maxHeightClass="max-h-none"
                  />
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
