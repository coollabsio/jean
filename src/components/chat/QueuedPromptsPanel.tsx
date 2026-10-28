import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Paperclip, Pencil, Play, X } from '@/components/icons/reicon'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import type { QueuedMessage } from '@/types/chat'
import { COMPOSER_SURFACE_CLASS } from './composer-surface'

interface QueuedPromptsPanelProps {
  sessionId: string
  messages: QueuedMessage[]
  /** True while the session is sending or waiting for input */
  isSessionBusy: boolean
  onRemove: (sessionId: string, messageId: string) => void
  onSendNow: (sessionId: string, messageId: string) => void
  /** Load the prompt (text + attachments) into the chat input to edit it */
  onEdit: (sessionId: string, messageId: string) => void
  onCancelEdit: (sessionId: string) => void
}

function attachmentCount(msg: QueuedMessage): number {
  return (
    msg.pendingImages.length +
    msg.pendingFiles.length +
    msg.pendingSkills.length +
    msg.pendingTextFiles.length
  )
}

/**
 * Collapsible list of queued prompts shown at the top of the chat window.
 *
 * Keyboard navigation (active while the list is focused):
 * - ArrowUp/ArrowDown: move selection
 * - Enter: send the selected prompt immediately
 * - Backspace/Delete: remove the selected prompt
 * - Escape: collapse the panel
 *
 * Editing loads the prompt into the chat input, so every attachment kind can
 * be added or removed there. Submitting the input saves it back in place.
 */
export const QueuedPromptsPanel = memo(function QueuedPromptsPanel({
  sessionId,
  messages,
  isSessionBusy,
  onRemove,
  onSendNow,
  onEdit,
  onCancelEdit,
}: QueuedPromptsPanelProps) {
  // Expanded state is remembered per session (collapsed by default)
  const isOpen = useChatStore(
    state => !!state.expandedQueuedPromptsSessions[sessionId]
  )
  const setIsOpen = useCallback(
    (open: boolean) =>
      useChatStore.getState().setQueuedPromptsExpanded(sessionId, open),
    [sessionId]
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const editingId = useChatStore(
    state => state.editingQueuedMessageIds[sessionId] ?? null
  )
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])

  // Clamp selection when the queue shrinks (auto-send / cross-client removal)
  useEffect(() => {
    if (selectedIndex > messages.length - 1) {
      setSelectedIndex(Math.max(0, messages.length - 1))
    }
  }, [messages.length, selectedIndex])

  const scrollRowIntoView = useCallback((index: number) => {
    rowRefs.current[index]?.scrollIntoView({ block: 'nearest' })
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (messages.length === 0) return
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          setSelectedIndex(prev => {
            const next = Math.min(prev + 1, messages.length - 1)
            scrollRowIntoView(next)
            return next
          })
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          setSelectedIndex(prev => {
            const next = Math.max(prev - 1, 0)
            scrollRowIntoView(next)
            return next
          })
          break
        }
        case 'Enter': {
          e.preventDefault()
          const msg = messages[selectedIndex]
          if (msg && msg.id !== editingId) onSendNow(sessionId, msg.id)
          break
        }
        case 'Backspace':
        case 'Delete': {
          e.preventDefault()
          const msg = messages[selectedIndex]
          if (msg && msg.id !== editingId) onRemove(sessionId, msg.id)
          break
        }
        case 'Escape': {
          e.preventDefault()
          setIsOpen(false)
          listRef.current?.blur()
          break
        }
      }
    },
    [
      editingId,
      messages,
      selectedIndex,
      sessionId,
      onRemove,
      onSendNow,
      scrollRowIntoView,
      setIsOpen,
    ]
  )

  if (messages.length === 0) return null

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      {/* Styled to read as an extension of the chat input card below */}
      <div
        className={cn(
          'overflow-hidden sm:rounded-t-lg sm:border-b-0',
          COMPOSER_SURFACE_CLASS
        )}
      >
        <div className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
          <CollapsibleTrigger className="flex flex-1 min-w-0 items-center gap-2 select-none text-left cursor-pointer -mx-3 -my-1.5 px-3 py-1.5 hover:bg-muted/50">
            <Clock className="h-4 w-4 shrink-0" />
            <span className="font-medium">Queued prompts</span>
            <span className="rounded bg-muted/50 px-1.5 py-0.5 text-xs">
              {messages.length}
            </span>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div
            ref={listRef}
            role="list"
            aria-label="Queued prompts"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="group/list max-h-48 overflow-y-auto border-t border-border/50 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {messages.map((msg, index) => {
              const isSelected = index === selectedIndex
              const attachments = attachmentCount(msg)
              const isEditing = editingId === msg.id
              return (
                <div
                  key={msg.id}
                  id={`queued-prompt-${index}`}
                  ref={el => {
                    rowRefs.current[index] = el
                  }}
                  role="listitem"
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => setSelectedIndex(index)}
                  className={cn(
                    'group flex items-center gap-2 px-3 py-1.5 text-xs cursor-default',
                    'hover:bg-muted/30',
                    // Selection is only visible while the list has focus, so the
                    // first row doesn't look permanently selected
                    isSelected && 'group-focus-within/list:bg-muted/60'
                  )}
                >
                  <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                    #{index + 1}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      isEditing ? 'text-muted-foreground' : 'text-foreground'
                    )}
                  >
                    {isEditing
                      ? 'Editing in the input below. Submit it to save.'
                      : msg.message}
                  </span>
                  {!isEditing && attachments > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted/50 px-1 py-0.5 text-2xs text-muted-foreground">
                      <Paperclip className="h-2.5 w-2.5" />
                      {attachments}
                    </span>
                  )}
                  <div
                    className={cn(
                      'flex shrink-0 items-center gap-1 transition-opacity',
                      isEditing
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
                      isSelected &&
                        !isEditing &&
                        'group-focus-within/list:opacity-100'
                    )}
                  >
                    {isEditing ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="Cancel queued prompt edit"
                            onClick={e => {
                              e.stopPropagation()
                              onCancelEdit(sessionId)
                            }}
                            className="rounded p-0.5 text-muted-foreground hover:bg-muted transition-colors"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Cancel edit</TooltipContent>
                      </Tooltip>
                    ) : (
                      <>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="Edit queued prompt"
                              onClick={e => {
                                e.stopPropagation()
                                onEdit(sessionId, msg.id)
                              }}
                              className="rounded p-0.5 text-muted-foreground hover:bg-muted transition-colors"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Edit queued prompt</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="Remove from queue"
                              onClick={e => {
                                e.stopPropagation()
                                onRemove(sessionId, msg.id)
                              }}
                              className="rounded p-0.5 text-muted-foreground hover:bg-destructive hover:text-white transition-colors"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Remove from queue</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="Send now"
                              onClick={e => {
                                e.stopPropagation()
                                onSendNow(sessionId, msg.id)
                              }}
                              className="rounded p-0.5 text-muted-foreground hover:bg-primary hover:text-primary-foreground transition-colors"
                            >
                              <Play className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {isSessionBusy
                              ? 'Send now (interrupts current run)'
                              : 'Send now'}
                          </TooltipContent>
                        </Tooltip>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})
