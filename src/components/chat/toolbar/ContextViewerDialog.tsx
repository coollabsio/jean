import { CircleDot, FolderOpen, GitPullRequest, Shield, ShieldAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type { ViewingContext } from '@/components/chat/toolbar/types'

interface ContextViewerDialogProps {
  viewingContext: ViewingContext | null
  onClose: () => void
}

export function ContextViewerDialog({
  viewingContext,
  onClose,
}: ContextViewerDialogProps) {
  if (!viewingContext) return null

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="!w-screen !h-dvh !max-w-screen !max-h-none !rounded-none sm:!w-[calc(100vw-8rem)] sm:!max-w-[calc(100vw-8rem)] sm:!h-[calc(100vh-8rem)] sm:!rounded-lg flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {viewingContext.type === 'issue' && (
              <CircleDot className="h-4 w-4 text-green-500" />
            )}
            {viewingContext.type === 'pr' && (
              <GitPullRequest className="h-4 w-4 text-green-500" />
            )}
            {viewingContext.type === 'saved' && (
              <FolderOpen className="h-4 w-4 text-blue-500" />
            )}
            {viewingContext.type === 'security' && (
              <Shield className="h-4 w-4 text-orange-500" />
            )}
            {viewingContext.type === 'advisory' && (
              <ShieldAlert className="h-4 w-4 text-orange-500" />
            )}
            {viewingContext.type === 'linear' && (
              <LinearIcon className="h-4 w-4 text-violet-500" />
            )}
            {viewingContext.number ? `#${viewingContext.number}: ` : ''}
            {viewingContext.ghsaId ? `${viewingContext.ghsaId}: ` : ''}
            {viewingContext.identifier && !viewingContext.title.startsWith(viewingContext.identifier) ? `${viewingContext.identifier}: ` : ''}
            {viewingContext.title}
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="flex-1 min-h-0">
          <Markdown className="p-4">{viewingContext.content}</Markdown>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
