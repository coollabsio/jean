import { forwardRef, useCallback } from 'react'
import {
  Archive,
  Eye,
  EyeOff,
  FileText,
  Pencil,
  Shield,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getLabelTextColor } from '@/lib/label-colors'
import { copyToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { getResumeCommand, statusConfig, type SessionCardProps } from './session-card-utils'

export const SessionListRow = forwardRef<HTMLDivElement, SessionCardProps>(
  function SessionListRow(
    {
      card,
      isSelected,
      onSelect,
      onArchive,
      onDelete,
      onPlanView,
      onRecapView,
      onApprove,
      onYolo,
      onClearContextApprove,
      onWorktreeBuildApprove,
      onWorktreeYoloApprove,
      onToggleLabel,
      onToggleReview,
      isRenaming,
      renameValue,
      onRenameValueChange,
      onRenameStart,
      onRenameSubmit,
      onRenameCancel,
    },
    ref
  ) {
    const config = statusConfig[card.status]
    const hasRecap = card.hasRecap
    const hasPlan = !!(card.planFilePath || card.planContent)
    const resumeCommand = getResumeCommand(card.session)
    const renameInputRef = useCallback((node: HTMLInputElement | null) => {
      if (node) {
        node.focus()
        node.select()
      }
    }, [])

    const handleRenameKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onRenameSubmit?.(card.session.id)
        } else if (e.key === 'Escape') {
          onRenameCancel?.()
        }
      },
      [onRenameSubmit, onRenameCancel, card.session.id]
    )

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            role="button"
            tabIndex={-1}
            onClick={onSelect}
            onDoubleClick={() =>
              onRenameStart?.(card.session.id, card.session.name)
            }
            className={cn(
              'group flex w-full items-center gap-3 rounded-md px-3 py-1.5 border border-transparent transition-colors text-left cursor-pointer scroll-mt-28 scroll-mb-20',
              'hover:bg-muted/50 hover:border-foreground/10',
              isSelected &&
                'border-primary/50 bg-primary/5 hover:border-primary/50 hover:bg-primary/10'
            )}
          >
            {/* Status dot */}
            <StatusIndicator
              status={config.indicatorStatus}
              variant={config.indicatorVariant}
              className="h-2 w-2 shrink-0"
            />

            {/* Session name */}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue ?? ''}
                onChange={e => onRenameValueChange?.(e.target.value)}
                onBlur={() => onRenameSubmit?.(card.session.id)}
                onKeyDown={handleRenameKeyDown}
                onClick={e => e.stopPropagation()}
                onDoubleClick={e => e.stopPropagation()}
                className="flex-1 min-w-0 bg-transparent text-sm outline-none ring-1 ring-ring rounded px-1"
              />
            ) : (
              <span className="flex-1 truncate text-sm">
                {card.session.name}
              </span>
            )}

            {/* Blocked badge */}
            {card.hasPermissionDenials && (
              <span className="flex items-center h-5 px-1.5 text-[10px] uppercase tracking-wide border border-yellow-500/50 text-yellow-600 dark:text-yellow-400 rounded shrink-0">
                <Shield className="mr-0.5 h-2.5 w-2.5" />
                {card.permissionDenialCount}
              </span>
            )}

            {/* Label */}
            {card.label && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide shrink-0"
                style={{
                  backgroundColor: card.label.color,
                  color: getLabelTextColor(card.label.color),
                }}
              >
                {card.label.name}
              </span>
            )}

            {/* Approve buttons */}
            {card.hasExitPlanMode &&
              !card.hasQuestion &&
              card.session.backend !== 'codex' &&
              onApprove &&
              onYolo && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    className="h-5 px-1.5 text-[10px] rounded"
                    disabled={card.isSending}
                    onClick={e => {
                      e.stopPropagation()
                      onApprove()
                    }}
                  >
                    Approve
                    <Kbd className="ml-1 h-3.5 text-[9px] bg-primary-foreground/20 text-primary-foreground">
                      {formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan)}
                    </Kbd>
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-5 px-1.5 text-[10px] rounded"
                    disabled={card.isSending}
                    onClick={e => {
                      e.stopPropagation()
                      onYolo()
                    }}
                  >
                    YOLO
                    <Kbd className="ml-1 h-3.5 text-[9px] bg-destructive-foreground/20 text-destructive-foreground">
                      {formatShortcutDisplay(
                        DEFAULT_KEYBINDINGS.approve_plan_yolo
                      )}
                    </Kbd>
                  </Button>
                  {onClearContextApprove && (
                    <Button
                      variant="destructive"
                      className="h-5 px-1.5 text-[10px] rounded"
                      disabled={card.isSending}
                      onClick={e => {
                        e.stopPropagation()
                        onClearContextApprove()
                      }}
                    >
                      Clear Context and yolo
                      <Kbd className="ml-1 h-3.5 text-[9px] bg-destructive-foreground/20 text-destructive-foreground">
                        {formatShortcutDisplay(
                          DEFAULT_KEYBINDINGS.approve_plan_clear_context
                        )}
                      </Kbd>
                    </Button>
                  )}
                  {onWorktreeBuildApprove && (
                    <Button
                      variant="outline"
                      className="h-5 px-1.5 text-[10px] rounded"
                      disabled={card.isSending}
                      onClick={e => {
                        e.stopPropagation()
                        onWorktreeBuildApprove()
                      }}
                    >
                      WT Build
                      <Kbd className="ml-1 h-3.5 text-[9px]">
                        {formatShortcutDisplay(
                          DEFAULT_KEYBINDINGS.approve_plan_worktree_build
                        )}
                      </Kbd>
                    </Button>
                  )}
                  {onWorktreeYoloApprove && (
                    <Button
                      variant="outline"
                      className="h-5 px-1.5 text-[10px] rounded"
                      disabled={card.isSending}
                      onClick={e => {
                        e.stopPropagation()
                        onWorktreeYoloApprove()
                      }}
                    >
                      WT YOLO
                      <Kbd className="ml-1 h-3.5 text-[9px]">
                        {formatShortcutDisplay(
                          DEFAULT_KEYBINDINGS.approve_plan_worktree_yolo
                        )}
                      </Kbd>
                    </Button>
                  )}
                </div>
              )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {onRenameStart && (
            <ContextMenuItem
              onSelect={() =>
                onRenameStart(card.session.id, card.session.name)
              }
            >
              <Pencil className="mr-2 h-4 w-4" />
              Rename
            </ContextMenuItem>
          )}
          {onToggleLabel && (
            <ContextMenuItem onSelect={onToggleLabel}>
              <Tag className="mr-2 h-4 w-4" />
              {card.label ? 'Remove Label' : 'Add Label'}
            </ContextMenuItem>
          )}
          {onToggleReview && (
            <ContextMenuItem onSelect={onToggleReview}>
              {card.status === 'review' ? (
                <>
                  <EyeOff className="mr-2 h-4 w-4" />
                  Mark as Idle
                </>
              ) : (
                <>
                  <Eye className="mr-2 h-4 w-4" />
                  Mark for Review
                </>
              )}
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={onArchive}>
            <Archive className="mr-2 h-4 w-4" />
            Archive Session
          </ContextMenuItem>
          {resumeCommand && (
            <ContextMenuItem
              onSelect={() => {
                void copyToClipboard(resumeCommand)
                  .then(() => toast.success('Resume command copied'))
                  .catch(() => toast.error('Failed to copy resume command'))
              }}
            >
              <Terminal className="mr-2 h-4 w-4" />
              Copy Resume Command
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!hasRecap} onSelect={onRecapView}>
            <Sparkles className="mr-2 h-4 w-4" />
            Recap
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasPlan} onSelect={onPlanView}>
            <FileText className="mr-2 h-4 w-4" />
            Plan
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete Session
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }
)
