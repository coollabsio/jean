import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertTriangle,
  CheckCircle2,
  MessageSquare,
  FileCode,
  Loader2,
  ChevronDown,
  ChevronRight,
  MessagesSquare,
} from '@/components/icons/reicon'
import type {
  ReviewFinding,
  ReviewResponse,
  StoredReviewResults,
} from '@/types/projects'
import { DEFAULT_MAGIC_PROMPT_MODES } from '@/types/preferences'
import { usePreferences } from '@/services/preferences'
import {
  codeReviewConfigKey,
  resolveCodeReviewFixMode,
} from '@/lib/code-review-configs'
import { cn } from '@/lib/utils'
import { isNativeApp } from '@/lib/environment'
import { useIsMobile } from '@/hooks/use-mobile'

/** Optional reviewer identity so fix sessions use the same backend/model. */
export interface ReviewFixOptions {
  backend?: string
  model?: string
}

interface ReviewResultsPanelProps {
  sessionId: string
  isReviewing?: boolean
  onSendFix?: (
    message: string | string[],
    executionMode: 'plan' | 'yolo',
    options?: ReviewFixOptions
  ) => void
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
function getSeverityConfig(severity: string): {
  variant: 'danger' | 'warning' | 'info' | 'success' | 'subtle'
  label: string
} {
  switch (severity) {
    case 'critical':
      return { variant: 'danger', label: 'Critical' }
    case 'warning':
      return { variant: 'warning', label: 'Warning' }
    case 'suggestion':
      return { variant: 'info', label: 'Suggestion' }
    case 'praise':
      return { variant: 'success', label: 'Praise' }
    default:
      return { variant: 'subtle', label: severity }
  }
}

/** Severity order for sorting (lower = higher priority) */
const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
  praise: 3,
}

function getSeverityRank(severity: string): number {
  return SEVERITY_ORDER[severity] ?? 99
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

function isFixableFinding(finding: ReviewFinding): boolean {
  return (finding.severity as string) !== 'praise'
}

function formatFindingMessage(finding: ReviewFinding): string {
  const suggestionToApply = finding.suggestion ?? ''
  return `Fix the following code review finding:

**File:** ${finding.file}
**Line:** ${finding.line ?? 'N/A'}
**Issue:** ${finding.title}

${finding.description}

**Suggested fix:**
${suggestionToApply || '(Please determine the best fix)'}

Please apply this fix to the file.`
}

function formatCombinedFindingsMessage(
  findings: { finding: ReviewFinding }[]
): string {
  return `Fix the following ${findings.length} code review findings:

${findings
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
}

function SeverityBadge({ severity }: { severity: string }) {
  const config = getSeverityConfig(severity)
  return (
    <Badge variant={config.variant} className="text-2xs">
      {config.label}
    </Badge>
  )
}

function ReviewHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b px-4 py-2">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <MessageSquare className="size-4 text-muted-foreground" />
        Review Findings
      </span>
      {children}
    </div>
  )
}

/** Empty state when no review results */
function EmptyState({ isReviewing = false }: { isReviewing?: boolean }) {
  return (
    <Empty className="h-full p-6 md:p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {isReviewing ? <Loader2 className="animate-spin" /> : <FileCode />}
        </EmptyMedia>
        <EmptyTitle className="text-sm">
          {isReviewing ? 'Review running...' : 'No review results'}
        </EmptyTitle>
        {isReviewing && (
          <EmptyDescription className="text-xs">
            Results will appear here when the review finishes.
          </EmptyDescription>
        )}
      </EmptyHeader>
    </Empty>
  )
}

export function ReviewResultsPanel({
  sessionId,
  isReviewing = false,
  onSendFix,
}: ReviewResultsPanelProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [activeIndex, setActiveIndex] = useState(0)
  const [isSending, setIsSending] = useState(false)
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(
    null
  )
  const activeRowRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const isMobile = useIsMobile()
  const showKeyboardHints = isNativeApp() && !isMobile
  const { data: preferences } = usePreferences()

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
  // Prefer the selected reviewer's fix_mode; fall back to global then plan.
  const fixExecutionMode = useMemo(() => {
    const globalFallback =
      preferences?.magic_prompt_modes?.code_review_fix_mode ??
      DEFAULT_MAGIC_PROMPT_MODES.code_review_fix_mode
    const configs = preferences?.magic_code_review_configs
    if (!configs?.length) return resolveCodeReviewFixMode(null, globalFallback)

    const matching =
      (effectiveReviewKey
        ? configs.find(c => codeReviewConfigKey(c) === effectiveReviewKey)
        : undefined) ?? configs[0]
    return resolveCodeReviewFixMode(matching, globalFallback)
  }, [
    effectiveReviewKey,
    preferences?.magic_code_review_configs,
    preferences?.magic_prompt_modes?.code_review_fix_mode,
  ])
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

  const fixableIndices = useMemo(
    () =>
      sortedFindings.flatMap(({ finding, originalIndex }) =>
        isFixableFinding(finding) ? [originalIndex] : []
      ),
    [sortedFindings]
  )

  // Clamp during render so list shrinks never leave an out-of-range index
  const safeActiveIndex =
    sortedFindings.length === 0
      ? 0
      : Math.min(activeIndex, sortedFindings.length - 1)

  const focusActiveRow = useCallback((index: number) => {
    const row = activeRowRefs.current[index]
    row?.focus({ preventScroll: true })
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  // Default-select all fixable findings when results/reviewer change.
  // State is adjusted during render so stale selections never paint; focus
  // stays in an effect because it touches the DOM.
  const resetKey = `${sessionId}\u0000${effectiveReviewKey}\u0000${fixableIndices.join(',')}`
  const [prevResetKey, setPrevResetKey] = useState<string | null>(null)
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey)
    setSelected(new Set(fixableIndices))
    setExpanded(new Set())
    setActiveIndex(0)
  }
  useEffect(() => {
    requestAnimationFrame(() => focusActiveRow(0))
  }, [resetKey, focusActiveRow])

  const handleReviewSelect = useCallback((key: string) => {
    setSelectedReviewKey(key)
  }, [])

  const toggleSelect = useCallback((index: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  const toggleExpand = useCallback((index: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  const allSelected =
    fixableIndices.length > 0 &&
    fixableIndices.every(index => selected.has(index))

  const toggleAll = useCallback(() => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(fixableIndices))
  }, [allSelected, fixableIndices])

  const markSelectedFixed = useCallback(
    (indices: number[]) => {
      if (!reviewResults) return
      const { markReviewFindingFixed } = useChatStore.getState()
      for (const index of indices) {
        const finding = reviewResults.findings[index]
        if (!finding) continue
        const findingKey = getStoredReviewFindingKey(
          finding,
          index,
          effectiveReviewKey
        )
        markReviewFindingFixed(sessionId, findingKey)
      }
    },
    [effectiveReviewKey, reviewResults, sessionId]
  )

  const getSelectedFindings = useCallback(() => {
    return sortedFindings.filter(
      ({ finding, originalIndex }) =>
        selected.has(originalIndex) && isFixableFinding(finding)
    )
  }, [sortedFindings, selected])

  const reviewFixOptions = useMemo((): ReviewFixOptions | undefined => {
    if (!selectedReviewEntry) return undefined
    return {
      backend: selectedReviewEntry.backend,
      model: selectedReviewEntry.model,
    }
  }, [selectedReviewEntry])

  const handleSendToChat = useCallback(() => {
    if (!onSendFix) return
    const selectedFindings = getSelectedFindings()
    if (selectedFindings.length === 0) return

    setIsSending(true)
    try {
      markSelectedFixed(selectedFindings.map(f => f.originalIndex))
      onSendFix(
        formatCombinedFindingsMessage(selectedFindings),
        fixExecutionMode,
        reviewFixOptions
      )
    } finally {
      setIsSending(false)
    }
  }, [
    fixExecutionMode,
    getSelectedFindings,
    markSelectedFixed,
    onSendFix,
    reviewFixOptions,
  ])

  const handleSendSeparately = useCallback(() => {
    if (!onSendFix) return
    const selectedFindings = getSelectedFindings()
    if (selectedFindings.length === 0) return

    setIsSending(true)
    try {
      markSelectedFixed(selectedFindings.map(f => f.originalIndex))
      onSendFix(
        selectedFindings.map(({ finding }) => formatFindingMessage(finding)),
        fixExecutionMode,
        reviewFixOptions
      )
    } finally {
      setIsSending(false)
    }
  }, [
    fixExecutionMode,
    getSelectedFindings,
    markSelectedFixed,
    onSendFix,
    reviewFixOptions,
  ])

  const handlePanelKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (sortedFindings.length === 0) return

      const sendShortcut =
        event.key === 'Enter' && (event.metaKey || event.ctrlKey)
      if (sendShortcut) {
        event.preventDefault()
        if (event.shiftKey) handleSendToChat()
        else handleSendSeparately()
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const next = Math.min(safeActiveIndex + 1, sortedFindings.length - 1)
        setActiveIndex(next)
        requestAnimationFrame(() => focusActiveRow(next))
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const next = Math.max(safeActiveIndex - 1, 0)
        setActiveIndex(next)
        requestAnimationFrame(() => focusActiveRow(next))
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        const item = sortedFindings[safeActiveIndex]
        if (item) toggleExpand(item.originalIndex)
        return
      }

      if (event.key === ' ') {
        event.preventDefault()
        const item = sortedFindings[safeActiveIndex]
        if (item && isFixableFinding(item.finding)) {
          toggleSelect(item.originalIndex)
        }
      }
    },
    [
      focusActiveRow,
      handleSendSeparately,
      handleSendToChat,
      safeActiveIndex,
      sortedFindings,
      toggleExpand,
      toggleSelect,
    ]
  )

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

  if (!reviewResults) {
    return (
      <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-background">
        {reviewSelector && <ReviewHeader>{reviewSelector}</ReviewHeader>}
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

  const approvalConfig = (() => {
    switch (reviewResults.approval_status) {
      case 'approved':
        return {
          icon: CheckCircle2,
          color: 'text-success',
          label: 'Approved',
        }
      case 'changes_requested':
        return {
          icon: AlertTriangle,
          color: 'text-warning',
          label: 'Changes Requested',
        }
      case 'needs_discussion':
        return {
          icon: MessageSquare,
          color: 'text-info',
          label: 'Needs Discussion',
        }
      default:
        return {
          icon: MessageSquare,
          color: 'text-muted-foreground',
          label: reviewResults.approval_status,
        }
    }
  })()
  const ApprovalIcon = approvalConfig.icon

  const selectedCount = getSelectedFindings().length
  const hasFindings = sortedFindings.length > 0

  return (
    <div
      className="relative flex h-full min-w-0 flex-col overflow-hidden bg-background outline-none"
      role="region"
      aria-label="Review findings"
      tabIndex={0}
      onKeyDown={handlePanelKeyDown}
    >
      <ReviewHeader>
        {reviewSelector}
        <div className="flex items-center gap-1.5">
          <ApprovalIcon className={cn('size-3.5', approvalConfig.color)} />
          <span className={cn('text-xs font-medium', approvalConfig.color)}>
            {approvalConfig.label}
          </span>
        </div>
      </ReviewHeader>

      {!hasFindings ? (
        <Empty className="p-6 md:p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileCode />
            </EmptyMedia>
            <EmptyTitle className="text-sm">
              No specific findings, code looks good
            </EmptyTitle>
            {reviewResults.summary && (
              <EmptyDescription className="text-xs">
                {reviewResults.summary}
              </EmptyDescription>
            )}
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {/* Selection controls */}
          <div className="flex items-center justify-between gap-3 px-4 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                {selectedCount} of {fixableIndices.length} selected
              </span>
              {showKeyboardHints && (
                <>
                  <span className="inline-flex items-center gap-1">
                    <Kbd className="h-4 min-w-0 px-1 text-2xs">↑/↓</Kbd>
                    move
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kbd className="h-4 min-w-0 px-1 text-2xs">↵</Kbd>
                    expand
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Kbd className="h-4 min-w-0 px-1 text-2xs">Space</Kbd>
                    select
                  </span>
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 text-xs"
              onClick={toggleAll}
              disabled={fixableIndices.length === 0}
            >
              {allSelected ? 'Deselect All' : 'Select All'}
            </Button>
          </div>

          {/* Findings list */}
          <ScrollArea className="min-h-0 flex-1 border-y">
            <div className="divide-y">
              {sortedFindings.map(({ finding, originalIndex }, listIndex) => {
                const isExpanded = expanded.has(originalIndex)
                const isSelected = selected.has(originalIndex)
                const isFixed = isFindingFixed(finding, originalIndex)
                const isActive = safeActiveIndex === listIndex
                const canSelect = isFixableFinding(finding)
                const lineInfo = finding.line ? `:${finding.line}` : ''

                return (
                  // react-doctor-disable-next-line react-doctor/no-static-element-interactions -- pointer mirror of the panel's handlePanelKeyDown roving navigation; checkbox/expand are real controls
                  <div
                    key={getReviewFindingKey(finding, originalIndex)}
                    ref={node => {
                      activeRowRefs.current[listIndex] = node
                    }}
                    data-active={isActive}
                    data-testid={`review-finding-row-${originalIndex}`}
                    className={cn(
                      'px-3 py-2.5 outline-none transition-colors',
                      isActive && 'bg-accent/40 ring-1 ring-ring/50',
                      isFixed && 'opacity-60'
                    )}
                    onClick={() => {
                      setActiveIndex(listIndex)
                      requestAnimationFrame(() => focusActiveRow(listIndex))
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={isSelected}
                        disabled={!canSelect}
                        onCheckedChange={() => toggleSelect(originalIndex)}
                        className="mt-0.5"
                        onClick={e => e.stopPropagation()}
                      />
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => toggleExpand(originalIndex)}
                          className="group w-full cursor-pointer text-left"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            {isExpanded ? (
                              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                              {finding.title}
                            </p>
                            <SeverityBadge severity={finding.severity} />
                            {isFixed && (
                              <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                            )}
                          </div>
                          <div className="mt-1 flex min-w-0 items-center gap-2 pl-5 text-xs">
                            <code className="truncate font-mono text-muted-foreground">
                              {finding.file}
                              {lineInfo}
                            </code>
                            {finding.category && (
                              <span className="shrink-0 text-muted-foreground/70">
                                {formatReviewMetadata(finding.category)}
                              </span>
                            )}
                          </div>
                        </button>

                        {isExpanded && (
                          <div className="mt-2 space-y-3 pl-5">
                            <p className="break-words text-sm leading-relaxed text-foreground/90 select-text">
                              {finding.description}
                            </p>

                            {finding.failure_scenario && (
                              <div>
                                <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                                  Failure Scenario
                                </h4>
                                <p className="break-words text-sm leading-relaxed text-foreground/90 select-text">
                                  {finding.failure_scenario}
                                </p>
                              </div>
                            )}

                            {finding.suggestion && (
                              <div>
                                <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                                  Suggested Fix
                                </h4>
                                <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-2 text-xs font-mono text-foreground/80 select-text">
                                  {finding.suggestion}
                                </pre>
                              </div>
                            )}

                            <div className="flex flex-wrap gap-1.5">
                              {finding.confidence && (
                                <Badge variant="subtle" className="text-2xs">
                                  {formatReviewMetadata(finding.confidence)}{' '}
                                  confidence
                                </Badge>
                              )}
                              {finding.blocking === true && (
                                <Badge variant="danger" className="text-2xs">
                                  Blocking
                                </Badge>
                              )}
                              {finding.introduced_by_diff === true && (
                                <Badge variant="subtle" className="text-2xs">
                                  Introduced by diff
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>

          {/* Summary */}
          {reviewResults.summary && (
            <div className="border-b px-4 py-2">
              <p className="line-clamp-2 text-xs text-muted-foreground select-text">
                {reviewResults.summary}
              </p>
            </div>
          )}

          {/* Footer actions */}
          <div className="flex shrink-0 justify-end gap-2 px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <Button
              variant="outline"
              size="sm"
              disabled={selectedCount === 0 || isSending || !onSendFix}
              onClick={handleSendToChat}
            >
              {isSending ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <MessageSquare className="mr-1.5 size-3.5" />
              )}
              Send to Chat ({selectedCount})
              {showKeyboardHints && (
                <KbdGroup modHint className="ml-1.5">
                  <Kbd className="h-4 min-w-4 px-1 text-2xs">⇧</Kbd>
                  <Kbd className="h-4 min-w-4 px-1 text-2xs">⌘↵</Kbd>
                </KbdGroup>
              )}
            </Button>
            <Button
              size="sm"
              disabled={selectedCount === 0 || isSending || !onSendFix}
              onClick={handleSendSeparately}
            >
              {isSending ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <MessagesSquare className="mr-1.5 size-3.5" />
              )}
              Send Separately ({selectedCount})
              {showKeyboardHints && (
                <KbdGroup modHint className="ml-1.5">
                  <Kbd className="h-4 min-w-4 px-1 text-2xs">⌘</Kbd>
                  <Kbd className="h-4 min-w-4 px-1 text-2xs">↵</Kbd>
                </KbdGroup>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
