import { memo, useCallback } from 'react'
import {
  Brain,
  ClipboardList,
  Clock,
  Hammer,
  Play,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ImageLightbox } from '@/components/chat/ImageLightbox'
import type { QueuedMessage } from '@/types/chat'
import {
  MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
} from '@/components/chat/ChatToolbar'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

interface QueuedMessageItemProps {
  message: QueuedMessage
  index: number
  sessionId: string
  onRemove: (sessionId: string, messageId: string) => void
  onForceSend?: (sessionId: string) => void
  isSessionIdle?: boolean
}

/**
 * Single queued message display
 * Memoized to prevent re-renders when sibling messages change
 */
export const QueuedMessageItem = memo(function QueuedMessageItem({
  message,
  index,
  sessionId,
  onRemove,
  onForceSend,
  isSessionIdle,
}: QueuedMessageItemProps) {
  const handleRemove = useCallback(() => {
    onRemove(sessionId, message.id)
  }, [onRemove, sessionId, message.id])

  const handleForceSend = useCallback(() => {
    onForceSend?.(sessionId)
  }, [onForceSend, sessionId])

  const showForceSend = index === 0 && isSessionIdle && onForceSend

  return (
    <div className="w-full flex justify-end overflow-visible">
      <div className="relative group text-foreground border border-dashed border-muted-foreground/40 rounded-lg px-3 py-2 max-w-[70%] bg-muted/10 min-w-0 break-words opacity-60 overflow-visible mr-1 mt-2">
        {/* Queue badge */}
        <div className="absolute -top-2 -left-2 flex items-center gap-1 bg-muted rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground z-10">
          <Clock className="h-2.5 w-2.5" />
          <span>#{index + 1}</span>
        </div>
        {/* Force send button - only on first queued message when session is idle */}
        {showForceSend && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleForceSend}
                className="absolute -top-2 -right-7 p-0.5 bg-muted hover:bg-green-600 text-muted-foreground hover:text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-10"
              >
                <Play className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Force send now</TooltipContent>
          </Tooltip>
        )}
        {/* Remove button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleRemove}
              className="absolute -top-2 -right-2 p-0.5 bg-muted hover:bg-destructive text-muted-foreground hover:text-destructive-foreground rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-10"
            >
              <X className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from queue</TooltipContent>
        </Tooltip>
        {/* Attached images */}
        {message.pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1.5">
            {message.pendingImages.map((img, idx) => (
              <ImageLightbox
                key={`${message.id}-img-${idx}`}
                src={img.path}
                alt={`Attached image ${idx + 1}`}
                thumbnailClassName="h-20 max-w-40 object-contain rounded border border-border/50 cursor-pointer hover:border-primary/50 transition-colors"
              />
            ))}
          </div>
        )}
        {/* Message content */}
        <div className="text-sm">
          {message.message.length > 200
            ? `${message.message.slice(0, 200)}...`
            : message.message}
        </div>
        {/* Attachment indicators */}
        {(message.pendingFiles.length > 0 ||
          message.pendingSkills.length > 0 ||
          message.pendingTextFiles.length > 0) && (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            {message.pendingFiles.length > 0 && (
              <span>{message.pendingFiles.length} file(s)</span>
            )}
            {message.pendingSkills.length > 0 && (
              <span>{message.pendingSkills.length} skill(s)</span>
            )}
            {message.pendingTextFiles.length > 0 && (
              <span>{message.pendingTextFiles.length} text file(s)</span>
            )}
          </div>
        )}
        {/* Captured settings */}
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          {/* Model badge */}
          <span className="inline-flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Sparkles className="h-2.5 w-2.5" />
            {MODEL_OPTIONS.find(o => o.value === message.model)?.label ??
              message.model}
          </span>
          {/* Mode badge */}
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
              message.executionMode === 'plan' &&
                'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
              message.executionMode === 'build' &&
                'bg-muted/80 text-muted-foreground',
              message.executionMode === 'yolo' &&
                'bg-red-500/20 text-red-600 dark:text-red-400'
            )}
          >
            {message.executionMode === 'plan' && (
              <ClipboardList className="h-2.5 w-2.5" />
            )}
            {message.executionMode === 'build' && (
              <Hammer className="h-2.5 w-2.5" />
            )}
            {message.executionMode === 'yolo' && (
              <Zap className="h-2.5 w-2.5" />
            )}
            <span className="capitalize">{message.executionMode}</span>
          </span>
          {/* Thinking/Effort level badge */}
          {message.effortLevel ? (
              <span className="inline-flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                <Brain className="h-2.5 w-2.5" />
                {
                  EFFORT_LEVEL_OPTIONS.find(
                    o => o.value === message.effortLevel
                  )?.label
                }
              </span>
            ) : message.thinkingLevel !== 'off' ? (
              <span className="inline-flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                <Brain className="h-2.5 w-2.5" />
                {
                  THINKING_LEVEL_OPTIONS.find(
                    o => o.value === message.thinkingLevel
                  )?.label
                }
              </span>
            ) : null}
        </div>
      </div>
    </div>
  )
})

interface QueuedMessagesListProps {
  messages: QueuedMessage[]
  sessionId: string
  onRemove: (sessionId: string, messageId: string) => void
  onForceSend?: (sessionId: string) => void
  isSessionIdle?: boolean
}

/**
 * List of queued messages
 * Memoized container that renders memoized items
 */
export const QueuedMessagesList = memo(function QueuedMessagesList({
  messages,
  sessionId,
  onRemove,
  onForceSend,
  isSessionIdle,
}: QueuedMessagesListProps) {
  if (messages.length === 0) return null

  return (
    <div className="space-y-3 mt-4 pr-2">
      {messages.map((msg, index) => (
        <QueuedMessageItem
          key={msg.id}
          message={msg}
          index={index}
          sessionId={sessionId}
          onRemove={onRemove}
          onForceSend={onForceSend}
          isSessionIdle={isSessionIdle}
        />
      ))}
    </div>
  )
})
