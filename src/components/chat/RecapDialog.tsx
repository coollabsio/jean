import { Loader2, Sparkles } from 'lucide-react'
import type { SessionDigest } from '@/types/chat'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface RecapDialogProps {
  digest: SessionDigest | null
  isOpen: boolean
  onClose: () => void
  isGenerating?: boolean
  onRegenerate?: () => void
}

export function RecapDialog({
  digest,
  isOpen,
  onClose,
  isGenerating,
  onRegenerate,
}: RecapDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="-mt-1">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span>Session Recap</span>
          </DialogTitle>
        </DialogHeader>
        {digest ? (
          <div className="space-y-4 pt-2">
            <div>
              <p className="text-sm text-foreground">{digest.chat_summary}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  Last action:
                </span>{' '}
                {digest.last_action}
              </p>
            </div>
            {onRegenerate && (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRegenerate}
                  className="text-xs"
                >
                  Regenerate
                  <kbd className="ml-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                    R
                  </kbd>
                </Button>
              </div>
            )}
          </div>
        ) : isGenerating ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating recap...
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            No recap available
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
