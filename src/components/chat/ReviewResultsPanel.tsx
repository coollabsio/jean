import { useState, useCallback, memo } from 'react'
import { useChatStore } from '@/store/chat-store'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  AlertCircle,
  AlertTriangle,
  Lightbulb,
  ThumbsUp,
  CheckCircle2,
  MessageSquare,
  FileCode,
  ChevronRight,
  Loader2,
  Wrench,
} from 'lucide-react'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import type { ReviewFinding, ReviewResponse } from '@/types/projects'
import { cn } from '@/lib/utils'

interface ReviewResultsPanelProps {
  sessionId: string
  onSendFix?: (message: string, executionMode: 'plan' | 'yolo') => void
}

/** Generate a unique key for a review finding */
function getReviewFindingKey(finding: ReviewFinding, index: number): string {
  return `${finding.file}:${finding.line ?? 0}:${index}`
}

/** Get severity icon and color */
function getSeverityConfig(severity: string) {
  switch (severity) {
    case 'critical':
      return {
        icon: AlertCircle,
        color: 'text-red-500',
        borderColor: 'border-red-500/20',
        label: 'Critical',
      }
    case 'warning':
      return {
        icon: AlertTriangle,
        color: 'text-yellow-500',
        borderColor: 'border-yellow-500/20',
        label: 'Warning',
      }
    case 'suggestion':
      return {
        icon: Lightbulb,
        color: 'text-blue-500',
        borderColor: 'border-blue-500/20',
        label: 'Suggestion',
      }
    case 'praise':
      return {
        icon: ThumbsUp,
        color: 'text-green-500',
        borderColor: 'border-green-500/20',
        label: 'Good',
      }
    default:
      return {
        icon: MessageSquare,
        color: 'text-muted-foreground',
        borderColor: 'border-muted/20',
        label: severity,
      }
  }
}

/** Severity order for sorting (lower = higher priority) */
const SEVERITY_ORDER: Record<ReviewFinding['severity'], number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
  praise: 3,
}

/** Sort findings by severity (critical first, praise last), preserving original indices */
function sortFindingsBySeverity(
  findings: ReviewFinding[]
): { finding: ReviewFinding; originalIndex: number }[] {
  return findings
    .map((finding, originalIndex) => ({ finding, originalIndex }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
    )
}

/** Get approval status config */
function getApprovalConfig(status: string) {
  switch (status) {
    case 'approved':
      return {
        icon: CheckCircle2,
        color: 'text-green-500',
        label: 'Approved',
      }
    case 'changes_requested':
      return {
        icon: AlertTriangle,
        color: 'text-yellow-500',
        label: 'Changes Requested',
      }
    case 'needs_discussion':
      return {
        icon: MessageSquare,
        color: 'text-blue-500',
        label: 'Needs Discussion',
      }
    default:
      return {
        icon: MessageSquare,
        color: 'text-muted-foreground',
        label: status,
      }
  }
}

interface FindingCardProps {
  finding: ReviewFinding
  index: number
  isFixed: boolean
  isFixing: boolean
  onFix: (
    finding: ReviewFinding,
    index: number,
    customSuggestion?: string,
    executionMode?: 'plan' | 'yolo'
  ) => void
}

/** Interactive finding card with fix functionality - memoized to prevent re-renders */
const FindingCard = memo(function FindingCard({
  finding,
  index,
  isFixed,
  isFixing,
  onFix,
}: FindingCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [customSuggestion, setCustomSuggestion] = useState('')

  const config = getSeverityConfig(finding.severity)
  const Icon = config.icon

  // Don't show fix for praise findings
  const canFix = finding.severity !== 'praise'

  const handleFix = useCallback(
    (executionMode: 'plan' | 'yolo') => {
      onFix(finding, index, customSuggestion.trim() || undefined, executionMode)
      setIsExpanded(false)
    },
    [finding, index, customSuggestion, onFix]
  )

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          'border-l-2 rounded-md bg-muted/30',
          config.borderColor,
          isFixed && 'opacity-60'
        )}
      >
        {/* Header */}
        <CollapsibleTrigger asChild>
          <div className="flex w-full items-center gap-2 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors">
            <ChevronRight
              className={cn(
                'h-4 w-4 shrink-0 transition-transform text-muted-foreground',
                isExpanded && 'rotate-90'
              )}
            />
            <Icon className={cn('h-4 w-4 shrink-0', config.color)} />
            <Badge
              variant="outline"
              className={cn('text-xs', config.color, 'border-current')}
            >
              {config.label}
            </Badge>
            <span className="flex-1 truncate text-sm font-medium">
              #{index + 1}: {finding.title}
            </span>
            {isFixed && (
              <Badge
                variant="outline"
                className="text-xs text-green-500 border-green-500"
              >
                Fixed
              </Badge>
            )}
          </div>
        </CollapsibleTrigger>

        {/* Content */}
        <CollapsibleContent>
          <div className="px-4 pb-4 pt-3 space-y-3 border-t border-border/50">
            {/* File location */}
            <p className="text-xs font-mono select-text cursor-text">
              <span className="text-muted-foreground">Affected code: </span>
              <span className="text-foreground">
                {finding.file}
                {finding.line ? `:${finding.line}` : ''}
              </span>
            </p>

            {/* Description */}
            <p className="text-sm text-muted-foreground select-text cursor-text">
              {finding.description}
            </p>

            {/* Suggested fix */}
            {finding.suggestion && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Suggested fix:
                </p>
                <div className="rounded-md bg-muted/50 p-2 border">
                  <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 select-text cursor-text">
                    {finding.suggestion}
                  </pre>
                </div>
              </div>
            )}

            {/* Custom suggestion input and fix button - always show when canFix */}
            {canFix && (
              <div className="space-y-2 pt-2">
                <Textarea
                  value={customSuggestion}
                  onChange={e => setCustomSuggestion(e.target.value)}
                  className="font-mono min-h-[60px] text-xs"
                  placeholder="Custom fix instructions (optional)..."
                />
                <div className="flex items-center justify-end gap-2">
                  {isFixed && (
                    <Badge
                      variant="outline"
                      className="text-xs text-green-500 border-green-500"
                    >
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Fix sent
                    </Badge>
                  )}
                  <Button
                    onClick={() => handleFix('plan')}
                    disabled={isFixing}
                    size="sm"
                  >
                    {isFixing ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Fixing...
                      </>
                    ) : isFixed ? (
                      <>Fix again</>
                    ) : (
                      <>Fix</>
                    )}
                  </Button>
                  <Button
                    onClick={() => handleFix('yolo')}
                    disabled={isFixing}
                    size="sm"
                    variant="destructive"
                  >
                    {isFixing ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Fixing...
                      </>
                    ) : isFixed ? (
                      <>Fix again (yolo)</>
                    ) : (
                      <>Fix (yolo)</>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})

/** Empty state when no review results */
function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <FileCode className="mx-auto h-12 w-12 text-muted-foreground/30" />
        <p className="mt-2 text-sm text-muted-foreground">No review results</p>
      </div>
    </div>
  )
}

export function ReviewResultsPanel({ sessionId, onSendFix }: ReviewResultsPanelProps) {
  const [fixingIndices, setFixingIndices] = useState<Set<number>>(new Set())
  const [isFixingAll, setIsFixingAll] = useState(false)

  const reviewResults = useChatStore(
    state => state.reviewResults[sessionId]
  ) as ReviewResponse | undefined
  const fixedReviewFindings = useChatStore(
    state => state.fixedReviewFindings[sessionId]
  )

  // Check if a finding is fixed
  const isFindingFixed = useCallback(
    (finding: ReviewFinding, index: number) => {
      const key = getReviewFindingKey(finding, index)
      return fixedReviewFindings?.has(key) ?? false
    },
    [fixedReviewFindings]
  )

  // Handle fixing a single finding - sends fix message via callback
  const handleFixFinding = useCallback(
    (
      finding: ReviewFinding,
      index: number,
      customSuggestion?: string,
      executionMode?: 'plan' | 'yolo'
    ) => {
      if (!onSendFix) return

      setFixingIndices(prev => new Set(prev).add(index))

      try {
        const suggestionToApply = customSuggestion ?? finding.suggestion ?? ''

        const message = `Fix the following code review finding:

**File:** ${finding.file}
**Line:** ${finding.line ?? 'N/A'}
**Issue:** ${finding.title}

${finding.description}

**Suggested fix:**
${suggestionToApply || '(Please determine the best fix)'}

Please apply this fix to the file.`

        // Mark as fixed
        const findingKey = getReviewFindingKey(finding, index)
        useChatStore.getState().markReviewFindingFixed(sessionId, findingKey)

        onSendFix(message, executionMode ?? 'plan')
      } finally {
        setFixingIndices(prev => {
          const next = new Set(prev)
          next.delete(index)
          return next
        })
      }
    },
    [sessionId, onSendFix]
  )

  // Handle fixing all unfixed findings - auto-sends fix message in same session
  const handleFixAll = useCallback(
    (executionMode: 'plan' | 'yolo') => {
      if (!reviewResults || !onSendFix) return

      setIsFixingAll(true)

      try {
        // Get unfixed, fixable findings
        const unfixedFindings = reviewResults.findings
          .map((finding, index) => ({ finding, index }))
          .filter(
            ({ finding, index }) =>
              finding.severity !== 'praise' && !isFindingFixed(finding, index)
          )

        if (unfixedFindings.length === 0) return

        const message = `Fix the following ${unfixedFindings.length} code review findings:

${unfixedFindings
  .map(
    ({ finding }, i) => `
### ${i + 1}. ${finding.title}
**File:** ${finding.file}
**Line:** ${finding.line ?? 'N/A'}

${finding.description}

**Suggested fix:**
${finding.suggestion ?? '(Please determine the best fix)'}
`
  )
  .join('\n---\n')}

Please apply all these fixes to the codebase.`

        const { markReviewFindingFixed } = useChatStore.getState()

        // Mark all as fixed
        for (const { finding, index } of unfixedFindings) {
          const findingKey = getReviewFindingKey(finding, index)
          markReviewFindingFixed(sessionId, findingKey)
        }

        onSendFix(message, executionMode)
      } finally {
        setIsFixingAll(false)
      }
    },
    [reviewResults, sessionId, isFindingFixed, onSendFix]
  )

  if (!reviewResults) {
    return <EmptyState />
  }

  const approvalConfig = getApprovalConfig(reviewResults.approval_status)
  const ApprovalIcon = approvalConfig.icon

  // Count findings by severity and fixed status
  const counts = reviewResults.findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  // Count fixable findings (exclude praise)
  const fixableFindings = reviewResults.findings.filter(
    (f, i) => f.severity !== 'praise' && !isFindingFixed(f, i)
  )
  const unfixedCount = fixableFindings.length
  const fixedCount = reviewResults.findings.filter(
    (f, i) => f.severity !== 'praise' && isFindingFixed(f, i)
  ).length

  return (
    <div className="relative flex h-full flex-col bg-background border-l">
      {/* Sidebar title bar */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Review
        </span>
        <ModalCloseButton
          size="sm"
          onClick={() => useChatStore.getState().setReviewSidebarVisible(false)}
        />
      </div>
      {/* Header with summary */}
      <div className="border-b p-3">
        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2.5 py-1',
                  approvalConfig.label === 'Changes Requested' &&
                    'bg-yellow-500/10'
                )}
              >
                <ApprovalIcon className={cn('h-4 w-4', approvalConfig.color)} />
                <span
                  className={cn('text-sm font-medium', approvalConfig.color)}
                >
                  {approvalConfig.label}
                </span>
              </div>
              {fixedCount > 0 && (
                <Badge
                  variant="outline"
                  className="text-green-500 border-green-500"
                >
                  {fixedCount} fixed
                </Badge>
              )}
              {unfixedCount > 0 && (
                <Badge
                  variant="outline"
                  className="text-amber-500 border-amber-500"
                >
                  {unfixedCount} remaining
                </Badge>
              )}
            </div>
            <p className="text-sm leading-6 text-muted-foreground select-text cursor-text">
              {reviewResults.summary}
            </p>
          </div>

          {/* Fix All buttons */}
          {unfixedCount > 0 && (
            <div className="grid grid-cols-1 gap-2">
              <Button
                onClick={() => handleFixAll('plan')}
                disabled={isFixingAll}
                size="sm"
                className="justify-start"
              >
                {isFixingAll ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Fixing...
                  </>
                ) : (
                  <>
                    <Wrench className="h-3.5 w-3.5" />
                    Fix all ({unfixedCount})
                  </>
                )}
              </Button>
              <Button
                onClick={() => handleFixAll('yolo')}
                disabled={isFixingAll}
                size="sm"
                variant="destructive"
                className="justify-start"
              >
                {isFixingAll ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Fixing...
                  </>
                ) : (
                  <>
                    <Wrench className="h-3.5 w-3.5" />
                    Auto-fix all (yolo) ({unfixedCount})
                  </>
                )}
              </Button>
            </div>
          )}
        </div>

        {/* Finding counts */}
        {reviewResults.findings.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {counts.critical && (
              <Badge variant="outline" className="text-red-500">
                {counts.critical} critical
              </Badge>
            )}
            {counts.warning && (
              <Badge variant="outline" className="text-yellow-500">
                {counts.warning} warning{counts.warning > 1 ? 's' : ''}
              </Badge>
            )}
            {counts.suggestion && (
              <Badge variant="outline" className="text-blue-500">
                {counts.suggestion} suggestion{counts.suggestion > 1 ? 's' : ''}
              </Badge>
            )}
            {counts.praise && (
              <Badge variant="outline" className="text-green-500">
                {counts.praise} praise
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Findings list */}
      <ScrollArea className="flex-1">
        {reviewResults.findings.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              No specific findings - code looks good!
            </p>
          </div>
        ) : (
          <div className="space-y-2 p-2">
            {sortFindingsBySeverity(reviewResults.findings).map(
              ({ finding, originalIndex }) => (
                <FindingCard
                  key={getReviewFindingKey(finding, originalIndex)}
                  finding={finding}
                  index={originalIndex}
                  isFixed={isFindingFixed(finding, originalIndex)}
                  isFixing={fixingIndices.has(originalIndex)}
                  onFix={handleFixFinding}
                />
              )
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
