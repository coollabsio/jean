import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Clock, Paperclip, Pencil, Play, X } from 'lucide-react'
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
import type { QueuedMessage } from '@/types/chat'

interface QueuedPromptsPanelProps {
  sessionId: string
  messages: QueuedMessage[]
  /** True while the session is sending or waiting for input */
  isSessionBusy: boolean
  onRemove: (sessionId: string, messageId: string) => void
  onSendNow: (sessionId: string, messageId: string) => void
  onEdit: (sessionId: string, messageId: string, message: string) => void
}

function attachmentCount(msg: QueuedMessage): number {
  return (
    msg.pendingImages.length +
    msg.pendingFiles.length +
    msg.pendingSkills.length +
    msg.pendingTextFiles.length
  )
}

function canEditQueuedMessage(msg: QueuedMessage): boolean {
  const backend = msg.backend ?? 'claude'
  if (backend === 'codex') return false
  if ((backend === 'opencode' || backend === 'pi') && attachmentCount(msg) === 0) {
    return false
  }
  return true
}

/**
 * Collapsible list of queued prompts shown at the top of the chat window.
 *
 * Keyboard navigation (active while the list is focused):
 * - ArrowUp/ArrowDown: move selection
 * - Enter: send the selected prompt immediately
 * - Backspace/Delete: remove the selected prompt
 * - Escape: collapse the panel
 */
export const QueuedPromptsPanel = memo(function QueuedPromptsPanel({
  sessionId,
  messages,
  isSessionBusy,
  onRemove,
  onSendNow,
  onEdit,
}: QueuedPromptsPanelProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
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
          if (msg) onSendNow(sessionId, msg.id)
          break
        }
        case 'Backspace':
        case 'Delete': {
          e.preventDefault()
          const msg = messages[selectedIndex]
          if (msg) onRemove(sessionId, msg.id)
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
    [messages, selectedIndex, sessionId, onRemove, onSendNow, scrollRowIntoView]
  )

  const startEditing = useCallback((msg: QueuedMessage) => {
    setEditingId(msg.id)
    setEditingText(msg.message)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingId(null)
    setEditingText('')
  }, [])

  const saveEditing = useCallback(() => {
    if (!editingId) return
    const next = editingText.trim()
    if (!next) return
    onEdit(sessionId, editingId, next)
    cancelEditing()
  }, [cancelEditing, editingId, editingText, onEdit, sessionId])

  if (messages.length === 0) return null

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      {/* Styled to read as an extension of the chat input card below */}
      <div className="border-t border-border bg-card sm:rounded-t-lg sm:border sm:border-b-0">
        <div className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
          <CollapsibleTrigger className="flex flex-1 items-center gap-2 hover:bg-muted/50 select-none -ml-3 -my-2 pl-3 py-2 rounded-l-md">
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
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
            role="listbox"
            aria-label="Queued prompts"
            aria-activedescendant={`queued-prompt-${selectedIndex}`}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="max-h-48 overflow-y-auto border-t border-border/50 outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => setSelectedIndex(index)}
                  className={cn(
                    'group flex items-center gap-2 px-3 py-1.5 text-xs cursor-default',
                    isSelected ? 'bg-muted/60' : 'hover:bg-muted/30'
                  )}
                >
                  <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                    #{index + 1}
                  </span>
                  {isEditing ? (
                    <textarea
                      aria-label="Queued prompt text"
                      value={editingText}
                      onChange={e => setEditingText(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => {
                        e.stopPropagation()
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelEditing()
                        } else if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          saveEditing()
                        }
                      }}
                      className="min-h-8 flex-1 resize-none rounded border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      autoFocus
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {msg.message}
                    </span>
                  )}
                  {attachments > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted/50 px-1 py-0.5 text-[10px] text-muted-foreground">
                      <Paperclip className="h-2.5 w-2.5" />
                      {attachments}
                    </span>
                  )}
                  <div
                    className={cn(
                      'flex shrink-0 items-center gap-1 transition-opacity',
                      isSelected
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100'
                    )}
                  >
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          aria-label="Save queued prompt"
                          disabled={!editingText.trim()}
                          onClick={e => {
                            e.stopPropagation()
                            saveEditing()
                          }}
                          className="rounded p-0.5 text-muted-foreground hover:bg-green-600 hover:text-white disabled:opacity-40 transition-colors"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel queued prompt edit"
                          onClick={e => {
                            e.stopPropagation()
                            cancelEditing()
                          }}
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        {canEditQueuedMessage(msg) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                aria-label="Edit queued prompt"
                                onClick={e => {
                                  e.stopPropagation()
                                  startEditing(msg)
                                }}
                                className="rounded p-0.5 text-muted-foreground hover:bg-muted transition-colors"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Edit queued prompt</TooltipContent>
                          </Tooltip>
                        )}
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
                              className="rounded p-0.5 text-muted-foreground hover:bg-green-600 hover:text-white transition-colors"
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
