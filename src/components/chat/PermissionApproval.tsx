import { useState, useCallback, useMemo, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Kbd } from '@/components/ui/kbd'
import { ShieldAlert, Play, ChevronRight, CheckCircle2 } from 'lucide-react'
import { formatShortcutDisplay, DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { PermissionDenial } from '@/types/chat'

interface PermissionApprovalProps {
  /** Session ID */
  sessionId: string
  /** Denied tools awaiting approval */
  denials: PermissionDenial[]
  /** Callback when user approves selected tools */
  onApprove: (sessionId: string, approvedPatterns: string[]) => void
  /** Callback when user approves with yolo mode (auto-approve all future tools) */
  onApproveYolo?: (sessionId: string, approvedPatterns: string[]) => void
  /** Callback when user denies/cancels */
  onDeny?: (sessionId: string) => void
  /** Read-only mode (after approval) */
  readOnly?: boolean
  /** Approved patterns (for read-only display) */
  approvedPatterns?: string[]
}

/**
 * Format a permission denial into an allowedTools pattern
 * e.g., Bash with command "bun run lint" -> "Bash(bun run lint)"
 */
function formatToolPattern(denial: PermissionDenial): string {
  const { tool_name, tool_input } = denial

  // For Bash, extract the command
  if (
    tool_name === 'Bash' &&
    typeof tool_input === 'object' &&
    tool_input !== null
  ) {
    const command = (tool_input as { command?: string }).command
    if (command) {
      return `Bash(${command})`
    }
  }

  // For other tools, just return the tool name
  return tool_name
}

/**
 * Get a human-readable description of what the tool is trying to do
 */
function getToolDescription(denial: PermissionDenial): string {
  const { tool_name, tool_input } = denial

  if (
    tool_name === 'Bash' &&
    typeof tool_input === 'object' &&
    tool_input !== null
  ) {
    const input = tool_input as { command?: string; description?: string }
    return input.description ?? input.command ?? 'Execute command'
  }

  if (
    tool_name === 'Write' &&
    typeof tool_input === 'object' &&
    tool_input !== null
  ) {
    const input = tool_input as { file_path?: string }
    return input.file_path ? `Write to ${input.file_path}` : 'Write file'
  }

  if (
    tool_name === 'Edit' &&
    typeof tool_input === 'object' &&
    tool_input !== null
  ) {
    const input = tool_input as { file_path?: string }
    return input.file_path ? `Edit ${input.file_path}` : 'Edit file'
  }

  return `Use ${tool_name} tool`
}

/**
 * Get the command/detail text to display for a denial
 */
function getToolCommand(denial: PermissionDenial): string | null {
  const { tool_name, tool_input } = denial

  if (
    tool_name === 'Bash' &&
    typeof tool_input === 'object' &&
    tool_input !== null
  ) {
    return (tool_input as { command?: string }).command ?? null
  }

  return null
}

/**
 * Renders permission approval UI for denied tools from Claude CLI
 * Shows when Claude CLI returns permission_denials and allows users
 * to approve tools for the current session.
 */
export function PermissionApproval({
  sessionId,
  denials,
  onApprove,
  onApproveYolo,
  onDeny,
  readOnly = false,
  approvedPatterns,
}: PermissionApprovalProps) {
  // Deduplicate denials based on the tool pattern
  // Also removes contained patterns (e.g., "cargo build ..." vs "cargo build ... | tail -30")
  const uniqueDenials = useMemo(() => {
    const patterns = denials.map(d => formatToolPattern(d))
    // Extract inner content for containment check (e.g., "Bash(cmd)" → "cmd")
    const innerContent = patterns.map(p => {
      const match = p.match(/^(\w+)\((.+)\)$/)
      return match
        ? { tool: match[1] ?? p, content: match[2] ?? p }
        : { tool: p, content: p }
    })
    const keep = new Set<number>()

    for (let i = 0; i < denials.length; i++) {
      let shouldKeep = true
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const itemI = innerContent[i]!

      for (let j = 0; j < denials.length; j++) {
        if (i === j) continue
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const itemJ = innerContent[j]!

        // Only compare containment for same tool type
        if (itemI.tool === itemJ.tool) {
          // If content[j] is contained in content[i] and shorter → skip i (keep shorter)
          if (
            itemI.content.includes(itemJ.content) &&
            itemJ.content.length < itemI.content.length
          ) {
            shouldKeep = false
            break
          }
        }

        // Exact duplicate of earlier item → skip
        if (j < i && patterns[i] === patterns[j]) {
          shouldKeep = false
          break
        }
      }

      if (shouldKeep) keep.add(i)
    }

    return denials.filter((_, i) => keep.has(i))
  }, [denials])

  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    () => new Set(uniqueDenials.map((_, i) => i)) // All selected by default
  )
  const [isExpanded, setIsExpanded] = useState(false)

  const toggleSelection = useCallback((index: number) => {
    setSelectedIndices(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [])

  const handleApprove = useCallback(() => {
    const patterns = uniqueDenials
      .filter((_, i) => selectedIndices.has(i))
      .map(formatToolPattern)
    onApprove(sessionId, patterns)
  }, [sessionId, uniqueDenials, selectedIndices, onApprove])

  const handleApproveYolo = useCallback(() => {
    const patterns = uniqueDenials
      .filter((_, i) => selectedIndices.has(i))
      .map(formatToolPattern)
    onApproveYolo?.(sessionId, patterns)
  }, [sessionId, uniqueDenials, selectedIndices, onApproveYolo])

  // Listen for CMD+ENTER to approve (same event as answer-question)
  useEffect(() => {
    if (readOnly) return

    const handleAnswerQuestion = () => {
      if (selectedIndices.size > 0) {
        handleApprove()
      }
    }

    window.addEventListener('answer-question', handleAnswerQuestion)
    return () =>
      window.removeEventListener('answer-question', handleAnswerQuestion)
  }, [readOnly, selectedIndices.size, handleApprove])

  // Listen for CMD+Y to approve with yolo mode
  useEffect(() => {
    if (readOnly || !onApproveYolo) return

    const handler = () => {
      if (selectedIndices.size > 0) {
        handleApproveYolo()
      }
    }

    window.addEventListener('approve-plan-yolo', handler)
    return () => window.removeEventListener('approve-plan-yolo', handler)
  }, [readOnly, selectedIndices.size, handleApproveYolo, onApproveYolo])

  // Read-only collapsed view (after approval)
  if (readOnly && approvedPatterns) {
    return (
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="my-2 rounded border border-border/50 bg-muted/30 font-mono text-sm">
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
            <ChevronRight
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                isExpanded && 'rotate-90'
              )}
            />
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
            <span className="truncate text-muted-foreground">
              Approved {approvedPatterns.length} tool
              {approvedPatterns.length !== 1 ? 's' : ''}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-1 border-t border-border/30 px-4 py-3">
              {approvedPatterns.map(pattern => (
                <div
                  key={pattern}
                  className="font-mono text-xs text-muted-foreground"
                >
                  {pattern}
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    )
  }

  // Interactive approval UI
  return (
    <div className="my-3 rounded border border-yellow-500/30 bg-yellow-500/5 p-4 font-mono text-sm">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-yellow-500" />
        <span className="font-semibold text-foreground">
          Permission Required
        </span>
        <span className="rounded bg-yellow-500/20 px-1.5 py-0.5 text-xs text-yellow-600 dark:text-yellow-400">
          {uniqueDenials.length} tool{uniqueDenials.length !== 1 ? 's' : ''}{' '}
          blocked
        </span>
      </div>

      <div className="mb-4 text-muted-foreground">
        Jean wants to use the following tools. Select which to allow:
      </div>

      <div className="mb-4 space-y-2.5">
        {uniqueDenials.map((denial, index) => {
          const command = getToolCommand(denial)
          return (
            <div
              key={denial.tool_use_id}
              className="flex items-start gap-2.5 rounded border border-border/30 bg-muted/30 p-2.5"
            >
              <Checkbox
                id={`permission-${sessionId}-${index}`}
                checked={selectedIndices.has(index)}
                onCheckedChange={() => toggleSelection(index)}
                className="mt-3"
              />
              <Label
                htmlFor={`permission-${sessionId}-${index}`}
                className="flex-1 cursor-pointer"
              >
                {command && (
                  <div className="mt-1 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground/80">
                    {command}
                  </div>
                )}
                <div className="mt-1">
                  <div className="font-medium">{denial.tool_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {getToolDescription(denial)}
                  </div>
                </div>
              </Label>
            </div>
          )
        })}
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleApprove}
          disabled={selectedIndices.size === 0}
          className="gap-1 !bg-primary/80 !border-primary !text-primary-foreground hover:!bg-primary/90"
        >
          <Play className="h-3 w-3" />
          Approve & Continue
          <Kbd className="ml-1.5 h-4 text-[10px] bg-primary-foreground/20 text-primary-foreground">
            {formatShortcutDisplay(
              DEFAULT_KEYBINDINGS.approve_plan ?? 'mod+enter'
            )}
          </Kbd>
        </Button>
        {onApproveYolo && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleApproveYolo}
            disabled={selectedIndices.size === 0}
            className="gap-1 !bg-destructive !border-destructive !text-white hover:!bg-destructive/90 dark:!bg-destructive/60"
          >
            <Play className="h-3 w-3" />
            Approve (yolo)
            <Kbd className="ml-1.5 h-4 text-[10px] bg-destructive-foreground/20 text-destructive-foreground">
              {formatShortcutDisplay(
                DEFAULT_KEYBINDINGS.approve_plan_yolo ?? 'mod+y'
              )}
            </Kbd>
          </Button>
        )}
        {onDeny && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDeny(sessionId)}
            className="text-muted-foreground"
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
