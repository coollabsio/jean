import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertCircle,
  AlertTriangle,
  Lightbulb,
  CheckCircle2,
  MessageSquare,
  FileCode,
  Loader2,
  Wrench,
} from 'lucide-react'
import type {
  ReviewFinding,
  ReviewResponse,
  StoredReviewResults,
} from '@/types/projects'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'

interface ReviewResultsPanelProps {
  sessionId: string
  isReviewing?: boolean
  onSendFix?: (message: string, executionMode: 'plan' | 'yolo') => void
}

/** Generate a unique key for a review finding */
function getReviewFindingKey(finding: ReviewFinding, index: number): string {
  return `${finding.file}:${finding.line ?? 0}:${index}`
}

function getStoredReviewFindingKey(
  finding: ReviewFinding,
  index: number,
  reviewKey: string | null
): string {
  const findingKey = getReviewFindingKey(finding, index)
  return reviewKey ? `${reviewKey}:${findingKey}` : findingKey
}

function formatReviewBackendName(backend: string): string {
  if (backend === 'opencode') return 'OpenCode'
  if (backend === 'commandcode') return 'Command Code'
  if (backend === 'kimi') return 'Kimi Code'
  if (backend === 'coderabbit-cli') return 'CodeRabbit CLI'
  return backend.charAt(0).toUpperCase() + backend.slice(1)
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
}

function getSeverityRank(severity: string): number {
  return SEVERITY_ORDER[severity as ReviewFinding['severity']] ?? 99
}

/** Sort findings by severity (critical first), preserving original indices */
function sortFindingsBySeverity(
  findings: ReviewFinding[]
): { finding: ReviewFinding; originalIndex: number }[] {
  return findings
    .map((finding, originalIndex) => ({ finding, originalIndex }))
    .sort(
      (a, b) =>
        getSeverityRank(a.finding.severity) -
        getSeverityRank(b.finding.severity)
    )
}

function formatReviewMetadata(value: string): string {
  return value
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function isFixAllCandidate(finding: ReviewFinding): boolean {
  const severity = finding.severity as string
  return (
    severity !== 'praise' &&
    (finding.blocking === true || severity !== 'suggestion')
  )
}

function isFixableFinding(finding: ReviewFinding): boolean {
  return (finding.severity as string) !== 'praise'
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
function EmptyState({ isReviewing = false }: { isReviewing?: boolean }) {
  if (isReviewing) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-muted-foreground/60" />
          <p className="mt-3 text-sm font-medium">Review running...</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Results will appear here when the review finishes.
          </p>
        </div>
      </div>
    )
  }

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
  isReviewing = false,
  onSendFix,
}: ReviewResultsPanelProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [customSuggestion, setCustomSuggestion] = useState('')
  const [fixingIndices, setFixingIndices] = useState<Set<number>>(new Set())
  const [isFixingAll, setIsFixingAll] = useState(false)
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(
    null
  )
  const detailViewportRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  const storedReviewResults = useChatStore(
    state => state.reviewResults[sessionId]
  ) as StoredReviewResults | undefined
  const reviewEntries = useMemo(
    () =>
      storedReviewResults && 'reviews' in storedReviewResults
        ? storedReviewResults.reviews
        : [],
    [storedReviewResults]
  )
  const effectiveReviewKey =
    (selectedReviewKey &&
    reviewEntries.some(
      entry => `${entry.backend}\u0000${entry.model}` === selectedReviewKey
    )
      ? selectedReviewKey
      : null) ??
    (reviewEntries[0]
      ? `${reviewEntries[0].backend}\u0000${reviewEntries[0].model}`
      : null)
  const selectedReviewEntry = reviewEntries.find(
    entry => `${entry.backend}\u0000${entry.model}` === effectiveReviewKey
  )
  const reviewResults: ReviewResponse | undefined =
    selectedReviewEntry?.result ??
    (storedReviewResults && !('reviews' in storedReviewResults)
      ? storedReviewResults
      : undefined)
  const fixedReviewFindings = useChatStore(
    state => state.fixedReviewFindings[sessionId]
  )

  const isFindingFixed = useCallback(
    (finding: ReviewFinding, index: number) => {
      const key = getStoredReviewFindingKey(finding, index, effectiveReviewKey)
      return fixedReviewFindings?.has(key) ?? false
    },
    [effectiveReviewKey, fixedReviewFindings]
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

  const handleReviewSelect = useCallback((key: string) => {
    setSelectedReviewKey(key)
    setSelectedIndex(null)
    setCustomSuggestion('')
  }, [])

  const reviewSelector =
    reviewEntries.length > 1 && effectiveReviewKey ? (
      <Select value={effectiveReviewKey} onValueChange={handleReviewSelect}>
        <SelectTrigger className="h-7 w-auto min-w-48 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {reviewEntries.map(entry => {
            const key = `${entry.backend}\u0000${entry.model}`
            return (
              <SelectItem key={key} value={key}>
                <span className="flex items-center gap-1.5">
                  {formatReviewBackendName(entry.backend)} · {entry.model}
                  {entry.status === 'running' && (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span className="sr-only">Running</span>
                    </>
                  )}
                </span>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    ) : null

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

        const findingKey = getStoredReviewFindingKey(
          finding,
          index,
          effectiveReviewKey
        )
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
    [effectiveReviewKey, sessionId, onSendFix]
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
              isFixAllCandidate(finding) && !isFindingFixed(finding, index)
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
          const findingKey = getStoredReviewFindingKey(
            finding,
            index,
            effectiveReviewKey
          )
          markReviewFindingFixed(sessionId, findingKey)
        }

        onSendFix(message, executionMode)
      } finally {
        setIsFixingAll(false)
      }
    },
    [effectiveReviewKey, reviewResults, sessionId, isFindingFixed, onSendFix]
  )

  useEffect(() => {
    if (detailViewportRef.current) {
      detailViewportRef.current.scrollTop = 0
    }
  }, [effectiveSelectedIndex])

  if (!reviewResults) {
    return (
      <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-background">
        {reviewSelector && (
          <div className="flex items-center gap-3 border-b px-4 py-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Review
            </span>
            {reviewSelector}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <EmptyState
            isReviewing={
              isReviewing || selectedReviewEntry?.status === 'running'
            }
          />
        </div>
      </div>
    )
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
    (f, i) => isFixAllCandidate(f) && !isFindingFixed(f, i)
  ).length
  const fixedCount = reviewResults.findings.filter((f, i) =>
    isFindingFixed(f, i)
  ).length

  const canFix =
    !!effectiveFinding && isFixableFinding(effectiveFinding.finding)
  const isCurrentFixed = effectiveFinding
    ? isFindingFixed(effectiveFinding.finding, effectiveFinding.originalIndex)
    : false
  const isCurrentFixing =
    effectiveSelectedIndex !== null && fixingIndices.has(effectiveSelectedIndex)

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-background">
      {/* Title bar */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 md:gap-3">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Review
          </span>
          {reviewSelector}
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
      </div>

      {/* Master-detail layout */}
      <ResizablePanelGroup
        direction={isMobile ? 'vertical' : 'horizontal'}
        className="flex-1 min-h-0 min-w-0"
      >
        {/* Left sidebar: findings list */}
        <ResizablePanel
          defaultSize={isMobile ? 30 : 40}
          minSize={isMobile ? 18 : 15}
          maxSize={isMobile ? 45 : 60}
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
          defaultSize={isMobile ? 70 : 60}
          className="flex flex-col min-h-0 min-w-0"
        >
          {effectiveFinding ? (
            <>
              {/* Finding detail header */}
              <div className="border-b px-4 py-3 md:px-6 md:py-4">
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
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h3 className="min-w-0 break-words text-sm font-semibold">
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
                      {effectiveFinding.finding.category && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0"
                        >
                          {formatReviewMetadata(
                            effectiveFinding.finding.category
                          )}
                        </Badge>
                      )}
                      {effectiveFinding.finding.confidence && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0"
                        >
                          {formatReviewMetadata(
                            effectiveFinding.finding.confidence
                          )}{' '}
                          confidence
                        </Badge>
                      )}
                      {effectiveFinding.finding.blocking === true && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 text-red-500 border-red-500"
                        >
                          Blocking
                        </Badge>
                      )}
                      {effectiveFinding.finding.introduced_by_diff === true && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0"
                        >
                          Introduced by diff
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 break-all text-xs font-mono text-muted-foreground select-text cursor-text">
                      {effectiveFinding.finding.file}
                      {effectiveFinding.finding.line
                        ? `:${effectiveFinding.finding.line}`
                        : ''}
                    </p>
                  </div>
                </div>
              </div>

              {/* Finding detail content */}
              <ScrollArea className="flex-1" viewportRef={detailViewportRef}>
                <div className="max-w-3xl space-y-4 px-4 py-4 md:px-6">
                  {/* Description */}
                  <div>
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Description
                    </h4>
                    <p className="break-words text-sm leading-relaxed text-foreground/90 select-text cursor-text">
                      {effectiveFinding.finding.description}
                    </p>
                  </div>

                  {/* Failure scenario */}
                  {effectiveFinding.finding.failure_scenario && (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        Failure Scenario
                      </h4>
                      <p className="break-words text-sm leading-relaxed text-foreground/90 select-text cursor-text">
                        {effectiveFinding.finding.failure_scenario}
                      </p>
                    </div>
                  )}

                  {/* Suggested fix */}
                  {effectiveFinding.finding.suggestion && (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        Suggested Fix
                      </h4>
                      <div className="rounded-md bg-muted/50 p-3 border">
                        <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground/80 select-text cursor-text">
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
                        className="font-mono min-h-[80px] text-base md:text-xs"
                        placeholder="Custom fix instructions (optional)..."
                      />
                      <div className="flex flex-wrap items-center gap-2 mt-3">
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
