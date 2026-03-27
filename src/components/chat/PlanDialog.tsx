import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Pencil, RotateCcw } from 'lucide-react'
import { invoke } from '@/lib/transport'
import { readPlanFile } from '@/services/chat'
import { usePreferences } from '@/services/preferences'
import { getFilename } from '@/lib/path-utils'
import { useUIStore } from '@/store/ui-store'
import { resolveApprovalLabel } from './approval-label-utils'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import { SplitButton } from '@/components/ui/split-button'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'

export interface ApprovalContext {
  worktreeId: string
  worktreePath: string
  sessionId: string
  pendingPlanMessageId: string | null
}

interface PlanDialogBaseProps {
  isOpen: boolean
  onClose: () => void
  editable?: boolean
  disabled?: boolean
  approvalContext?: ApprovalContext
  onApprove?: (updatedPlan: string) => void
  onApproveYolo?: (updatedPlan: string) => void
  onClearContextApprove?: (updatedPlan: string) => void
  onClearContextBuildApprove?: (updatedPlan: string) => void
  onWorktreeBuildApprove?: (updatedPlan: string) => void
  onWorktreeYoloApprove?: (updatedPlan: string) => void
  /** Hide approve buttons (e.g. for Codex which has no native approval flow) */
  hideApproveButtons?: boolean
}

interface PlanDialogFileProps extends PlanDialogBaseProps {
  filePath: string
  content?: never
}

interface PlanDialogContentProps extends PlanDialogBaseProps {
  content: string
  filePath?: never
}

type PlanDialogProps = PlanDialogFileProps | PlanDialogContentProps

export function PlanDialog({
  filePath,
  content: inlineContent,
  isOpen,
  onClose,
  editable = false,
  disabled = false,
  approvalContext: _approvalContext,
  onApprove,
  onApproveYolo,
  onClearContextApprove,
  onClearContextBuildApprove,
  onWorktreeBuildApprove,
  onWorktreeYoloApprove,
  hideApproveButtons,
}: PlanDialogProps) {
  const filename = filePath ? getFilename(filePath) : null
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const buildLabel = resolveApprovalLabel('build', preferences)
  const yoloLabel = resolveApprovalLabel('yolo', preferences)

  const { data: fetchedContent, isLoading } = useQuery({
    queryKey: ['planFile', filePath],
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    queryFn: () => readPlanFile(filePath!),
    staleTime: 1000 * 60 * 5, // 5 minutes
    retry: 1,
    enabled: isOpen && !!filePath && !inlineContent,
  })

  const originalContent = inlineContent ?? fetchedContent ?? ''
  const [editedContent, setEditedContent] = useState('')
  const [isEditMode, setIsEditMode] = useState(false)

  // Sync edited content when original changes or dialog opens
  useEffect(() => {
    if (isOpen && originalContent) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditedContent(originalContent)
    }
  }, [isOpen, originalContent])

  // Reset edit mode when dialog closes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isOpen) setIsEditMode(false)
  }, [isOpen])

  // Track dialog open state in UIStore to block canvas keybindings
  useEffect(() => {
    useUIStore.getState().setPlanDialogOpen(isOpen)
    return () => useUIStore.getState().setPlanDialogOpen(false)
  }, [isOpen])

  const hasChanges = editedContent !== originalContent
  // Enable approve buttons when callbacks are provided and not disabled (session still running)
  const canApprove = !hideApproveButtons && !!onApprove && !!onApproveYolo && !disabled

  // Auto-save plan file with debounce when content changes
  useEffect(() => {
    if (!filePath || !hasChanges || !isOpen || !editable) return

    const timer = setTimeout(async () => {
      try {
        await invoke('write_file_content', {
          path: filePath,
          content: editedContent,
        })
        queryClient.invalidateQueries({ queryKey: ['planFile', filePath] })
      } catch (err) {
        console.error('[PlanDialog] Auto-save failed:', err)
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [filePath, editedContent, hasChanges, isOpen, editable, queryClient])

  const handleReset = useCallback(() => {
    setEditedContent(originalContent)
  }, [originalContent])

  const handleApprove = useCallback(() => {
    // File is auto-saved, just call the approve callback
    onApprove?.(editedContent)
    onClose()
  }, [editedContent, onApprove, onClose])

  const handleApproveYolo = useCallback(() => {
    // File is auto-saved, just call the approve callback
    onApproveYolo?.(editedContent)
    onClose()
  }, [editedContent, onApproveYolo, onClose])

  const handleClearContextApprove = useCallback(() => {
    onClearContextApprove?.(editedContent)
    onClose()
  }, [editedContent, onClearContextApprove, onClose])

  const handleClearContextBuildApprove = useCallback(() => {
    onClearContextBuildApprove?.(editedContent)
    onClose()
  }, [editedContent, onClearContextBuildApprove, onClose])

  const handleWorktreeBuildApprove = useCallback(() => {
    onWorktreeBuildApprove?.(editedContent)
    onClose()
  }, [editedContent, onWorktreeBuildApprove, onClose])

  const handleWorktreeYoloApprove = useCallback(() => {
    onWorktreeYoloApprove?.(editedContent)
    onClose()
  }, [editedContent, onWorktreeYoloApprove, onClose])

  // Keyboard shortcuts for approve actions
  useEffect(() => {
    if (!isOpen || !editable) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey

      // Check most specific combos first to avoid matching simpler patterns

      // Mod+Alt+Enter = Worktree Build
      if (isMod && e.altKey && e.key === 'Enter') {
        e.preventDefault()
        if (canApprove && onWorktreeBuildApprove) {
          handleWorktreeBuildApprove()
        }
        return
      }

      // Mod+Shift+Enter = Clear Context and build
      if (isMod && e.shiftKey && e.key === 'Enter') {
        e.preventDefault()
        if (canApprove && onClearContextBuildApprove) {
          handleClearContextBuildApprove()
        }
        return
      }

      // Mod+Enter = Approve (no shift, no alt)
      if (isMod && e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (canApprove) {
          handleApprove()
        }
        return
      }

      // Mod+Alt+Y = Worktree Yolo
      if (isMod && e.altKey && (e.key === 'Y' || e.key === 'y')) {
        e.preventDefault()
        if (canApprove && onWorktreeYoloApprove) {
          handleWorktreeYoloApprove()
        }
        return
      }

      // Mod+Shift+Y = Clear Context and yolo
      if (isMod && e.shiftKey && (e.key === 'Y' || e.key === 'y')) {
        e.preventDefault()
        if (canApprove && onClearContextApprove) {
          handleClearContextApprove()
        }
        return
      }

      // Mod+Y = Approve Yolo (no shift, no alt)
      if (isMod && e.key === 'y' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (canApprove) {
          handleApproveYolo()
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, editable, canApprove, handleApprove, handleApproveYolo, onClearContextApprove, handleClearContextApprove, onClearContextBuildApprove, handleClearContextBuildApprove, onWorktreeBuildApprove, handleWorktreeBuildApprove, onWorktreeYoloApprove, handleWorktreeYoloApprove])

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-7xl h-[80vh] min-w-[90vw] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            <span>Plan</span>
            {filename && (
              <code className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                {filename}
              </code>
            )}
          </DialogTitle>
        </DialogHeader>

        {editable && isEditMode ? (
          // Edit mode: textarea
          <Textarea
            value={editedContent}
            onChange={e => setEditedContent(e.target.value)}
            className="flex-1 min-h-0 resize-none font-mono text-sm"
            placeholder="Loading plan..."
          />
        ) : (
          // View mode: rendered markdown
          <ScrollArea className="flex-1 min-h-0 -mx-6 px-6 select-text">
            {!inlineContent && isLoading ? (
              <div className="text-sm text-muted-foreground">
                Loading plan...
              </div>
            ) : (editable ? editedContent : originalContent) ? (
              <Markdown className="text-sm">
                {editable ? editedContent : originalContent}
              </Markdown>
            ) : (
              <div className="text-sm text-destructive">
                Failed to load plan file
              </div>
            )}
          </ScrollArea>
        )}

        {editable && (
          <DialogFooter className="shrink-0 border-t pt-4 -mx-6 px-6 mt-4 sm:justify-between">
            {/* Left side: Edit or Reset button */}
            {isEditMode ? (
              <Button
                variant="ghost"
                onClick={handleReset}
                disabled={!hasChanges}
                className="sm:mr-auto"
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Reset
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => setIsEditMode(true)}
                className="sm:mr-auto"
              >
                <Pencil className="h-4 w-4 mr-2" />
                Edit
              </Button>
            )}

            {/* Right side: Approve + Auto split buttons */}
            <div className="flex gap-2">
              <SplitButton
                label="Approve"
                tooltip={`Approve plan (${formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan)})`}
                onClick={handleApprove}
                disabled={!canApprove}
              >
                {onClearContextBuildApprove && (
                  <DropdownMenuItem onClick={handleClearContextBuildApprove} disabled={!canApprove}>
                    <span className="flex flex-col">
                      <span>New Session</span>
                      {buildLabel && (
                        <span className="text-[10px] text-muted-foreground">{buildLabel}</span>
                      )}
                    </span>
                    <DropdownMenuShortcut>
                      {formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan_clear_context_build)}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
                {onWorktreeBuildApprove && (
                  <DropdownMenuItem onClick={handleWorktreeBuildApprove} disabled={!canApprove}>
                    <span className="flex flex-col">
                      <span>New Worktree</span>
                      {buildLabel && (
                        <span className="text-[10px] text-muted-foreground">{buildLabel}</span>
                      )}
                    </span>
                    <DropdownMenuShortcut>
                      {formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan_worktree_build)}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
              </SplitButton>
              <SplitButton
                label="YOLO"
                tooltip={`Approve with yolo mode (${formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan_yolo)})`}
                variant="outline"
                onClick={handleApproveYolo}
                disabled={!canApprove}
              >
                {onClearContextApprove && (
                  <DropdownMenuItem onClick={handleClearContextApprove} disabled={!canApprove}>
                    <span className="flex flex-col">
                      <span>New Session (YOLO)</span>
                      {yoloLabel && (
                        <span className="text-[10px] text-muted-foreground">{yoloLabel}</span>
                      )}
                    </span>
                    <DropdownMenuShortcut>
                      {formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan_clear_context)}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
                {onWorktreeYoloApprove && (
                  <DropdownMenuItem onClick={handleWorktreeYoloApprove} disabled={!canApprove}>
                    <span className="flex flex-col">
                      <span>New Worktree (YOLO)</span>
                      {yoloLabel && (
                        <span className="text-[10px] text-muted-foreground">{yoloLabel}</span>
                      )}
                    </span>
                    <DropdownMenuShortcut>
                      {formatShortcutDisplay(DEFAULT_KEYBINDINGS.approve_plan_worktree_yolo)}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
              </SplitButton>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
