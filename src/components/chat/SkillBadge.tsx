import { useState, useCallback } from 'react'
import { Wand2, Loader2, X } from '@/components/icons/reicon'
import { invokeForOptionalServer } from '@/lib/transport'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  PREVIEW_DIALOG_BODY_CLASS,
  PREVIEW_DIALOG_CONTENT_CLASS,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import { MessageThreadContextMenu } from './message-thread-context-menu'
import { cn } from '@/lib/utils'
import type { PendingSkill } from '@/types/chat'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

interface SkillBadgeProps {
  /** The pending skill to display */
  skill: PendingSkill
  /** Server that owns the skill file; `undefined` means the active transport. */
  serverId: string | undefined
  /** Optional callback to remove this skill (shows X button if provided) */
  onRemove?: () => void
  /** Whether the badge is in a compact display mode */
  compact?: boolean
}

/**
 * Displays a skill mention as a clickable badge that opens a preview dialog
 * Used in chat input for pending skills and in messages for sent skills
 */
export function SkillBadge({
  skill,
  serverId,
  onRemove,
  compact,
}: SkillBadgeProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleOpen = useCallback(async () => {
    setIsOpen(true)

    // Load content on-demand if not already loaded
    if (content === null && !isLoading) {
      setIsLoading(true)
      setError(null)
      try {
        const fileContent = await invokeForOptionalServer<string>(
          serverId,
          'read_file_content',
          { path: skill.path }
        )
        setContent(fileContent)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setIsLoading(false)
      }
    }
  }, [content, isLoading, serverId, skill.path])

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onRemove?.()
    },
    [onRemove]
  )

  return (
    <>
      <div
        className={cn(
          'inline-flex items-center rounded-md border border-border/50 bg-muted/50 hover:border-foreground/20 transition-colors',
          compact ? 'h-6' : 'h-7'
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpen}
              className={cn(
                'flex items-center gap-1.5 cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-md',
                compact ? 'h-6 px-2' : 'h-7 px-2.5'
              )}
            >
              <Wand2
                className={cn(
                  'shrink-0 text-info',
                  compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
                )}
              />
              <span
                className={cn(
                  'font-medium truncate max-w-[120px]',
                  compact ? 'text-2xs' : 'text-xs'
                )}
              >
                /{skill.name}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{`Skill: ${skill.name}\n${skill.path}`}</TooltipContent>
        </Tooltip>
        {onRemove && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleRemove}
                aria-label="Remove skill"
                className={cn(
                  'p-0.5 rounded hover:bg-accent/50 transition-colors',
                  compact ? 'mr-1' : 'mr-1.5'
                )}
              >
                <X
                  className={cn(
                    'text-muted-foreground',
                    compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>Remove skill</TooltipContent>
          </Tooltip>
        )}
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className={PREVIEW_DIALOG_CONTENT_CLASS}>
          <div className="shrink-0 min-w-0 border-b px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 pr-14 sm:border-b-0 sm:p-0 sm:pr-10">
            <DialogTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <Wand2 className="size-4 shrink-0 text-info" />
              <span className="truncate">Skill: {skill.name}</span>
            </DialogTitle>
            <p className="mt-1 text-xs text-muted-foreground truncate">
              {skill.path}
            </p>
          </div>
          <DialogDescription className="sr-only">
            Preview of the skill definition for slash command {skill.name}.
          </DialogDescription>
          <ScrollArea
            className={cn(
              PREVIEW_DIALOG_BODY_CLASS,
              'pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:h-[calc(85vh-6rem)]'
            )}
          >
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="text-sm text-destructive p-3">
                Failed to load skill: {error}
              </div>
            ) : (
              <div className="p-3">
                <MessageThreadContextMenu
                  messageText={content ?? ''}
                  copyMessageLabel="Copy file"
                >
                  <div>
                    <Markdown className="text-sm">{content ?? ''}</Markdown>
                  </div>
                </MessageThreadContextMenu>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  )
}
