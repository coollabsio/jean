import { useState, useCallback } from 'react'
import { Loader2, Clipboard, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface ExportSessionModalProps {
  isOpen: boolean
  onClose: () => void
  sessionName: string
  onExportClipboard: () => Promise<void>
  onExportFile: () => Promise<void>
}

export function ExportSessionModal({
  isOpen,
  onClose,
  sessionName,
  onExportClipboard,
  onExportFile,
}: ExportSessionModalProps) {
  const [loading, setLoading] = useState<'clipboard' | 'file' | null>(null)

  const handleClipboard = useCallback(async () => {
    setLoading('clipboard')
    try {
      await onExportClipboard()
      onClose()
    } catch (err) {
      toast.error(`Export failed: ${err}`)
    } finally {
      setLoading(null)
    }
  }, [onExportClipboard, onClose])

  const handleFile = useCallback(async () => {
    setLoading('file')
    try {
      await onExportFile()
      onClose()
    } catch (err) {
      toast.error(`Export failed: ${err}`)
    } finally {
      setLoading(null)
    }
  }, [onExportFile, onClose])

  const isLoading = loading !== null

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="w-auto">
        <DialogHeader>
          <DialogTitle>Export Session</DialogTitle>
          <DialogDescription className="truncate">
            {sessionName}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 pt-1">
          <Button
            onClick={handleClipboard}
            disabled={isLoading}
            className="justify-start gap-3"
          >
            {loading === 'clipboard' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Clipboard className="h-4 w-4" />
            )}
            Copy to Clipboard
          </Button>
          <Button
            variant="outline"
            onClick={handleFile}
            disabled={isLoading}
            className="justify-start gap-3 overflow-hidden"
          >
            {loading === 'file' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="h-4 w-4" />
            )}
            <span className="truncate">Save to File</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              ./session-exports/
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
