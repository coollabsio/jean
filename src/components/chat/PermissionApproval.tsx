import { useState, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { ApprovalCard } from './ApprovalCard'
import { ApprovalShortcutKbd, useApprovalShortcuts } from './approval-shortcuts'
import { ChevronRight, CheckCircle2 } from '@/components/icons/reicon'
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

  const [isExpanded, setIsExpanded] = useState(false)

  const handleApprove = useCallback(() => {
    onApprove(sessionId, uniqueDenials.map(formatToolPattern))
  }, [sessionId, uniqueDenials, onApprove])

  const handleApproveYolo = useCallback(() => {
    onApproveYolo?.(sessionId, uniqueDenials.map(formatToolPattern))
  }, [sessionId, uniqueDenials, onApproveYolo])

  useApprovalShortcuts({
    enabled: !readOnly,
    onApprove: handleApprove,
    onApproveYolo: onApproveYolo ? handleApproveYolo : undefined,
    onDeny: onDeny ? () => onDeny(sessionId) : undefined,
  })

  // Read-only collapsed view (after approval)
  if (readOnly && approvedPatterns) {
    return (
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="my-2 rounded-lg border border-border bg-muted/30 text-sm">
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
            <ChevronRight
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                isExpanded && 'rotate-90'
              )}
            />
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
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

  // Interactive approval UI (matches CodexCommandApprovalRequestCard styling)
  return (
    <ApprovalCard
      title={`Claude wants to use ${uniqueDenials.length} tool${uniqueDenials.length !== 1 ? 's' : ''}`}
      actions={
        <>
          <Button size="sm" onClick={handleApprove}>
            Approve
            <ApprovalShortcutKbd action="approve_plan" />
          </Button>
          {onApproveYolo && (
            <Button size="sm" variant="destructive" onClick={handleApproveYolo}>
              Approve (Full access)
              <ApprovalShortcutKbd action="approve_plan_yolo" />
            </Button>
          )}
          {onDeny && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onDeny(sessionId)}
            >
              Deny
              <ApprovalShortcutKbd action="deny_permission" />
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {uniqueDenials.map(denial => {
          const command = getToolCommand(denial)
          return (
            <div key={denial.tool_use_id} className="min-w-0">
              <div className="font-medium">{denial.tool_name}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {getToolDescription(denial)}
              </div>
              {command && (
                <pre className="mt-2 rounded bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
                  {command}
                </pre>
              )}
            </div>
          )
        })}
      </div>
    </ApprovalCard>
  )
}
