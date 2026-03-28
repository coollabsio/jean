import { useState, useCallback, useMemo } from 'react'
import { useChatStore } from '@/store/chat-store'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertCircle,
  AlertTriangle,
  Lightbulb,
  ThumbsUp,
  CheckCircle2,
  MessageSquare,
  FileCode,
  Loader2,
  Wrench,
} from 'lucide-react'
import { ModalCloseButton } from '@/components/ui/modal-close-button'
import type { ReviewFinding, ReviewResponse } from '@/types/projects'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
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
        bgColor: 'bg-red-500/10',
        label: 'Critical',
      }
    case 'warning':
      return {
        icon: AlertTriangle,
        color: 'text-yellow-500',
        bgColor: 'bg-yellow-500/10',
        label: 'Warning',
      }
    case 'suggestion':
      return {
        icon: Lightbulb,
        color: 'text-blue-500',
        bgColor: 'bg-blue-500/10',
        label: 'Suggestion',
      }
    case 'praise':
      return {
        icon: ThumbsUp,
        color: 'text-green-500',
        bgColor: 'bg-green-500/10',
        label: 'Good',
      }
    default:
      return {
        icon: MessageSquare,
        color: 'text-muted-foreground',
        bgColor: 'bg-muted/10',
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

export function ReviewResultsPanel({
  sessionId,
  onSendFix,
}: ReviewResultsPanelProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [customSuggestion, setCustomSuggestion] = useState('')
  const [fixingIndices, setFixingIndices] = useState<Set<number>>(new Set())
  const [isFixingAll, setIsFixingAll] = useState(false)

  const reviewResults = useChatStore(
    state => state.reviewResults[sessionId]
  ) as ReviewResponse | undefined
  const fixedReviewFindings = useChatStore(
    state => state.fixedReviewFindings[sessionId]
  )

  const isFindingFixed = useCallback(
    (finding: ReviewFinding, index: number) => {
      const key = getReviewFindingKey(finding, index)
      return fixedReviewFindings?.has(key) ?? false
    },
    [fixedReviewFindings]
  )

  const sortedFindings = useMemo(
    () => (reviewResults ? sortFindingsBySeverity(reviewResults.findings) : []),
    [reviewResults]
  )

  // Auto-select first finding when results load and nothing is selected
  const effectiveSelectedIndex =
    selectedIndex ?? sortedFindings[0]?.originalIndex ?? null
  const effectiveFinding = useMemo(() => {
    if (effectiveSelectedIndex === null) return null
    return (
      sortedFindings.find(f => f.originalIndex === effectiveSelectedIndex) ??
      null
    )
  }, [effectiveSelectedIndex, sortedFindings])

  // Reset custom suggestion when selection changes
  const handleSelect = useCallback((index: number) => {
    setSelectedIndex(index)
    setCustomSuggestion('')
  }, [])

  const handleFixFinding = useCallback(
    (
      finding: ReviewFinding,
      index: number,
      suggestion?: string,
      executionMode?: 'plan' | 'yolo'
    ) => {
      if (!onSendFix) return

      setFixingIndices(prev => new Set(prev).add(index))

      try {
        const suggestionToApply = suggestion ?? finding.suggestion ?? ''

        const message = `Fix the following code review finding:

**File:** ${finding.file}
**Line:** ${finding.line ?? 'N/A'}
**Issue:** ${finding.title}

${finding.description}

**Suggested fix:**
${suggestionToApply || '(Please determine the best fix)'}

Please apply this fix to the file.`

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

  const handleFixAll = useCallback(
    (executionMode: 'plan' | 'yolo') => {
      if (!reviewResults || !onSendFix) return

      setIsFixingAll(true)

      try {
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

  const counts = reviewResults.findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  const unfixedCount = reviewResults.findings.filter(
    (f, i) => f.severity !== 'praise' && !isFindingFixed(f, i)
  ).length
  const fixedCount = reviewResults.findings.filter(
    (f, i) => f.severity !== 'praise' && isFindingFixed(f, i)
  ).length

  const canFix =
    effectiveFinding && effectiveFinding.finding.severity !== 'praise'
  const isCurrentFixed = effectiveFinding
    ? isFindingFixed(effectiveFinding.finding, effectiveFinding.originalIndex)
    : false
  const isCurrentFixing =
    effectiveSelectedIndex !== null && fixingIndices.has(effectiveSelectedIndex)

  return (
    <div className="relative flex h-full flex-col bg-background">
      {/* Title bar */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Review
          </span>
          <div className="flex items-center gap-1.5">
            <ApprovalIcon className={cn('h-3.5 w-3.5', approvalConfig.color)} />
            <span className={cn('text-xs font-medium', approvalConfig.color)}>
              {approvalConfig.label}
            </span>
          </div>
          {/* Severity counts */}
          <div className="flex items-center gap-1.5">
            {(counts.critical ?? 0) > 0 && (
              <Badge
                variant="outline"
                className="text-red-500 text-[10px] px-1.5 py-0"
              >
                {counts.critical} critical
              </Badge>
            )}
            {(counts.warning ?? 0) > 0 && (
              <Badge
                variant="outline"
                className="text-yellow-500 text-[10px] px-1.5 py-0"
              >
                {counts.warning} warning
              </Badge>
            )}
            {(counts.suggestion ?? 0) > 0 && (
              <Badge
                variant="outline"
                className="text-blue-500 text-[10px] px-1.5 py-0"
              >
                {counts.suggestion} suggestion
              </Badge>
            )}
            {(counts.praise ?? 0) > 0 && (
              <Badge
                variant="outline"
                className="text-green-500 text-[10px] px-1.5 py-0"
              >
                {counts.praise} praise
              </Badge>
            )}
          </div>
          {fixedCount > 0 && (
            <Badge
              variant="outline"
              className="text-green-500 border-green-500 text-[10px] px-1.5 py-0"
            >
              {fixedCount} fixed
            </Badge>
          )}
        </div>
        <ModalCloseButton
          size="sm"
          onClick={() => useChatStore.getState().setReviewSidebarVisible(false)}
        />
      </div>

      {/* Master-detail layout */}
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
        {/* Left sidebar: findings list */}
        <ResizablePanel
          defaultSize={40}
          minSize={15}
          maxSize={60}
          className="flex flex-col min-h-0"
        >
          {/* Fix all actions */}
          {unfixedCount > 0 && (
            <div className="border-b p-2 flex gap-1.5">
              <Button
                onClick={() => handleFixAll('plan')}
                disabled={isFixingAll}
                size="sm"
                variant="outline"
                className="flex-1 h-7 text-xs"
              >
                {isFixingAll ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    <Wrench className="h-3 w-3" />
                    Fix all ({unfixedCount})
                  </>
                )}
              </Button>
              <Button
                onClick={() => handleFixAll('yolo')}
                disabled={isFixingAll}
                size="sm"
                variant="destructive"
                className="flex-1 h-7 text-xs"
              >
                {isFixingAll ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    <Wrench className="h-3 w-3" />
                    Yolo all ({unfixedCount})
                  </>
                )}
              </Button>
            </div>
          )}

          {/* File-grouped finding list */}
          <ScrollArea className="flex-1">
            <div className="py-1">
              {sortedFindings.map(({ finding, originalIndex }) => {
                const config = getSeverityConfig(finding.severity)
                const Icon = config.icon
                const isFixed = isFindingFixed(finding, originalIndex)
                const isSelected = effectiveSelectedIndex === originalIndex

                return (
                  <button
                    key={getReviewFindingKey(finding, originalIndex)}
                    onClick={() => handleSelect(originalIndex)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                      'hover:bg-muted/50',
                      isSelected && 'bg-muted',
                      isFixed && 'opacity-50'
                    )}
                  >
                    <Icon
                      className={cn('h-3.5 w-3.5 shrink-0', config.color)}
                    />
                    <span className="flex-1 truncate text-xs">
                      {finding.title}
                    </span>
                    {isFixed && (
                      <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
                    )}
                  </button>
                )
              })}
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle />

        {/* Right detail panel */}
        <ResizablePanel
          defaultSize={60}
          className="flex flex-col min-h-0 min-w-0"
        >
          {effectiveFinding ? (
            <>
              {/* Finding detail header */}
              <div className="border-b px-6 py-4">
                <div className="flex items-start gap-3">
                  {(() => {
                    const config = getSeverityConfig(
                      effectiveFinding.finding.severity
                    )
                    const Icon = config.icon
                    return (
                      <div
                        className={cn(
                          'mt-0.5 rounded-md p-1.5',
                          config.bgColor
                        )}
                      >
                        <Icon className={cn('h-4 w-4', config.color)} />
                      </div>
                    )
                  })()}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">
                        {effectiveFinding.finding.title}
                      </h3>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] px-1.5 py-0',
                          getSeverityConfig(effectiveFinding.finding.severity)
                            .color,
                          'border-current'
                        )}
                      >
                        {
                          getSeverityConfig(effectiveFinding.finding.severity)
                            .label
                        }
                      </Badge>
                      {isCurrentFixed && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 text-green-500 border-green-500"
                        >
                          Fixed
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs font-mono text-muted-foreground select-text cursor-text">
                      {effectiveFinding.finding.file}
                      {effectiveFinding.finding.line
                        ? `:${effectiveFinding.finding.line}`
                        : ''}
                    </p>
                  </div>
                </div>
              </div>

              {/* Finding detail content */}
              <ScrollArea className="flex-1">
                <div className="px-6 py-4 space-y-4 max-w-3xl">
                  {/* Description */}
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Description
                    </h4>
                    <p className="text-sm leading-relaxed text-foreground/90 select-text cursor-text">
                      {effectiveFinding.finding.description}
                    </p>
                  </div>

                  {/* Suggested fix */}
                  {effectiveFinding.finding.suggestion && (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        Suggested Fix
                      </h4>
                      <div className="rounded-md bg-muted/50 p-3 border">
                        <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 select-text cursor-text">
                          {effectiveFinding.finding.suggestion}
                        </pre>
                      </div>
                    </div>
                  )}

                  {/* Custom instructions + fix actions */}
                  {canFix && (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        Fix Instructions
                      </h4>
                      <Textarea
                        value={customSuggestion}
                        onChange={e => setCustomSuggestion(e.target.value)}
                        className="font-mono min-h-[80px] text-xs"
                        placeholder="Custom fix instructions (optional)..."
                      />
                      <div className="flex items-center gap-2 mt-3">
                        <Button
                          onClick={() =>
                            handleFixFinding(
                              effectiveFinding.finding,
                              effectiveFinding.originalIndex,
                              customSuggestion.trim() || undefined,
                              'plan'
                            )
                          }
                          disabled={isCurrentFixing}
                          size="sm"
                        >
                          {isCurrentFixing ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Fixing...
                            </>
                          ) : isCurrentFixed ? (
                            'Fix again'
                          ) : (
                            'Fix'
                          )}
                        </Button>
                        <Button
                          onClick={() =>
                            handleFixFinding(
                              effectiveFinding.finding,
                              effectiveFinding.originalIndex,
                              customSuggestion.trim() || undefined,
                              'yolo'
                            )
                          }
                          disabled={isCurrentFixing}
                          size="sm"
                          variant="destructive"
                        >
                          {isCurrentFixing ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Fixing...
                            </>
                          ) : isCurrentFixed ? (
                            'Fix again (yolo)'
                          ) : (
                            'Fix (yolo)'
                          )}
                        </Button>
                        {isCurrentFixed && (
                          <Badge
                            variant="outline"
                            className="text-xs text-green-500 border-green-500"
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Fix sent
                          </Badge>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Summary (shown below the finding detail for context) */}
                  <div className="border-t pt-4 mt-4">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Review Summary
                    </h4>
                    <p className="text-xs leading-relaxed text-muted-foreground select-text cursor-text">
                      {reviewResults.summary}
                    </p>
                  </div>
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <FileCode className="mx-auto h-12 w-12 text-muted-foreground/30" />
                <p className="mt-2 text-sm text-muted-foreground">
                  {reviewResults.findings.length === 0
                    ? 'No specific findings - code looks good!'
                    : 'Select a finding to view details'}
                </p>
              </div>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
